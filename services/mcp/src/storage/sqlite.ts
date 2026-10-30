import { DatabaseSync } from 'node:sqlite';

import type { SqlDatabase, SqlExecutor, SqlParams } from '../../../../src/core/persistence/database';
import { migrationChecksum } from '../../../../src/core/persistence/migrations';
import { latestSchemaVersion, migrations } from '../../../../src/core/persistence/schema';

// one instance owns one connection. account/process ownership is enforced by the caller.
export class NodeSqlDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;
  private readonly executor: SqlExecutor;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(location = ':memory:') {
    if (process.release.name !== 'node' || 'bun' in process.versions) {
      throw new Error('The product SQLite adapter requires Node, not Bun SQLite emulation.');
    }
    this.db = new DatabaseSync(location);
    try {
      // older node:sqlite releases silently truncate text at embedded nul bytes.
      const probe = 'before\0after';
      if (this.db.prepare('SELECT ? AS value').get(probe)?.value !== probe) {
        throw new Error('node:sqlite truncates embedded NUL text. Use the verified Node 24.22.2 runtime.');
      }
      this.verifyProductSchema();
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
    } catch (cause) {
      this.db.close();
      throw cause;
    }
    this.executor = this.rawExecutor(() => undefined);
  }

  // validate before changing connection pragmas or letting the core migrate.
  // accept only a contiguous, checksum-matching prefix of the released schema.
  private verifyProductSchema(): void {
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version < 0 || version > latestSchemaVersion) {
      throw new Error('Unsupported product schema version.');
    }
    const ledger = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!ledger) {
      const table = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (version !== 0 || table) throw new Error('Product schema has no migration ledger.');
      return;
    }
    const applied = this.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    for (const [index, row] of applied.entries()) {
      const migration = migrations[index];
      if (!migration || row.version !== migration.version || row.checksum !== migrationChecksum(migration)) {
        throw new Error('Product migration version or checksum does not match the released schema.');
      }
    }
    if (version !== (applied.at(-1)?.version ?? 0)) {
      throw new Error('Product schema version does not match its migration ledger.');
    }
  }

  private enqueue<Value>(work: () => Promise<Value>): Promise<Value> {
    if (this.closing) return Promise.reject(new Error('The database is closing or closed.'));
    return this.schedule(work);
  }

  private schedule<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.queue.then(work);
    // a failed operation must not poison the lane for later work or close.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private rawExecutor(assertActive: () => void): SqlExecutor {
    return {
      runAsync: async (sql, params = []) => {
        assertActive();
        return { changes: Number(this.db.prepare(sql).run(...params).changes) };
      },
      getAllAsync: async <Row>(sql: string, params: SqlParams = []) => {
        assertActive();
        return this.db.prepare(sql).all(...params) as Row[];
      },
      getFirstAsync: async <Row>(sql: string, params: SqlParams = []) => {
        assertActive();
        return (this.db.prepare(sql).get(...params) as Row | undefined) ?? null;
      },
    };
  }

  runAsync(sql: string, params: SqlParams = []): Promise<{ changes: number }> {
    const values = [...params];
    return this.enqueue(() => this.executor.runAsync(sql, values));
  }

  getAllAsync<Row>(sql: string, params: SqlParams = []): Promise<Row[]> {
    const values = [...params];
    return this.enqueue(() => this.executor.getAllAsync<Row>(sql, values));
  }

  getFirstAsync<Row>(sql: string, params: SqlParams = []): Promise<Row | null> {
    const values = [...params];
    return this.enqueue(() => this.executor.getFirstAsync<Row>(sql, values));
  }

  execAsync(sql: string): Promise<void> {
    return this.enqueue(async () => { this.db.exec(sql); });
  }

  withExclusiveTransactionAsync<Value>(work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.transaction('BEGIN EXCLUSIVE', work);
  }

  withTransactionAsync<Value>(work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.transaction('BEGIN DEFERRED', work);
  }

  private transaction<Value>(begin: string, work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.enqueue(async () => {
      this.db.exec(begin);
      let active = true;
      const tx = this.rawExecutor(() => {
        if (!active) throw new Error('The transaction has finished.');
      });
      try {
        // callbacks must await their work and use tx, never the outer queued database.
        const value = await work(tx);
        active = false;
        this.db.exec('COMMIT');
        return value;
      } catch (cause) {
        active = false;
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackFailure) {
          throw new AggregateError([cause, rollbackFailure], 'Transaction failed and could not be rolled back.');
        }
        throw cause;
      }
    });
  }

  closeAsync(): Promise<void> {
    this.closing ??= this.schedule(async () => { this.db.close(); });
    return this.closing;
  }
}
