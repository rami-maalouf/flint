import {
  archiveBoard, createBoard, deleteBoard, restoreBoard, updateBoard, type CreateBoardInput,
} from '@/core/domain/commands';
import { createBoardWithReminders } from '@/core/domain/create-board-with-reminders';
import { validateBoardAnchorGraph } from '@/core/domain/board-anchor';
import type { Board } from '@/core/domain/entities';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById, insertCheckIn } from '@/core/persistence/repositories/check-ins';

import { FakeReminderScheduler } from '../helpers/fake-scheduler';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const fields = {
  title: 'Anchored habit', symbol: 'star.fill', accentHex: '#70A7FF',
  usesTintedBackground: true, tracksAmount: false, tracksTime: false,
  startOfDayMinute: 0, metricsEnabled: true,
};
const noAnchor = { anchorRelation: null, anchorKind: null, anchorBoardId: null, anchorPreset: null, anchorText: null };

async function semanticSnapshot(h: TestHarness) {
  const tables = ['boards', 'check_ins', 'habit_actions', 'board_activity_periods', 'reminders', 'app_settings', 'mutation_outbox', 'widget_board_rows'];
  return Promise.all(tables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

describe('board anchor inputs', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  async function create(extra: Partial<CreateBoardInput> = {}): Promise<Board> {
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...extra });
    if (!result.ok) throw new Error(result.error.message);
    return (await getBoardById(h.db, result.value.boardId))!;
  }

  async function edit(board: Board, extra: Partial<CreateBoardInput>) {
    return updateBoard(h.deps, {
      ...fields, boardId: board.id, expectedMutationStamp: board.mutationStamp,
      commandId: h.ids.nextCommandId(), ...extra,
    });
  }

  it('stores a preset, quarter-hour usual time, and optional membership without changing legacy defaults', async () => {
    const legacy = await create();
    expect(legacy).toMatchObject({ ...noAnchor, usualTimeMinute: null, requiredInStack: true, kind: 'count' });
    const board = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' }, usualTimeMinute: 0, requiredInStack: false });
    expect(board).toMatchObject({ ...noAnchor, anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake', usualTimeMinute: 0, requiredInStack: false });
  });

  it.each(['before', 'after'] as const)('replaces targets consistently and preserves omitted values for a %s board anchor', async (relation) => {
    const target = await create();
    let board = await create({ anchor: { kind: 'board', relation, boardId: target.id }, usualTimeMinute: 1425, requiredInStack: false });
    expect(board).toMatchObject({ ...noAnchor, anchorKind: 'board', anchorRelation: relation, anchorBoardId: target.id });
    expect((await edit(board, { title: 'Renamed' })).ok).toBe(true);
    board = (await getBoardById(h.db, board.id))!;
    expect(board).toMatchObject({ title: 'Renamed', anchorBoardId: target.id, usualTimeMinute: 1425, requiredInStack: false });
    expect((await edit(board, { anchor: { kind: 'text', relation, text: '  finish work  ' } })).ok).toBe(true);
    board = (await getBoardById(h.db, board.id))!;
    expect(board).toMatchObject({ ...noAnchor, anchorKind: 'text', anchorRelation: relation, anchorText: 'finish work', usualTimeMinute: 1425, requiredInStack: false });
    expect((await edit(board, { anchor: null })).ok).toBe(true);
    board = (await getBoardById(h.db, board.id))!;
    expect(board).toMatchObject({ ...noAnchor, usualTimeMinute: 1425, requiredInStack: false });
    expect((await edit(board, { usualTimeMinute: null, requiredInStack: true })).ok).toBe(true);
    expect(await getBoardById(h.db, board.id)).toMatchObject({ ...noAnchor, usualTimeMinute: null, requiredInStack: true });
  });

  it('counts trimmed text in Unicode code points and retains all four preset names', async () => {
    const text = '𐐀'.repeat(80);
    expect(await create({ anchor: { kind: 'text', relation: 'after', text: ` ${text} ` } })).toMatchObject({ anchorText: text });
    for (const preset of ['wake', 'lunch', 'dinner', 'sleep'] as const) {
      expect(await create({ anchor: { kind: 'preset', relation: 'before', preset } })).toMatchObject({ anchorPreset: preset });
    }
  });

  const invalid: { extra: Record<string, unknown>; field: string }[] = [
    ...[0, [], 'wake', {}, { kind: 'unknown', relation: 'after' }, { kind: 'preset', relation: 'around', preset: 'wake' },
      { kind: 'preset', relation: 'after', preset: 'breakfast' }, { kind: 'preset', relation: 'after', preset: ['wake'] },
      { kind: 'preset', relation: 'after', preset: 'wake', text: 'extra' },
      { kind: 'board', relation: 'after', boardId: 'bad-id' }, { kind: 'board', relation: 'after', boardId: ['00000000-0000-4000-8000-000000000001'] },
      { kind: 'text', relation: 'after', text: 12 }, { kind: 'text', relation: 'after', text: '  ' },
      { kind: 'text', relation: 'after', text: '𐐀'.repeat(81) },
    ].map((anchor) => ({ extra: { anchor }, field: 'anchor' })),
    ...[-1, 1439, 1440, 16, 15.5, NaN, Infinity, -Infinity, '15', false].map((usualTimeMinute) => ({ extra: { usualTimeMinute }, field: 'usualTimeMinute' })),
    ...[0, 1, 'false', null].map((requiredInStack) => ({ extra: { requiredInStack }, field: 'requiredInStack' })),
  ];
  it.each(invalid)('rejects malformed input $extra without semantic writes', async ({ extra, field }) => {
    const before = await semanticSnapshot(h);
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...extra } as CreateBoardInput);
    expect(result).toMatchObject({ ok: false, error: { code: 'validation', field } });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it('rejects malformed update inputs without changing an existing anchor', async () => {
    const board = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'dinner' } });
    const before = await semanticSnapshot(h);
    expect(await edit(board, { anchor: { kind: 'board', relation: 'after', boardId: 'bad-id' as BoardId } }))
      .toMatchObject({ ok: false, error: { code: 'validation', field: 'anchor' } });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it('accepts chains, siblings, and archived targets while archive and restore preserve every edge', async () => {
    const root = await create({ anchor: { kind: 'preset', relation: 'before', preset: 'sleep' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root.id } });
    const sibling = await create({ anchor: { kind: 'board', relation: 'before', boardId: root.id } });
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child.id })).ok).toBe(true);
    const grandchild = await create({ anchor: { kind: 'board', relation: 'before', boardId: child.id } });
    expect(await getBoardById(h.db, grandchild.id)).toMatchObject({ anchorBoardId: child.id });
    expect((await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child.id })).ok).toBe(true);
    expect(await getBoardById(h.db, child.id)).toMatchObject({ anchorBoardId: root.id });
    expect(await getBoardById(h.db, sibling.id)).toMatchObject({ anchorBoardId: root.id });
  });

  it('rejects self and longer cycles before mutation evidence and permits clearing an edge', async () => {
    const a = await create();
    const b = await create({ anchor: { kind: 'board', relation: 'before', boardId: a.id } });
    const c = await create({ anchor: { kind: 'board', relation: 'after', boardId: b.id } });
    for (const target of [a, b, c]) {
      const before = await semanticSnapshot(h);
      expect(await edit(a, { anchor: { kind: 'board', relation: 'after', boardId: target.id } }))
        .toMatchObject({ ok: false, error: { code: 'validation', field: 'anchor' } });
      expect(await semanticSnapshot(h)).toEqual(before);
    }
    expect((await edit(b, { anchor: null })).ok).toBe(true);
    expect((await edit(a, { anchor: { kind: 'board', relation: 'after', boardId: c.id } })).ok).toBe(true);
  });

  it('serializes reciprocal edits and rejects the second edge against the newly committed graph', async () => {
    const a = await create();
    const b = await create();
    const results = await Promise.all([
      edit(a, { anchor: { kind: 'board', relation: 'before', boardId: b.id } }),
      edit(b, { anchor: { kind: 'board', relation: 'after', boardId: a.id } }),
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await getBoardById(h.db, b.id)).toMatchObject(noAnchor);
  });

  it('rejects stale and cyclic conversions without writes and never baselines a pending raw payload', async () => {
    const board = await create();
    const pendingId = h.ids.uuid() as CheckInId;
    await insertCheckIn(h.db, {
      id: pendingId, boardId: board.id, logicalDate: '2026-08-30' as LogicalDate,
      occurredAtUtc: h.clock.utcMs, timeZoneId: h.clock.zone, offsetMinutes: -240,
      amount: 7, note: 'pending note', source: 'sync', idempotencyKey: h.ids.nextCommandId(),
      createdAt: h.clock.utcMs, updatedAt: h.clock.utcMs, mutationStamp: '01788105600000-00000-legacy', deletedAt: null,
    });
    expect((await edit(board, { title: 'Fresh title' })).ok).toBe(true);
    const before = await semanticSnapshot(h);
    expect(await edit(board, { kind: 'daily', anchor: { kind: 'board', relation: 'after', boardId: board.id } }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await semanticSnapshot(h)).toEqual(before);
    const current = (await getBoardById(h.db, board.id))!;
    expect(await edit(current, { kind: 'daily', anchor: { kind: 'board', relation: 'after', boardId: board.id } }))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await semanticSnapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect((await edit(current, { kind: 'daily', anchor: { kind: 'preset', relation: 'after', preset: 'lunch' } })).ok).toBe(true);
    expect(await h.db.getAllAsync('SELECT kind FROM habit_actions')).toEqual([{ kind: 'policy' }]);
    expect(await getCheckInById(h.db, pendingId)).toBeNull();
    expect(await h.db.getFirstAsync('SELECT amount, note, occurred_at_utc FROM check_ins')).toEqual({ amount: 7, note: 'pending note', occurred_at_utc: h.clock.utcMs });
  });

  it.each(['cycle', 'missing', 'null'] as const)('rejects a malformed %s target chain without looping or writing', async (mode) => {
    const a = await create();
    const b = await create({ anchor: { kind: 'board', relation: 'after', boardId: a.id } });
    let targetId = mode === 'cycle' ? b.id : null;
    if (mode === 'missing') {
      const deleted = await create();
      await h.db.runAsync('UPDATE boards SET deleted_at = ? WHERE id = ?', [h.clock.utcMs, deleted.id]);
      targetId = deleted.id;
    }
    await h.db.runAsync("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?",
      [targetId, a.id]);
    const before = await semanticSnapshot(h);
    expect(await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board', relation: 'after', boardId: b.id } }))
      .toMatchObject({ ok: false, error: { code: 'validation', field: 'anchor' } });
    expect(await semanticSnapshot(h)).toEqual(before);
  });

  it('rejects tombstoned nodes even when a caller supplies them to the pure graph validator', async () => {
    const target = await create();
    expect(validateBoardAnchorGraph(null, target.id, [{ ...target, deletedAt: h.clock.utcMs }]))
      .toMatchObject({ ok: false, error: { code: 'validation', field: 'anchor' } });
  });

  it.each([false, true])('both creation paths reject a missing or deleted target before allocating ids (reminders: %s)', async (withReminders) => {
    const target = await create();
    await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: target.id });
    const scheduler = new FakeReminderScheduler();
    for (const boardId of [target.id, h.ids.uuid() as BoardId]) {
      const input = { ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board' as const, relation: 'after' as const, boardId } };
      const before = await semanticSnapshot(h);
      const ids = jest.spyOn(h.ids, 'uuid');
      const result = withReminders
        ? await createBoardWithReminders({ ...h.deps, scheduler }, { ...input, reminders: [{ weekdaysMask: 1, minuteOfDay: 540, enabled: true }] })
        : await createBoard(h.deps, input);
      expect(result).toMatchObject({ ok: false, error: { code: 'validation', field: 'anchor' } });
      expect(ids).not.toHaveBeenCalled();
      ids.mockRestore();
      expect(scheduler.pending.size).toBe(0);
      expect(await semanticSnapshot(h)).toEqual(before);
    }
  });

  it('validates against the committed graph after a reminder permission prompt finishes', async () => {
    const target = await create();
    const scheduler = new FakeReminderScheduler();
    scheduler.auth = 'undetermined';
    let finish!: () => void;
    let prompted!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { prompted = resolve; });
    jest.spyOn(scheduler, 'requestAuthorization').mockImplementation(async () => { prompted(); await waiting; return 'granted'; });
    const creation = createBoardWithReminders({ ...h.deps, scheduler }, {
      ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board', relation: 'after', boardId: target.id },
      reminders: [{ weekdaysMask: 1, minuteOfDay: 540, enabled: true }],
    });
    await started;
    expect((await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: target.id })).ok).toBe(true);
    const before = await semanticSnapshot(h);
    finish();
    expect(await creation).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await semanticSnapshot(h)).toEqual(before);
    expect(scheduler.pending.size).toBe(0);
  });

  it('replays acknowledged creation and update before invalid retry inputs or a deleted target are examined', async () => {
    const target = await create();
    const input: CreateBoardInput = { ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board', relation: 'before', boardId: target.id } };
    const first = await createBoard(h.deps, input);
    if (!first.ok) throw new Error(first.error.message);
    const board = (await getBoardById(h.db, first.value.boardId))!;
    const update = { ...input, commandId: h.ids.nextCommandId(), boardId: board.id, expectedMutationStamp: board.mutationStamp, title: 'changed' };
    const edited = await updateBoard(h.deps, update);
    expect(edited.ok).toBe(true);
    await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: target.id });
    const before = await semanticSnapshot(h);
    expect(await createBoard(h.deps, { ...input, title: '', requiredInStack: null as unknown as boolean })).toEqual(first);
    expect(await updateBoard(h.deps, { ...update, title: '', usualTimeMinute: Infinity })).toEqual(edited);
    expect(await semanticSnapshot(h)).toEqual(before);
  });
});
