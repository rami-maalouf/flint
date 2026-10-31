// explicit synthetic acceptance after reviewed production activation.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { login, logout, signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { createBoard, createCheckIn } from '../../../../src/core/domain/commands';
import { createReward } from '../../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../../src/core/domain/ids';
import { createCorePorts, createSnapbackTransport, getCoinTotals, initializeProductDatabase,
  NodeSqlDatabase, runSync } from '../../src/core';
import { contracts, type PublicOperation, type ToolName } from '../../src/tools/contracts';
import { authorizeSynthetic, syntheticOAuthClient } from './oauth';
import { authorizeSyntheticWrite } from './write-oauth';

const origin = 'https://habits.ramimaalouf.com';
const resource = `${origin}/mcp`;
const privateParent = '/Users/rami/Private/habit-system-mcp-rehearsals';
const scope = 'habits:read coins:read checkins:write rewards:claim offline_access';
type Reply = { isError?: boolean; structuredContent?: unknown; content?: unknown[] };
type Session = Extract<Awaited<ReturnType<typeof signup>>, { ok: true }>['session'];
type Quote = { operationId: string; confirmationToken: string; confirmationUrl: string;
  balance: number; balanceAfterClaim: number | null };

function publicOrigin(value: string): void {
  assert.equal(value, origin, 'public proof is restricted to the owned production origin');
}
function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing confirmation field ${name}`);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function refused(reply: Reply, code: string): void {
  assert.equal(reply.isError, true, 'expected a bounded tool refusal');
  assert.equal((reply.structuredContent as { error: { code: string } }).error.code, code);
}
async function call<T>(client: Client, name: ToolName, args: Record<string, unknown> = {}): Promise<T> {
  const reply = await client.callTool({ name, arguments: args });
  assert.equal(reply.isError, undefined, `public ${name} failed`);
  const checked = contracts[name].output.parse(reply.structuredContent);
  const text = reply.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.ok(text.length > 0 && !text.includes('returned the account observation'), 'missing useful result text');
  return checked.data as T;
}
function acknowledged(value: PublicOperation): void {
  assert.equal(value.state, 'backend_acknowledged');
  assert.equal(value.delivery, 'acknowledged');
  assert.equal(value.error, null);
}
async function sync(db: NodeSqlDatabase, session: Session, pullOnly = false): Promise<void> {
  const upstream = createClient({ url: origin, token: session.token, readOnly: session.scope === 'read' });
  try {
    const source = createSnapbackTransport({ connection: async () => ({ client: upstream, session, isCurrent: () => true }),
      bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
    const transport = pullOnly ? { fetchChanges: source.fetchChanges,
      ensureZone: async () => { throw new Error('read-only proof attempted account creation'); },
      upload: async () => { throw new Error('read-only proof attempted upload'); } } : source;
    const result = await runSync({ db, ...createCorePorts('UTC'), transport, random: () => 0.5,
      ...(pullOnly ? { mode: 'pull_only' as const } : {}) });
    assert.ok(result.ok && result.value.status === 'up_to_date', 'public replica sync failed');
  } finally { await upstream.close(); }
}
async function confirmation(quote: Quote, cookie: string): Promise<void> {
  const url = new URL(quote.confirmationUrl);
  publicOrigin(url.origin);
  assert.equal(url.pathname, '/mcp/reward-confirmation');
  const page = await fetch(url, { headers: { cookie }, redirect: 'error' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('3 coins') && html.includes('1 coin'), 'confirmation did not show exact cost and resulting balance');
  const csrfCookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const submit = (csrf?: string) => fetch(url.origin + url.pathname, { method: 'POST', redirect: 'error',
    headers: { origin, cookie: `${cookie}; ${csrfCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: hidden(html, 'token'), ...(csrf === undefined ? {} : { csrf }), decision: 'approve' }) });
  assert.equal((await submit()).status, 403, 'missing CSRF was accepted');
  assert.equal((await submit('invalid')).status, 403, 'forged CSRF was accepted');
  const approved = await submit(hidden(html, 'csrf'));
  assert.equal(approved.status, 200);
  assert.ok((await approved.text()).includes('Reward approved'));
}
async function retireUpstream(session: Session): Promise<void> {
  let accepted = false;
  await logout(origin, session.token, async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });
    accepted = response.ok;
    return response;
  });
  assert.equal(accepted, true, 'upstream retirement was not confirmed');
  const probe = await fetch(`${origin}/probe?scope=1`, { redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(probe.status, 401, 'retired synthetic upstream session remains usable');
}
async function revoke(provider: ReturnType<typeof syntheticOAuthClient>): Promise<void> {
  const token = provider.tokens()?.refresh_token;
  const clientId = provider.clientInformation()?.client_id;
  assert.ok(token && clientId, 'synthetic grant lacks revocation metadata');
  const response = await fetch(`${origin}/mcp/auth/oauth2/revoke`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }) });
  assert.equal(response.status, 200, 'synthetic grant cutoff failed');
}

