import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { login } from 'snapback4/auth';
import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import { claimReward, createReward, deleteReward, updateReward } from '../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { WireSyncRecord } from '../../../src/core/sync/transport';
import { accountDirectory } from '../src/accounts/replica';
import { wireIdentity } from '../src/operations/records';
import { syntheticOAuthClient } from './helpers/oauth';
import { fullService } from './helpers/full-service';

type Quote = { operationId: string; reward: { mutationStamp: string; costCoins: number; title: string }; balance: number;
  balanceAfterClaim: number | null; expiresAtUtc: number; confirmationToken: string; confirmationUrl: string };
type Receipt = { operationId: string; tool: string; state: string; delivery: string; result: { ledgerEntryId: string;
  rewardId: string; rewardTitle: string; costCoins: number; logicalDate: string; balanceAfterClaim: number } };
type ToolResponse = { isError?: boolean; structuredContent?: unknown };
const data = <T>(response: ToolResponse): T => {
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return (response.structuredContent as { data: T }).data;
};
const error = (response: ToolResponse, code: string) => {
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.equal((response.structuredContent as { error: { code: string } }).error.code, code);
};
const hidden = (html: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing ${name}`);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
};
const preview = async (client: Client, rewardId: string, operationId: string = randomUUID()) => data<Quote>(await client.callTool({
  name: 'get_reward_claim_preview', arguments: { rewardId, operationId, timeZone: 'America/Toronto' },
}));
const claim = (client: Client, quote: Quote, changes: Record<string, string> = {}) => client.callTool({
  name: 'claim_reward', arguments: { operationId: quote.operationId, confirmationToken: quote.confirmationToken, ...changes },
});

test('M19 real Snapback, OAuth and HTTP MCP reward claims preserve approval, replay and offline economics',
  { timeout: 180_000 }, async t => {
    const fixture = await fullService(t);
    const owner = await fixture.account();
    const deps = { db: owner.seed, ...fixture.ports };
    const board = await createBoard(deps, { commandId: randomUUID() as CommandId, title: 'synthetic reward funding',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok, JSON.stringify(board));
    const reward = await createReward(deps, { commandId: randomUUID() as CommandId, title: 'synthetic first title',
      costCoins: 3, symbol: 'star.fill', accentHex: '#70A7FF' });
    assert.ok(reward.ok, JSON.stringify(reward));
    for (let index = 0; index < 4; index++) {
      const result = await createCheckIn(deps,
        { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' });
      assert.ok(result.ok, JSON.stringify(result));
    }
    await owner.sync();
    const { browserSession, context } = await owner.authorize();
    const client = await owner.connect();
    const catalog = await client.listTools();
    const names = catalog.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['list_habits', 'get_habit', 'get_today', 'list_stacks', 'get_stack', 'get_checkin_history',
      'get_coin_balance', 'get_coin_history', 'list_rewards', 'get_sync_status', 'get_operation', 'create_checkin',
      'undo_checkin', 'get_reward_claim_preview', 'claim_reward'].sort());
    assert.deepEqual(fixture.mutations.toolNames, ['create_checkin', 'undo_checkin', 'get_operation', 'claim_reward']);
    assert.equal(catalog.tools.find(tool => tool.name === 'claim_reward')?.inputSchema.additionalProperties, false);

    const first = await preview(client, reward.value.rewardId);
    assert.equal(first.balance, 4); assert.equal(first.balanceAfterClaim, 1);
    const balance = async () => data<{ earned: number; spent: number; balance: number }>(
      await client.callTool({ name: 'get_coin_balance', arguments: {} }));
    assert.equal((await balance()).balance, 4);
    error(await claim(client, first), 'CONFIRMATION_REQUIRED');
    error(await claim(client, first, { confirmed: 'true' }), 'INVALID_INPUT');
    const page = await fetch(first.confirmationUrl, { headers: { cookie: browserSession.cookieHeader() } });
    assert.equal(page.status, 200, await page.clone().text());
    const html = await page.text();
    assert.ok(html.includes('3 coins') && html.includes('1 coins'));
    assert.equal((await balance()).balance, 4);
    const csrfCookie = page.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const approve = async (quote: Quote, session = browserSession) => {
      const shown = quote === first ? { html, cookie: csrfCookie } : await (async () => {
        const response = await fetch(quote.confirmationUrl, { headers: { cookie: session.cookieHeader() } });
        assert.equal(response.status, 200, await response.clone().text());
        return { html: await response.text(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
      })();
      const response = await fetch(fixture.publicOrigin + '/mcp/reward-confirmation', { method: 'POST',
        headers: { origin: fixture.publicOrigin, cookie: session.cookieHeader() + '; ' + shown.cookie,
          'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: hidden(shown.html, 'token'), csrf: hidden(shown.html, 'csrf'), decision: 'approve' }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok((await response.text()).includes('Reward approved'));
    };
    await approve(first);
    const secondAccount = await fixture.account();
    await secondAccount.authorize();
    const otherAccountClient = await secondAccount.connect();
    error(await claim(otherAccountClient, first), 'FORBIDDEN');
    error(await otherAccountClient.callTool({ name: 'get_operation', arguments: { operationId: first.operationId } }), 'NOT_FOUND');
    const otherProvider = syntheticOAuthClient('different synthetic reward app');
    await owner.authorize(otherProvider);
    const otherAppClient = await owner.connect(otherProvider);
    error(await claim(otherAppClient, first), 'FORBIDDEN');
    error(await otherAppClient.callTool({ name: 'get_operation', arguments: { operationId: first.operationId } }), 'NOT_FOUND');
    error(await client.callTool({ name: 'claim_reward', arguments: {
      operationId: randomUUID(), confirmationToken: first.confirmationToken } }), 'FORBIDDEN');
    const movement = data<{ state: string }>(await client.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId: board.value.boardId, timeZone: 'UTC' } }));
    assert.equal(movement.state, 'backend_acknowledged');
    assert.equal((await balance()).balance, 5);

    const uncertain = await owner.connect(owner.provider, async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === 'POST' ? await request.clone().text() : '';
      const response = await fetch(request);
      if (body.includes(first.operationId)) { await response.arrayBuffer(); throw new Error('synthetic lost claim HTTP response'); }
      return response;
    });
    await assert.rejects(claim(uncertain, first), /synthetic lost claim HTTP response/);
    const firstReceipt = data<Receipt>(await claim(client, first));
    assert.equal(firstReceipt.state, 'backend_acknowledged'); assert.equal(firstReceipt.delivery, 'acknowledged');
    assert.equal(firstReceipt.result.balanceAfterClaim, 2);
    assert.equal(firstReceipt.result.rewardTitle, 'synthetic first title');
    assert.equal((await balance()).balance, 2);
    error(await client.callTool({ name: 'create_checkin', arguments: {
      operationId: first.operationId, habitId: board.value.boardId, timeZone: 'UTC' } }), 'IDEMPOTENCY_CONFLICT');

    const path = accountDirectory(fixture.replicas, context.accountId);
    const journal = new DatabaseSync(join(path, 'journal.sqlite'), { readOnly: true });
    try {
      const tuples = journal.prepare('SELECT entity_type, entity_id, record, payload_hash, digest, disposition, remote_stamp FROM tuples WHERE operation_id = ?').all(first.operationId);
      assert.ok(tuples.some(tuple => tuple.entity_type === 'ledger_entry' && tuple.entity_id === firstReceipt.result.ledgerEntryId));
      for (const tuple of tuples) {
        const identity = wireIdentity(JSON.parse(String(tuple.record)) as WireSyncRecord);
        assert.equal(tuple.payload_hash, identity.payloadHash);
        assert.equal(tuple.digest, identity.digest);
        assert.equal(tuple.disposition, 'accepted');
        assert.equal(tuple.remote_stamp, identity.record.mutationStamp);
      }
    } finally { journal.close(); }
    const product = new DatabaseSync(join(path, 'product.sqlite'), { readOnly: true });
    try {
      const row = product.prepare('SELECT id, delta, reward_id, reward_title_snapshot, mutation_stamp FROM coin_ledger WHERE id = ?')
        .get(firstReceipt.result.ledgerEntryId);
      assert.equal(row?.delta, -3); assert.equal(row?.reward_id, reward.value.rewardId);
      assert.equal(row?.reward_title_snapshot, 'synthetic first title'); assert.equal(typeof row?.mutation_stamp, 'string');
    } finally { product.close(); }

    const funding = data<{ state: string }>(await client.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId: board.value.boardId, timeZone: 'UTC' } }));
    assert.equal(funding.state, 'backend_acknowledged'); assert.equal((await balance()).balance, 3);
    const expiring = await preview(client, reward.value.rewardId);
    await approve(expiring);
    fixture.setQuoteTime(expiring.expiresAtUtc);
    error(await claim(client, expiring), 'CONFIRMATION_EXPIRED');
    const fresh = await preview(client, reward.value.rewardId, expiring.operationId);
    assert.notEqual(fresh.confirmationToken, expiring.confirmationToken);
    error(await claim(client, fresh), 'CONFIRMATION_REQUIRED');

    const stale = await preview(client, reward.value.rewardId);
    await approve(stale);
    await owner.sync();
    const updated = await updateReward(deps, { commandId: randomUUID() as CommandId, rewardId: reward.value.rewardId,
      expectedMutationStamp: stale.reward.mutationStamp, title: 'synthetic edited title', costCoins: 3,
      symbol: 'star.fill', accentHex: '#70A7FF' });
    assert.ok(updated.ok, JSON.stringify(updated));
    await owner.sync();
    error(await claim(client, stale), 'CONFIRMATION_REQUIRED');
    const requoted = await preview(client, reward.value.rewardId, stale.operationId);
    assert.notEqual(requoted.confirmationToken, stale.confirmationToken);
    assert.equal(requoted.reward.title, 'synthetic edited title');
    await approve(requoted);

    await owner.sync();
    const nativeClaim = await claimReward(deps, { commandId: randomUUID() as CommandId,
      rewardId: reward.value.rewardId, expectedMutationStamp: requoted.reward.mutationStamp });
    assert.ok(nativeClaim.ok, JSON.stringify(nativeClaim));
    assert.equal(nativeClaim.value.balance, 0);
    const mcpClaim = data<Receipt>(await claim(client, requoted));
    assert.equal(mcpClaim.state, 'backend_acknowledged');
    assert.equal(mcpClaim.result.balanceAfterClaim, 0);
    await owner.sync();
    const nativeRows = await owner.seed.getAllAsync<{ id: string; delta: number; mutation_stamp: string }>(
      "SELECT * FROM coin_ledger WHERE kind = 'claim' ORDER BY id");
    assert.deepEqual(nativeRows.map(row => row.id), [firstReceipt.result.ledgerEntryId,
      nativeClaim.value.ledgerEntryId, mcpClaim.result.ledgerEntryId].sort());
    assert.equal(nativeRows.reduce((sum, row) => sum + row.delta, 0), -9);
    assert.equal((await owner.seed.getFirstAsync<{ balance: number }>(
      'SELECT COALESCE(SUM(delta), 0) AS balance FROM coin_ledger WHERE deleted_at IS NULL'))?.balance, -3);
    assert.equal((await balance()).balance, -3);
    const read = await login(fixture.host.url, owner.credentials.email, owner.credentials.password, { scope: 'read' });
    assert.ok(read.ok);
    const replica = await fixture.newReplica();
    await owner.sync(replica, read.session, 'pull_only');
    const replicaRows = await replica.getAllAsync<{ id: string; delta: number; mutation_stamp: string }>(
      "SELECT * FROM coin_ledger WHERE kind = 'claim' ORDER BY id");
    assert.deepEqual(replicaRows, nativeRows);
    const hashes = (rows: typeof nativeRows) => rows.map(row => createHash('sha256').update(JSON.stringify(row)).digest('hex'));
    assert.deepEqual(hashes(replicaRows), hashes(nativeRows));
    assert.equal(new Set(hashes(replicaRows)).size, 3);
    assert.equal((await replica.getFirstAsync<{ balance: number }>(
      'SELECT COALESCE(SUM(delta), 0) AS balance FROM coin_ledger WHERE deleted_at IS NULL'))?.balance, -3);
    const history = data<{ items: { id: string; delta: number }[] }>(await client.callTool({ name: 'get_coin_history', arguments: {} }));
    assert.deepEqual(history.items.filter(row => row.delta === -3).map(row => row.id).sort(), nativeRows.map(row => row.id));
    const secondJournal = new DatabaseSync(join(path, 'journal.sqlite'), { readOnly: true });
    try {
      const tuple = secondJournal.prepare('SELECT record, payload_hash, digest, disposition, remote_stamp FROM tuples WHERE operation_id = ? AND entity_type = ? AND entity_id = ?')
        .get(requoted.operationId, 'ledger_entry', mcpClaim.result.ledgerEntryId);
      assert.ok(tuple);
      const identity = wireIdentity(JSON.parse(String(tuple.record)) as WireSyncRecord);
      assert.equal(tuple.payload_hash, identity.payloadHash);
      assert.equal(tuple.digest, identity.digest);
      assert.equal(tuple.disposition, 'accepted');
      assert.equal(tuple.remote_stamp, identity.record.mutationStamp);
    } finally { secondJournal.close(); }

    const deleted = await deleteReward(deps, { commandId: randomUUID() as CommandId, rewardId: reward.value.rewardId });
    assert.ok(deleted.ok, JSON.stringify(deleted));
    await owner.sync();
    assert.deepEqual(data<Receipt>(await claim(client, first)), firstReceipt);
    assert.deepEqual(data<Receipt>(await claim(client, requoted)), mcpClaim);
    assert.equal((await balance()).balance, -3);
    const lookup = data<Receipt>(await client.callTool({ name: 'get_operation', arguments: { operationId: first.operationId } }));
    assert.deepEqual(lookup, firstReceipt);
  });
