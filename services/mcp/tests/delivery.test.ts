import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test, type TestContext } from 'node:test';
import { login, signup, type Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe, type ServeHost } from 'snapback4/proof';

import { createBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { WireSyncRecord } from '../../../src/core/sync/transport';
import { AccountActors } from '../src/accounts/actor';
import { DeliveryBarrier } from '../src/accounts/delivery';
import { accountDirectory } from '../src/accounts/replica';
import type { OperationPolicy } from '../src/accounts/operations';
import type { AuthContext } from '../src/auth/context';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../src/core';
import { FileRestoreLatch } from '../src/operations/recovery-head';

const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-delivery-'));
let host: ServeHost, full: Session, boardId: string, seeds: WireSyncRecord[];
before(async () => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal((await deploy(join(directory, 'backend'), resolve('snapback/schema.q'), { logsDir: join(directory, 'logs') })).code, 0);
  host = await startServe(join(directory, 'backend'), { logsDir: join(directory, 'logs') });
  const email = `${randomUUID()}@example.test`, password = randomUUID();
  const signed = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(signed.ok); full = signed.session;
  const client = createClient({ url: host.url, token: full.token }), db = new NodeSqlDatabase(), ports = createCorePorts('UTC');
  try {
    assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
    const board = await createBoard({ db, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic delivery', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok); boardId = board.value.boardId;
    await db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const transport = createSnapbackTransport({ connection: async () => ({ client, session: full, isCurrent: () => true }),
      bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
    assert.ok((await runSync({ db, ...ports, transport, random: () => 0.5 })).ok);
    seeds = (await transport.fetchChanges(null)).records;
  } finally { await client.close(); await db.closeAsync(); }
});
after(async () => { await host?.stop(); rmSync(directory, { recursive: true, force: true }); });

async function fixture(t: TestContext, readSession = false) {
  const email = `${randomUUID()}@example.test`, password = randomUUID();
  const signed = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(signed.ok);
  let read = signed.session;
  if (readSession) {
    const narrowed = await login(host.url, email, password, { scope: 'read', timeoutMs: 2000 }); assert.ok(narrowed.ok);
    read = narrowed.session;
  }
  const sessions = { full: signed.session, read };
  const client = createClient({ url: host.url, token: sessions.full.token });
  try {
    const transport = createSnapbackTransport({ connection: async () => ({ client, session: sessions.full, isCurrent: () => true }),
      bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
    await transport.ensureZone(); await transport.upload(seeds);
  } finally { await client.close(); }
  const root = mkdtempSync(join(tmpdir(), 'habit-mcp-delivery-actors-')), local = join(root, 'replicas'), external = join(root, 'external');
  mkdirSync(local, { mode: 0o700 }); mkdirSync(external, { mode: 0o700 });
  const latchOptions = { path: join(external, 'latch'), installationId: randomUUID(),
    restoredDirectories: [local, join(directory, 'backend')] as const };
  FileRestoreLatch.provisionFresh(latchOptions);
  const latch = new FileRestoreLatch(latchOptions), accountId = randomUUID(), clientA = randomUUID(), grantA = randomUUID();
  const clientB = randomUUID(), grantB = randomUUID();
  const grants = new Map<string, { accountId: string; clientId: string; active: boolean; scopes: readonly ('habits:read' | 'checkins:write')[] }>([[grantA, { accountId, clientId: clientA, active: true, scopes: ['habits:read', 'checkins:write'] as const }],
    [grantB, { accountId, clientId: clientB, active: true, scopes: ['habits:read', 'checkins:write'] as const }]]);
  const context = (session: Session = sessions.full, clientId = clientA, grantId = grantA): AuthContext => ({ accountId,
    clientId, grantId, principal: session.principal, scopes: ['habits:read', 'checkins:write'], backendUrl: host.url,
    session, assertActive: async () => { if (!grants.get(grantId)?.active) throw new Error('grant revoked'); } });
  const policy: OperationPolicy = { latch, authorize: async () => undefined,
    normalize: async (_request, frozen) => ({ timeZone: 'UTC', command: { tool: 'create_checkin', input: {
      commandId: frozen.commandId, boardId: boardId as never, logicalDate: '2026-10-30' as never, source: 'app' } } }),
    delivery: { grantStatus: async id => grants.get(id) ?? null } };
  const actors: AccountActors[] = [];
  const make = (overrides: Partial<OperationPolicy> = {}, options: { fetch?: typeof fetch; requestTimeoutMs?: number } = {}) => {
    const actor = new AccountActors({ root: local, backendUrl: host.url, minFreeBytes: 1024 * 1024,
      operationPolicy: { ...policy, ...overrides }, ...options }); actors.push(actor); return actor;
  };
  t.after(async () => { await Promise.all(actors.map(actor => actor.close())); rmSync(root, { recursive: true, force: true }); });
  const request = (ctx: AuthContext, operationId = randomUUID()) => ({ clientId: ctx.clientId, tool: 'create_checkin' as const,
    input: { operationId, habitId: boardId, timeZone: 'UTC' } });
  const path = accountDirectory(local, accountId);
  const queue = () => { const db = new DatabaseSync(join(path, 'product.sqlite'));
    try { return Number(db.prepare('SELECT count(*) AS n FROM mutation_outbox').get()!.n); } finally { db.close(); } };
  const evidence = () => { const db = new DatabaseSync(join(path, 'journal.sqlite'));
    try { return db.prepare('SELECT disposition FROM tuples ORDER BY outbox_id').all().map(row => row.disposition); } finally { db.close(); } };
  const count = () => { const db = new DatabaseSync(join(path, 'product.sqlite'));
    try { return Number(db.prepare('SELECT count(*) AS n FROM check_ins').get()!.n); } finally { db.close(); } };
  return { sessions, context, grants, grantA, grantB, clientA, clientB, policy, make, request, queue, evidence, count, latch, path };
}

test('full operation delivers through its exact grant and retains durable acceptance', { timeout: 20_000 }, async t => {
  const h = await fixture(t, true), actor = h.make(), ctx = h.context(), request = h.request(ctx);
  const result = await actor.runOperation(ctx, request);
  assert.equal(result.data.state, 'backend_acknowledged');
  assert.equal(result.data.delivery, 'acknowledged');
  assert.equal(h.queue(), 0);
  assert.equal(result.meta.pendingLocalDeliveries, 0);
  assert.ok(h.evidence().length > 0 && h.evidence().every(value => value === 'accepted'));
  const readCtx = h.context(h.sessions.read);
  await assert.rejects(actor.runOperation(readCtx, h.request(readCtx)), { code: 'FORBIDDEN' });
  await assert.rejects(actor.runOperation({ ...ctx, scopes: ['habits:read'] }, h.request(ctx)), { code: 'FORBIDDEN' });
  await assert.rejects(actor.resumeDelivery({ ...ctx, scopes: ['habits:read'] }, async () => undefined), { code: 'FORBIDDEN' });
  h.grants.get(h.grantA)!.scopes = ['habits:read'];
  await assert.rejects(actor.runOperation(ctx, h.request(ctx)), { code: 'OPERATION_PENDING' });
});

test('revoked origin pauses the whole mixed queue until explicit same-owner resume', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const actor = h.make({ delivery: undefined });
  await actor.runOperation(a, h.request(a));
  await actor.runOperation(b, h.request(b));
  assert.ok(h.queue() > 0);
  await actor.close();
  const active = h.make();
  await active.revokeDeliveryGrant({ accountId: b.accountId, principal: b.principal, backendUrl: b.backendUrl,
    grantId: h.grantA, clientId: h.clientA }, async () => { h.grants.get(h.grantA)!.active = false; });
  await assert.rejects(active.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  assert.ok(h.queue() > 0);
  const paused = await active.withAccount(b, {}, async runtime => runtime.recovery);
  assert.equal(paused.data.deliveryPaused, true);
  await assert.rejects(active.resumeDelivery(b, async () => { throw new Error('owner declined'); }), /owner declined/);
  assert.ok(h.queue() > 0);
  await active.resumeDelivery(b, async () => undefined);
  assert.equal(h.queue(), 0);
  const ready = await active.withAccount(b, {}, async runtime => runtime.recovery);
  assert.equal(ready.data.deliveryPaused, false);
  const resumed = await active.runOperation(b, h.request(b));
  assert.equal(resumed.data.state, 'backend_acknowledged');
  assert.equal(h.queue(), 0);
});

test('revoking A globally pauses a B-only queue and blocks new B mutations until owner resume', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(b, h.request(b));
  assert.ok(h.queue() > 0);
  await parked.close();
  const actor = h.make();
  await actor.revokeDeliveryGrant(a, async () => { h.grants.get(h.grantA)!.active = false; });
  const before = h.count();
  await assert.rejects(actor.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), before);
  assert.equal((await actor.withAccount(b, {}, async runtime => runtime.recovery)).data.deliveryPaused, true);
  await actor.close();
  const restarted = h.make();
  await assert.rejects(restarted.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  await restarted.resumeDelivery(b, async () => undefined);
  assert.equal(h.queue(), 0);
  const delivered = await restarted.runOperation(b, h.request(b));
  assert.equal(delivered.data.state, 'backend_acknowledged');
  assert.equal(h.queue(), 0);
});

test('missing delivery sidecar cannot erase a retained account-wide revoke pause', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(b, h.request(b));
  await parked.close();
  const actor = h.make();
  await actor.revokeDeliveryGrant(a, async () => { h.grants.get(h.grantA)!.active = false; });
  assert.ok(h.queue() > 0);
  await actor.close();
  rmSync(join(h.path, 'delivery.sqlite'));
  const restarted = h.make();
  const before = h.count();
  await assert.rejects(restarted.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), before);
  assert.ok(h.queue() > 0);
});

test('pre-anchor operation history cannot be adopted as a fresh delivery barrier', async t => {
  const h = await fixture(t), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(b, h.request(b));
  await parked.close();
  const state = new DatabaseSync(join(h.path, 'operations.sqlite'));
  state.exec('DROP TABLE delivery_anchor');
  state.close();
  const actor = h.make();
  await assert.rejects(actor.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  assert.ok(h.queue() > 0);
});

test('an expired queued origin detected by provider status persists the account pause before B admission', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(a, h.request(a));
  await parked.close();
  h.grants.get(h.grantA)!.active = false;
  const actor = h.make();
  const before = h.count();
  await assert.rejects(actor.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), before);
  await actor.close();
  const restarted = h.make();
  await assert.rejects(restarted.runOperation(b, h.request(b)), { code: 'OPERATION_PENDING' });
  await restarted.resumeDelivery(b, async () => undefined);
  assert.equal((await restarted.runOperation(b, h.request(b))).data.state, 'backend_acknowledged');
});

test('owner resume snapshots a bounded queue window and later unattributed rows remain fenced', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(b, h.request(b));
  await parked.close();
  const raw = new DatabaseSync(join(h.path, 'product.sqlite'));
  raw.exec('BEGIN IMMEDIATE');
  const insert = raw.prepare("INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES ('settings', '1', ?, 0)");
  for (let n = 0; n < 1001; n++) insert.run('01793000000000-00001-window');
  raw.exec('COMMIT'); raw.close();
  const product = new NodeSqlDatabase(join(h.path, 'product.sqlite'));
  const barrier = new DeliveryBarrier(h.path, b, h.policy.delivery!);
  try {
    await barrier.revoke(a, product);
    await assert.rejects(barrier.authorizeQueue(b, product), { code: 'OPERATION_PENDING' });
    assert.equal(await barrier.resume(b, product), 1000);
    assert.equal(await barrier.exceedsWindow(product), true);
    assert.equal(await barrier.authorizeQueue(b, product), 1000);
    await assert.rejects(barrier.refreshRevokedOrigins(b, product), { code: 'OPERATION_PENDING' });
    await product.runAsync('DELETE FROM mutation_outbox WHERE id IN (SELECT id FROM mutation_outbox ORDER BY id LIMIT 1000)');
    await assert.rejects(barrier.authorizeQueue(b, product), { code: 'OPERATION_PENDING' });
  } finally { barrier.close(); await product.closeAsync(); }
});

test('delivery window cannot slide to the 1001st ID after an earlier batch clears', async t => {
  const h = await fixture(t), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const parked = h.make({ delivery: undefined });
  await parked.runOperation(b, h.request(b));
  await parked.close();
  const raw = new DatabaseSync(join(h.path, 'product.sqlite'));
  const insert = raw.prepare("INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES ('settings', '1', ?, 0)");
  for (let n = 0; n < 1001; n++) insert.run('01793000000000-00001-window');
  raw.close();
  const product = new NodeSqlDatabase(join(h.path, 'product.sqlite'));
  const barrier = new DeliveryBarrier(h.path, b, h.policy.delivery!);
  try {
    await barrier.resume(b, product);
    const sidecar = new DatabaseSync(join(h.path, 'delivery.sqlite'));
    const later = await product.getAllAsync<{ id: number }>('SELECT id FROM mutation_outbox ORDER BY id LIMIT -1 OFFSET 1000');
    for (const row of later) sidecar.prepare('INSERT INTO owner_resumes VALUES (?, ?)').run(row.id, b.grantId);
    sidecar.close();
    const frozen = await barrier.authorizeQueue(b, product);
    await product.runAsync('DELETE FROM mutation_outbox WHERE id IN (SELECT id FROM mutation_outbox ORDER BY id LIMIT 200)');
    await assert.rejects(barrier.authorizeQueue(b, product, frozen), { code: 'OPERATION_PENDING' });
  } finally { barrier.close(); await product.closeAsync(); }
});

test('timed out revoke waiting for the lane never commits later', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  const actor = h.make({}, { requestTimeoutMs: 500 });
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const running = actor.withAccount(b, {}, async () => { entered(); await hold; }).catch(error => error);
  await inside;
  let commits = 0;
  const cutoff = actor.revokeDeliveryGrant(a, async () => { commits++; });
  await assert.rejects(cutoff, { code: 'UNAVAILABLE' });
  release();
  await running;
  await actor.close();
  assert.equal(commits, 0);
});

