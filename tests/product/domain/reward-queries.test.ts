import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCheckIn } from '@/core/domain/commands';
import { archiveReward, claimReward, createReward, deleteReward, updateReward } from '@/core/domain/reward-commands';
import { getReward, getRewardClaimPreview, listRewards, type ListRewardsInput } from '@/core/domain/reward-queries';
import { parseRewardId, type RewardId } from '@/core/domain/ids';
import type { DomainResult } from '@/core/domain/result';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const fields = { title: 'A book', costCoins: 1, symbol: 'book.fill', accentHex: '#70A7FF' };
const missingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as RewardId;
function value<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function create(h: TestHarness) {
  const { rewardId } = value(await createReward(h.deps, { ...fields, commandId: h.ids.nextCommandId() }));
  return value(await getReward(h.deps, rewardId));
}

describe('reward queries and confirmation snapshots', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('parses reward routes without accepting malformed or non-v4 identities', () => {
    expect(parseRewardId('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF')).toBe('abcdefab-cdef-4abc-8def-abcdefabcdef');
    expect(parseRewardId('ABCDEFAB-CDEF-5ABC-8DEF-ABCDEFABCDEF')).toBeNull();
    expect(parseRewardId('not-a-reward')).toBeNull();
    expect(parseRewardId(['abcdefab-cdef-4abc-8def-abcdefabcdef'] as unknown as string)).toBeNull();
  });

  it('sorts stored key ties by binary id and keeps active, archived and deleted views separate', async () => {
    const created = await create(h);
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'];
    for (const id of ids) await h.db.runAsync(`INSERT INTO rewards SELECT ?, title, cost_coins, symbol, accent_hex,
      order_key, archived_at, created_at, updated_at, mutation_stamp, deleted_at FROM rewards WHERE id = ?`, [id, created.id]);
    const read = jest.spyOn(h.db, 'getAllAsync');
    expect(value(await listRewards(h.deps, { archived: false })).map((row) => row.id)).toEqual([created.id, ids[1], ids[0]]);
    const sql = read.mock.calls.find(([sql]) => sql.includes('FROM rewards'))![0];
    const plan = await h.db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`);
    expect(plan.some((row) => row.detail.includes('idx_rewards_active'))).toBe(true);
    value(await archiveReward(h.deps, { rewardId: ids[0] as RewardId, commandId: h.ids.nextCommandId() }));
    value(await archiveReward(h.deps, { rewardId: ids[1] as RewardId, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps, { archived: true })).map((row) => row.id)).toEqual([ids[1], ids[0]]);
    expect(value(await getReward(h.deps, ids[0] as RewardId)).archivedAt).not.toBeNull();
    expect(await getRewardClaimPreview(h.deps, ids[0] as RewardId)).toMatchObject({ ok: false, error: { code: 'archived' } });
    value(await deleteReward(h.deps, { rewardId: ids[0] as RewardId, commandId: h.ids.nextCommandId() }));
    expect(await getReward(h.deps, ids[0] as RewardId)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await getRewardClaimPreview(h.deps, missingId)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([created.id]);
  });

  it('returns no unsafe projected balance for an already-negative ledger and reports unsafe aggregates explicitly', async () => {
    const reward = await create(h);
    const insertDebit = (amount: number) => h.db.runAsync(`INSERT INTO coin_ledger
      (id, kind, delta, reward_id, reward_title_snapshot, logical_date, created_at, mutation_stamp)
      VALUES (?, 'claim', ?, ?, 'Historical claim', '2026-08-29', 0, '00000000000000-00000-test')`,
    [h.ids.uuid(), -amount, missingId]);
    await insertDebit(Number.MAX_SAFE_INTEGER);
    expect(await getRewardClaimPreview(h.deps, reward.id)).toEqual({ ok: true, value: {
      reward, balance: -Number.MAX_SAFE_INTEGER, balanceAfterClaim: null,
    } });
    const insufficient = { commandId: h.ids.nextCommandId(), rewardId: reward.id, expectedMutationStamp: reward.mutationStamp };
    expect(await claimReward(h.deps, insufficient)).toMatchObject({ ok: false, error: { code: 'validation' } });
    await insertDebit(1);
    expect(await getRewardClaimPreview(h.deps, reward.id)).toMatchObject({ ok: false, error: { code: 'capacity', retryable: false } });
    const before = await h.db.getAllAsync('SELECT * FROM coin_ledger');
    expect(await claimReward(h.deps, { ...insufficient, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'capacity', retryable: false } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual(before);
  });

  it.each([undefined, null, 7, 'bad'])('rejects malformed reward identity %s', async (id) => {
    expect(await getReward(h.deps, id as RewardId)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each([null, 0, 'false'])('rejects a malformed archive selector %s', async (archived) => {
    expect(await listRewards(h.deps, { archived } as unknown as ListRewardsInput)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('returns retryable read failures and recovers without changing product rows', async () => {
    const reward = await create(h);
    const snapshot = async () => Promise.all(['rewards', 'coin_ledger', 'mutation_outbox', 'command_receipts', 'app_settings']
      .map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
    const before = await snapshot();
    jest.spyOn(h.db, 'getAllAsync').mockRejectedValueOnce(new Error('reward list unavailable'));
    expect(await listRewards(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(value(await listRewards(h.deps))).toEqual([reward]);
    const original = h.db.getFirstAsync.bind(h.db);
    const read = jest.spyOn(h.db, 'getFirstAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM coin_ledger')) throw new Error('coin totals unavailable');
      return original(sql, params);
    });
    expect(await getRewardClaimPreview(h.deps, reward.id)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    read.mockRestore();
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toEqual({ reward, balance: 0, balanceAfterClaim: null });
    expect(await snapshot()).toEqual(before);
  });

  it('reads reward and balance from one WAL snapshot while another connection commits a claim and edit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'habit-reward-preview-'));
    const writer = new NodeSqlDatabase(join(directory, 'test.sqlite'));
    const reader = new NodeSqlDatabase(join(directory, 'test.sqlite'));
    try {
      value(await initializeProductDatabase(writer, h.ids, h.deps.hashing));
      await writer.execAsync('PRAGMA journal_mode=WAL');
      const writerHarness = { ...h, db: writer, deps: { ...h.deps, db: writer } };
      const boardId = await createBoardForTest(writerHarness, { earnsCoins: true, coinCapPerDay: 3 });
      for (let n = 0; n < 3; n += 1) value(await createCheckIn(writerHarness.deps, {
        commandId: h.ids.nextCommandId(), boardId, source: 'app',
      }));
      const reward = await create(writerHarness);
      const original = reader.getFirstAsync.bind(reader);
      const intercepted = jest.spyOn(reader, 'getFirstAsync').mockImplementationOnce(async (sql, params) => {
        const result = await original(sql, params);
        value(await claimReward(writerHarness.deps, { rewardId: reward.id,
          expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
        value(await updateReward(writerHarness.deps, { ...fields, title: 'Edited book', costCoins: 2,
          rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
        return result;
      });
      expect(await getRewardClaimPreview({ db: reader, clock: h.clock }, reward.id)).toEqual({ ok: true, value: {
        reward, balance: 3, balanceAfterClaim: 2,
      } });
      intercepted.mockRestore();
      expect(await getRewardClaimPreview({ db: reader, clock: h.clock }, reward.id)).toMatchObject({ ok: true, value: {
        reward: { title: 'Edited book', costCoins: 2 }, balance: 2, balanceAfterClaim: 0,
      } });
    } finally {
      await reader.closeAsync(); await writer.closeAsync(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
