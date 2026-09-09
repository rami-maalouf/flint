import { admitLegacyChecks } from '../helpers/legacy-checks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckInIntent, runRemoveLatestIntent, runTodayCheckInsIntent } from '@/core/automations/contract';
import { createBoard, archiveBoard, importSnapshot, createCheckIn, deleteBoard, removeCheckIn, removeLatestCheckIn, toggleDailyCheckIn, undoCreatedCheckIn, updateBoard, updateCheckIn } from '@/core/domain/commands';
import type { CheckIn } from '@/core/domain/entities';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { foldDailyActions } from '@/core/domain/habit-actions';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById, insertCheckIn, listBoardCheckInsForDate } from '@/core/persistence/repositories/check-ins';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { getSettings } from '@/core/persistence/repositories/support';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../src/core/automations/fixtures/habit-actions.json'), 'utf8'));
const today = '2026-08-30' as LogicalDate;
const yesterday = '2026-08-29' as LogicalDate;
function boardInput(h: TestHarness, kind: 'daily' | 'count' = 'daily') {
  return { commandId: h.ids.nextCommandId(), title: 'read', symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false, kind, tracksAmount: true, amountUnit: 'pages', quickAmount: 3, tracksTime: true, startOfDayMinute: 0, metricsEnabled: true };
}
async function makeBoard(h: TestHarness, kind: 'daily' | 'count' = 'daily'): Promise<BoardId> {
  const result = await createBoard(h.deps, boardInput(h, kind));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}
async function check(h: TestHarness, boardId: BoardId, logicalDate = today) {
  const commandId = h.ids.nextCommandId();
  const result = await createCheckIn(h.deps, { commandId, boardId, logicalDate, source: 'app' });
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.value, commandId };
}

async function legacyCheck(h: TestHarness, boardId: BoardId, logicalDate = today) {
  const check: CheckIn = {
    id: h.ids.uuid() as never, boardId, logicalDate, occurredAtUtc: h.clock.utcMs,
    timeZoneId: h.clock.zone, offsetMinutes: -240, amount: 3, note: 'preserved note',
    source: 'app', idempotencyKey: h.ids.nextCommandId(), createdAt: h.clock.utcMs,
    updatedAt: h.clock.utcMs, mutationStamp: '01788105600000-00000-legacy', deletedAt: null,
  };
  await insertCheckIn(h.db, check);
  await admitLegacyChecks(h, [check]);
  return check;
}

