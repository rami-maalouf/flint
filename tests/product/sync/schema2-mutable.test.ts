import fixture from '../../../modules/habit-system-apple/tests/CloudKit/sync-records-v2.json';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import { runSync } from '@/core/sync/engine';
import type { WireSyncRecord, SyncTransport } from '@/core/sync/transport';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

function row(type: string, fields: Record<string, unknown> = {}): WireSyncRecord {
  const source = fixture.find(record => record.entityType === type && !record.deleted)!;
  return { ...source, fields: { ...source.fields, ...fields } } as unknown as WireSyncRecord;
}
async function receive(h: TestHarness, records: WireSyncRecord[]) {
  const transport: SyncTransport<WireSyncRecord> = { ensureZone: async () => {}, upload: async () => {},
    fetchChanges: async () => ({ records, nextToken: 'next', more: false }) };
  return runSync({ ...h.deps, transport, random: () => 0 });
}
let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness();
  await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true });
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

describe('schema 2 mutable closure', () => {
  it('commits a reversed forward chain in one page without rereading the entire deferred store', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`);
    const records = ids.map((id, index) => ({ ...row('board', {
      id, anchor_kind: index === ids.length - 1 ? 'preset' : 'board', anchor_preset: index === ids.length - 1 ? 'wake' : null,
      anchor_board_id: ids[index + 1] ?? null,
    }), entityId: id }));
    const reads: string[] = [];
    const original = h.db.getAllAsync.bind(h.db);
    jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) => { reads.push(sql); return original(sql, params); });
    expect(await receive(h, records)).toMatchObject({ ok: true, value: { applied: 12, status: 'up_to_date' } });
    expect(await h.db.getAllAsync('SELECT * FROM sync_deferred')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT id,anchor_board_id FROM boards ORDER BY id')).toEqual(ids.map((id, index) => ({ id, anchor_board_id: ids[index + 1] ?? null })));
    expect(reads.filter(sql => sql.includes('SELECT entity_type, entity_id, mutation_stamp, payload FROM sync_deferred'))).toHaveLength(2);
    // one captured closure read and one final status read; no depth-dependent full-store scans.
  });

  it('persists complete board/settings/reward values, retains local settings and never emits remote policy actions', async () => {
    const board = row('board'); const settings = row('settings', { wake_minute: 0, sleep_minute: 1425 }); const reward = row('reward');
    expect(await receive(h, [reward, settings, board])).toMatchObject({ ok: true, value: { applied: 3 } });
    expect(await h.db.getFirstAsync('SELECT kind,earns_coins,coin_cap_per_day,usual_time_minute,anchor_preset FROM boards')).toEqual({ kind: 'count', earns_coins: 1, coin_cap_per_day: 10, usual_time_minute: 0, anchor_preset: 'wake' });
    expect(await h.db.getFirstAsync('SELECT wake_minute,sleep_minute,icloud_sync_enabled FROM app_settings')).toEqual({ wake_minute: 0, sleep_minute: 1425, icloud_sync_enabled: 1 });
    expect(await h.db.getFirstAsync('SELECT title,cost_coins,mutation_stamp FROM rewards')).toEqual({ title: reward.fields.title, cost_coins: reward.fields.cost_coins, mutation_stamp: reward.mutationStamp });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
  });

  it.each([false, true])('wakes only the newest retained child version after its parent arrives: %s', async reverse => {
    const parent = row('board'); const id = '00000000-0000-4000-8000-000000009900';
    const older = { ...row('board', { id, title: 'older', anchor_kind: 'board', anchor_preset: null, anchor_board_id: parent.entityId }), entityId: id };
    const newer = { ...older, mutationStamp: '01787572800002-00002-remote', fields: { ...older.fields, title: 'newer' } };
    const children = reverse ? [newer, older] : [older, newer];
    expect(await receive(h, [...children, parent])).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 2 } });
    expect(await h.db.getFirstAsync('SELECT title,mutation_stamp FROM boards WHERE id = ?', [id])).toEqual({ title: 'newer', mutation_stamp: newer.mutationStamp });
    expect(await h.db.getAllAsync('SELECT * FROM sync_deferred')).toEqual([]);
  });

  it('retains the exact empty reversed period until a missing parent arrives on a later page', async () => {
    const period = row('activity_period', { start_date: '2026-09-09', end_date: '2026-09-08' });
    period.entityId = `${period.fields.board_id}|2026-09-09`;
    expect(await receive(h, [period])).toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0, localChanged: true } });
    expect(await h.db.getAllAsync('SELECT * FROM board_activity_periods')).toEqual([]);
    expect(await receive(h, [row('board')])).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 2 } });
    expect(await h.db.getFirstAsync('SELECT start_date,end_date,mutation_stamp FROM board_activity_periods')).toEqual({ start_date: '2026-09-09', end_date: '2026-09-08', mutation_stamp: period.mutationStamp });
    expect(await h.db.getAllAsync('SELECT * FROM sync_deferred')).toEqual([]);
  });
});
