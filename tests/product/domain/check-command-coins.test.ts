import { admitLegacyChecks } from '../helpers/legacy-checks';
import writerFixture from '@/core/automations/fixtures/coin-writers.json';
import { runCheckInIntent, runRemoveLatestIntent } from '@/core/automations/contract';
import {
  archiveBoard, createBoard, createCheckIn, removeCheckIn, removeLatestCheckIn,
  toggleDailyCheckIn, undoCreatedCheckIn, updateBoard,
} from '@/core/domain/commands';
import { coinLedgerTotals } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy, parseCoinPolicy } from '@/core/domain/coin-policy';
import type { BoardKind } from '@/core/domain/entities';
import type { BoardId, CheckInId, CommandId, LogicalDate } from '@/core/domain/ids';
import { isUuidV5 } from '@/core/domain/ids';
import type { SqlDatabase, SqlExecutor, SqlParams } from '@/core/persistence/database';
import { getBoardById, insertBoard } from '@/core/persistence/repositories/boards';
import { insertCheckIn } from '@/core/persistence/repositories/check-ins';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';
import { insertPeriod } from '@/core/persistence/repositories/support';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const date = '2026-09-08' as LogicalDate;
const now = 1788868800000;
const closesAt = 1788912000000;
const fields = { title: 'Coin command', symbol: 'star.fill', accentHex: '#70A7FF',
  usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true };
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger',
  'command_receipts', 'app_settings', 'widget_board_rows', 'mutation_outbox'];

