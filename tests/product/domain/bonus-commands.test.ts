import { admitLegacyChecks } from '../helpers/legacy-checks';
import { archiveBoard, createBoard, createCheckIn, deleteBoard, removeCheckIn, removeLatestCheckIn,
  restoreBoard, toggleDailyCheckIn, undoCreatedCheckIn, updateBoard, updateCheckIn,
  type CreateBoardInput } from '@/core/domain/commands';
import { coinLedgerTotals } from '@/core/domain/coin-ledger';
import { settleAffectedCoinScopes } from '@/core/domain/coin-settlement';
import { baselineAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById, insertCheckIn } from '@/core/persistence/repositories/check-ins';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const date = '2026-08-30' as LogicalDate;
const previous = '2026-08-29' as LogicalDate;
const close = Date.UTC(2026, 7, 31, 4);
const fields = { title: 'bonus habit', symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false,
  tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true };
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger',
  'mutation_outbox', 'app_settings', 'command_receipts', 'widget_board_rows'];
const snapshot = (h: TestHarness) => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));

describe('same-day bonus command integration', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  async function board(extra: Partial<CreateBoardInput> = {}) {
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), kind: 'daily', ...extra });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }
  async function stack(extra: Partial<CreateBoardInput> = {}) {
    const root = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' }, ...extra });
    const member = await board({ anchor: { kind: 'board', relation: 'after', boardId: root }, ...extra });
    return { root, member };
  }
  async function check(boardId: BoardId, logicalDate = date) {
    const commandId = h.ids.nextCommandId();
    const result = await createCheckIn(h.deps, { commandId, boardId, logicalDate, source: 'app', note: 'kept note' });
    if (!result.ok) throw new Error(result.error.message);
    return { ...result.value, commandId };
  }
  async function update(boardId: BoardId, extra: Partial<CreateBoardInput>) {
    const current = (await getBoardById(h.db, boardId))!;
    return updateBoard(h.deps, { ...fields, startOfDayMinute: current.startOfDayMinute,
      commandId: h.ids.nextCommandId(), boardId, expectedMutationStamp: current.mutationStamp, ...extra });
  }
  const bonus = (root: BoardId, logicalDate = date) => listLedgerEntriesForScope(h.db, `bonus:${root}:${logicalDate}`);

  it.each(['daily', 'count'] as const)('earns, reverses and restores one %s stack bonus through normal writers', async kind => {
    const { root, member } = await stack({ kind, earnsCoins: true, coinCapPerDay: 4 });
    await check(root);
    expect(await bonus(root)).toEqual([]);
    const last = await check(member);
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ kind: 'run_bonus', delta: 1, runKey: `${root}|${date}` });
    const beforeReplay = await snapshot(h);
    expect(await createCheckIn(h.deps, { commandId: last.commandId, boardId: member, source: 'app' })).toMatchObject({ ok: true, value: { checkInId: last.checkInId } });
    expect(await snapshot(h)).toEqual(beforeReplay);
    expect(await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: member, logicalDate: date })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1, -1]);
    await check(member);
    const restored = await bonus(root);
    expect(restored[0]).toEqual(original[0]);
    expect(restored.map(row => row.delta)).toEqual([1, -1, 1]);
    expect(coinLedgerTotals(restored).balance).toBe(1);
  });

  it('keeps a bonus while another Count token survives and reverses on the last precise Undo', async () => {
    const { root, member } = await stack({ kind: 'count' });
    await check(root);
    const first = await check(member);
    const second = await check(member);
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    expect(await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId,
      createdByCommandId: first.commandId })).toMatchObject({ ok: true });
    expect(await bonus(root)).toEqual(original);
    expect(await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: second.checkInId,
      createdByCommandId: second.commandId })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1, -1]);
  });

  it('keeps private check fields out of economic scope query parameters', async () => {
    const { root, member } = await stack();
    await check(root);
    const reads = jest.spyOn(h.db, 'getAllAsync');
    await check(member);
    const scoped = reads.mock.calls.filter(([sql]) => sql.includes('json_each'));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.flatMap(([, params]) => params ?? []).some(value =>
      typeof value === 'string' && (value.includes('kept note') || value.includes('occurredAtUtc') || value.includes('"amount"')))).toBe(false);
    expect(await bonus(root)).toHaveLength(1);
  });

  it('never combines checks on consecutive stored dates', async () => {
    h.clock.advanceDays(-1);
    const { root, member } = await stack();
    await check(root, previous);
    h.clock.advanceDays(1);
    await check(member);
    expect(await bonus(root, previous)).toEqual([]);
    expect(await bonus(root)).toEqual([]);
    await check(root);
    expect((await bonus(root)).map(row => row.delta)).toEqual([1]);
    expect(await bonus(root, previous)).toEqual([]);
  });

  it('uses an explicitly admitted required legacy member without inventing its individual earning', async () => {
    const { root, member } = await stack({ earnsCoins: true });
    const legacy = { id: h.ids.uuid() as CheckInId, boardId: root, logicalDate: date,
      occurredAtUtc: null, timeZoneId: null, offsetMinutes: null, amount: null, note: 'legacy preserved',
      source: 'app' as const, idempotencyKey: h.ids.nextCommandId(), createdAt: h.clock.utcMs,
      updatedAt: h.clock.utcMs, mutationStamp: '00000000000100-00000-legacy', deletedAt: null };
    await insertCheckIn(h.db, legacy);
    await admitLegacyChecks(h, [legacy]);
    await check(member);
    expect((await bonus(root)).map(row => row.delta)).toEqual([1]);
    const expected = await baselineAction(legacy, h.deps.hashing);
    expect(await listHabitActions(h.db, root, date)).toContainEqual(expected);
    expect(await listLedgerEntriesForScope(h.db, `check:${root}:${date}`)).toEqual([]);
    expect(await getCheckInById(h.db, legacy.id)).toEqual(legacy);
    expect(await h.db.getAllAsync("SELECT entity_id FROM mutation_outbox WHERE entity_type = 'habit_action' AND entity_id = ?", [expected.id]))
      .toEqual([{ entity_id: expected.id }]);
  });

  it('discovers a former stack when all of the detached member observations are rootless', async () => {
    const root = await board({ requiredInStack: false, anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const member = await board({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    const detached = await board();
    const old = await check(detached);
    expect(await update(detached, { anchor: { kind: 'board', relation: 'after', boardId: root } })).toMatchObject({ ok: true });
    await check(member);
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    expect(await update(detached, { anchor: null })).toMatchObject({ ok: true });
    expect(await bonus(root)).toEqual(original);
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: old.checkInId })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1, -1]);
    expect((await listHabitActions(h.db, detached, date)).every(action => JSON.parse(action.policyJson!).rootId === null)).toBe(true);
  });

  it('archive and restore change future requirements without minting or replacing a held bonus', async () => {
    const { root, member } = await stack();
    await check(root);
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: member })).toMatchObject({ ok: true });
    expect(await bonus(root)).toEqual([]);
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true, value: { checked: false } });
    await check(root);
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: member })).toMatchObject({ ok: true });
    const extra = await check(member);
    expect(await bonus(root)).toEqual(original);
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: extra.checkInId })).toMatchObject({ ok: true });
    expect(await bonus(root)).toEqual(original);
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1, -1]);
  });

  it('uses the root control close after a timezone change while preserving the member check close', async () => {
    const root = await board({ startOfDayMinute: 240, anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const member = await board({ earnsCoins: true, anchor: { kind: 'board', relation: 'after', boardId: root } });
    await check(root);
    h.clock.zone = 'Asia/Dubai';
    const last = await check(member);
    const individual = await listLedgerEntriesForScope(h.db, `check:${member}:${date}`);
    expect(await bonus(root)).toHaveLength(1);
    h.clock.utcMs = Date.UTC(2026, 7, 31, 6);
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: last.checkInId })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1, -1]);
    expect(await listLedgerEntriesForScope(h.db, `check:${member}:${date}`)).toEqual(individual);
  });

  it.each([close - 1, close, close + 1])('moves preserve exact notes and use the bonus close at %i', async at => {
    const { root, member } = await stack();
    await check(root);
    const last = await check(member);
    const row = (await getCheckInById(h.db, last.checkInId))!;
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    h.clock.utcMs = at;
    expect(await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: row.id,
      expectedMutationStamp: row.mutationStamp, logicalDate: previous, note: row.note! })).toMatchObject({ ok: true });
    expect((await bonus(root)).map(item => item.delta)).toEqual(at < close ? [1, -1] : [1]);
    expect(await bonus(root, previous)).toEqual([]);
    expect(await getCheckInById(h.db, row.id)).toMatchObject({ logicalDate: previous, note: 'kept note' });
  });

  it('deleting the structural root reverses once before retiring its scope', async () => {
    const { root, member } = await stack();
    await check(root);
    await check(member);
    const original = await bonus(root);
    expect(original).toHaveLength(1);
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    const rows = await bonus(root);
    expect(rows[0]).toEqual(original[0]);
    expect(rows.map(row => row.delta)).toEqual([1, -1]);
    expect(await getBoardById(h.db, root)).toBeNull();
  });

  it.each(['bonus', 'outbox', 'receipt'])('rolls back all command effects on %s failure and retries once', async point => {
    const { root, member } = await stack();
    await check(root);
    const commandId = h.ids.nextCommandId();
    const input = { commandId, boardId: member, source: 'app' as const, note: 'atomic completion' };
    const before = await snapshot(h);
    const run = h.db.runAsync.bind(h.db);
    const failure = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const isBonus = sql.includes('INSERT INTO coin_ledger') && params?.[1] === 'run_bonus';
      const isOutbox = sql.includes('INSERT INTO mutation_outbox') && params?.[0] === 'ledger_entry';
      const isReceipt = sql.includes('INSERT INTO command_receipts');
      if ((point === 'bonus' && isBonus) || (point === 'outbox' && isOutbox) || (point === 'receipt' && isReceipt)) throw new Error('economic write failed');
      return run(sql, params);
    });
    expect(await createCheckIn(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
    failure.mockRestore();
    expect(await createCheckIn(h.deps, input)).toMatchObject({ ok: true });
    expect((await bonus(root)).map(row => row.delta)).toEqual([1]);
    const saved = await snapshot(h);
    expect(await createCheckIn(h.deps, input)).toMatchObject({ ok: true });
    expect(await snapshot(h)).toEqual(saved);
  });

  it('settles an explicit closed root scope repeatedly without needing current check scopes', async () => {
    const { root, member } = await stack();
    await check(root);
    await check(member);
    expect(await bonus(root)).toHaveLength(1);
    h.clock.utcMs = close + 1;
    const before = await snapshot(h);
    for (let retry = 0; retry < 2; retry += 1) {
      await h.db.withExclusiveTransactionAsync(tx => settleAffectedCoinScopes(h.deps, { tx, now: h.clock.utcMs },
        { checkScopes: [], rootScopes: [{ rootId: root, logicalDate: date }] }));
    }
    expect(await snapshot(h)).toEqual(before);
  });

  it('deduplicates empty incoming check scopes without inventing state or coins', async () => {
    const id = await board();
    const scope = { boardId: id, logicalDate: date };
    const before = await snapshot(h);
    await h.db.withExclusiveTransactionAsync(tx => settleAffectedCoinScopes(h.deps, { tx, now: h.clock.utcMs },
      { checkScopes: [scope, scope] }));
    expect(await snapshot(h)).toEqual(before);
  });

  it('retains one explicitly admitted legacy token shared by historical root policies only once', async () => {
    const first = await board({ requiredInStack: false, anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const second = await board({ requiredInStack: false, anchor: { kind: 'preset', relation: 'after', preset: 'sleep' } });
    const member = await board({ anchor: { kind: 'board', relation: 'after', boardId: first } });
    expect(await update(member, { anchor: { kind: 'board', relation: 'after', boardId: second } })).toMatchObject({ ok: true });
    const legacy = { id: h.ids.uuid() as CheckInId, boardId: member, logicalDate: date,
      occurredAtUtc: null, timeZoneId: null, offsetMinutes: null, amount: null, note: 'restored survivor',
      source: 'app' as const, idempotencyKey: h.ids.nextCommandId(), createdAt: h.clock.utcMs,
      updatedAt: h.clock.utcMs, mutationStamp: '00000000000100-00000-legacy', deletedAt: null };
    await insertCheckIn(h.db, legacy);
    await admitLegacyChecks(h, [legacy]);
    await h.db.withExclusiveTransactionAsync(tx => settleAffectedCoinScopes(h.deps, { tx, now: h.clock.utcMs },
      { checkScopes: [{ boardId: member, logicalDate: date }] }));
    const expected = await baselineAction(legacy, h.deps.hashing);
    expect(await listHabitActions(h.db, member, date)).toEqual([expected]);
    expect(await h.db.getAllAsync("SELECT entity_id FROM mutation_outbox WHERE entity_type = 'habit_action' AND entity_id = ?", [expected.id]))
      .toEqual([{ entity_id: expected.id }]);
    expect(await bonus(first)).toEqual([]);
    expect(await bonus(second)).toEqual([]);
  });
});
