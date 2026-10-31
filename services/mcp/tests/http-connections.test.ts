import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { auth } from '@modelcontextprotocol/client';

import { createBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { accountDirectory } from '../src/accounts/replica';
import { FileRestoreLatch } from '../src/operations/recovery-head';
import { createConnectionsHandler } from '../src/web/connections';
import { renderConnectionsPage } from '../src/web/connections-pages';
import { syntheticOAuthClient } from './helpers/oauth';
import { fullService } from './helpers/full-service';

function field(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing ${name}`);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function form(html: string, action: 'revoke' | 'resume', grantId: string): string {
  const match = new RegExp(`<form[^>]*data-action="${action}"[^>]*data-grant-id="${grantId}"[^>]*>([\\s\\S]*?)<\\/form>`).exec(html);
  assert.ok(match, `missing ${action} form for ${grantId}`);
  return match[1];
}
function csrfCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('mcp-connections-form='));
  assert.ok(cookie);
  return cookie.split(';')[0];
}
async function page(origin: string, browserCookie: string) {
  const response = await fetch(origin + '/mcp/connections', { headers: { cookie: browserCookie }, redirect: 'manual' });
  return { response, html: await response.text(), csrf: csrfCookie(response) };
}
async function submit(origin: string, browserCookie: string, csrf: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(origin + '/mcp/connections', { method: 'POST', redirect: 'manual', headers: {
    origin, cookie: browserCookie + '; ' + csrf, 'content-type': 'application/x-www-form-urlencoded', ...headers,
  }, body: new URLSearchParams(body) });
}
function pending(directory: string, accountId: string): number {
  const db = new DatabaseSync(join(accountDirectory(directory, accountId), 'product.sqlite'), { readOnly: true });
  try { return Number(db.prepare('SELECT count(*) AS n FROM mutation_outbox').get()!.n); } finally { db.close(); }
}
function checkins(directory: string, accountId: string): number {
  const db = new DatabaseSync(join(accountDirectory(directory, accountId), 'product.sqlite'), { readOnly: true });
  try { return Number(db.prepare('SELECT count(*) AS n FROM check_ins').get()!.n); } finally { db.close(); }
}
async function authorizeRead(service: Awaited<ReturnType<typeof fullService>>,
  provider: ReturnType<typeof syntheticOAuthClient>, credentials: { email: string; password: string }) {
  assert.equal(await auth(provider, { serverUrl: service.authorization.resource, scope: 'habits:read offline_access' }), 'REDIRECT');
  const cookies = new Map<string, string>();
  const request = async (url: string | URL, init: RequestInit = {}) => {
    const response = await fetch(new URL(url, service.publicOrigin), { redirect: 'manual', ...init,
      headers: { accept: 'text/html', cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('='); cookies.set(name, value.join('='));
    }
    return response;
  };
  const submitForm = (url: string, body: Record<string, string>) => request(url, { method: 'POST',
    headers: { origin: service.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let response = await request(provider.authorizationUrl());
  response = await request(response.headers.get('location')!);
  let html = await response.text();
  response = await submitForm('/mcp/sign-in', { ...credentials, csrf: field(html, 'csrf'), oauth_query: field(html, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  response = await request(response.headers.get('location')!);
  html = await response.text();
  response = await submitForm('/mcp/consent', { decision: 'allow', csrf: field(html, 'csrf'), oauth_query: field(html, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  const callback = new URL(response.headers.get('location')!);
  assert.equal(await auth(provider, { serverUrl: service.authorization.resource,
    authorizationCode: callback.searchParams.get('code')!, iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
  return service.authorization.authenticate(new Request(service.authorization.resource,
    { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } }));
}

test('M20 owner browser revokes A and explicitly resumes its pending work through B', { timeout: 180_000 }, async t => {
  const service = await fullService(t);
  const secret = randomBytes(48).toString('hex');
  const connections = createConnectionsHandler({ authorization: service.authorization, accounts: service.accounts,
    publicOrigin: service.publicOrigin, secret });
  assert.equal(await connections.fetch(new Request(service.publicOrigin + '/mcp/reward-confirmation')), null);
  service.mountOwnerBrowser(connections);
  const anonymous = await fetch(service.publicOrigin + '/mcp/connections', { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), service.publicOrigin + '/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections');
  const owner = await service.account();
  const board = await createBoard({ db: owner.seed, ...service.ports }, { commandId: randomUUID() as CommandId,
    title: 'synthetic connection test', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true,
    coinCapPerDay: 10 });
  assert.ok(board.ok);
  await owner.sync();
  const { context: a } = await owner.authorize();
  const otherApp = syntheticOAuthClient('synthetic other connection');
  const { browserSession: browserB, context: b } = await owner.authorize(otherApp);
  assert.notEqual(a.clientId, b.clientId);
  const clientA = await owner.connect();
  const originalFetch = globalThis.fetch;
  let rejectedUploads = 0;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === service.host.url && new URL(request.url).pathname === '/m/uploadRecord') {
      rejectedUploads++;
      return Promise.resolve(new Response('synthetic offline upload', { status: 503 }));
    }
    return originalFetch(input, init);
  };
  try {
    const result = await clientA.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId: board.value.boardId, timeZone: 'UTC',
    } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(rejectedUploads > 0);
  assert.ok(pending(service.replicas, a.accountId) > 0);
  const queueBeforeGet = pending(service.replicas, a.accountId);
  const checkinsBeforeGet = checkins(service.replicas, a.accountId);
  const shown = await page(service.publicOrigin, browserB.cookieHeader());
  assert.equal(shown.response.status, 200);
  assert.match(shown.html, new RegExp(a.clientId));
  assert.match(shown.html, new RegExp(b.clientId));
  const revoke = form(shown.html, 'revoke', a.grantId);
  const noEffect = await fetch(service.publicOrigin + '/mcp/connections?action=revoke&grant_id=' + a.grantId,
    { headers: { cookie: browserB.cookieHeader() } });
  assert.equal(noEffect.status, 400);
  assert.equal(pending(service.replicas, a.accountId), queueBeforeGet);
  assert.equal(checkins(service.replicas, a.accountId), checkinsBeforeGet);
  assert.equal((await service.authorization.ownerConnections(new Request(service.publicOrigin + '/mcp/connections',
    { headers: { cookie: browserB.cookieHeader() } }))).find(grant => grant.grantId === a.grantId)?.active, true);
  const disconnected = await submit(service.publicOrigin, browserB.cookieHeader(), shown.csrf,
    { action: 'revoke', grant_id: a.grantId, csrf: field(revoke, 'csrf') });
  assert.equal(disconnected.status, 200, await disconnected.clone().text());
  assert.match(await disconnected.text(), /Connection disconnected/);
  assert.ok(pending(service.replicas, a.accountId) > 0);
  const clientB = await owner.connect(otherApp);
  const beforeCheckins = checkins(service.replicas, a.accountId);
  const beforeQueue = pending(service.replicas, a.accountId);
  const denied = await clientB.callTool({ name: 'create_checkin', arguments: {
    operationId: randomUUID(), habitId: board.value.boardId, timeZone: 'UTC',
  } });
  assert.equal(denied.isError, true);
  assert.ok(['OPERATION_PENDING', 'UNAVAILABLE'].includes((denied.structuredContent as { error: { code: string } }).error.code));
  assert.equal(checkins(service.replicas, a.accountId), beforeCheckins);
  assert.equal(pending(service.replicas, a.accountId), beforeQueue);

  service.mountOwnerBrowser(createConnectionsHandler({ authorization: service.authorization, accounts: service.accounts,
    publicOrigin: service.publicOrigin, secret }));
  const resumePage = await page(service.publicOrigin, browserB.cookieHeader());
  assert.match(resumePage.html, /Disconnected/);
  const resume = form(resumePage.html, 'resume', b.grantId);
  const body = { action: 'resume', grant_id: b.grantId, csrf: field(resume, 'csrf') };
  assert.equal((await submit(service.publicOrigin, browserB.cookieHeader(), resumePage.csrf, body)).status, 403);
  const approved = await submit(service.publicOrigin, browserB.cookieHeader(), resumePage.csrf,
    { ...body, consent: 'all_pending' });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.match(await approved.text(), /Resume authorized/);
  assert.equal(pending(service.replicas, a.accountId), 0);
  const journal = new DatabaseSync(join(accountDirectory(service.replicas, a.accountId), 'journal.sqlite'), { readOnly: true });
  try { assert.ok((journal.prepare("SELECT count(*) AS n FROM tuples WHERE disposition = 'accepted'").get() as { n: number }).n > 0); }
  finally { journal.close(); }
});

test('M20 forms bind owner session, action, grant, origin and full authority', { timeout: 180_000 }, async t => {
  const service = await fullService(t);
  const secret = randomBytes(48).toString('hex');
  service.mountOwnerBrowser(createConnectionsHandler({ authorization: service.authorization, accounts: service.accounts,
    publicOrigin: service.publicOrigin, secret }));
  const owner = await service.account();
  const { browserSession: browserA, context: a } = await owner.authorize();
  const otherApp = syntheticOAuthClient('synthetic second connection');
  const { context: b } = await owner.authorize(otherApp);
  const shown = await page(service.publicOrigin, browserA.cookieHeader());
  const revokeA = form(shown.html, 'revoke', a.grantId), resumeA = form(shown.html, 'resume', a.grantId);
  const other = await service.account();
  const { browserSession: browserOther, context: otherContext } = await other.authorize();
  const revokeBody = { action: 'revoke', grant_id: a.grantId, csrf: field(revokeA, 'csrf') };
  assert.equal((await submit(service.publicOrigin, browserOther.cookieHeader(), shown.csrf, revokeBody)).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { ...revokeBody, grant_id: b.grantId })).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { action: 'resume', grant_id: a.grantId, csrf: field(revokeA, 'csrf'), consent: 'all_pending' })).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), '', revokeBody)).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf, revokeBody,
    { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf, revokeBody,
    { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { ...revokeBody, csrf: 'x'.repeat(5000) })).status, 400);
  const duplicate = await fetch(service.publicOrigin + '/mcp/connections', { method: 'POST', headers: {
    origin: service.publicOrigin, cookie: browserA.cookieHeader() + '; ' + shown.csrf,
    'content-type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams([['action', 'revoke'], ['grant_id', a.grantId], ['grant_id', b.grantId],
    ['csrf', field(revokeA, 'csrf')]]) });
  assert.equal(duplicate.status, 400);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { ...revokeBody, grant_id: otherContext.grantId })).status, 403);
  assert.equal((await service.authorization.ownerConnections(new Request(service.publicOrigin + '/mcp/connections',
    { headers: { cookie: browserA.cookieHeader() } }))).find(grant => grant.grantId === a.grantId)?.active, true);

  const readApp = syntheticOAuthClient('synthetic read connection');
  const read = await authorizeRead(service, readApp, owner.credentials);
  const readPage = await page(service.publicOrigin, browserA.cookieHeader());
  assert.doesNotMatch(readPage.html, new RegExp(`data-action="resume" data-grant-id="${read.grantId}"`));
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { action: 'resume', grant_id: read.grantId, csrf: field(resumeA, 'csrf'), consent: 'all_pending' })).status, 403);

  const db = new DatabaseSync(join(service.directory, 'provider.sqlite'));
  try { db.prepare('UPDATE mcp_grants SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a.grantId); }
  finally { db.close(); }
  const expired = await page(service.publicOrigin, browserA.cookieHeader());
  assert.match(expired.html, /Reconnect from the requesting app/);
  assert.equal((await submit(service.publicOrigin, browserA.cookieHeader(), shown.csrf,
    { action: 'resume', grant_id: a.grantId, csrf: field(resumeA, 'csrf'), consent: 'all_pending' })).status, 403);

  const latchPath = join(service.directory, 'external', 'restore-latch');
  const installationId = (JSON.parse(readFileSync(latchPath, 'utf8').split('\n')[0]) as { installationId: string }).installationId;
  new FileRestoreLatch({ path: latchPath, installationId,
    restoredDirectories: [service.replicas, join(service.directory, 'backend')] }).markRestored();
  const restorePage = await page(service.publicOrigin, browserA.cookieHeader());
  const resumeB = form(restorePage.html, 'resume', b.grantId);
  const restore = await submit(service.publicOrigin, browserA.cookieHeader(), restorePage.csrf,
    { action: 'resume', grant_id: b.grantId, csrf: field(resumeB, 'csrf'), consent: 'all_pending' });
  assert.equal(restore.status, 409, await restore.clone().text());
  assert.match(await restore.text(), /needs recovery/i);
});

test('M20 connection page escapes client metadata and keeps the consent action above disconnect', () => {
  const html = renderConnectionsPage([{ grantId: randomUUID(), clientId: '<img src=x onerror=alert(1)>',
    scopes: ['habits:read', 'checkins:write', '<script>'], active: true, credentialScope: 'full', expiresAt: Date.now() + 60_000,
    revokeCsrf: 'revoke', resumeCsrf: 'resume' }]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Unknown permission/);
  assert.ok(html.indexOf('Resume pending delivery') < html.indexOf('Disconnect connection'));
});
