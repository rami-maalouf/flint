import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { auth as sdkAuthorize, Client, StreamableHTTPClientTransport,
  discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata,
  type OAuthClientProvider } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, requireBearerAuth, requireScopes } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { createClient, type Client as SnapbackClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { api } from '../../../snapback/generated/api.ts';
import { createAuthorizationService } from '../src/auth/provider';
import { GrantStore, authorizationScopes, writeScopes } from '../src/auth/grants';
import { CredentialVault } from '../src/auth/vault';
import type { AuthContext } from '../src/auth/context';

type RestartInput = { publicOrigin: string; backendUrl: string; databasePath: string; secret: string;
  vaultPath: string; vaultKey: string; accessToken: string; writeConnections?: boolean };
type CrashInput = { databasePath: string; vaultPath: string; vaultKey: string };
if (process.env.MCP_AUTH_GRANT_CRASH_CHILD === '1') {
  process.once('message', (input: CrashInput) => {
    const database = new DatabaseSync(input.databasePath);
    const vault = new CredentialVault({ location: input.vaultPath, activeKeyVersion: 'v1',
      keys: new Map([['v1', Buffer.from(input.vaultKey, 'hex')]]) });
    const put = vault.put.bind(vault);
    vault.put = (grantBinding, session) => {
      put(grantBinding, session);
      if (grantBinding.scope === 'full') process.kill(process.pid, 'SIGKILL');
    };
    const grants = new GrantStore(database, vault, [...authorizationScopes, ...writeScopes]);
    const account = { accountId: 'crash-account', backendUrl: 'https://snapback.synthetic.test', principal: 'crash-user' };
    const expiresAt = Date.now() + 600_000;
    grants.stage('crash-session', 'crash-user-id', { ...account,
      session: { kind: 'user', principal: account.principal, token: 'read-crash-token', scope: 'read', expiresAt } });
    grants.connect('crash-session', 'crash-user-id', 'crash-client', ['checkins:write'], { ...account,
      session: { kind: 'user', principal: account.principal, token: 'full-crash-token', scope: 'full', expiresAt } });
  });
}
if (process.env.MCP_AUTH_RESTART_CHILD === '1') {
  process.once('message', async (input: RestartInput) => {
    const vault = new CredentialVault({ location: input.vaultPath, activeKeyVersion: 'v1', keys: new Map([['v1', Buffer.from(input.vaultKey, 'hex')]]) });
    const service = await createAuthorizationService({ ...input, vault, allowTestLoopback: true,
      writeConnections: input.writeConnections ? { revoke: async (_grant, commit) => commit() } : undefined });
    try {
      const context = await service.authenticate(new Request(service.resource, { headers: { authorization: `Bearer ${input.accessToken}` } }));
      process.send?.({ accountId: context.accountId, grantId: context.grantId,
        upstreamHash: createHash('sha256').update(context.session.token).digest('hex'),
        jwks: await (await service.handler(new Request(input.publicOrigin + '/mcp/auth/jwks'))).json(),
        ...(input.writeConnections ? { upstreamScope: context.session.scope, scopes: context.scopes } : {}) });
    } finally { await service.close(); vault.close(); process.disconnect(); }
  });
}

if (!process.env.MCP_AUTH_RESTART_CHILD && !process.env.MCP_AUTH_GRANT_CRASH_CHILD)
  test('authorization requires a fixed canonical origin and externally supplied secrets', async () => {
  await assert.rejects(createAuthorizationService({ publicOrigin: 'http://attacker.test' } as never));
});

if (!process.env.MCP_AUTH_RESTART_CHILD && !process.env.MCP_AUTH_GRANT_CRASH_CHILD)
  test('a killed process after full custody leaves an inactive grant that startup tombstones', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-grant-crash-'));
    const databasePath = join(directory, 'provider.sqlite');
    const vaultPath = join(directory, 'vault.sqlite');
    const vaultKey = randomBytes(32).toString('hex');
    const child = fork(new URL(import.meta.url), [], { execPath: process.execPath,
      env: { ...process.env, MCP_AUTH_GRANT_CRASH_CHILD: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const liveFull = () => {
      const database = new DatabaseSync(vaultPath);
      try { return (database.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL")
        .get() as { n: number }).n; } finally { database.close(); }
    };
    try {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
      child.send({ databasePath, vaultPath, vaultKey } satisfies CrashInput);
      assert.deepEqual(await exited, [null, 'SIGKILL']);
      const database = new DatabaseSync(databasePath);
      const vault = new CredentialVault({ location: vaultPath, activeKeyVersion: 'v1',
        keys: new Map([['v1', Buffer.from(vaultKey, 'hex')]]) });
      try {
        const stored = database.prepare('SELECT active, credential_scope FROM mcp_grants').all();
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.active, 0);
        assert.equal(stored[0]?.credential_scope, 'full');
        assert.equal(liveFull(), 1);
        const grants = new GrantStore(database, vault, [...authorizationScopes, ...writeScopes]);
        assert.equal(grants.lookupSession('crash-session')?.active, false);
        assert.equal(liveFull(), 0);
      } finally { database.close(); vault.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });

if (!process.env.MCP_AUTH_RESTART_CHILD && !process.env.MCP_AUTH_GRANT_CRASH_CHILD)
  test('private M07 metadata migrates to explicit read custody', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-grant-migration-'));
    const database = new DatabaseSync(join(directory, 'provider.sqlite'));
    const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1',
      keys: new Map([['v1', randomBytes(32)]]) });
    try {
      database.exec(`CREATE TABLE mcp_pending (
        session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL,
        user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE mcp_grants (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL,
        user_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, lineage TEXT NOT NULL,
        scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`);
      const expiresAt = Date.now() + 600_000;
      database.prepare('INSERT INTO mcp_pending VALUES (?, ?, ?, ?, ?, ?, 0)').run('old-pending', 'old-account',
        'https://snapback.synthetic.test', 'old-user', 'old-user-id', expiresAt);
      database.prepare('INSERT INTO mcp_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run('old-grant',
        'old-account', 'https://snapback.synthetic.test', 'old-user', 'old-user-id', 'old-client',
        'old-session', 'old-lineage', JSON.stringify(['habits:read']), expiresAt);
      vault.put({ backend: 'https://snapback.synthetic.test', principal: 'old-user', accountId: 'old-account',
        grantId: 'old-grant', scope: 'read' }, { principal: 'old-user', kind: 'user', token: 'old-read-token',
        expiresAt, scope: 'read' });
      const grants = new GrantStore(database, vault);
      assert.equal(grants.active('old-grant').credentialScope, 'read');
      assert.equal(database.prepare('SELECT credential_scope FROM mcp_pending WHERE session_id = ?').get('old-pending')?.credential_scope,
        'read');
      assert.equal(database.prepare('SELECT credential_scope FROM mcp_grants WHERE id = ?').get('old-grant')?.credential_scope,
        'read');
    } finally { database.close(); vault.close(); await rm(directory, { recursive: true, force: true }); }
  });

if (!process.env.MCP_AUTH_RESTART_CHILD && !process.env.MCP_AUTH_GRANT_CRASH_CHILD)
  test('malformed custody cannot match read permissions or pass private schema admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-malformed-custody-'));
    const validDatabase = new DatabaseSync(join(directory, 'valid.sqlite'));
    const malformedDatabase = new DatabaseSync(join(directory, 'malformed.sqlite'));
    const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1',
      keys: new Map([['v1', randomBytes(32)]]) });
    try {
      const grants = new GrantStore(validDatabase, vault);
      malformedDatabase.exec(`CREATE TABLE mcp_grants (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, backend TEXT NOT NULL, principal TEXT NOT NULL,
        user_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, lineage TEXT NOT NULL,
        scopes TEXT NOT NULL, credential_scope TEXT NOT NULL DEFAULT 'read',
        expires_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`);
      const expiresAt = Date.now() + 600_000;
      malformedDatabase.prepare('INSERT INTO mcp_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run('malformed-grant', 'account', 'https://snapback.synthetic.test', 'principal', 'user', 'client',
          'session', 'lineage', JSON.stringify(['habits:read']), 'unknown', expiresAt);
      const stored = malformedDatabase.prepare('SELECT credential_scope FROM mcp_grants WHERE id = ?')
        .get('malformed-grant') as { credential_scope: 'read' };
      const metadata = { grantId: 'malformed-grant', accountId: 'account', backendUrl: 'https://snapback.synthetic.test',
        principal: 'principal', userId: 'user', clientId: 'client', sessionId: 'session', operationLineageId: 'lineage',
        scopes: ['habits:read'], credentialScope: stored.credential_scope, expiresAt, active: true };
      assert.equal(grants.permissionsMatch(metadata), false);
      malformedDatabase.prepare('UPDATE mcp_grants SET credential_scope = ? WHERE id = ?').run('read', 'malformed-grant');
      assert.throws(() => new GrantStore(malformedDatabase, vault), /Authorization is unavailable/);
    } finally {
      validDatabase.close(); malformedDatabase.close(); vault.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

function oauthClient(name: string) {
  let information: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
  let tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
  let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>;
  let verifier = '';
  let authorizationUrl = new URL('https://unset.invalid');
  const provider = {
    redirectUrl: 'http://127.0.0.1:49781/callback',
    clientMetadata: { client_name: name, redirect_uris: ['http://127.0.0.1:49781/callback'],
      token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] },
    state: () => randomUUID(), clientInformation: () => information,
    saveClientInformation: (value: NonNullable<typeof information>) => { information = value; },
    tokens: () => tokens, saveTokens: (value: NonNullable<typeof tokens>) => { tokens = value; },
    saveCodeVerifier: (value: string) => { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization: (value: URL) => { authorizationUrl = value; },
    saveDiscoveryState: (value: NonNullable<typeof discovery>) => { discovery = value; }, discoveryState: () => discovery,
  } satisfies OAuthClientProvider;
  return { ...provider, forgetTokens() { tokens = undefined; }, get authorizationUrl() { return authorizationUrl; } };
}
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!);
const hidden = (body: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
  assert.ok(value, `missing ${name} field`); return decode(value);
};

