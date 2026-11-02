import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import { logoutAll } from 'snapback4/auth';

import { authorize, call, connectClient, createAccount, createPhone, hiddenField, oauthClient, startBackend,
  startService } from './helpers.ts';

test('an assistant signs in with the flint account and reads what the phone synced', async t => {
  const backendUrl = await startBackend(t);
  const account = await createAccount(backendUrl);
  const phone = await createPhone(t, backendUrl, account.session);
  const reading = await phone.habit({ title: 'Read' });
  await phone.habit({ title: 'Meditate', kind: 'daily' });
  await phone.sync();

  const service = await startService(t, backendUrl);
  const provider = oauthClient();
  await authorize(service.origin, provider, account);
  const client = await connectClient(t, service.origin, provider);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['claim_reward', 'create_checkin', 'get_checkin_history', 'get_coin_balance',
    'get_coin_history', 'get_habit', 'get_stack', 'get_sync_status', 'get_today', 'list_habits', 'list_rewards', 'list_stacks',
    'preview_reward_claim', 'undo_checkin']);
  const { habits } = await call<{ habits: { id: string; title: string; kind: string }[] }>(client, 'list_habits');
  assert.deepEqual(habits.map(habit => [habit.title, habit.kind]).sort(), [['Meditate', 'daily'], ['Read', 'count']]);
  const today = await call<{ habits: { habit: { id: string }; last14Days: unknown[] }[]; sync: { status: string } }>(
    client, 'get_today', { timeZone: 'Europe/Paris' });
  assert.equal(today.sync.status, 'synced');
  assert.equal(today.habits.find(card => card.habit.id === reading)?.last14Days.length, 14);
});

async function connectedAccount(t: TestContext, options: { write?: boolean; capabilities?: Parameters<typeof connectClient>[3] } = {}) {
  const backendUrl = await startBackend(t);
  const account = await createAccount(backendUrl);
  const phone = await createPhone(t, backendUrl, account.session);
  const reading = await phone.habit({ title: 'Read' });
  const meditation = await phone.habit({ title: 'Meditate', kind: 'daily' });
  const movie = await phone.reward('Movie night', 2);
  await phone.sync();
  const service = await startService(t, backendUrl);
  const provider = oauthClient();
  const browser = await authorize(service.origin, provider, account, { write: options.write });
  const client = await connectClient(t, service.origin, provider, options.capabilities);
  return { backendUrl, account, phone, reading, meditation, movie, service, provider, browser, client };
}

type CheckinResult = { checkinId: string; date: string; created: boolean; delivery: string };

async function phoneCheckIns(phone: Awaited<ReturnType<typeof createPhone>>, habitId: string) {
  await phone.sync();
  return phone.db.getAllAsync<{ id: string }>('SELECT id FROM check_ins WHERE board_id = ? AND deleted_at IS NULL', [habitId]);
}

test('a check-in reaches the phone once, even when retried after the server loses its replica', async t => {
  const { client, phone, reading, meditation, service } = await connectedAccount(t);
  const operationId = randomUUID();
  const first = await call<CheckinResult>(client, 'create_checkin', { operationId, habitId: reading, timeZone: 'Europe/Paris', note: 'chapter 3' });
  assert.equal(first.created, true);
  assert.equal(first.delivery, 'synced');
  const retried = await call<CheckinResult>(client, 'create_checkin', { operationId, habitId: reading, timeZone: 'Europe/Paris' });
  assert.equal(retried.checkinId, first.checkinId);

  await service.restart({ dropReplicas: true });
  const afterLoss = await call<CheckinResult>(client, 'create_checkin', { operationId, habitId: reading, timeZone: 'Europe/Paris' });
  assert.equal(afterLoss.checkinId, first.checkinId);
  assert.deepEqual((await phoneCheckIns(phone, reading)).map(row => row.id), [first.checkinId]);

  await assert.rejects(call(client, 'create_checkin', { operationId, habitId: meditation, timeZone: 'UTC' }), /CONFLICT/);
  const daily = await call<CheckinResult>(client, 'create_checkin', { operationId: randomUUID(), habitId: meditation, timeZone: 'UTC' });
  const dailyAgain = await call<CheckinResult>(client, 'create_checkin', { operationId: randomUUID(), habitId: meditation, timeZone: 'UTC' });
  assert.deepEqual([daily.created, dailyAgain.created, dailyAgain.checkinId], [true, false, daily.checkinId]);
  await assert.rejects(call(client, 'create_checkin', { operationId: randomUUID(), habitId: reading, timeZone: 'UTC', date: '2999-01-01' }),
    /INVALID_INPUT/);
});

