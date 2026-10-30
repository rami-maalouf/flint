import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contracts, hasToolScope, validateResult } from '../src/tools/contracts';

const operationId = '00000000-0000-4000-8000-000000000001';
const habitId = '00000000-0000-4000-8000-000000000002';

test('the catalog contains exactly the fifteen bounded v1 tools', () => {
  assert.deepEqual(Object.keys(contracts).sort(), ['list_habits', 'get_habit', 'get_today', 'list_stacks', 'get_stack',
    'get_checkin_history', 'get_coin_balance', 'get_coin_history', 'list_rewards', 'get_reward_claim_preview',
    'get_sync_status', 'get_operation', 'create_checkin', 'undo_checkin', 'claim_reward'].sort());
  for (const tool of Object.values(contracts)) {
    assert.ok(tool.description.length > 20);
    assert.equal(tool.input.safeParse({ owner: habitId, backend: 'https://example.test' }).success, false);
    assert.equal(hasToolScope(tool, []), false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test('read inputs reject unknown fields, oversized pages, invalid zones and impossible dates', () => {
  assert.equal(contracts.list_habits.input.safeParse({ limit: 100 }).success, true);
  for (const limit of [0, 101, 1.5, Infinity]) assert.equal(contracts.list_habits.input.safeParse({ limit }).success, false);
  assert.equal(contracts.get_today.input.safeParse({ timeZone: 'America/Toronto' }).success, true);
  for (const timeZone of ['not/a-zone', '../account', '', '+05:00']) {
    assert.equal(contracts.get_today.input.safeParse({ timeZone }).success, false);
  }
  assert.equal(contracts.get_checkin_history.input.safeParse({ habitId, fromDate: '2026-02-30' }).success, false);
  assert.equal(contracts.get_checkin_history.input.safeParse({ habitId, fromDate: '2026-10-30', toDate: '2026-10-01' }).success, false);
  assert.equal(contracts.get_habit.input.safeParse({ habitId, sql: 'select 1' }).success, false);
});

test('mutation contracts require v4 operation ids and explicit confirmation evidence', () => {
  assert.equal(contracts.create_checkin.input.safeParse({ habitId, timeZone: 'UTC' }).success, false);
  assert.equal(contracts.create_checkin.input.safeParse({ operationId, habitId, timeZone: 'UTC' }).success, true);
  assert.equal(contracts.create_checkin.input.safeParse({ operationId: habitId.replace('-4000-', '-5000-'), habitId, timeZone: 'UTC' }).success, false);
  for (const amount of [0, -1, Infinity, 1e20]) {
    assert.equal(contracts.create_checkin.input.safeParse({ operationId, habitId, timeZone: 'UTC', amount }).success, false);
  }
  assert.equal(contracts.claim_reward.input.safeParse({ operationId, confirmed: true }).success, false);
  assert.equal(contracts.undo_checkin.input.safeParse({ operationId, checkinId: habitId }).success, false);
  assert.equal(contracts.get_reward_claim_preview.input.safeParse({ operationId, rewardId: habitId, timeZone: 'UTC' }).success, true);
});

test('scope checks require all declared authority and operation lookup admits either read family', () => {
  assert.equal(hasToolScope(contracts.create_checkin, ['habits:read']), false);
  assert.equal(hasToolScope(contracts.create_checkin, ['checkins:write']), true);
  assert.equal(hasToolScope(contracts.claim_reward, ['rewards:claim']), false);
  assert.equal(hasToolScope(contracts.claim_reward, ['coins:read', 'rewards:claim']), true);
  assert.equal(hasToolScope(contracts.get_operation, ['coins:read']), true);
  assert.equal(hasToolScope(contracts.get_operation, ['habits:read']), true);
});

test('structured outputs accept negative balances and enforce an overall byte budget', () => {
  const meta = { observedAtUtc: 1, lastCompletedPullAtUtc: 1, backendRevision: null, syncStatus: 'up_to_date',
    pendingLocalDeliveries: 0, admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
  assert.deepEqual(validateResult('get_coin_balance', { data: { earned: 2, spent: 4, balance: -2 }, meta }),
    { data: { earned: 2, spent: 4, balance: -2 }, meta });
  assert.throws(() => validateResult('get_coin_balance', { data: { earned: 2, spent: 4, balance: -2, token: 'private' }, meta }));
  assert.throws(() => validateResult('get_coin_balance', { data: { earned: 2, spent: 4, balance: -2 }, meta }, 8));
});

test('history preserves fractional historical instants and historical timezone offsets', () => {
  const meta = { observedAtUtc: 1, lastCompletedPullAtUtc: 1, backendRevision: null, syncStatus: 'up_to_date',
    pendingLocalDeliveries: 0, admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
  const item = { id: operationId, habitId, logicalDate: '1900-01-01', occurredAtUtc: -2208988800000.5,
    timeZoneId: 'Europe/Paris', offsetMinutes: 9.35, amount: null, createdAt: 1, mutationStamp: 'historical' };
  assert.deepEqual(validateResult('get_checkin_history', { data: { items: [item], nextCursor: null }, meta }),
    { data: { items: [item], nextCursor: null }, meta });
  assert.equal(contracts.create_checkin.input.safeParse({ operationId, habitId, timeZone: 'Europe/Paris',
    occurredAtUtc: item.occurredAtUtc }).success, true);
});
