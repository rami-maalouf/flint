import { archiveBoard, createCheckIn, removeCheckIn, restoreBoard, updateCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoardHeatmap, getBoardSummary, getCheckIn, getConsistencyAnalytics, getHomeBoardProjection, getStreakAnalytics, getWeekdayAnalytics } from '@/core/domain/queries';

import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const d = (date: string) => date as LogicalDate;

describe('habit activation from first effective completion', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  async function check(boardId: BoardId, date: string) {
    const result = await createCheckIn(h.deps, {
      commandId: h.ids.nextCommandId(), boardId, logicalDate: d(date), source: 'app',
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.checkInId;
  }

  it.each(['daily', 'count'])('starts %s metrics five days ago despite creation ten days ago', async (kind) => {
    const boardId = await createBoardForTest(h, { kind });
    h.clock.advanceDays(10);
    await check(boardId, '2026-09-04');
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: {
      eligibleDayCount: 6, metricsReady: false, consistencyPercent: expect.closeTo(100 / 6),
      currentStreak: 0, longestStreak: 1,
    } });
    expect(await getWeekdayAnalytics(h.deps, boardId)).toEqual({ ok: true, value: null });
    expect(await getConsistencyAnalytics(h.deps, boardId)).toEqual({ ok: true, value: null });
    const heatmap = await getBoardHeatmap(h.deps, boardId, { days: 14 });
    if (!heatmap.ok || !heatmap.value) throw new Error('missing heatmap');
    const cells = heatmap.value.weeks.flatMap((week) => week.days);
    expect(cells.find((cell) => cell.date === '2026-09-03')?.eligible).toBe(false);
    expect(cells.find((cell) => cell.date === '2026-09-04')?.eligible).toBe(true);
    h.clock.advanceDays(1);
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 7, metricsReady: true } });
    const consistency = await getConsistencyAnalytics(h.deps, boardId);
    if (!consistency.ok || !consistency.value) throw new Error('missing consistency');
    expect(consistency.value.at(-2)?.percent).toBeNull();
    expect(consistency.value.at(-1)?.percent).toBeCloseTo(100 / 7);
    expect(await getWeekdayAnalytics(h.deps, boardId)).toMatchObject({ ok: true, value: { workdayCount: 1 } });
  });

  it('has no tracked days before its first completion or after its last completion is removed', async () => {
    const boardId = await createBoardForTest(h);
    h.clock.advanceDays(20);
    const empty = { ok: true, value: { eligibleDayCount: 0, metricsReady: false, consistencyPercent: null, consistencyBand: null } };
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject(empty);
    const id = await check(boardId, '2026-09-15');
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: id })).toMatchObject({ ok: true });
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject(empty);
  });

  it('recalculates activation after moving, removing and suppressing the first check', async () => {
    const boardId = await createBoardForTest(h);
    h.clock.advanceDays(10);
    const first = await check(boardId, '2026-09-04');
    const second = await check(boardId, '2026-09-07');
    const row = await getCheckIn(h.deps, first);
    if (!row.ok || !row.value) throw new Error('missing check');
    expect(await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first,
      expectedMutationStamp: row.value.mutationStamp, logicalDate: d('2026-09-08') })).toMatchObject({ ok: true });
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 3 } });
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: second })).toMatchObject({ ok: true });
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 2 } });
    // simulate the derived visibility written by action replay after synchronization.
    await h.db.runAsync('UPDATE check_ins SET state_suppressed = 1 WHERE id = ?', [first]);
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 0 } });
  });

  it('counts pre-creation history consistently on home and detail', async () => {
    const boardId = await createBoardForTest(h, { kind: 'daily' });
    const periods = await h.db.getAllAsync('SELECT * FROM board_activity_periods');
    for (const date of ['2026-08-28', '2026-08-29', '2026-08-30']) await check(boardId, date);
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: {
      eligibleDayCount: 3, currentStreak: 3, longestStreak: 3, consistencyPercent: 100,
      currentWeekCount: 3, currentMonthCount: 3,
    } });
    expect(await getHomeBoardProjection(h.deps)).toMatchObject({ ok: true, value: [{ currentStreak: 3 }] });
    expect(await getStreakAnalytics(h.deps, boardId)).toMatchObject({ ok: true, value: { allTimeLongest: 3 } });
    expect(await h.db.getAllAsync('SELECT * FROM board_activity_periods')).toEqual(periods);
  });

  it('preserves archived gaps and activation outside the requested heatmap window', async () => {
    const boardId = await createBoardForTest(h);
    h.clock.advanceDays(2);
    await check(boardId, '2026-09-01');
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    h.clock.advanceDays(3);
    expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    h.clock.advanceDays(6);
    expect(await getBoardSummary(h.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 8 } });
    const heatmap = await getBoardHeatmap(h.deps, boardId, { days: 8 });
    if (!heatmap.ok || !heatmap.value) throw new Error('missing heatmap');
    const cells = heatmap.value.weeks.flatMap((week) => week.days);
    expect(cells.find((cell) => cell.date === '2026-09-03')?.eligible).toBe(false);
    expect(cells.find((cell) => cell.date === '2026-09-04')?.eligible).toBe(true);
    expect(cells.find((cell) => cell.date === '2026-09-10')?.eligible).toBe(true);
  });
});
