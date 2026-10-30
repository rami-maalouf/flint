import { closeSync, constants, existsSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SqlDatabase } from '../../../../src/core/persistence/database';
import type { AuthContext } from '../auth/context';

export type DeliveryGrantBinding = Readonly<Pick<AuthContext, 'accountId' | 'principal' | 'backendUrl' | 'grantId' | 'clientId'>>;
export type DeliveryGrantStatus = Readonly<{ accountId: string; clientId: string; active: boolean; scopes: readonly string[] }>;
export type DeliveryPolicy = Readonly<{
  // a trusted provider query, never a session or credential lookup.
  grantStatus: (grantId: string) => Promise<DeliveryGrantStatus | null>;
}>;

export class DeliveryBarrierError extends Error {
  readonly code = 'OPERATION_PENDING';
  constructor(message: string) { super(message); }
}

const schema = `CREATE TABLE delivery_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
  account_id TEXT NOT NULL, backend_url TEXT NOT NULL, principal TEXT NOT NULL);
CREATE TABLE revoked_grants (grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL);
CREATE TABLE owner_resumes (outbox_id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL);
CREATE TABLE account_pause (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL CHECK (paused IN (0, 1)));`;

function pending(message: string): never { throw new DeliveryBarrierError(message); }
function identifier(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) pending('Invalid delivery binding.');
}
function secure(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    pending('Delivery barrier storage is unsafe.');
  }
}

