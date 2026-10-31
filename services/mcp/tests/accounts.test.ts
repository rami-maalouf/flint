import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test, type TestContext } from 'node:test';
import { login, signup, type Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe, type ServeHost } from 'snapback4/proof';

import { api } from '../../../snapback/generated/api.ts';
import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { AccountActors, AccountError, type AccountOptions } from '../src/accounts/actor';
import { accountDirectory } from '../src/accounts/replica';
import type { AuthContext } from '../src/auth/context';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../src/core';
import type { WireSyncRecord } from '../../../src/core/sync/transport';

const scratch = mkdtempSync(join(tmpdir(), 'habit-mcp-accounts-server-'));
let host: ServeHost;
type SyntheticAccount = { ctx: AuthContext; context: (session?: Session) => AuthContext;
  full: Session; read: Session; boardId: string };
const accountFixtures = new Map<string, Promise<SyntheticAccount>>();
before(async () => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  assert.equal((await deploy(join(scratch, 'backend'), resolve('snapback/schema.q'), { logsDir: join(scratch, 'logs') })).code, 0);
  host = await startServe(join(scratch, 'backend'), { logsDir: join(scratch, 'logs') });
});
after(async () => { await host?.stop(); rmSync(scratch, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic test gate deadline exceeded')), 5000);
    release = () => { clearTimeout(timer); resolve(); };
  });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'habit-mcp-actors-'));
  const managers: AccountActors[] = [];
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const actors = (options: Partial<AccountOptions> = {}) => {
    const manager = new AccountActors({ root, backendUrl: host.url, minFreeBytes: 1024 * 1024, ...options });
    managers.push(manager); return manager;
  };
  const createAccount = async (title: string, seedCheck: boolean): Promise<SyntheticAccount> => {
    const email = `${randomUUID()}@example.test`, password = randomUUID();
    const full = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(full.ok);
    const client = createClient({ url: host.url, token: full.session.token });
    const db = new NodeSqlDatabase();
    const ports = createCorePorts('UTC', Date.UTC(2026, 9, 30, 12));
    let boardId: string;
    try {
      assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
      const board = await createBoard({ db, ...ports }, { commandId: randomUUID() as CommandId,
        title, symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
        tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
        kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
      assert.ok(board.ok);
      boardId = board.value.boardId;
      if (seedCheck) assert.ok((await createCheckIn({ db, ...ports }, { commandId: randomUUID() as CommandId,
        boardId: board.value.boardId, source: 'app' })).ok);
      await db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1 WHERE id = 1');
      const transport = createSnapbackTransport({ connection: async () => ({ client, session: full.session, isCurrent: () => true }),
        bind: async () => undefined, hash: async text => Buffer.from(await ports.hashing.sha256(new TextEncoder().encode(text))).toString('hex') });
      const synced = await runSync({ db, ...ports, transport, random: () => 0.5 });
      assert.ok(synced.ok); assert.equal(synced.value.status, 'up_to_date');
      if (seedCheck) {
        const id = randomUUID(), stamp = '01793000000000-00001-legacy';
        const record = { schemaVersion: 1, entityType: 'check_in', entityId: id, mutationStamp: stamp, deleted: false,
          fields: { id, board_id: boardId, logical_date: '2026-10-30', occurred_at_utc: null, time_zone_id: null,
            offset_minutes: null, amount: null, note: 'synthetic legacy', source: 'app', idempotency_key: id,
            created_at: Date.UTC(2026, 9, 30), updated_at: Date.UTC(2026, 9, 30), deleted_at: null } };
        const payload = JSON.stringify(record);
        const sent = await client.mutate(api.uploadRecord, { entityType: 'check_in', entityId: id,
          schemaVersion: 1, mutationStamp: stamp, deleted: false,
          payload, digest: createHash('sha256').update(payload).digest('hex'), body: null });
        assert.equal(sent.state, 'sent');
      }
    } finally { await client.close(); await db.closeAsync(); }
    const read = await login(host.url, email, password, { scope: 'read', timeoutMs: 2000 }); assert.ok(read.ok);
    const accountId = randomUUID();
    const context = (session: Session = read.session): AuthContext => ({ accountId, clientId: randomUUID(), grantId: randomUUID(),
      principal: session.principal, scopes: ['habits:read'], backendUrl: host.url, session, assertActive: async () => undefined });
    return { ctx: context(), context, full: full.session, read: read.session, boardId };
  };
  const uses = new Map<string, number>();
  const account = (title = 'synthetic habit', seedCheck = false) => {
    const family = JSON.stringify([title, seedCheck]), index = uses.get(family) ?? 0;
    uses.set(family, index + 1);
    const key = JSON.stringify([family, index]);
    let seeded = accountFixtures.get(key);
    if (!seeded) { seeded = createAccount(title, seedCheck); accountFixtures.set(key, seeded); }
    return seeded;
  };
  return { root, actors, account };
}

const titles = async ({ db }: { db: NodeSqlDatabase | import('../../../src/core/persistence/database').SqlDatabase }) =>
  (await db.getAllAsync<{ title: string }>('SELECT title FROM boards ORDER BY title')).map(row => row.title);

test('two accounts and two clients isolate product rows while simultaneous opens share one durable device', async t => {
  const h = await fixture(t), a = await h.account('synthetic alpha'), b = await h.account('synthetic beta');
  const actor = h.actors();
  const results = await Promise.all([
    actor.withAccount(a.ctx, {}, titles), actor.withAccount(a.context(), {}, titles), actor.withAccount(b.ctx, {}, titles),
  ]);
  assert.deepEqual(results.map(result => result.data), [['synthetic alpha'], ['synthetic alpha'], ['synthetic beta']]);
  assert.equal(readdirSync(h.root).length, 2);
  const device = async (ctx: AuthContext) => actor.withAccount(ctx, {}, async ({ db }) =>
    (await db.getFirstAsync<{ device_id: string }>('SELECT device_id FROM app_settings'))!.device_id);
  assert.equal((await device(a.ctx)).data, (await device(a.context())).data);
  assert.notEqual((await device(a.ctx)).data, (await device(b.ctx)).data);
  assert.ok(results.every(result => result.meta.syncStatus === 'up_to_date' && !result.meta.usedCached));
});

test('the first read uses the exact read session and emits no backend mutations, retaining reconciliation facts', async t => {
  const h = await fixture(t), a = await h.account('synthetic daily', true);
  const requests: { path: string; method: string; authorization: string | null }[] = [];
  const actor = h.actors({ fetch: async (input, init) => {
    const request = new Request(input, init);
    requests.push({ path: new URL(request.url).pathname, method: request.method, authorization: request.headers.get('authorization') });
    return fetch(request);
  } });
  const result = await actor.withAccount(a.ctx, {}, async runtime => ({
    titles: await titles(runtime), recovery: runtime.recovery,
    device: await runtime.db.getFirstAsync('SELECT device_id, hlc_wall_time, hlc_counter FROM app_settings'),
  }));
  assert.deepEqual(result.data.titles, ['synthetic daily']);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.authorization === `Bearer ${a.read.token}`));
  assert.ok(requests.every(request => request.method === 'GET' || request.path.startsWith('/q/')));
  assert.ok(result.meta.pendingLocalDeliveries > 0, 'legacy evidence must remain queued without a provider mutation');
  assert.equal(result.data.recovery.writeFenced, true);
  assert.equal(result.data.recovery.recoveryReason, 'read_only_reconstruction');
  assert.equal(result.meta.lastCompletedPullAtUtc === null, false);
  assert.ok(result.meta.backendRevision);
  await actor.close();
  const restarted = h.actors();
  const again = await restarted.withAccount(a.ctx, {}, async runtime => ({
    titles: await titles(runtime), device: await runtime.db.getFirstAsync('SELECT device_id, hlc_wall_time, hlc_counter FROM app_settings'),
  }));
  assert.deepEqual(again.data.device, result.data.device);
  const client = createClient({ url: host.url, token: a.read.token });
  try {
    const profile = await client.query(api.profile, {}); assert.ok('data' in profile);
    // the read-only SDK and server independently refuse a write.
    assert.equal((await client.mutate(api.ensureAccount, {})).state, 'failed');
  } finally { await client.close(); }
});

