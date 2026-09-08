import { isDateEligible, type ActivityPeriodRange } from '@/core/calendar/periods';
import { archiveBoard, createBoard, createCheckIn, importSnapshot, restoreBoard } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoardSummary } from '@/core/domain/queries';
import { isStackDateEligible } from '@/core/domain/stack-runs';
import { parseOwnExport } from '@/core/export/import-parsers';
import { getExportSnapshot, serializeExport } from '@/core/export/serialize';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const today = '2026-09-10' as LogicalDate;
const dates = ['2026-09-07', '2026-09-08', '2026-09-09', today] as LogicalDate[];

describe('own-format activity period preservation', () => {
  let source: TestHarness;
  let destination: TestHarness;
  beforeEach(async () => {
    source = await createTestHarness();
    destination = await createTestHarness();
    destination.clock.utcMs = Date.parse('2026-09-10T12:00:00Z');
    destination.clock.zone = 'UTC';
  });
  afterEach(async () => {
    await source.db.closeAsync();
    await destination.db.closeAsync();
  });

  async function createAt(instant: string, zone: string): Promise<BoardId> {
    source.clock.utcMs = Date.parse(instant);
    source.clock.zone = zone;
    const made = await createBoard(source.deps, {
      commandId: source.ids.nextCommandId(), title: 'Travel history', symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: false, kind: 'count', tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
    });
    if (!made.ok) throw new Error(made.error.message);
    return made.value.boardId;
  }

  async function check(boardId: BoardId, logicalDate: LogicalDate) {
    expect(await createCheckIn(source.deps, {
      commandId: source.ids.nextCommandId(), boardId, logicalDate,
      note: `retained ${logicalDate}`, source: 'app',
    })).toMatchObject({ ok: true });
  }

  async function exportFile(): Promise<string> {
    const result = await getExportSnapshot(source.deps, {
      databaseSchemaVersion: 8, appVersion: 'test', buildVersion: 'test', locale: 'en-US',
    });
    if (!result.ok) throw new Error(result.error.message);
    return serializeExport(result.value);
  }

  async function restoreFile(serialized: string) {
    const parsed = parseOwnExport(serialized);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const input = { commandId: destination.ids.nextCommandId(), draft: parsed.value };
    const result = await importSnapshot(destination.deps, input);
    expect(result).toMatchObject({ ok: true, value: { boardsCreated: 1 } });
    return input;
  }

  async function observed(h: TestHarness, boardId: BoardId) {
    const periods = await h.db.getAllAsync<ActivityPeriodRange>(
      'SELECT start_date AS startDate, end_date AS endDate FROM board_activity_periods WHERE board_id = ? ORDER BY start_date, end_date', [boardId]);
    const checks = await h.db.getAllAsync(
      'SELECT id, logical_date, note, occurred_at_utc, time_zone_id, offset_minutes, amount FROM check_ins WHERE board_id = ? ORDER BY id', [boardId]);
    const summary = await getBoardSummary(h.deps, boardId);
    return { periods, checks, summary, eligibility: dates.map(date => ({ date,
      habit: isDateEligible(date, periods, today), stack: isStackDateEligible(date, periods, today),
    })) };
  }

  async function archivedBackward() {
    const boardId = await createAt('2026-09-08T23:00:00Z', 'Pacific/Auckland');
    await check(boardId, dates[1]);
    await check(boardId, dates[2]);
    source.clock.utcMs = Date.parse('2026-09-09T01:00:00Z');
    source.clock.zone = 'Pacific/Honolulu';
    expect(await archiveBoard(source.deps, { commandId: source.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    source.clock.utcMs = destination.clock.utcMs;
    source.clock.zone = 'UTC';
    return boardId;
  }

  async function overlappingRestore() {
    const boardId = await createAt('2026-09-07T12:00:00Z', 'UTC');
    await check(boardId, dates[0]);
    source.clock.utcMs = Date.parse('2026-09-08T23:00:00Z');
    source.clock.zone = 'Pacific/Auckland';
    await check(boardId, dates[1]);
    expect(await archiveBoard(source.deps, { commandId: source.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    source.clock.utcMs = Date.parse('2026-09-09T01:00:00Z');
    source.clock.zone = 'Pacific/Honolulu';
    expect(await restoreBoard(source.deps, { commandId: source.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    source.clock.utcMs = destination.clock.utcMs;
    source.clock.zone = 'UTC';
    return boardId;
  }

  it('preserves a real backward archive and its empty eligibility through export, parse and import', async () => {
    const boardId = await archivedBackward();
    const before = await observed(source, boardId);
    expect(before.periods).toEqual([{ startDate: '2026-09-09', endDate: '2026-09-08' }]);
    expect(before.summary).toMatchObject({ ok: true, value: { eligibleDayCount: 0, currentStreak: 0, longestStreak: 0, consistencyPercent: null } });
    const input = await restoreFile(await exportFile());
    expect(await observed(destination, boardId)).toEqual(before);
    const after = await destination.db.getAllAsync('SELECT * FROM board_activity_periods');
    expect(await importSnapshot(destination.deps, input)).toMatchObject({ ok: true });
    expect(await destination.db.getAllAsync('SELECT * FROM board_activity_periods')).toEqual(after);
    expect(await destination.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('preserves the overlap produced by a real zone-changing archive and restore', async () => {
    const boardId = await overlappingRestore();
    const before = await observed(source, boardId);
    expect(before.periods).toEqual([
      { startDate: '2026-09-07', endDate: '2026-09-09' },
      { startDate: '2026-09-08', endDate: null },
    ]);
    await restoreFile(await exportFile());
    expect(await observed(destination, boardId)).toEqual(before);
  });

  it('counts dates in actual overlapping periods once in the public board summary', async () => {
    const boardId = await overlappingRestore();
    expect(await getBoardSummary(source.deps, boardId)).toMatchObject({ ok: true, value: { eligibleDayCount: 4, metricsReady: false } });
  });

  it('restores unsorted open, closed and reversed ranges without closing earlier open rows', async () => {
    const boardId = await createAt('2026-09-07T12:00:00Z', 'UTC');
    const file = JSON.parse(await exportFile());
    file.boards[0].periods = [
      { startDate: '2026-09-08', endDate: null },
      { startDate: '2026-09-09', endDate: '2026-09-07' },
      { startDate: '2026-09-07', endDate: '2026-09-08' },
      { startDate: '2026-09-07', endDate: null },
    ];
    await restoreFile(JSON.stringify(file));
    const periods = (await observed(destination, boardId)).periods;
    expect(periods).toEqual([
      { startDate: '2026-09-07', endDate: null },
      { startDate: '2026-09-07', endDate: '2026-09-08' },
      { startDate: '2026-09-08', endDate: null },
      { startDate: '2026-09-09', endDate: '2026-09-07' },
    ]);
    expect(await destination.db.getAllAsync("SELECT entity_id FROM mutation_outbox WHERE entity_type = 'activity_period' ORDER BY entity_id"))
      .toEqual([{ entity_id: '1' }, { entity_id: '2' }, { entity_id: '3' }, { entity_id: '4' }]);
  });

  it.each(['bad-start', 'bad-end', 'null-entry', 'missing', 'empty'])('retains the established lifetime fallback for %s period evidence', async mode => {
    const boardId = await archivedBackward();
    const file = JSON.parse(await exportFile());
    if (mode === 'bad-start') file.boards[0].periods[0].startDate = 'malformed-date';
    if (mode === 'bad-end') file.boards[0].periods[0].endDate = 'malformed-date';
    if (mode === 'null-entry') file.boards[0].periods = [null];
    if (mode === 'missing') delete file.boards[0].periods;
    if (mode === 'empty') file.boards[0].periods = [];
    await restoreFile(JSON.stringify(file));
    expect((await observed(destination, boardId)).periods).toEqual([{ startDate: '2026-09-08', endDate: '2026-09-09' }]);
  });
});
