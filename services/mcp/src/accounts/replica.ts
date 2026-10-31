import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AuthContext } from '../auth/context';
import { NodeSqlDatabase } from '../core';

export class ReplicaError extends Error {
  readonly code = 'UNAVAILABLE';
  readonly retryable = true;
}

export function accountDirectory(root: string, accountId: string): string {
  return join(root, createHash('sha256').update(accountId).digest('hex'));
}

export function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new ReplicaError('Replica directory must be private and owned by the service.');
  }
}

function privateFile(path: string): void {
  // never open/close an existing lock inode through fs: posix close can release process locks.
  if (!existsSync(path)) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new ReplicaError('Replica files must be private regular files owned by the service.');
  }
}

export type ReplicaLimits = { maxAccountBytes: number; minFreeBytes: number };
type Binding = { account_id: string; backend_url: string; principal: string;
  healthy_pull_at: number | null; healthy_revision: string | null };
const bindingSchema = `CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
  backend_url TEXT NOT NULL, principal TEXT NOT NULL, healthy_pull_at INTEGER, healthy_revision TEXT)`;
const historySchema = `CREATE TABLE operation_provenance (id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('never', 'initialized', 'unknown')))`;
export type OperationHistoryState = 'never' | 'initialized' | 'unknown';

// this handle is owned by the actor's lane, including initialization and close.
export class AccountReplica {
  readonly directory: string;
  readonly db: NodeSqlDatabase;
  private readonly lock: DatabaseSync;
  private readonly state: DatabaseSync;
  private closed = false;

  constructor(root: string, readonly backendUrl: string, readonly context: Pick<AuthContext, 'accountId' | 'principal'>,
    private readonly limits: ReplicaLimits) {
    this.directory = accountDirectory(root, context.accountId);
    privateDirectory(this.directory);
    this.checkDisk();
    const lockPath = join(this.directory, 'ownership.sqlite');
    privateFile(lockPath);
    this.lock = new DatabaseSync(lockPath);
    let state: DatabaseSync | undefined, product: NodeSqlDatabase | undefined;
    try {
      this.lock.exec('PRAGMA busy_timeout = 0');
      const mode = this.lock.prepare('PRAGMA journal_mode = DELETE').get();
      if (mode?.journal_mode !== 'delete') throw new ReplicaError('Replica ownership requires rollback journal locking.');
      this.lock.exec('BEGIN EXCLUSIVE');
      for (const name of readdirSync(this.directory)) privateFile(join(this.directory, name));
      const statePath = join(this.directory, 'replica.sqlite');
      if (!existsSync(statePath) && ['product.sqlite', 'operations.sqlite', 'journal.sqlite', 'delivery.sqlite']
        .some(name => existsSync(join(this.directory, name)))) {
        throw new ReplicaError('Replica metadata is missing from an existing account.');
      }
      privateFile(statePath);
      state = new DatabaseSync(statePath);
      state.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
      const version = state.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new ReplicaError('Unsupported replica metadata schema.');
      if (version === 0) {
        if (state.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").get()) {
          throw new ReplicaError('Unrecognized replica metadata.');
        }
        state.exec(`BEGIN EXCLUSIVE; ${bindingSchema}; ${historySchema}; PRAGMA user_version = 2;`);
        state.prepare('INSERT INTO binding (id, account_id, backend_url, principal) VALUES (1, ?, ?, ?)')
          .run(context.accountId, backendUrl, context.principal);
        state.prepare("INSERT INTO operation_provenance VALUES (1, 'never')").run();
        state.exec('COMMIT');
      }
      if (state.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'binding'").get()?.sql !== bindingSchema) {
        throw new ReplicaError('Replica metadata schema does not match its released definition.');
      }
      if (version === 1) {
        const tables = state.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        if (tables.length !== 1 || tables[0].name !== 'binding') throw new ReplicaError('Legacy replica metadata is ambiguous.');
        const retained = existsSync(join(this.directory, 'operations.sqlite')) || existsSync(join(this.directory, 'journal.sqlite'));
        state.exec(`BEGIN IMMEDIATE; ${historySchema};`);
        try {
          state.prepare('INSERT INTO operation_provenance VALUES (1, ?)').run(retained ? 'initialized' : 'unknown');
          state.exec('PRAGMA user_version = 2; COMMIT');
        } catch (cause) { state.exec('ROLLBACK'); throw cause; }
      }
      if (state.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operation_provenance'").get()?.sql !== historySchema ||
        !['never', 'initialized', 'unknown'].includes(String(state.prepare('SELECT state FROM operation_provenance WHERE id = 1').get()?.state))) {
        throw new ReplicaError('Operation provenance marker is missing or invalid.');
      }
      const tables = state.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(row => row.name);
      if (JSON.stringify(tables) !== JSON.stringify(['binding', 'operation_provenance'])) {
        throw new ReplicaError('Replica metadata schema has unexpected tables.');
      }
      this.state = state;
      this.assertBinding(context, backendUrl);
      const productPath = join(this.directory, 'product.sqlite');
      // losing a previously healthy product file is a restore event, never a new empty cache.
      if (this.binding().healthy_pull_at !== null && (!existsSync(productPath) || lstatSync(productPath).size === 0)) {
        throw new ReplicaError('Previously bootstrapped product replica is missing. Restore and reconcile it.');
      }
      privateFile(productPath);
      product = new NodeSqlDatabase(productPath);
      this.db = product;
    } catch (cause) {
      void product?.closeAsync();
      state?.close();
      this.lock.close();
      if (cause instanceof ReplicaError) throw cause;
      throw new ReplicaError('Replica could not be opened. It may already have an owner or require schema repair.');
    }
  }

