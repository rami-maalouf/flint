import fixtures from '../../../modules/habit-system-apple/tests/CloudKit/sync-records-v2.json';
import { immutableSyncCandidate } from '@/core/sync/immutable-records';
import { schema2SpecFor, toSchema2SyncRecord, type Schema2SyncEntityType } from '@/core/sync/schema-2-records';
import { prepareRemoteFacts } from '@/core/domain/remote-fact-validation';

import { createTestHarness } from '../helpers/test-db';

describe('schema-2 outbound record allowlists', () => {
  it.each(fixtures)('matches the paired native $entityType fixture at $mutationStamp', fixture => {
    expect(toSchema2SyncRecord(fixture.entityType as Schema2SyncEntityType,
      fixture.entityId, fixture.mutationStamp, fixture.fields)).toEqual(fixture);
  });

  it('keeps all device-local and unrelated database fields outside every outgoing record', () => {
    for (const fixture of fixtures) {
      const record = toSchema2SyncRecord(fixture.entityType as Schema2SyncEntityType,
        fixture.entityId, fixture.mutationStamp, { ...fixture.fields,
          state_suppressed: 1, remote_fact_inbox: 'private', native_identifier: 'private',
          device_id: 'private', selected_icon: 'private', i_cloud_sync_enabled: 1 });
      expect(record).toEqual(fixture);
      expect(Object.keys(record.fields)).toEqual(schema2SpecFor(record.entityType).columns);
    }
  });

  it('strips board and reward tombstones using valid neutral values', () => {
    for (const fixture of fixtures.filter(row => row.deleted && ['board', 'reward'].includes(row.entityType))) {
      expect(toSchema2SyncRecord(fixture.entityType as Schema2SyncEntityType,
        fixture.entityId, fixture.mutationStamp, { ...fixture.fields, title: 'private',
          symbol: 'star.fill', accent_hex: '#123456', archived_at: 2,
          kind: 'daily', anchor_relation: 'after', anchor_kind: 'text', anchor_text: 'private',
          anchor_preset: 'wake', anchor_board_id: fixture.entityId, usual_time_minute: 0,
          required_in_stack: 1, earns_coins: 1, coin_cap_per_day: 10, cost_coins: 100 })).toEqual(fixture);
    }
  });

  it('preserves genuine immutable fixtures through outbound mapping and admission preparation', async () => {
    const h = await createTestHarness();
    try {
      const rows = fixtures.filter(row => ['habit_action', 'ledger_entry'].includes(row.entityType));
      const candidates = rows.map(row => immutableSyncCandidate(toSchema2SyncRecord(
        row.entityType as Schema2SyncEntityType, row.entityId, row.mutationStamp, row.fields)));
      const prepared = await prepareRemoteFacts(candidates, h.deps.hashing);
      expect(prepared).toHaveLength(3);
      expect(prepared.every(row => row.fact !== null && row.payloadEncoding === 'canonical_v1')).toBe(true);
      expect((prepared[2].fact!.value as { rewardTitleSnapshot: string }).rewardTitleSnapshot).toBe('Cafe\u0301');
    } finally { await h.db.closeAsync(); }
  });

  it('fails before upload when a required new field is missing instead of inventing legacy defaults', () => {
    for (const [entityType, field] of [['board', 'kind'], ['settings', 'wake_minute'],
      ['reward', 'cost_coins'], ['habit_action', 'policy_json'], ['ledger_entry', 'deleted_at']] as const) {
      const fixture = fixtures.find(row => row.entityType === entityType)!;
      const fields: Record<string, string | number | null | undefined> = { ...fixture.fields };
      delete fields[field];
      expect(() => toSchema2SyncRecord(entityType, fixture.entityId, fixture.mutationStamp,
        fields as Record<string, string | number | null>)).toThrow();
    }
  });

  it('refuses tombstoning immutable evidence', () => {
    for (const fixture of fixtures.filter(row => ['habit_action', 'ledger_entry'].includes(row.entityType))) {
      expect(() => toSchema2SyncRecord(fixture.entityType as Schema2SyncEntityType,
        fixture.entityId, fixture.mutationStamp, { ...fixture.fields, deleted_at: 1 })).toThrow();
    }
  });
});
