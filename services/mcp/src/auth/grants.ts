import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { VerifiedIdentity, VerifiedWriteIdentity } from './identity';
import { CredentialVault, type VaultBinding } from './vault';
import { readScopes, writeScopes } from '../scopes';

export { readScopes, writeScopes } from '../scopes';
export const authorizationScopes = ['openid', 'offline_access', ...readScopes];
export const requestsWrite = (scopes: readonly string[]) => scopes.some(scope => writeScopes.some(write => write === scope));
export type PrivateGrant = Readonly<{
  grantId: string; accountId: string; backendUrl: string; principal: string; userId: string;
  clientId: string; sessionId: string; operationLineageId: string; scopes: readonly string[];
  credentialScope: 'read' | 'full';
  authorizationEpoch: string | null; expiresAt: number; active: boolean;
}>;
type GrantRow = { id: string; account_id: string; backend: string; principal: string; user_id: string;
  client_id: string; session_id: string; lineage: string; scopes: string; credential_scope: 'read' | 'full';
  authorization_epoch: string | null; retirement_uncertain: number; retirement_attempted_at: number | null;
  expires_at: number; active: number };
type Pending = { session_id: string; account_id: string; backend: string; principal: string; user_id: string;
  expires_at: number; consumed: number; credential_scope: 'read'; authorization_epoch: string | null };

export class AuthorizationDenied extends Error {
  constructor() { super('Authorization is unavailable. Connect this account again.'); this.name = 'AuthorizationDenied'; }
}
export class OwnerConnectionLimitError extends Error {
  constructor() { super('This account has more than 100 connections. The connection list cannot be shown safely.');
    this.name = 'OwnerConnectionLimitError'; }
}
export function binding(grant: Pick<PrivateGrant, 'grantId' | 'accountId' | 'backendUrl' | 'principal' | 'credentialScope'>): VaultBinding {
  return { backend: grant.backendUrl, principal: grant.principal, accountId: grant.accountId, grantId: grant.grantId,
    scope: grant.credentialScope };
}
function pendingBinding(row: Pending): VaultBinding {
  if (row.credential_scope !== 'read') throw new AuthorizationDenied();
  return { backend: row.backend, principal: row.principal, accountId: row.account_id,
    grantId: `pending:${row.session_id}`, scope: row.credential_scope };
}
function unpack(row: GrantRow): PrivateGrant {
  let scopes: string[] = [];
  try {
    const stored: unknown = JSON.parse(row.scopes);
    if (Array.isArray(stored) && stored.every(scope => typeof scope === 'string')) scopes = stored;
  } catch { /* invalid permission metadata cannot grant access, but custody remains revocable. */ }
  return Object.freeze({ grantId: row.id, accountId: row.account_id, backendUrl: row.backend, principal: row.principal,
    userId: row.user_id, clientId: row.client_id, sessionId: row.session_id, operationLineageId: row.lineage,
    scopes: Object.freeze(scopes), credentialScope: row.credential_scope, authorizationEpoch: row.authorization_epoch,
    expiresAt: row.expires_at, active: row.active === 1 });
}
function validEpoch(epoch: string): boolean {
  return typeof epoch === 'string' && epoch.length > 0 && epoch.length <= 256 && /^[\x21-\x7e]+$/.test(epoch);
}