test('a durably admitted cutoff completes its provider callback past the queue deadline', async t => {
  const h = await fixture(t), a = h.context();
  const actor = h.make({}, { requestTimeoutMs: 300 });
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const cutoff = actor.revokeDeliveryGrant(a, async () => { entered(); await hold; completed = true; });
  await inside;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(completed, false);
  release();
  await cutoff;
  assert.equal(completed, true);
});

test('provider cutoff waits for account commit and repeated inactive revoke needs no live context', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const actor = h.make({ normalize: async (request, frozen) => {
    enter(); await held; return h.policy.normalize(request, frozen);
  } });
  const running = actor.runOperation(a, h.request(a));
  await entered;
  let commits = 0;
  const binding = { accountId: a.accountId, principal: a.principal, backendUrl: a.backendUrl,
    grantId: a.grantId, clientId: a.clientId };
  const cutoff = actor.revokeDeliveryGrant(binding, async () => {
    commits++; assert.equal(h.count(), 1); h.grants.get(h.grantA)!.active = false;
  });
  release();
  await running; await cutoff;
  assert.equal(commits, 1);
  await actor.revokeDeliveryGrant(binding, async () => { commits++; });
  assert.equal(commits, 2);
  const other = await actor.runOperation(b, h.request(b));
  assert.equal(other.data.state, 'backend_acknowledged');
});

