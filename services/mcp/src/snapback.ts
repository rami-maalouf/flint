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
  private readonly refreshing = new Map<string, Promise<Session | null>>();

  // onLost runs when a session is dropped, so the account's oauth refresh tokens can be revoked too.
  constructor(private readonly db: DatabaseSync, secret: string, private readonly backendUrl: string,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now,
    private readonly onLost: (accountId: string) => Promise<void> = async () => {}) {
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

  // a seal that no longer opens, for example after the secret changed, counts as no session.
  load(accountId: string): Session | null {
    const row = this.db.prepare('SELECT principal, nonce, sealed, expires_at FROM flint_accounts WHERE account_id = ?')
      .get(accountId) as Row | undefined;
    if (!row) return null;
    try {
      const sealed = Buffer.from(row.sealed);
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce).setAAD(Buffer.from(accountId));
      decipher.setAuthTag(sealed.subarray(-16));
      const session = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString('utf8')) as Session;
      return session.principal === row.principal ? session : null;
    } catch {
      return null;
    }
  }

  delete(accountId: string): Session | null {
    const session = this.load(accountId);
    this.db.prepare('DELETE FROM flint_accounts WHERE account_id = ?').run(accountId);
    return session;
  }

  // forgets a session the backend refused, unless a newer sign-in already replaced it. the
  // account's oauth refresh tokens go too, so clients start sign-in instead of looping on 401s.
  async deleteIfCurrent(accountId: string, token: string): Promise<boolean> {
    if (this.load(accountId)?.token !== token) return false;
    this.delete(accountId);
    await this.onLost(accountId);
    return true;
  }

  list(): { accountId: string; savedAt: number; expiresAt: number }[] {
    return (this.db.prepare('SELECT account_id, updated_at, expires_at FROM flint_accounts').all() as
      { account_id: string; updated_at: number; expires_at: number }[])
      .map(row => ({ accountId: row.account_id, savedAt: row.updated_at, expiresAt: row.expires_at }));
  }

  // the usable session, refreshed when close to expiry. null means the user must reconnect.
  // refreshes are serialized per account: snapback consumes the old token during a refresh.
  current(accountId: string): Promise<Session | null> {
    const previous = this.refreshing.get(accountId) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(() => this.refreshed(accountId));
    this.refreshing.set(accountId, next);
    const settle = () => { if (this.refreshing.get(accountId) === next) this.refreshing.delete(accountId); };
    next.then(settle, settle);
    return next;
  }

  // refreshes every session that would expire soon, even for accounts that are idle.
  async refreshExpiring(): Promise<void> {
    const soon = this.now() + REFRESH_WINDOW_MS;
    for (const { accountId } of this.list().filter(row => row.expiresAt < soon)) {
      await this.current(accountId).catch(() => undefined);
    }
  }

  private async refreshed(accountId: string): Promise<Session | null> {
    const session = this.load(accountId);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt - now > REFRESH_WINDOW_MS) return session;
    const refreshed = await refreshSession(this.backendUrl, session.token,
      (input, init) => this.fetcher(input, { ...init, signal: AbortSignal.timeout(15_000) }));
    if (!refreshed.ok) {
      // only a final refusal of the credential ends it; an outage or a rate limit keeps it
      // until it really expires.
      if (refreshed.why.family === 'auth' && refreshed.why.retryable !== true) {
        await this.deleteIfCurrent(accountId, session.token);
        return this.load(accountId);
      }
      return session.expiresAt > now ? session : null;
    }
    // a sign-in during the refresh already stored a newer session; keep that one.
    if (this.load(accountId)?.token !== session.token) {
      void endSession(this.backendUrl, refreshed.session, this.fetcher);
      return this.load(accountId);
    }
    this.save(accountId, refreshed.session);
    return refreshed.session;
  }
}
