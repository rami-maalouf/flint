import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';

import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import { checkCoinRow, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { baselineAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from '@/core/domain/ids';
import type { Hashing } from '@/core/domain/ports';
import { migrateDatabase, migrationChecksum } from '@/core/persistence/migrations';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry, getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { migrations } from '@/core/persistence/schema';

import { NodeSqlDatabase } from '../helpers/test-db';

const hashing: Hashing = {
  sha1: async bytes => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()),
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boardId = id(1) as BoardId;
const date = '2026-09-08' as LogicalDate;
const now = Date.UTC(2026, 8, 8, 12);
const stamp = `${String(now).padStart(14, '0')}-00000-legacy`;
const oldChecksums = ['c459cef6', '34363ca0', 'bac085e2', 'dcbb9394', '633f8fb7',
  '0191110b', 'a901fb95', '14ff0dae', '421ece28', '5d0cab85'];

async function oldDatabase(version = 10, location?: string) {
  const db = new NodeSqlDatabase(location);
  await db.runAsync(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations.filter(item => item.version <= version)) {
    for (const sql of migration.statements) await db.runAsync(sql);
    await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)',
      [migration.version, migration.name, migrationChecksum(migration)]);
  }
  await db.runAsync(`PRAGMA user_version = ${version}`);
  await db.runAsync(`INSERT INTO app_settings (id, schema_revision, device_id, hlc_wall_time, hlc_counter)
    VALUES (1, ?, 'legacy-device', 100, 4)`, [version]);
  await db.runAsync("INSERT INTO sync_state (id, change_token) VALUES (1, 'old-token')");
  await db.runAsync(`INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background,
    tracks_amount, quick_amount, tracks_time, start_of_day_minute, metrics_enabled, order_key,
    created_at, updated_at, mutation_stamp) VALUES (?, 'Retained habit', 'book.fill', '#70A7FF',
    0, 1, 2.5, 1, 0, 1, 'i', 100, 100, ?)`, [boardId, stamp]);
  return db;
}

async function rawCheck(db: NodeSqlDatabase, n: number, deletedAt: number | null = null) {
  const check = { id: id(n) as CheckInId, boardId, logicalDate: date };
  await db.runAsync(`INSERT INTO check_ins (id, board_id, logical_date, occurred_at_utc,
    time_zone_id, offset_minutes, amount, note, source, idempotency_key, created_at,
    updated_at, mutation_stamp, deleted_at) VALUES (?, ?, ?, ?, 'UTC', 0, 2.5,
    'Retained private note', 'shortcut', ?, 100, 100, ?, ?)`,
  [check.id, boardId, date, now, id(n + 100), stamp, deletedAt]);
  return check;
}

