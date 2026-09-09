import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from '@/core/domain/ids';
import { prepareRemoteFact, type PreparedRemoteFact } from '@/core/domain/remote-fact-validation';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import type { SqlExecutor } from '@/core/persistence/database';
import { applyRemoteFactInboxChanges, readRemoteFactInbox, readRemoteFactInboxCounts,
  type RemoteFactInboxDisposition } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHarness, createTestHashing, NodeSqlDatabase, TestIds, type TestHarness } from '../helpers/test-db';

const date = '2026-09-08' as LogicalDate;
const id = 'AAAAAAAA-0000-4000-8000-000000000001' as HabitActionId;
const boardId = '00000000-0000-4000-8000-000000000002' as BoardId;
const action: HabitAction = { id, boardId, logicalDate: date,
  checkInId: '00000000-0000-4000-8000-000000000003' as CheckInId,
  commandId: '00000000-0000-4000-8000-000000000004' as CommandId,
  kind: 'check', createdAt: 1, mutationStamp: '00000000000001-00000-source', policyJson: null };
const pending: RemoteFactInboxDisposition = { state: 'pending', reason: 'dependency' };
const invalid: RemoteFactInboxDisposition = { state: 'quarantined', reason: 'invalid' };
const blocked: RemoteFactInboxDisposition = { state: 'blocked_capacity', reason: 'scope_capacity' };
const hashing = createTestHashing();
const prepare = (value: unknown = action, factId = id) => prepareRemoteFact({ factType: 'habit_action',
  factId, value, enqueueOnAdmission: false }, hashing);
const key = (fact: PreparedRemoteFact) => ({ factType: fact.factType, factId: fact.factId, payloadDigest: fact.payloadDigest });

