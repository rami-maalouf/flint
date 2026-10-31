import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { logout, signup, type Session } from 'snapback4/auth';
import { createClient, type Client } from 'snapback4/client';
import { deploy, startServe, type ServeHost } from 'snapback4/proof';
import { api } from '../../../snapback/generated/api.ts';
import type { AuthContext } from '../src/auth/context';
import { createIdentityBridge, createWriteIdentityBridge, IdentityError, type IdentityConfig } from '../src/auth/identity';

test('only trusted canonical HTTPS configuration selects the backend', () => {
  for (const backendUrl of ['http://example.test', 'http://127.0.0.1:45000', 'https://u:p@example.test',
    'https://example.test/path', 'https://example.test/?x', 'https://example.test/#x',
    ' https://example.test', 'https://example.test/../', 'https://example.test\\@evil.test']) {
    assert.throws(() => createIdentityBridge({ backendUrl }), { code: 'INVALID_CONFIG' });
  }
  for (const backendUrl of ['http://localhost:45000', 'http://127.0.0.2:45000', 'http://127.0.0.1']) {
    assert.throws(() => createIdentityBridge({ backendUrl, allowTestLoopback: true }), { code: 'INVALID_CONFIG' });
  }
  for (const timeoutMs of [0, -1, NaN, 1.5, 60_001]) {
    assert.throws(() => createIdentityBridge({ backendUrl: 'https://example.test', timeoutMs }), { code: 'INVALID_CONFIG' });
  }
});

test('fresh write authentication verifies full upstream scope and the existing browser account without upgrading reads', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-write-identity-'));
  const deployed = await deploy(join(directory, 'backend'), resolve('snapback/schema.q'), { logsDir: directory });
  assert.equal(deployed.code, 0);
  const host = await startServe(join(directory, 'backend'), { logsDir: directory });
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await host.stop(); await rm(directory, { recursive: true, force: true }); });
  const credentials = [0, 1].map(() => ({ email: `${randomUUID()}@example.test`, password: randomUUID() }));
  for (const input of credentials) assert.ok((await signup(host.url, input.email, input.password)).ok);
  const config = { backendUrl: host.url, allowTestLoopback: true };
  const observed = await createIdentityBridge(config).login(credentials[0]);
  const expected = { accountId: observed.accountId, principal: observed.principal, backendUrl: observed.backendUrl };
  const traffic: string[] = [];
  const writes = createWriteIdentityBridge({ ...config, fetch: async (input, init) => {
    traffic.push(new URL(String(input)).pathname); return fetch(input, init);
  } });
  const full = await writes.login(credentials[0], expected);
  assert.equal(full.session.scope, 'full');
  assert.equal(full.accountId, observed.accountId);
  assert.notEqual(full.session.token, observed.session.token);
  assert.ok(Object.isFrozen(full) && Object.isFrozen(full.session));
  assert.ok(traffic.includes('/probe') && traffic.includes('/q/profile'));
  assert.ok(traffic.every(path => !path.startsWith('/m/')));
  const client = createClient({ url: host.url, token: full.session.token }); clients.push(client);
  assert.equal((await client.mutate(api.saveProfile, { name: 'synthetic consented writer' })).state, 'sent');
  const read = createClient({ url: host.url, token: observed.session.token, readOnly: true }); clients.push(read);
  assert.equal((await read.mutate(api.saveProfile, { name: 'forbidden' })).state, 'failed');
  await assert.rejects(writes.login(credentials[1], expected), { code: 'IDENTITY_INVALID' });
  assert.ok(traffic.includes('/auth/logout'));
  traffic.length = 0;
  await assert.rejects(writes.login(credentials[0], { ...expected, backendUrl: 'https://wrong.test' }), { code: 'IDENTITY_INVALID' });
  assert.equal(traffic.length, 0);
  const forged = createWriteIdentityBridge({ ...config, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/login') return Response.json({ ok: true, session: { ...observed.session, scope: 'full' } });
    return fetch(input, init);
  } });
  await assert.rejects(forged.login(credentials[0], expected), { code: 'IDENTITY_INVALID' });
  assert.ok(!('denied' in await read.query(api.profile, {})));
});

