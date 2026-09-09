import { admitLegacyChecks } from '../helpers/legacy-checks';
import { addDays } from '@/core/calendar/logical-date';
import { archiveBoard, createBoard, deleteBoard, restoreBoard, toggleDailyCheckIn } from '@/core/domain/commands';
import type { CreateBoardInput } from '@/core/domain/commands';
import type { CheckIn } from '@/core/domain/entities';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { getDailyToggleSnapshot, getHomeBoardProjection } from '@/core/domain/queries';
import { insertCheckIn } from '@/core/persistence/repositories/check-ins';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const today = '2026-08-30' as LogicalDate;
const day = (date: string) => date as LogicalDate;

async function create(h: TestHarness, overrides: Partial<CreateBoardInput> = {}): Promise<BoardId> {
  const result = await createBoard(h.deps, {
    commandId: h.ids.nextCommandId(), kind: 'daily', title: 'daily habit', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: true, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function seed(h: TestHarness, boardId: BoardId, dates: string[], overrides: Partial<CheckIn> = {}) {
  const checks: CheckIn[] = [];
  for (const logicalDate of dates) {
    const check: CheckIn = {
      id: h.ids.uuid() as CheckInId, boardId, logicalDate: day(logicalDate),
      occurredAtUtc: null, timeZoneId: null, offsetMinutes: null, amount: null, note: null,
      source: 'app', idempotencyKey: h.ids.nextCommandId(), createdAt: h.clock.utcMs,
      updatedAt: h.clock.utcMs, mutationStamp: '01788105600000-00000-seed', deletedAt: null,
      ...overrides,
    };
    await insertCheckIn(h.db, check);
    await admitLegacyChecks(h, [check]);
    checks.push(check);
  }
  return checks;
}

async function cards(h: TestHarness) {
  const result = await getHomeBoardProjection(h.deps);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('daily home projection', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); h.clock.utcMs = Date.UTC(2026, 7, 1, 16); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('shows fourteen binary cells and distinct weekly completion while preserving Count counts', async () => {
    const dailyId = await create(h);
    const countId = await create(h, { kind: 'count', title: 'count board' });
    await seed(h, dailyId, ['2026-08-16', '2026-08-17', '2026-08-24', today, today]);
    await seed(h, countId, [today, today]);
    h.clock.utcMs = Date.UTC(2026, 7, 30, 16);
    const [daily, count] = await cards(h);
    expect(daily).toMatchObject({ today, daily: { checkedToday: true, completedThisWeek: 2, currentStreak: 1 } });
    expect(daily.strip).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    expect(count.daily).toBeNull();
    expect(count.strip[13]).toBe(2);
  });

  it('counts ISO weeks across a year boundary and resets on Monday', async () => {
    h.clock.utcMs = Date.UTC(2025, 11, 1, 16);
    const boardId = await create(h);
    await seed(h, boardId, ['2025-12-28', '2025-12-29', '2025-12-31', '2026-01-01', '2026-01-04', '2026-01-05']);
    h.clock.utcMs = Date.UTC(2026, 0, 4, 16);
    expect((await cards(h))[0].daily).toEqual({ checkedToday: true, completedThisWeek: 4, currentStreak: 1 });
    h.clock.utcMs = Date.UTC(2026, 0, 5, 16);
    expect((await cards(h))[0].daily).toEqual({ checkedToday: true, completedThisWeek: 1, currentStreak: 2 });
  });

  it('keeps a streak longer than the strip and does not break it while today is unfinished', async () => {
    const boardId = await create(h);
    const dates = Array.from({ length: 20 }, (_, index) => addDays(day('2026-08-10'), index));
    await seed(h, boardId, dates);
    h.clock.utcMs = Date.UTC(2026, 7, 30, 16);
    expect((await cards(h))[0].daily).toEqual({ checkedToday: false, completedThisWeek: 6, currentStreak: 20 });
    h.clock.advanceDays(1);
    expect((await cards(h))[0].daily).toEqual({ checkedToday: false, completedThisWeek: 0, currentStreak: 0 });
  });

  it('uses each shifted board day and permanently stored dates instead of occurrence instants', async () => {
    const midnight = await create(h);
    const shifted = await create(h, { title: 'noon shift', startOfDayMinute: 720 });
    await seed(h, midnight, ['2026-08-30', '2026-08-31']);
    await seed(h, shifted, ['2026-08-30', '2026-08-31'], { occurredAtUtc: Date.UTC(2024, 0, 1), timeZoneId: 'Pacific/Auckland', offsetMinutes: 780 });
    h.clock.utcMs = Date.UTC(2026, 7, 31, 15, 30);
    const [early, late] = await cards(h);
    expect(early).toMatchObject({ today: '2026-08-31', daily: { checkedToday: true, completedThisWeek: 1, currentStreak: 2 } });
    expect(late).toMatchObject({ today: '2026-08-30', daily: { checkedToday: true, completedThisWeek: 1, currentStreak: 1 } });
  });

  it('respects archive gaps and ignores pre-creation, deleted, and future records in summaries', async () => {
    h.clock.utcMs = Date.UTC(2026, 7, 24, 16);
    const boardId = await create(h);
    await seed(h, boardId, ['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', today, '2026-08-31']);
    await seed(h, boardId, [today], { deletedAt: h.clock.utcMs });
    h.clock.utcMs = Date.UTC(2026, 7, 25, 16);
    await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    h.clock.utcMs = Date.UTC(2026, 7, 29, 16);
    await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    h.clock.utcMs = Date.UTC(2026, 7, 30, 16);
    const card = (await cards(h))[0];
    expect(card.daily).toEqual({ checkedToday: true, completedThisWeek: 4, currentStreak: 2 });
    // retained records remain visible during the gap, while metrics use eligibility.
    expect(card.strip.slice(9, 12)).toEqual([1, 1, 1]);
  });

  it('excludes archived and deleted boards, and handles no history or disabled metrics', async () => {
    const empty = await create(h);
    const disabled = await create(h, { title: 'without metrics', metricsEnabled: false });
    const archived = await create(h, { title: 'archived' });
    const deleted = await create(h, { title: 'deleted' });
    await seed(h, disabled, [today]);
    await seed(h, archived, [today]);
    await seed(h, deleted, [today]);
    await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: archived });
    await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: deleted });
    h.clock.utcMs = Date.UTC(2026, 7, 30, 16);
    const result = await cards(h);
    expect(result.map(x => x.board.id)).toEqual([empty, disabled]);
    expect(result[0].daily).toEqual({ checkedToday: false, completedThisWeek: 0, currentStreak: 0 });
    expect(result[0].strip).toEqual(new Array(14).fill(0));
    expect(result[1].daily).toEqual({ checkedToday: true, completedThisWeek: 1, currentStreak: null });
  });

  it('keeps the grouped read count bounded across many Daily boards', async () => {
    for (let index = 0; index < 12; index++) {
      const boardId = await create(h, { title: `habit ${index}` });
      await seed(h, boardId, [today, today]);
    }
    h.clock.utcMs = Date.UTC(2026, 7, 30, 16);
    const reads = jest.spyOn(h.db, 'getAllAsync');
    const result = await cards(h);
    expect(result).toHaveLength(12);
    expect(result.every(card => card.daily?.completedThisWeek === 1)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(3);
    reads.mockRestore();
  });
});