test('revoke before core commit rolls back and leaves prepared intent for its original grant', async t => {
  const h = await fixture(t), ctx = h.context();
  let checks = 0;
  const actor = h.make({ authorize: async admission => {
    if (admission.action === 'execute' && ++checks === 4) h.grants.get(h.grantA)!.active = false;
  } });
  await assert.rejects(actor.runOperation(ctx, h.request(ctx)), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), 0);
  assert.equal(h.queue(), 0);
  const view = new DatabaseSync(join(h.path, 'journal.sqlite'));
  try { assert.equal(view.prepare('SELECT state FROM operations').get()!.state, 'prepared'); }
  finally { view.close(); }
  const b = h.context(h.sessions.full, h.clientB, h.grantB);
  await assert.rejects(actor.runOperation(b, h.request(b)), { code: 'FORBIDDEN' });
  assert.equal(h.count(), 0);
});

test('revocation after core commit retains one effect and B can capture its receipt without executing A intent', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB), request = h.request(a);
  const actor = h.make({ failpoint: point => { if (point === 'after_core_commit') h.grants.get(h.grantA)!.active = false; } });
  await assert.rejects(actor.runOperation(a, request), /grant revoked/);
  assert.equal(h.count(), 1);
  await actor.close();
  const recovered = h.make();
  await recovered.lookupOperation(b, request.input.operationId);
  assert.equal(h.count(), 1);
  const journal = new DatabaseSync(join(h.path, 'journal.sqlite'));
  try { assert.equal(journal.prepare('SELECT state FROM operations').get()!.state, 'pending_sync'); }
  finally { journal.close(); }
  await assert.rejects(recovered.resumeDelivery(a, async () => undefined), /grant revoked/);
});

