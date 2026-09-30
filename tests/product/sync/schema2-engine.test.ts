import checkFixture from '@/core/automations/fixtures/check-coins.json';
import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import wireFixture from '../../../modules/habit-system-apple/tests/CloudKit/sync-records-v2.json';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { IMMUTABLE_FIELD_MAP } from '@/core/sync/immutable-records';
import { runSync } from '@/core/sync/engine';
import { toSyncRecord } from '@/core/sync/records';
import { toSchema2SyncRecord, type Schema2SyncRecord } from '@/core/sync/schema-2-records';
import type { SyncTransport } from '@/core/sync/transport';
import { createTestHarness, type TestHarness } from '../helpers/test-db';
import { createBoardForTest } from '../helpers/product-fixtures';

const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const parentId = source.boardId;

function fact(kind: keyof typeof IMMUTABLE_FIELD_MAP, value: HabitAction | CoinLedgerRow): Schema2SyncRecord {
  const domain = value as unknown as Record<string, unknown>;
  const raw = Object.fromEntries(Object.entries(IMMUTABLE_FIELD_MAP[kind]).map(([wire, key]) => [wire, domain[key]]));
  return toSchema2SyncRecord(kind, value.id, value.mutationStamp, raw);
}
function payload(version: 1 | 2, mutationStamp = source.mutationStamp): Schema2SyncRecord {
  const row = { id: source.checkInId!, board_id: parentId, logical_date: source.logicalDate,
    occurred_at_utc: null, time_zone_id: null, offset_minutes: null, amount: null,
    note: 'preserved source note', source: 'app', idempotency_key: source.checkInId!,
    created_at: source.createdAt, updated_at: source.createdAt, deleted_at: null };
  return version === 1 ? toSyncRecord('check_in', source.checkInId!, mutationStamp, row)
    : toSchema2SyncRecord('check_in', source.checkInId!, mutationStamp, row);
}
async function setup() {
  const h = await createTestHarness();
  await createBoardForTest({ ...h, deps: { ...h.deps, ids: { uuid: () => parentId } } }, { earnsCoins: true });
  expect(await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true })).toMatchObject({ ok: true });
  return h;
}
async function receive(h: TestHarness, records: Schema2SyncRecord[]) {
  const previous = await h.db.getFirstAsync<{ change_token: string | null }>('SELECT change_token FROM sync_state');
  const nextToken = String(Number(previous?.change_token ?? 0) + 1);
  const transport = { ensureZone: async () => {}, upload: async () => {},
    fetchChanges: async () => ({ records, nextToken, more: false }) } as unknown as SyncTransport;
  return runSync({ ...h.deps, transport, random: () => 0 });
}
async function economics(h: TestHarness) {
  return { actions: await h.db.getAllAsync<{ id: string; kind: string }>('SELECT id, kind FROM habit_actions ORDER BY id'),
    rows: await h.db.getAllAsync<{ id: string; delta: number; kind: string }>('SELECT id, delta, kind FROM coin_ledger ORDER BY id') };
}
async function union(h: TestHarness): Promise<Schema2SyncRecord[]> {
  const rawActions = await h.db.getAllAsync<Record<string, string | number | null>>('SELECT * FROM habit_actions ORDER BY id');
  const actions = rawActions.map(row => toSchema2SyncRecord('habit_action', row.id as string, row.mutation_stamp as string, row));
  const rows = await h.db.getAllAsync<Record<string, string | number | null>>('SELECT * FROM coin_ledger ORDER BY id');
  return [...actions, ...rows.map(row => toSchema2SyncRecord('ledger_entry', row.id as string, row.mutation_stamp as string, row))];
}

