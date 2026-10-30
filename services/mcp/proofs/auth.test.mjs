import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  auth as sdkAuthorize, Client, StreamableHTTPClientTransport,
  discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata,
} from '@modelcontextprotocol/client';
import { signup, login } from '../../../node_modules/snapback4/dist/auth.js';
import { createClient } from '../../../node_modules/snapback4/dist/client.js';
import { startDev } from '../../../node_modules/snapback4/dist/proof.js';
import { api } from '../../../snapback/generated/api.ts';
import { verifyBearerToken } from 'better-auth/oauth2';
import { startAuthorizationProof, fetchClientMetadataResource } from './auth.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cookieJar = response => response.headers.getSetCookie()
  .map(value => value.split(';')[0]).join('; ');

function oauthClient(redirectUrl, clientMetadataUrl) {
  let information, tokens, verifier, authorizationUrl, discovery;
  return {
    redirectUrl, clientMetadataUrl,
    clientMetadata: {
      client_name: 'Synthetic proof', redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none', response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
    },
    state: () => 'synthetic-callback-state',
    clientInformation: () => information,
    saveClientInformation: value => { information = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: value => { authorizationUrl = value; },
    saveDiscoveryState: value => { discovery = value; },
    discoveryState: () => discovery,
    get authorizationUrl() { return authorizationUrl; },
  };
}

test('the pinned Node runtime preserves opaque SQLite text', () => {
  assert.equal(process.versions.bun, undefined);
  assert.equal(process.versions.node, '24.22.2');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE opaque (value TEXT NOT NULL)');
    db.prepare('INSERT INTO opaque VALUES (?)').run('a\0z');
    assert.equal(db.prepare('SELECT value FROM opaque').get().value, 'a\0z');
  } finally {
    db.close();
  }
});

test('Node CIMD transport rejects private targets and unsupported methods before connecting', async () => {
  for (const url of ['http://example.com/client.json', 'https://127.0.0.1/client.json',
    'https://localhost/client.json', 'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.1/client.json', 'https://[::1]/client.json']) {
    await assert.rejects(async () => fetchClientMetadataResource(url, { signal: AbortSignal.timeout(3000) }));
  }
  await assert.rejects(async () => fetchClientMetadataResource('https://example.com/client.json', { method: 'POST' }), /GET and HEAD/);
});

