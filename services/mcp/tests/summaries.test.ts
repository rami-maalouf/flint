import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeResult, SUMMARY_BYTES } from '../src/tools/summaries';

const id = '00000000-0000-4000-8000-000000000001';
const meta = { observedAtUtc: 1, lastCompletedPullAtUtc: 1, backendRevision: null, syncStatus: 'up_to_date',
  pendingLocalDeliveries: 0, admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
const reward = { id, title: 'synthetic reward', costCoins: 3, symbol: 'star', accentHex: '#ffffff', mutationStamp: 'stamp', archivedAt: null };

test('text preserves negative balances and explicitly labels cached observations', () => {
  const text = summarizeResult('get_coin_balance', { data: { earned: 1, spent: 3, balance: -2 },
    meta: { ...meta, usedCached: true, syncStatus: 'cached', pendingLocalDeliveries: 4 } });
  assert.match(text, /balance -2; earned 1; spent 3/);
  assert.match(text, /queued deliveries 4; cached observation/);
});

test('operation text states delivery and actual effects without inventing a committed result', () => {
  const operation = { operationId: id, tool: 'create_checkin', state: 'prepared', delivery: 'unknown', result: null, error: null };
  const pending = summarizeResult('get_operation', { data: operation, meta });
  assert.ok(pending.includes(id)); assert.match(pending, /state prepared; delivery unknown/);
  assert.match(pending, /No committed result/);
  const replay = summarizeResult('create_checkin', { data: { ...operation, state: 'completed_no_mutation', delivery: 'not_required',
    result: { checkinId: id, habitId: id, logicalDate: '2026-10-30', created: false } }, meta });
  assert.match(replay, /Reused existing check-in/);
  assert.doesNotMatch(replay, /Created check-in/);
});

test('confirmation text includes the exact cost and usable URL, with a bounded oversized-link fallback', () => {
  const data = { operationId: id, reward, balance: 4, balanceAfterClaim: 1, expiresAtUtc: 2,
    confirmationUrl: 'https://example.test/mcp/reward-confirmation?token=public-confirmation', confirmationToken: 'private-opaque-token' };
  const text = summarizeResult('get_reward_claim_preview', { data, meta });
  assert.ok(text.includes(data.confirmationUrl)); assert.match(text, /costs 3 coins/); assert.match(text, /balance after claim 1/);
  assert.match(text, /No coins spent or reserved/); assert.ok(!text.includes(data.confirmationToken));
  const insufficient = summarizeResult('get_reward_claim_preview', { data: { ...data, balance: 1, balanceAfterClaim: null }, meta });
  assert.match(insufficient, /insufficient funds/); assert.match(insufficient, /Approval is unavailable/);
  const bounded = summarizeResult('get_reward_claim_preview', { data: { ...data, confirmationUrl: 'https://example.test/?x=' + 'x'.repeat(20_000) }, meta });
  assert.match(bounded, /confirmationUrl in the structured result/); assert.ok(Buffer.byteLength(bounded) <= SUMMARY_BYTES);
});

test('history text contains ids and dates while omitting private notes', () => {
  const text = summarizeResult('get_checkin_history', { data: { items: [{ id, habitId: id, logicalDate: '2026-10-30', occurredAtUtc: null,
    timeZoneId: null, offsetMinutes: null, amount: 2, note: 'private sentinel', createdAt: 1, mutationStamp: 'stamp' }], nextCursor: 'opaque-cursor' }, meta });
  assert.match(text, /1 check-ins returned; more results available/); assert.ok(text.includes(id));
  assert.match(text, /2026-10-30, amount 2/); assert.ok(!text.includes('private sentinel'));
});
