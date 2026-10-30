import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import { createReward } from '../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { AccountActors } from '../src/accounts/actor';
import { createAuthorizationService } from '../src/auth/provider';
import { CredentialVault } from '../src/auth/vault';
import { createCorePorts, initializeProductDatabase, NodeSqlDatabase, createSnapbackTransport, runSync } from '../src/core';
import { createHttpService } from '../src/http';
import { CursorCodec } from '../src/tools/cursors';
import { ReadTools, readToolNames } from '../src/tools/reads';
import { authorizeSynthetic, syntheticOAuthClient } from './helpers/oauth';

test('the loopback reverse proxy uses a fixed public origin without trusting forwarded host or scheme', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-origin-'));
  const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
  const authorization = await createAuthorizationService({ publicOrigin: 'https://habits.example.test',
    backendUrl: 'https://backend.example.test', databasePath: join(directory, 'provider.sqlite'), secret: randomBytes(48).toString('hex'), vault });
  const http = createHttpService({ authorization, reads: {} as ReadTools });
  t.after(async () => { await http.close(); await authorization.close(); vault.close(); rmSync(directory, { recursive: true, force: true }); });
  const metadata = await http.fetch(new Request('http://habits.example.test/.well-known/oauth-protected-resource/mcp',
    { headers: { host: 'habits.example.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'http' } }));
  assert.equal(metadata.status, 200, await metadata.clone().text());
  assert.equal((await metadata.json() as { resource: string }).resource, 'https://habits.example.test/mcp');
  assert.equal((await http.fetch(new Request('http://attacker.test/mcp'))).status, 403);
  assert.equal((await http.fetch(new Request('http://habits.example.test/mcp', { headers: { host: 'attacker.test' } }))).status, 403);
});

test('real OAuth + HTTP MCP reads isolate two accounts, paginate history and retain read-only upstream authority', { timeout: 120_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-http-reads-'));
  const host = await startDev({ cwd: resolve('.'), logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
  const server = createServer((request, response) => dispatch(request, response));
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const publicOrigin = `http://127.0.0.1:${address.port}`;
  const backendUrl = 'https://snapback.synthetic.test';
  const traffic: string[] = [];
  let offline = false;
  const backendFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, backendUrl); traffic.push(url.pathname);
    if (offline) return Promise.reject(new Error('synthetic network outage'));
    return fetch(host.url + url.pathname + url.search, input instanceof Request ? input : init);
  };
  mkdirSync(join(directory, 'accounts'), { mode: 0o700 });
  const accounts = new AccountActors({ root: join(directory, 'accounts'), backendUrl, fetch: backendFetch });
  const authorization = await createAuthorizationService({ publicOrigin, backendUrl, databasePath: join(directory, 'provider.sqlite'),
    secret: randomBytes(48).toString('hex'), vault, identityOptions: { fetch: backendFetch }, allowTestLoopback: true });
  const reads = new ReadTools({ accounts, cursors: new CursorCodec(randomBytes(32)) });
  const http = createHttpService({ authorization, reads });
  dispatch = toNodeHandler(http);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await http.close(); await accounts.close(); await authorization.close(); vault.close(); await host.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const credentials = [0, 1].map(() => ({ email: `${randomUUID()}@example.test`, password: randomUUID() }));
  let habitId = '';
  for (const [index, input] of credentials.entries()) {
    const result = await signup(host.url, input.email, input.password); assert.ok(result.ok);
    const seed = new NodeSqlDatabase(join(directory, `seed-${index}.sqlite`));
    const ports = createCorePorts('UTC');
    assert.ok((await initializeProductDatabase(seed, ports.ids, ports.hashing)).ok);
    const deps = { db: seed, ...ports };
    const board = await createBoard(deps, { commandId: randomUUID() as CommandId, title: `synthetic account ${index}`,
      symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false, tracksAmount: false,
      amountUnit: null, quickAmount: 1, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    assert.ok(board.ok); if (index === 0) habitId = board.value.boardId;
    assert.ok((await createReward(deps, { commandId: randomUUID() as CommandId, title: 'synthetic reward', costCoins: 1,
      symbol: 'star.fill', accentHex: '#78D98B' })).ok);
    if (index === 0) for (let count = 0; count < 105; count++) assert.ok((await createCheckIn(deps,
      { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app', note: 'synthetic private note' })).ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1 WHERE id = 1');
    const client = createClient({ url: host.url, token: result.session.token });
    const transport = createSnapbackTransport({ connection: async () => ({ client, session: result.session, isCurrent: () => true }),
      bind: async () => {}, hash: async text => Buffer.from(await ports.hashing.sha256(new TextEncoder().encode(text))).toString('hex') });
    const synced = await runSync({ ...deps, transport, random: () => 0.5 });
    assert.ok(synced.ok && synced.value.status === 'up_to_date', JSON.stringify(synced));
    await client.close(); await seed.closeAsync();
  }
  traffic.length = 0;
  for (const [index, input] of credentials.entries()) {
    const provider = syntheticOAuthClient(`synthetic read ${index}`);
    await authorizeSynthetic(authorization.resource, provider, input, 'habits:read coins:read offline_access');
    for (const revision of ['2026-07-28', '2025-11-25'] as const) {
      const client = new Client({ name: 'mcp-read-integration', version: '1' }, {
        versionNegotiation: { mode: revision === '2025-11-25' ? 'legacy' : { pin: revision } },
      });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(authorization.resource), {
        requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } },
      }));
      const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...readToolNames].sort());
      const schema = tools.tools.find(tool => tool.name === 'list_habits')!.inputSchema;
      assert.equal(schema.additionalProperties, false);
      for (const arguments_ of [{ limit: 101 }, { owner: 'another-account' }, { limit: 'private SQL token' }]) {
        const invalid = await client.callTool({ name: 'list_habits', arguments: arguments_ });
        assert.equal(invalid.isError, true);
        assert.equal((invalid.structuredContent as { error: { code: string } } | undefined)?.error.code, 'INVALID_INPUT');
        assert.ok(!JSON.stringify(invalid).includes('private SQL token'));
      }
      const listed = await client.callTool({ name: 'list_habits', arguments: {} });
      assert.equal(listed.isError, undefined, JSON.stringify(listed));
      const data = listed.structuredContent as { data: { items: { id: string; title: string }[] } };
      assert.equal(data.data.items[0].title, `synthetic account ${index}`);
      const balance = await client.callTool({ name: 'get_coin_balance', arguments: {} }); assert.ok(!balance.isError);
      for (const [name, arguments_] of [
        ['get_habit', { habitId: data.data.items[0].id }],
        ['get_today', { timeZone: 'America/Toronto' }], ['list_stacks', { timeZone: 'America/Toronto' }],
        ['get_stack', { rootHabitId: data.data.items[0].id, timeZone: 'America/Toronto' }],
        ['get_sync_status', {}], ['get_coin_history', {}], ['list_rewards', {}],
      ] as const) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.ok(!result.isError, JSON.stringify({ name, result }));
      }
      if (index === 0) {
        const first = await client.callTool({ name: 'get_checkin_history', arguments: { habitId, limit: 100 } });
        const page = first.structuredContent as { data: { items: object[]; nextCursor: string } };
        assert.equal(page.data.items.length, 100);
        assert.ok(page.data.items.every(row => !Object.hasOwn(row, 'note')));
        const next = await client.callTool({ name: 'get_checkin_history', arguments: { habitId, cursor: page.data.nextCursor } });
        assert.equal((next.structuredContent as typeof page).data.items.length, 5);
      } else {
        const foreign = await client.callTool({ name: 'get_habit', arguments: { habitId } });
        assert.equal(foreign.isError, true);
        assert.equal((foreign.structuredContent as { error: { code: string } }).error.code, 'NOT_FOUND');
      }
    }
  }
  assert.ok(traffic.length > 0);
  assert.ok(traffic.every(path => !path.startsWith('/m/') && !path.startsWith('/a/')), traffic.join(','));
  const restrictedProvider = syntheticOAuthClient('synthetic coins only');
  await authorizeSynthetic(authorization.resource, restrictedProvider, credentials[0], 'coins:read offline_access');
  const restricted = new Client({ name: 'restricted-read', version: '1' }); clients.push(restricted);
  await restricted.connect(new StreamableHTTPClientTransport(new URL(authorization.resource), {
    requestInit: { headers: { authorization: `Bearer ${restrictedProvider.tokens()!.access_token}` } },
  }));
  const denied = await restricted.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'FORBIDDEN');
  offline = true;
  const fullRead = clients.at(-2)!;
  const required = await fullRead.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(required.isError, true);
  const cached = await fullRead.callTool({ name: 'list_habits', arguments: { freshness: 'allow_cached' } });
  assert.ok(!cached.isError, JSON.stringify(cached));
  assert.equal((cached.structuredContent as { meta: { usedCached: boolean } }).meta.usedCached, true);
  offline = false;
  assert.equal((await fetch(authorization.resource)).status, 401);
  assert.equal((await fetch(authorization.resource, { headers: { origin: 'https://evil.test' } })).status, 403);
});