test('one account serializes pulls and reads while other accounts proceed and request zones stay immutable', async t => {
  const h = await fixture(t), a = await h.account(), b = await h.account();
  const actor = h.actors(), entered = gate(), held = gate(), events: string[] = [];
  const first = actor.withAccount(a.ctx, { timeZone: 'America/Toronto' }, async runtime => {
    events.push('first'); entered.release(); await held.promise;
    assert.equal(runtime.clock.timeZoneId(), 'America/Toronto');
    assert.ok(Object.isFrozen(runtime.clock) && Object.isFrozen(runtime.hashing));
    return runtime.clock.nowUtcMs();
  });
  await entered.promise;
  const second = actor.withAccount(a.context(), { timeZone: 'Asia/Tokyo' }, async runtime => {
    events.push('second'); assert.equal(runtime.clock.timeZoneId(), 'Asia/Tokyo');
    return runtime.clock.nowUtcMs();
  });
  await actor.withAccount(b.ctx, {}, titles);
  assert.deepEqual(events, ['first']);
  held.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'second']);
  assert.ok(results[1].data >= results[0].data);
});

test('failed initial pull is never an empty healthy cache; a queued retry bootstraps normally', async t => {
  const h = await fixture(t), a = await h.account();
  let offline = true;
  const actor = h.actors({ requestTimeoutMs: 1200, pullTimeoutMs: 120, fetch: async (input, init) => {
    if (offline) throw new TypeError('synthetic network failure');
    return fetch(input, init);
  } });
  await assert.rejects(actor.withAccount(a.ctx, { freshness: 'allow_cached' }, titles), AccountError);
  offline = false;
  assert.deepEqual((await actor.withAccount(a.ctx, {}, titles)).data, ['synthetic habit']);
});