if (!process.env.MCP_AUTH_RESTART_CHILD && !process.env.MCP_AUTH_GRANT_CRASH_CHILD)
  test('production browser provider binds independent read grants over real SDK, SQLite and Snapback HTTP', { timeout: 120_000 }, async t => {
  assert.equal(process.versions.node, '24.22.2');
  const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-http-auth-'));
  const host = await startDev({ cwd: resolve('.'), logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const snapbackClients: SnapbackClient[] = [];
  const sdkClients: Client[] = [];
  const secret = randomBytes(48).toString('hex');
  let vaultNow: number | undefined;
  const vaultConfig = { location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]),
    nowUtcMs: () => vaultNow ?? Date.now() };
  let vault = new CredentialVault(vaultConfig);
  let service: Awaited<ReturnType<typeof createAuthorizationService>>;
  const server = createServer((req, res) => dispatch(req, res));
  let dispatch: ReturnType<typeof toNodeHandler> = async (_req, res) => { res.writeHead(503); res.end(); };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    try {
      await Promise.all(sdkClients.map(client => client.close()));
      await Promise.all(snapbackClients.map(client => client.close()));
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await service?.close(); vault.close(); await host.stop();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const backendTraffic: string[] = [];
  const backendFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://snapback.synthetic.test');
    backendTraffic.push(url.pathname);
    return fetch(host.url + url.pathname + url.search, init);
  };
  const config = { publicOrigin: origin, backendUrl: 'https://snapback.synthetic.test', databasePath: join(directory, 'provider.sqlite'),
    secret, vault, allowTestLoopback: true, identityOptions: { fetch: backendFetch } };
  const writeEvents: { phase: 'before' | 'after'; grantId: string; active: boolean; scope: string[] }[] = [];
  let failCoordination = false;
  let writeConnections: { revoke: (grant: { grantId: string; accountId: string; scopes: readonly string[] },
    commitRevocation: () => Promise<void>) => Promise<void> } | undefined;
  const start = async (accessTokenExpiresIn = 300) => {
    service = await createAuthorizationService({ ...config, vault, accessTokenExpiresIn, writeConnections });
    const gate = requireBearerAuth({ expectedResource: new URL(service.resource), resourceMetadataUrl: service.resourceMetadataUrl,
      verifier: { async verifyAccessToken(token) {
        try {
          return await service.verifyAccessToken(token);
        } catch { throw new OAuthError(OAuthErrorCode.InvalidToken, 'Connection refused'); }
      } } });
    const mcpHandler = createMcpHandler(context => {
      const mcpServer = new McpServer({ name: 'synthetic-read-profile', version: '1' });
      const current = context.authInfo?.extra?.authContext as AuthContext;
      mcpServer.registerTool('read_profile', { scopeChallenge: requireScopes('habits:read') }, async () => {
        await current.assertActive();
        const client = createClient({ url: host.url, token: current.session.token, readOnly: true });
        snapbackClients.push(client);
        const profile = await client.query(api.profile, {});
        assert.ok(!('denied' in profile)); await current.assertActive();
        return { content: [{ type: 'text', text: JSON.stringify(profile.data) }] };
      });
      mcpServer.registerTool('read_notes', { scopeChallenge: requireScopes('habits:notes:read') }, async () => ({ content: [{ type: 'text', text: 'notes allowed' }] }));
      return mcpServer;
    }, { legacy: 'reject' });
    dispatch = toNodeHandler({ async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') return service.handler(request);
      const admitted = await gate(request);
      return admitted instanceof Response ? admitted : mcpHandler.fetch(request, { authInfo: admitted });
    } });
  };
  const request = (path: string | URL, init: RequestInit = {}) => fetch(new URL(path, origin), { redirect: 'manual', ...init });
  class Browser {
    cookies = new Map<string, string>();
    get cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
    async request(path: string | URL, init: RequestInit = {}) {
      const response = await request(path, { ...init, headers: { accept: 'text/html', cookie: this.cookie, ...init.headers } });
      for (const cookie of response.headers.getSetCookie()) {
        const [name, ...value] = cookie.split(';')[0]!.split('='); this.cookies.set(name!, value.join('='));
      }
      return response;
    }
    async submit(path: string | URL, body: Record<string, string>, headers: Record<string, string> = {}) {
      return this.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...headers },
        body: new URLSearchParams(body) });
    }
  }
  const accounts = [0, 1].map(() => ({ email: randomUUID() + '@example.test', password: randomUUID() }));
  const principals: string[] = [];
  for (const account of accounts) {
    const result = await signup(host.url, account.email, account.password); assert.ok(result.ok);
    principals.push(result.session.principal);
    if (account === accounts[1]) {
      const client = createClient({ url: host.url, token: result.session.token }); snapbackClients.push(client);
      assert.equal((await client.mutate(api.saveProfile, { name: 'Synthetic initialized account' })).state, 'sent');
    }
  }
  await start();
  const connect = async (provider: ReturnType<typeof oauthClient>) => {
    const client = new Client({ name: 'm07-http-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    sdkClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.resource), {
      requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } },
    }));
    return client;
  };
  const begin = async (provider: ReturnType<typeof oauthClient>, scope = 'habits:read offline_access') => {
    assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource, scope }), 'REDIRECT');
    return provider.authorizationUrl;
  };
  const authorize = async (provider: ReturnType<typeof oauthClient>, account: typeof accounts[number], browser = new Browser(), accept = true,
    scope = 'habits:read offline_access', exchange = true) => {
    const url = await begin(provider, scope);
    let response = await browser.request(url);
    let location = response.headers.get('location');
    assert.ok(location, `authorize status ${response.status}: ${await response.text()}`);
    response = await browser.request(new URL(location, origin));
    assert.equal(response.status, 200, await response.clone().text());
    let body = await response.text();
    if (new URL(location, origin).pathname === '/mcp/sign-in') {
      response = await browser.submit('/mcp/sign-in', { ...account, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
      assert.equal(response.status, 303, await response.clone().text());
      location = response.headers.get('location'); assert.ok(location);
      response = await browser.request(location); assert.equal(response.status, 200, await response.clone().text());
      body = await response.text();
    }
    const write = scope.includes('checkins:write') || scope.includes('rewards:claim');
    assert.ok(body.includes(write ? 'Confirm and allow' : 'Allow connection'));
    assert.equal(response.headers.get('content-security-policy')?.split(';').map(value => value.trim())
      .find(value => value.startsWith('form-action ')), `form-action 'self' ${new URL(provider.redirectUrl).origin}`,
    'consent must permit the provider-validated callback after a Chromium form redirect');
    response = await browser.submit('/mcp/consent', { decision: accept ? 'allow' : 'deny', ...(write && accept ? account : {}),
      csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
    assert.equal(response.status, 303, await response.clone().text());
    const callback = new URL(response.headers.get('location')!);
    if (accept && exchange) {
      assert.equal(callback.searchParams.get('error'), null, callback.href);
      assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource, authorizationCode: callback.searchParams.get('code')!,
        iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
    }
    return { browser, callback };
  };
  const alice = oauthClient('Synthetic app A');
  const bob = oauthClient('Synthetic app B');
  let shared: Browser;
  let aliceContext: AuthContext;
  const contextFor = (provider: ReturnType<typeof oauthClient>) => service.authenticate(new Request(service.resource,
    { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } }));
  await t.test('SDK metadata, S256, empty account and an initialized second account complete actual consent and reads', async () => {
    const challenge = await request('/mcp'); assert.equal(challenge.status, 401);
    assert.ok(challenge.headers.get('www-authenticate')?.includes(service.resourceMetadataUrl));
    const resource = await discoverOAuthProtectedResourceMetadata(new URL(service.resource)); assert.equal(resource.resource, service.resource);
    const metadata = await discoverAuthorizationServerMetadata(service.issuer);
    assert.equal(metadata?.issuer, service.issuer); assert.equal(metadata?.client_id_metadata_document_supported, true);
    assert.deepEqual(metadata?.code_challenge_methods_supported, ['S256']);
    const keys = await (await request('/mcp/auth/jwks')).json() as { keys: unknown[] }; assert.ok(keys.keys.length);
    shared = (await authorize(alice, accounts[0]!)).browser;
    aliceContext = await contextFor(alice); assert.equal(aliceContext.principal, principals[0]);
    const empty = await (await connect(alice)).callTool({ name: 'read_profile' });
    assert.deepEqual(empty.content, [{ type: 'text', text: 'null' }]);
    await authorize(bob, accounts[1]!, shared);
    const populated = await (await connect(bob)).callTool({ name: 'read_profile' });
    assert.equal(populated.content[0]?.type, 'text');
    if (populated.content[0]?.type !== 'text') throw new Error('missing profile');
    const profile = JSON.parse(populated.content[0].text) as { owner: string; name: string };
    assert.equal(profile.owner, principals[1]); assert.equal(profile.name, 'Synthetic initialized account');
    assert.notEqual((await contextFor(bob)).session.token, aliceContext.session.token);
    await aliceContext.assertActive();
  });
  const postProtocol = (path: string, body: Record<string, string>) => request('/mcp/auth/oauth2/' + path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });
  const refresh = (provider: ReturnType<typeof oauthClient>, refreshToken = provider.tokens()!.refresh_token!) => postProtocol('token', {
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: provider.clientInformation()!.client_id, resource: service.resource,
  });
  const sql = <T>(work: (database: DatabaseSync) => T) => {
    const database = new DatabaseSync(config.databasePath); try { return work(database); } finally { database.close(); }
  };
  const vaultSql = <T>(work: (database: DatabaseSync) => T) => {
    const database = new DatabaseSync(vaultConfig.location); try { return work(database); } finally { database.close(); }
  };
  await t.test('each client connection consumes exactly one pending credential and private reauthentication keeps account bindings separate', async () => {
    const third = oauthClient('Synthetic app C');
    const before = (await contextFor(bob)).session.token;
    const beginUrl = await begin(third);
    const needsLogin = await shared.request(beginUrl);
    const loginLocation = needsLogin.headers.get('location')!;
    assert.equal(new URL(loginLocation, origin).pathname, '/mcp/sign-in');
    await authorize(third, accounts[0]!, shared);
    const context = await contextFor(third);
    assert.equal(context.accountId, aliceContext.accountId); assert.equal(context.principal, aliceContext.principal);
    assert.notEqual(context.session.token, aliceContext.session.token);
    assert.equal((await contextFor(bob)).session.token, before);
    await aliceContext.assertActive();
    assert.equal(service.lookupGrant({ accountId: (await contextFor(bob)).accountId, grantId: context.grantId }), undefined);
    assert.notEqual(service.lookupGrant(context)!.operationLineageId, service.lookupGrant(aliceContext)!.operationLineageId);
    assert.equal(sql(db => (db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n), 0);
    const state = await service.browserSession(new Request(origin + '/mcp/consent', { headers: { cookie: shared.cookie } }));
    assert.equal(state?.accountId, aliceContext.accountId);
    assert.ok(!JSON.stringify(state).includes(context.session.token));
  });
  await t.test('two concurrent consent forms cannot consume one pending credential or revoke the winning grant', async () => {
    const first = oauthClient('Concurrent A'); const second = oauthClient('Concurrent B'); const browser = new Browser();
    const start = await browser.request(await begin(first)); const location = start.headers.get('location')!;
    let response = await browser.request(new URL(location, origin)); let body = await response.text();
    response = await browser.submit('/mcp/sign-in', { ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
    assert.equal(response.status, 303);
    const firstPage = await (await browser.request(response.headers.get('location')!)).text();
    const secondRedirect = await browser.request(await begin(second));
    const secondPage = await (await browser.request(new URL(secondRedirect.headers.get('location')!, origin))).text();
    const outcomes = await Promise.all([firstPage, secondPage].map(page => browser.submit('/mcp/consent', {
      decision: 'allow', csrf: hidden(page, 'csrf'), oauth_query: hidden(page, 'oauth_query'),
    })));
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [303, 401]);
    const winner = outcomes[0]!.status === 303 ? first : second;
    const callback = new URL(outcomes.find(outcome => outcome.status === 303)!.headers.get('location')!);
    assert.equal(await sdkAuthorize(winner, { serverUrl: service.resource, authorizationCode: callback.searchParams.get('code')!,
      iss: callback.searchParams.get('iss')! }), 'AUTHORIZED');
    await (await contextFor(winner)).assertActive();
    assert.ok((await outcomes.find(outcome => outcome.status === 401)!.text()).includes('Sign in again'));
  });
  await t.test('form CSRF, origin, host, query integrity, invalid passwords and direct provider login are refused', async () => {
    const provider = oauthClient('<script>untrusted app</script>');
    const browser = new Browser();
    const response = await browser.request(await begin(provider));
    const location = response.headers.get('location')!;
    const formResponse = await browser.request(new URL(location, origin));
    assert.equal(formResponse.headers.get('referrer-policy'), 'strict-origin', 'browser form posts must preserve their non-opaque origin');
    const body = await formResponse.text();
    assert.ok(body.includes('&lt;script&gt;untrusted app&lt;/script&gt;')); assert.ok(!body.includes('<script>'));
    const fields = { ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') };
    assert.equal((await browser.submit('/mcp/sign-in', fields, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await browser.submit('/mcp/sign-in', { ...fields, csrf: 'forged' })).status, 403);
    assert.equal((await new Browser().submit('/mcp/sign-in', fields)).status, 403);
    assert.equal((await browser.submit('/mcp/sign-in', { ...fields, owner: principals[1]! })).status, 400);
    assert.equal((await browser.submit('/mcp/sign-in', { ...fields, password: 'incorrect' })).status, 401);
    assert.equal(await service.browserSession(new Request(origin + '/mcp/consent', { headers: { cookie: browser.cookie } })), null);
    assert.equal((await request(new URL(location + '&scope=checkins%3Awrite', origin))).status, 400);
    assert.equal((await service.handler(new Request('https://evil.test/mcp/auth/jwks'))).status, 400);
    assert.equal((await service.handler(new Request(origin + '/mcp/auth/jwks', { headers: { host: 'evil.test' } }))).status, 400);
    assert.equal((await request('/mcp/auth/private/sign-in', { method: 'POST' })).status, 404);
    assert.equal((await request('/mcp/auth/oauth2/consent', { method: 'POST' })).status, 404);
    assert.equal((await request('/mcp/auth/sign-up/email', { method: 'POST' })).status, 404);
    assert.equal((await request('/mcp/consent?decision=allow')).status, 400);
    const forwarded = await service.handler(new Request(origin + '/.well-known/oauth-authorization-server/mcp/auth',
      { headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' } }));
    assert.equal((await forwarded.json() as { issuer: string }).issuer, service.issuer);
  });
  await t.test('public DCR rejects confidential, write-capable and unsafe callback profiles', async () => {
    for (const changes of [{ token_endpoint_auth_method: 'client_secret_post' }, { grant_types: ['client_credentials'] },
      { scope: 'checkins:write' }, { scope: 'rewards:claim' }, { redirect_uris: ['https://evil.test/#fragment'] },
      { redirect_uris: ['javascript:alert(1)'] }, { skip_consent: true }, { require_pkce: false }]) {
      const response = await request('/mcp/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...oauthClient('Refused profile').clientMetadata, ...changes }) });
      assert.equal(response.status, 400, JSON.stringify(changes));
    }
    const privateClient = await begin(oauthClient('CIMD refusal probe'));
    privateClient.searchParams.set('client_id', 'https://127.0.0.1/client.json');
    const response = await new Browser().request(privateClient);
    assert.ok(!String(response.headers.get('location')).includes('/mcp/sign-in'));
  });
  await t.test('authorization rejects missing S256, unregistered redirect, wrong resource and all write scopes', async () => {
    const base = await begin(oauthClient('Invalid authorization probe'));
    for (const change of [(url: URL) => url.searchParams.delete('code_challenge'),
      (url: URL) => url.searchParams.set('code_challenge_method', 'plain'),
      (url: URL) => url.searchParams.set('redirect_uri', 'https://evil.test/callback'),
      (url: URL) => url.searchParams.set('resource', origin + '/wrong'),
      (url: URL) => url.searchParams.set('scope', 'habits:read checkins:write'),
      (url: URL) => url.searchParams.set('scope', 'coins:read rewards:claim')]) {
      const url = new URL(base); change(url);
      const response = await new Browser().request(url);
      const result = response.headers.get('location') ?? await response.text();
      assert.ok(!result.includes('/mcp/sign-in?'), result); assert.ok(/error|invalid/i.test(result), result);
    }
    await assert.rejects(service.authenticate(new Request(service.resource, { headers: { authorization: `Bearer ${aliceContext.session.token}` } })));
  });
  await t.test('denied consent issues no grant or usable code and note permission is independent', async () => {
    const before = sql(db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n);
    const denied = await authorize(oauthClient('Denied client'), accounts[0]!, new Browser(), false);
    assert.equal(denied.callback.searchParams.get('error'), 'access_denied');
    assert.equal(denied.callback.searchParams.get('code'), null);
    assert.equal(sql(db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n), before);
    await assert.rejects((await connect(alice)).callTool({ name: 'read_notes' }), /[Ii]nsufficient.scope/);
    const notes = oauthClient('Notes permission');
    await authorize(notes, accounts[0]!, new Browser(), true, 'habits:read habits:notes:read coins:read openid offline_access');
    assert.ok((await contextFor(notes)).scopes.includes('habits:notes:read'));
    assert.deepEqual((await (await connect(notes)).callTool({ name: 'read_notes' })).content, [{ type: 'text', text: 'notes allowed' }]);
  });
  await t.test('code replay and wrong verifier never yield usable replacement authority', async () => {
    const provider = oauthClient('Replay test');
    const { callback } = await authorize(provider, accounts[0]!);
    const response = await postProtocol('token', { grant_type: 'authorization_code', code: callback.searchParams.get('code')!,
      code_verifier: provider.codeVerifier(), client_id: provider.clientInformation()!.client_id,
      redirect_uri: provider.redirectUrl, resource: service.resource });
    assert.equal(response.status, 400);
    const another = oauthClient('Wrong verifier');
    const fresh = await authorize(another, accounts[1]!, new Browser(), true, 'habits:read offline_access', false);
    const wrong = await postProtocol('token', { grant_type: 'authorization_code', code: fresh.callback.searchParams.get('code')!,
      code_verifier: randomBytes(32).toString('base64url'), client_id: another.clientInformation()!.client_id,
      redirect_uri: another.redirectUrl, resource: service.resource });
    assert.equal(wrong.status, 400);
  });
  await t.test('revoke fences existing contexts and refresh immediately while another grant and lineage survive', async () => {
    const previous = service.lookupGrant(aliceContext)!;
    const oldRefresh = alice.tokens()!.refresh_token!;
    await assert.rejects(service.revokeGrant({ accountId: (await contextFor(bob)).accountId, grantId: aliceContext.grantId }));
    await service.revokeGrant(aliceContext);
    await assert.rejects(aliceContext.assertActive()); await assert.rejects(contextFor(alice));
    const response = await refresh(alice, oldRefresh); assert.equal(response.status, 400);
    await (await contextFor(bob)).assertActive();
    alice.forgetTokens();
    await authorize(alice, accounts[0]!, shared);
    const reconnected = await contextFor(alice);
    assert.notEqual(reconnected.grantId, previous.grantId); assert.notEqual(reconnected.session.token, aliceContext.session.token);
    assert.equal(service.lookupGrant(reconnected)!.operationLineageId, previous.operationLineageId);
    assert.equal((await refresh(alice, oldRefresh)).status, 400);
    await reconnected.assertActive();
    aliceContext = reconnected;
    const previousBob = await contextFor(bob); const bobLineage = service.lookupGrant(previousBob)!.operationLineageId;
    bob.forgetTokens(); await authorize(bob, accounts[0]!, shared);
    const switched = await contextFor(bob);
    assert.notEqual(switched.accountId, previousBob.accountId);
    assert.notEqual(service.lookupGrant(switched)!.operationLineageId, bobLineage);
    await previousBob.assertActive();
  });
  await t.test('restart retains provider keys, private read credentials and SDK refresh binding', async () => {
    const before = await contextFor(bob); const browserBefore = await service.browserSession(new Request(origin + '/mcp/consent', { headers: { cookie: shared.cookie } }));
    const keys = await (await request('/mcp/auth/jwks')).json();
    const counts = sql(db => ['oauthClient', 'oauthConsent', 'session', 'jwks', 'mcp_grants'].map(table =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
    await Promise.all(sdkClients.splice(0).map(client => client.close()));
    await service.close(); vault.close();
    const child = fork(new URL(import.meta.url), [], { execPath: process.execPath,
      env: { ...process.env, MCP_AUTH_RESTART_CHILD: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      const result = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
      child.send({ publicOrigin: origin, backendUrl: config.backendUrl, databasePath: config.databasePath, secret,
        vaultPath: vaultConfig.location, vaultKey: Buffer.from(vaultConfig.keys.get('v1')!).toString('hex'), accessToken: bob.tokens()!.access_token });
      assert.deepEqual((await result)[0], { accountId: before.accountId, grantId: before.grantId,
        upstreamHash: createHash('sha256').update(before.session.token).digest('hex'), jwks: keys });
      assert.equal((await exited)[0], 0);
    } finally { if (child.exitCode === null) child.kill(); }
    vault = new CredentialVault(vaultConfig); await start();
    assert.deepEqual(await (await request('/mcp/auth/jwks')).json(), keys);
    assert.deepEqual(sql(db => ['oauthClient', 'oauthConsent', 'session', 'jwks', 'mcp_grants'].map(table =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)), counts);
    assert.equal((await contextFor(bob)).session.token, before.session.token);
    assert.deepEqual(await service.browserSession(new Request(origin + '/mcp/consent', { headers: { cookie: shared.cookie } })), browserBefore);
    assert.equal(await sdkAuthorize(bob, { serverUrl: service.resource }), 'AUTHORIZED');
    const after = await contextFor(bob); assert.equal(after.grantId, before.grantId);
    assert.equal(after.session.token, before.session.token);
    assert.deepEqual((await (await connect(bob)).callTool({ name: 'read_profile' })).content, [{ type: 'text', text: 'null' }]);
  });
  await t.test('protocol refresh-token revocation fences the entire connection without affecting another grant', async () => {
    const provider = oauthClient('Protocol revocation'); await authorize(provider, accounts[0]!);
    const current = await contextFor(provider);
    const response = await postProtocol('revoke', { token: provider.tokens()!.refresh_token!, token_type_hint: 'refresh_token',
      client_id: provider.clientInformation()!.client_id });
    assert.equal(response.status, 200);
    await assert.rejects(current.assertActive());
    assert.equal((await refresh(provider)).status, 400);
    assert.equal(service.lookupGrant(current)!.active, false);
    await (await contextFor(bob)).assertActive();
    const access = oauthClient('Access revocation'); await authorize(access, accounts[0]!);
    const accessContext = await contextFor(access);
    const wrongClient = await postProtocol('revoke', { token: access.tokens()!.access_token, token_type_hint: 'access_token',
      client_id: bob.clientInformation()!.client_id });
    assert.equal(wrongClient.status, 200); await accessContext.assertActive();
    const revoked = await postProtocol('revoke', { token: access.tokens()!.access_token, token_type_hint: 'access_token',
      client_id: access.clientInformation()!.client_id });
    assert.equal(revoked.status, 200); await assert.rejects(accessContext.assertActive());
    assert.equal((await refresh(access)).status, 400);
    await (await contextFor(bob)).assertActive();
  });
  for (const concurrent of [false, true]) await t.test(`${concurrent ? 'concurrent' : 'repeated'} ended-refresh revocation preserves a reconnected same-client account`, async () => {
    const provider = oauthClient(concurrent ? 'Concurrent ended revocation' : 'Repeated ended revocation');
    await authorize(provider, accounts[1]!);
    const ended = await contextFor(provider);
    const oldRefresh = provider.tokens()!.refresh_token!;
    const revokeOld = (clientId = provider.clientInformation()!.client_id) => postProtocol('revoke', {
      token: oldRefresh, token_type_hint: 'refresh_token', client_id: clientId,
    });
    if (concurrent) {
      const rotated = await refresh(provider); assert.equal(rotated.status, 200);
      provider.saveTokens({ ...provider.tokens()!, ...await rotated.json() });
    }
    assert.equal((await revokeOld()).status, 200);
    provider.forgetTokens(); await authorize(provider, accounts[1]!);
    const replacement = await contextFor(provider);
    assert.equal(replacement.accountId, ended.accountId); assert.equal(replacement.clientId, ended.clientId);
    assert.notEqual(replacement.grantId, ended.grantId);
    const before = await refresh(provider); assert.equal(before.status, 200);
    provider.saveTokens({ ...provider.tokens()!, ...await before.json() });
    const unknownClient = 'unregistered-revocation-client';
    const unknownReference = await postProtocol('revoke', { token: randomUUID(), client_id: unknownClient });
    const unauthorized = await revokeOld(unknownClient);
    const wrongClient = await revokeOld(bob.clientInformation()!.client_id);
    assert.equal(wrongClient.status, 200);
    const outcomes = concurrent ? await Promise.all([revokeOld(), revokeOld(), revokeOld()]) : [await revokeOld()];
    const after = await refresh(provider);
    assert.deepEqual({ repeated: outcomes.map(response => response.status), replacement: after.status },
      { repeated: concurrent ? [200, 200, 200] : [200], replacement: 200 });
    assert.equal(unauthorized.status, unknownReference.status, 'ended tokens retain provider client authentication');
    assert.deepEqual(await unauthorized.json(), await unknownReference.json());
    provider.saveTokens({ ...provider.tokens()!, ...await after.json() });
    await assert.rejects(ended.assertActive()); await replacement.assertActive();
    assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource }), 'AUTHORIZED');
    assert.equal((await contextFor(provider)).grantId, replacement.grantId);
    const result = await (await connect(provider)).callTool({ name: 'read_profile' });
    assert.equal(result.isError, undefined);
    await (await contextFor(bob)).assertActive();
  });
  await t.test('repeated ended-access revocation authenticates the caller and preserves a same-client reconnect', async () => {
    const provider = oauthClient('Repeated ended access revocation');
    await authorize(provider, accounts[1]!);
    const ended = await contextFor(provider);
    const oldAccess = provider.tokens()!.access_token;
    const clientId = provider.clientInformation()!.client_id;
    const revokeOld = (token = oldAccess, caller = clientId) => postProtocol('revoke', {
      token, token_type_hint: 'access_token', client_id: caller,
    });
    assert.equal((await revokeOld()).status, 200);
    await assert.rejects(ended.assertActive());
    const evidence = sql(db => db.prepare('SELECT token_mac, grant_id FROM mcp_revoked_access_tokens WHERE grant_id = ?')
      .get(ended.grantId) as { token_mac: string; grant_id: string });
    assert.match(evidence.token_mac, /^[a-f0-9]{64}$/);
    assert.notEqual(evidence.token_mac, oldAccess);
    await Promise.all(sdkClients.splice(0).map(client => client.close()));
    await service.close(); await start();
    provider.forgetTokens(); await authorize(provider, accounts[1]!);
    const replacement = await contextFor(provider);
    assert.equal(replacement.accountId, ended.accountId);
    assert.equal(replacement.clientId, ended.clientId);
    assert.notEqual(replacement.grantId, ended.grantId);
    const refreshed = await refresh(provider); assert.equal(refreshed.status, 200);
    provider.saveTokens({ ...provider.tokens()!, ...await refreshed.json() });
    assert.equal((await revokeOld(oldAccess, bob.clientInformation()!.client_id)).status, 200);
    const unknownClient = 'unregistered-revocation-client';
    const unauthenticated = await revokeOld(oldAccess, unknownClient);
    const unknownReference = await revokeOld(randomUUID(), unknownClient);
    assert.equal(unauthenticated.status, unknownReference.status);
    assert.deepEqual(await unauthenticated.json(), await unknownReference.json());
    const signatureParts = oldAccess.split('.'); assert.equal(signatureParts.length, 3);
    signatureParts[2] = (signatureParts[2]![0] === 'A' ? 'B' : 'A') + signatureParts[2]!.slice(1);
    const tampered = await revokeOld(signatureParts.join('.'));
    assert.ok(tampered.status >= 400, 'a tampered JWT must not use ended-token evidence');
    assert.equal((await revokeOld()).status, 200);
    assert.equal((await revokeOld()).status, 200);
    await replacement.assertActive();
    const after = await refresh(provider); assert.equal(after.status, 200);
    provider.saveTokens({ ...provider.tokens()!, ...await after.json() });
    assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource }), 'AUTHORIZED');
    assert.equal((await contextFor(provider)).grantId, replacement.grantId);
    const result = await (await connect(provider)).callTool({ name: 'read_profile' });
    assert.equal(result.isError, undefined);
  });
  await t.test('upstream expiry blocks both delivery and token refresh without granting write authority', async () => {
    const current = await contextFor(bob);
    vaultNow = current.session.expiresAt + 1;
    await assert.rejects(current.assertActive()); await assert.rejects(contextFor(bob));
    const response = await refresh(bob); assert.ok(response.status >= 400);
    vaultNow = undefined;
    const client = createClient({ url: host.url, token: aliceContext.session.token }); snapbackClients.push(client);
    const mutation = await client.mutate(api.saveProfile, { name: 'forbidden' });
    assert.equal(mutation.state, 'failed'); if (mutation.state === 'failed') assert.equal(mutation.why.code, 'E_READ_ONLY');
    assert.ok(backendTraffic.length > 0 && backendTraffic.every(path => !path.startsWith('/m/')));
  });
  await t.test('expired signed access tokens are rejected even while the private grant is active', async () => {
    await Promise.all(sdkClients.splice(0).map(client => client.close()));
    await service.close(); await start(1);
    const short = oauthClient('Short-lived token'); await authorize(short, accounts[0]!);
    const current = await contextFor(short);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await assert.rejects(contextFor(short)); await assert.rejects(current.assertActive());
    assert.equal(service.lookupGrant(current)!.active, true);
  });
  let writer: ReturnType<typeof oauthClient>;
  let writeContext: AuthContext;
  await t.test('write consent requires fresh matching credentials after read-only sign-in', async () => {
    await service.close();
    writeConnections = { revoke: async (grant, commitRevocation) => {
      assert.ok(Object.isFrozen(grant));
      assert.equal('token' in grant, false);
      writeEvents.push({ phase: 'before', grantId: grant.grantId, active: service.lookupGrant(grant)!.active, scope: [...grant.scopes] });
      if (failCoordination) throw new Error('account lane unavailable');
      await commitRevocation();
      writeEvents.push({ phase: 'after', grantId: grant.grantId, active: service.lookupGrant(grant)!.active, scope: [...grant.scopes] });
    } };
    await start();
    writer = oauthClient('Explicit write client');
    const browser = new Browser();
    let response = await browser.request(await begin(writer, 'habits:read checkins:write offline_access'));
    response = await browser.request(response.headers.get('location')!);
    let body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes('Sign in to connect'));
    assert.equal(vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full'").get() as { n: number }).n), 0);
    response = await browser.submit('/mcp/sign-in', { ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
    assert.equal(response.status, 303);
    response = await browser.request(response.headers.get('location')!);
    body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes('Create check-ins'));
    assert.ok(body.includes('name="password"'));
    assert.equal(vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full'").get() as { n: number }).n), 0);
    response = await browser.submit('/mcp/consent', { decision: 'allow', csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
    assert.notEqual(response.status, 303, 'write approval cannot use the sign-in read session');
    for (const [credentials, headers] of [
      [{ ...accounts[0]!, password: 'incorrect' }, {}],
      [accounts[1]!, {}],
      [accounts[0]!, { origin: 'https://evil.test' }],
    ] as const) {
      response = await browser.submit('/mcp/consent', { decision: 'allow', ...credentials,
        csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') }, headers);
      assert.notEqual(response.status, 303);
      assert.equal(vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full'").get() as { n: number }).n), 0);
    }
    response = await browser.submit('/mcp/consent', { decision: 'allow', ...accounts[0]!,
      csrf: 'forged', oauth_query: hidden(body, 'oauth_query') });
    assert.equal(response.status, 403);
    response = await browser.submit('/mcp/consent', { decision: 'allow', ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
    assert.equal(response.status, 303, await response.clone().text());
    const callback = new URL(response.headers.get('location')!);
    assert.equal(await sdkAuthorize(writer, { serverUrl: service.resource, authorizationCode: callback.searchParams.get('code')!,
      iss: callback.searchParams.get('iss')! }), 'AUTHORIZED');
    const context = await contextFor(writer);
    writeContext = context;
    assert.equal(context.session.scope, 'full');
    assert.ok(context.scopes.includes('checkins:write'));
    assert.deepEqual(await service.deliveryGrantStatus(context.grantId), {
      accountId: context.accountId, clientId: context.clientId, active: true,
      scopes: service.lookupGrant(context)!.scopes,
    });
    assert.equal(await service.deliveryGrantStatus(randomUUID()), null);
    assert.equal(vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL").get() as { n: number }).n), 1);
    assert.notEqual(context.session.token, aliceContext.session.token);
    const fullClient = createClient({ url: host.url, token: context.session.token }); snapbackClients.push(fullClient);
    assert.equal((await fullClient.mutate(api.saveProfile, { name: 'Write consent proved' })).state, 'sent');
    const read = oauthClient('Read after write'); await authorize(read, accounts[0]!);
    const readContext = await contextFor(read);
    assert.equal(readContext.session.scope, 'read');
    assert.deepEqual(readContext.scopes, ['habits:read']);
    assert.notEqual(readContext.session.token, context.session.token);
    assert.equal(vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL").get() as { n: number }).n), 1);
  });
  await t.test('delivery status is metadata-only and fails closed for upstream expiry or missing provider session', async () => {
    const grant = service.lookupGrant(writeContext)!;
    sql(db => db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?').run(Date.now() - 1, grant.grantId));
    assert.equal((await service.deliveryGrantStatus(grant.grantId))?.active, false);
    sql(db => db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?').run(grant.expiresAt, grant.grantId));
    assert.equal((await service.deliveryGrantStatus(grant.grantId))?.active, true);
    const disposable = oauthClient('Missing provider session');
    await authorize(disposable, accounts[0]!);
    const disposableContext = await contextFor(disposable);
    sql(db => db.prepare('DELETE FROM session WHERE id = ?').run(service.lookupGrant(disposableContext)!.sessionId));
    const status = await service.deliveryGrantStatus(disposableContext.grantId);
    assert.deepEqual(status, { accountId: disposableContext.accountId, clientId: disposableContext.clientId,
      active: false, scopes: service.lookupGrant(disposableContext)!.scopes });
    await service.revokeGrant(disposableContext);
  });
  await t.test('full custody and exact write scopes survive a fresh Node process without rotating the upstream session', async () => {
    const before = await contextFor(writer);
    const keys = await (await request('/mcp/auth/jwks')).json();
    await service.close(); vault.close();
    const child = fork(new URL(import.meta.url), [], { execPath: process.execPath,
      env: { ...process.env, MCP_AUTH_RESTART_CHILD: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      const result = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
      child.send({ publicOrigin: origin, backendUrl: config.backendUrl, databasePath: config.databasePath, secret,
        vaultPath: vaultConfig.location, vaultKey: Buffer.from(vaultConfig.keys.get('v1')!).toString('hex'),
        accessToken: writer.tokens()!.access_token, writeConnections: true });
      assert.deepEqual((await result)[0], { accountId: before.accountId, grantId: before.grantId,
        upstreamHash: createHash('sha256').update(before.session.token).digest('hex'), jwks: keys,
        upstreamScope: 'full', scopes: before.scopes });
      assert.equal((await exited)[0], 0);
    } finally { if (child.exitCode === null) child.kill(); }
    vault = new CredentialVault(vaultConfig);
    await assert.rejects(createAuthorizationService({ ...config, vault, writeConnections: undefined }),
      /Active write grants require a write connection lifecycle/);
    await start();
    const after = await contextFor(writer);
    writeContext = after;
    assert.equal(after.grantId, before.grantId);
    assert.equal(after.session.token, before.session.token);
    assert.equal(after.session.scope, 'full');
  });
  await t.test('failed account coordination refuses revocation and cannot claim the connection ended', async () => {
    failCoordination = true;
    try {
      const before = writeEvents.length;
      await assert.rejects(service.revokeGrant(writeContext), /Account coordination is temporarily unavailable/);
      assert.deepEqual(writeEvents.slice(before).map(event => event.phase), ['before']);
      assert.equal(service.lookupGrant(writeContext)!.active, true);
      await writeContext.assertActive();
      const logged: string[] = [], originalError = console.error;
      let failedProtocol: Response;
      try {
        console.error = (...values: unknown[]) => { logged.push(values.map(value => value instanceof Error ? value.message : String(value)).join(' ')); };
        failedProtocol = await postProtocol('revoke', { token: writer.tokens()!.refresh_token!,
          token_type_hint: 'refresh_token', client_id: writer.clientInformation()!.client_id });
      } finally { console.error = originalError; }
      assert.ok(!logged.join('\n').includes('account lane unavailable'), 'provider logs must not include raw coordination failures');
      assert.notEqual(failedProtocol.status, 200);
      assert.equal(service.lookupGrant(writeContext)!.active, true);
    } finally { failCoordination = false; }
  });
  await t.test('trusted and repeated protocol revocations coordinate before cutoff and preserve another full grant', async () => {
    const other = oauthClient('Second write grant');
    await authorize(other, accounts[0]!, new Browser(), true, 'habits:read checkins:write offline_access');
    const otherContext = await contextFor(other);
    assert.equal(otherContext.session.scope, 'full');
    assert.notEqual(otherContext.session.token, writeContext.session.token);
    const oldRefresh = writer.tokens()!.refresh_token!;
    const before = writeEvents.length;
    await service.revokeGrant(writeContext);
    assert.deepEqual(writeEvents.slice(before).map(event => ({ phase: event.phase, active: event.active })),
      [{ phase: 'before', active: true }, { phase: 'after', active: false }]);
    await assert.rejects(writeContext.assertActive());
    await otherContext.assertActive();
    assert.equal((await refresh(writer, oldRefresh)).status, 400);
    writer.forgetTokens();
    await authorize(writer, accounts[0]!, new Browser(), true, 'habits:read checkins:write offline_access');
    const writerReplacement = await contextFor(writer);
    assert.equal(writerReplacement.clientId, writeContext.clientId);
    assert.notEqual(writerReplacement.grantId, writeContext.grantId);
    assert.notEqual(writerReplacement.session.token, writeContext.session.token);
    const endedRefresh = await postProtocol('revoke', { token: oldRefresh, client_id: writer.clientInformation()!.client_id });
    assert.equal(endedRefresh.status, 200);
    const repeatedRefresh = await Promise.all([oldRefresh, oldRefresh].map(token => postProtocol('revoke', {
      token, client_id: writer.clientInformation()!.client_id,
    })));
    assert.deepEqual(repeatedRefresh.map(response => response.status), [200, 200]);
    await writerReplacement.assertActive();
    const writerRefresh = await refresh(writer); assert.equal(writerRefresh.status, 200);
    writer.saveTokens({ ...writer.tokens()!, ...await writerRefresh.json() });
    await otherContext.assertActive();
    const access = oauthClient('Access write grant');
    await authorize(access, accounts[0]!, new Browser(), true, 'coins:read rewards:claim offline_access');
    const accessContext = await contextFor(access);
    assert.deepEqual(accessContext.scopes, ['coins:read', 'rewards:claim']);
    const oldAccess = access.tokens()!.access_token;
    const accessBefore = writeEvents.length;
    const revokedAccess = await postProtocol('revoke', { token: access.tokens()!.access_token,
      client_id: access.clientInformation()!.client_id });
    assert.equal(revokedAccess.status, 200);
    assert.deepEqual(writeEvents.slice(accessBefore, accessBefore + 2).map(event => event.phase), ['before', 'after']);
    await assert.rejects(accessContext.assertActive());
    access.forgetTokens();
    await authorize(access, accounts[0]!, new Browser(), true, 'coins:read rewards:claim offline_access');
    const accessReplacement = await contextFor(access);
    assert.equal(accessReplacement.clientId, accessContext.clientId);
    assert.notEqual(accessReplacement.grantId, accessContext.grantId);
    const repeated = await Promise.all([oldRefresh, oldRefresh].map(token => postProtocol('revoke', {
      token, client_id: writer.clientInformation()!.client_id,
    })));
    assert.deepEqual(repeated.map(response => response.status), [200, 200]);
    const endedAccess = await Promise.all([oldAccess, oldAccess].map(token => postProtocol('revoke', {
      token, client_id: access.clientInformation()!.client_id,
    })));
    assert.deepEqual(endedAccess.map(response => response.status), [200, 200]);
    await accessReplacement.assertActive();
    const accessRefresh = await refresh(access); assert.equal(accessRefresh.status, 200);
    access.saveTokens({ ...access.tokens()!, ...await accessRefresh.json() });
    await otherContext.assertActive();
    const otherRefresh = await refresh(other); assert.equal(otherRefresh.status, 200);
    other.saveTokens({ ...other.tokens()!, ...await otherRefresh.json() });
    await (await contextFor(other)).assertActive();
  });
  await t.test('a full upstream session expires honestly without automatic rotation', async () => {
    const replacement = oauthClient('Expiring write grant');
    await authorize(replacement, accounts[0]!, new Browser(), true, 'checkins:write offline_access');
    const context = await contextFor(replacement);
    vaultNow = context.session.expiresAt + 1;
    await assert.rejects(context.assertActive());
    assert.equal((await refresh(replacement)).status, 400);
    vaultNow = undefined;
    assert.equal(service.lookupGrant(context)!.active, true);
    sql(db => db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?').run(Date.now() - 1, context.grantId));
    assert.equal((await service.deliveryGrantStatus(context.grantId))?.active, false);
    const before = writeEvents.length;
    await service.revokeGrant(context);
    assert.deepEqual(writeEvents.slice(before).map(event => event.phase), ['before', 'after']);
    assert.equal(service.lookupGrant(context)!.active, false);
  });
  await t.test('grant insertion failure never places a full credential in vault custody', async () => {
    const liveFull = () => vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL")
      .get() as { n: number }).n);
    const before = liveFull();
    const grantCount = sql(db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n);
    sql(db => db.exec("CREATE TRIGGER fail_grant_insert BEFORE INSERT ON mcp_grants BEGIN SELECT RAISE(ABORT, 'insert fault'); END"));
    try {
      const failed = oauthClient('Grant insert failure'); const browser = new Browser();
      let response = await browser.request(await begin(failed, 'checkins:write offline_access'));
      response = await browser.request(response.headers.get('location')!); let body = await response.text();
      response = await browser.submit('/mcp/sign-in', { ...accounts[0]!, csrf: hidden(body, 'csrf'),
        oauth_query: hidden(body, 'oauth_query') });
      assert.equal(response.status, 303);
      response = await browser.request(response.headers.get('location')!); body = await response.text();
      response = await browser.submit('/mcp/consent', { decision: 'allow', ...accounts[0]!, csrf: hidden(body, 'csrf'),
        oauth_query: hidden(body, 'oauth_query') });
      assert.notEqual(response.status, 303);
    } finally { sql(db => db.exec('DROP TRIGGER fail_grant_insert')); }
    assert.equal(sql(db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n), grantCount);
    assert.equal(liveFull(), before);
  });
  await t.test('activation failure tombstones full custody and leaves a known inactive grant', async () => {
    const liveFull = () => vaultSql(db => (db.prepare("SELECT COUNT(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL")
      .get() as { n: number }).n);
    const before = liveFull();
    const inactiveBefore = sql(db => (db.prepare("SELECT COUNT(*) AS n FROM mcp_grants WHERE active = 0 AND credential_scope = 'full'")
      .get() as { n: number }).n);
    sql(db => db.exec("CREATE TRIGGER fail_grant_activation BEFORE UPDATE OF active ON mcp_grants WHEN NEW.active = 1 BEGIN SELECT RAISE(ABORT, 'activation fault'); END"));
    try {
      const failed = oauthClient('Grant activation failure'); const browser = new Browser();
      let response = await browser.request(await begin(failed, 'checkins:write offline_access'));
      response = await browser.request(response.headers.get('location')!); let body = await response.text();
      response = await browser.submit('/mcp/sign-in', { ...accounts[0]!, csrf: hidden(body, 'csrf'),
        oauth_query: hidden(body, 'oauth_query') });
      assert.equal(response.status, 303);
      response = await browser.request(response.headers.get('location')!); body = await response.text();
      response = await browser.submit('/mcp/consent', { decision: 'allow', ...accounts[0]!, csrf: hidden(body, 'csrf'),
        oauth_query: hidden(body, 'oauth_query') });
      assert.notEqual(response.status, 303);
    } finally { sql(db => db.exec('DROP TRIGGER fail_grant_activation')); }
    assert.equal(sql(db => (db.prepare("SELECT COUNT(*) AS n FROM mcp_grants WHERE active = 0 AND credential_scope = 'full'")
      .get() as { n: number }).n), inactiveBefore + 1);
    assert.equal(liveFull(), before);
  });
  await t.test('full custody binding survives OAuth scope drift and revocation preserves another grant', async () => {
    const drifted = oauthClient('Drifted write grant');
    const surviving = oauthClient('Surviving write grant');
    await authorize(drifted, accounts[0]!, new Browser(), true, 'checkins:write offline_access');
    await authorize(surviving, accounts[0]!, new Browser(), true, 'checkins:write offline_access');
    const current = await contextFor(drifted);
    const other = await contextFor(surviving);
    assert.equal(service.lookupGrant(current)!.credentialScope, 'full');
    sql(db => db.prepare('UPDATE mcp_grants SET scopes = ? WHERE id = ?').run(JSON.stringify(['habits:read']), current.grantId));
    assert.equal((await service.deliveryGrantStatus(current.grantId))?.active, false);
    await assert.rejects(current.assertActive());
    await service.revokeGrant(current);
    assert.equal(service.lookupGrant(current)!.active, false);
    assert.equal(vaultSql(db => (db.prepare('SELECT COUNT(*) AS n FROM vault_credentials WHERE grant_id = ? AND scope = ? AND token_hash IS NOT NULL')
      .get(current.grantId, 'full') as { n: number }).n), 0);
    await other.assertActive();
  });
});
