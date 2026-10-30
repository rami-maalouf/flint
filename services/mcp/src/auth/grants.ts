import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { VerifiedIdentity } from './identity';
import { CredentialVault, type VaultBinding } from './vault';

export const readScopes = ['habits:read', 'habits:notes:read', 'coins:read'] as const;
export const authorizationScopes = ['openid', 'offline_access', ...readScopes];
export type PrivateGrant = Readonly<{
  grantId: string; accountId: string; backendUrl: string; principal: string; userId: string;
  clientId: string; sessionId: string; operationLineageId: string; scopes: readonly string[];
  expiresAt: number; active: boolean;
}>;
type GrantRow = { id: string; account_id: string; backend: string; principal: string; user_id: string;
  client_id: string; session_id: string; lineage: string; scopes: string; expires_at: number; active: number };
type Pending = { session_id: string; account_id: string; backend: string; principal: string; user_id: string;
  expires_at: number; consumed: number };

export class AuthorizationDenied extends Error {
  constructor() { super('Authorization is unavailable. Connect this account again.'); this.name = 'AuthorizationDenied'; }
}
export function binding(grant: Pick<PrivateGrant, 'grantId' | 'accountId' | 'backendUrl' | 'principal'>): VaultBinding {
  return { backend: grant.backendUrl, principal: grant.principal, accountId: grant.accountId, grantId: grant.grantId, scope: 'read' };
}
function pendingBinding(row: Pending): VaultBinding {
  return binding({ grantId: `pending:${row.session_id}`, accountId: row.account_id, backendUrl: row.backend, principal: row.principal });
}
function unpack(row: GrantRow): PrivateGrant {
  return Object.freeze({ grantId: row.id, accountId: row.account_id, backendUrl: row.backend, principal: row.principal,
    userId: row.user_id, clientId: row.client_id, sessionId: row.session_id, operationLineageId: row.lineage,
    scopes: Object.freeze(JSON.parse(row.scopes) as string[]), expiresAt: row.expires_at, active: row.active === 1 });
}

// metadata owns no bearer material; custody and duplicate-bearer checks remain in the vault.
export class GrantStore {
  constructor(private db: DatabaseSync, private vault: CredentialVault) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_pending (
      session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL,
      user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS mcp_lineages (
      account_id TEXT NOT NULL, client_id TEXT NOT NULL, lineage TEXT NOT NULL UNIQUE,
      PRIMARY KEY(account_id, client_id)) STRICT;
      CREATE TABLE IF NOT EXISTS mcp_grants (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL, user_id TEXT NOT NULL,
      client_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, lineage TEXT NOT NULL, scopes TEXT NOT NULL,
      expires_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`);
  }
  pending(sessionId: string): boolean {
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!row || row.consumed || row.expires_at <= Date.now()) return false;
    try { this.vault.get(pendingBinding(row)); return true; } catch { return false; }
  }
  stage(sessionId: string, userId: string, identity: VerifiedIdentity): void {
    const expiresAt = Math.min(identity.session.expiresAt, identity.session.capExpiresAt ?? Infinity, Date.now() + 600_000);
    const row: Pending = { session_id: sessionId, user_id: userId, account_id: identity.accountId,
      backend: identity.backendUrl, principal: identity.principal, expires_at: expiresAt, consumed: 0 };
    this.vault.put(pendingBinding(row), identity.session);
    this.db.prepare('INSERT INTO mcp_pending VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(sessionId, identity.accountId, identity.backendUrl, identity.principal, userId, expiresAt);
  }
  connect(sessionId: string, userId: string, clientId: string, scopes: string[]): PrivateGrant {
    if (!scopes.length || scopes.some(scope => !authorizationScopes.includes(scope))) throw new AuthorizationDenied();
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!row || row.user_id !== userId || !this.pending(sessionId)) throw new AuthorizationDenied();
    const session = this.vault.get(pendingBinding(row));
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
      userId, clientId, sessionId, operationLineageId, scopes, expiresAt: Math.min(session.expiresAt, session.capExpiresAt ?? Infinity), active: true };
    this.vault.put(binding(grant), session);
    this.db.prepare('INSERT INTO mcp_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(grantId, grant.accountId, grant.backendUrl, grant.principal, userId, clientId, sessionId,
        operationLineageId, JSON.stringify(scopes), grant.expiresAt);
    return this.active(grantId);
  }
  lookup(grantId: string): PrivateGrant | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE id = ?').get(grantId) as GrantRow | undefined;
    return row ? unpack(row) : undefined;
  }
  lookupSession(sessionId: string): PrivateGrant | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE session_id = ?').get(sessionId) as GrantRow | undefined;
    return row ? unpack(row) : undefined;
  }
  discardPending(sessionId: string): void {
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE session_id = ?').get(sessionId) as Pending | undefined;
    if (!row) return;
    this.db.prepare('UPDATE mcp_pending SET consumed = 1 WHERE session_id = ?').run(sessionId);
    this.vault.revoke(pendingBinding(row));
  }
  forSession(sessionId: string, clientId: string): PrivateGrant {
    const row = this.db.prepare('SELECT * FROM mcp_grants WHERE session_id = ? AND client_id = ?')
      .get(sessionId, clientId) as GrantRow | undefined;
    if (!row) throw new AuthorizationDenied();
    return this.active(row.id);
  }
  active(grantId: string): PrivateGrant {
    const grant = this.lookup(grantId);
    if (!grant?.active || grant.expiresAt <= Date.now()) throw new AuthorizationDenied();
    this.vault.get(binding(grant));
    return grant;
  }
  revoke(grantId: string): void {
    const grant = this.lookup(grantId);
    if (!grant) throw new AuthorizationDenied();
    this.db.prepare('UPDATE mcp_grants SET active = 0 WHERE id = ?').run(grantId);
    this.vault.revoke(binding(grant));
  }
}