async function run(): Promise<void> {
  assert.equal(process.version, 'v24.22.2');
  assert.equal(process.versions.bun, undefined);
  assert.equal(process.env.MCP_RELEASE_WRITE_PROOF, 'synthetic-account-only', 'explicit synthetic release proof gate required');
  assert.equal(realpathSync(privateParent), privateParent);
  assert.equal(statSync(privateParent).mode & 0o077, 0);
  const health = await fetch(`${resource}/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, 'reviewed MCP release is not active');
  const root = mkdtempSync(join(privateParent, 'public-release-'));
  const closers: (() => void | Promise<void>)[] = [];
  const evidence: Record<string, unknown> = { origin, node: process.version, sdk: '2.4.0', ok: false };
  let failure: unknown, failed = false;
  try {
    const credentials = { email: `mcp-release-${randomUUID()}@example.test`, password: randomBytes(32).toString('base64url') };
    writeFileSync(join(root, 'synthetic-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
    const signed = await signup(origin, credentials.email, credentials.password);
    assert.ok(signed.ok, 'synthetic account creation failed');
    closers.push(() => retireUpstream(signed.session));
    const ports = createCorePorts('UTC');
    const seed = new NodeSqlDatabase(join(root, 'seed.sqlite'));
    closers.unshift(() => seed.closeAsync());
    assert.ok((await initializeProductDatabase(seed, ports.ids, ports.hashing)).ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const deps = { db: seed, ...ports };
    const habit = await createBoard(deps, { commandId: randomUUID() as CommandId, title: 'synthetic mcp release proof',
      symbol: 'star.fill', accentHex: '#FFFFFF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(habit.ok);
    const reward = await createReward(deps, { commandId: randomUUID() as CommandId,
      title: 'synthetic release reward', costCoins: 3, symbol: 'star.fill', accentHex: '#FFFFFF' });
    assert.ok(reward.ok);
    for (let i = 0; i < 4; i++) assert.ok((await createCheckIn(deps,
      { commandId: randomUUID() as CommandId, boardId: habit.value.boardId, source: 'app' })).ok);
    await sync(seed, signed.session);
    const connect = async (provider: ReturnType<typeof syntheticOAuthClient>) => {
      const client = new Client({ name: 'synthetic-public-release', version: '1' });
      closers.unshift(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } } }));
      return client;
    };
    const reader = syntheticOAuthClient('synthetic public release read');
    await authorizeSynthetic(resource, reader, credentials);
    closers.unshift(() => revoke(reader));
    const readClient = await connect(reader);
    const habitId = habit.value.boardId;
    const observed = await call<{ id: string }>(readClient, 'get_habit', { habitId });
    assert.equal(observed.id, habitId);
    refused(await readClient.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId, timeZone: 'UTC' } }), 'FORBIDDEN');
    const writer = syntheticOAuthClient('synthetic public release write');
    const browser = await authorizeSyntheticWrite(resource, writer, credentials, scope);
    closers.unshift(() => revoke(writer));
    const client = await connect(writer);
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), Object.keys(contracts).sort());
    const balance = () => call<{ balance: number }>(client, 'get_coin_balance');
    assert.equal((await balance()).balance, 4);
    const operationId = randomUUID();
    const created = await call<PublicOperation>(client, 'create_checkin', { operationId, habitId, timeZone: 'UTC' });
    acknowledged(created);
    assert.ok(created.result && 'created' in created.result && created.result.created);
    const checkinId = created.result.checkinId;
    assert.deepEqual(await call(client, 'create_checkin', { operationId, habitId, timeZone: 'UTC' }), created);
    assert.deepEqual(await call(client, 'get_operation', { operationId }), created);
    assert.equal((await balance()).balance, 5);
    const undo = await call<PublicOperation>(client, 'undo_checkin', { operationId: randomUUID(), originalOperationId: operationId });
    acknowledged(undo);
    assert.equal((await balance()).balance, 4);
    const quote = await call<Quote>(client, 'get_reward_claim_preview', {
      operationId: randomUUID(), rewardId: reward.value.rewardId, timeZone: 'UTC' });
    assert.equal(quote.balance, 4); assert.equal(quote.balanceAfterClaim, 1);
    refused(await client.callTool({ name: 'claim_reward', arguments: {
      operationId: quote.operationId, confirmationToken: quote.confirmationToken } }), 'CONFIRMATION_REQUIRED');
    await confirmation(quote, browser.cookieHeader());
    assert.equal((await balance()).balance, 4, 'browser approval spent coins');
    const claimArgs = { operationId: quote.operationId, confirmationToken: quote.confirmationToken };
    const claimed = await call<PublicOperation>(client, 'claim_reward', claimArgs);
    acknowledged(claimed);
    assert.deepEqual(await call(client, 'claim_reward', claimArgs), claimed);
    assert.equal((await balance()).balance, 1);
    const independent = new NodeSqlDatabase(join(root, 'second-replica.sqlite'));
    closers.unshift(() => independent.closeAsync());
    assert.ok((await initializeProductDatabase(independent, ports.ids, ports.hashing)).ok);
    await independent.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const readSession = await login(origin, credentials.email, credentials.password, { scope: 'read' });
    assert.ok(readSession.ok);
    closers.push(() => retireUpstream(readSession.session));
    await sync(independent, readSession.session, true);
    const totals = await getCoinTotals({ db: independent, ...createCorePorts('UTC') });
    assert.ok(totals.ok);
    assert.deepEqual(totals.value, { earned: 5, spent: 4, balance: 1 });
    assert.equal((await independent.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM check_ins WHERE board_id = ? AND deleted_at IS NULL', [habitId]))?.count, 4);
    assert.equal((await independent.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM check_ins WHERE board_id = ?', [habitId]))?.count, 5);
    const undone = await independent.getFirstAsync<{ deleted_at: number | null }>(
      'SELECT deleted_at FROM check_ins WHERE id = ?', [checkinId]);
    assert.equal(typeof undone?.deleted_at, 'number');
    const ledger = await independent.getAllAsync<{ kind: string; count: number; delta: number }>(
      'SELECT kind, COUNT(*) AS count, SUM(delta) AS delta FROM coin_ledger GROUP BY kind ORDER BY kind');
    assert.deepEqual(ledger.map(row => ({ ...row })), [{ kind: 'check', count: 5, delta: 5 }, { kind: 'claim', count: 1, delta: -3 },
      { kind: 'reversal', count: 1, delta: -1 }]);
    assert.ok(claimed.result && 'ledgerEntryId' in claimed.result);
    const claimEntry = await independent.getFirstAsync<{ kind: string; delta: number; reward_id: string }>(
      'SELECT kind, delta, reward_id FROM coin_ledger WHERE id = ?', [claimed.result.ledgerEntryId]);
    assert.deepEqual({ ...claimEntry }, { kind: 'claim', delta: -3, reward_id: reward.value.rewardId },
      'claim receipt must identify the exact reward debit');
    const checkEntries = await independent.getAllAsync<{ id: string; delta: number }>(
      "SELECT id, delta FROM coin_ledger WHERE kind = 'check' AND check_in_id = ?", [checkinId]);
    assert.equal(checkEntries.length, 1, 'created check-in must earn exactly one coin entry');
    assert.equal(checkEntries[0].delta, 1);
    const reversal = await independent.getFirstAsync<{ reverses_id: string; delta: number }>(
      "SELECT reverses_id, delta FROM coin_ledger WHERE kind = 'reversal'");
    assert.deepEqual({ ...reversal }, { reverses_id: checkEntries[0].id, delta: -1 },
      'undo must reverse the created check-in coin entry');
    await revoke(writer);
    await assert.rejects(() => client.callTool({ name: 'get_habit', arguments: { habitId } }));
    assert.equal((await call<{ id: string }>(readClient, 'get_habit', { habitId })).id, habitId);
    evidence.toolCount = catalog.tools.length;
    evidence.checkinReplay = true; evidence.undo = true; evidence.approvedClaimReplay = true;
    evidence.balance = 1; evidence.readWriteRefusal = true; evidence.secondReadOnlyReplica = true;
    evidence.writeRevocation = true; evidence.independentReadPreserved = true;
    evidence.earned = 5; evidence.spent = 4; evidence.csrfRefusals = true;
  } catch (cause) { failure = cause; failed = true; }
  const cleanupErrors: unknown[] = [];
  for (const close of closers) try { await close(); } catch (cause) { cleanupErrors.push(cause); }
  evidence.ok = !failed && cleanupErrors.length === 0;
  evidence.cleanupErrors = cleanupErrors.length;
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (failed || cleanupErrors.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'public synthetic release proof failed');
  process.stdout.write(JSON.stringify({ evidence: join(root, 'evidence.json'), ...evidence }) + '\n');
}

if (process.argv[2] === 'self-check') {
  publicOrigin(origin);
  assert.throws(() => publicOrigin('http://127.0.0.1:4410'));
  assert.throws(() => publicOrigin('https://other.invalid'));
  assert.equal(hidden('<input name="csrf" value="a&amp;b">', 'csrf'), 'a&b');
  process.stdout.write('public release local guards passed\n');
} else if (process.argv[2] === 'run') {
  process.umask(0o077);
  await run();
} else {
  // no network or account mutation occurs without the explicit run command and environment gate.
  assert.equal(process.argv[2], 'self-check', 'expected self-check or run');
}
