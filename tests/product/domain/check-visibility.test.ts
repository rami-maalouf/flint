import * as checkReads from '@/core/persistence/repositories/check-ins';
import { readStackEvidence } from '@/core/persistence/repositories/stack-evidence';
import { getExportSnapshot } from '@/core/export/serialize';
import { settleAffectedCoinScopes } from '@/core/domain/coin-settlement';
import { createBoard, createCheckIn, deleteBoard, removeLatestCheckIn, updateBoard, updateCheckIn } from '@/core/domain/commands';
import type { CheckIn } from '@/core/domain/entities';
import { foldActiveCheckInIds, baselineAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { establishLegacyCheckEvidence } from '@/core/domain/legacy-check-evidence';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById, insertCheckIn, listBoardCheckIns, updateCheckInRow } from '@/core/persistence/repositories/check-ins';
import { refreshCheckVisibility } from '@/core/persistence/repositories/check-visibility';
import { appendHabitAction, listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const today = '2026-08-30' as LogicalDate;
const prior = '2026-08-29' as LogicalDate;
const input = { title: 'visible evidence', symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false,
  tracksAmount: false, tracksTime: false, amountUnit: null, quickAmount: 1, startOfDayMinute: 0, metricsEnabled: true };
async function board(h: TestHarness, kind: 'daily' | 'count' = 'daily') {
  const result = await createBoard(h.deps, { ...input, kind, earnsCoins: true, coinCapPerDay: 10, commandId: h.ids.nextCommandId() });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}
async function payload(h: TestHarness, boardId: BoardId, logicalDate = today): Promise<CheckIn> {
  const value: CheckIn = { id: h.ids.uuid() as CheckInId, boardId, logicalDate, occurredAtUtc: null,
    timeZoneId: null, offsetMinutes: null, amount: null, note: 'pending private note', source: 'sync',
    idempotencyKey: h.ids.nextCommandId(), createdAt: h.clock.utcMs, updatedAt: h.clock.utcMs,
    mutationStamp: '01788105600000-00000-remote', deletedAt: null };
  await insertCheckIn(h.db, value); return value;
}

describe('accepted token visibility', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it('keeps an action-less payload hidden through public daily check and policy edit without inventing a baseline', async () => {
    const id = await board(h); const raw = await payload(h, id);
    expect(await getCheckInById(h.db, raw.id)).toBeNull();
    const checked = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' });
    expect(checked).toMatchObject({ ok: true, value: { created: true } });
    const current = (await getBoardById(h.db, id))!;
    expect(await updateBoard(h.deps, { ...input, boardId: id, commandId: h.ids.nextCommandId(),
      expectedMutationStamp: current.mutationStamp, kind: 'count', earnsCoins: true, coinCapPerDay: 8 })).toMatchObject({ ok: true });
    expect(await getCheckInById(h.db, raw.id)).toBeNull();
    expect((await listHabitActions(h.db, id, today)).filter(a => a.kind === 'baseline')).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 1 });
  });

  it('does not steal a later genuine source token by baselining raw payloads during count checks', async () => {
    const id = await board(h, 'count'); const raw = await payload(h, id);
    await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' });
    expect((await listHabitActions(h.db, id, today)).some(a => a.checkInId === raw.id)).toBe(false);
  });

  it('keeps cleared payloads hidden after a higher-stamp raw note update', async () => {
    const id = await board(h); const created = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' });
    if (!created.ok) throw new Error(created.error.message);
    const check = (await getCheckInById(h.db, created.value.checkInId))!;
    await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id });
    await updateCheckInRow(h.db, { ...check, note: 'remote resurrection attempt', mutationStamp: '99999999999999-00000-remote' });
    await refreshCheckVisibility(h.db, [check]);
    expect(await getCheckInById(h.db, check.id)).toBeNull();
    expect(await listBoardCheckIns(h.db, id)).toEqual([]);
  });

  it('retains every surviving token while intersecting the winning raw date', async () => {
    const id = await board(h); const a = await payload(h, id); const b = await payload(h, id);
    const aa = await baselineAction(a, h.deps.hashing); const bb = await baselineAction(b, h.deps.hashing);
    await appendHabitAction(h.db, aa); await appendHabitAction(h.db, bb);
    expect(foldActiveCheckInIds(Object.freeze([bb, aa]))).toEqual([aa, bb].sort((x,y) => x.id < y.id ? -1 : 1).map(x => x.checkInId));
    await refreshCheckVisibility(h.db, [a, b]);
    expect((await listBoardCheckIns(h.db, id)).map(x => x.id).sort()).toEqual([a.id,b.id].sort());
    await updateCheckInRow(h.db, { ...a, logicalDate: prior });
    await refreshCheckVisibility(h.db, [a, { ...a, logicalDate: prior }]);
    expect(await getCheckInById(h.db, a.id)).toBeNull();
    expect(await getCheckInById(h.db, b.id)).not.toBeNull();
  });

  it('explicit legacy admission queues canonical zero-time evidence once without policy or fresh earnings', async () => {
    const id = await board(h); const raw = await payload(h, id);
    const context = { tx: h.db, now: 123, hashing: h.deps.hashing };
    const first = await establishLegacyCheckEvidence(context, [raw, raw]);
    expect(first.actions).toEqual([await baselineAction(raw, h.deps.hashing)]);
    expect(first.checkScopes).toEqual([{ boardId: id, logicalDate: today }]);
    expect(await establishLegacyCheckEvidence({ ...context, now: 456 }, [raw])).toEqual({ actions: [], checkScopes: [{ boardId: id, logicalDate: today }] });
    await refreshCheckVisibility(h.db, first.checkScopes);
    expect(await getCheckInById(h.db, raw.id)).toEqual(raw);
    expect(await h.db.getAllAsync("SELECT created_at FROM mutation_outbox WHERE entity_type = 'habit_action'")).toEqual([{ created_at: 123 }]);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('public date moves derive both dates and raw board deletion still tombstones suppressed children', async () => {
    const id = await board(h, 'count'); const pending = await payload(h, id);
    const created = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' });
    if (!created.ok) throw new Error(created.error.message);
    const check = (await getCheckInById(h.db, created.value.checkInId))!;
    expect(await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: check.id,
      expectedMutationStamp: check.mutationStamp, logicalDate: prior })).toMatchObject({ ok: true });
    expect(await getCheckInById(h.db, check.id)).toMatchObject({ logicalDate: prior });
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id })).toMatchObject({ ok: true });
    expect(await h.db.getFirstAsync('SELECT deleted_at FROM check_ins WHERE id = ?', [pending.id])).toEqual({ deleted_at: h.clock.utcMs });
    expect((await listHabitActions(h.db, id, today)).some(a => a.kind === 'baseline')).toBe(false);
  });
  it('uses indexed bulk visibility updates without per-row correlated token scans', async () => {
    const id = await board(h, 'count');
    const checks: CheckIn[] = [];
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (let n = 0; n < 400; n++) checks.push(await payload(h, id));
      await establishLegacyCheckEvidence({ tx, now: 1, hashing: h.deps.hashing }, checks);
    });
    const writes = jest.spyOn(h.db, 'runAsync');
    await refreshCheckVisibility(h.db, checks);
    const updates = writes.mock.calls.filter(([sql]) => sql.startsWith('UPDATE check_ins'));
    expect(updates.length).toBeLessThanOrEqual(2);
    for (const [sql, params] of updates) {
      const plan = await h.db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      expect(plan.some(row => row.detail.includes('CORRELATED'))).toBe(false);
      expect(plan.some(row => row.detail.includes('SEARCH'))).toBe(true);
    }
    expect(await listBoardCheckIns(h.db, id)).toHaveLength(400);
    writes.mockRestore();
  });

  it('hides pending payloads from every history and aggregate surface while retaining raw identity guards', async () => {
    const id = await board(h); const raw = await payload(h, id, prior); await payload(h, id);
    const made = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app', note: 'accepted note' });
    if (!made.ok) throw new Error(made.error.message);
    const visible = (await getCheckInById(h.db, made.value.checkInId))!;
    expect(await checkReads.listBoardCheckIns(h.db, id, 10)).toEqual([visible]);
    expect(await checkReads.listBoardCheckInsForDate(h.db, id, prior)).toEqual([]);
    expect(await checkReads.listBoardJournal(h.db, id)).toEqual([visible]);
    expect(await checkReads.earliestCheckInDate(h.db, id)).toBe(today);
    expect(await checkReads.monthlyCheckInTotals(h.db, id)).toEqual(new Map([['2026-08', 1]]));
    expect(await checkReads.dailyCounts(h.db, id, prior, today)).toEqual(new Map([[today, 1]]));
    expect(await checkReads.allDailyCounts(h.db, id)).toEqual(new Map([[today, 1]]));
    expect((await checkReads.dailyCountsForBoards(h.db, prior, today)).get(id)).toEqual(new Map([[today, 1]]));
    expect((await checkReads.eligibleDailyCompletionsForActiveBoards(h.db, today)).get(id)).toEqual(new Set([today]));
    expect(await checkReads.latestCheckInForDate(h.db, id, prior)).toBeNull();
    expect(await checkReads.countBoardCheckIns(h.db, id)).toBe(1);
    expect(await checkReads.countBoardNotes(h.db, id)).toBe(1);
    expect((await readStackEvidence(h.db, [id])).countsByBoard.get(id)).toEqual(new Map([[today, 1]]));
    const exported = await getExportSnapshot(h.deps, { databaseSchemaVersion: 11, appVersion: 'test', buildVersion: 'test', locale: 'en-US' });
    expect(exported).toMatchObject({ ok: true, value: { checkIns: [{ id: visible.id }] } });
    expect(exported.ok && exported.value.checkIns).toHaveLength(1);
    expect(await checkReads.checkInIdExists(h.db, raw.id)).toBe(true);
    expect(await checkReads.getCheckInByIdempotencyKey(h.db, raw.idempotencyKey)).toEqual(raw);
    expect(await checkReads.listRawBoardCheckIns(h.db, id)).toHaveLength(3);
  });

  it('leaves a payload awaiting its genuine action eligible for the original source earning', async () => {
    const id = await board(h, 'count'); const raw = await payload(h, id);
    await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' });
    const source = (await listHabitActions(h.db, id, today)).find(a => a.kind === 'check')!;
    const genuine = { ...source, id: h.ids.uuid() as typeof source.id, checkInId: raw.id,
      commandId: raw.idempotencyKey, mutationStamp: '01788192000000-00000-remote' };
    await h.db.withExclusiveTransactionAsync(async tx => {
      await appendHabitAction(tx, genuine);
      await settleAffectedCoinScopes(h.deps, { tx, now: h.clock.utcMs }, { checkScopes: [raw] });
      await refreshCheckVisibility(tx, [raw]);
    });
    expect(await getCheckInById(h.db, raw.id)).toEqual(raw);
    expect(await h.db.getFirstAsync('SELECT delta FROM coin_ledger WHERE source_action_id = ?', [genuine.id])).toEqual({ delta: 1 });
    expect((await listHabitActions(h.db, id, today)).some(a => a.kind === 'baseline')).toBe(false);
  });

  it('does not read or write when either explicit boundary receives no scopes', async () => {
    const reads = jest.spyOn(h.db, 'getAllAsync'); const writes = jest.spyOn(h.db, 'runAsync');
    expect(await establishLegacyCheckEvidence({ tx: h.db, now: 1, hashing: h.deps.hashing }, [])).toEqual({ actions: [], checkScopes: [] });
    await refreshCheckVisibility(h.db, []);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it('rolls back local earning and all source effects if visibility derivation fails, then safely retries', async () => {
    const id = await board(h); const commandId = h.ids.nextCommandId();
    const tables = ['check_ins', 'habit_actions', 'coin_ledger', 'mutation_outbox', 'command_receipts', 'app_settings', 'widget_board_rows'];
    const snapshot = () => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));
    const before = await snapshot(); const run = h.db.runAsync.bind(h.db);
    const fail = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE check_ins SET state_suppressed')) throw new Error('visibility failure');
      return run(sql, params);
    });
    expect(await createCheckIn(h.deps, { commandId, boardId: id, source: 'app' })).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot()).toEqual(before); fail.mockRestore();
    expect(await createCheckIn(h.deps, { commandId, boardId: id, source: 'app' })).toMatchObject({ ok: true, value: { created: true } });
    expect(await listBoardCheckIns(h.db, id)).toHaveLength(1);
    expect(await h.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 1 });
  });

});
