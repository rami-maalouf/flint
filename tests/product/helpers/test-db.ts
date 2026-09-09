// real sql engine for jest through node:sqlite, implementing the same
// SqlDatabase port the expo-sqlite adapter implements on device
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { CommandDeps } from '@/core/domain/commands';
import type { CommandId } from '@/core/domain/ids';
import type { Clock, Hashing, IdGenerator } from '@/core/domain/ports';
import type { QueryDeps } from '@/core/domain/queries';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import type { SqlDatabase, SqlExecutor, SqlParams } from '@/core/persistence/database';

export class NodeSqlDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  // one connection: all transactions serialize through this queue
  private queue: Promise<unknown> = Promise.resolve();

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
  }

  private enqueue<Value>(run: () => Promise<Value>): Promise<Value> {
    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => undefined);
    return chained;
  }

  async runAsync(sql: string, params: SqlParams = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  async getAllAsync<Row>(sql: string, params: SqlParams = []): Promise<Row[]> {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  async getFirstAsync<Row>(sql: string, params: SqlParams = []): Promise<Row | null> {
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    return row ?? null;
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  withExclusiveTransactionAsync<Value>(
    work: (tx: SqlExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN EXCLUSIVE');
      try {
        const value = await work(this);
        this.db.exec('COMMIT');
        return value;
      } catch (cause) {
        this.db.exec('ROLLBACK');
        throw cause;
      }
    });
  }

  withTransactionAsync<Value>(work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN');
      try {
        const value = await work(this);
        this.db.exec('COMMIT');
        return value;
      } catch (cause) {
        this.db.exec('ROLLBACK');
        throw cause;
      }
    });
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

export class TestClock implements Clock {
  constructor(
    public utcMs: number = Date.UTC(2026, 7, 30, 16, 0),
    public zone: string = 'America/New_York',
  ) {}

  nowUtcMs(): number {
    return this.utcMs;
  }

  timeZoneId(): string {
    return this.zone;
  }

  advanceMinutes(minutes: number): void {
    this.utcMs += minutes * 60000;
  }

  advanceDays(days: number): void {
    this.utcMs += days * 86400000;
  }
}

export class TestIds implements IdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter += 1;
    const suffix = String(this.counter).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
  }

  nextCommandId(): CommandId {
    return this.uuid() as CommandId;
  }
}

export type TestHarness = {
  db: NodeSqlDatabase;
  clock: TestClock;
  ids: TestIds;
  deps: CommandDeps & QueryDeps;
};

export function createTestHashing(): Hashing {
  return {
    sha1: async (bytes) => new Uint8Array(createHash('sha1').update(bytes).digest()),
    sha256: async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest()),
  };
}

export async function createTestHarness(): Promise<TestHarness> {
  const db = new NodeSqlDatabase();
  const clock = new TestClock();
  const ids = new TestIds();
  const hashing = createTestHashing();
  const initialized = await initializeProductDatabase(db, ids, hashing);
  if (!initialized.ok) {
    throw new Error(initialized.error.message);
  }
  return { db, clock, ids, deps: { db, clock, ids, hashing } };
}
