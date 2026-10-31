import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { Hashing } from '../../../src/core/domain/ports';
import { initializeProductDatabase } from '../../../src/core/persistence/bootstrap';
import type { SqlExecutor } from '../../../src/core/persistence/database';
import { migrationChecksum } from '../../../src/core/persistence/migrations';
import { getSettings } from '../../../src/core/persistence/repositories/support';
import { latestSchemaVersion, migrations } from '../../../src/core/persistence/schema';
import { NodeSqlDatabase } from '../src/storage/sqlite';

const hashing: Hashing = {
  sha1: async bytes => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()),
};
const ids = { uuid: () => randomUUID() };
const clock = { nowUtcMs: () => Date.UTC(2026, 9, 30, 12), timeZoneId: () => 'UTC' };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function temporaryDatabase(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'product.sqlite');
}

async function initialize(db: NodeSqlDatabase) {
  const result = await initializeProductDatabase(db, ids, hashing);
  assert.equal(result.ok, true, JSON.stringify(result));
}

test('proof executes on real Node, never Bun SQLite emulation', () => {
  assert.equal(process.release.name, 'node');
  assert.equal('bun' in process.versions, false);
});

test('unchanged product migrations reach schema 12 with exact checksums and durable SQLite settings', async t => {
  const db = new NodeSqlDatabase(temporaryDatabase(t));
  t.after(() => db.closeAsync());
  assert.equal((await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode'))?.journal_mode, 'wal');
  assert.equal((await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys, 1);
  assert.equal((await db.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous'))?.synchronous, 2);
  assert.equal((await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout, 5000);
  await initialize(db);
  assert.equal(latestSchemaVersion, 12);
  assert.deepEqual((await db.getAllAsync<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  )).map(row => ({ ...row })),
    migrations.map(migration => ({ version: migration.version, checksum: migrationChecksum(migration) })));
  assert.equal((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, 12);
  await assert.rejects(db.runAsync('INSERT INTO board_activity_periods (board_id, start_date, mutation_stamp) VALUES (?, ?, ?)',
    ['missing-board', '2026-10-30', 'synthetic']), /FOREIGN KEY/);
});

test('bound values preserve embedded NUL, Unicode, numbers and null without executing SQL content', async t => {
  const db = new NodeSqlDatabase();
  t.after(() => db.closeAsync());
  await db.execAsync('CREATE TABLE sample (value TEXT, amount REAL, optional TEXT)');
  const value = "before\0after café 漢字 '); DROP TABLE sample; --";
  assert.equal((await db.runAsync('INSERT INTO sample VALUES (?, ?, ?)', [value, 2.5, null])).changes, 1);
  assert.equal((await db.getFirstAsync<{ value: string }>('SELECT value FROM sample'))?.value, value);
  assert.deepEqual((await db.getAllAsync<{ value: string; amount: number; optional: null }>(
    'SELECT * FROM sample WHERE value = ?', [value],
  )).map(row => ({ ...row })), [{ value, amount: 2.5, optional: null }]);
  assert.equal(await db.getFirstAsync('SELECT * FROM sample WHERE value = ?', ['absent']), null);
});

for (const method of ['withExclusiveTransactionAsync', 'withTransactionAsync'] as const) {
  test(`${method} awaits its callback and rolls back writes on either side of an await`, async t => {
    const db = new NodeSqlDatabase();
    t.after(() => db.closeAsync());
    await db.execAsync('CREATE TABLE sample (value TEXT)');
    const failure = new Error('synthetic awaited failure');
    await assert.rejects(db[method](async tx => {
      await tx.runAsync('INSERT INTO sample VALUES (?)', ['before']);
      await Promise.resolve();
      await tx.runAsync('INSERT INTO sample VALUES (?)', ['after']);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(await db.getAllAsync('SELECT * FROM sample'), []);
    const result = await db[method](async tx => {
      await tx.runAsync('INSERT INTO sample VALUES (?)', ['committed']);
      return 'callback value';
    });
    assert.equal(result, 'callback value');
    assert.equal((await db.getFirstAsync<{ value: string }>('SELECT value FROM sample'))?.value, 'committed');
  });

  test(`${method} excludes every direct query and other transaction during an awaited rollback`, async t => {
    const db = new NodeSqlDatabase();
    t.after(() => db.closeAsync());
    await db.execAsync('CREATE TABLE sample (value TEXT)');
    const entered = gate();
    const resume = gate();
    const transaction = db[method](async tx => {
      await tx.runAsync('INSERT INTO sample VALUES (?)', ['uncommitted']);
      entered.release();
      await resume.promise;
      throw new Error('roll back');
    });
    const rejected = assert.rejects(transaction, /roll back/);
    await entered.promise;
    const observations: string[] = [];
    const values = ['outside'];
    const outside = [
      db.getFirstAsync<{ value: string }>('SELECT value FROM sample').then(row => {
        observations.push('first'); assert.equal(row, null);
      }),
      db.getAllAsync('SELECT * FROM sample').then(rows => {
        observations.push('all'); assert.deepEqual(rows, []);
      }),
      db.runAsync('INSERT INTO sample VALUES (?)', values).then(() => { observations.push('run'); }),
      db.execAsync("INSERT INTO sample VALUES ('exec')").then(() => { observations.push('exec'); }),
      db.withExclusiveTransactionAsync(async tx => {
        observations.push('transaction');
        await tx.runAsync('INSERT INTO sample VALUES (?)', ['second transaction']);
      }),
    ];
    values[0] = 'mutated after admission';
    // attach handlers before yielding so a broken adapter reports assertion failures cleanly.
    const completed = Promise.allSettled(outside);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(observations, []);
    } finally {
      resume.release();
      await rejected;
    }
    const results = await completed;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.deepEqual((await db.getAllAsync<{ value: string }>('SELECT value FROM sample ORDER BY rowid')).map(row => ({ ...row })),
      [{ value: 'outside' }, { value: 'exec' }, { value: 'second transaction' }]);
  });
}

test('deferred transaction retains one WAL snapshot across an awaited external connection write', async t => {
  const location = temporaryDatabase(t);
  const db = new NodeSqlDatabase(location);
  t.after(() => db.closeAsync());
  await initialize(db);
  await db.execAsync('CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES (\'before\')');
  const other = new DatabaseSync(location);
  t.after(() => other.close());
  await db.withTransactionAsync(async tx => {
    assert.equal((await tx.getFirstAsync<{ value: string }>('SELECT value FROM sample'))?.value, 'before');
    await Promise.resolve();
    other.prepare('UPDATE sample SET value = ?').run('after');
    assert.equal((await tx.getFirstAsync<{ value: string }>('SELECT value FROM sample'))?.value, 'before');
  });
  assert.equal((await db.getFirstAsync<{ value: string }>('SELECT value FROM sample'))?.value, 'after');
});

test('real core commands retain receipts, device identity, HLC and outbox after close/reopen', async t => {
  const location = temporaryDatabase(t);
  let db = new NodeSqlDatabase(location);
  t.after(() => db.closeAsync());
  await initialize(db);
  const board = await createBoard({ db, ids, clock, hashing }, {
    commandId: randomUUID() as CommandId, title: 'synthetic habit', symbol: 'star.fill', accentHex: '#78d98b',
    usesTintedBackground: true, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
  });
  assert.ok(board.ok, JSON.stringify(board));
  const input = { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' as const, note: 'left\0right' };
  const check = await createCheckIn({ db, ids, clock, hashing }, input);
  assert.ok(check.ok, JSON.stringify(check));
  const settings = await getSettings(db);
  assert.ok(settings);
  assert.equal(settings.hlcWallTime, clock.nowUtcMs());
  const receipts = await db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
  const outbox = await db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id');
  assert.ok(outbox.length > 0);
  await db.closeAsync();
  db = new NodeSqlDatabase(location);
  await initialize(db);
  assert.deepEqual(await getSettings(db), settings);
  assert.deepEqual(await db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id'), receipts);
  assert.deepEqual(await createCheckIn({ db, ids, clock, hashing }, input), check);
  assert.deepEqual(await db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'), outbox);
  assert.equal((await db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM check_ins'))?.count, 1);
  assert.equal((await db.getFirstAsync<{ note: string }>('SELECT note FROM check_ins'))?.note, 'left\0right');
});

test('transaction executor expires after callback and close waits for already accepted work', async t => {
  const db = new NodeSqlDatabase();
  t.after(() => db.closeAsync());
  const entered = gate();
  const resume = gate();
  let escaped!: SqlExecutor;
  const work = db.withExclusiveTransactionAsync(async tx => {
    escaped = tx;
    entered.release();
    await resume.promise;
    await tx.runAsync('CREATE TABLE sample (value TEXT)');
  });
  await entered.promise;
  const read = db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM sample');
  const close = db.closeAsync();
  const completed = Promise.all([work, read, close]);
  resume.release();
  const [, row] = await completed;
  assert.equal(row?.count, 0);
  await assert.rejects(escaped.runAsync('INSERT INTO sample VALUES (?)', ['late']), /transaction.*(finished|active|ended)/i);
  await assert.rejects(db.getFirstAsync('SELECT 1'), /clos/i);
  await db.closeAsync();
});

test('commit-time constraint failure rolls back and leaves the lane usable', async t => {
  const db = new NodeSqlDatabase();
  t.after(() => db.closeAsync());
  await db.execAsync(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`);
  await assert.rejects(db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('INSERT INTO child VALUES (?)', [1]);
    await Promise.resolve();
  }), /FOREIGN KEY/);
  assert.equal((await db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM child'))?.count, 0);
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('INSERT INTO parent VALUES (?)', [1]);
    await tx.runAsync('INSERT INTO child VALUES (?)', [1]);
  });
  assert.equal((await db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM child'))?.count, 1);
});

test('a verified released schema prefix opens and upgrades through unchanged core migrations', async t => {
  const location = temporaryDatabase(t);
  const raw = new DatabaseSync(location);
  const first = migrations[0];
  for (const statement of first.statements) raw.exec(statement);
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(first.version, first.name, migrationChecksum(first), 0);
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  const db = new NodeSqlDatabase(location);
  t.after(() => db.closeAsync());
  await initialize(db);
  assert.equal((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, 12);
  assert.equal((await db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM schema_migrations'))?.count, 12);
  assert.ok((await getSettings(db))?.deviceId);
});

for (const [name, corrupt] of [
  ['future user_version', (db: DatabaseSync) => db.exec('PRAGMA user_version = 13')],
  ['unknown migration', (db: DatabaseSync) => db.exec("INSERT INTO schema_migrations VALUES (13, 'future', 'unknown', 0)")],
  ['rewritten checksum', (db: DatabaseSync) => db.exec("UPDATE schema_migrations SET checksum = 'wrong' WHERE version = 1")],
  ['missing migration', (db: DatabaseSync) => db.exec('DELETE FROM schema_migrations WHERE version = 4')],
  ['inconsistent marker', (db: DatabaseSync) => db.exec('PRAGMA user_version = 11')],
  ['missing ledger', (db: DatabaseSync) => db.exec('DROP TABLE schema_migrations')],
] as const) {
  test(`open refuses ${name} without replacing or modifying the product database`, async t => {
    const location = temporaryDatabase(t);
    const db = new NodeSqlDatabase(location);
    await initialize(db);
    await db.closeAsync();
    const raw = new DatabaseSync(location);
    corrupt(raw);
    raw.close();
    const before = readFileSync(location);
    assert.throws(() => {
      const unexpected = new NodeSqlDatabase(location);
      void unexpected.closeAsync();
    }, /schema|migration|checksum|version/i);
    assert.deepEqual(readFileSync(location), before);
  });
}
