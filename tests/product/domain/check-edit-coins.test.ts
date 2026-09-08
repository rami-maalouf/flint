import { createBoard, createCheckIn, deleteBoard, importSnapshot, importSnapshotInTransaction, runCommand, updateCheckIn, type CreateBoardInput } from '@/core/domain/commands';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { parseCoinPolicy } from '@/core/domain/coin-policy';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById } from '@/core/persistence/repositories/check-ins';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';
import { referenceAugust2026Draft, seedReferenceAugust2026 } from '@/testing/fixtures/reference-august-2026';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const today = '2026-08-30' as LogicalDate;
const yesterday = '2026-08-29' as LogicalDate;
const close = Date.UTC(2026, 7, 31, 4);
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger', 'mutation_outbox', 'app_settings', 'command_receipts', 'widget_board_rows'];
const snapshot = (h: TestHarness) => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));

describe('coin consequences of history edits, deletion and restore', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  async function board(extra: Partial<CreateBoardInput> = {}): Promise<BoardId> {
    const result = await createBoard(h.deps, {
      commandId: h.ids.nextCommandId(), title: 'history', symbol: 'star.fill', accentHex: '#78D98B',
      usesTintedBackground: false, kind: 'count', tracksAmount: true, amountUnit: 'pages', quickAmount: 3,
      tracksTime: true, startOfDayMinute: 0, metricsEnabled: true, ...extra,
    });
    if (!result.ok) throw new Error(result.error.message);
    await h.db.runAsync('UPDATE boards SET earns_coins = 1, coin_cap_per_day = 10 WHERE id = ?', [result.value.boardId]);
    return result.value.boardId;
  }

  async function check(boardId: BoardId, logicalDate = today) {
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate, note: 'kept history', source: 'app' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.checkInId;
  }

  async function edit(checkInId: CheckInId, logicalDate: LogicalDate) {
    const row = (await getCheckInById(h.db, checkInId))!;
    return updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId, expectedMutationStamp: row.mutationStamp, logicalDate, note: 'edited history' });
  }

  const ledger = (boardId: BoardId, date = today): Promise<CoinLedgerRow[]> =>
    listLedgerEntriesForScope(h.db, `check:${boardId}:${date}`);

  it.each([close - 1, close, close + 1])('moving an earned check at %i settles its original close and never earns at the destination', async at => {
    const boardId = await board();
    const id = await check(boardId);
    const earned = await ledger(boardId);
    expect(earned).toHaveLength(1);
    h.clock.utcMs = at;
    expect(await edit(id, yesterday)).toEqual({ ok: true, value: { mutationStamp: expect.any(String) } });
    expect(await getCheckInById(h.db, id)).toMatchObject({ logicalDate: yesterday, note: 'edited history', amount: 3 });
    const sourceRows = await ledger(boardId);
    expect(sourceRows[0]).toEqual(earned[0]);
    expect(sourceRows.map(row => row.delta)).toEqual(at < close ? [1, -1] : [1]);
    expect(await ledger(boardId, yesterday)).toEqual([]);
    const source = await listHabitActions(h.db, boardId, today);
    const destination = await listHabitActions(h.db, boardId, yesterday);
    expect(source.map(action => action.kind)).toEqual(['check', 'move_out']);
    expect(destination.map(action => action.kind)).toEqual(['move_in']);
    for (const action of [...source, ...destination]) expect(parseCoinPolicy(action.policyJson!)).toMatchObject({ earnsCoins: true, coinCapPerDay: 10 });
    expect(destination[0].mutationStamp > source[1].mutationStamp).toBe(true);
    expect(await edit(id, today)).toMatchObject({ ok: true });
    expect(await ledger(boardId)).toEqual(sourceRows);
    expect(await ledger(boardId, yesterday)).toEqual([]);
  });

  it('keeps same-date note, amount and exact-time edits outside economic history', async () => {
    const boardId = await board();
    const id = await check(boardId);
    const row = (await getCheckInById(h.db, id))!;
    const actions = await listHabitActions(h.db, boardId, today);
    const before = await ledger(boardId);
    expect(await updateCheckIn(h.deps, {
      commandId: h.ids.nextCommandId(), checkInId: id, expectedMutationStamp: row.mutationStamp,
      logicalDate: today, occurredAtUtc: h.clock.utcMs - 86400000, amount: 7, note: 'new details',
    })).toMatchObject({ ok: true });
    expect(await getCheckInById(h.db, id)).toMatchObject({ logicalDate: today, amount: 7, note: 'new details', occurredAtUtc: h.clock.utcMs - 86400000 });
    expect(await listHabitActions(h.db, boardId, today)).toEqual(actions);
    expect(await ledger(boardId)).toEqual(before);
  });

  it('rejects a Daily destination conflict before adding action or economic history', async () => {
    const boardId = await board({ kind: 'daily' });
    h.clock.advanceDays(-1);
    await check(boardId, yesterday);
    h.clock.advanceDays(1);
    const id = await check(boardId);
    const before = await snapshot(h);
    expect(await edit(id, yesterday)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const after = await snapshot(h);
    expect(after.filter((_, index) => tables[index] !== 'command_receipts')).toEqual(before.filter((_, index) => tables[index] !== 'command_receipts'));
    expect(await ledger(boardId)).toHaveLength(1);
    expect(await ledger(boardId, yesterday)).toHaveLength(1);
  });

  it('deleting a board settles each stored date, retains closed awards and preserves historical references', async () => {
    const rootId = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const childId = await board({ anchor: { kind: 'board', relation: 'after', boardId: rootId } });
    h.clock.advanceDays(-1);
    const old = await check(rootId, yesterday);
    h.clock.advanceDays(1);
    const first = await check(rootId);
    const second = await check(rootId);
    const closedRows = await ledger(rootId, yesterday);
    const input = { commandId: h.ids.nextCommandId(), boardId: rootId };
    expect(await deleteBoard(h.deps, input)).toEqual({ ok: true, value: undefined });
    expect(await getBoardById(h.db, rootId)).toBeNull();
    expect(await getBoardById(h.db, childId)).toMatchObject({ anchorKind: null, anchorBoardId: null });
    for (const id of [old, first, second]) expect(await getCheckInById(h.db, id)).toBeNull();
    expect(await ledger(rootId, yesterday)).toEqual(closedRows);
    expect((await ledger(rootId)).map(row => row.delta).sort()).toEqual([-1, -1, 1, 1]);
    const actions = await listHabitActions(h.db, rootId, today);
    expect(actions.filter(action => action.kind === 'uncheck')).toHaveLength(2);
    for (const action of actions) expect(parseCoinPolicy(action.policyJson!)).toMatchObject({ rootId, requiredBoardIds: [rootId, childId].sort() });
    const after = await snapshot(h);
    expect(await deleteBoard(h.deps, input)).toEqual({ ok: true, value: undefined });
    expect(await snapshot(h)).toEqual(after);
  });

  it.each(['move', 'delete'])('rolls back the complete %s if its reversal cannot be stored, then retries once', async operation => {
    const boardId = await board();
    const id = await check(boardId);
    const row = (await getCheckInById(h.db, id))!;
    const commandId = h.ids.nextCommandId();
    const write = () => operation === 'move'
      ? updateCheckIn(h.deps, { commandId, checkInId: id, expectedMutationStamp: row.mutationStamp, logicalDate: yesterday })
      : deleteBoard(h.deps, { commandId, boardId });
    const before = await snapshot(h);
    const run = h.db.runAsync.bind(h.db);
    const failure = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => sql.includes('INSERT INTO coin_ledger')
      ? Promise.reject(new Error('reversal storage failed')) : run(sql, params));
    expect(await write()).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
    failure.mockRestore();
    expect(await write()).toMatchObject({ ok: true });
    expect((await ledger(boardId)).map(item => item.delta)).toEqual([1, -1]);
    const after = await snapshot(h);
    expect(await write()).toMatchObject({ ok: true });
    expect(await snapshot(h)).toEqual(after);
  });

  it.each(['move', 'delete'])('rejects invalid topology before the %s changes source history', async operation => {
    const boardId = await board();
    const id = await check(boardId);
    await h.db.runAsync("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = id WHERE id = ?", [boardId]);
    const before = await snapshot(h);
    const result = operation === 'move' ? await edit(id, yesterday)
      : await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    const after = await snapshot(h);
    expect(after.filter((_, index) => tables[index] !== 'command_receipts')).toEqual(before.filter((_, index) => tables[index] !== 'command_receipts'));
  });

  it('restores legacy checks as null-policy baselines even into an existing opted-in board', async () => {
    const boardId = await board();
    const source = referenceAugust2026Draft.boards[0];
    const draft = { ...referenceAugust2026Draft,
      boards: [{ ...source, sourceId: boardId }],
      checkIns: referenceAugust2026Draft.checkIns.filter(row => row.sourceBoardId === source.sourceId).map(row => ({ ...row, sourceBoardId: boardId })),
      reminders: [],
    };
    const input = { commandId: h.ids.nextCommandId(), draft };
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { boardsCreated: 0, checkInsCreated: 12 } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    const actions = await h.db.getAllAsync<{ kind: string; policy_json: string | null }>('SELECT kind, policy_json FROM habit_actions');
    expect(actions).toHaveLength(12);
    expect(actions.every(action => action.kind === 'baseline' && action.policy_json === null)).toBe(true);
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('the direct development seed follows the same explicit non-earning import path', async () => {
    expect(await seedReferenceAugust2026(h.deps, h.ids.nextCommandId())).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    const actions = await h.db.getAllAsync<{ kind: string; policy_json: string | null }>('SELECT kind, policy_json FROM habit_actions');
    expect(actions.length).toBeGreaterThan(70);
    expect(actions.every(action => action.kind === 'baseline' && action.policy_json === null)).toBe(true);
  });

  it.each([undefined, 'earn'])('rejects transactional import without history-preserving mode: %s', async mode => {
    const before = await snapshot(h);
    const result = await runCommand(h.deps, h.ids.nextCommandId(), context =>
      importSnapshotInTransaction(h.deps, context, referenceAugust2026Draft, mode as never));
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    const after = await snapshot(h);
    expect(after.filter((_, index) => tables[index] !== 'command_receipts')).toEqual(before.filter((_, index) => tables[index] !== 'command_receipts'));
  });
});