async function snapshot(db: SqlExecutor, includeReceipts = true) {
  const selected = tables.filter((table) => includeReceipts || table !== 'command_receipts');
  const rows = await Promise.all(selected.map((table) => db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  return Object.fromEntries(selected.map((table, index) => [table, rows[index]]));
}

function failingAt(db: SqlDatabase, predicate: (sql: string, params?: SqlParams) => boolean): SqlDatabase {
  const wrapped = Object.create(db) as SqlDatabase;
  wrapped.withExclusiveTransactionAsync = (work) => db.withExclusiveTransactionAsync((tx) => {
    const failing = Object.create(tx) as SqlExecutor;
    failing.runAsync = (sql, params) => {
      if (predicate(sql, params)) throw new Error('simulated coin storage failure');
      return tx.runAsync(sql, params);
    };
    return work(failing);
  });
  return wrapped;
}

describe('check command coin accounting', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); h.clock.utcMs = now; h.clock.zone = 'UTC'; });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  async function board(kind: BoardKind = 'count', options?: { earnsCoins: boolean; cap: number }) {
    const result = await createBoard(h.deps, { ...fields, kind, commandId: h.ids.nextCommandId() });
    if (!result.ok) throw new Error(result.error.message);
    // earning controls are not exposed until every writer is integrated.
    if (options) await h.db.runAsync('UPDATE boards SET earns_coins = ?, coin_cap_per_day = ? WHERE id = ?', [options.earnsCoins ? 1 : 0, options.cap, result.value.boardId]);
    return result.value.boardId;
  }
  async function check(boardId: BoardId, note?: string) {
    const commandId = h.ids.nextCommandId();
    const result = await createCheckIn(h.deps, { commandId, boardId, logicalDate: date, source: 'app', note });
    if (!result.ok) throw new Error(result.error.message);
    return { commandId, ...result.value };
  }
  const ledger = (boardId: BoardId) => listLedgerEntriesForScope(h.db, `check:${boardId}:${date}`);
  async function totals(boardId: BoardId) { return coinLedgerTotals(await ledger(boardId)); }
  async function convertToDaily(boardId: BoardId) {
    const current = await getBoardById(h.db, boardId);
    if (!current) throw new Error('missing fixture board');
    expect(await updateBoard(h.deps, { ...current, kind: 'daily', commandId: h.ids.nextCommandId(), boardId, expectedMutationStamp: current.mutationStamp }))
      .toMatchObject({ ok: true });
  }

  it.each(['count', 'daily'] as const)('earns one coin from a genuine %s check with canonical causal evidence', async (kind) => {
    const boardId = await board(kind, { earnsCoins: true, cap: 2 });
    const created = await check(boardId, 'Keep this note');
    const actions = await listHabitActions(h.db, boardId, date);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action).toMatchObject({ kind: 'check', commandId: created.commandId, checkInId: created.checkInId, createdAt: now,
      policyJson: canonicalCoinPolicy({ version: 1, boardKind: kind, earnsCoins: true, coinCapPerDay: 2,
        checkClosesAtUtc: closesAt, rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) });
    const rows = await ledger(boardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'check', delta: 1, boardId, checkInId: created.checkInId,
      sourceActionId: action.id, scopeKey: `check:${boardId}:${date}`, logicalDate: date,
      createdAt: action.createdAt, mutationStamp: action.mutationStamp, deletedAt: null });
    expect(isUuidV5(rows[0].id)).toBe(true);
    expect(await h.db.getAllAsync('SELECT entity_id, mutation_stamp, created_at FROM mutation_outbox WHERE entity_type = ?', ['ledger_entry']))
      .toEqual([{ entity_id: rows[0].id, mutation_stamp: action.mutationStamp, created_at: now }]);
    expect(await h.db.getFirstAsync('SELECT note, source FROM check_ins WHERE id = ?', [created.checkInId]))
      .toEqual({ note: 'Keep this note', source: 'app' });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
  });

  it.each([1, 10])('honors Count cap %s without losing checks or awarding previously blocked history', async (cap) => {
    const boardId = await board('count', { earnsCoins: true, cap });
    const created: Awaited<ReturnType<typeof check>>[] = [];
    for (let index = 0; index <= cap; index++) created.push(await check(boardId, `check ${index}`));
    expect(await totals(boardId)).toEqual({ earned: cap, spent: 0, balance: cap });
    expect(await h.db.getAllAsync('SELECT id FROM check_ins WHERE board_id = ? AND deleted_at IS NULL', [boardId])).toHaveLength(cap + 1);
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: created[0].checkInId })).toMatchObject({ ok: true });
    expect(await totals(boardId)).toEqual({ earned: cap, spent: 1, balance: cap - 1 });
    expect((await ledger(boardId)).filter((row) => row.checkInId === created[cap].checkInId)).toEqual([]);
    const fresh = await check(boardId);
    expect(await totals(boardId)).toEqual({ earned: cap + 1, spent: 1, balance: cap });
    expect((await ledger(boardId)).some((row) => row.kind === 'check' && row.checkInId === fresh.checkInId)).toBe(true);
  });

  it.each(['default', 'explicitly off'] as const)('captures a truthful non-earning policy when the board is %s', async (mode) => {
    const boardId = await board('count', mode === 'default' ? undefined : { earnsCoins: false, cap: 3 });
    await check(boardId);
    const actions = await listHabitActions(h.db, boardId, date);
    expect(actions[0].policyJson).not.toBeNull();
    expect(parseCoinPolicy(actions[0].policyJson!)).toMatchObject({ earnsCoins: false, coinCapPerDay: mode === 'default' ? 1 : 3 });
    expect(await ledger(boardId)).toEqual([]);
  });

  it('preserves amount, selected time and source while a Count check earns', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 1 });
    await h.db.runAsync('UPDATE boards SET tracks_amount = 1, tracks_time = 1 WHERE id = ?', [boardId]);
    const occurredAtUtc = now - 3_600_000;
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, amount: 2.5, occurredAtUtc, source: 'widget', note: 'Retain fields' });
    if (!result.ok) throw new Error(result.error.message);
    expect(await h.db.getFirstAsync('SELECT amount, occurred_at_utc, time_zone_id, offset_minutes, source, note FROM check_ins WHERE id = ?', [result.value.checkInId]))
      .toEqual({ amount: 2.5, occurred_at_utc: occurredAtUtc, time_zone_id: 'UTC', offset_minutes: 0, source: 'widget', note: 'Retain fields' });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
  });

  it('does not award, advance evidence, or give Undo ownership to a Daily no-op', async () => {
    const boardId = await board('daily', { earnsCoins: true, cap: 3 });
    const first = await check(boardId);
    const before = await snapshot(h.db, false);
    const noop = await check(boardId);
    expect(noop).toMatchObject({ created: false, checkInId: first.checkInId, logicalDate: date });
    expect(await snapshot(h.db, false)).toEqual(before);
    expect(await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: noop.checkInId, createdByCommandId: noop.commandId }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await snapshot(h.db, false)).toEqual(before);
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
  });

  it('earns, clears and re-earns through the widget Daily toggle with fresh immutable rows', async () => {
    const boardId = await board('daily', { earnsCoins: true, cap: 1 });
    const run = () => toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: date, source: 'widget' });
    expect(await run()).toMatchObject({ ok: true, value: { checked: true, created: true } });
    expect(await run()).toMatchObject({ ok: true, value: { checked: false, created: false } });
    expect(await run()).toMatchObject({ ok: true, value: { checked: true, created: true } });
    expect(await totals(boardId)).toEqual({ earned: 2, spent: 1, balance: 1 });
    expect(await h.db.getAllAsync('SELECT source FROM check_ins WHERE board_id = ?', [boardId]))
      .toEqual([{ source: 'widget' }, { source: 'widget' }]);
  });

  const removals = ['history', 'latest count', 'undo', 'daily toggle', 'latest daily'] as const;
  it.each(removals.flatMap((method) => [-1, 0, 1].map((offset) => ({ method, offset }))))(
    '$method at close plus $offset ms reverses only before the captured close', async ({ method, offset }) => {
      const boardId = await board(method.includes('daily') ? 'daily' : 'count', { earnsCoins: true, cap: 1 });
      const created = await check(boardId);
      const earned = await ledger(boardId);
      expect(earned).toHaveLength(1);
      h.clock.utcMs = closesAt + offset;
      const commandId = h.ids.nextCommandId();
      const result = method === 'history' ? await removeCheckIn(h.deps, { commandId, checkInId: created.checkInId })
        : method === 'undo' ? await undoCreatedCheckIn(h.deps, { commandId, checkInId: created.checkInId, createdByCommandId: created.commandId })
          : method === 'daily toggle' ? await toggleDailyCheckIn(h.deps, { commandId, boardId, logicalDate: date })
            : await removeLatestCheckIn(h.deps, { commandId, boardId, logicalDate: date });
      expect(result).toMatchObject({ ok: true });
      expect(await h.db.getAllAsync('SELECT id FROM check_ins WHERE board_id = ? AND deleted_at IS NULL', [boardId])).toEqual([]);
      expect(await totals(boardId)).toEqual({ earned: 1, spent: offset < 0 ? 1 : 0, balance: offset < 0 ? 0 : 1 });
      const rows = await ledger(boardId);
      if (offset < 0) expect(rows.find((row) => row.kind === 'reversal')).toMatchObject({ delta: -1, reversesId: earned[0].id });
      else expect(rows).toEqual(earned);
    },
  );

  it('preserves exact Undo ownership when a newer Count check also earned', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 2 });
    const first = await check(boardId, 'first');
    h.clock.advanceMinutes(1);
    const second = await check(boardId, 'second');
    expect(await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId, createdByCommandId: first.commandId })).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync('SELECT id, note FROM check_ins WHERE board_id = ? AND deleted_at IS NULL', [boardId]))
      .toEqual([{ id: second.checkInId, note: 'second' }]);
    const rows = await ledger(boardId);
    const award = rows.find((row) => row.kind === 'check' && row.checkInId === first.checkInId);
    expect(award).toBeDefined();
    expect(rows.find((row) => row.kind === 'reversal')).toMatchObject({ reversesId: award!.id });
    expect(await totals(boardId)).toEqual({ earned: 2, spent: 1, balance: 1 });
  });

  it('removing the awarded converted-Daily token does not transfer its coin to a retained token', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 1 });
    const first = await check(boardId, 'awarded');
    const blocked = await check(boardId, 'retained');
    await convertToDaily(boardId);
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId })).toMatchObject({ ok: true });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 1, balance: 0 });
    expect(await check(boardId)).toMatchObject({ created: false, checkInId: blocked.checkInId });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 1, balance: 0 });
    expect(await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: date })).toMatchObject({ ok: true });
    await check(boardId);
    expect(await totals(boardId)).toEqual({ earned: 2, spent: 1, balance: 1 });
  });

  it('clears every converted-Daily check and reverses each eligible award once', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 3 });
    const first = await check(boardId, 'first note');
    const second = await check(boardId, 'second note');
    await convertToDaily(boardId);
    const result = await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: date });
    expect(result).toMatchObject({ ok: true, value: { checked: false, removedCheckInIds: [first.checkInId, second.checkInId] } });
    expect(await totals(boardId)).toEqual({ earned: 2, spent: 2, balance: 0 });
    const actions = await listHabitActions(h.db, boardId, date);
    expect(actions.filter((action) => action.kind === 'uncheck')).toMatchObject([{ checkInId: null }]);
    expect(await h.db.getAllAsync('SELECT note FROM check_ins WHERE board_id = ? ORDER BY id', [boardId]))
      .toEqual([{ note: 'first note' }, { note: 'second note' }]);
  });

  it('retains explicitly admitted legacy duplicate history without baseline earnings', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 3 });
    const current = await getBoardById(h.db, boardId);
    if (!current) throw new Error('missing fixture board');
    for (const note of ['legacy one', 'legacy two']) {
      const legacy = { id: h.ids.uuid() as CheckInId, boardId, logicalDate: date, occurredAtUtc: null,
        timeZoneId: null, offsetMinutes: null, amount: null, note, source: 'app' as const, idempotencyKey: h.ids.nextCommandId(),
        createdAt: now - 1000, updatedAt: now - 1000, mutationStamp: current.mutationStamp, deletedAt: null };
      await insertCheckIn(h.db, legacy);
      await admitLegacyChecks(h, [legacy]);
    }
    await convertToDaily(boardId);
    expect(await check(boardId)).toMatchObject({ created: false });
    expect(await ledger(boardId)).toEqual([]);
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: date })).toMatchObject({ ok: true });
    const actions = await listHabitActions(h.db, boardId, date);
    expect(actions.filter((action) => action.kind === 'baseline')).toHaveLength(2);
    expect(actions.filter((action) => action.kind === 'baseline').every((action) => action.policyJson === null)).toBe(true);
    expect(await ledger(boardId)).toEqual([]);
    await check(boardId);
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
  });

  it('uses the original captured close and cap slot after earnings, shift and zone settings change', async () => {
    const boardId = await board('daily', { earnsCoins: true, cap: 1 });
    const first = await check(boardId);
    const earned = await ledger(boardId);
    expect(earned).toHaveLength(1);
    await h.db.runAsync('UPDATE boards SET earns_coins = 0, start_of_day_minute = 240 WHERE id = ?', [boardId]);
    h.clock.utcMs = closesAt + 1;
    h.clock.zone = 'America/New_York';
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId })).toMatchObject({ ok: true });
    expect(await ledger(boardId)).toEqual(earned);
    await h.db.runAsync('UPDATE boards SET earns_coins = 1 WHERE id = ?', [boardId]);
    await check(boardId);
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
  });

  it.each(['history', 'undo'] as const)('preserves %s removal during a partial sync with a tombstoned parent', async (method) => {
    const boardId = await board('count', { earnsCoins: true, cap: 1 });
    const created = await check(boardId);
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
    await h.db.runAsync('UPDATE boards SET deleted_at = ? WHERE id = ?', [now, boardId]);
    const commandId = h.ids.nextCommandId();
    const result = method === 'history'
      ? await removeCheckIn(h.deps, { commandId, checkInId: created.checkInId })
      : await undoCreatedCheckIn(h.deps, { commandId, checkInId: created.checkInId, createdByCommandId: created.commandId });
    expect(result).toMatchObject({ ok: true });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 1, balance: 0 });
    expect((await listHabitActions(h.db, boardId, date)).find((action) => action.commandId === commandId))
      .toMatchObject({ kind: 'uncheck', checkInId: created.checkInId, policyJson: null });
  });

  it.each(['check', 'remove', 'toggle'] as const)('replays an acknowledged %s without fresh policy, clock or id work', async (method) => {
    const boardId = await board('daily', { earnsCoins: true, cap: 1 });
    if (method === 'remove') await check(boardId);
    const commandId = h.ids.nextCommandId();
    const run = () => method === 'check' ? createCheckIn(h.deps, { commandId, boardId, logicalDate: date, source: 'app' })
      : method === 'remove' ? removeLatestCheckIn(h.deps, { commandId, boardId, logicalDate: date })
        : toggleDailyCheckIn(h.deps, { commandId, boardId, logicalDate: date });
    const first = await run();
    expect(first).toMatchObject({ ok: true });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: method === 'remove' ? 1 : 0, balance: method === 'remove' ? 0 : 1 });
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    const before = await snapshot(h.db);
    jest.spyOn(h.clock, 'nowUtcMs').mockImplementation(() => { throw new Error('receipt replay read clock'); });
    jest.spyOn(h.clock, 'timeZoneId').mockImplementation(() => { throw new Error('receipt replay read zone'); });
    jest.spyOn(h.ids, 'uuid').mockImplementation(() => { throw new Error('receipt replay allocated id'); });
    expect(await run()).toEqual(first);
    expect(await snapshot(h.db)).toEqual(before);
  });

  const failurePoints = [
    ['ledger', (sql: string) => sql.includes('INSERT INTO coin_ledger')],
    ['ledger outbox', (sql: string, params?: SqlParams) => sql.includes('INSERT INTO mutation_outbox') && params?.[0] === 'ledger_entry'],
    ['widget projection', (sql: string) => sql.includes('INSERT INTO widget_board_rows')],
    ['receipt', (sql: string) => sql.includes('INSERT INTO command_receipts')],
  ] as const;
  it.each(failurePoints)('rolls back creation at %s and retries the same command exactly once', async (_name, fails) => {
    const boardId = await board('daily', { earnsCoins: true, cap: 1 });
    const before = await snapshot(h.db);
    const input = { commandId: h.ids.nextCommandId(), boardId, logicalDate: date };
    expect(await toggleDailyCheckIn({ ...h.deps, db: failingAt(h.db, fails) }, input))
      .toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h.db)).toEqual(before);
    const retried = await toggleDailyCheckIn(h.deps, input);
    expect(retried).toMatchObject({ ok: true, value: { checked: true, created: true } });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
    const after = await snapshot(h.db);
    expect(await toggleDailyCheckIn(h.deps, input)).toEqual(retried);
    expect(await snapshot(h.db)).toEqual(after);
  });

  it('restores the awarded check, ledger, HLC and projection if a timely clear fails at receipt persistence', async () => {
    const boardId = await board('daily', { earnsCoins: true, cap: 1 });
    await check(boardId, 'preserve after rollback');
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 0, balance: 1 });
    const before = await snapshot(h.db);
    const input = { commandId: h.ids.nextCommandId(), boardId, logicalDate: date };
    expect(await toggleDailyCheckIn({ ...h.deps, db: failingAt(h.db, (sql) => sql.includes('INSERT INTO command_receipts')) }, input))
      .toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h.db)).toEqual(before);
    expect(await toggleDailyCheckIn(h.deps, input)).toMatchObject({ ok: true, value: { checked: false } });
    expect(await totals(boardId)).toEqual({ earned: 1, spent: 1, balance: 0 });
  });

  it.each(['create', 'history', 'latest', 'undo', 'toggle'] as const)('rejects invalid topology before any %s mutation or economic evidence', async (method) => {
    const boardId = await board(method === 'toggle' ? 'daily' : 'count', { earnsCoins: true, cap: 1 });
    const existing = method === 'create' ? null : await check(boardId);
    await h.db.runAsync("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = id WHERE id = ?", [boardId]);
    const before = await snapshot(h.db, false);
    const commandId = h.ids.nextCommandId();
    const result = method === 'create' ? await createCheckIn(h.deps, { commandId, boardId, source: 'app' })
      : method === 'history' ? await removeCheckIn(h.deps, { commandId, checkInId: existing!.checkInId })
        : method === 'undo' ? await undoCreatedCheckIn(h.deps, { commandId, checkInId: existing!.checkInId, createdByCommandId: existing!.commandId })
          : method === 'latest' ? await removeLatestCheckIn(h.deps, { commandId, boardId, logicalDate: date })
            : await toggleDailyCheckIn(h.deps, { commandId, boardId, logicalDate: date });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h.db, false)).toEqual(before);
  });

  it('returns capacity without committing a check when its valid stack policy exceeds the record limit', async () => {
    const boardId = await board('count', { earnsCoins: true, cap: 1 });
    const ids = JSON.stringify(Array.from({ length: 5100 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    const current = await getBoardById(h.db, boardId);
    if (!current) throw new Error('missing root');
    await h.db.runAsync(`INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background, tracks_amount,
      quick_amount, tracks_time, start_of_day_minute, metrics_enabled, order_key, created_at, updated_at,
      mutation_stamp, anchor_kind, anchor_relation, anchor_board_id)
      SELECT value, 'Required child', 'star.fill', '#70A7FF', 0, 0, 1, 0, 0, 1, value, ?, ?, ?, 'board', 'after', ?
      FROM json_each(?)`, [now, now, current.mutationStamp, boardId, ids]);
    await h.db.runAsync(`INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp, deleted_at)
      SELECT value, ?, NULL, ?, NULL FROM json_each(?)`, [date, current.mutationStamp, ids]);
    const before = await snapshot(h.db, false);
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app' }))
      .toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
    expect(await snapshot(h.db, false)).toEqual(before);
  });
});

describe('shared public writer receipts and coin evidence', () => {
  it.each(writerFixture.scenarios)('$name', async (scenario) => {
    const h = await createTestHarness();
    const seed = writerFixture.seed;
    h.clock.utcMs = seed.nowUtcMs;
    h.clock.zone = seed.timeZoneId;
    try {
      await h.db.runAsync('UPDATE app_settings SET device_id = ?, hlc_wall_time = 0, hlc_counter = 0', [seed.deviceId]);
      for (const row of seed.boards) {
        const id = row.id as BoardId;
        const mutationStamp = `00000000000000-00000-${seed.deviceId}`;
        await insertBoard(h.db, { ...fields, ...row, id, kind: scenario.kind as BoardKind,
          anchorKind: null, anchorRelation: null, anchorBoardId: null, anchorPreset: null, anchorText: null,
          usualTimeMinute: null, requiredInStack: true, orderKey: row.id,
          archivedAt: row.archived ? seed.nowUtcMs : null, deletedAt: null,
          createdAt: seed.nowUtcMs, updatedAt: seed.nowUtcMs, mutationStamp });
        await insertPeriod(h.db, id, date, mutationStamp);
      }
      for (const step of scenario.steps) {
        let allocated = 0;
        const deps = { ...h.deps, ids: { uuid: () => {
          const id = step.generatedIds[allocated++];
          if (id === undefined) throw new Error('writer fixture generated id queue exhausted');
          return id;
        } } };
        const input = { commandId: step.commandId as CommandId, boardId: step.input.boardId as BoardId };
        const run = () => step.intent === 'checkIn'
          ? runCheckInIntent(deps, { ...input, source: 'shortcut' })
          : runRemoveLatestIntent(deps, input);
        expect(await run()).toEqual(step.expectedReceipt);
        expect(allocated).toBe(step.generatedIds.length);
        const stored = await h.db.getFirstAsync<{ outcome: string }>('SELECT outcome FROM command_receipts WHERE command_id = ?', [step.commandId]);
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!.outcome)).toEqual(step.expectedReceipt);
        expect(await listHabitActions(h.db, input.boardId, date)).toEqual(step.expectedActions);
        expect(await listLedgerEntriesForScope(h.db, `check:${input.boardId}:${date}`)).toEqual(step.expectedLedger);
        expect((await h.db.getAllAsync<{ id: string }>('SELECT id FROM check_ins WHERE deleted_at IS NULL ORDER BY id')).map((row) => row.id))
          .toEqual(step.expectedLiveCheckIds);
        expect(await h.db.getFirstAsync('SELECT hlc_counter FROM app_settings')).toEqual({ hlc_counter: step.expectedHlcCounter });
        const beforeReplay = await snapshot(h.db);
        expect(await run()).toEqual(step.expectedReceipt);
        expect(allocated).toBe(step.generatedIds.length);
        expect(await snapshot(h.db)).toEqual(beforeReplay);
      }
    } finally { await h.db.closeAsync(); }
  });
});