test('required sync fails offline while explicit cached reads retain prior successful bootstrap metadata across restart', async t => {
  const h = await fixture(t), a = await h.account();
  const first = h.actors();
  const healthy = await first.withAccount(a.ctx, {}, titles);
  await first.close();
  const offline = h.actors({ requestTimeoutMs: 1200, pullTimeoutMs: 100, fetch: async () => { throw new TypeError('synthetic offline'); } });
  await assert.rejects(offline.withAccount(a.ctx, {}, titles), AccountError);
  const cached = await offline.withAccount(a.context(), { freshness: 'allow_cached' }, titles);
  assert.deepEqual(cached.data, healthy.data);
  assert.equal(cached.meta.usedCached, true);
  assert.notEqual(cached.meta.syncStatus, 'up_to_date');
  assert.equal(cached.meta.lastCompletedPullAtUtc, healthy.meta.lastCompletedPullAtUtc);
  assert.equal(cached.meta.backendRevision, healthy.meta.backendRevision);
});

test('MCP revocation denies admission and a result after protected work; no alternate grant is used', async t => {
  const h = await fixture(t), a = await h.account();
  let active = false, calls = 0;
  const actor = h.actors({ fetch: async (input, init) => { calls++; return fetch(input, init); } });
  const ctx = { ...a.ctx, assertActive: async () => { if (!active) throw new AccountError('FORBIDDEN', 'synthetic revoked', false); } };
  await assert.rejects(actor.withAccount(ctx, {}, titles), { code: 'FORBIDDEN' });
  assert.equal(calls, 0);
  active = true;
  await assert.rejects(actor.withAccount(ctx, {}, async runtime => { await titles(runtime); active = false; return 'withheld'; }), { code: 'FORBIDDEN' });
  await actor.withAccount(a.context(a.full), {}, titles);
  await assert.rejects(actor.withAccount(ctx, { freshness: 'allow_cached' }, titles), { code: 'FORBIDDEN' });
});

test('fixed backend, session principal and durable account binding refuse identity swaps', async t => {
  const h = await fixture(t), a = await h.account(), b = await h.account();
  const actor = h.actors();
  await actor.withAccount(a.ctx, {}, titles);
  await assert.rejects(actor.withAccount({ ...a.ctx, backendUrl: 'http://127.0.0.1:1' }, {}, titles), { code: 'FORBIDDEN' });
  await assert.rejects(actor.withAccount({ ...a.ctx, principal: b.ctx.principal }, {}, titles), { code: 'FORBIDDEN' });
  await assert.rejects(actor.withAccount({ ...b.ctx, accountId: a.ctx.accountId }, {}, titles));
  await actor.close();
  await assert.rejects(h.actors().withAccount({ ...b.ctx, accountId: a.ctx.accountId }, {}, titles));
});