test('real Snapback login binds empty and initialized accounts to independent read credentials', { timeout: 90_000 }, async t => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  const directory = await mkdtemp(join(tmpdir(), 'habit-mcp-identity-'));
  const clients: Client[] = [];
  let host: ServeHost | undefined;
  t.after(async () => {
    try { await Promise.all(clients.map(client => client.close())); await host?.stop(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const deployment = join(directory, 'backend');
  assert.equal((await deploy(deployment, resolve('snapback/schema.q'), { logsDir: directory })).code, 0);
  host = await startServe(deployment, { logsDir: directory });
  const backendUrl = host.url;
  const credentials = [0, 1].map(() => ({ email: `${randomUUID()}@example.test`, password: randomUUID() }));
  const accounts: Session[] = [];
  for (const input of credentials) {
    const result = await signup(backendUrl, input.email, input.password);
    assert.ok(result.ok); accounts.push(result.session);
  }
  const connect = (token: string, readOnly = true) => {
    const client = createClient({ url: backendUrl, token, readOnly }); clients.push(client); return client;
  };
  const initialized = connect(accounts[1].token, false);
  assert.equal((await initialized.mutate(api.saveProfile, { name: credentials[0].email })).state, 'sent');
  const traffic: { path: string; scope?: string; redirect?: RequestRedirect }[] = [];
  const observe: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    traffic.push({ path, redirect: init?.redirect,
      ...(path === '/auth/login' ? { scope: JSON.parse(String(init?.body)).scope } : {}) });
    return fetch(input, init);
  };
  const config: IdentityConfig = { backendUrl: backendUrl + '/', allowTestLoopback: true, fetch: observe };
  const bridge = createIdentityBridge(config);
  const empty = await bridge.login(credentials[0]);
  const populated = await bridge.login(credentials[1]);

  await t.test('healthy absence is complete authenticated evidence and performs no bootstrap mutation', async () => {
    const profile = await connect(empty.session.token).query(api.profile, {});
    assert.ok(!('denied' in profile)); assert.equal(profile.complete, true); assert.equal(profile.data, null);
    assert.equal(empty.principal, accounts[0].principal);
    assert.equal(empty.backendUrl, backendUrl);
    assert.equal(empty.session.scope, 'read');
    assert.deepEqual(Object.keys(empty).sort(), ['accountId', 'backendUrl', 'principal', 'session']);
    assert.ok(Object.keys(empty.session).every(key => ['expiresAt', 'kind', 'principal', 'scope', 'token', 'capExpiresAt'].includes(key)));
    assert.ok(traffic.some(request => request.path === '/probe'));
    assert.ok(traffic.some(request => request.path === '/q/profile'));
    assert.ok(traffic.filter(request => request.path === '/auth/login').every(request => request.scope === 'read'));
    assert.ok(traffic.every(request => request.redirect === 'error' && !request.path.startsWith('/m/') && !request.path.includes('refresh')));
  });

  await t.test('account ids use immutable principal and canonical backend, with distinct account switching', async () => {
    const again = await bridge.login(credentials[0]);
    const cased = await bridge.login({ ...credentials[0], email: credentials[0].email.toUpperCase() });
    const canonical = await createIdentityBridge({ ...config, backendUrl }).login(credentials[0]);
    assert.equal(again.accountId, empty.accountId); assert.equal(cased.accountId, empty.accountId);
    assert.equal(canonical.accountId, empty.accountId);
    assert.equal(cased.principal, empty.principal);
    assert.match(empty.accountId, /^[a-f0-9]{64}$/);
    assert.notEqual(empty.accountId, populated.accountId);
    assert.notEqual(empty.principal, populated.principal);
    assert.equal(new Set([empty.session.token, populated.session.token, again.session.token, cased.session.token]).size, 4);
    await logout(backendUrl, again.session.token);
    const revoked = await connect(again.session.token).query(api.profile, {});
    assert.ok('denied' in revoked);
    assert.equal(revoked.denied.code, 'E_AUTH');
    assert.ok(!('denied' in await connect(empty.session.token).query(api.profile, {})));
    const profile = await connect(populated.session.token).query(api.profile, {});
    assert.ok(!('denied' in profile)); assert.equal(profile.data?.owner, populated.principal);
    assert.ok(Object.isFrozen(empty) && Object.isFrozen(empty.session));
  });

  await t.test('read bearers refuse mutations locally and on the server without the read-only option', async () => {
    for (const readOnly of [true, false]) {
      const result = await connect(populated.session.token, readOnly).mutate(api.saveProfile, { name: 'forbidden' });
      assert.equal(result.state, 'failed');
      if (result.state === 'failed') assert.equal(result.why.code, 'E_READ_ONLY');
    }
    const profile = await initialized.query(api.profile, {});
    assert.ok(!('denied' in profile)); assert.equal(profile.data?.name, credentials[0].email);
  });

  await t.test('the common context carries admitted identity and an active-grant barrier', async () => {
    let active = true;
    const context: AuthContext = { ...empty, clientId: 'client', grantId: 'grant', scopes: ['habits:read'],
      assertActive: async () => { if (!active) throw new Error('revoked'); } };
    await context.assertActive(); active = false;
    await assert.rejects(context.assertActive(), /revoked/);
  });

  await t.test('wrong passwords and caller identity fields fail safely', async () => {
    await assert.rejects(bridge.login({ ...credentials[0], password: 'wrong-password' }), { code: 'INVALID_CREDENTIALS' });
    for (const extra of [{ owner: populated.principal }, { backendUrl: 'https://evil.test' },
      { principal: populated.principal }, { session: populated.session }, { accountId: populated.accountId }]) {
      await assert.rejects(bridge.login({ ...credentials[0], ...extra }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(bridge.login({ email: '', password: '' }), { code: 'INVALID_INPUT' });
  });

  // isolate fault batches from production's auth admission rate limit, without disabling server checks.
  const restart = async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await host!.stop();
    host = await startServe(deployment, { logsDir: directory, args: ['--port', new URL(backendUrl).port] });
    assert.equal(host.url, backendUrl);
  };
  await restart();
  assert.equal((await bridge.login(credentials[0])).accountId, empty.accountId);
  const injected = (transform: (path: string, response: Response) => Promise<Response>) => createIdentityBridge({
    ...config, fetch: async (input, init) => transform(new URL(String(input)).pathname, await fetch(input, init)),
  });
  const replaceSession = (changes: Record<string, unknown>) => injected(async (path, response) => {
    if (path !== '/auth/login') return response;
    const body = await response.json();
    return Response.json({ ...body, session: { ...body.session, ...changes } }, { headers: response.headers });
  });
  await t.test('an empty profile cannot bind a login principal that differs from the authenticated viewer', async () => {
    let verifiedProbe = false, verifiedEmptyProfile = false;
    const mismatch = injected(async (path, response) => {
      if (path === '/auth/login') {
        const body = await response.json();
        return Response.json({ ...body, session: { ...body.session, principal: accounts[1].principal } }, { headers: response.headers });
      }
      if (path === '/probe') {
        const probe = await response.clone().json();
        assert.equal(probe.scope, 'read');
        assert.equal(probe.viewer, accounts[0].principal);
        verifiedProbe = true;
      }
      if (path === '/q/profile') {
        const profile = await response.clone().json();
        assert.equal(profile.complete, true);
        assert.equal(profile.data, null);
        verifiedEmptyProfile = true;
      }
      return response;
    });
    await assert.rejects(mismatch.login(credentials[0]), { code: 'IDENTITY_INVALID' });
    assert.ok(verifiedProbe && verifiedEmptyProfile);
  });
  await t.test('invalid scope, expired and malformed sessions cannot establish identity', async () => {
    let count = 0;
    for (const changes of [{ scope: undefined }, { scope: 'full' }, { kind: 'guest' }, { expiresAt: 1 },
      { capExpiresAt: 1 }, { principal: '' }, { token: '' }, { token: 'unsafe\ntoken' }]) {
      if (count++ === 4) await restart();
      await assert.rejects(replaceSession(changes).login(credentials[0]), { code: 'IDENTITY_INVALID' });
    }
  });
  await t.test('an invalid read bearer is not accepted for an empty account', async () => {
    await assert.rejects(replaceSession({ token: 'ro.invalid-bearer' }).login(credentials[0]), { code: 'IDENTITY_INVALID' });
    await assert.rejects(replaceSession({ token: accounts[0].token }).login(credentials[0]), { code: 'IDENTITY_INVALID' });
  });
  await t.test('a non-null profile must match the login principal', async () => {
    await assert.rejects(replaceSession({ principal: accounts[0].principal }).login(credentials[1]), { code: 'IDENTITY_INVALID' });
  });
  await t.test('incomplete reads are distinct from malformed or denied verification', async () => {
    await restart();
    for (const [changes, code] of [
      [{ complete: false }, 'VERIFICATION_INCOMPLETE'], [{ data: {} }, 'IDENTITY_INVALID'],
      [{ data: [] }, 'IDENTITY_INVALID'], [{ complete: undefined }, 'IDENTITY_INVALID'],
      [{ denied: { code: 'E_AUTH', family: 'auth', message: 'private SQL token' } }, 'IDENTITY_INVALID'],
    ] as const) {
      const bridge = injected(async (path, response) => {
        if (path !== '/q/profile') return response;
        return Response.json({ ...await response.json(), ...changes }, { headers: response.headers });
      });
      await assert.rejects(bridge.login(credentials[0]), { code });
    }
    const malformed = injected(async (path, response) => {
      if (path !== '/q/profile') return response;
      await response.body?.cancel(); return new Response('private SQL token');
    });
    await assert.rejects(malformed.login(credentials[0]), { code: 'IDENTITY_INVALID' });
  });
  await t.test('transport failures and timeouts expose only bounded safe errors without logs', async () => {
    await restart();
    const logs: unknown[][] = [];
    const previous = { error: console.error, warn: console.warn, log: console.log };
    console.error = console.warn = console.log = (...values: unknown[]) => { logs.push(values); };
    try {
      for (const path of ['/auth/login', '/probe', '/q/profile']) {
        const unavailable = createIdentityBridge({ ...config, fetch: async (input, init) => {
          if (new URL(String(input)).pathname === path) throw new Error(`SQL ${credentials[0].password} ${empty.session.token}`);
          return fetch(input, init);
        } });
        await assert.rejects(unavailable.login(credentials[0]), error => {
          assert.ok(error instanceof IdentityError); assert.equal(error.code, 'BACKEND_UNAVAILABLE');
          assert.equal(error.cause, undefined);
          assert.ok(!String(error.stack).includes(empty.session.token));
          assert.ok(!JSON.stringify(error).includes(credentials[0].password)); return true;
        });
      }
      for (const path of ['/auth/login', '/q/profile']) {
        const stalled = createIdentityBridge({ ...config, timeoutMs: 2000, fetch: async (input, init) => {
          if (new URL(String(input)).pathname !== path) return fetch(input, init);
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('secret timeout payload')), { once: true });
          });
        } });
        const started = performance.now();
        await assert.rejects(stalled.login(credentials[0]), { code: 'BACKEND_UNAVAILABLE' });
        assert.ok(performance.now() - started < 4000);
      }
      assert.deepEqual(logs, []);
    } finally { Object.assign(console, previous); }
  });
  await t.test('the same immutable principal at a different backend authority has a separate account binding', async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await host!.stop();
    host = await startServe(deployment, { logsDir: directory, args: ['--port', '0'] });
    assert.notEqual(host.url, backendUrl);
    const otherBackend = await createIdentityBridge({ backendUrl: host.url, allowTestLoopback: true }).login(credentials[0]);
    assert.equal(otherBackend.principal, empty.principal);
    assert.notEqual(otherBackend.accountId, empty.accountId);
    assert.equal(otherBackend.backendUrl, host.url);
  });
});