  private binding(): Binding {
    const row = this.state.prepare('SELECT account_id, backend_url, principal, healthy_pull_at, healthy_revision FROM binding WHERE id = 1').get();
    if (!row) throw new ReplicaError('Replica binding is missing.');
    if ((row.healthy_pull_at !== null && (typeof row.healthy_pull_at !== 'number' || !Number.isSafeInteger(row.healthy_pull_at))) ||
      (row.healthy_revision !== null && (typeof row.healthy_revision !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(row.healthy_revision)))) {
      throw new ReplicaError('Replica bootstrap metadata is invalid.');
    }
    return row as Binding;
  }

  assertBinding(ctx: Pick<AuthContext, 'accountId' | 'principal'>, backendUrl: string): void {
    const binding = this.binding();
    if (binding.account_id !== ctx.accountId || binding.backend_url !== backendUrl || binding.principal !== ctx.principal) {
      throw new ReplicaError('Replica account binding does not match the admitted identity.');
    }
  }

  get lastHealthyPullAtUtc(): number | null { return this.binding().healthy_pull_at; }

  get operationHistoryState(): OperationHistoryState {
    const state = this.state.prepare('SELECT state FROM operation_provenance WHERE id = 1').get()?.state;
    if (state !== 'never' && state !== 'initialized' && state !== 'unknown') {
      throw new ReplicaError('Operation provenance marker is missing or invalid.');
    }
    return state;
  }

  markOperationHistory(): void {
    if (this.operationHistoryState !== 'never') throw new ReplicaError('Operation history cannot be reinitialized.');
    const result = this.state.prepare("UPDATE operation_provenance SET state = 'initialized' WHERE id = 1 AND state = 'never'").run();
    if (result.changes !== 1) throw new ReplicaError('Operation provenance marker could not be committed.');
    const directory = openSync(this.directory, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  markHealthy(at: number, revision: string | null): void {
    this.state.prepare('UPDATE binding SET healthy_pull_at = ?, healthy_revision = ? WHERE id = 1').run(at, revision);
  }

  async boundProduct(): Promise<void> {
    const pageSize = (await this.db.getFirstAsync<{ page_size: number }>('PRAGMA page_size'))!.page_size;
    const maxPages = Math.floor(this.limits.maxAccountBytes / pageSize);
    const bounded = await this.db.getFirstAsync<{ max_page_count: number }>(`PRAGMA max_page_count = ${maxPages}`);
    if (!bounded || bounded.max_page_count > maxPages) throw new ReplicaError('Replica exceeds its product page budget.');
    await this.db.execAsync('PRAGMA busy_timeout = 0; PRAGMA wal_autocheckpoint = 256; PRAGMA journal_size_limit = 1048576');
  }

  checkDisk(): void {
    let bytes = 0;
    const names = readdirSync(this.directory);
    if (names.length > 64) throw new ReplicaError('Replica file budget exceeded.');
    for (const name of names) {
      const stat = lstatSync(join(this.directory, name));
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new ReplicaError('Replica contains an unsafe file.');
      }
      bytes += stat.size;
    }
    const disk = statfsSync(this.directory);
    if (bytes > this.limits.maxAccountBytes || disk.bavail * disk.bsize < this.limits.minFreeBytes) {
      throw new ReplicaError('Replica storage budget is unavailable.');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.db.closeAsync(); }
    finally { try { this.state.close(); } finally { this.lock.close(); } }
  }
}