// metadata owns no bearer material; custody and duplicate-bearer checks remain in the vault.
export class GrantStore {
  constructor(private db: DatabaseSync, private vault: CredentialVault, private allowedScopes: readonly string[] = authorizationScopes) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_pending (
      session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL,
      user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
      credential_scope TEXT NOT NULL DEFAULT 'read' CHECK(credential_scope = 'read'),
      authorization_epoch TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS mcp_lineages (
      account_id TEXT NOT NULL, client_id TEXT NOT NULL, lineage TEXT NOT NULL UNIQUE,
      PRIMARY KEY(account_id, client_id)) STRICT;
      CREATE TABLE IF NOT EXISTS mcp_grants (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL, user_id TEXT NOT NULL,
      client_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, lineage TEXT NOT NULL, scopes TEXT NOT NULL,
      credential_scope TEXT NOT NULL DEFAULT 'read' CHECK(credential_scope IN ('read', 'full')),
      authorization_epoch TEXT, retirement_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(retirement_uncertain IN (0,1)),
      retirement_attempted_at INTEGER,
      expires_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`);
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map(column => column.name));
    const pendingColumns = columns('mcp_pending');
    const grantColumns = columns('mcp_grants');
    if (!pendingColumns.has('credential_scope') || !grantColumns.has('credential_scope') ||
      !pendingColumns.has('authorization_epoch') || !grantColumns.has('authorization_epoch') ||
      !grantColumns.has('retirement_uncertain') || !grantColumns.has('retirement_attempted_at')) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!grantColumns.has('credential_scope')) {
          const legacy = db.prepare('SELECT scopes FROM mcp_grants').all() as { scopes: string }[];
          if (legacy.some(row => {
            try {
              const scopes: unknown = JSON.parse(row.scopes);
              return !Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string') || requestsWrite(scopes);
            } catch { return true; }
          })) throw new AuthorizationDenied();
          db.exec("ALTER TABLE mcp_grants ADD COLUMN credential_scope TEXT NOT NULL DEFAULT 'read' CHECK(credential_scope IN ('read', 'full'))");
        }
        if (!pendingColumns.has('credential_scope')) db.exec("ALTER TABLE mcp_pending ADD COLUMN credential_scope TEXT NOT NULL DEFAULT 'read' CHECK(credential_scope = 'read')");
        if (!pendingColumns.has('authorization_epoch')) db.exec('ALTER TABLE mcp_pending ADD COLUMN authorization_epoch TEXT');
        if (!grantColumns.has('authorization_epoch')) db.exec('ALTER TABLE mcp_grants ADD COLUMN authorization_epoch TEXT');
        if (!grantColumns.has('retirement_uncertain')) db.exec('ALTER TABLE mcp_grants ADD COLUMN retirement_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(retirement_uncertain IN (0,1))');
        if (!grantColumns.has('retirement_attempted_at')) db.exec('ALTER TABLE mcp_grants ADD COLUMN retirement_attempted_at INTEGER');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const custodySchema = (table: 'mcp_pending' | 'mcp_grants', declaration: RegExp) => {
      const stored = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', table) as { sql: string } | undefined;
      if (!stored || !declaration.test(stored.sql)) throw new AuthorizationDenied();
    };
    custodySchema('mcp_pending', /(?:\(|,)\s*credential_scope\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'read'\s+CHECK\s*\(\s*credential_scope\s*=\s*'read'\s*\)/i);
    custodySchema('mcp_grants', /(?:\(|,)\s*credential_scope\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'read'\s+CHECK\s*\(\s*credential_scope\s+IN\s*\(\s*'read'\s*,\s*'full'\s*\)\s*\)/i);
    // a prior process may have stopped after durable grant insertion or vault custody.
    for (const row of db.prepare('SELECT * FROM mcp_grants WHERE active = 0').all() as GrantRow[]) {
      this.vault.revoke(binding(unpack(row)));
    }
    for (const row of db.prepare('SELECT * FROM mcp_pending WHERE consumed = 1').all() as Pending[]) {
      this.vault.revoke(pendingBinding(row));
    }
  }
  permissionsMatch(grant: PrivateGrant): boolean {
    return (grant.credentialScope === 'read' || grant.credentialScope === 'full') &&
      grant.scopes.length > 0 && grant.scopes.every(scope => this.allowedScopes.includes(scope)) &&
      (!grant.scopes.includes('rewards:claim') || grant.scopes.includes('coins:read')) &&
      requestsWrite(grant.scopes) === (grant.credentialScope === 'full');
  }
  pending(sessionId: string, epoch: string): boolean {
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!validEpoch(epoch) || !row || row.authorization_epoch !== epoch || row.credential_scope !== 'read' ||
      row.consumed || row.expires_at <= Date.now()) return false;
    try { this.vault.get(pendingBinding(row)); return true; } catch { return false; }
  }
  stage(sessionId: string, userId: string, identity: VerifiedIdentity, epoch: string): void {
    if (!validEpoch(epoch)) throw new AuthorizationDenied();
    const expiresAt = Math.min(identity.session.expiresAt, identity.session.capExpiresAt ?? Infinity, Date.now() + 600_000);
    const row: Pending = { session_id: sessionId, user_id: userId, account_id: identity.accountId,
      backend: identity.backendUrl, principal: identity.principal, expires_at: expiresAt,
      consumed: 0, credential_scope: 'read', authorization_epoch: epoch };
    this.vault.put(pendingBinding(row), identity.session);
    this.db.prepare("INSERT INTO mcp_pending (session_id, account_id, backend, principal, user_id, expires_at, consumed, credential_scope, authorization_epoch) VALUES (?, ?, ?, ?, ?, ?, 0, 'read', ?)")
      .run(sessionId, identity.accountId, identity.backendUrl, identity.principal, userId, expiresAt, epoch);
  }
  connect(sessionId: string, userId: string, clientId: string, scopes: string[], epoch: string,
    writeIdentity?: VerifiedWriteIdentity): PrivateGrant {
    if (!validEpoch(epoch)) throw new AuthorizationDenied();
    if (!scopes.length || scopes.some(scope => !this.allowedScopes.includes(scope)) ||
      (scopes.includes('rewards:claim') && !scopes.includes('coins:read')) || requestsWrite(scopes) !== !!writeIdentity) {
      throw new AuthorizationDenied();
    }
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!row || row.authorization_epoch !== epoch || row.user_id !== userId || !this.pending(sessionId, epoch)) throw new AuthorizationDenied();
    if (writeIdentity && (writeIdentity.accountId !== row.account_id || writeIdentity.backendUrl !== row.backend ||
      writeIdentity.principal !== row.principal || writeIdentity.session.scope !== 'full')) throw new AuthorizationDenied();
    const pendingSession = this.vault.get(pendingBinding(row));
    if (writeIdentity?.session.token === pendingSession.token) throw new AuthorizationDenied();
    const session = writeIdentity?.session ?? pendingSession;
    // consume durably before moving custody. a crash between databases requires private reauthentication.
    if (this.db.prepare('UPDATE mcp_pending SET consumed = 1 WHERE session_id = ? AND consumed = 0').run(sessionId).changes !== 1) {
      throw new AuthorizationDenied();
    }
    this.vault.revoke(pendingBinding(row));
    const grantId = randomUUID();
    const lineage = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO mcp_lineages VALUES (?, ?, ?)').run(row.account_id, clientId, lineage);
    const operationLineageId = (this.db.prepare('SELECT lineage FROM mcp_lineages WHERE account_id = ? AND client_id = ?')
      .get(row.account_id, clientId) as { lineage: string }).lineage;
    const grant: PrivateGrant = { grantId, accountId: row.account_id, backendUrl: row.backend, principal: row.principal,
      userId, clientId, sessionId, operationLineageId, scopes, credentialScope: writeIdentity ? 'full' : 'read',
      authorizationEpoch: epoch, expiresAt: Math.min(session.expiresAt, session.capExpiresAt ?? Infinity), active: false };
    this.db.prepare(`INSERT INTO mcp_grants
      (id, account_id, backend, principal, user_id, client_id, session_id, lineage, scopes, credential_scope, authorization_epoch, expires_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(grantId, grant.accountId, grant.backendUrl, grant.principal, userId, clientId, sessionId,
        operationLineageId, JSON.stringify(scopes), grant.credentialScope, epoch, grant.expiresAt);
    try {
      this.vault.put(binding(grant), session);
      if (this.db.prepare('UPDATE mcp_grants SET active = 1 WHERE id = ? AND active = 0').run(grantId).changes !== 1) {
        throw new AuthorizationDenied();
      }
    } catch (error) {
      // the inactive record survives cleanup failure so startup can retry the exact vault binding.
      try { this.vault.revoke(binding(grant)); } catch { /* custody stays fenced by the inactive grant. */ }
      throw error;
    }
    return this.active(grantId, epoch);
  }
  lookup(grantId: string): PrivateGrant | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE id = ?').get(grantId) as GrantRow | undefined;
    return row ? unpack(row) : undefined;
  }
  lookupSession(sessionId: string): PrivateGrant | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE session_id = ?').get(sessionId) as GrantRow | undefined;
    return row ? unpack(row) : undefined;
  }
  forAccount(accountId: string): readonly PrivateGrant[] {
    const rows = this.db.prepare('SELECT * FROM mcp_grants WHERE account_id = ? ORDER BY expires_at DESC, id DESC LIMIT 101')
      .all(accountId) as GrantRow[];
    if (rows.length > 100) throw new OwnerConnectionLimitError();
    return Object.freeze(rows.map(unpack));
  }
  discardPending(sessionId: string): void {
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!row) return;
    this.db.prepare('UPDATE mcp_pending SET consumed = 1 WHERE session_id = ?').run(sessionId);
    this.vault.revoke(pendingBinding(row));
  }
  forSession(sessionId: string, clientId: string, epoch: string): PrivateGrant {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE session_id = ? AND client_id = ?')
      .get(sessionId, clientId) as GrantRow | undefined;
    if (!row) throw new AuthorizationDenied();
    return this.active(row.id, epoch);
  }
  active(grantId: string, epoch: string): PrivateGrant {
    const grant = this.lookup(grantId);
    if (!validEpoch(epoch) || !grant?.active || grant.authorizationEpoch !== epoch ||
      !this.permissionsMatch(grant) || grant.expiresAt <= Date.now()) throw new AuthorizationDenied();
    this.vault.get(binding(grant));
    return grant;
  }
  revoke(grantId: string): void {
    const grant = this.lookup(grantId);
    if (!grant) throw new AuthorizationDenied();
    this.db.prepare('UPDATE mcp_grants SET active = 0, retirement_uncertain = 1 WHERE id = ?').run(grantId);
    this.vault.revoke(binding(grant));
  }
  retirementAttempted(grantId: string): void {
    this.db.prepare('UPDATE mcp_grants SET retirement_attempted_at = ? WHERE id = ? AND retirement_uncertain = 1')
      .run(Date.now(), grantId);
  }
}