test('undo removes only the check-in its operation created, and repeating it is harmless', async t => {
  const { client, phone, reading } = await connectedAccount(t);
  const kept = await call<CheckinResult>(client, 'create_checkin', { operationId: randomUUID(), habitId: reading, timeZone: 'UTC' });
  const operationId = randomUUID();
  const undone = await call<CheckinResult>(client, 'create_checkin', { operationId, habitId: reading, timeZone: 'UTC' });
  assert.equal(phone && (await phoneCheckIns(phone, reading)).length, 2);
  await call(client, 'undo_checkin', { operationId });
  await call(client, 'undo_checkin', { operationId });
  assert.deepEqual((await phoneCheckIns(phone, reading)).map(row => row.id), [kept.checkinId]);
  assert.notEqual(undone.checkinId, kept.checkinId);
  await assert.rejects(call(client, 'undo_checkin', { operationId: randomUUID() }), /NOT_FOUND/);
});

type Claim = { claimId: string; balance: number; costCoins: number };
type Preview = { reward: { version: string }; balance: number; balanceAfterClaim: number | null };

async function earnCoins(client: Client, habitId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    await call(client, 'create_checkin', { operationId: randomUUID(), habitId, timeZone: 'UTC' });
  }
}

test('a client with elicitation asks the user before a claim, and a declined claim spends nothing', async t => {
  let answer = false;
  const asked: string[] = [];
  const { client, reading, movie } = await connectedAccount(t, { capabilities: {
    capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } } });
  client.setRequestHandler('elicitation/create', async request => {
    asked.push(request.params.message);
    return { action: 'accept', content: { confirm: answer } };
  });
  await earnCoins(client, reading, 3);
  const preview = await call<Preview>(client, 'preview_reward_claim', { rewardId: movie });
  assert.deepEqual([preview.balance, preview.balanceAfterClaim], [3, 1]);
  const claim = { operationId: randomUUID(), rewardId: movie, rewardVersion: preview.reward.version, timeZone: 'UTC' };

  await assert.rejects(call(client, 'claim_reward', claim), /DECLINED/);
  assert.equal((await call<{ balance: number }>(client, 'get_coin_balance')).balance, 3);
  answer = true;
  const claimed = await call<Claim>(client, 'claim_reward', claim);
  assert.deepEqual([claimed.costCoins, claimed.balance], [2, 1]);
  assert.deepEqual(asked, Array(2).fill('Claim "Movie night" for 2 coins? Your balance goes from 3 to 1.'));
  // a completed claim replays without asking again.
  assert.equal((await call<Claim>(client, 'claim_reward', claim)).claimId, claimed.claimId);
  assert.equal(asked.length, 2);
});

// the 2025 protocol is served statelessly, so the server cannot ask mid-call. these clients rely on
// preview_reward_claim and their own approval prompt for non-read-only tools.
test('a 2025 protocol client claims without a server-side question', async t => {
  const { client, reading, movie } = await connectedAccount(t, { capabilities: { capabilities: { elicitation: { form: {} } } } });
  client.setRequestHandler('elicitation/create', async () => assert.fail('a stateless 2025 request cannot be asked'));
  await earnCoins(client, reading, 2);
  const preview = await call<Preview>(client, 'preview_reward_claim', { rewardId: movie });
  const claimed = await call<Claim>(client, 'claim_reward',
    { operationId: randomUUID(), rewardId: movie, rewardVersion: preview.reward.version, timeZone: 'UTC' });
  assert.equal(claimed.balance, 0);
});

test('a claim is spent once across retries and replica loss, and refuses a changed reward', async t => {
  const { client, phone, reading, movie, service } = await connectedAccount(t);
  await earnCoins(client, reading, 2);
  const preview = await call<Preview>(client, 'preview_reward_claim', { rewardId: movie });
  const claim = { operationId: randomUUID(), rewardId: movie, rewardVersion: preview.reward.version, timeZone: 'UTC' };
  const first = await call<Claim>(client, 'claim_reward', claim);
  await service.restart({ dropReplicas: true });
  const retried = await call<Claim>(client, 'claim_reward', claim);
  assert.equal(retried.claimId, first.claimId);
  assert.equal((await call<{ balance: number }>(client, 'get_coin_balance')).balance, 0);
  await phone.sync();
  const claims = await phone.db.getAllAsync('SELECT id FROM coin_ledger WHERE kind = \'claim\'');
  assert.equal(claims.length, 1);

  await assert.rejects(call(client, 'claim_reward', { ...claim, operationId: randomUUID() }), /not enough coins/);
  await assert.rejects(call(client, 'claim_reward', { ...claim, operationId: randomUUID(), rewardVersion: 'stale' }), /CONFLICT/);
});

