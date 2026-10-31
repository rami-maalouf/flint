import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as nodeRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe } from 'snapback4/proof';
import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import { createReward } from '../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { accountDirectory } from '../src/accounts/replica';
import type { McpConfig } from '../src/config';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../src/core';
import { FileRestoreLatch } from '../src/operations/recovery-head';
import { startMcpService, type McpService } from '../src/startup';
import { readToolNames } from '../src/tools/reads';
import { authorizeSynthetic, syntheticOAuthClient } from './helpers/oauth';
import { authorizeSyntheticWrite } from './helpers/write-oauth';

type ToolResponse = { isError?: boolean; structuredContent?: unknown };
type Receipt = { operationId: string; state: string; delivery: string; result: { balanceAfterClaim?: number } };
type Quote = { operationId: string; confirmationToken: string; confirmationUrl: string; balance: number; balanceAfterClaim: number };
function data<T>(result: ToolResponse): T {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return (result.structuredContent as { data: T }).data;
}
function error(result: ToolResponse, code: string) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, code);
}
function hidden(html: string, name: string) {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing synthetic form field ${name}`);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function runtime(t: TestContext, initialLatch: 'fresh' | 'missing' = 'fresh') {
  assert.equal(process.version, 'v24.22.2'); assert.equal(process.versions.bun, undefined);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-runtime-writes-')));
  const dataDirectory = join(directory, 'data'), backendDirectory = join(directory, 'backend'), external = join(directory, 'external');
  for (const path of [dataDirectory, backendDirectory, external]) mkdirSync(path, { mode: 0o700 });
  const logsDir = join(directory, 'logs');
  assert.equal((await deploy(backendDirectory, resolve('snapback/schema.q'), { logsDir })).code, 0);
  const host = await startServe(backendDirectory, { logsDir });
  let service: McpService | undefined;
  const clients: Client[] = [];
  const originalFetch = globalThis.fetch;
  const publicOrigin = 'https://habits.runtime.test', backendUrl = 'https://backend.runtime.test';
  t.after(async () => {
    try {
      await Promise.allSettled(clients.map(client => client.close()));
      await service?.close();
    } finally { globalThis.fetch = originalFetch; await host.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
  // scoped synthetic TLS proxy: keep production config and startup APIs unchanged.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === backendUrl) return originalFetch(host.url + url.pathname + url.search, request);
    if (url.origin === publicOrigin) {
      assert.ok(service, 'synthetic listener must exist');
      const headers = new Headers(request.headers); headers.set('host', url.host);
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      return new Promise<Response>((resolve, reject) => {
        const proxy = nodeRequest({ host: '127.0.0.1', port: service!.address.port, path: url.pathname + url.search,
          method: request.method, headers: Object.fromEntries(headers), signal: request.signal, timeout: 5000 }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
          response.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
              else if (value !== undefined) headers.set(name, value);
            }
            resolve(new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode!) ? null : Buffer.concat(chunks),
              { status: response.statusCode!, headers }));
          });
        });
        proxy.on('error', reject); proxy.on('timeout', () => proxy.destroy(new Error('synthetic proxy deadline exceeded'))); proxy.end(body);
      });
    }
    assert.equal(url.origin, new URL(host.url).origin, 'only synthetic loopback traffic is permitted');
    return originalFetch(request);
  };
  const keyFile = join(external, 'keys.json');
  const keys = { version: 1, providerSecret: randomBytes(48).toString('base64'), cursorKey: randomBytes(32).toString('base64'),
    activeVaultKeyVersion: 'v1', vaultKeys: { v1: randomBytes(32).toString('base64') } };
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  const operations = { installationId: randomUUID(), backendDirectory, latchPath: join(external, 'restore-latch') };
  const latchOptions = { path: operations.latchPath, installationId: operations.installationId,
    restoredDirectories: [dataDirectory, backendDirectory] as const };
  if (initialLatch === 'fresh') FileRestoreLatch.provisionFresh(latchOptions);
  const config: McpConfig = { version: 2, publicOrigin, backendUrl, dataDirectory, keyFile, port: 0, operations };
  const start = async (input: McpConfig = config) => {
    service = await startMcpService(input, { allowTestPort: true }); return service;
  };
  const stop = async () => { await service?.close(); service = undefined; };
  await start();
  const ports = createCorePorts('UTC');
  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
  const signed = await signup(host.url, credentials.email, credentials.password); assert.ok(signed.ok);
  const seed = new NodeSqlDatabase(join(directory, 'seed.sqlite'));
  try {
    assert.ok((await initializeProductDatabase(seed, ports.ids, ports.hashing)).ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const deps = { db: seed, ...ports };
    const board = await createBoard(deps, { commandId: randomUUID() as CommandId, title: 'synthetic runtime funding',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok);
    const reward = await createReward(deps, { commandId: randomUUID() as CommandId, title: 'synthetic runtime reward',
      costCoins: 3, symbol: 'star.fill', accentHex: '#70A7FF' }); assert.ok(reward.ok);
    for (let index = 0; index < 4; index++) assert.ok((await createCheckIn(deps,
      { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' })).ok);
    const upstream = createClient({ url: host.url, token: signed.session.token });
    try {
      const transport = createSnapbackTransport({ connection: async () => ({ client: upstream, session: signed.session, isCurrent: () => true }),
        bind: async () => undefined, hash: async value => createHash('sha256').update(value).digest('hex') });
      const result = await runSync({ db: seed, ...ports, transport, random: () => 0.5 });
      assert.ok(result.ok && result.value.status === 'up_to_date', JSON.stringify(result));
    } finally { await upstream.close(); }
    const connect = async (write = true) => {
      const provider = syntheticOAuthClient(`synthetic runtime ${randomUUID()}`);
      const browser = write ? await authorizeSyntheticWrite(publicOrigin + '/mcp', provider, credentials,
        'habits:read coins:read checkins:write rewards:claim offline_access') :
        await authorizeSynthetic(publicOrigin + '/mcp', provider, credentials);
      const client = new Client({ name: 'production-runtime-acceptance', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(publicOrigin + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } },
      }));
      return { client, provider, browser };
    };
    const accountId = createHash('sha256').update(JSON.stringify([backendUrl, signed.session.principal])).digest('hex');
    return { directory, config, keys, start, stop, connect, publicOrigin,
      habitId: board.value.boardId, rewardId: reward.value.rewardId,
      replica: accountDirectory(join(dataDirectory, 'accounts'), accountId),
      markRestored: () => new FileRestoreLatch(latchOptions).markRestored() };
  } finally { await seed.closeAsync(); }
}

test('production v2 composes all 15 SDK tools, scoped grants, durable quotes, confirmation and owner revocation', { timeout: 120_000 }, async t => {
  const f = await runtime(t);
  const writer = await f.connect(), reader = await f.connect(false);
  assert.ok(writer.browser);
  assert.deepEqual((await writer.client.listTools()).tools.map(tool => tool.name).sort(),
    [...readToolNames, 'create_checkin', 'undo_checkin', 'get_operation', 'get_reward_claim_preview', 'claim_reward'].sort());
  error(await reader.client.callTool({ name: 'create_checkin', arguments: {
    operationId: randomUUID(), habitId: f.habitId, timeZone: 'UTC' } }), 'FORBIDDEN');
  const operationId = randomUUID();
  const created = data<Receipt>(await writer.client.callTool({ name: 'create_checkin', arguments: {
    operationId, habitId: f.habitId, timeZone: 'UTC' } }));
  assert.equal(created.state, 'backend_acknowledged');
  const undone = data<Receipt>(await writer.client.callTool({ name: 'undo_checkin', arguments: {
    operationId: randomUUID(), originalOperationId: operationId } })); assert.equal(undone.state, 'backend_acknowledged');
  const quote = data<Quote>(await writer.client.callTool({ name: 'get_reward_claim_preview', arguments: {
    operationId: randomUUID(), rewardId: f.rewardId, timeZone: 'America/Toronto' } }));
  assert.equal(quote.balance, 4); assert.equal(quote.balanceAfterClaim, 1);
  const claim = () => writer.client.callTool({ name: 'claim_reward', arguments: {
    operationId: quote.operationId, confirmationToken: quote.confirmationToken } });
  error(await claim(), 'CONFIRMATION_REQUIRED');
  const keysBefore = readFileSync(f.config.keyFile);
  await f.stop();
  writeFileSync(f.config.keyFile, JSON.stringify({ ...f.keys, cursorKey: randomBytes(32).toString('base64') }));
  await assert.rejects(f.start(), { message: 'MCP service could not start.' });
  writeFileSync(f.config.keyFile, keysBefore);
  await assert.rejects(f.start({ ...f.config, publicOrigin: 'https://changed.runtime.test' }), { message: 'MCP service could not start.' });
  await f.start();
  const response = await fetch(quote.confirmationUrl, { headers: { cookie: writer.browser.cookieHeader() } });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  const cookie = writer.browser.cookieHeader() + '; ' + response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const approved = await fetch(f.publicOrigin + '/mcp/reward-confirmation', { method: 'POST',
    headers: { cookie, origin: f.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: hidden(body, 'token'), csrf: hidden(body, 'csrf'), decision: 'approve' }) });
  assert.equal(approved.status, 200, await approved.clone().text());
  const receipt = data<Receipt>(await claim()); assert.equal(receipt.state, 'backend_acknowledged');
  assert.equal(receipt.result.balanceAfterClaim, 1);
  assert.deepEqual(data<Receipt>(await writer.client.callTool({ name: 'get_operation', arguments: { operationId: quote.operationId } })), receipt);
  assert.deepEqual(readFileSync(f.config.keyFile), keysBefore);
  await f.stop();
  await assert.rejects(f.start({ version: 1, publicOrigin: f.publicOrigin, backendUrl: f.config.backendUrl,
    dataDirectory: f.config.dataDirectory, keyFile: f.config.keyFile, port: 0 }), { message: 'MCP service could not start.' });
  await f.start();
  const connections = await fetch(f.publicOrigin + '/mcp/connections', { headers: { cookie: writer.browser.cookieHeader() } });
  assert.equal(connections.status, 200, await connections.clone().text());
  const card = (await connections.text()).split('<li class="connection-card">')
    .find(part => part.includes(writer.provider.clientInformation()!.client_id)); assert.ok(card);
  const form = /<form[^>]*data-action="revoke"[^>]*>([\s\S]*?)<\/form>/.exec(card)?.[1]; assert.ok(form);
  const disconnected = await fetch(f.publicOrigin + '/mcp/connections', { method: 'POST',
    headers: { origin: f.publicOrigin, cookie: writer.browser.cookieHeader() + '; ' +
      connections.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'revoke', grant_id: hidden(form, 'grant_id'), csrf: hidden(form, 'csrf') }) });
  assert.equal(disconnected.status, 200, await disconnected.clone().text());
  assert.match(await disconnected.text(), /Connection disconnected/);
  const denied = await fetch(f.publicOrigin + '/mcp', { headers: { authorization: `Bearer ${writer.provider.tokens()!.access_token}` } });
  assert.equal(denied.status, 401);
  data(await reader.client.callTool({ name: 'list_habits', arguments: {} }));
});

test('production version 1 keeps exactly the ten read tools and cannot dispatch mutations', { timeout: 120_000 }, async t => {
  const f = await runtime(t);
  await f.stop();
  await f.start({ version: 1, publicOrigin: f.publicOrigin, backendUrl: f.config.backendUrl,
    dataDirectory: f.config.dataDirectory, keyFile: f.config.keyFile, port: 0 });
  const { client } = await f.connect(false);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...readToolNames].sort());
  assert.equal(data<{ balance: number }>(await client.callTool({ name: 'get_coin_balance', arguments: {} })).balance, 4);
  error(await client.callTool({ name: 'create_checkin', arguments: {
    operationId: randomUUID(), habitId: f.habitId, timeZone: 'UTC' } }), 'NOT_FOUND');
  const ready = await fetch(f.publicOrigin + '/mcp/ready'); assert.deepEqual(await ready.json(), { status: 'ready' });
});

test('missing or corrupt external latch keeps runtime writes fenced without provisioning while trusted reads serve', { timeout: 120_000 }, async t => {
  const f = await runtime(t, 'missing');
  assert.equal(existsSync(f.config.operations.latchPath), false);
  const { client } = await f.connect();
  for (const marker of [null, 'synthetic-corrupt-latch']) {
    if (marker !== null) writeFileSync(f.config.operations.latchPath, marker, { mode: 0o600 });
    const ready = await fetch(f.publicOrigin + '/mcp/ready'); assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready', restoreFenced: true });
    data(await client.callTool({ name: 'list_habits', arguments: {} }));
    error(await client.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId: f.habitId, timeZone: 'UTC' } }), 'OPERATION_PENDING');
    assert.equal(existsSync(join(f.replica, 'journal.sqlite')), false);
    assert.equal(data<{ balance: number }>(await client.callTool({ name: 'get_coin_balance', arguments: {} })).balance, 4);
    if (marker === null) assert.equal(existsSync(f.config.operations.latchPath), false);
    else assert.equal(readFileSync(f.config.operations.latchPath, 'utf8'), marker);
  }
});

test('a restore mark after accepted writes fences further effects and owner resume while preserving trusted reads', { timeout: 120_000 }, async t => {
  const f = await runtime(t);
  const { client, browser } = await f.connect(); assert.ok(browser);
  data(await client.callTool({ name: 'create_checkin', arguments: {
    operationId: randomUUID(), habitId: f.habitId, timeZone: 'UTC' } }));
  f.markRestored(); const marked = readFileSync(f.config.operations.latchPath);
  const product = new DatabaseSync(join(f.replica, 'product.sqlite'), { readOnly: true });
  let before: unknown;
  try { before = product.prepare('SELECT COUNT(*) AS count FROM check_ins').get(); } finally { product.close(); }
  await f.stop(); await f.start();
  data(await client.callTool({ name: 'list_habits', arguments: {} }));
  error(await client.callTool({ name: 'create_checkin', arguments: {
    operationId: randomUUID(), habitId: f.habitId, timeZone: 'UTC' } }), 'OPERATION_PENDING');
  const after = new DatabaseSync(join(f.replica, 'product.sqlite'), { readOnly: true });
  try { assert.deepEqual(after.prepare('SELECT COUNT(*) AS count FROM check_ins').get(), before); } finally { after.close(); }
  const shown = await fetch(f.publicOrigin + '/mcp/connections', { headers: { cookie: browser.cookieHeader() } });
  assert.equal(shown.status, 200, await shown.clone().text());
  const form = /<form[^>]*data-action="resume"[^>]*>([\s\S]*?)<\/form>/.exec(await shown.text())?.[1]; assert.ok(form);
  const resume = await fetch(f.publicOrigin + '/mcp/connections', { method: 'POST',
    headers: { cookie: browser.cookieHeader() + '; ' + shown.headers.getSetCookie().map(value => value.split(';')[0]).join('; '),
      origin: f.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'resume', consent: 'all_pending', grant_id: hidden(form, 'grant_id'), csrf: hidden(form, 'csrf') }) });
  assert.equal(resume.status, 409, await resume.clone().text());
  assert.deepEqual(readFileSync(f.config.operations.latchPath), marked);
});