describe('schema 2 public sync pages', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await setup(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it.each([false, true])('intersects payload and accepted genuine action in either arrival order: %s', async actionFirst => {
    const first = actionFirst ? fact('habit_action', source) : payload(2);
    expect(await receive(h, [first])).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(await h.db.getAllAsync("SELECT * FROM habit_actions WHERE kind = 'baseline'")).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins WHERE state_suppressed = 0')).toEqual([]);
    expect(await receive(h, [actionFirst ? payload(2) : fact('habit_action', source)])).toMatchObject({ ok: true });
    expect((await economics(h)).rows).toEqual([{ id: award.id, kind: 'check', delta: 1 }]);
    expect(await h.db.getAllAsync('SELECT note FROM check_ins WHERE state_suppressed = 0')).toEqual([{ note: 'preserved source note' }]);
  });

  it.each([false, true])('same-page v1 compatibility precedes G regardless of wire order: %s', async reverse => {
    const records = [payload(1), fact('habit_action', source)];
    expect(await receive(h, reverse ? records.reverse() : records)).toMatchObject({ ok: true });
    const state = await economics(h);
    expect(state.actions.map(row => row.kind).sort()).toEqual(['baseline', 'check']);
    expect(state.rows).toEqual([]);
    expect(await h.db.getAllAsync('SELECT id FROM check_ins WHERE state_suppressed = 0')).toEqual([{ id: source.checkInId }]);
  });

  it('retains a same-page supplied award and corrects its baseline-superseded entitlement', async () => {
    expect(await receive(h, [fact('ledger_entry', award), payload(1), fact('habit_action', source)])).toMatchObject({ ok: true });
    expect((await economics(h)).rows).toEqual(expect.arrayContaining([
      { id: award.id, kind: 'check', delta: 1 }, expect.objectContaining({ kind: 'adjustment', delta: -1 }),
    ]));
    expect((await economics(h)).rows).toHaveLength(2);
    expect(await union(h)).toContainEqual(fact('ledger_entry', award));
  });

  it('never synthesizes legacy evidence after the genuine action was already accepted', async () => {
    expect(await receive(h, [fact('habit_action', source)])).toMatchObject({ ok: true });
    expect(await receive(h, [payload(1)])).toMatchObject({ ok: true });
    expect(await economics(h)).toEqual({ actions: [{ id: source.id, kind: 'check' }], rows: [{ id: award.id, kind: 'check', delta: 1 }] });
  });

  it('retains a committed v1 baseline when G arrives later', async () => {
    expect(await receive(h, [payload(1)])).toMatchObject({ ok: true });
    const before = await h.db.getAllAsync('SELECT * FROM habit_actions');
    expect(await receive(h, [fact('habit_action', source)])).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync("SELECT * FROM habit_actions WHERE kind = 'baseline'")).toEqual(before);
    expect((await economics(h)).actions.map(row => row.kind).sort()).toEqual(['baseline', 'check']);
    expect((await economics(h)).rows).toEqual([]);
  });

  it.each([false, true])('does not baseline a transient v1 payload superseded by v2 in one page: %s', async reverse => {
    const newer = payload(2, '01788825600000-00009-remote');
    const records = [payload(1), newer, fact('habit_action', source)];
    expect(await receive(h, reverse ? records.reverse() : records)).toMatchObject({ ok: true });
    expect(await economics(h)).toEqual({ actions: [{ id: source.id, kind: 'check' }], rows: [{ id: award.id, kind: 'check', delta: 1 }] });
    expect(await h.db.getFirstAsync('SELECT mutation_stamp FROM check_ins')).toEqual({ mutation_stamp: newer.mutationStamp });
  });

  it('converges the complete peer union after distinct v1-first and G-first histories', async () => {
    const other = await setup();
    try {
      await receive(h, [payload(1)]); await receive(h, [fact('habit_action', source)]);
      await receive(other, [fact('habit_action', source)]); await receive(other, [payload(1)]);
      expect((await economics(h)).rows).toHaveLength(0);
      expect((await economics(other)).rows).toEqual([{ id: award.id, kind: 'check', delta: 1 }]);
      const originalAward = fact('ledger_entry', award);
      for (let round = 0; round < 3; round++) {
        const left = await union(h); const right = await union(other);
        expect(await receive(h, right.reverse())).toMatchObject({ ok: true });
        expect(await receive(other, left)).toMatchObject({ ok: true });
      }
      expect(await union(h)).toEqual(await union(other));
      expect(await union(h)).toContainEqual(originalAward);
      expect((await economics(h)).actions).toHaveLength(2);
      expect((await economics(h)).rows).toHaveLength(2);
      expect((await economics(h)).rows.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
      const before = await union(h);
      expect(await receive(h, [])).toMatchObject({ ok: true, value: { applied: 0, localChanged: false } });
      expect(await union(h)).toEqual(before);
      expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
    } finally { await other.db.closeAsync(); }
  });

  it('keeps moved raw dates separate from historical earning and never revives a cleared note', async () => {
    await receive(h, [payload(2), fact('habit_action', source)]);
    const moved = payload(2, '01788825600000-00004-remote');
    moved.fields.logical_date = '2026-09-09';
    expect(await receive(h, [moved])).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync('SELECT * FROM check_ins WHERE state_suppressed = 0')).toEqual([]);
    expect((await economics(h)).rows).toEqual([{ id: award.id, kind: 'check', delta: 1 }]);
    const moveOut = checkFixture.cases[12].actions[0] as HabitAction;
    const moveIn: HabitAction = { ...source, id: '00000000-0000-4000-8000-000000009994' as HabitAction['id'],
      logicalDate: '2026-09-09' as HabitAction['logicalDate'], kind: 'move_in',
      mutationStamp: '01788825600000-00004-remote', createdAt: source.createdAt + 3 };
    expect(await receive(h, [fact('habit_action', moveIn), fact('habit_action', moveOut)])).toMatchObject({ ok: true });
    expect(await h.db.getFirstAsync('SELECT logical_date,state_suppressed FROM check_ins')).toEqual({ logical_date: '2026-09-09', state_suppressed: 0 });
    const removal: HabitAction = { ...moveIn, id: '00000000-0000-4000-8000-000000009995' as HabitAction['id'],
      kind: 'uncheck', mutationStamp: '01788825600000-00005-remote', createdAt: source.createdAt + 4 };
    await receive(h, [fact('habit_action', removal)]);
    const noteEdit = { ...moved, mutationStamp: '01788825600000-00006-remote', fields: { ...moved.fields, note: 'cleared private text' } };
    expect(await receive(h, [noteEdit])).toMatchObject({ ok: true });
    expect(await h.db.getFirstAsync('SELECT note,state_suppressed,mutation_stamp FROM check_ins')).toEqual({ note: 'cleared private text', state_suppressed: 1, mutation_stamp: noteEdit.mutationStamp });
    expect((await economics(h)).rows.map(row => row.delta).sort()).toEqual([-1, 1]);
    expect((await economics(h)).actions.some(row => row.kind === 'baseline')).toBe(false);
  });

  it.each([false, true])('resolves the original rootless bonus cause when its control arrives, even without raw parents: %s', async controlFirst => {
    const vector = bonusFixture.replayCases.find(item => item.name === 'control admits genuine rootless final check')!;
    const [control, member, final] = vector.actions as HabitAction[];
    const bonus = vector.expectedOrdinaryRows[0] as CoinLedgerRow;
    if (controlFirst) await receive(h, [fact('habit_action', control)]);
    expect(await receive(h, [fact('ledger_entry', bonus), fact('habit_action', final)]))
      .toMatchObject({ ok: true, value: { retryAfterMs: null } });
    if (!controlFirst) expect(await h.db.getAllAsync('SELECT fact_id,state FROM remote_fact_inbox')).toEqual([{ fact_id: bonus.id, state: 'pending' }]);
    expect(await receive(h, [fact('habit_action', member), fact('habit_action', control)])).toMatchObject({ ok: true });
    expect(await union(h)).toContainEqual(fact('ledger_entry', bonus));
    expect((await economics(h)).rows.reduce((sum, row) => sum + row.delta, 0)).toBe(3);
    expect(await h.db.getAllAsync('SELECT * FROM remote_fact_inbox')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    const before = await union(h);
    expect(await receive(h, [fact('ledger_entry', bonus), fact('habit_action', final)])).toMatchObject({ ok: true, value: { applied: 0, localChanged: false } });
    expect(await union(h)).toEqual(before);
  });

  it('accepts an immutable claim without its reward and without rechecking current affordability', async () => {
    const claim = wireFixture.find(record => record.entityType === 'ledger_entry' && record.fields.kind === 'claim')! as unknown as Schema2SyncRecord;
    expect(await receive(h, [claim])).toMatchObject({ ok: true, value: { applied: 1, status: 'up_to_date' } });
    expect(await h.db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    expect(await union(h)).toEqual([claim]);
    expect((await economics(h)).rows[0].delta).toBeLessThan(0);
    expect(await receive(h, [claim])).toMatchObject({ ok: true, value: { applied: 0, localChanged: false } });
    expect(await union(h)).toEqual([claim]);
  });
});
