import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';

import { setICloudSyncEnabled, createBoard } from '../../../src/core/domain/commands.ts';
import type { BoardId, CommandId, RewardId } from '../../../src/core/domain/ids.ts';
import { createReward } from '../../../src/core/domain/reward-commands.ts';
import { initializeProductDatabase } from '../../../src/core/persistence/bootstrap.ts';
import { runSync } from '../../../src/core/sync/engine.ts';
import { createSnapbackTransport } from '../../../src/platform/backend/transport.ts';
import { clockAt, hashing } from '../src/accounts.ts';
import { createApp } from '../src/app.ts';
import { NodeSqlDatabase } from '../src/sqlite.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');

// a disposable snapback server with the app's real schema.
export async function startBackend(t: TestContext) {
  const host = await startDev({ cwd: repoRoot, args: ['--memory', '--no-watch'] });
  t.after(() => host.stop());
  return host.url;
}

export async function createAccount(backendUrl: string) {
  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
  const created = await signup(backendUrl, credentials.email, credentials.password);
  assert.ok(created.ok);
  return { ...credentials, session: created.session };
}

// a phone: its own product replica syncing with the same account through the real core.
export async function createPhone(t: TestContext, backendUrl: string, session: Awaited<ReturnType<typeof createAccount>>['session']) {
  const db = new NodeSqlDatabase();
  t.after(() => db.closeAsync());
  const deps = { db, clock: clockAt('UTC'), ids: { uuid: randomUUID }, hashing };
  assert.ok((await initializeProductDatabase(db, deps.ids, hashing)).ok);
  assert.ok((await setICloudSyncEnabled(deps, { commandId: command(), enabled: true })).ok);
  return {
    db,
    deps,
    async habit(input: { title: string; kind?: 'count' | 'daily'; tracksAmount?: boolean; after?: BoardId }): Promise<BoardId> {
      const result = await createBoard(deps, { commandId: command(), title: input.title, symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: true, tracksAmount: input.tracksAmount ?? false, tracksTime: false, startOfDayMinute: 0,
        metricsEnabled: true, kind: input.kind ?? 'count', earnsCoins: true, coinCapPerDay: 10,
        ...(input.after ? { anchor: { kind: 'board', relation: 'after', boardId: input.after } } : {}) });
      assert.ok(result.ok, JSON.stringify(result));
      return result.value.boardId;
    },
    async reward(title: string, costCoins: number): Promise<RewardId> {
      const result = await createReward(deps, { commandId: command(), title, costCoins, symbol: 'gift.fill', accentHex: '#70A7FF' });
      assert.ok(result.ok, JSON.stringify(result));
      return result.value.rewardId;
    },
    async sync() {
      const client = createClient({ url: backendUrl, token: session.token });
      try {
        const transport = createSnapbackTransport({ connection: async () => ({ client, session, isCurrent: () => true }),
          bind: async () => {}, hash: async text => Buffer.from(await hashing.sha256(new TextEncoder().encode(text))).toString('hex') });
        const result = await runSync({ db, clock: clockAt('UTC'), hashing, transport, random: Math.random });
        assert.ok(result.ok && result.value.status === 'up_to_date', JSON.stringify(result));
      } finally {
        await client.close();
      }
    },
  };
}

export const command = () => randomUUID() as CommandId;

// the mcp service on an ephemeral loopback port, with a private data directory.
export async function startService(t: TestContext, backendUrl: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'flint-mcp-test-'));
  let dispatch: ReturnType<typeof toNodeHandler> | undefined;
  const server = createServer((request, response) => void dispatch?.(request, response));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = { origin, backendUrl, dataDir, host: '127.0.0.1', port: address.port, secret: randomBytes(32).toString('hex') };
  let app = await createApp(config);
  dispatch = toNodeHandler(app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    origin, dataDir,
    // a process restart; `dropReplicas` also loses every account replica, as after restoring an old backup.
    async restart(options: { dropReplicas?: boolean } = {}) {
      await app.close();
      if (options.dropReplicas) rmSync(join(dataDir, 'accounts'), { recursive: true, force: true });
      app = await createApp(config);
      dispatch = toNodeHandler(app);
    },
  };
}

export function oauthClient(name = 'Test assistant') {
  let information: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
  let tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
  let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>;
  let verifier = '';
  let destination: URL | undefined;
  return {
    redirectUrl: 'http://127.0.0.1:49781/callback',
    clientMetadata: { client_name: name, redirect_uris: ['http://127.0.0.1:49781/callback'],
      token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] },
    state: () => randomUUID(),
    clientInformation: () => information,
    saveClientInformation: (value: NonNullable<typeof information>) => { information = value; },
    tokens: () => tokens,
    saveTokens: (value: NonNullable<typeof tokens>) => { tokens = value; },
    saveCodeVerifier: (value: string) => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: (value: URL) => { destination = value; },
    saveDiscoveryState: (value: NonNullable<typeof discovery>) => { discovery = value; },
    discoveryState: () => discovery,
    authorizationUrl: () => destination,
  } satisfies OAuthClientProvider & { authorizationUrl: () => URL | undefined };
}

// a browser with a cookie jar that never follows redirects on its own.
export function browser(origin: string) {
  const cookies = new Map<string, string>();
  const request = async (url: string | URL, init: RequestInit = {}) => {
    const response = await fetch(new URL(url, origin), { redirect: 'manual', ...init,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('=');
      cookies.set(name, value.join('='));
    }
    return response;
  };
  return {
    get: (url: string | URL) => request(url),
    post: (url: string, body: Record<string, string>, from = origin) => request(url, { method: 'POST',
      headers: { origin: from, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }),
  };
}

export function hiddenField(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value !== undefined, `missing form field ${name}`);
  return value.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// the full browser flow a person completes: sign in, review the consent, allow.
export async function authorize(origin: string, provider: ReturnType<typeof oauthClient>,
  credentials: { email: string; password: string }, options: { write?: boolean } = {}) {
  const resource = `${origin}/mcp`;
  assert.equal(await auth(provider, { serverUrl: resource }), 'REDIRECT');
  const page = browser(origin);
  let response = await page.get(provider.authorizationUrl()!);
  assert.ok([302, 303].includes(response.status), await response.clone().text());
  response = await page.get(response.headers.get('location')!);
  assert.equal(response.status, 200);
  let html = await response.text();
  response = await page.post('/mcp/sign-in', { ...credentials, oauth_query: hiddenField(html, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  response = await page.get(response.headers.get('location')!);
  assert.equal(response.status, 200, await response.clone().text());
  html = await response.text();
  response = await page.post('/mcp/consent', { decision: 'allow', oauth_query: hiddenField(html, 'oauth_query'),
    ...(options.write === false ? {} : { write: '1' }) });
  assert.equal(response.status, 303, await response.clone().text());
  const callback = new URL(response.headers.get('location')!);
  assert.equal(callback.searchParams.get('error'), null, callback.href);
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: callback.searchParams.get('code')!,
    iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
  return page;
}

export async function connectClient(t: TestContext, origin: string, provider: ReturnType<typeof oauthClient>,
  capabilities: ConstructorParameters<typeof Client>[1] = {}) {
  const client = new Client({ name: 'flint-test', version: '1.0.0' }, capabilities);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }));
  t.after(() => client.close());
  return client;
}

export async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}
