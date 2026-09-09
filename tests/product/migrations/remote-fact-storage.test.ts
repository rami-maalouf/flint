import { Buffer } from 'node:buffer';

import type { SqlValue } from '@/core/persistence/database';
import { toSyncRecord } from '@/core/sync/records';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const factId = 'abcdefab-1234-5000-8000-abcdef123456';
const digest = 'a'.repeat(64);
const row = {
  fact_type: 'habit_action', fact_id: factId, payload_digest: digest,
  payload_encoding: 'canonical_v1', payload: '[]', payload_bytes: 2,
  logical_date: null, scope_key: null, state: 'pending', reason: 'dependency', first_seen_at: 0,
};

async function insert(h: TestHarness, overrides: Record<string, SqlValue> = {}) {
  const values = { ...row, ...overrides };
  await h.db.runAsync(`INSERT INTO remote_fact_inbox (${Object.keys(values).join(', ')})
    VALUES (${Object.keys(values).map(() => '?').join(', ')})`, Object.values(values));
}

describe('remote fact inbox database constraints', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('measures exact UTF-8 bytes, including multibyte text and embedded nulls', async () => {
    const payload = 'café 漢\u0000z';
    const bytes = Buffer.byteLength(payload, 'utf8');
    expect(bytes).toBeGreaterThan(payload.length);
    await insert(h, { payload, payload_bytes: bytes });
    expect(await h.db.getFirstAsync('SELECT payload, payload_bytes, enqueue_on_admission FROM remote_fact_inbox'))
      .toEqual({ payload, payload_bytes: bytes, enqueue_on_admission: 0 });
    await expect(h.db.runAsync('UPDATE remote_fact_inbox SET payload_bytes = ?', [payload.length]))
      .rejects.toThrow('CHECK constraint failed');
    await expect(h.db.runAsync('UPDATE remote_fact_inbox SET payload = ?', [`${payload}x`]))
      .rejects.toThrow('CHECK constraint failed');
    expect(await h.db.getFirstAsync('SELECT payload, payload_bytes FROM remote_fact_inbox')).toEqual({ payload, payload_bytes: bytes });
  });

  it('accepts exactly 786432 payload bytes and rejects one more, empty payloads, or noninteger counts', async () => {
    const payload = 'x'.repeat(786432);
    await insert(h, { payload, payload_bytes: 786432 });
    expect(await h.db.getFirstAsync('SELECT length(CAST(payload AS BLOB)) AS bytes FROM remote_fact_inbox'))
      .toEqual({ bytes: 786432 });
    await h.db.runAsync('DELETE FROM remote_fact_inbox');
    for (const [payload, bytes] of [['x'.repeat(786433), 786433], ['', 0], ['', 1], ['x', 1.5], ['x', 'invalid']] as const) {
      await expect(insert(h, { payload, payload_bytes: bytes })).rejects.toThrow('CHECK constraint failed');
    }
    expect(await h.db.getAllAsync('SELECT * FROM remote_fact_inbox')).toEqual([]);
  });

  it.each([
    ['pending', 'dependency'], ['blocked_capacity', 'scope_capacity'],
    ['quarantined', 'invalid'], ['quarantined', 'conflict'],
  ])('retains the supported %s/%s state and reason pair without a live parent', async (state, reason) => {
    await insert(h, { state, reason, payload_encoding: state === 'quarantined' ? 'rejected_json_v1' : 'canonical_v1',
      logical_date: '2026-09-08', scope_key: `check:${factId}:2026-09-08` });
    expect(await h.db.getFirstAsync('SELECT state, reason FROM remote_fact_inbox')).toEqual({ state, reason });
    expect(await h.db.getAllAsync('PRAGMA foreign_key_list(remote_fact_inbox)')).toEqual([]);
  });

  it('rejects unsupported or mismatched state/reason pairs and missing required state', async () => {
    for (const state of ['pending', 'blocked_capacity', 'quarantined', 'accepted']) {
      for (const reason of ['dependency', 'scope_capacity', 'invalid', 'conflict', 'unknown']) {
        const valid = state === 'pending' && reason === 'dependency'
          || state === 'blocked_capacity' && reason === 'scope_capacity'
          || state === 'quarantined' && ['invalid', 'conflict'].includes(reason);
        if (!valid) await expect(insert(h, { state, reason })).rejects.toThrow('CHECK constraint failed');
      }
    }
    await expect(insert(h, { state: null })).rejects.toThrow('NOT NULL constraint failed');
    await expect(insert(h, { reason: null })).rejects.toThrow('NOT NULL constraint failed');
    expect(await h.db.getAllAsync('SELECT * FROM remote_fact_inbox')).toEqual([]);
  });

  it('rejects unsupported fact types, encodings, and non-lowercase or malformed digests', async () => {
    const rejected: Record<string, SqlValue>[] = [
      { fact_type: 'check_in' }, { fact_type: 'reward' }, { payload_encoding: 'json' },
      { payload_digest: 'A'.repeat(64) }, { payload_digest: 'g'.repeat(64) },
      { payload_digest: 'a'.repeat(63) }, { payload_digest: 'a'.repeat(65) },
      { payload_digest: `${'a'.repeat(64)}\u0000g` },
    ];
    for (const overrides of rejected) await expect(insert(h, overrides)).rejects.toThrow('CHECK constraint failed');
    expect(await h.db.getAllAsync('SELECT * FROM remote_fact_inbox')).toEqual([]);
  });

  it('stores integer enqueue flags and bounded safe first-seen timestamps', async () => {
    for (const [index, firstSeen] of [0, Number.MAX_SAFE_INTEGER].entries()) {
      await insert(h, { payload_digest: String(index).repeat(64), enqueue_on_admission: index, first_seen_at: firstSeen });
    }
    expect(await h.db.getAllAsync(`SELECT enqueue_on_admission, first_seen_at,
      typeof(enqueue_on_admission) AS flag_type, typeof(first_seen_at) AS time_type
      FROM remote_fact_inbox ORDER BY first_seen_at`)).toEqual([
      { enqueue_on_admission: 0, first_seen_at: 0, flag_type: 'integer', time_type: 'integer' },
      { enqueue_on_admission: 1, first_seen_at: Number.MAX_SAFE_INTEGER, flag_type: 'integer', time_type: 'integer' },
    ]);
    for (const enqueue_on_admission of [-1, 2, 0.5, 'invalid']) {
      await expect(insert(h, { enqueue_on_admission })).rejects.toThrow('CHECK constraint failed');
    }
    for (const first_seen_at of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5, 'invalid']) {
      await expect(insert(h, { first_seen_at })).rejects.toThrow('CHECK constraint failed');
    }
    await expect(insert(h, { first_seen_at: null })).rejects.toThrow('NOT NULL constraint failed');
  });

  it('keys variants by exact type, binary original-case ID, and digest', async () => {
    await insert(h);
    await expect(insert(h)).rejects.toThrow('UNIQUE constraint failed');
    await insert(h, { payload_digest: 'b'.repeat(64), payload: '{}', payload_bytes: 2 });
    await insert(h, { fact_id: factId.toUpperCase() });
    await insert(h, { fact_type: 'ledger_entry' });
    expect(await h.db.getAllAsync('SELECT fact_type, fact_id, payload_digest FROM remote_fact_inbox ORDER BY fact_type, fact_id, payload_digest')).toEqual([
      { fact_type: 'habit_action', fact_id: factId.toUpperCase(), payload_digest: digest },
      { fact_type: 'habit_action', fact_id: factId, payload_digest: digest },
      { fact_type: 'habit_action', fact_id: factId, payload_digest: 'b'.repeat(64) },
      { fact_type: 'ledger_entry', fact_id: factId, payload_digest: digest },
    ]);
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM remote_fact_inbox WHERE fact_id = ?', [factId]))
      .toEqual({ count: 3 });
  });

  it('defaults new raw checks to suppressed and excludes the local bit from wire fields', async () => {
    const boardId = '00000000-0000-4000-8000-000000000010', checkId = '00000000-0000-4000-8000-000000000011';
    await h.db.runAsync(`INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
      tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'pending', 'star.fill', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, 'seed')`, [boardId]);
    await h.db.runAsync(`INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp)
      VALUES (?, ?, '2026-09-08', 'sync', ?, 0, 0, 'seed')`, [checkId, boardId, checkId]);
    const raw = await h.db.getFirstAsync<Record<string, SqlValue>>('SELECT * FROM check_ins WHERE id = ?', [checkId]);
    expect(raw?.state_suppressed).toBe(1);
    expect(toSyncRecord('check_in', checkId, 'seed', raw!).fields).not.toHaveProperty('state_suppressed');
    expect(toSyncRecord('check_in', checkId, 'seed', { ...raw!, state_suppressed: 0 })).toEqual(toSyncRecord('check_in', checkId, 'seed', raw!));
    for (const value of [-1, 2, 0.5, 'invalid']) {
      await expect(h.db.runAsync('UPDATE check_ins SET state_suppressed = ?', [value])).rejects.toThrow('CHECK constraint failed');
    }
    expect(await h.db.getFirstAsync('SELECT state_suppressed FROM check_ins WHERE id = ?', [checkId])).toEqual({ state_suppressed: 1 });
  });
});
