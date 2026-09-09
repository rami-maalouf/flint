import { createCheckIn, removeLatestCheckIn, setICloudSyncEnabled } from '@/core/domain/commands';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import { getCheckInById, listBoardCheckIns } from '@/core/persistence/repositories/check-ins';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { runSync, type SyncDeps } from '@/core/sync/engine';
import { toSyncRecord } from '@/core/sync/records';
import type { SyncRecord } from '@/core/sync/transport';
import { FakeSyncTransport } from '../helpers/fake-transport';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const date = '2026-08-30' as LogicalDate;
function raw(id: string, boardId: BoardId, stamp = '01788105600000-00001-remote', logicalDate = date): SyncRecord {
  return { schemaVersion: 1, entityType: 'check_in', entityId: id, mutationStamp: stamp, deleted: false,
    fields: { id, board_id: boardId, logical_date: logicalDate, occurred_at_utc: null, time_zone_id: null,
      offset_minutes: null, amount: null, note: 'legacy note', source: 'sync', idempotency_key: id,
      created_at: 0, updated_at: 0, deleted_at: null } };
}

describe('version-one applied check authority', () => {
  let h: TestHarness; let transport: FakeSyncTransport; let deps: SyncDeps;
  beforeEach(async () => {
    h = await createTestHarness(); transport = new FakeSyncTransport();
    await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true });
    deps = { ...h.deps, transport, random: () => 0.5 };
  });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it('admits only applied v1 rows and never synthesizes evidence for an ignored old date', async () => {
    const id = await createBoardForTest(h); const checkId = h.ids.uuid() as CheckInId;
    transport.seedRemote(raw(checkId, id));
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(await getCheckInById(h.db, checkId)).toMatchObject({ logicalDate: date, note: 'legacy note' });
    const actions = await listHabitActions(h.db, id, date);
    expect(actions).toMatchObject([{ kind: 'baseline', createdAt: 0, policyJson: null, commandId: null }]);
    transport.seedRemote(raw(checkId, id, '00000000000001-00000-old', '2026-08-29' as LogicalDate));
    await runSync(deps);
    expect(await listHabitActions(h.db, id, date)).toEqual(actions);
    expect(await listHabitActions(h.db, id, '2026-08-29' as LogicalDate)).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    const tombstone = raw(checkId, id, '01788105600000-00009-remote'); tombstone.deleted = true; tombstone.fields.deleted_at = 1;
    transport.seedRemote(tombstone); await runSync(deps);
    expect(await h.db.getFirstAsync('SELECT logical_date, state_suppressed FROM check_ins WHERE id = ?', [checkId])).toEqual({ logical_date: '', state_suppressed: 1 });
  });

  it('preserves v1 authority across deferral until the parent arrives', async () => {
    const id = h.ids.uuid() as BoardId; const checkId = h.ids.uuid() as CheckInId;
    transport.seedRemote(raw(checkId, id));
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'needs_attention' } });
    expect(await listHabitActions(h.db, id, date)).toEqual([]);
    const sourceId = await createBoardForTest(h);
    const source = (await h.db.getFirstAsync<Record<string,string|number|null>>('SELECT * FROM boards WHERE id = ?', [sourceId]))!;
    transport.seedRemote(toSyncRecord('board', id, '01788105600000-00002-remote', { ...source, id }));
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(await getCheckInById(h.db, checkId)).not.toBeNull();
    expect(await listHabitActions(h.db, id, date)).toHaveLength(1);
    expect(await h.db.getAllAsync('SELECT * FROM sync_deferred')).toEqual([]);
  });

  it('does not resurrect cleared state from a later live note or blank-date tombstone', async () => {
    const id = await createBoardForTest(h, { kind: 'daily' });
    const made = await createCheckIn(h.deps, { boardId: id, commandId: h.ids.nextCommandId(), source: 'app' });
    if (!made.ok) throw new Error(made.error.message);
    const checkId = made.value.checkInId;
    await removeLatestCheckIn(h.deps, { boardId: id, commandId: h.ids.nextCommandId() });
    transport.seedRemote(raw(checkId, id, '99999999999990-00000-remote'));
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(await listBoardCheckIns(h.db, id)).toEqual([]);
    expect((await listHabitActions(h.db,id,date)).filter(a => a.kind==='baseline')).toEqual([]);
    const tombstone=raw(checkId,id,'99999999999991-00000-remote');tombstone.deleted=true;
    tombstone.fields={ id:checkId, board_id:id, logical_date:'', source:'sync', idempotency_key:checkId, created_at:0, updated_at:0, deleted_at:1 };
    transport.seedRemote(tombstone);await runSync(deps);
    expect(await h.db.getFirstAsync('SELECT logical_date,deleted_at,state_suppressed FROM check_ins WHERE id = ?', [checkId])).toEqual({ logical_date:'',deleted_at:1,state_suppressed:1 });
  });
  it('applies explicit legacy authority on an empty page after a locally created parent resolves deferral', async () => {
    const id = '00000000-0000-4000-8000-000000008001' as BoardId; const checkId = h.ids.uuid() as CheckInId;
    transport.seedRemote(raw(checkId, id));
    await runSync(deps);
    const localId = await createBoardForTest(h);
    const parent = (await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM boards WHERE id = ?', [localId]))!;
    const columns = Object.keys(parent);
    await h.db.runAsync(`INSERT INTO boards (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(key => key === 'id' ? id : parent[key]));
    jest.spyOn(transport, 'fetchChanges').mockResolvedValue({ records: [], nextToken: 'empty-resolved', more: false });
    h.clock.utcMs += 1234;
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { applied: 1, status: 'up_to_date' } });
    expect(await getCheckInById(h.db, checkId)).not.toBeNull();
    expect(await h.db.getAllAsync('SELECT * FROM sync_deferred')).toEqual([]);
    const baseline = (await listHabitActions(h.db, id, date))[0];
    expect(await h.db.getFirstAsync('SELECT created_at FROM mutation_outbox WHERE entity_id = ?', [baseline.id])).toEqual({ created_at: h.clock.utcMs });
    expect(baseline.createdAt).toBe(0);
  });

  it.each(['baseline', 'outbox', 'correction', 'visibility'])('keeps v1 mixed-award admission atomic when %s fails and retries the same page', async stage => {
    const id = await createBoardForTest(h, { kind: 'daily', earnsCoins: true, coinCapPerDay: 10 });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' })).toMatchObject({ ok: true });
    await runSync(deps);
    const token = await h.db.getFirstAsync('SELECT change_token FROM sync_state');
    const tables = ['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'mutation_outbox', 'command_receipts', 'app_settings', 'widget_board_rows', 'sync_deferred'];
    const snapshot = () => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));
    const before = await snapshot(); const originalLedger = await h.db.getAllAsync<{ id: string; delta: number }>('SELECT * FROM coin_ledger ORDER BY id');
    expect(originalLedger).toHaveLength(1); expect(originalLedger[0].delta).toBe(1);
    const checkId = h.ids.uuid() as CheckInId;
    transport.seedRemote(raw(checkId, id, '01788192000000-00000-remote'));
    const run = h.db.runAsync.bind(h.db);
    const fail = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      if ((stage === 'baseline' && sql.includes('INSERT INTO habit_actions')) ||
          (stage === 'outbox' && sql.includes('INSERT INTO mutation_outbox')) ||
          (stage === 'correction' && sql.includes('INSERT INTO coin_ledger')) ||
          (stage === 'visibility' && sql.startsWith('UPDATE check_ins SET state_suppressed'))) throw new Error('injected admission failure');
      return run(sql, params);
    });
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0 } });
    expect(await snapshot()).toEqual(before);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual(token);
    fail.mockRestore();
    expect(await runSync(deps)).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 1 } });
    expect(await listBoardCheckIns(h.db, id)).toHaveLength(2);
    const ledger = await h.db.getAllAsync<{ id: string; delta: number; kind: string }>('SELECT * FROM coin_ledger ORDER BY id');
    expect(ledger.find(row => row.id === originalLedger[0].id)).toEqual(originalLedger[0]);
    expect(ledger.filter(row => row.id !== originalLedger[0].id)).toMatchObject([{ kind: 'adjustment', delta: -1 }]);
    expect((await listHabitActions(h.db, id, date)).filter(a => a.kind === 'baseline')).toHaveLength(1);
    await runSync(deps);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(ledger);
    expect(transport.uploads.flat().filter(row => row.entityType === 'check_in').every(row => !('state_suppressed' in row.fields))).toBe(true);
  });

});
