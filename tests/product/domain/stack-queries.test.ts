import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveBoard, createBoard, createCheckIn, deleteBoard, importSnapshot, restoreBoard, setAnchorPresetMinute, updateBoard, type CreateBoardInput } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getStackDetailSnapshot, getStackListSnapshot } from '@/core/domain/stack-queries';
import { parseOwnExport } from '@/core/export/import-parsers';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { readStackEvidence } from '@/core/persistence/repositories/stack-evidence';

import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const fields = { title: 'Stack member', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true };
const date = (value: string) => value as LogicalDate;
const missing = '00000000-0000-4000-8000-999999999999' as BoardId;
async function semanticSnapshot(h: TestHarness) {
  return Promise.all(['boards', 'check_ins', 'habit_actions', 'board_activity_periods', 'app_settings', 'mutation_outbox', 'command_receipts', 'widget_board_rows'].map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

describe('stack query snapshots', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });
  async function board(extra: Partial<CreateBoardInput> = {}) {
    const result = await createBoard(h.deps, { ...fields, ...extra, commandId: h.ids.nextCommandId() });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }
  async function check(boardId: BoardId, logicalDate: string) {
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: date(logicalDate), source: 'app', note: 'retained' });
    expect(result.ok).toBe(true);
  }

  it('returns ordered active members, compact metrics and separate truthful detail without changing evidence', async () => {
    const root = await board({ title: 'Root', anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const first = await board({ title: 'Before', anchor: { kind: 'board', relation: 'before', boardId: root }, usualTimeMinute: 0 });
    const optional = await board({ title: 'Optional', requiredInStack: false, anchor: { kind: 'board', relation: 'after', boardId: root } });
    await board({ title: 'Unanchored singleton' });
    h.clock.utcMs = Date.parse('2026-09-08T16:00:00Z');
    for (const id of [root, first]) {
      await check(id, '2026-09-07'); await check(id, '2026-09-08');
    }
    await check(root, '2026-09-08');
    await check(first, '2026-09-08');
    const row = (await getBoardById(h.db, first))!;
    await updateBoard(h.deps, { ...row, boardId: first, commandId: h.ids.nextCommandId(), expectedMutationStamp: row.mutationStamp, kind: 'daily' });
    const before = await semanticSnapshot(h);
    const list = await getStackListSnapshot(h.deps);
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value).toMatchObject({ generatedAtUtc: h.clock.utcMs, timeZoneId: h.clock.zone, refreshAtUtc: Date.parse('2026-09-09T04:00:00Z') });
    expect(list.value.stacks).toHaveLength(1);
    const summary = list.value.stacks[0];
    expect(summary).toEqual({
      rootId: root, rootStartOfDayMinute: 0,
      members: [
        { id: first, title: 'Before', symbol: fields.symbol, accentHex: fields.accentHex, kind: 'daily', requiredInStack: true, checked: true, eligible: true },
        { id: root, title: 'Root', symbol: fields.symbol, accentHex: fields.accentHex, kind: 'count', requiredInStack: true, checked: true, eligible: true },
        { id: optional, title: 'Optional', symbol: fields.symbol, accentHex: fields.accentHex, kind: 'count', requiredInStack: false, checked: false, eligible: true },
      ],
      timeHint: { kind: 'usualTime', minute: 0 },
      currentRun: { logicalDate: '2026-09-08', requiredCount: 2, checkedRequiredCount: 2, available: true, complete: true },
      completeRunsThisWeek: 2, currentStreak: 2,
    });
    const detail = await getStackDetailSnapshot(h.deps, root);
    if (!detail.ok) throw new Error(detail.error.message);
    expect(detail.value.stack).toMatchObject({ ...summary, longestStreak: 2, memberWeeklyCounts: [{ boardId: first, checks: 2 }, { boardId: root, checks: 3 }, { boardId: optional, checks: 0 }] });
    expect(detail.value.stack.heatmap).toHaveLength(365);
    expect(detail.value.stack.heatmap.at(-1)).toEqual({ ...summary.currentRun, state: 'all' });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it('keeps archived roots and their day boundary while missing, non-root and all-archived details are not found', async () => {
    const root = await board({ startOfDayMinute: 240 });
    const child = await board({ anchor: { kind: 'board', relation: 'before', boardId: root } });
    await archiveBoard(h.deps, { boardId: root, commandId: h.ids.nextCommandId() });
    h.clock.utcMs = Date.parse('2026-09-08T07:30:00Z');
    const result = await getStackDetailSnapshot(h.deps, root);
    expect(result).toMatchObject({ ok: true, value: { refreshAtUtc: Date.parse('2026-09-08T08:00:00Z'), stack: { rootId: root, rootStartOfDayMinute: 240, members: [{ id: child }], timeHint: null, currentRun: { logicalDate: '2026-09-07', requiredCount: 1 } } } });
    expect(await getStackDetailSnapshot(h.deps, child)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await getStackDetailSnapshot(h.deps, missing)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await getStackDetailSnapshot(h.deps, 'invalid' as BoardId)).toMatchObject({ ok: false, error: { code: 'validation', field: 'rootId' } });
    await archiveBoard(h.deps, { boardId: child, commandId: h.ids.nextCommandId() });
    const reads = jest.spyOn(h.db, 'getAllAsync');
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await getStackListSnapshot(h.deps)).toEqual({ ok: true, value: { generatedAtUtc: h.clock.utcMs, timeZoneId: h.clock.zone, refreshAtUtc: null, stacks: [] } });
    expect(reads.mock.calls.some(([sql]) => sql.includes('FROM check_ins') || sql.includes('FROM board_activity_periods'))).toBe(false);
  });

  it('distinguishes raw same-date checks from unavailable membership and excludes tombstoned evidence', async () => {
    const root = await board({ startOfDayMinute: 240, anchor: { kind: 'text', relation: 'after', text: 'Coffee' } });
    const child = await board({ requiredInStack: false, anchor: { kind: 'board', relation: 'after', boardId: root } });
    h.clock.utcMs = Date.parse('2026-09-07T16:00:00Z');
    await check(child, '2026-09-07');
    await archiveBoard(h.deps, { boardId: child, commandId: h.ids.nextCommandId() });
    h.clock.utcMs = Date.parse('2026-09-08T06:00:00Z');
    await restoreBoard(h.deps, { boardId: child, commandId: h.ids.nextCommandId() });
    await check(root, '2026-09-07');
    await h.db.runAsync('UPDATE check_ins SET deleted_at = ? WHERE board_id = ?', [h.clock.utcMs, root]);
    const deleted = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    await check(deleted, '2026-09-07');
    await deleteBoard(h.deps, { boardId: deleted, commandId: h.ids.nextCommandId() });
    const result = await getStackDetailSnapshot(h.deps, root);
    expect(result).toMatchObject({ ok: true, value: { stack: {
      members: [{ id: root, checked: false, eligible: true }, { id: child, checked: true, eligible: false }],
      currentRun: { logicalDate: '2026-09-07', requiredCount: 1, checkedRequiredCount: 0, complete: false },
      memberWeeklyCounts: [{ boardId: root, checks: 0 }, { boardId: child, checks: 0 }],
    } } });
    await h.db.runAsync('UPDATE board_activity_periods SET deleted_at = ? WHERE board_id = ?', [h.clock.utcMs, root]);
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: true, value: { stack: {
      members: [{ id: root, checked: false, eligible: false }, { id: child, checked: true, eligible: false }],
      currentRun: { requiredCount: 0, checkedRequiredCount: 0, available: false, complete: false },
    } } });
  });

  it('keeps configured preset midnight distinct from no hint and ignores hints for date metrics', async () => {
    const root = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    await check(root, '2026-08-30');
    await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 0 });
    const first = await getStackListSnapshot(h.deps);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.stacks[0].timeHint).toEqual({ kind: 'preset', preset: 'wake', minute: 0 });
    await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 1425 });
    const second = await getStackListSnapshot(h.deps);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.stacks[0]).toEqual({ ...first.value.stacks[0], timeHint: { kind: 'preset', preset: 'wake', minute: 1425 } });
    const row = (await getBoardById(h.db, root))!;
    await updateBoard(h.deps, { ...row, boardId: root, commandId: h.ids.nextCommandId(), expectedMutationStamp: row.mutationStamp, anchor: { kind: 'preset', relation: 'before', preset: 'wake' } });
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true, value: { stacks: [{ timeHint: null }] } });
  });

  it('keeps invalid topology as validation while missing settings and storage failures are retryable', async () => {
    const root = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const target = await board();
    await h.db.runAsync('UPDATE boards SET deleted_at = ? WHERE id = ?', [h.clock.utcMs, target]);
    await h.db.runAsync('UPDATE boards SET anchor_kind = ?, anchor_board_id = ?, anchor_preset = NULL WHERE id = ?', ['board', target, root]);
    for (const query of [() => getStackListSnapshot(h.deps), () => getStackDetailSnapshot(h.deps, root)]) {
      expect(await query()).toMatchObject({ ok: false, error: { code: 'validation', retryable: false } });
    }
    await h.db.runAsync('DELETE FROM app_settings');
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
  });

  it('holds one WAL snapshot across settings, topology, periods and check counts', async () => {
    const root = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const child = await board({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    await check(root, '2026-08-30');
    const directory = mkdtempSync(join(tmpdir(), 'habit-stack-query-'));
    const path = join(directory, 'snapshot.sqlite');
    await h.db.runAsync('VACUUM INTO ?', [path]);
    const reader = new NodeSqlDatabase(path); const writer = new NodeSqlDatabase(path);
    try {
      await reader.execAsync('PRAGMA journal_mode = WAL');
      const original = reader.getFirstAsync.bind(reader);
      const intercepted = jest.spyOn(reader, 'getFirstAsync').mockImplementationOnce(async (sql, params) => {
        const result = await original(sql, params);
        const deps = { ...h.deps, db: writer };
        await setAnchorPresetMinute(deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 450 });
        await createCheckIn(deps, { commandId: h.ids.nextCommandId(), boardId: child, logicalDate: date('2026-08-30'), source: 'app' });
        await archiveBoard(deps, { commandId: h.ids.nextCommandId(), boardId: root });
        return result;
      });
      const first = await getStackDetailSnapshot({ db: reader, clock: h.clock }, root);
      expect(first).toMatchObject({ ok: true, value: { stack: { timeHint: { kind: 'preset', minute: 420 }, members: [{ id: root }, { id: child, checked: false }], currentRun: { requiredCount: 2, checkedRequiredCount: 1, complete: false } } } });
      intercepted.mockRestore();
      expect(await getStackDetailSnapshot({ db: reader, clock: h.clock }, root)).toMatchObject({ ok: true, value: { stack: { timeHint: null, members: [{ id: child, checked: true }], currentRun: { requiredCount: 1, checkedRequiredCount: 1, complete: true } } } });
    } finally {
      await reader.closeAsync(); await writer.closeAsync(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns a retryable query failure after earlier reads and recovers without mutation side effects', async () => {
    const root = await board({ anchor: { kind: 'text', relation: 'after', text: 'Breakfast' } });
    await check(root, '2026-08-30');
    const before = await semanticSnapshot(h);
    const original = h.db.getAllAsync.bind(h.db);
    const read = jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM check_ins')) throw new Error('disk read failed');
      return original(sql, params);
    });
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: false, error: { code: 'database', retryable: true, message: 'The data could not be loaded: disk read failed' } });
    read.mockRestore();
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: true, value: { stack: { currentRun: { complete: true } } } });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it('captures time and zone once when its queued snapshot actually starts', async () => {
    const root = await board({ anchor: { kind: 'text', relation: 'after', text: 'Lunch' } });
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = h.db.withExclusiveTransactionAsync(async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); });
    await entered;
    const now = jest.spyOn(h.clock, 'nowUtcMs'); const zone = jest.spyOn(h.clock, 'timeZoneId');
    const pending = getStackDetailSnapshot(h.deps, root);
    h.clock.utcMs = Date.parse('2026-09-08T01:00:00Z'); h.clock.zone = 'Pacific/Auckland';
    release(); await held;
    expect(await pending).toMatchObject({ ok: true, value: { generatedAtUtc: h.clock.utcMs, timeZoneId: 'Pacific/Auckland', stack: { currentRun: { logicalDate: '2026-09-08' } } } });
    expect(now).toHaveBeenCalledTimes(1); expect(zone).toHaveBeenCalledTimes(1);
  });

  it('scopes evidence to visible components and refreshes at the earliest root boundary', async () => {
    const shifted = await board({ startOfDayMinute: 240, anchor: { kind: 'text', relation: 'after', text: 'Morning' } });
    const midnight = await board({ anchor: { kind: 'text', relation: 'after', text: 'Evening' } });
    const singleton = await board();
    const archived = await board({ anchor: { kind: 'text', relation: 'after', text: 'Archived' } });
    h.clock.utcMs = Date.parse('2026-09-08T16:00:00Z');
    for (const id of [shifted, midnight, singleton, archived]) {
      await check(id, '2026-09-07'); await check(id, '2026-09-08');
    }
    await archiveBoard(h.deps, { boardId: archived, commandId: h.ids.nextCommandId() });
    h.clock.utcMs = Date.parse('2026-09-08T07:30:00Z');
    const reads = jest.spyOn(h.db, 'getAllAsync');
    const list = await getStackListSnapshot(h.deps);
    expect(list).toMatchObject({ ok: true, value: { refreshAtUtc: Date.parse('2026-09-08T08:00:00Z'), stacks: [
      { rootId: shifted, currentRun: { logicalDate: '2026-09-07' }, completeRunsThisWeek: 1 },
      { rootId: midnight, currentRun: { logicalDate: '2026-09-08' }, completeRunsThisWeek: 2 },
    ] } });
    const grouped = reads.mock.calls.findIndex(([sql]) => sql.includes('FROM check_ins'));
    expect(await reads.mock.results[grouped].value).toEqual([
      { board_id: shifted, logical_date: '2026-09-07', count: 1 }, { board_id: shifted, logical_date: '2026-09-08', count: 1 },
      { board_id: midnight, logical_date: '2026-09-07', count: 1 }, { board_id: midnight, logical_date: '2026-09-08', count: 1 },
    ]);
    reads.mockClear();
    expect(await getStackDetailSnapshot(h.deps, midnight)).toMatchObject({ ok: true, value: { refreshAtUtc: Date.parse('2026-09-09T04:00:00Z') } });
    const detailGrouped = reads.mock.calls.findIndex(([sql]) => sql.includes('FROM check_ins'));
    expect(await reads.mock.results[detailGrouped].value).toEqual([
      { board_id: midnight, logical_date: '2026-09-07', count: 1 }, { board_id: midnight, logical_date: '2026-09-08', count: 1 },
    ]);
  });

  it('keeps database reads bounded as the stack grows and groups checks without history payloads', async () => {
    const root = await board({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const reads = jest.spyOn(h.db, 'getAllAsync'); const firstReads = jest.spyOn(h.db, 'getFirstAsync');
    expect((await getStackListSnapshot(h.deps)).ok).toBe(true);
    const baseReads = reads.mock.calls.length + firstReads.mock.calls.length;
    for (let index = 0; index < 40; index += 1) {
      const id = await board({ anchor: { kind: 'board', relation: 'after', boardId: root } });
      await check(id, '2026-08-30');
    }
    reads.mockClear(); firstReads.mockClear();
    const result = await getStackListSnapshot(h.deps);
    expect(result).toMatchObject({ ok: true, value: { stacks: [{ members: expect.any(Array) }] } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.stacks[0].members).toHaveLength(41);
    expect(reads.mock.calls.length + firstReads.mock.calls.length).toBe(baseReads);
    expect(baseReads).toBeLessThanOrEqual(4);
    const countSql = reads.mock.calls.find(([sql]) => sql.includes('FROM check_ins'))?.[0];
    expect(countSql).toMatch(/GROUP BY/);
    expect(countSql).not.toMatch(/note|amount|occurred_at|SELECT \*/);
  });

  it('accepts a component ID set beyond SQLite bind-variable limits without broadening the evidence scope', async () => {
    const selected = await board(); const other = await board();
    await check(selected, '2026-08-30'); await check(other, '2026-08-30');
    const ids = [selected, ...Array.from({ length: 40000 }, () => h.ids.uuid() as BoardId)];
    const result = await readStackEvidence(h.db, ids);
    expect([...result.periodsByBoard.keys()]).toEqual([selected]);
    expect([...result.countsByBoard]).toEqual([[selected, new Map([[date('2026-08-30'), 1]])]]);
  });

  it.each([
    ['year zero leap day', ['0000-02-28', '0000-02-29', '0000-03-01']],
    ['first AD year', ['0001-01-01', '0001-01-02']],
    ['first century boundary', ['0099-12-31', '0100-01-01']],
  ])('keeps the complete imported streak after anchoring %s history', async (_name, dates) => {
    const root = h.ids.uuid() as BoardId;
    const parsed = parseOwnExport(JSON.stringify({
      format: 'habit-system.export', exportVersion: 1,
      boards: [{ ...fields, id: root, createdAtUtc: 0, archivedAtUtc: null, periods: [{ startDate: dates[0], endDate: null }] }],
      checkIns: dates.map((logicalDate) => ({ id: h.ids.uuid(), boardId: root, logicalDate, createdAtUtc: 0, occurredAtUtc: null, note: 'imported early-year record' })),
    }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: parsed.value }))
      .toMatchObject({ ok: true, value: { boardsCreated: 1, checkInsCreated: dates.length } });
    const row = (await getBoardById(h.db, root))!;
    expect((await updateBoard(h.deps, { ...row, boardId: root, expectedMutationStamp: row.mutationStamp, commandId: h.ids.nextCommandId(), anchor: { kind: 'text', relation: 'after', text: 'Historical sequence' } })).ok).toBe(true);
    const before = await semanticSnapshot(h);
    expect(await getStackDetailSnapshot(h.deps, root)).toMatchObject({ ok: true, value: { stack: { longestStreak: dates.length, currentStreak: 0, completeRunsThisWeek: 0 } } });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it.each(['0000-02-29', '0001-01-02'])('stores the correct date and UTC offset for a timed check on %s', async (date) => {
    h.clock.zone = 'UTC';
    const root = await board({ tracksTime: true, anchor: { kind: 'text', relation: 'after', text: 'History' } });
    const occurredAtUtc = Date.parse(`${date}T12:00:00Z`);
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root, occurredAtUtc, source: 'app' });
    expect(result).toMatchObject({ ok: true, value: { logicalDate: date, created: true } });
    expect(await h.db.getFirstAsync('SELECT logical_date, occurred_at_utc, time_zone_id, offset_minutes FROM check_ins WHERE board_id = ?', [root]))
      .toEqual({ logical_date: date, occurred_at_utc: occurredAtUtc, time_zone_id: 'UTC', offset_minutes: 0 });
  });
});