test('a read-only connection cannot change anything', async t => {
  const { client, reading } = await connectedAccount(t, { write: false });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('list_habits'));
  assert.ok(!names.includes('create_checkin') && !names.includes('claim_reward') && !names.includes('undo_checkin'));
  await assert.rejects(client.callTool({ name: 'create_checkin', arguments: { operationId: randomUUID(), habitId: reading, timeZone: 'UTC' } }),
    /not found/);
});

test('disconnecting an app from the connections page stops its access immediately', async t => {
  const { client, browser } = await connectedAccount(t);
  const page = await (await browser.get('/mcp/connections')).text();
  assert.match(page, /Test assistant/);
  const consent = hiddenField(page, 'consent');
  const response = await browser.post('/mcp/connections', { action: 'disconnect', consent });
  assert.equal(response.status, 303);
  assert.match(await (await browser.get('/mcp/connections')).text(), /No apps are connected/);
  await assert.rejects(client.callTool({ name: 'list_habits', arguments: {} }));
});

test('a signed-out flint session asks the user to reconnect', async t => {
  const { client, backendUrl, account } = await connectedAccount(t);
  await logoutAll(backendUrl, account.session.token);
  const result = await client.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /RECONNECT_REQUIRED/);
});

test('every read tool answers within its published schema', async t => {
  const { client, phone, reading, meditation, movie } = await connectedAccount(t);
  const stretch = await phone.habit({ title: 'Stretch', kind: 'daily', after: meditation });
  await phone.sync();
  for (let index = 0; index < 3; index += 1) {
    await call(client, 'create_checkin', { operationId: randomUUID(), habitId: reading, timeZone: 'UTC', note: `page ${index}` });
  }
  await call(client, 'create_checkin', { operationId: randomUUID(), habitId: meditation, timeZone: 'UTC' });
  await call(client, 'create_checkin', { operationId: randomUUID(), habitId: stretch, timeZone: 'UTC' });

  const habit = await call<{ habit: { title: string }; summary: { currentStreak: number } }>(
    client, 'get_habit', { habitId: meditation, timeZone: 'UTC' });
  assert.deepEqual([habit.habit.title, habit.summary.currentStreak], ['Meditate', 1]);
  const { stacks } = await call<{ stacks: { rootHabitId: string; members: { title: string }[]; currentRun: { complete: boolean } }[] }>(
    client, 'list_stacks', { timeZone: 'UTC' });
  const stack = stacks.find(row => row.rootHabitId === meditation);
  assert.deepEqual(stack?.members.map(member => member.title), ['Meditate', 'Stretch']);
  assert.equal(stack?.currentRun.complete, true);
  const detail = await call<{ stack: { longestStreak: number; days: unknown[] } }>(client, 'get_stack', { rootHabitId: meditation, timeZone: 'UTC' });
  assert.equal(detail.stack.longestStreak, 1);

  const page1 = await call<{ checkins: { note: string }[]; nextCursor: string }>(client, 'get_checkin_history', { habitId: reading, limit: 2 });
  const page2 = await call<{ checkins: { note: string }[]; nextCursor: null }>(client, 'get_checkin_history',
    { habitId: reading, limit: 2, cursor: page1.nextCursor });
  assert.deepEqual([...page1.checkins, ...page2.checkins].map(row => row.note).sort(), ['page 0', 'page 1', 'page 2']);
  assert.equal(page2.nextCursor, null);

  const balance = await call<{ earned: number; balance: number }>(client, 'get_coin_balance');
  const history = await call<{ entries: { kind: string }[] }>(client, 'get_coin_history', { limit: 100 });
  assert.equal(history.entries.length, balance.earned);
  const { rewards } = await call<{ rewards: { id: string; costCoins: number }[] }>(client, 'list_rewards', { status: 'all' });
  assert.deepEqual(rewards.map(row => [row.id, row.costCoins]), [[movie, 2]]);
  const status = await call<{ sync: { status: string; pendingUploads: number } }>(client, 'get_sync_status');
  assert.deepEqual([status.sync.status, status.sync.pendingUploads], ['synced', 0]);
  const listing = await call<{ habits: unknown[]; nextCursor: string }>(client, 'list_habits', { limit: 2 });
  const rest = await call<{ habits: unknown[]; nextCursor: null }>(client, 'list_habits', { limit: 2, cursor: listing.nextCursor });
  assert.equal(listing.habits.length + rest.habits.length, 3);
});