test('mid-upload cutoff retains partial acceptance and leaves the queue for explicit resume', { timeout: 20_000 }, async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.sessions.full, h.clientB, h.grantB);
  let uploads = 0;
  const actor = h.make({}, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (new URL(request.url).pathname === '/m/uploadRecord' && ++uploads === 1) h.grants.get(h.grantA)!.active = false;
    return response;
  } });
  await assert.rejects(actor.runOperation(a, h.request(a)), /grant revoked/);
  assert.equal(uploads, 1);
  assert.ok(h.evidence().includes('accepted'));
  assert.ok(h.queue() > 0);
  await actor.close();
  const restarted = h.make();
  await restarted.resumeDelivery(b, async () => undefined);
  const result = await restarted.runOperation(b, h.request(b));
  assert.equal(result.data.state, 'backend_acknowledged');
  assert.equal(h.queue(), 0);
  assert.ok(h.evidence().every(value => value !== null));
});

test('read-derived facts need explicit owner resume and a restored latch still fences it', { timeout: 20_000 }, async t => {
  const h = await fixture(t, true), readCtx = h.context(h.sessions.read), fullCtx = h.context();
  const client = createClient({ url: host.url, token: h.sessions.full.token });
  try {
    const id = randomUUID(), stamp = '01793000000000-00001-legacy';
    const payload = JSON.stringify({ schemaVersion: 1, entityType: 'check_in', entityId: id, mutationStamp: stamp, deleted: false,
      fields: { id, board_id: boardId, logical_date: '2026-10-30', occurred_at_utc: null, time_zone_id: null,
        offset_minutes: null, amount: null, note: 'synthetic derived fact', source: 'app', idempotency_key: id,
        created_at: Date.UTC(2026, 9, 30), updated_at: Date.UTC(2026, 9, 30), deleted_at: null } });
    const uploaded = await client.mutate((await import('../../../snapback/generated/api.ts')).api.uploadRecord, {
      entityType: 'check_in', entityId: id, schemaVersion: 1, mutationStamp: stamp, deleted: false,
      payload, body: null, digest: createHash('sha256').update(payload).digest('hex') });
    assert.equal(uploaded.state, 'sent');
  } finally { await client.close(); }
  const actor = h.make();
  await actor.withAccount(readCtx, {}, async () => undefined);
  await actor.withAccount(readCtx, {}, async () => undefined);
  assert.ok(h.queue() > 0);
  const request = h.request(fullCtx);
  const pending = await actor.runOperation(fullCtx, request);
  assert.equal(pending.data.state, 'pending_sync');
  assert.ok(h.queue() > 0);
  await actor.close();
  const resumed = h.make();
  await resumed.resumeDelivery(fullCtx, async () => undefined);
  const delivered = await resumed.runOperation(fullCtx, request);
  assert.equal(delivered.data.state, 'backend_acknowledged');
  assert.equal(h.queue(), 0);
  h.latch.markRestored();
  await assert.rejects(resumed.resumeDelivery(fullCtx, async () => undefined), { code: 'OPERATION_PENDING' });
});
