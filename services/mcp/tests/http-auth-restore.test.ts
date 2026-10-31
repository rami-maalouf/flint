import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { auth as sdkAuthorize } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { api } from '../../../snapback/generated/api.ts';
import { createAuthorizationService } from '../src/auth/provider';
import { CredentialVault } from '../src/auth/vault';
import { authorizeSynthetic, syntheticOAuthClient } from './helpers/oauth';

const hidden = (body: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
  assert.ok(value);
  return value.replace(/&amp;/g, '&');
};

test('a restore epoch rejects old access, refresh, browser and pending authority while fresh reads work', { timeout: 60_000 }, async () => {
  assert.equal(process.version, 'v24.22.2');
  const directory = await mkdtemp(join(tmpdir(), 'mcp-auth-rollback-proof-'));
  const host = await startDev({ cwd: resolve('.'), logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const databasePath = join(directory, 'provider.sqlite');
  const vaultPath = join(directory, 'vault.sqlite');
  const backupProvider = join(directory, 'provider.snapshot.sqlite');
  const backupVault = join(directory, 'vault.snapshot.sqlite');
  const secret = randomBytes(48).toString('hex');
  let epoch = 'first-test-epoch';
  let mode: 'normal' | 'degraded_read' = 'normal';
  let epochFailure: 'none' | 'malformed' | 'throw' = 'none';
  const authorizationEpoch = { current: async () => {
    if (epochFailure === 'throw') throw new Error('synthetic marker failure');
    return { epoch: epochFailure === 'malformed' ? '' : epoch, mode };
  } };
  const key = randomBytes(32);
  const backendUrl = 'https://snapback.synthetic.test';
  let logoutOutage = false;
  const backendFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, backendUrl);
    if (logoutOutage && url.pathname === '/auth/logout') throw new Error('synthetic upstream outage');
    return fetch(host.url + url.pathname + url.search, init);
  };
  const server = createServer((request, response) => dispatch(request, response));
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let vault = new CredentialVault({ location: vaultPath, activeKeyVersion: 'v1', keys: new Map([['v1', key]]) });
  let service: Awaited<ReturnType<typeof createAuthorizationService>> | undefined;
  const accounts = [0, 1].map(() => ({ email: randomUUID() + '@example.test', password: randomUUID() }));
  for (const account of accounts) assert.ok((await signup(host.url, account.email, account.password)).ok);
  const clients = [syntheticOAuthClient('rollback A'), syntheticOAuthClient('rollback B')];
  const browserCookies = new Map<string, string>();
  const browser = async (path: string, init: RequestInit = {}) => {
    const cookie = [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(origin + path, { redirect: 'manual', ...init,
      headers: { accept: 'text/html', cookie, ...init.headers } });
    for (const entry of response.headers.getSetCookie()) {
      const [name, ...value] = entry.split(';')[0]!.split('=');
      browserCookies.set(name!, value.join('='));
    }
    return response;
  };
  const isolatedBrowser = () => {
    const cookies = new Map<string, string>();
    const send = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(new URL(path, origin), { redirect: 'manual', ...init,
        headers: { accept: 'text/html', cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...init.headers } });
      for (const entry of response.headers.getSetCookie()) {
        const [name, ...value] = entry.split(';')[0]!.split('=');
        cookies.set(name!, value.join('='));
      }
      return response;
    };
    return { send, cookieHeader: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  };
  const openConsent = async (client: ReturnType<typeof syntheticOAuthClient>,
    scope = 'habits:read coins:read offline_access') => {
    assert.equal(await sdkAuthorize(client, { serverUrl: origin + '/mcp',
      scope }), 'REDIRECT');
    const browser = isolatedBrowser();
    let response = await browser.send(client.authorizationUrl().href);
    assert.equal(response.status, 303);
    response = await browser.send(response.headers.get('location')!);
    assert.equal(response.status, 200);
    let body = await response.text();
    response = await browser.send('/mcp/sign-in', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') }) });
    assert.equal(response.status, 303);
    response = await browser.send(response.headers.get('location')!);
    assert.equal(response.status, 200);
    body = await response.text();
    return { browser, csrf: hidden(body, 'csrf'), oauthQuery: hidden(body, 'oauth_query') };
  };
  const make = async (enableWrites = true) => {
    service = await createAuthorizationService({ publicOrigin: origin, backendUrl, databasePath, secret, vault,
      authorizationEpoch, writeConnections: enableWrites ? { revoke: async (_grant, commit) => commit() } : undefined,
      identityOptions: { fetch: backendFetch }, allowTestLoopback: true });
    dispatch = toNodeHandler({ fetch: request => service!.handler(request) });
  };
  const access = (index: number) => new Request(origin + '/mcp',
    { headers: { authorization: `Bearer ${clients[index]!.tokens()!.access_token}` } });
  const snapshot = (from: string, to: string) => {
    const db = new DatabaseSync(from);
    try { db.prepare('VACUUM INTO ?').run(to); } finally { db.close(); }
  };
  const restore = async (from: string, to: string) => {
    await rm(to + '-wal', { force: true });
    await rm(to + '-shm', { force: true });
    await copyFile(from, to);
    await chmod(to, 0o600);
  };
  const readUpstream = async (token: string, readOnly = true) => {
    const client = createClient({ url: host.url, token, readOnly });
    try { return await client.query(api.profile, {}); }
    finally { await client.close(); }
  };
  try {
    await make();
    assert.equal(await sdkAuthorize(clients[0]!, { serverUrl: origin + '/mcp',
      scope: 'habits:read coins:read offline_access' }), 'REDIRECT');
    let response = await browser(clients[0]!.authorizationUrl().href.replace(origin, ''));
    assert.equal(response.status, 303);
    response = await browser(new URL(response.headers.get('location')!, origin).pathname +
      new URL(response.headers.get('location')!, origin).search);
    assert.equal(response.status, 200);
    let body = await response.text();
    response = await browser('/mcp/sign-in', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...accounts[0]!, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') }) });
    assert.equal(response.status, 303);
    response = await browser(new URL(response.headers.get('location')!, origin).pathname +
      new URL(response.headers.get('location')!, origin).search);
    assert.equal(response.status, 200);
    body = await response.text();
    response = await browser('/mcp/consent', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') }) });
    assert.equal(response.status, 303);
    const callback = new URL(response.headers.get('location')!);
    assert.equal(await sdkAuthorize(clients[0]!, { serverUrl: origin + '/mcp',
      authorizationCode: callback.searchParams.get('code')!, iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
    await authorizeSynthetic(origin + '/mcp', clients[1]!, accounts[1]!);
    const contextA = await service!.authenticate(access(0));
    const contextB = await service!.authenticate(access(1));
    const oldAAccess = clients[0]!.tokens()!.access_token;
    const oldARefresh = clients[0]!.tokens()!.refresh_token!;
    const pendingClient = syntheticOAuthClient('pending before restore');
    const pending = await openConsent(pendingClient);
    const codeClient = syntheticOAuthClient('code before restore');
    const issued = await openConsent(codeClient);
    const codeResponse = await issued.browser.send('/mcp/consent', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', csrf: issued.csrf, oauth_query: issued.oauthQuery }) });
    assert.equal(codeResponse.status, 303);
    const oldCodeCallback = new URL(codeResponse.headers.get('location')!);
    assert.ok(oldCodeCallback.searchParams.get('code'));
    const fullClient = syntheticOAuthClient('full before restore');
    const fullPending = await openConsent(fullClient, 'habits:read checkins:write offline_access');
    const fullResponse = await fullPending.browser.send('/mcp/consent', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', csrf: fullPending.csrf,
        oauth_query: fullPending.oauthQuery, ...accounts[0]! }) });
    assert.equal(fullResponse.status, 303);
    const fullCallback = new URL(fullResponse.headers.get('location')!);
    assert.equal(await sdkAuthorize(fullClient, { serverUrl: origin + '/mcp',
      authorizationCode: fullCallback.searchParams.get('code')!,
      iss: fullCallback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
    const fullContext = await service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${fullClient.tokens()!.access_token}` } }));
    assert.equal(fullContext.session.scope, 'full');
    mode = 'degraded_read';
    await assert.rejects(fullContext.assertActive());
    assert.equal((await service!.deliveryGrantStatus(fullContext.grantId))?.active, false);
    await assert.rejects(service!.ownerResumeContext(new Request(origin + '/mcp/reward-confirmation', {
      method: 'POST', headers: { origin, cookie: fullPending.browser.cookieHeader() },
    }), fullContext.grantId));
    mode = 'normal';
    await fullContext.assertActive();
    assert.equal((await service!.browserSession(new Request(origin + '/mcp/connections',
      { headers: { cookie: [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; ') } })))?.accountId,
    contextA.accountId);
    snapshot(databasePath, backupProvider);
    snapshot(vaultPath, backupVault);
    logoutOutage = true;
    await service!.revokeGrant({ accountId: contextA.accountId, grantId: contextA.grantId });
    const cutoffDatabase = new DatabaseSync(databasePath);
    try {
      const retirement = cutoffDatabase.prepare('SELECT retirement_uncertain, retirement_attempted_at FROM mcp_grants WHERE id = ?')
        .get(contextA.grantId) as { retirement_uncertain: number; retirement_attempted_at: number | null };
      assert.equal(retirement.retirement_uncertain, 1);
      assert.ok(retirement.retirement_attempted_at && retirement.retirement_attempted_at <= Date.now());
    } finally { cutoffDatabase.close(); }
    await assert.rejects(service!.authenticate(access(0)));
    assert.equal(await service!.browserSession(new Request(origin + '/mcp/connections',
      { headers: { cookie: [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; ') } })), null);
    await contextB.assertActive();
    assert.equal('denied' in await readUpstream(contextA.session.token), false,
      'local cutoff survives an upstream logout outage');
    logoutOutage = false;
    await service!.close(); service = undefined; vault.close();
    await restore(backupProvider, databasePath);
    await restore(backupVault, vaultPath);
    epoch = 'second-test-epoch';
    mode = 'degraded_read';
    vault = new CredentialVault({ location: vaultPath, activeKeyVersion: 'v1', keys: new Map([['v1', key]]) });
    await make();
    const restoredDatabase = new DatabaseSync(databasePath);
    try {
      const restored = restoredDatabase.prepare('SELECT active, authorization_epoch FROM mcp_grants WHERE id = ?')
        .get(contextA.grantId) as { active: number; authorization_epoch: string };
      assert.equal(restored.active, 1);
      assert.equal(restored.authorization_epoch, 'first-test-epoch');
    } finally { restoredDatabase.close(); }
    await assert.rejects(service!.authenticate(access(0)),
      'a restored pre-disconnect access token must not regain authority');
    await assert.rejects(service!.authenticate(access(1)),
      'every pre-restore grant is stale after epoch rotation');
    await assert.rejects(service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${fullClient.tokens()!.access_token}` } })));
    const refresh = await fetch(origin + '/mcp/auth/oauth2/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: clients[0]!.tokens()!.refresh_token!,
        client_id: clients[0]!.clientInformation()!.client_id, resource: origin + '/mcp',
      }) });
    assert.equal(refresh.status, 400);
    const stalePending = await pending.browser.send('/mcp/consent', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'allow', csrf: pending.csrf, oauth_query: pending.oauthQuery }) });
    assert.equal(stalePending.status, 401);
    await assert.rejects(sdkAuthorize(codeClient, { serverUrl: origin + '/mcp',
      authorizationCode: oldCodeCallback.searchParams.get('code')!,
      iss: oldCodeCallback.searchParams.get('iss') ?? undefined }));
    assert.equal((await service!.deliveryGrantStatus(contextA.grantId))?.active, false);
    assert.equal((await service!.deliveryGrantStatus(contextB.grantId))?.active, false);
    const browserRequest = new Request(origin + '/mcp/connections', { headers: {
      cookie: [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; '),
    } });
    assert.equal(await service!.browserSession(browserRequest), null);
    await assert.rejects(service!.ownerConnections(browserRequest));
    assert.equal((await browser(clients[0]!.authorizationUrl().href.replace(origin, ''))).status, 401,
      'the maintained authorize endpoint cannot reuse an old browser session');
    const fresh = syntheticOAuthClient('fresh degraded read');
    await authorizeSynthetic(origin + '/mcp', fresh, accounts[0]!);
    const freshContext = await service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${fresh.tokens()!.access_token}` } }));
    assert.equal(freshContext.accountId, contextA.accountId);
    assert.equal(freshContext.session.scope, 'read');
    const reconnectClient = syntheticOAuthClient('rollback A reconnect');
    reconnectClient.saveClientInformation(clients[0]!.clientInformation()!);
    await authorizeSynthetic(origin + '/mcp', reconnectClient, accounts[0]!);
    const reconnect = await service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${reconnectClient.tokens()!.access_token}` } }));
    assert.equal(reconnect.accountId, contextA.accountId);
    assert.equal(reconnect.clientId, contextA.clientId);
    assert.notEqual(reconnect.grantId, contextA.grantId);
    let replacementRefresh = reconnectClient.tokens()!.refresh_token!;
    const refreshReplacement = async () => {
      const result = await fetch(origin + '/mcp/auth/oauth2/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: replacementRefresh,
          client_id: reconnect.clientId, resource: origin + '/mcp',
        }) });
      if (result.status === 200) {
        const tokens = await result.json() as { access_token: string; refresh_token: string };
        replacementRefresh = tokens.refresh_token;
        assert.equal((await service!.authenticate(new Request(origin + '/mcp',
          { headers: { authorization: `Bearer ${tokens.access_token}` } }))).grantId, reconnect.grantId);
      }
      return result.status;
    };
    assert.equal(await refreshReplacement(), 200);
    for (const token of [oldARefresh, oldAAccess, oldARefresh, oldAAccess]) {
      const revoked = await fetch(origin + '/mcp/auth/oauth2/revoke', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          token, token_type_hint: token === oldARefresh ? 'refresh_token' : 'access_token',
          client_id: reconnect.clientId,
        }) });
      assert.equal(revoked.status, 200, 'known stale A revocation is idempotent');
      await reconnect.assertActive();
      assert.equal(await refreshReplacement(), 200, 'stale A revocation must preserve same-client reconnect B');
    }
    const ownerPage = await browser('/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections');
    assert.equal(ownerPage.status, 200);
    const ownerForm = await ownerPage.text();
    const ownerLogin = await browser('/mcp/account/sign-in', { method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...accounts[0]!, csrf: hidden(ownerForm, 'csrf'),
        return_to: hidden(ownerForm, 'return_to') }) });
    assert.equal(ownerLogin.status, 303);
    const freshOwnerRequest = new Request(origin + '/mcp/connections', { headers: {
      cookie: [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; '),
    } });
    const listed = await service!.ownerConnections(freshOwnerRequest);
    assert.equal(listed.find(item => item.grantId === contextA.grantId)?.active, false);
    assert.equal(listed.find(item => item.grantId === contextB.grantId), undefined);
    assert.equal(listed.find(item => item.grantId === freshContext.grantId)?.active, true);
    await assert.rejects(service!.ownerResumeContext(new Request(origin + '/mcp/reward-confirmation', {
      method: 'POST', headers: { origin, cookie: freshOwnerRequest.headers.get('cookie')! },
    }), fullContext.grantId));
    const blockedWrite = syntheticOAuthClient('blocked degraded write');
    assert.equal(await sdkAuthorize(blockedWrite, { serverUrl: origin + '/mcp',
      scope: 'habits:read checkins:write offline_access' }), 'REDIRECT');
    const writeBrowser = isolatedBrowser();
    let writeResponse = await writeBrowser.send(blockedWrite.authorizationUrl().href);
    assert.equal(writeResponse.status, 303);
    writeResponse = await writeBrowser.send(writeResponse.headers.get('location')!);
    assert.equal(writeResponse.status, 403);
    const vaultDatabase = new DatabaseSync(vaultPath);
    try {
      assert.equal((vaultDatabase.prepare("SELECT count(*) AS n FROM vault_credentials WHERE scope = 'full' AND token_hash IS NOT NULL")
        .get() as { n: number }).n, 1);
    } finally { vaultDatabase.close(); }
    epochFailure = 'malformed';
    await assert.rejects(service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${fresh.tokens()!.access_token}` } })));
    epochFailure = 'throw';
    await assert.rejects(service!.authenticate(new Request(origin + '/mcp',
      { headers: { authorization: `Bearer ${fresh.tokens()!.access_token}` } })));
    epochFailure = 'none';
    await service!.revokeGrant({ accountId: freshContext.accountId, grantId: freshContext.grantId });
    assert.equal('denied' in await readUpstream(freshContext.session.token), true,
      'the supported exact-session logout retires only the disconnected session');
    assert.equal('denied' in await readUpstream(fullContext.session.token, false), false,
      'a separate same-account upstream session remains live');
    assert.equal('denied' in await readUpstream(contextB.session.token), false,
      'restore fencing leaves independent upstream sessions alone');
    await service!.close(); service = undefined;
    await assert.rejects(make(false), /Active write grants require a write connection lifecycle/);
    const readOnlyVault = new CredentialVault({ location: join(directory, 'read-only-vault.sqlite'),
      activeKeyVersion: 'v1', keys: new Map([['v1', key]]) });
    let readOnlyService: Awaited<ReturnType<typeof createAuthorizationService>> | undefined;
    try {
      readOnlyService = await createAuthorizationService({ publicOrigin: origin, backendUrl,
        databasePath: join(directory, 'read-only-provider.sqlite'), secret, vault: readOnlyVault,
        authorizationEpoch, identityOptions: { fetch: backendFetch }, allowTestLoopback: true });
      dispatch = toNodeHandler({ fetch: request => readOnlyService!.handler(request) });
      const readOnlyAfterRestore = syntheticOAuthClient('read-only after restore');
      await authorizeSynthetic(origin + '/mcp', readOnlyAfterRestore, accounts[1]!);
      const readOnlyContext = await readOnlyService.authenticate(new Request(origin + '/mcp',
        { headers: { authorization: `Bearer ${readOnlyAfterRestore.tokens()!.access_token}` } }));
      assert.equal(readOnlyContext.accountId, contextB.accountId);
      assert.equal(readOnlyContext.session.scope, 'read');
      assert.equal(await readOnlyService.deliveryGrantStatus(fullContext.grantId), null);
    } finally { await readOnlyService?.close(); readOnlyVault.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await service?.close(); vault.close(); await host.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
