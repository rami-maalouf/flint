import { DatabaseSync } from 'node:sqlite';

import type { SqlDatabase, SqlExecutor, SqlParams } from '../../../src/core/persistence/database.ts';

// the product core port over node:sqlite. one instance owns one connection and
// runs every statement and transaction through a single fifo lane, because the
// core's transaction callbacks are async while node:sqlite is synchronous.
export class NodeSqlDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;
  private readonly executor: SqlExecutor;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    try {
      // node 24.13.0 truncates text at an embedded nul byte; refuse such a runtime.
      const probe = 'before\0after';
      if (this.db.prepare('SELECT ? AS value').get(probe)?.value !== probe) {
        throw new Error('This Node release truncates SQLite text at NUL bytes. Use Node 24.22.2 or later.');
      }
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

  runAsync(sql: string, params: SqlParams = []): Promise<{ changes: number }> {
    return this.enqueue(() => this.executor.runAsync(sql, [...params]));
  }

  getAllAsync<Row>(sql: string, params: SqlParams = []): Promise<Row[]> {
    return this.enqueue(() => this.executor.getAllAsync<Row>(sql, [...params]));
  }

  getFirstAsync<Row>(sql: string, params: SqlParams = []): Promise<Row | null> {
    return this.enqueue(() => this.executor.getFirstAsync<Row>(sql, [...params]));
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

  closeAsync(): Promise<void> {
    this.closing ??= this.schedule(async () => { this.db.close(); });
    return this.closing;
  }

  private enqueue<Value>(work: () => Promise<Value>): Promise<Value> {
    if (this.closing) return Promise.reject(new Error('The database is closed.'));
    return this.schedule(work);
  }

  private schedule<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.queue.then(work);
    // a failed statement must not poison the lane for later work.
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

  // the transaction holds the lane until its callback settles. the callback
  // must use `tx`; queuing on the outer database from inside would deadlock.
  private transaction<Value>(begin: string, work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.enqueue(async () => {
      this.db.exec(begin);
      let active = true;
      const tx = this.rawExecutor(() => {
        if (!active) throw new Error('The transaction has finished.');
      });
      try {
        const value = await work(tx);
        active = false;
        this.db.exec('COMMIT');
        return value;
      } catch (cause) {
        active = false;
        this.db.exec('ROLLBACK');
        throw cause;
      }
    });
  }
}