describe('daily commands and action evidence', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('forces daily tracking off and makes concurrent checks a read-only no-op after the first', async () => {
    const boardId = await makeBoard(h);
    expect(await getBoardById(h.db, boardId)).toMatchObject({ kind: 'daily', tracksAmount: false, tracksTime: false, amountUnit: 'pages', quickAmount: 3 });
    const first = await check(h, boardId);
    expect(first.created).toBe(true);
    const settings = await getSettings(h.db);
    const outbox = await h.db.getAllAsync('SELECT * FROM mutation_outbox');
    const second = await check(h, boardId);
    expect(second).toMatchObject({ created: false, checkInId: first.checkInId });
    expect(await getSettings(h.db)).toEqual(settings);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual(outbox);
    expect(await listHabitActions(h.db, boardId, today)).toMatchObject([{ kind: 'check', checkInId: first.checkInId, commandId: first.commandId }]);
    const undo = await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: second.checkInId, createdByCommandId: second.commandId });
    expect(undo).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await listBoardCheckInsForDate(h.db, boardId, today)).toHaveLength(1);
  });

  it('retains count history on conversion, unchecks the entire date, and rechecks with a new token', async () => {
    const boardId = await makeBoard(h, 'count');
    const first = await check(h, boardId);
    const second = await check(h, boardId);
    const board = (await getBoardById(h.db, boardId))!;
    expect(await updateBoard(h.deps, { ...boardInput(h), boardId, expectedMutationStamp: board.mutationStamp })).toMatchObject({ ok: true });
    expect(await getCheckInById(h.db, first.checkInId)).toMatchObject({ amount: 3, occurredAtUtc: h.clock.utcMs });
    const removed = await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    expect(removed).toMatchObject({ ok: true, value: { removedCheckInIds: [first.checkInId, second.checkInId], logicalDate: today } });
    expect(await listBoardCheckInsForDate(h.db, boardId, today)).toEqual([]);
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: false, checkInId: null });
    const next = await check(h, boardId);
    expect(next.created).toBe(true);
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: true, checkInId: next.checkInId });
  });

  it('keeps selective history removal and Undo scoped to their own token', async () => {
    const boardId = await makeBoard(h, 'count');
    const first = await check(h, boardId);
    const second = await check(h, boardId);
    await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: second.checkInId });
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: true, checkInId: first.checkInId });
    await undoCreatedCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId, createdByCommandId: first.commandId });
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: false, checkInId: null });
  });

  it('rejects moving onto an occupied daily date before evidence writes, then records a free-date move', async () => {
    const boardId = await makeBoard(h);
    const first = await check(h, boardId);
    await check(h, boardId, yesterday);
    const row = (await getCheckInById(h.db, first.checkInId))!;
    const before = await h.db.getAllAsync('SELECT * FROM habit_actions');
    expect(await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId, expectedMutationStamp: row.mutationStamp, logicalDate: yesterday })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual(before);
    expect(await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.checkInId, expectedMutationStamp: row.mutationStamp, logicalDate: '2026-08-28' as LogicalDate })).toMatchObject({ ok: true });
    expect((await listHabitActions(h.db, boardId, today)).map(x => x.kind)).toEqual(['check', 'move_out']);
    expect((await listHabitActions(h.db, boardId, '2026-08-28' as LogicalDate)).map(x => x.kind)).toEqual(['move_in']);
  });

  it('toggles inside one command transaction and records board deletion evidence', async () => {
    const boardId = await makeBoard(h);
    const commandId = h.ids.nextCommandId();
    const checked = await toggleDailyCheckIn(h.deps, { commandId, boardId });
    expect(checked).toMatchObject({ ok: true, value: { checked: true, created: true } });
    expect(await toggleDailyCheckIn(h.deps, { commandId, boardId })).toEqual(checked);
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true, value: { checked: false } });
    await check(h, boardId);
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: false, checkInId: null });
  });
  it('preserves explicitly admitted legacy baselines through conversion and preserves omitted daily kind and old values', async () => {
    const boardId = await makeBoard(h, 'count');
    const first = await legacyCheck(h, boardId);
    const second = await legacyCheck(h, boardId);
    const board = (await getBoardById(h.db, boardId))!;
    await updateBoard(h.deps, { ...boardInput(h), boardId, expectedMutationStamp: board.mutationStamp });
    expect(await getCheckInById(h.db, first.id)).toEqual(first);
    const actions = await listHabitActions(h.db, boardId, today);
    expect(actions.map(x => x.kind)).toEqual(['baseline', 'baseline', 'policy']);
    expect(foldDailyActions(actions).checked).toBe(true);
    const daily = (await getBoardById(h.db, boardId))!;
    const { kind: omitted, ...input } = boardInput(h);
    void omitted;
    await updateBoard(h.deps, { ...input, boardId, expectedMutationStamp: daily.mutationStamp });
    expect(await getBoardById(h.db, boardId)).toMatchObject({ kind: 'daily', tracksAmount: false, tracksTime: false });
    await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.id });
    expect(foldDailyActions(await listHabitActions(h.db, boardId, today))).toEqual({ checked: true, checkInId: second.id });
    const row = (await getCheckInById(h.db, second.id))!;
    await updateCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: row.id, logicalDate: today, expectedMutationStamp: row.mutationStamp, note: 'edited' });
    expect(await getCheckInById(h.db, second.id)).toMatchObject({ amount: second.amount, occurredAtUtc: second.occurredAtUtc, note: 'edited' });
  });

  it('rejects changed confirmation sets without writes and permits matching and unchecked expectations', async () => {
    const boardId = await makeBoard(h);
    const first = await check(h, boardId);
    const row = (await getCheckInById(h.db, first.checkInId))!;
    const expectedCheckIns = [{ checkInId: row.id, mutationStamp: row.mutationStamp }];
    const before = await h.db.getAllAsync('SELECT * FROM habit_actions');
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, expectedCheckIns: [] })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, expectedCheckIns: [{ ...expectedCheckIns[0], mutationStamp: 'old' }] })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual(before);
    expect(await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, expectedCheckIns })).toMatchObject({ ok: true });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: yesterday, expectedCheckIns: [] })).toMatchObject({ ok: true, value: { checked: true } });
    const added = (await listBoardCheckInsForDate(h.db, boardId, yesterday))[0];
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: yesterday, expectedCheckIns: [{ checkInId: added.id, mutationStamp: added.mutationStamp }] })).toMatchObject({ ok: true, value: { checked: false } });
  });

  it('replays successful check and edit receipts before validating changed retry notes', async () => {
    const boardId = await makeBoard(h);
    const created = await check(h, boardId);
    expect(await createCheckIn(h.deps, { commandId: created.commandId, boardId, source: 'app', note: 'x'.repeat(10001) })).toMatchObject({ ok: true, value: { checkInId: created.checkInId, created: true } });
    const row = (await getCheckInById(h.db, created.checkInId))!;
    const input = { commandId: h.ids.nextCommandId(), checkInId: row.id, logicalDate: today, expectedMutationStamp: row.mutationStamp, note: 'saved' };
    const edited = await updateCheckIn(h.deps, input);
    expect(await updateCheckIn(h.deps, { ...input, note: 'x'.repeat(10001) })).toEqual(edited);
    expect(await listHabitActions(h.db, boardId, today)).toHaveLength(1);
  });

  it('serializes simultaneous Daily creates and retains one created receipt', async () => {
    const boardId = await makeBoard(h);
    const outcomes = await Promise.all([check(h, boardId), check(h, boardId)]);
    expect(outcomes.map(x => x.created).sort()).toEqual([false, true]);
    expect(new Set(outcomes.map(x => x.checkInId)).size).toBe(1);
    expect(await listHabitActions(h.db, boardId, today)).toHaveLength(1);
  });

  it('validates new Daily-only operations before evidence writes', async () => {
    const boardId = await makeBoard(h);
    const count = await makeBoard(h, 'count');
    expect(await createBoard(h.deps, { ...boardInput(h), kind: 'other' as never })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app', occurredAtUtc: h.clock.utcMs })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: count })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: h.ids.uuid() as never })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: '2026-09-01' as LogicalDate })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await removeLatestCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: '2026-09-01' as LogicalDate })).toMatchObject({ ok: false, error: { code: 'validation' } });
    await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: false, error: { code: 'archived' } });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
  });

  it('restores deterministic import baselines without earning or duplicating on retry', async () => {
    const sourceId = h.ids.uuid();
    const sourceCheckId = h.ids.uuid();
    const draft = { source: 'own' as const, boards: [{ ...boardInput(h, 'count'), sourceId, amountUnit: null, createdAtUtc: h.clock.utcMs, archivedAtUtc: null, preserveId: true, periods: null, orderKey: null }], checkIns: [{ sourceId: sourceCheckId, sourceBoardId: sourceId, logicalDate: '1960-01-01', occurredAtUtc: null, createdAtUtc: 12, amount: null, note: 'old', timeZoneId: null, offsetMinutes: null, preserveId: true }], reminders: [] };
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft })).toMatchObject({ ok: true, value: { checkInsCreated: 1 } });
    const actions = await listHabitActions(h.db, sourceId as BoardId, '1960-01-01' as LogicalDate);
    expect(actions).toMatchObject([{ kind: 'baseline', commandId: null, checkInId: sourceCheckId, createdAt: 0 }]);
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft })).toMatchObject({ ok: true, value: { checkInsCreated: 0 } });
    expect(await listHabitActions(h.db, sourceId as BoardId, '1960-01-01' as LogicalDate)).toEqual(actions);
  });

  for (const vector of fixture.automationCases) {
    it(vector.name, async () => {
      const boardId = await makeBoard(h);
      for (let index = 0; index < vector.legacyCheckCount; index++) await legacyCheck(h, boardId);
      expect((await listHabitActions(h.db, boardId, today)).filter(x => x.kind === 'baseline')).toHaveLength(vector.legacyCheckCount);
      const created = [];
      for (let index = 0; index < vector.checkAttempts; index++) {
        const result = await runCheckInIntent(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'siri', amount: 999, occurredAtUtc: h.clock.utcMs - 1 });
        expect(result.ok).toBe(true);
        if (result.ok) created.push(result.value.created);
      }
      if (vector.removeLatest) {
        const removed = await runRemoveLatestIntent(h.deps, { commandId: h.ids.nextCommandId(), boardId });
        expect(removed).toMatchObject({ ok: true, value: { logicalDate: today } });
        expect(removed.ok && removed.value.removedCheckInIds).toHaveLength(vector.legacyCheckCount);
      }
      expect(created).toEqual(vector.expectedCreated);
      const rows = await listBoardCheckInsForDate(h.db, boardId, today);
      expect(rows).toHaveLength(vector.expectedLiveCount);
      if (!vector.legacyCheckCount) for (const row of rows) expect(row).toMatchObject({ amount: null, occurredAtUtc: null });
      expect(await runTodayCheckInsIntent(h.deps, { boardId })).toMatchObject({ ok: true, value: { total: vector.expectedTodayCount } });
      expect((await listHabitActions(h.db, boardId, today)).filter(x => x.kind !== 'baseline').map(x => x.kind)).toEqual(vector.expectedActionKinds.filter((kind: string) => kind !== 'baseline'));
    });
  }

  it('retains exact occurrence input for timed Count automation', async () => {
    const boardId = await makeBoard(h, 'count');
    const occurredAtUtc = h.clock.utcMs - 60_000;
    const result = await runCheckInIntent(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'shortcut', occurredAtUtc });
    expect(result.ok).toBe(true);
    if (result.ok) expect(await getCheckInById(h.db, result.value.checkInId as never)).toMatchObject({ occurredAtUtc });
  });

  it('decodes pre-Daily receipts through both core and automation without rewriting them', async () => {
    const boardId = await makeBoard(h, 'count');
    const first = await check(h, boardId);
    const oldCreation = { ok: true, value: { checkInId: first.checkInId, logicalDate: today } };
    await h.db.runAsync('UPDATE command_receipts SET outcome = ? WHERE command_id = ?', [JSON.stringify(oldCreation), first.commandId]);
    const checkInput = { commandId: first.commandId, boardId, source: 'shortcut' as const };
    expect(await createCheckIn(h.deps, checkInput)).toEqual({ ok: true, value: { ...oldCreation.value, created: true } });
    expect(await runCheckInIntent(h.deps, checkInput)).toEqual({ ok: true, value: { ...oldCreation.value, created: true } });
    expect(await h.db.getFirstAsync('SELECT outcome FROM command_receipts WHERE command_id = ?', [first.commandId])).toEqual({ outcome: JSON.stringify(oldCreation) });
    const removalId = h.ids.nextCommandId();
    await removeLatestCheckIn(h.deps, { commandId: removalId, boardId });
    const oldRemoval = { ok: true, value: { removedCheckInId: first.checkInId, logicalDate: today } };
    await h.db.runAsync('UPDATE command_receipts SET outcome = ? WHERE command_id = ?', [JSON.stringify(oldRemoval), removalId]);
    const expected = { ok: true, value: { ...oldRemoval.value, removedCheckInIds: [first.checkInId] } };
    expect(await removeLatestCheckIn(h.deps, { commandId: removalId, boardId })).toEqual(expected);
    expect(await runRemoveLatestIntent(h.deps, { commandId: removalId, boardId })).toEqual(expected);
  });

});
