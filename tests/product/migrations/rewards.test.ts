import { migrateDatabase, migrationChecksum } from '@/core/persistence/migrations';
import { latestSchemaVersion, migrations } from '@/core/persistence/schema';
import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import { checkCoinRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';

import { createTestHashing, NodeSqlDatabase } from '../helpers/test-db';

const rewardId = '00000000-0000-4000-8000-000000000010';
const boardId = '00000000-0000-4000-8000-000000000001';
const stamp = '00000000000100-00000-legacy';
const protectedTables = ['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'command_receipts',
  'mutation_outbox', 'widget_board_rows', 'board_activity_periods', 'sync_state', 'sync_account_bindings', 'sync_deferred'];

async function versionNine() {
  const db = new NodeSqlDatabase();
  await db.runAsync(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations.filter(entry => entry.version <= 9)) {
    for (const sql of migration.statements) await db.runAsync(sql);
    await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)',
      [migration.version, migration.name, migrationChecksum(migration)]);
  }
  await db.runAsync('PRAGMA user_version = 9');
  await db.runAsync(`INSERT INTO app_settings (id, schema_revision, device_id, hlc_wall_time, hlc_counter)
    VALUES (1, 9, 'legacy-device', 100, 4)`);
  await db.runAsync("INSERT INTO sync_state (id, change_token, zone_created) VALUES (1, 'retained-cursor', 1)");
  await db.runAsync(`INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background,
    tracks_amount, quick_amount, tracks_time, start_of_day_minute, metrics_enabled,
    order_key, created_at, updated_at, mutation_stamp) VALUES (
    ?, 'retained count', 'star.fill', '#70A7FF', 1, 1, 2.5, 1, 240, 1, 'i', 100, 100, ?)`, [boardId, stamp]);
  await db.runAsync(`INSERT INTO check_ins VALUES (
    '00000000-0000-4000-8000-000000000002', ?, '2026-09-08', NULL, NULL, NULL, 2.5,
    'retained note', 'shortcut', '00000000-0000-4000-8000-000000000003', 100, 100, ?, NULL)`, [boardId, stamp]);
  const action = {
    id: '00000000-0000-4000-8000-000000000004', commandId: '00000000-0000-4000-8000-000000000003',
    boardId, logicalDate: '2026-09-08', checkInId: '00000000-0000-4000-8000-000000000002',
    kind: 'check', createdAt: 100, mutationStamp: stamp,
    policyJson: canonicalCoinPolicy({ version: 1, boardKind: 'count', earnsCoins: true,
      coinCapPerDay: 1, checkClosesAtUtc: 200, rootId: null, requiredBoardIds: [],
      bonusClosesAtUtc: null, bonusEnabled: false }),
  } as HabitAction;
  await appendHabitAction(db, action);
  const award = await checkCoinRow(action, createTestHashing());
  await appendLedgerEntry(db, award);
  await db.runAsync(`INSERT INTO coin_ledger (id, kind, delta, reward_id, reward_title_snapshot,
    logical_date, created_at, mutation_stamp) VALUES (
    '00000000-0000-4000-8000-000000000006', 'claim', -2, ?, 'Retained café title', '2026-09-08', 100, ?)`, [rewardId, stamp]);
  await db.runAsync('INSERT INTO command_receipts VALUES (?, ?, 100)',
    ['00000000-0000-4000-8000-000000000003', '{"ok":true,"value":{"created":true}}']);
  await db.runAsync(`INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at)
    VALUES ('ledger_entry', ?, ?, 100)`, [award.id, stamp]);
  return db;
}

async function insertReward(db: NodeSqlDatabase) {
  await db.runAsync(`INSERT INTO rewards (id, title, cost_coins, symbol, accent_hex, order_key,
    archived_at, created_at, updated_at, mutation_stamp, deleted_at)
    VALUES (?, 'A small treat', 1, 'star.fill', '#70A7FF', 'i', NULL, 100, 100, ?, NULL)`, [rewardId, stamp]);
}

