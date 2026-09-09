import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baselineAction, foldDailyActions, foldActiveCheckInIds, validateHabitAction } from '@/core/domain/habit-actions';
import type { HabitAction } from '@/core/domain/habit-actions';
import { HABIT_SYSTEM_NAMESPACE, uuidV5 } from '@/core/domain/deterministic-ids';
import { appendHabitAction, listHabitActions } from '@/core/persistence/repositories/habit-actions';

import { createTestHarness } from '../helpers/test-db';

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../src/core/automations/fixtures/habit-actions.json'), 'utf8'));
const hashing = { sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()) };
const action = (overrides: Partial<HabitAction> = {}): HabitAction => ({
  id: '00000000-0000-4000-8000-000000000001',
  commandId: '00000000-0000-4000-8000-000000000002',
  boardId: fixture.baseline.source.boardId,
  logicalDate: fixture.baseline.source.logicalDate,
  checkInId: fixture.baseline.source.id,
  kind: 'check', createdAt: 1788825600000,
  mutationStamp: '01788825600000-00000-device', policyJson: null,
  ...overrides,
} as HabitAction);

describe('immutable habit evidence', () => {
  it('uses the shared fork namespace and Unicode UUIDv5 vectors', async () => {
    expect(HABIT_SYSTEM_NAMESPACE).toBe(fixture.namespace);
    for (const vector of fixture.uuidVectors) expect(await uuidV5(vector.name, hashing)).toBe(vector.id);
    await expect(uuidV5('invalid digest', { sha1: async () => new Uint8Array(4) })).rejects.toThrow('SHA-1');
  });

  it('derives the same baseline only from preserved identity and date', async () => {
    const baseline = await baselineAction(fixture.baseline.source, hashing);
    expect(baseline).toEqual(action({ id: fixture.baseline.id, commandId: null, kind: 'baseline',
      createdAt: fixture.baseline.createdAt, mutationStamp: fixture.baseline.mutationStamp }));
    expect(validateHabitAction(baseline).ok).toBe(true);
    const altered = { ...fixture.baseline.source, createdAt: 12, mutationStamp: 'changed', idempotencyKey: 'different' };
    expect(await baselineAction(altered, hashing)).toEqual(baseline);
    expect(validateHabitAction({ ...baseline, mutationStamp: '01788825600000-00000-device' }).ok).toBe(false);
    expect(validateHabitAction({ ...baseline, createdAt: 1 }).ok).toBe(false);
    expect(validateHabitAction(await baselineAction({ ...fixture.baseline.source, logicalDate: '0000-01-01' }, hashing)).ok).toBe(true);
  });

  it('matches shared native fold cases', () => {
    for (const vector of fixture.foldCases) {
      expect(foldDailyActions(vector.actions)).toEqual({ checked: vector.checked, checkInId: vector.checkInId });
    }
  });

  it('folds delivery order, selective deletion, whole-date uncheck, moves, and policy', async () => {
    const baseline = await baselineAction(fixture.baseline.source, hashing);
    const first = action();
    const second = action({ id: '00000000-0000-4000-8000-000000000003' as never, checkInId: '00000000-0000-4000-8000-00000000c002' as never });
    expect(foldDailyActions([])).toEqual({ checked: false, checkInId: null });
    expect(foldDailyActions([baseline])).toEqual({ checked: true, checkInId: baseline.checkInId });
    expect(foldDailyActions([second, first])).toEqual({ checked: true, checkInId: second.checkInId });
    expect(foldDailyActions([first, second])).toEqual(foldDailyActions([second, first]));
    const removal = action({ id: '00000000-0000-4000-8000-000000000004' as never, kind: 'uncheck', checkInId: second.checkInId, mutationStamp: '01788825600001-00000-device' });
    expect(foldDailyActions([removal, second, first])).toEqual({ checked: true, checkInId: first.checkInId });
    const clear = { ...removal, checkInId: null };
    expect(foldDailyActions([clear, baseline, first, second])).toEqual({ checked: false, checkInId: null });
    const moved = { ...second, kind: 'move_in' as const, mutationStamp: '01788825600002-00000-device' };
    expect(foldDailyActions([clear, moved])).toEqual({ checked: true, checkInId: moved.checkInId });
    expect(foldDailyActions([moved, { ...removal, kind: 'move_out', mutationStamp: '01788825600003-00000-device' }])).toEqual({ checked: false, checkInId: null });
    expect(foldDailyActions([first, action({ kind: 'policy', checkInId: null })])).toEqual({ checked: true, checkInId: first.checkInId });
    expect(foldDailyActions([first, first])).toEqual({ checked: true, checkInId: first.checkInId });
  });

  it('returns every survivor in final-add order across shuffled, frozen input and duplicate adds', () => {
    const first = action();
    const second = action({ id: '00000000-0000-4000-8000-000000000003' as never, checkInId: '00000000-0000-4000-8000-00000000c002' as never });
    const repeated = { ...first, id: '00000000-0000-4000-8000-000000000004' as HabitAction['id'], mutationStamp: '01788825600001-00000-device' };
    const moved = { ...second, id: '00000000-0000-4000-8000-000000000005' as HabitAction['id'], kind: 'move_out' as const, mutationStamp: '01788825600002-00000-device' };
    const frozen = Object.freeze([repeated, first, second]);
    expect(foldActiveCheckInIds(frozen)).toEqual([second.checkInId, first.checkInId]);
    expect(foldActiveCheckInIds([second, repeated, first])).toEqual([second.checkInId, first.checkInId]);
    expect(foldActiveCheckInIds([...frozen, moved])).toEqual([first.checkInId]);
    expect(frozen).toEqual([repeated, first, second]);
  });

  it.each([
    { id: ['00000000-0000-4000-8000-000000000001'] }, { boardId: [] }, { logicalDate: [] }, { kind: [] },
    { mutationStamp: [] }, { commandId: [] }, { checkInId: [] },
    { id: 'bad' }, { commandId: null }, { commandId: 'bad' }, { boardId: 'bad' },
    { logicalDate: '2026-02-30' }, { kind: 'unknown' }, { checkInId: null }, { checkInId: 'bad' },
    { createdAt: -1 }, { createdAt: 0.5 }, { mutationStamp: 'bad' }, { policyJson: '{}' },
    { kind: 'baseline', commandId: null }, { kind: 'policy', checkInId: fixture.baseline.source.id },
  ])('rejects malformed evidence %j before persistence', (invalid) => {
    expect(validateHabitAction(action(invalid as Partial<HabitAction>)).ok).toBe(false);
  });

  it('permits both date-wide and targeted unchecks', () => {
    expect(validateHabitAction(action({ kind: 'uncheck', checkInId: null })).ok).toBe(true);
    expect(validateHabitAction(action({ kind: 'uncheck' })).ok).toBe(true);
    expect(validateHabitAction(action({ kind: 'policy', checkInId: null })).ok).toBe(true);
  });

  it('appends once, refuses replacement, and prevents SQL update or deletion', async () => {
    const harness = await createTestHarness();
    try {
      const original = action();
      expect(await appendHabitAction(harness.db, original)).toBe(true);
      expect(await appendHabitAction(harness.db, original)).toBe(false);
      expect(await listHabitActions(harness.db, original.boardId, original.logicalDate)).toEqual([original]);
      expect(await listHabitActions(harness.db, original.boardId, '2026-09-07' as never)).toEqual([]);
      await expect(appendHabitAction(harness.db, { ...original, kind: 'uncheck' })).rejects.toThrow('Immutable');
      await expect(appendHabitAction(harness.db, { ...original, id: 'bad' as never })).rejects.toThrow('Invalid');
      await expect(harness.db.runAsync('UPDATE habit_actions SET kind = ?', ['policy'])).rejects.toThrow('immutable');
      await expect(harness.db.runAsync('DELETE FROM habit_actions')).rejects.toThrow('immutable');
      await expect(harness.db.runAsync(
        'INSERT OR REPLACE INTO habit_actions SELECT id, command_id, board_id, logical_date, check_in_id, kind, created_at + 1, mutation_stamp, policy_json FROM habit_actions'
      )).rejects.toThrow('immutable');
    } finally { await harness.db.closeAsync(); }
  });
});
