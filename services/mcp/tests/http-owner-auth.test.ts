import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { startDev } from 'snapback4/proof';
import { createAuthorizationService } from '../src/auth/provider';
import { CredentialVault } from '../src/auth/vault';
import { syntheticAuthorizationEpoch } from './helpers/authorization-epoch';
import { authorizeSynthetic, syntheticOAuthClient } from './helpers/oauth';
import { authorizeSyntheticWrite } from './helpers/write-oauth';

const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!);
const hidden = (body: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
  assert.ok(value, `missing ${name} field`);
  return decode(value);
};

test('owner sign-in and private grant selection use real HTTP, SDK, SQLite and Snapback accounts', { timeout: 120_000 }, async t => {
  assert.equal(process.version, 'v24.22.2');
  const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-owner-auth-'));
  const host = await startDev({ cwd: resolve('.'), logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const server = createServer((request, response) => dispatch(request, response));
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const backendUrl = 'https://snapback.synthetic.test';
  const databasePath = join(directory, 'provider.sqlite');
  const vaultPath = join(directory, 'vault.sqlite');
  let vaultNow: number | undefined;
  const vault = new CredentialVault({ location: vaultPath, activeKeyVersion: 'v1',
    keys: new Map([['v1', randomBytes(32)]]), nowUtcMs: () => vaultNow ?? Date.now() });
  const backendFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, backendUrl);
    return fetch(host.url + url.pathname + url.search, request);
  };
  const service = await createAuthorizationService({ publicOrigin: origin, backendUrl, databasePath,
    secret: randomBytes(48).toString('hex'), vault, authorizationEpoch: syntheticAuthorizationEpoch(),
    allowTestLoopback: true, identityOptions: { fetch: backendFetch },
    writeConnections: { revoke: async (_grant, commit) => commit() } });
  dispatch = toNodeHandler({ fetch: request => service.handler(request) });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close(); vault.close(); await host.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const sql = <T>(path: string, run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path);
    try { return run(db); } finally { db.close(); }
  };
  class Browser {
    cookies = new Map<string, string>();
    get cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
    async request(path: string, init: RequestInit = {}) {
      const response = await fetch(new URL(path, origin), { redirect: 'manual', ...init,
        headers: { accept: 'text/html', cookie: this.cookie, ...init.headers } });
      for (const cookie of response.headers.getSetCookie()) {
        const [name, ...value] = cookie.split(';')[0]!.split('=');
        this.cookies.set(name!, value.join('='));
      }
      return response;
    }
    submit(fields: URLSearchParams | Record<string, string>, headers: Record<string, string> = {}) {
      return this.request('/mcp/account/sign-in', { method: 'POST',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields) });
    }
    ownerRequest(path = '/mcp/connections', method = 'GET', headers: Record<string, string> = {}) {
      return new Request(origin + path, { method, headers: { cookie: this.cookie, ...(method === 'POST' ? { origin } : {}), ...headers } });
    }
  }
  const accounts = [0, 1].map(() => ({ email: `${randomUUID()}@example.test`, password: randomUUID() }));
  const principals: string[] = [];
  for (const account of accounts) {
    const signed = await signup(host.url, account.email, account.password);
    assert.ok(signed.ok);
    principals.push(signed.session.principal);
  }
  const form = async (browser: Browser, returnTo = '/mcp/connections') => {
    const response = await browser.request('/mcp/account/sign-in?return_to=' + encodeURIComponent(returnTo));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.text();
    return { csrf: hidden(body, 'csrf'), return_to: hidden(body, 'return_to'), body };
  };
  const signIn = async (browser: Browser, account: typeof accounts[number], returnTo = '/mcp/connections') => {
    const fields = await form(browser, returnTo);
    const response = await browser.submit({ ...account, csrf: fields.csrf, return_to: fields.return_to });
    assert.equal(response.status, 303, await response.clone().text());
    assert.equal(response.headers.get('location'), returnTo);
  };

  await t.test('standalone owner login creates only a read-verified browser session and safe return', async () => {
    const browser = new Browser();
    const quote = `rq1.${randomUUID()}.${'a'.repeat(64)}`;
    const returnTo = `/mcp/reward-confirmation?token=${quote}`;
    const fields = await form(browser, returnTo);
    assert.ok(fields.body.includes('Sign in to Habit System'));
    const response = await browser.submit({ ...accounts[0]!, csrf: fields.csrf, return_to: fields.return_to });
    assert.equal(response.status, 303, await response.clone().text());
    assert.equal(response.headers.get('location'), returnTo);
    const owner = await service.browserSession(browser.ownerRequest());
    assert.equal(owner?.principal, principals[0]);
    assert.deepEqual(await service.ownerConnections(browser.ownerRequest()), []);
    assert.equal(sql(databasePath, db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n), 0);
    assert.equal(sql(databasePath, db => (db.prepare('SELECT COUNT(*) AS n FROM mcp_pending').get() as { n: number }).n), 0);
    assert.equal(sql(vaultPath, db => (db.prepare('SELECT COUNT(*) AS n FROM vault_credentials').get() as { n: number }).n), 0);
    assert.equal(JSON.stringify(owner).includes('token'), false);
  });

  await t.test('malformed returns, credentials, csrf, duplicate fields and origin are refused', async () => {
    const invalid = ['/evil', '//evil.example/mcp/connections', 'https://evil.example/mcp/connections',
      '/mcp/connections?next=/evil', '/mcp/reward-confirmation', '/mcp/reward-confirmation?token=x&next=1',
      '/mcp/reward-confirmation?token=bad%2Fpath', '/mcp/../mcp/connections', '/mcp/connections#part'];
    const browser = new Browser();
    await assert.rejects(service.ownerConnections(browser.ownerRequest()));
    for (const value of invalid) {
      const response = await browser.request('/mcp/account/sign-in?return_to=' + encodeURIComponent(value));
      assert.equal(response.status, 400, value);
    }
    assert.equal((await browser.request('/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections&extra=1')).status, 400);
    assert.equal((await browser.request('/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections&return_to=%2Fmcp%2Fconnections')).status, 400);
    assert.equal((await browser.request('/mcp/account/sign-in?return_to=' + encodeURIComponent('/mcp/reward-confirmation?token=' + 'a'.repeat(4200)))).status, 400);
    assert.equal((await browser.request('/mcp/auth/private/owner-sign-in')).status, 404);
    const fields = await form(browser);
    const wrong = await browser.submit({ email: accounts[0]!.email, password: 'wrong-password',
      csrf: fields.csrf, return_to: fields.return_to });
    assert.equal(wrong.status, 401);
    assert.ok((await wrong.text()).includes('Sign-in was refused'));
    assert.equal((await browser.submit({ ...accounts[0]!, csrf: fields.csrf,
      return_to: '/mcp/reward-confirmation?token=' + `rq1.${randomUUID()}.${'a'.repeat(64)}` })).status, 403);
    assert.equal((await browser.submit({ ...accounts[0]!, csrf: 'bad', return_to: fields.return_to })).status, 403);
    assert.equal((await browser.submit({ ...accounts[0]!, csrf: fields.csrf, return_to: fields.return_to },
      { origin: 'https://evil.example' })).status, 403);
    assert.equal((await browser.submit({ ...accounts[0]!, csrf: fields.csrf, return_to: fields.return_to },
      { 'sec-fetch-site': 'cross-site' })).status, 403);
    const duplicate = new URLSearchParams({ ...accounts[0]!, csrf: fields.csrf, return_to: fields.return_to });
    duplicate.append('csrf', fields.csrf);
    assert.equal((await browser.submit(duplicate)).status, 400);
    assert.equal((await browser.submit({ ...accounts[0]!, csrf: fields.csrf,
      return_to: fields.return_to, scope: 'checkins:write' })).status, 400);
    assert.equal(await service.browserSession(browser.ownerRequest()), null);
  });

  await t.test('owner listing and full resume bind exact account, scopes and live provider sessions', async () => {
    const alice = new Browser(), bob = new Browser();
    await signIn(alice, accounts[0]!);
    await signIn(bob, accounts[1]!);
    const aOwner = await service.browserSession(alice.ownerRequest());
    const bOwner = await service.browserSession(bob.ownerRequest());
    assert.ok(aOwner && bOwner);
    assert.notEqual(aOwner.accountId, bOwner.accountId);
    const writeA = syntheticOAuthClient('Owner A write');
    const writeB = syntheticOAuthClient('Owner B write');
    const readA = syntheticOAuthClient('Owner A read');
    await authorizeSyntheticWrite(service.resource, writeA, accounts[0]!);
    await authorizeSyntheticWrite(service.resource, writeB, accounts[1]!);
    await authorizeSynthetic(service.resource, readA, accounts[0]!);
    const bearer = (client: ReturnType<typeof syntheticOAuthClient>) => new Request(service.resource,
      { headers: { authorization: `Bearer ${client.tokens()!.access_token}` } });
    const aWrite = await service.authenticate(bearer(writeA));
    const bWrite = await service.authenticate(bearer(writeB));
    const aRead = await service.authenticate(bearer(readA));
    await signIn(alice, accounts[1]!);
    assert.equal((await service.browserSession(alice.ownerRequest()))?.accountId, bOwner.accountId);
    await aWrite.assertActive();
    await signIn(alice, accounts[0]!);
    assert.equal((await service.browserSession(alice.ownerRequest()))?.accountId, aOwner.accountId);
    const listed = await service.ownerConnections(alice.ownerRequest());
    assert.equal(listed.length, 2);
    assert.equal(listed.some(grant => grant.grantId === bWrite.grantId), false);
    assert.deepEqual(Object.keys(listed[0]!).sort(),
      ['active', 'clientId', 'credentialScope', 'expiresAt', 'grantId', 'scopes']);
    assert.equal(JSON.stringify(listed).includes(aWrite.session.token), false);
    assert.equal(listed.find(grant => grant.grantId === aWrite.grantId)?.credentialScope, 'full');
    assert.equal(listed.find(grant => grant.grantId === aRead.grantId)?.credentialScope, 'read');
    assert.equal((await service.ownerConnections(bob.ownerRequest())).length, 1);
    const selected = await service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST'), aWrite.grantId);
    assert.deepEqual(selected.scopes, aWrite.scopes);
    assert.equal(selected.session.scope, 'full');
    await selected.assertActive();
    await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST'), aRead.grantId));
    await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST'), bWrite.grantId));
    await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume'), aWrite.grantId));
    await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST',
      { origin: 'https://evil.example' }), aWrite.grantId));
    await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST',
      { 'sec-fetch-site': 'cross-site' }), aWrite.grantId));
    const grant = service.lookupGrant({ accountId: aOwner.accountId, grantId: aWrite.grantId });
    assert.ok(grant);
    sql(databasePath, db => db.prepare('UPDATE mcp_grants SET user_id = ?, session_id = ? WHERE id = ?')
      .run(bOwner.accountId, bOwner.providerSessionId, aWrite.grantId));
    try {
      const malformed = (await service.ownerConnections(alice.ownerRequest()))
        .find(item => item.grantId === aWrite.grantId);
      assert.equal(malformed?.active, false);
      await assert.rejects(service.ownerResumeContext(alice.ownerRequest('/mcp/connections/resume', 'POST'), aWrite.grantId));
      await assert.rejects(selected.assertActive());
    } finally {
      sql(databasePath, db => db.prepare('UPDATE mcp_grants SET user_id = ?, session_id = ? WHERE id = ?')
        .run(grant.userId, grant.sessionId, aWrite.grantId));
    }
    await selected.assertActive();
    sql(databasePath, db => {
      db.prepare('UPDATE mcp_grants SET user_id = ? WHERE id = ?').run(bOwner.accountId, aWrite.grantId);
      db.prepare('UPDATE session SET userId = ? WHERE id = ?').run(bOwner.accountId, grant.sessionId);
    });
    try { await assert.rejects(selected.assertActive()); }
    finally {
      sql(databasePath, db => {
        db.prepare('UPDATE mcp_grants SET user_id = ? WHERE id = ?').run(grant.userId, aWrite.grantId);
        db.prepare('UPDATE session SET userId = ? WHERE id = ?').run(grant.userId, grant.sessionId);
      });
    }
    await selected.assertActive();
    sql(databasePath, db => db.prepare('UPDATE mcp_grants SET scopes = ? WHERE id = ?')
      .run(JSON.stringify(['habits:read']), aWrite.grantId));
    await assert.rejects(selected.assertActive());
    sql(databasePath, db => db.prepare('UPDATE mcp_grants SET scopes = ? WHERE id = ?')
      .run(JSON.stringify(grant.scopes), aWrite.grantId));
    await selected.assertActive();
    sql(databasePath, db => db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, aWrite.grantId));
    await assert.rejects(selected.assertActive());
    sql(databasePath, db => db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?')
      .run(grant.expiresAt, aWrite.grantId));
    await selected.assertActive();
    vaultNow = aWrite.session.expiresAt + 1;
    await assert.rejects(selected.assertActive());
    vaultNow = undefined;
    await selected.assertActive();
    const providerExpiry = sql(databasePath, db => (db.prepare('SELECT expiresAt FROM session WHERE id = ?')
      .get(grant.sessionId) as { expiresAt: number }).expiresAt);
    sql(databasePath, db => db.prepare('UPDATE session SET expiresAt = ? WHERE id = ?')
      .run(Date.now() - 1, grant.sessionId));
    await assert.rejects(selected.assertActive());
    sql(databasePath, db => db.prepare('UPDATE session SET expiresAt = ? WHERE id = ?')
      .run(providerExpiry, grant.sessionId));
    await selected.assertActive();
    sql(databasePath, db => db.prepare('DELETE FROM session WHERE id = ?').run(
      service.lookupGrant({ accountId: aOwner.accountId, grantId: aRead.grantId })!.sessionId));
    assert.equal((await service.ownerConnections(alice.ownerRequest())).find(item => item.grantId === aRead.grantId)?.active, false);
    await service.revokeGrant({ accountId: aOwner.accountId, grantId: aWrite.grantId });
    await assert.rejects(selected.assertActive());
    assert.equal((await service.ownerConnections(alice.ownerRequest())).find(item => item.grantId === aWrite.grantId)?.active, false);
    await bWrite.assertActive();
    const bSelected = await service.ownerResumeContext(bob.ownerRequest('/mcp/connections/resume', 'POST'), bWrite.grantId);
    sql(databasePath, db => db.prepare('DELETE FROM session WHERE id = ?').run(bOwner.providerSessionId));
    await assert.rejects(bSelected.assertActive());
    await bWrite.assertActive();
    const bobAgain = new Browser();
    await signIn(bobAgain, accounts[1]!);
    const bFresh = await service.ownerResumeContext(bobAgain.ownerRequest('/mcp/connections/resume', 'POST'), bWrite.grantId);
    sql(databasePath, db => db.prepare('DELETE FROM session WHERE id = ?').run(
      service.lookupGrant({ accountId: bOwner.accountId, grantId: bWrite.grantId })!.sessionId));
    await assert.rejects(bFresh.assertActive());
    const expiry = Date.now() + 60_000;
    sql(databasePath, db => {
      const insert = db.prepare(`INSERT INTO mcp_grants
        (id, account_id, backend, principal, user_id, client_id, session_id, lineage, scopes, credential_scope, expires_at, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'read', ?, 0)`);
      for (let index = 0; index < 101; index++) insert.run(randomUUID(), aOwner.accountId, backendUrl,
        aOwner.principal, aOwner.accountId, `overflow-client-${index}`, randomUUID(), randomUUID(),
        JSON.stringify(['habits:read']), expiry);
    });
    await assert.rejects(service.ownerConnections(alice.ownerRequest()), /more than 100 connections/);
  });
});