describe('reward storage migration', () => {
  it('adds empty rewards while preserving all schema-nine history and loose claim references', async () => {
    const db = await versionNine();
    try {
      const before = await Promise.all(protectedTables.map(table => db.getAllAsync(`SELECT * FROM ${table}`)));
      const settings = await db.getFirstAsync('SELECT * FROM app_settings');
      expect(migrations.find(entry => entry.version === 10)?.name).toBe('user_rewards');
      expect(await migrateDatabase(db, { hashing: createTestHashing() })).toEqual({ ok: true, value: latestSchemaVersion });
      expect(await db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
      for (const [index, table] of protectedTables.entries()) expect(await db.getAllAsync(`SELECT * FROM ${table}`))
        .toEqual(table === 'check_ins' ? before[index].map(row => ({ ...row as object, state_suppressed: 0 })) : before[index]);
      expect(await db.getFirstAsync('SELECT * FROM app_settings')).toEqual({ ...settings!, schema_revision: latestSchemaVersion });
      expect(await db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: latestSchemaVersion });
      expect(migrations.slice(0, 9).map(migrationChecksum)).toEqual([
        'c459cef6', '34363ca0', 'bac085e2', 'dcbb9394', '633f8fb7', '0191110b', 'a901fb95', '14ff0dae', '421ece28',
      ]);
      expect(await db.getAllAsync('PRAGMA foreign_key_list(coin_ledger)')).toEqual([]);
      expect(await db.getAllAsync('PRAGMA foreign_key_list(rewards)')).toEqual([]);
      await insertReward(db);
      await db.runAsync('UPDATE rewards SET deleted_at = 101 WHERE id = ?', [rewardId]);
      expect(await db.getAllAsync('SELECT * FROM coin_ledger')).toEqual(before[3]);
      expect(await migrateDatabase(db, { hashing: createTestHashing() })).toEqual({ ok: true, value: latestSchemaVersion });
      expect(await db.getAllAsync('SELECT * FROM rewards')).toHaveLength(1);
      const plan = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT * FROM rewards
        WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY order_key, id`);
      expect(plan.some(row => row.detail.includes('idx_rewards_active'))).toBe(true);
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
    } finally { await db.closeAsync(); }
  });

  it.each(['CREATE INDEX idx_rewards_active', 'UPDATE app_settings SET schema_revision = 10',
    'PRAGMA user_version = 10'])('rolls back all reward migration writes when %s fails and retries', async failure => {
    const db = await versionNine();
    try {
      const tables = [...protectedTables, 'app_settings', 'schema_migrations'];
      const before = await Promise.all(tables.map(table => db.getAllAsync(`SELECT * FROM ${table}`)));
      const run = db.runAsync.bind(db);
      const spy = jest.spyOn(db, 'runAsync').mockImplementation((sql, params) => {
        if (sql.includes(failure)) return Promise.reject(new Error('simulated disk failure'));
        return run(sql, params);
      });
      expect(await migrateDatabase(db, { hashing: createTestHashing() })).toMatchObject({ ok: false, error: { code: 'migration' } });
      expect(await db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 9 });
      expect(await db.getAllAsync("SELECT name FROM sqlite_master WHERE name LIKE '%rewards%'")).toEqual([]);
      for (const [index, table] of tables.entries()) expect(await db.getAllAsync(`SELECT * FROM ${table}`)).toEqual(before[index]);
      spy.mockRestore();
      expect(await migrateDatabase(db, { hashing: createTestHashing() })).toEqual({ ok: true, value: latestSchemaVersion });
      expect(await db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    } finally { await db.closeAsync(); }
  });

  it.each([
    ['cost_coins', 0], ['cost_coins', 100001], ['cost_coins', 1.5], ['cost_coins', 'invalid'],
    ['created_at', -1], ['updated_at', 1.5], ['archived_at', -1], ['deleted_at', 9007199254740992],
  ])('rejects invalid %s value %s at the storage boundary', async (column, value) => {
    const db = await versionNine();
    try {
      expect(await migrateDatabase(db, { hashing: createTestHashing() })).toEqual({ ok: true, value: latestSchemaVersion });
      await insertReward(db);
      await expect(db.runAsync(`UPDATE rewards SET ${column} = ?`, [value])).rejects.toThrow('CHECK constraint failed');
      await db.runAsync('UPDATE rewards SET cost_coins = 100000, archived_at = 0, deleted_at = 0');
      expect(await db.getFirstAsync('SELECT cost_coins FROM rewards')).toEqual({ cost_coins: 100000 });
    } finally { await db.closeAsync(); }
  });
});
