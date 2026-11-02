import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { login, logout, refreshSession, type Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';

import { api } from '../../../snapback/generated/api.ts';

export class SignInRefused extends Error {}

export type VerifiedAccount = { accountId: string; principal: string; session: Session };

// the same digest the phone binds its replica to: sha256 of [backend url, principal].
export function accountIdFor(backendUrl: string, principal: string): string {
  return createHash('sha256').update(JSON.stringify([backendUrl, principal])).digest('hex');
}

// signs into the existing snapback account and proves the bearer works for its principal.
// the password is used for this request only and never stored.
export async function verifySignIn(backendUrl: string, email: string, password: string,
  fetcher: typeof fetch = fetch): Promise<VerifiedAccount> {
  const result = await login(backendUrl, email, password, { scope: 'full', timeoutMs: 15_000 }, fetcher);
  if (!result.ok) throw new SignInRefused(result.why.code);
  const { session } = result;
  const client = createClient({ url: backendUrl, token: session.token, fetch: fetcher });
  try {
    const profile = await client.query(api.profile, {});
    // an empty account has no profile row, so the authenticated viewer is the identity proof.
    if ('denied' in profile || client.viewer() !== session.principal) throw new SignInRefused('IDENTITY');
  } finally {
    await client.close();
  }
  return { accountId: accountIdFor(backendUrl, session.principal), principal: session.principal, session };
}

export async function endSession(backendUrl: string, session: Session, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await logout(backendUrl, session.token, (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(5_000) }));
  } catch { /* best effort: the local credential is already gone. */ }
}

// sessions refresh inside this window so a connection keeps working without weekly sign-ins.
const REFRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

type Row = { principal: string; nonce: Uint8Array; sealed: Uint8Array; expires_at: number };

// one snapback session per account, sealed with aes-256-gcm and bound to its account id.
export class Credentials {
  private readonly key: Buffer;

  constructor(private readonly db: DatabaseSync, secret: string, private readonly backendUrl: string,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'flint-mcp', 'snapback-session', 32));
    db.exec(`CREATE TABLE IF NOT EXISTS flint_accounts (
      account_id TEXT PRIMARY KEY, principal TEXT NOT NULL, nonce BLOB NOT NULL, sealed BLOB NOT NULL,
      expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }

  // stores the newest session and returns the one it replaced, for logout.
  save(accountId: string, session: Session): Session | null {
    const previous = this.load(accountId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce).setAAD(Buffer.from(accountId));
    const sealed = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    this.db.prepare(`INSERT INTO flint_accounts VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
      principal = excluded.principal, nonce = excluded.nonce, sealed = excluded.sealed,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
      .run(accountId, session.principal, nonce, sealed, session.expiresAt, this.now());
    return previous && previous.token !== session.token ? previous : null;
  }

  load(accountId: string): Session | null {
    const row = this.db.prepare('SELECT principal, nonce, sealed, expires_at FROM flint_accounts WHERE account_id = ?')
      .get(accountId) as Row | undefined;
    if (!row) return null;
    const sealed = Buffer.from(row.sealed);
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce).setAAD(Buffer.from(accountId));
    decipher.setAuthTag(sealed.subarray(-16));
    const session = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString('utf8')) as Session;
    return session.principal === row.principal ? session : null;
  }

  delete(accountId: string): Session | null {
    const session = this.load(accountId);
    this.db.prepare('DELETE FROM flint_accounts WHERE account_id = ?').run(accountId);
    return session;
  }

  accountsExpiringBefore(instant: number): string[] {
    return (this.db.prepare('SELECT account_id FROM flint_accounts WHERE expires_at < ?').all(instant) as { account_id: string }[])
      .map(row => row.account_id);
  }

  // the usable session, refreshed when close to expiry. null means the user must reconnect.
  // callers serialize this per account: snapback consumes the old token during a refresh.
  async current(accountId: string): Promise<Session | null> {
    const session = this.load(accountId);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt - now > REFRESH_WINDOW_MS) return session;
    let refreshed;
    try {
      refreshed = await refreshSession(this.backendUrl, session.token, this.fetcher);
    } catch {
      // offline: keep the current session until it actually expires.
      return session.expiresAt > now ? session : null;
    }
    if (!refreshed.ok) {
      this.delete(accountId);
      return null;
    }
    this.save(accountId, refreshed.session);
    return refreshed.session;
  }

  // refreshes every session that would expire soon, even for accounts that are idle.
  async refreshExpiring(run: (accountId: string, work: () => Promise<void>) => Promise<void>): Promise<void> {
    for (const accountId of this.accountsExpiringBefore(this.now() + REFRESH_WINDOW_MS)) {
      await run(accountId, async () => { await this.current(accountId); }).catch(() => undefined);
    }
  }
}