describe('daily toggle confirmation snapshot', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('captures all selected date ids, stamps, and note counts in one read transaction without writes', async () => {
    const boardId = await create(h);
    const records = await seed(h, boardId, [today, today], { note: 'retained note' });
    await seed(h, boardId, [today]);
    await seed(h, boardId, [today], { note: 'deleted note', deletedAt: h.clock.utcMs });
    await seed(h, boardId, ['2026-08-29'], { note: 'another date' });
    const transaction = jest.spyOn(h.db, 'withTransactionAsync');
    const writes = jest.spyOn(h.db, 'runAsync');
    const result = await getDailyToggleSnapshot(h.deps, boardId);
    expect(result).toMatchObject({ ok: true, value: { boardId, boardTitle: 'daily habit', logicalDate: today, checked: true, checkInCount: 3, noteCount: 2 } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.expectedCheckIns).toHaveLength(3);
    expect(result.value.expectedCheckIns.slice(0, 2)).toEqual(records.map(record => ({ checkInId: record.id, mutationStamp: record.mutationStamp })));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    transaction.mockRestore(); writes.mockRestore();
    await seed(h, boardId, [today], { note: 'added after prompt' });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: result.value.logicalDate, expectedCheckIns: result.value.expectedCheckIns })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('captures an empty expected set and accepts a specific past date', async () => {
    const boardId = await create(h, { startOfDayMinute: 720 });
    h.clock.utcMs = Date.UTC(2026, 7, 30, 15);
    expect(await getDailyToggleSnapshot(h.deps, boardId)).toMatchObject({ ok: true, value: { logicalDate: '2026-08-29', checked: false, checkInCount: 0, noteCount: 0, expectedCheckIns: [] } });
    await seed(h, boardId, ['2026-08-28']);
    expect(await getDailyToggleSnapshot(h.deps, boardId, day('2026-08-28'))).toMatchObject({ ok: true, value: { logicalDate: '2026-08-28', checked: true, checkInCount: 1, noteCount: 0 } });
  });

  it('rejects missing, Count, archived, invalid-date, and future-date targets', async () => {
    const daily = await create(h);
    const count = await create(h, { kind: 'count' });
    expect(await getDailyToggleSnapshot(h.deps, h.ids.uuid() as BoardId)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await getDailyToggleSnapshot(h.deps, count)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await getDailyToggleSnapshot(h.deps, daily, day('2026-02-30'))).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await getDailyToggleSnapshot(h.deps, daily, day('2026-08-31'))).toMatchObject({ ok: false, error: { code: 'validation' } });
    await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: daily });
    expect(await getDailyToggleSnapshot(h.deps, daily)).toMatchObject({ ok: false, error: { code: 'archived' } });
  });

  it('returns the normal recoverable query error when the snapshot cannot be read', async () => {
    const boardId = await create(h);
    const reads = jest.spyOn(h.db, 'getAllAsync').mockRejectedValueOnce(new Error('snapshot unavailable'));
    expect(await getDailyToggleSnapshot(h.deps, boardId)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    reads.mockRestore();
  });
});
