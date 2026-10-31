import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { startDev } from 'snapback4/proof';
import { createAuthorizationService } from '../src/auth/provider';
import { CredentialVault } from '../src/auth/vault';
import { RewardQuoteStore } from '../src/rewards/quotes';
import { createRewardConfirmationHandler } from '../src/web/reward-confirmation';
import { syntheticAuthorizationEpoch } from './helpers/authorization-epoch';
import { syntheticOAuthClient } from './helpers/oauth';
import { authorizeSyntheticWrite } from './helpers/write-oauth';

const hidden = (html: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing ${name}`);
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
};

test('authenticated reward confirmation requires same-account CSRF POST and never spends on GET', { timeout: 120_000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'habit-mcp-confirmation-')));
  let stopHost = async () => {}, closeAuthorization = async () => {}, closeVault = () => {}, closeQuotes = () => {}, stopServer = async () => {};
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of [() => stopServer(), () => closeAuthorization(), () => closeQuotes(), () => closeVault(), () => stopHost(),
      () => rmSync(directory, { recursive: true, force: true })]) {
      try { await close(); } catch (cause) { errors.push(cause); }
    }
    if (errors.length) throw new AggregateError(errors);
  });
  const host = await startDev({ cwd: resolve('.'), logsDir: directory, args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  stopHost = () => host.stop();
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  const server = createServer((request, response) => dispatch(request, response));
  stopServer = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const publicOrigin = `http://127.0.0.1:${address.port}`, backendUrl = 'https://snapback.synthetic.test';
  const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
  closeVault = () => vault.close();
  const authorization = await createAuthorizationService({ publicOrigin, backendUrl, databasePath: join(directory, 'provider.sqlite'),
    secret: randomBytes(48).toString('hex'), vault, authorizationEpoch: syntheticAuthorizationEpoch(), allowTestLoopback: true,
    identityOptions: { fetch: (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.origin, backendUrl); return fetch(host.url + url.pathname + url.search, request);
    } }, writeConnections: { revoke: async (_grant, commit) => commit() } });
  closeAuthorization = () => authorization.close();
  let now = Date.now();
  const quotes = new RewardQuoteStore({ location: join(directory, 'quotes.sqlite'), key: randomBytes(32), publicOrigin, nowUtcMs: () => now });
  closeQuotes = () => quotes.close();
  const confirmation = createRewardConfirmationHandler({ authorization, quotes, publicOrigin, secret: randomBytes(48).toString('hex') });
  dispatch = toNodeHandler({ fetch: async request => await confirmation.fetch(request) ?? authorization.handler(request) });
  const credentials = [0, 1].map(() => ({ email: `${randomUUID()}@example.test`, password: randomUUID() }));
  const browsers: { cookieHeader(): string }[] = [];
  const identities: Awaited<ReturnType<typeof authorization.authenticate>>[] = [];
  for (const input of credentials) {
    assert.ok((await signup(host.url, input.email, input.password)).ok);
    const provider = syntheticOAuthClient('synthetic reward requester');
    browsers.push(await authorizeSyntheticWrite(authorization.resource, provider, input, 'coins:read rewards:claim offline_access'));
    identities.push(await authorization.authenticate(new Request(authorization.resource,
      { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } })));
  }
  const identity = identities[0], operationId = randomUUID(), rewardId = randomUUID();
  const preview = { reward: { id: rewardId, title: '<script>synthetic reward</script>', costCoins: 4, symbol: 'star.fill',
    accentHex: '#70A7FF', mutationStamp: '01792900000000-00001-synthetic', archivedAt: null }, balance: 10, balanceAfterClaim: 6 };
  const quote = quotes.issue(identity, { operationId, rewardId, timeZone: 'America/Toronto' }, preview);
  const claim = { accountId: identity.accountId, clientId: identity.clientId, operationId };
  const anonymous = await fetch(quote.confirmationUrl, { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  const signIn = new URL(anonymous.headers.get('location')!, publicOrigin);
  assert.equal(signIn.pathname, '/mcp/account/sign-in');
  assert.equal(signIn.searchParams.get('return_to'), new URL(quote.confirmationUrl).pathname + new URL(quote.confirmationUrl).search);
  const signInPage = await fetch(signIn, { redirect: 'manual' });
  assert.equal(signInPage.status, 200, await signInPage.clone().text());
  const foreign = await fetch(quote.confirmationUrl, { headers: { cookie: browsers[1].cookieHeader() } });
  assert.equal(foreign.status, 403); assert.ok(!(await foreign.text()).includes('synthetic reward'));
  const page = await fetch(quote.confirmationUrl, { headers: { cookie: browsers[0].cookieHeader() } });
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.ok(body.includes('4 coins')); assert.ok(body.includes('6 coins')); assert.ok(body.includes(identity.clientId));
  assert.ok(body.includes('&lt;script&gt;')); assert.ok(!body.includes('<script>'));
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.throws(() => quotes.admit(quote.confirmationToken, claim), { code: 'CONFIRMATION_REQUIRED' });
  const csrfCookie = page.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  const cookie = browsers[0].cookieHeader() + '; ' + csrfCookie;
  const post = (changes: Record<string, string> = {}, headers: Record<string, string> = {}) => fetch(publicOrigin + '/mcp/reward-confirmation', {
    method: 'POST', headers: { cookie, origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ token: hidden(body, 'token'), csrf: hidden(body, 'csrf'), decision: 'approve', ...changes }),
  });
  assert.equal((await post({ csrf: 'forged' })).status, 403);
  assert.equal((await post({}, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post({}, { cookie: browsers[1].cookieHeader() + '; ' + csrfCookie })).status, 403);
  const swapped = quotes.issue(identity, { operationId: randomUUID(), rewardId, timeZone: 'America/Toronto' }, preview);
  assert.equal((await post({ token: swapped.confirmationToken })).status, 403);
  assert.equal((await post({}, { 'content-type': 'application/json' })).status, 403);
  const duplicate = await fetch(publicOrigin + '/mcp/reward-confirmation', { method: 'POST',
    headers: { cookie, origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['token', quote.confirmationToken], ['token', quote.confirmationToken]]) });
  assert.equal(duplicate.status, 400);
  assert.equal((await fetch(quote.confirmationUrl, { method: 'DELETE' })).status, 405);
  const cancelled = await post({ decision: 'deny' });
  assert.equal(cancelled.status, 200); assert.ok((await cancelled.text()).includes('Approval cancelled'));
  assert.throws(() => quotes.admit(quote.confirmationToken, claim), { code: 'CONFIRMATION_REQUIRED' });
  const approved = await post(); assert.equal(approved.status, 200, await approved.clone().text());
  assert.ok((await approved.text()).includes('Reward approved'));
  assert.equal(quotes.admit(quote.confirmationToken, claim).reward.costCoins, 4);
  const repeatedPost = await post(); assert.equal(repeatedPost.status, 200);
  assert.ok((await repeatedPost.text()).includes('Reward approved'));
  const again = await fetch(quote.confirmationUrl, { headers: { cookie: browsers[0].cookieHeader() } });
  assert.ok((await again.text()).includes('Reward approved'));
  const poor = quotes.issue(identity, { operationId: randomUUID(), rewardId, timeZone: 'America/Toronto' },
    { ...preview, balance: -2, balanceAfterClaim: null });
  const poorPage = await fetch(poor.confirmationUrl, { headers: { cookie: browsers[0].cookieHeader() } });
  const poorBody = await poorPage.text();
  assert.ok(poorBody.includes('Insufficient coins')); assert.ok(!poorBody.includes('value="approve"'));
  now = quote.expiresAtUtc;
  const expired = await fetch(quote.confirmationUrl, { headers: { cookie: browsers[0].cookieHeader() } });
  assert.equal(expired.status, 410); assert.ok((await expired.text()).includes('Quote expired'));
});