test('idle and capacity eviction close handles without deleting identity, HLC, outbox or cache files', async t => {
  const h = await fixture(t), a = await h.account('synthetic alpha', true), b = await h.account('synthetic beta');
  const actor = h.actors({ maxOpenReplicas: 1, idleMs: 10 });
  const snapshot = async (ctx: AuthContext) => actor.withAccount(ctx, {}, async ({ db }) => ({
    settings: await db.getFirstAsync('SELECT device_id, hlc_wall_time, hlc_counter FROM app_settings'),
    outbox: await db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
  }));
  const original = await snapshot(a.ctx);
  await actor.withAccount(b.ctx, {}, titles);
  assert.equal(readdirSync(h.root).length, 2);
  assert.deepEqual((await snapshot(a.context())).data, original.data);
  await new Promise(resolve => setTimeout(resolve, 15));
  await actor.evictIdle();
  assert.deepEqual((await snapshot(a.context())).data, original.data);
});

test('read runtime denies mutations, expires escaped capabilities and cannot disable SQLite query-only', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors();
  let escaped: import('../../../src/core/persistence/database').SqlDatabase | undefined;
  await actor.withAccount(a.ctx, {}, async ({ db }) => {
    escaped = db;
    await assert.rejects(db.runAsync('DELETE FROM boards'), { code: 'FORBIDDEN' });
    assert.throws(() => db.getAllAsync('DELETE FROM boards RETURNING id'), { code: 'FORBIDDEN' });
    assert.throws(() => db.getAllAsync('PRAGMA query_only = OFF'), { code: 'FORBIDDEN' });
    await assert.rejects(db.execAsync('PRAGMA query_only = OFF'), { code: 'FORBIDDEN' });
    await assert.rejects(db.closeAsync(), { code: 'FORBIDDEN' });
    return titles({ db });
  });
  assert.throws(() => escaped!.getAllAsync('SELECT * FROM boards'), { code: 'FORBIDDEN' });
  assert.deepEqual((await actor.withAccount(a.ctx, {}, titles)).data, ['synthetic habit']);
});

test('unknown product schema is refused and preserved instead of resetting the replica', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors();
  await actor.withAccount(a.ctx, {}, titles); await actor.close();
  const path = join(accountDirectory(h.root, a.ctx.accountId), 'product.sqlite');
  const future = new DatabaseSync(path); future.exec('PRAGMA user_version = 99'); future.close();
  await assert.rejects(h.actors().withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  const retained = new DatabaseSync(path);
  try {
    assert.equal(retained.prepare('PRAGMA user_version').get()!.user_version, 99);
    assert.equal(retained.prepare('SELECT count(*) AS n FROM boards').get()!.n, 1);
  } finally { retained.close(); }
});

test('an existing write replica requires recovery before bootstrap, local fact processing or a pull', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors(); await actor.withAccount(a.ctx, {}, titles); await actor.close();
  const db = new NodeSqlDatabase(join(accountDirectory(h.root, a.ctx.accountId), 'product.sqlite'));
  try {
    const result = await createCheckIn({ db, ...createCorePorts('UTC') }, { commandId: randomUUID() as CommandId,
      boardId: a.boardId as never, source: 'app' });
    assert.ok(result.ok);
  } finally { await db.closeAsync(); }
  let pulled = false;
  const refused = h.actors({ fetch: async (input, init) => { pulled = true; return fetch(input, init); } });
  await assert.rejects(refused.withAccount(a.ctx, {}, titles), { code: 'OPERATION_PENDING' });
  assert.equal(pulled, false); await refused.close();
  let recoveryCalls = 0;
  const integrated = h.actors({ recover: async ({ assertActive, context }) => {
    assert.equal(context.session.token, a.read.token); await assertActive(); recoveryCalls++;
    // this injected test explicitly stays fenced; it does not pretend to recover or publish a journal.
    return { writeFenced: true, deliveryPaused: true, reconnectRequired: false, recoveryReason: 'synthetic_read_only_review' };
  } });
  const result = await integrated.withAccount(a.ctx, {}, async runtime => runtime.recovery);
  assert.equal(recoveryCalls, 1); assert.equal(result.data.writeFenced, true);
});