async function mixedDatabase(existingBaseline: boolean) {
  const db = await oldDatabase();
  await db.runAsync("UPDATE boards SET kind = 'daily', earns_coins = 1");
  const genuine = await rawCheck(db, 2);
  const legacy = await rawCheck(db, 3);
  const action: HabitAction = { id: id(4) as HabitActionId, commandId: id(102) as CommandId,
    boardId, logicalDate: date, checkInId: genuine.id, kind: 'check', createdAt: now,
    mutationStamp: stamp, policyJson: canonicalCoinPolicy({ version: 1, boardKind: 'daily',
      earnsCoins: true, coinCapPerDay: 1, checkClosesAtUtc: now + 43_200_000,
      rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
  await appendHabitAction(db, action);
  const award = await checkCoinRow(action, hashing);
  await appendLedgerEntry(db, award);
  if (existingBaseline) await appendHabitAction(db, await baselineAction(legacy, hashing));
  return { db, award, legacy };
}

async function payloads(db: NodeSqlDatabase) {
  return db.getAllAsync(`SELECT id, board_id, logical_date, occurred_at_utc, time_zone_id,
    offset_minutes, amount, note, source, idempotency_key, created_at, updated_at,
    mutation_stamp, deleted_at FROM check_ins ORDER BY id`);
}

async function snapshot(db: NodeSqlDatabase) {
  const schema = await db.getAllAsync<{ name: string; type: string; sql: string | null }>(
    'SELECT name, type, sql FROM sqlite_master ORDER BY name');
  const tables = await Promise.all(schema.filter(row => row.type === 'table').map(async ({ name }) =>
    [name, await db.getAllAsync(`SELECT * FROM "${name}" ORDER BY rowid`)]));
  return { schema, tables, version: await db.getFirstAsync('PRAGMA user_version') };
}

describe('remote fact storage and explicit legacy migration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('versions the derived step without changing released checksums', () => {
    expect(migrations.slice(0, 10).map(migrationChecksum)).toEqual(oldChecksums);
    expect(migrations.find(item => item.version === 11)).toMatchObject({ name: 'remote_fact_admission',
      dataStep: { name: 'legacy_check_evidence', version: 1 } });
    const plain = migrations[0];
    const derived = { ...plain, dataStep: { name: 'legacy_check_evidence', version: 1 } };
    expect(migrationChecksum(derived)).not.toBe(migrationChecksum(plain));
    expect(migrationChecksum({ ...derived, dataStep: { ...derived.dataStep, version: 2 } }))
      .not.toBe(migrationChecksum(derived));
  });

  it('upgrades v5 payloads to explicit non-earning legacy evidence and visible state', async () => {
    const db = await oldDatabase(5);
    try {
      const legacy = await rawCheck(db, 2);
      await rawCheck(db, 3, 101);
      const before = await payloads(db);
      const settings = await db.getFirstAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings');
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await payloads(db)).toEqual(before);
      const baseline = await baselineAction(legacy, hashing);
      expect(await db.getAllAsync('SELECT id, kind, created_at, policy_json FROM habit_actions'))
        .toEqual([{ id: baseline.id, kind: 'baseline', created_at: 0, policy_json: null }]);
      expect(await db.getAllAsync('SELECT id, state_suppressed FROM check_ins ORDER BY id'))
        .toEqual([{ id: id(2), state_suppressed: 0 }, { id: id(3), state_suppressed: 1 }]);
      expect(await db.getAllAsync('SELECT entity_type, entity_id FROM mutation_outbox'))
        .toEqual([{ entity_type: 'habit_action', entity_id: baseline.id }]);
      expect(await db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
      expect(await db.getAllAsync('SELECT * FROM command_receipts')).toEqual([]);
      expect(await db.getFirstAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings')).toEqual(settings);
      const outbox = await db.getAllAsync('SELECT * FROM mutation_outbox');
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual(outbox);
    } finally { await db.closeAsync(); }
  });

  it.each([false, true])('settles a retained Daily award with an existing legacy baseline: %s', async existing => {
    const { db, award, legacy } = await mixedDatabase(existing);
    try {
      const before = await payloads(db);
      const savedAward = await db.getFirstAsync('SELECT * FROM coin_ledger WHERE id = ?', [award.id]);
      const baseline = await baselineAction(legacy, hashing);
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await payloads(db)).toEqual(before);
      expect(await db.getFirstAsync('SELECT * FROM coin_ledger WHERE id = ?', [award.id])).toEqual(savedAward);
      expect(await db.getAllAsync('SELECT kind, delta FROM coin_ledger ORDER BY rowid'))
        .toEqual([{ kind: 'check', delta: 1 }, { kind: 'adjustment', delta: -1 }]);
      expect(await db.getAllAsync("SELECT id FROM habit_actions WHERE kind = 'baseline'")).toEqual([{ id: baseline.id }]);
      expect(await db.getAllAsync('SELECT state_suppressed FROM check_ins')).toEqual([
        { state_suppressed: 0 }, { state_suppressed: 0 },
      ]);
      const rows = await db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(rows);
    } finally { await db.closeAsync(); }
  });

  it.each([
    ['second baseline', 'INSERT INTO habit_actions', 2],
    ['second outbox', 'INSERT INTO mutation_outbox', 2],
    ['correction', 'INSERT INTO coin_ledger', 1],
    ['visibility', 'UPDATE check_ins SET state_suppressed', 1],
    ['marker', 'INSERT INTO schema_migrations', 1],
    ['version', 'PRAGMA user_version = 11', 1],
  ] as const)('rolls back all schema and derived writes after a failed %s, then retries', async (_, sqlPart, ordinal) => {
    const { db } = await mixedDatabase(false);
    try {
      await rawCheck(db, 5);
      const before = await snapshot(db);
      const run = db.runAsync.bind(db);
      let matching = 0;
      const spy = jest.spyOn(db, 'runAsync').mockImplementation((sql, params) => {
        if (sql.includes(sqlPart) && ++matching === ordinal) return Promise.reject(new Error('simulated disk failure'));
        return run(sql, params);
      });
      expect(await migrateDatabase(db, { hashing })).toMatchObject({ ok: false,
        error: { code: 'migration', message: 'Database migration failed: simulated disk failure' } });
      expect(await snapshot(db)).toEqual(before);
      spy.mockRestore();
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await db.getAllAsync('SELECT kind, delta FROM coin_ledger ORDER BY rowid'))
        .toEqual([{ kind: 'check', delta: 1 }, { kind: 'adjustment', delta: -1 }]);
      expect(await db.getAllAsync("SELECT id FROM habit_actions WHERE kind = 'baseline'")).toHaveLength(2);
    } finally { await db.closeAsync(); }
  });

  it.each(['sha1', 'sha256'] as const)('rolls back a failed %s adapter after entering the derived step', async method => {
    const { db } = await mixedDatabase(false);
    try {
      const before = await snapshot(db);
      const failing = { ...hashing, [method]: jest.fn().mockRejectedValue(new Error('hash unavailable')) };
      expect(await migrateDatabase(db, { hashing: failing })).toMatchObject({ ok: false,
        error: { code: 'migration', message: 'Database migration failed: hash unavailable' } });
      expect(failing[method]).toHaveBeenCalled();
      expect(await snapshot(db)).toEqual(before);
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
    } finally { await db.closeAsync(); }
  });

  it('keeps the old schema visible to another connection until the acquired-time derived step commits', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'habit-migration-'));
    const location = path.join(directory, 'product.db');
    const db = await oldDatabase(10, location);
    const reader = new NodeSqlDatabase(location);
    try {
      await rawCheck(db, 2);
      const before = await snapshot(reader);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(100);
      const exclusive = db.withExclusiveTransactionAsync.bind(db);
      jest.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation(work => exclusive(tx => {
        clock.mockReturnValue(200);
        return work(tx);
      }));
      const checkedHashing: Hashing = { ...hashing, sha1: async bytes => {
        expect(await snapshot(reader)).toEqual(before);
        return hashing.sha1(bytes);
      } };
      expect(await migrateDatabase(db, { hashing: checkedHashing })).toEqual({ ok: true, value: 11 });
      expect(await reader.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 11 });
      expect(await reader.getFirstAsync('SELECT applied_at FROM schema_migrations WHERE version = 11'))
        .toEqual({ applied_at: 200 });
      expect(await reader.getAllAsync("SELECT created_at FROM mutation_outbox WHERE entity_type = 'habit_action'"))
        .toEqual([{ created_at: 200 }]);
      expect(await reader.getFirstAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'))
        .toEqual({ hlc_wall_time: 100, hlc_counter: 4 });
    } finally { await reader.closeAsync(); await db.closeAsync(); rmSync(directory, { recursive: true }); }
  });

  it.each([{ name: 'unknown', version: 1 }, { name: 'legacy_check_evidence', version: 2 }])(
    'rejects an unsupported descriptor $name/$version before recording its marker', async descriptor => {
      const db = await oldDatabase();
      const step = migrations[10].dataStep!;
      const original = { ...step };
      try {
        await rawCheck(db, 2);
        const before = await snapshot(db);
        Object.assign(step, descriptor);
        expect(await migrateDatabase(db, { hashing })).toMatchObject({ ok: false,
          error: { code: 'migration', message: 'Database migration failed: Unsupported migration data step.' } });
        expect(await snapshot(db)).toEqual(before);
      } finally { Object.assign(step, original); await db.closeAsync(); }
    });

  it('keeps an explicitly cleared legacy payload hidden without deleting its private history', async () => {
    const db = await oldDatabase();
    try {
      await rawCheck(db, 2);
      await appendHabitAction(db, { id: id(3) as HabitActionId, commandId: id(4) as CommandId,
        boardId, logicalDate: date, checkInId: null, kind: 'uncheck', createdAt: now,
        mutationStamp: stamp, policyJson: null });
      const before = await payloads(db);
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(await payloads(db)).toEqual(before);
      expect(await db.getAllAsync('SELECT state_suppressed FROM check_ins')).toEqual([{ state_suppressed: 1 }]);
      expect(await db.getAllAsync("SELECT id FROM habit_actions WHERE kind = 'baseline'")).toHaveLength(1);
      expect(await db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    } finally { await db.closeAsync(); }
  });

  it('settles existing bonus scopes even when live parents and new legacy payloads are absent', async () => {
    const db = await oldDatabase();
    try {
      const vector = bonusFixture.reconciliationCases.find(item => item.name === 'two valid partial awards converge to one held bonus')!;
      for (const action of vector.actions) await appendHabitAction(db, action as HabitAction);
      for (const row of vector.rows) await appendLedgerEntry(db, row as CoinLedgerRow);
      const before = await db.getAllAsync<{ id: string }>('SELECT * FROM coin_ledger ORDER BY id');
      expect(before.length).toBeGreaterThan(0);
      expect(await migrateDatabase(db, { hashing })).toEqual({ ok: true, value: 11 });
      expect(vector.expectedAppendedRows).toHaveLength(1);
      expect(vector.expectedAppendedRows[0]).toMatchObject({ kind: 'adjustment', delta: -1 });
      expect(await db.getAllAsync('SELECT * FROM coin_ledger')).toHaveLength(before.length + 1);
      for (const row of before) expect(await db.getFirstAsync('SELECT * FROM coin_ledger WHERE id = ?', [row.id])).toEqual(row);
      for (const row of vector.expectedAppendedRows) expect(await getLedgerEntry(db, (row as CoinLedgerRow).id)).toEqual(row);
      expect(await db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: vector.expectedBalance });
      expect(await db.getAllAsync("SELECT id FROM habit_actions WHERE kind = 'baseline'")).toEqual([]);
    } finally { await db.closeAsync(); }
  });

  it.each([
    ['other', boardId, date], ['check', 'invalid', date],
    ['check', boardId, '2026-02-30'], ['check', boardId, `${date}:extra`],
  ])('fails closed for corrupt retained scope %s:%s:%s', async (kind, owner, label) => {
    const db = await oldDatabase();
    try {
      await db.runAsync(`INSERT INTO coin_ledger (id, kind, delta, board_id, check_in_id, scope_key,
        source_action_id, logical_date, created_at, mutation_stamp) VALUES (?, 'check', 1, ?, ?, ?, ?, ?, ?, ?)`,
      [id(4), boardId, id(2), `${kind}:${owner}:${label}`, id(3), label === '2026-02-30' ? label : date, now, stamp]);
      const before = await snapshot(db);
      expect(await migrateDatabase(db, { hashing })).toMatchObject({ ok: false,
        error: { code: 'migration', message: 'Database migration failed: Coin evidence invalid.' } });
      expect(await snapshot(db)).toEqual(before);
    } finally { await db.closeAsync(); }
  });
});