// this sidecar belongs to one account actor lane. it never opens the product as a writer.
export class DeliveryBarrier {
  private readonly db: DatabaseSync;
  constructor(private readonly directory: string, binding: DeliveryGrantBinding, private readonly policy: DeliveryPolicy) {
    for (const value of [binding.accountId, binding.principal, binding.backendUrl, binding.grantId, binding.clientId]) identifier(value);
    const path = join(directory, 'delivery.sqlite'), existed = existsSync(path);
    const statePath = join(directory, 'operations.sqlite');
    if (!existsSync(statePath)) pending('Delivery provenance marker is missing.');
    const stateFile = lstatSync(statePath);
    if (!stateFile.isFile() || stateFile.nlink !== 1 || (stateFile.mode & 0o077) !== 0 || stateFile.uid !== process.getuid?.()) {
      pending('Delivery provenance storage is unsafe.');
    }
    const state = new DatabaseSync(statePath);
    try {
      state.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
      const meta = state.prepare('SELECT account_id, backend_url, principal, generation FROM runtime_meta WHERE id = 1').get();
      const anchorTable = state.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'delivery_anchor'").get();
      const anchor = anchorTable ? state.prepare('SELECT generation, initialized FROM delivery_anchor WHERE id = 1').get() : null;
      if (!meta || !anchor || meta.account_id !== binding.accountId || meta.backend_url !== binding.backendUrl ||
        meta.principal !== binding.principal || anchor.generation !== meta.generation || ![0, 1].includes(Number(anchor.initialized)) ||
        (anchor.initialized === 1 && !existed) || (anchor.initialized === 0 && existed)) {
        pending('Delivery provenance marker or sidecar is missing or inconsistent.');
      }
      if (anchor.initialized === 0) state.prepare('UPDATE delivery_anchor SET initialized = 1 WHERE id = 1 AND initialized = 0').run();
    } catch (cause) {
      if (cause instanceof DeliveryBarrierError) throw cause;
      pending('Delivery provenance marker requires reconciliation.');
    } finally { state.close(); }
    secure(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
      if (!existed) {
        this.db.exec(`BEGIN IMMEDIATE; ${schema} PRAGMA user_version = 1;`);
        this.db.prepare('INSERT INTO delivery_meta VALUES (1, 1, ?, ?, ?)')
          .run(binding.accountId, binding.backendUrl, binding.principal);
        this.db.prepare('INSERT INTO account_pause VALUES (1, 0)').run();
        this.db.exec('COMMIT');
      }
      const meta = this.db.prepare('SELECT * FROM delivery_meta WHERE id = 1').get();
      const actual = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => String(row.sql).trim()).sort();
      const expected = schema.trim().split(';').map(sql => sql.trim()).filter(Boolean).sort();
      const pause = this.db.prepare('SELECT paused FROM account_pause WHERE id = 1').get();
      if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1 || meta?.version !== 1 ||
        meta.account_id !== binding.accountId || meta.backend_url !== binding.backendUrl || meta.principal !== binding.principal ||
        JSON.stringify(actual) !== JSON.stringify(expected) || !pause || ![0, 1].includes(Number(pause.paused))) {
        pending('Delivery barrier identity or schema needs reconciliation.');
      }
    } catch (cause) { this.db.close(); throw cause; }
  }

  async revoke(binding: DeliveryGrantBinding, product: SqlDatabase, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    identifier(binding.grantId); identifier(binding.clientId);
    const existing = this.db.prepare('SELECT client_id FROM revoked_grants WHERE grant_id = ?').get(binding.grantId);
    if (existing && existing.client_id !== binding.clientId) pending('Revoked grant identity changed.');
    const queueTable = await product.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'mutation_outbox'");
    const queued = queueTable && await product.getFirstAsync('SELECT 1 FROM mutation_outbox LIMIT 1');
    if (signal?.aborted) throw signal.reason;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO revoked_grants VALUES (?, ?)').run(binding.grantId, binding.clientId);
      if (queued) this.db.prepare('UPDATE account_pause SET paused = 1 WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  assertMutationAllowed(): void {
    if (this.db.prepare('SELECT paused FROM account_pause WHERE id = 1').get()?.paused !== 0) {
      pending('Account delivery is paused until the owner explicitly resumes the queued work.');
    }
  }

  private async grant(id: string, accountId: string, clientId: string): Promise<DeliveryGrantStatus | null> {
    const status = await this.policy.grantStatus(id);
    if (status && (status.accountId !== accountId || status.clientId !== clientId || typeof status.active !== 'boolean' ||
      !Array.isArray(status.scopes))) pending('Delivery grant identity is inconsistent.');
    return status;
  }

  async assertCurrent(context: AuthContext): Promise<void> {
    if (context.session.scope !== 'full' || context.session.expiresAt <= Date.now()) pending('A current full session is required for delivery.');
    await context.assertActive();
    const status = await this.grant(context.grantId, context.accountId, context.clientId);
    if (!status?.active || context.scopes.some(scope => !status.scopes.includes(scope)) ||
      this.db.prepare('SELECT 1 FROM revoked_grants WHERE grant_id = ?').get(context.grantId)) {
      pending('The selected delivery grant is revoked.');
    }
    await context.assertActive();
  }

  private async outbox(db: SqlDatabase): Promise<{ id: number }[]> {
    const table = await db.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'mutation_outbox'");
    return table ? db.getAllAsync<{ id: number }>('SELECT id FROM mutation_outbox ORDER BY id LIMIT 1001') : [];
  }

  async exceedsWindow(product: SqlDatabase): Promise<boolean> { return (await this.outbox(product)).length > 1000; }

  async refreshRevokedOrigins(context: AuthContext, product: SqlDatabase, deliveryWindow = false): Promise<void> {
    if (this.db.prepare('SELECT paused FROM account_pause WHERE id = 1').get()?.paused === 1) return;
    const rows = await this.outbox(product);
    if (rows.length > 1000 && !deliveryWindow) pending('Delivery queue exceeds one bounded admission window.');
    if (!rows.length) return;
    const journal = new DatabaseSync(join(this.directory, 'journal.sqlite'), { readOnly: true });
    const state = new DatabaseSync(join(this.directory, 'operations.sqlite'), { readOnly: true });
    try {
      const tupleFor = journal.prepare('SELECT client_id, operation_id FROM tuples WHERE outbox_id = ?');
      const grantFor = state.prepare('SELECT grant_id FROM operation_grants WHERE client_id = ? AND operation_id = ?');
      const seen = new Set<string>();
      for (const row of rows.slice(0, 1000)) {
        const tuple = tupleFor.get(row.id);
        if (!tuple) continue;
        const origin = grantFor.get(tuple.client_id, tuple.operation_id);
        if (!origin || typeof origin.grant_id !== 'string') pending('Delivery operation provenance is missing.');
        const id = String(origin.grant_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const known = this.db.prepare('SELECT 1 FROM revoked_grants WHERE grant_id = ?').get(id);
        const status = await this.grant(id, context.accountId, String(tuple.client_id));
        if (!status?.active && !known) {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.prepare('INSERT OR IGNORE INTO revoked_grants VALUES (?, ?)').run(id, tuple.client_id);
            this.db.prepare('UPDATE account_pause SET paused = 1 WHERE id = 1').run();
            this.db.exec('COMMIT');
          } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
          break;
        }
      }
    } finally { state.close(); journal.close(); }
  }

  async authorizeQueue(context: AuthContext, product: SqlDatabase, maxId?: number): Promise<number> {
    await this.assertCurrent(context);
    await this.refreshRevokedOrigins(context, product, true);
    this.assertMutationAllowed();
    const rows = await this.outbox(product);
    if (maxId !== undefined && rows.slice(0, 1000).some(row => row.id > maxId)) {
      pending('Delivery pass reached its frozen queue boundary.');
    }
    const statuses = new Map<string, DeliveryGrantStatus | null>();
    const journal = new DatabaseSync(join(this.directory, 'journal.sqlite'), { readOnly: true });
    const state = new DatabaseSync(join(this.directory, 'operations.sqlite'), { readOnly: true });
    try {
      const tupleFor = journal.prepare('SELECT client_id, operation_id FROM tuples WHERE outbox_id = ?');
      const grantFor = state.prepare('SELECT grant_id FROM operation_grants WHERE client_id = ? AND operation_id = ?');
      for (const row of rows.slice(0, 1000)) {
        const tuple = tupleFor.get(row.id);
        const origin = tuple ? grantFor.get(tuple.client_id, tuple.operation_id) : null;
        if (tuple && (!origin || typeof origin.grant_id !== 'string')) pending('Delivery operation provenance is missing.');
        const originId = origin ? String(origin.grant_id) : null;
        if (originId && !statuses.has(originId)) statuses.set(originId,
          await this.grant(originId, context.accountId, String(tuple!.client_id)));
        const owner = originId && originId === context.grantId && statuses.get(originId)?.active &&
          !this.db.prepare('SELECT 1 FROM revoked_grants WHERE grant_id = ?').get(originId);
        if (!owner && this.db.prepare('SELECT grant_id FROM owner_resumes WHERE outbox_id = ?').get(row.id)?.grant_id !== context.grantId) {
          pending('Mixed, revoked or unattributed queue needs explicit owner resume.');
        }
      }
    } finally { state.close(); journal.close(); }
    await this.assertCurrent(context);
    return maxId ?? rows[Math.min(rows.length, 1000) - 1]?.id ?? 0;
  }

  async resume(context: AuthContext, product: SqlDatabase): Promise<number> {
    await this.assertCurrent(context);
    const rows = await this.outbox(product);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM owner_resumes').run();
      const insert = this.db.prepare('INSERT INTO owner_resumes VALUES (?, ?)');
      for (const row of rows.slice(0, 1000)) insert.run(row.id, context.grantId);
      this.db.prepare('UPDATE account_pause SET paused = 0 WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
    await this.assertCurrent(context);
    return Math.min(rows.length, 1000);
  }

  close(): void { this.db.close(); }
}