test('public CIMD transport retrieves real HTTPS metadata and refuses to follow redirects', {
  skip: process.env.MCP_PROOF_PUBLIC_CIMD !== '1', timeout: 30_000,
}, async () => {
  const response = await fetchClientMetadataResource('https://chatgpt.com/oauth/client.json', {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.client_id, 'https://chatgpt.com/oauth/client.json');
  assert.ok(document.redirect_uris.includes('https://chatgpt.com/connector_platform_oauth_redirect'));
  const redirect = await fetchClientMetadataResource(
    'https://better-auth.com/docs/plugins/cimd/',
    { signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(redirect.status, 308);
  assert.equal(new URL(redirect.headers.get('location'), 'https://better-auth.com').href,
    'https://better-auth.com/docs/plugins/cimd');
  await redirect.body?.cancel();
});

test('external identity, OAuth, SQLite and the SDK isolate two synthetic accounts', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'habit-auth-proof-'));
  const host = await startDev({ cwd: root, logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const accounts = [];
  const clients = [];
  const secret = randomBytes(48).toString('hex');
  const path = join(directory, 'provider.sqlite');
  let service;
  const request = (endpoint, options = {}) => fetch(new URL(endpoint, service.origin), {
    redirect: 'manual', ...options, headers: { connection: 'close', ...options.headers },
  });
  const post = (endpoint, body, cookie = '') => request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: service.origin, cookie },
    body: JSON.stringify(body),
  });
  const signIn = async (account, cookie = '', password = account.password) => {
    const response = await post('/api/auth/snapback-sign-in', { email: account.email, password }, cookie);
    if (response.status !== 200) return { status: response.status };
    return { ...(await response.json()), cookie: cookieJar(response), status: response.status };
  };
  const begin = async (provider, scope = 'habits:read offline_access') => {
    assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource, scope }), 'REDIRECT');
    assert.equal(provider.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(provider.authorizationUrl.searchParams.get('resource'), service.resource);
    return provider.authorizationUrl;
  };
  const consent = async (url, account, accept = true) => {
    const response = await request(url, { headers: { cookie: account.cookie } });
    const location = response.headers.get('location') ?? (await response.json()).url;
    assert.ok(location, `authorization status ${response.status}`);
    const consentUrl = new URL(location, service.origin);
    assert.equal(consentUrl.pathname, '/consent');
    const decision = await post('/api/auth/oauth2/consent', {
      accept, oauth_query: consentUrl.search.slice(1),
    }, account.cookie);
    assert.equal(decision.status, 200);
    const result = await decision.json();
    return new URL(result.redirect_uri ?? result.url);
  };
  const connect = async provider => {
    const client = new Client({ name: 'synthetic-sdk-proof', version: '1' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    const transport = new StreamableHTTPClientTransport(new URL(service.resource), {
      requestInit: { headers: { Authorization: `Bearer ${provider.tokens().access_token}` } },
    });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  try {
    for (const name of ['Alice', 'Bob']) {
      const account = { email: `${randomUUID()}@example.test`, password: randomUUID(), name };
      const created = await signup(host.url, account.email, account.password);
      assert.equal(created.ok, true);
      account.principal = created.session.principal;
      account.token = created.session.token;
      const client = createClient({ url: host.url, token: created.session.token });
      clients.push(client);
      assert.equal((await client.mutate(api.saveProfile, { name })).state, 'sent');
      accounts.push(account);
    }
    service = await startAuthorizationProof({ backend: host.url, path, secret });
    const alice = await signIn(accounts[0]);
    const bob = await signIn(accounts[1], alice.cookie);
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    assert.notEqual(alice.subject, bob.subject);
    assert.notEqual(alice.cookie, bob.cookie);

    await t.test('identity refuses bad passwords, CSRF, caller owner fields and Snapback writes', async () => {
      assert.equal((await signIn(accounts[0], '', randomUUID())).status, 401);
      const csrf = await request('/api/auth/snapback-sign-in', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ email: accounts[0].email, password: accounts[0].password }),
      });
      assert.equal(csrf.status, 403);
      assert.equal((await post('/api/auth/snapback-sign-in', {
        email: accounts[0].email, password: accounts[0].password, principal: accounts[1].principal,
      })).status, 400);
      const binding = service.db.prepare('SELECT snapbackPrincipal FROM user WHERE id = ?').get(bob.subject);
      assert.equal(binding.snapbackPrincipal, accounts[1].principal);
      const read = await login(host.url, accounts[0].email, accounts[0].password, { scope: 'read' });
      assert.equal(read.ok, true);
      assert.equal(read.session.scope, 'read');
      const readClient = createClient({ url: host.url, token: read.session.token });
      clients.push(readClient);
      const mutation = await readClient.mutate(api.saveProfile, { name: 'Forbidden' });
      assert.equal(mutation.state, 'failed');
      if (mutation.state !== 'failed') throw new Error('read session mutated the backend');
      assert.equal(mutation.why.code, 'E_READ_ONLY');
      const profile = await readClient.query(api.profile, {});
      assert.ok('data' in profile);
      assert.equal(profile.data.name, 'Alice');
      assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM account').get().count, 0);
    });

    await t.test('SDK follows the anonymous challenge and discovers both metadata documents', async () => {
      const response = await request('/mcp');
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate'), /resource_metadata/);
      const metadata = await discoverOAuthProtectedResourceMetadata(service.resource);
      assert.equal(metadata.resource, service.resource);
      assert.deepEqual(metadata.authorization_servers, [service.issuer]);
      const as = await discoverAuthorizationServerMetadata(service.issuer);
      assert.equal(as.issuer, service.issuer);
      assert.equal(as.client_id_metadata_document_supported, true);
      assert.ok(as.registration_endpoint);
      assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    });

    const profiles = [
      { redirect: 'http://127.0.0.1:49152/callback', account: alice, name: 'Alice' },
      { redirect: 'https://chatgpt.com/connector_platform_oauth_redirect', account: bob, name: 'Bob' },
      { redirect: 'https://claude.ai/api/mcp/auth_callback', account: alice, name: 'Alice' },
    ];
    for (const profile of profiles) {
      await t.test(`DCR public-client profile with ${new URL(profile.redirect).hostname} callback`, async () => {
        const provider = oauthClient(profile.redirect);
        const url = await begin(provider);
        const callback = await consent(url, profile.account);
        assert.equal(callback.origin + callback.pathname, profile.redirect);
        assert.equal(callback.searchParams.get('state'), provider.state());
        profile.provider = provider;
        profile.code = callback.searchParams.get('code');
        assert.equal(await sdkAuthorize(provider, {
          serverUrl: service.resource, authorizationCode: profile.code,
          iss: callback.searchParams.get('iss'),
        }), 'AUTHORIZED');
        assert.ok(provider.tokens().refresh_token);
        const client = await connect(provider);
        const tools = await client.listTools();
        assert.ok(tools.tools.some(tool => tool.name === 'read_profile'));
        const result = await client.callTool({ name: 'read_profile' });
        assert.equal(result.content[0].type, 'text');
        if (result.content[0].type !== 'text') throw new Error('missing text result');
        assert.equal(JSON.parse(result.content[0].text).name, profile.name);
        await assert.rejects(client.callTool({ name: 'write_probe' }), /[Ii]nsufficient.scope/);
      });
    }

    await t.test('provider rejects replay, wrong verifier, wrong resource, missing PKCE and redirect tampering', async () => {
      const profile = profiles[0];
      const exchange = async overrides => {
        const response = await request('/api/auth/oauth2/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code',
            code: profile.code, client_id: profile.provider.clientInformation().client_id,
            redirect_uri: profile.redirect, code_verifier: profile.provider.codeVerifier(),
            resource: service.resource, ...overrides }),
        });
        assert.equal(response.status, 400);
      };
      await exchange({});
      for (const verifyOptions of [
        { issuer: service.issuer, audience: `${service.origin}/other` },
        { issuer: `${service.origin}/other`, audience: service.resource },
      ]) {
        await assert.rejects(verifyBearerToken(profiles[1].provider.tokens().access_token, {
          verifyOptions, jwksUrl: `${service.issuer}/jwks`,
        }));
      }
      const provider = oauthClient('http://127.0.0.1:49153/callback');
      const url = await begin(provider);
      for (const [key, value] of [['redirect_uri', 'https://attacker.example/callback'], ['resource', 'https://attacker.example/mcp'], ['code_challenge', '']]) {
        const invalid = new URL(url);
        if (value) invalid.searchParams.set(key, value);
        else { invalid.searchParams.delete(key); invalid.searchParams.delete('code_challenge_method'); }
        const response = await request(invalid, { headers: { cookie: alice.cookie } });
        const redirect = response.headers.get('location') ?? (await response.json()).url;
        assert.ok(response.status === 400 || redirect?.includes('error='));
      }
      const callback = await consent(url, alice);
      await exchange({ code: callback.searchParams.get('code'), client_id: provider.clientInformation().client_id,
        redirect_uri: provider.redirectUrl, code_verifier: 'x'.repeat(43) });
      const denied = oauthClient('http://127.0.0.1:49154/callback');
      const refusal = await consent(await begin(denied), alice, false);
      assert.equal(refusal.searchParams.get('error'), 'access_denied');
      assert.equal((await request('/mcp', { headers: { authorization: `Bearer ${accounts[0].token}` } })).status, 401);
    });

    await t.test('public ChatGPT CIMD is discovered through the maintained transport and persisted', {
      skip: process.env.MCP_PROOF_PUBLIC_CIMD !== '1', timeout: 30_000,
    }, async () => {
      const provider = oauthClient('https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com/oauth/client.json');
      const url = await begin(provider);
      assert.equal(url.searchParams.get('client_id'), provider.clientMetadataUrl);
      const callback = await consent(url, alice);
      assert.ok(callback.searchParams.get('code'));
      const row = service.db.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?').get(provider.clientMetadataUrl);
      assert.equal(row.clientId, provider.clientMetadataUrl);
    });

    await t.test('a fresh Node process retains subjects, DCR, consent, signing keys and refresh authority', async () => {
      const counts = () => Object.fromEntries(['user', 'session', 'oauthClient', 'oauthConsent', 'oauthRefreshToken', 'jwks']
        .map(table => [table, service.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
      const before = counts();
      const signingKeys = service.db.prepare('SELECT publicKey, privateKey FROM jwks ORDER BY id').all();
      assert.equal(before.user, 2);
      assert.ok(before.oauthClient >= 3 && before.oauthConsent >= 3 && before.jwks > 0);
      const port = Number(new URL(service.origin).port);
      await service.close();
      const child = fork(fileURLToPath(new URL('./auth.mjs', import.meta.url)), [], {
        execPath: process.execPath, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const ready = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
      child.send({ backend: host.url, path, secret, port });
      const [addresses] = await ready;
      const reopened = new DatabaseSync(path);
      service = { ...addresses, db: reopened, async close() {
        reopened.close();
        const exit = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
        child.disconnect();
        const [code] = await exit;
        assert.equal(code, 0);
      } };
      assert.deepEqual(counts(), before);
      assert.deepEqual(service.db.prepare('SELECT publicKey, privateKey FROM jwks ORDER BY id').all(), signingKeys);
      const reconnected = await signIn(accounts[1]);
      assert.equal(reconnected.subject, bob.subject);
      const provider = profiles[1].provider;
      assert.equal(await sdkAuthorize(provider, { serverUrl: service.resource }), 'AUTHORIZED');
      const result = await (await connect(provider)).callTool({ name: 'read_profile' });
      if (result.content[0].type !== 'text') throw new Error('missing text result');
      assert.equal(JSON.parse(result.content[0].text).name, 'Bob');
    });
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await service?.close();
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