test('a separate actor process owns the SQLite lock until SIGKILL; retry keeps the same device', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = await h.account();
  const bundle = resolve(`services/mcp/.artifacts/accounts-child-${process.pid}.mjs`);
  const built = spawnSync('bun', ['build', 'services/mcp/src/accounts/actor.ts', '--target=node', '--packages=external', `--outfile=${bundle}`], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { AccountActors } = await import(process.argv[1]);
    process.once('message', async ({ root, backendUrl, ctx }) => {
      try {
        const actors = new AccountActors({ root, backendUrl, minFreeBytes: 1048576 });
        await actors.withAccount({ ...ctx, assertActive: async () => {} }, {}, async ({ db }) => {
          const row = await db.getFirstAsync('SELECT device_id FROM app_settings');
          process.send({ ready: row.device_id });
          await new Promise(() => {});
        });
      } catch (error) { process.send({ error: String(error) }); process.exit(1); }
    });`, bundle], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(bundle, { force: true }); });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-4000); });
  const message = Promise.race([once(child, 'message'), once(child, 'exit').then(([code, signal]) => {
    throw new Error(`synthetic actor child exited before readiness (${code}, ${signal}): ${stderr}`);
  })]);
  child.send({ root: h.root, backendUrl: host.url, ctx: { ...a.ctx, assertActive: undefined } });
  const [ready] = await message;
  assert.ok(ready.ready, ready.error);
  const parent = h.actors();
  await assert.rejects(parent.withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const reopened = await parent.withAccount(a.context(), {}, async ({ db }) =>
    (await db.getFirstAsync<{ device_id: string }>('SELECT device_id FROM app_settings'))!.device_id);
  assert.equal(reopened.data, ready.ready);
});

test('queue and open-replica budgets reject excess work while accepted reads stay ordered', async t => {
  const h = await fixture(t), a = await h.account(), b = await h.account();
  const actor = h.actors({ maxOpenReplicas: 1, maxQueuedPerAccount: 2 }), entered = gate(), hold = gate();
  const first = actor.withAccount(a.ctx, {}, async () => { entered.release(); await hold.promise; return 1; });
  await entered.promise;
  const second = actor.withAccount(a.context(), {}, async () => 2);
  try {
    await assert.rejects(actor.withAccount(a.context(), {}, async () => 3), { code: 'RATE_LIMITED' });
    await assert.rejects(actor.withAccount(b.ctx, {}, titles), { code: 'RATE_LIMITED' });
  } finally { hold.release(); }
  assert.deepEqual((await Promise.all([first, second])).map(value => value.data), [1, 2]);
});

test('a stalled SDK fetch is aborted at its pull deadline and cached reads explicitly report incomplete', async t => {
  const h = await fixture(t), a = await h.account();
  const initial = h.actors(); await initial.withAccount(a.ctx, {}, titles); await initial.close();
  let aborted = false;
  const actor = h.actors({ requestTimeoutMs: 1500, pullTimeoutMs: 100, fetch: async (_input, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const started = Date.now();
  await assert.rejects(actor.withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  assert.ok(Date.now() - started < 1000); assert.equal(aborted, true);
  const cached = await actor.withAccount(a.ctx, { freshness: 'allow_cached' }, titles);
  assert.equal(cached.meta.usedCached, true); assert.equal(cached.meta.syncStatus, 'incomplete');
});

test('low disk and per-account byte budgets fail without exposing or deleting product records', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors(); await actor.withAccount(a.ctx, {}, titles); await actor.close();
  await assert.rejects(h.actors({ maxAccountBytes: 1 }).withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  await assert.rejects(h.actors({ minFreeBytes: Number.MAX_SAFE_INTEGER }).withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  assert.deepEqual((await h.actors().withAccount(a.ctx, {}, titles)).data, ['synthetic habit']);
});

test('an empty previously healthy product file is refused without assigning a replacement device', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors(); await actor.withAccount(a.ctx, {}, titles); await actor.close();
  const path = join(accountDirectory(h.root, a.ctx.accountId), 'product.sqlite');
  writeFileSync(path, '');
  await assert.rejects(h.actors().withAccount(a.ctx, {}, titles), { code: 'UNAVAILABLE' });
  assert.equal(statSync(path).size, 0);
});

test('actual multi-page pulls stop at the page budget and an ordered retry completes bootstrap', { timeout: 30_000 }, async t => {
  const h = await fixture(t), a = await h.account('synthetic page source');
  const client = createClient({ url: host.url, token: a.full.token });
  try {
    const page = await client.query(api.changes, { after: 0 }); assert.ok('data' in page);
    const original = JSON.parse(page.data!.find(row => row.entityType === 'board')!.payload) as WireSyncRecord;
    const transport = createSnapbackTransport({ connection: async () => ({ client, session: a.full, isCurrent: () => true }),
      bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
    const records = Array.from({ length: 200 }, (_, index) => {
      const id = randomUUID();
      return { ...original, entityId: id, fields: { ...original.fields, id, title: `synthetic page ${index}` } };
    });
    await transport.upload(records);
  } finally { await client.close(); }
  let pageQueries = 0;
  const actor = h.actors({ maxPullPages: 1, fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/q/changes') pageQueries++;
    return fetch(request);
  } });
  await assert.rejects(actor.withAccount(a.ctx, { freshness: 'allow_cached' }, titles), { code: 'UNAVAILABLE' });
  assert.equal(pageQueries, 1);
  const state = new DatabaseSync(join(accountDirectory(h.root, a.ctx.accountId), 'replica.sqlite'));
  try { assert.equal(state.prepare('SELECT healthy_pull_at FROM binding').get()!.healthy_pull_at, null); }
  finally { state.close(); }
  const partial = new DatabaseSync(join(accountDirectory(h.root, a.ctx.accountId), 'product.sqlite'));
  try {
    assert.ok(Number(partial.prepare('SELECT change_token FROM sync_state').get()!.change_token) > 0);
    assert.ok(Number(partial.prepare('SELECT count(*) AS n FROM boards').get()!.n) > 0);
  } finally { partial.close(); }
  let completed: Awaited<ReturnType<typeof actor.withAccount<string[]>>> | undefined;
  // snapback can also cut a query at its byte/word horizon before reaching 200 rows.
  for (let attempt = 0; attempt < 8 && !completed; attempt++) {
    const queriesBefore: number = pageQueries;
    try { completed = await actor.withAccount(a.context(), {}, titles); }
    catch (cause) { assert.equal((cause as AccountError).code, 'UNAVAILABLE'); }
    assert.equal(pageQueries, queriesBefore + 1);
  }
  assert.ok(completed); assert.ok(pageQueries > 1); assert.equal(completed.data.length, 201);
  assert.equal(completed.meta.syncStatus, 'up_to_date'); assert.equal(completed.meta.usedCached, false);
});

test('malformed immutable facts are quarantined by the real core and never reported as a complete clean account', async t => {
  const h = await fixture(t), a = await h.account('synthetic quarantine source');
  const actor = h.actors(); const healthy = await actor.withAccount(a.ctx, {}, titles);
  const client = createClient({ url: host.url, token: a.full.token });
  try {
    const id = randomUUID(), stamp = '01793000000000-00001-malformed';
    const payload = JSON.stringify({ schemaVersion: 2, entityType: 'ledger_entry', entityId: id,
      mutationStamp: stamp, deleted: false, fields: { id, delta: 1 } });
    const sent = await client.mutate(api.uploadRecord, { entityType: 'ledger_entry', entityId: id,
      schemaVersion: 2, mutationStamp: stamp, deleted: false, payload, body: null,
      digest: createHash('sha256').update(payload).digest('hex') });
    assert.equal(sent.state, 'sent');
  } finally { await client.close(); }
  await assert.rejects(actor.withAccount(a.ctx, {}, titles), { code: 'SYNC_ATTENTION' });
  const cached = await actor.withAccount(a.ctx, { freshness: 'allow_cached' }, titles);
  assert.equal(cached.meta.syncStatus, 'sync_attention'); assert.equal(cached.meta.usedCached, true);
  assert.ok(cached.meta.admission.quarantined > 0);
  assert.equal(cached.meta.lastCompletedPullAtUtc, healthy.meta.lastCompletedPullAtUtc);
  await actor.close();
  const noHistory = h.actors({ root: join(h.root, 'synthetic-reconstruction') });
  await assert.rejects(noHistory.withAccount(a.ctx, { freshness: 'allow_cached' }, titles), { code: 'SYNC_ATTENTION' });
});

test('an expired upstream session requires reconnect unless an explicitly requested healthy cache exists', async t => {
  const h = await fixture(t), a = await h.account();
  const actor = h.actors(); const healthy = await actor.withAccount(a.ctx, {}, titles);
  const expired = a.context({ ...a.read, expiresAt: Date.now() - 1 });
  await assert.rejects(actor.withAccount(expired, {}, titles), { code: 'RECONNECT_REQUIRED' });
  const cached = await actor.withAccount(expired, { freshness: 'allow_cached' }, async runtime => runtime.recovery);
  assert.equal(cached.meta.syncStatus, 'reconnect_required'); assert.equal(cached.meta.usedCached, true);
  assert.equal(cached.meta.lastCompletedPullAtUtc, healthy.meta.lastCompletedPullAtUtc);
  assert.equal(cached.data.reconnectRequired, true);
});