describe('bounded immutable inbox storage', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('retains duplicates, separate conflicting variants, and distinct binary identities without accepted writes', async () => {
    const first = await prepare();
    const variant = await prepare({ ...action, createdAt: 2 });
    const lower = await prepare({ ...action, id: id.toLowerCase() }, id.toLowerCase() as HabitActionId);
    const result = await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [first, first, variant, lower].map(prepared => ({ prepared, disposition: pending })), removals: [] }, 10));
    expect(result).toEqual({ localChanged: true, counts: { variants: 3,
      payloadBytes: first.payloadBytes + variant.payloadBytes + lower.payloadBytes, pending: 3, blocked: 0, quarantined: 0 } });
    const rows = await readRemoteFactInbox(h.db, [{ factType: 'habit_action', factId: id }]);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.payload).sort()).toEqual([first.payload, variant.payload].sort());
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('ORs restore intent, preserves first-seen time and reports only durable changes', async () => {
    const prepared = await prepare();
    const apply = (enqueueOnAdmission: boolean, now: number, disposition: RemoteFactInboxDisposition = pending) =>
      h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx, { removals: [],
        upserts: [{ prepared: { ...prepared, enqueueOnAdmission }, disposition }] }, now));
    await apply(false, 10);
    expect((await apply(false, 20)).localChanged).toBe(false);
    expect((await apply(true, 30)).localChanged).toBe(true);
    expect((await apply(false, 40)).localChanged).toBe(false);
    expect((await apply(false, 50, blocked)).localChanged).toBe(true);
    expect(await readRemoteFactInbox(h.db)).toEqual([expect.objectContaining({ firstSeenAt: 10,
      enqueueOnAdmission: true, state: 'blocked_capacity', reason: 'scope_capacity', payload: prepared.payload })]);
    expect(await readRemoteFactInboxCounts(h.db)).toMatchObject({ pending: 0, blocked: 1 });
  });

  it('separates retryable rows from quarantined diagnostics while keeping targeted variants readable', async () => {
    const rejected = await prepare({ ...action, policyJson: 'bad' });
    await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [{ prepared: rejected, disposition: invalid }], removals: [] }, 0));
    expect(await readRemoteFactInbox(h.db)).toEqual([]);
    expect(await readRemoteFactInbox(h.db, [])).toEqual([]);
    expect(await readRemoteFactInbox(h.db, [key(rejected), key(rejected)]))
      .toEqual([expect.objectContaining({ payload: rejected.payload, state: 'quarantined', firstSeenAt: 0 })]);
    expect(await readRemoteFactInboxCounts(h.db)).toEqual({ variants: 1, payloadBytes: rejected.payloadBytes,
      pending: 0, blocked: 0, quarantined: 1 });
  });

  it('compares payload bytes on a digest hit even when the old variant is proposed for removal', async () => {
    const original = await prepare();
    const changed = { ...await prepare({ ...action, createdAt: 2 }), payloadDigest: original.payloadDigest };
    await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [{ prepared: original, disposition: pending }], removals: [] }, 1));
    await expect(h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [{ prepared: changed, disposition: pending }], removals: [key(original)] }, 2)))
      .rejects.toMatchObject({ reason: 'integrity' });
    expect(await readRemoteFactInbox(h.db)).toEqual([expect.objectContaining({ payload: original.payload, firstSeenAt: 1 })]);
  });

  it('rolls back earlier inbox changes and caller work when a later storage write fails', async () => {
    const first = await prepare();
    const second = await prepare({ ...action, createdAt: 2 });
    await h.db.execAsync(`CREATE TABLE caller_cursor (value TEXT);
      CREATE TRIGGER fail_second_inbox BEFORE INSERT ON remote_fact_inbox
      WHEN NEW.payload_digest = '${second.payloadDigest}' BEGIN SELECT RAISE(FAIL, 'inbox disk failure'); END;`);
    await expect(h.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('INSERT INTO caller_cursor VALUES (?)', ['advanced']);
      return applyRemoteFactInboxChanges(tx, { upserts: [first, second].map(prepared => ({ prepared, disposition: pending })),
        removals: [] }, 1);
    })).rejects.toThrow('inbox disk failure');
    expect(await readRemoteFactInbox(h.db)).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM caller_cursor')).toEqual([]);
  });

  it('keeps deferred import intent and exact diagnostics through a real database restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'habit-inbox-'));
    const path = join(directory, 'db.sqlite');
    let db = new NodeSqlDatabase(path);
    try {
      expect((await initializeProductDatabase(db, new TestIds(), hashing)).ok).toBe(true);
      const prepared = { ...await prepare({ ...action, policyJson: 'not canonical' }), enqueueOnAdmission: true };
      await db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
        { upserts: [{ prepared, disposition: invalid }], removals: [] }, 123));
      await db.closeAsync();
      db = new NodeSqlDatabase(path);
      expect(await readRemoteFactInbox(db, [key(prepared)])).toEqual([expect.objectContaining({
        payload: prepared.payload, payloadDigest: prepared.payloadDigest, enqueueOnAdmission: true, firstSeenAt: 123 })]);
    } finally { await db.closeAsync(); rmSync(directory, { recursive: true, force: true }); }
  });

  async function seedOccupancy(count: number, payload: string) {
    await h.db.runAsync(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO remote_fact_inbox (fact_type, fact_id, payload_digest, payload_encoding, payload,
        payload_bytes, logical_date, scope_key, state, reason, enqueue_on_admission, first_seen_at)
      SELECT 'habit_action', printf('00000000-0000-4000-8000-%012x', n), ?, 'rejected_json_v1', ?,
        ?, NULL, NULL, 'quarantined', 'invalid', 0, 1 FROM numbers`,
    [count, '0'.repeat(64), payload, Buffer.byteLength(payload)]);
  }

  it('accepts exactly 32768 variants, makes duplicates free, and rolls back an over-limit caller cursor', async () => {
    await seedOccupancy(32767, 'null');
    const prepared = await prepare();
    const upsert = { prepared, disposition: pending };
    expect((await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [upsert], removals: [] }, 1))).counts.variants).toBe(32768);
    expect((await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [upsert, upsert], removals: [] }, 2))).localChanged).toBe(false);
    const extra = await prepare({ ...action, createdAt: 2 });
    await h.db.execAsync('CREATE TABLE limit_cursor (value TEXT)');
    await expect(h.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('INSERT INTO limit_cursor VALUES (?)', ['next page']);
      return applyRemoteFactInboxChanges(tx, { upserts: [{ prepared: extra, disposition: pending }], removals: [] }, 3);
    })).rejects.toMatchObject({ reason: 'capacity' });
    expect(await h.db.getAllAsync('SELECT * FROM limit_cursor')).toEqual([]);
    expect((await readRemoteFactInboxCounts(h.db)).variants).toBe(32768);
    const removed = { factType: 'habit_action' as const, factId: '00000000-0000-4000-8000-000000000001', payloadDigest: '0'.repeat(64) };
    const result = await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [{ prepared: extra, disposition: pending }], removals: [removed, removed] }, 4));
    expect(result).toMatchObject({ localChanged: true, counts: { variants: 32768, pending: 2, quarantined: 32766 } });
    expect(await readRemoteFactInbox(h.db, [removed])).toEqual([]);
  });

  it('counts UTF-8 bytes at exactly 64 MiB and applies same-transaction removals before checking capacity', async () => {
    const payload = JSON.stringify('é'.repeat(393215));
    expect(Buffer.byteLength(payload)).toBe(786432);
    await seedOccupancy(85, payload);
    const final = await prepare('é'.repeat(131071));
    expect(final.payloadBytes).toBe(262144);
    const apply = (upserts: { prepared: PreparedRemoteFact; disposition: RemoteFactInboxDisposition }[], removals: ReturnType<typeof key>[] = []) =>
      h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx, { upserts, removals }, 2));
    expect((await apply([{ prepared: final, disposition: invalid }])).counts.payloadBytes).toBe(67108864);
    const extra = await prepare(0);
    await expect(apply([{ prepared: extra, disposition: invalid }])).rejects.toMatchObject({ reason: 'capacity' });
    expect((await readRemoteFactInboxCounts(h.db)).payloadBytes).toBe(67108864);
    expect(await apply([{ prepared: extra, disposition: invalid }], [key(final)]))
      .toMatchObject({ localChanged: true, counts: { variants: 86, payloadBytes: 85 * 786432 + 1 } });
  });

  it('keeps empty drains and nonexistent removals unchanged and rejects invalid acquired time before writes', async () => {
    const missing = key(await prepare());
    expect(await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [], removals: [missing] }, 0))).toEqual({ localChanged: false,
      counts: { variants: 0, payloadBytes: 0, pending: 0, blocked: 0, quarantined: 0 } });
    for (const now of [-1, -0, 0.5, NaN, Infinity]) {
      await expect(applyRemoteFactInboxChanges(h.db, { upserts: [], removals: [] }, now))
        .rejects.toMatchObject({ reason: 'envelope' });
    }
  });

  it('does not allow diagnostic bytes to be promoted back into a retryable economic candidate', async () => {
    const prepared = await prepare(null);
    for (const disposition of [pending, { state: 'quarantined', reason: 'conflict' } as const]) {
      await expect(h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
        { upserts: [{ prepared, disposition }], removals: [] }, 0))).rejects.toMatchObject({ reason: 'integrity' });
    }
    expect((await readRemoteFactInboxCounts(h.db)).variants).toBe(0);
  });

  it('sends only unique typed identities to SQLite even when the caller supplies full prepared records', async () => {
    const prepared = await prepare();
    const read = jest.spyOn(h.db, 'getAllAsync');
    try {
      await readRemoteFactInbox(h.db, [prepared, prepared]);
      expect(read.mock.calls[0][1]).toEqual([JSON.stringify([{ factType: prepared.factType, factId: prepared.factId }])]);
    } finally { read.mockRestore(); }
  });

  it.each(['9007199254740992', '-1', 'bad'])('fails closed for an invalid storage aggregate %s', async (payloadBytes) => {
    const getFirstAsync = async () => ({ variants: '0', payloadBytes, pending: '0', blocked: '0', quarantined: '0' });
    await expect(readRemoteFactInboxCounts({ getFirstAsync } as unknown as SqlExecutor))
      .rejects.toMatchObject({ reason: 'integrity' });
  });
});
