import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test, type TestContext } from 'node:test';
import { login, signup, type Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe, type ServeHost } from 'snapback4/proof';

import { api } from '../../../snapback/generated/api.ts';
import { createBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { WireSyncRecord } from '../../../src/core/sync/transport';
import { AccountActors, type AccountOptions } from '../src/accounts/actor';
import { accountDirectory } from '../src/accounts/replica';
import type { OperationPolicy } from '../src/accounts/operations';
import type { AuthContext } from '../src/auth/context';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../src/core';
import type { MutationRequest } from '../src/operations/journal';
import { FileRestoreLatch } from '../src/operations/recovery-head';

const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-operation-server-'));
let host: ServeHost, full: Session, read: Session, boardId: string;
let seeds: WireSyncRecord[], fixtureNumber = 0;
before(async () => {
  assert.equal(process.version, 'v24.22.2'); assert.equal('bun' in process.versions, false);
  assert.equal((await deploy(join(directory, 'backend'), resolve('snapback/schema.q'), { logsDir: join(directory, 'logs') })).code, 0);
  host = await startServe(join(directory, 'backend'), { logsDir: join(directory, 'logs') });
  const email = `${randomUUID()}@example.test`, password = randomUUID();
  const signed = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(signed.ok); full = signed.session;
  const narrowed = await login(host.url, email, password, { scope: 'read', timeoutMs: 2000 }); assert.ok(narrowed.ok); read = narrowed.session;
  const client = createClient({ url: host.url, token: full.token }), db = new NodeSqlDatabase();
  const ports = createCorePorts('UTC');
  try {
    assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
    const board = await createBoard({ db, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic protected count', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
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

async function fixture(t: TestContext) {
  let sessions = { full, read };
  if (fixtureNumber++ > 0) {
    const email = `${randomUUID()}@example.test`, password = randomUUID();
    const signed = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(signed.ok, JSON.stringify(signed));
    const narrowed = await login(host.url, email, password, { scope: 'read', timeoutMs: 2000 }); assert.ok(narrowed.ok);
    sessions = { full: signed.session, read: narrowed.session };
    const client = createClient({ url: host.url, token: sessions.full.token });
    try {
      const transport = createSnapbackTransport({ connection: async () => ({ client, session: sessions.full, isCurrent: () => true }),
        bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
      await transport.ensureZone(); await transport.upload(seeds);
    } finally { await client.close(); }
  }
  const root = mkdtempSync(join(tmpdir(), 'habit-mcp-operation-actors-')), local = join(root, 'replicas'), external = join(root, 'external');
  mkdirSync(local, { mode: 0o700 }); mkdirSync(external, { mode: 0o700 });
  const latchOptions = { path: join(external, 'restore-latch'), installationId: randomUUID(),
    restoredDirectories: [local, join(directory, 'backend')] as const };
  FileRestoreLatch.provisionFresh(latchOptions);
  const latch = new FileRestoreLatch(latchOptions), accountId = randomUUID(), clientId = randomUUID(), grantId = randomUUID();
  const context = (session = sessions.full, client: string = clientId, grant: string = grantId): AuthContext => ({ accountId, clientId: client, grantId: grant,
    principal: session.principal, scopes: ['habits:read', 'checkins:write'], backendUrl: host.url, session, assertActive: async () => undefined });
  const policy: OperationPolicy = { latch, authorize: async () => undefined,
    normalize: async (request, frozen) => {
      assert.equal(request.tool, 'create_checkin');
      return { timeZone: 'UTC', command: { tool: 'create_checkin', input: { commandId: frozen.commandId,
        boardId: boardId as never, logicalDate: '2026-10-30' as never, source: 'app' } } };
    } };
  const managers: AccountActors[] = [];
  const actors = (overrides: Partial<OperationPolicy> = {}, options: Partial<AccountOptions> = {}) => {
    const actor = new AccountActors({ root: local, backendUrl: host.url, minFreeBytes: 1024 * 1024,
      operationPolicy: { ...policy, ...overrides }, ...options }); managers.push(actor); return actor;
  };
  t.after(async () => { await Promise.all(managers.map(actor => actor.close())); rmSync(root, { recursive: true, force: true }); });
  const request = (ctx = context(), id: string = randomUUID()): MutationRequest => ({ clientId: ctx.clientId, tool: 'create_checkin',
    input: { operationId: id, habitId: boardId, timeZone: 'UTC' } });
  const path = accountDirectory(local, accountId);
  const count = () => {
    const db = new DatabaseSync(join(path, 'product.sqlite'));
    try { return Number(db.prepare('SELECT count(*) AS n FROM check_ins').get()!.n); }
    finally { db.close(); }
  };
  return { root, local, path, latch, latchOptions, context, policy, actors, request, count, ...sessions };
}

test('protected core commit lost before receipt capture recovers and returns one effect after restart', { timeout: 20_000 }, async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const crashed = h.actors({ failpoint: point => { if (point === 'after_core_commit') throw new Error('synthetic after-core crash'); } });
  await assert.rejects(crashed.runOperation(ctx, request), /synthetic after-core crash/);
  assert.equal(h.count(), 1); await crashed.close();
  const actor = h.actors(), recovered = await actor.runOperation(ctx, request);
  assert.ok(recovered.data.result?.ok); assert.equal(recovered.data.state, 'pending_sync');
  assert.equal(recovered.data.delivery, 'pending'); assert.equal(h.count(), 1);
  assert.ok(recovered.meta.pendingLocalDeliveries > 0);
  assert.deepEqual((await actor.runOperation(ctx, request)).data, recovered.data);
  const writeOnly = { ...ctx, scopes: ['checkins:write'] as const };
  await assert.rejects(actor.lookupOperation(writeOnly, request.input.operationId), { code: 'FORBIDDEN' });
  await assert.rejects(actor.lookupOperation(writeOnly, randomUUID()), { code: 'FORBIDDEN' });
  const client = createClient({ url: host.url, token: h.read.token, readOnly: true });
  try { const head = await client.query(api.mcpRecoveryHead, {}); assert.ok('data' in head && head.data); assert.equal(head.data.sequence, 2); }
  finally { await client.close(); }
  await actor.close();
  const delivered = h.actors({ delivery: { grantStatus: async grantId => grantId === ctx.grantId
    ? { accountId: ctx.accountId, clientId: ctx.clientId, active: true, scopes: ctx.scopes } : null } });
  const accepted = await delivered.runOperation(ctx, request);
  assert.equal(accepted.data.state, 'backend_acknowledged');
  assert.equal(accepted.data.delivery, 'acknowledged');
  await delivered.close();
  const acceptedCopy = join(h.root, 'accepted-operation'); cpSync(h.path, acceptedCopy, { recursive: true });
  for (const [change, name] of [
    ["UPDATE operations SET state = 'pending_sync', delivery = 'pending'", 'accepted operation downgraded to pending'],
    ["UPDATE tuples SET disposition = NULL, remote_stamp = NULL WHERE outbox_id = (SELECT min(outbox_id) FROM tuples)",
      'accepted tuple rolled back to unknown'],
    ["UPDATE tuples SET remote_stamp = '99999999999999-zzzzz-forged' WHERE outbox_id = (SELECT min(outbox_id) FROM tuples)",
      'accepted tuple remote stamp changed'],
  ] as const) {
    await t.test(name, async () => {
      rmSync(h.path, { recursive: true }); cpSync(acceptedCopy, h.path, { recursive: true });
      const forged = new DatabaseSync(join(h.path, 'journal.sqlite'));
      try { forged.exec(change); } finally { forged.close(); }
      const reopened = h.actors();
      try {
        await assert.rejects(reopened.runOperation(ctx, request), { code: 'OPERATION_PENDING' });
        assert.equal(h.count(), 1);
      } finally { await reopened.close(); }
    });
  }
});

test('read authority cannot initialize, advance, recover prepared work or borrow another full session', async t => {
  const h = await fixture(t), ctx = h.context(), readCtx = h.context(h.read), request = h.request(ctx);
  const paths: string[] = [];
  const options = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); paths.push(new URL(request.url).pathname); return fetch(request);
  } };
  const actor = h.actors({}, options);
  await assert.rejects(actor.runOperation(readCtx, request), { code: 'FORBIDDEN' });
  assert.equal(readdirSync(h.local).length, 0);
  const initial = await actor.withAccount(readCtx, {}, async runtime => runtime.recovery);
  assert.equal(initial.data.writeFenced, true); assert.equal(paths.some(path => path.startsWith('/m/')), false);
  await actor.close();
  const crashed = h.actors({ failpoint: point => { if (point === 'after_prepare') throw new Error('synthetic prepared crash'); } });
  await assert.rejects(crashed.runOperation(ctx, request), /synthetic prepared crash/);
  assert.equal(h.count(), 0); await crashed.close();
  paths.length = 0;
  const refused = h.actors({}, options);
  await assert.rejects(refused.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  await assert.rejects(refused.lookupOperation(readCtx, request.input.operationId), { code: 'OPERATION_PENDING' });
  await assert.rejects(refused.runOperation(readCtx, request), { code: 'FORBIDDEN' });
  assert.equal(paths.includes('/q/changes'), false); assert.equal(paths.some(path => path.startsWith('/m/')), false);
  assert.equal(h.count(), 0); await refused.close();
  const resumed = h.actors(); await resumed.runOperation(ctx, request); assert.equal(h.count(), 1);
  paths.length = 0;
  const looked = await resumed.lookupOperation(readCtx, request.input.operationId);
  assert.equal(looked.data?.state, 'pending_sync');
  await assert.rejects(resumed.lookupOperation({ ...readCtx, scopes: ['habits:read'] }, request.input.operationId), { code: 'FORBIDDEN' });
});

test('receipt capture and head publication precede the first resumed pull and its derived facts', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const actor = h.actors({ failpoint: point => { if (point === 'after_core_commit') throw new Error('synthetic lost capture'); } });
  await assert.rejects(actor.runOperation(ctx, request), /synthetic lost capture/); await actor.close();
  const sidecar = new DatabaseSync(join(h.path, 'operations.sqlite'));
  const journal = new DatabaseSync(join(h.path, 'journal.sqlite'));
  try {
    const meta = sidecar.prepare('SELECT * FROM runtime_meta').get()!;
    assert.equal(meta.generation, journal.prepare('SELECT generation FROM journal_meta').get()!.generation);
    assert.equal(meta.journal_ready, 1);
    assert.equal(sidecar.prepare('SELECT grant_id FROM operation_grants').get()!.grant_id, ctx.grantId);
  } finally { sidecar.close(); journal.close(); }
  const client = createClient({ url: host.url, token: h.full.token });
  try {
    const id = randomUUID(), stamp = '01793000000000-00001-legacy';
    const payload = JSON.stringify({ schemaVersion: 1, entityType: 'check_in', entityId: id, mutationStamp: stamp, deleted: false,
      fields: { id, board_id: boardId, logical_date: '2026-10-30', occurred_at_utc: null, time_zone_id: null, offset_minutes: null,
        amount: null, note: 'synthetic delayed legacy', source: 'app', idempotency_key: id,
        created_at: Date.UTC(2026, 9, 30), updated_at: Date.UTC(2026, 9, 30), deleted_at: null } });
    assert.equal((await client.mutate(api.uploadRecord, { entityType: 'check_in', entityId: id, schemaVersion: 1,
      mutationStamp: stamp, deleted: false, payload, body: null, digest: createHash('sha256').update(payload).digest('hex') })).state, 'sent');
  } finally { await client.close(); }
  let pulled = 0, captured = 0;
  const resumed = h.actors({}, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/q/changes') {
      pulled++;
      const view = new DatabaseSync(join(h.path, 'journal.sqlite'));
      try {
        assert.equal(view.prepare('SELECT state FROM operations').get()!.state, 'pending_sync');
        captured = Number(view.prepare('SELECT count(*) AS n FROM tuples').get()!.n);
        assert.ok(captured > 0);
      } finally { view.close(); }
    }
    return fetch(request);
  } });
  const result = await resumed.lookupOperation(ctx, request.input.operationId);
  assert.equal(pulled, 1); assert.equal(result.data!.tuples.length, captured);
  assert.ok(result.meta.pendingLocalDeliveries > captured); assert.equal(h.count(), 2);
});

test('old local history against an advanced owner head and a missing restore latch fence before pull or execution', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const provisioned = h.actors({ failpoint: point => { if (point === 'before_prepare') throw new Error('synthetic before prepare'); } });
  await assert.rejects(provisioned.runOperation(ctx, request), /synthetic before prepare/); await provisioned.close();
  const backup = join(h.root, 'old-account'); cpSync(h.path, backup, { recursive: true });
  const advanced = h.actors(); await advanced.runOperation(ctx, request); assert.equal(h.count(), 1); await advanced.close();
  rmSync(h.path, { recursive: true }); cpSync(backup, h.path, { recursive: true });
  let pulled = 0;
  const restored = h.actors({}, { fetch: async (input, init) => {
    const request = new Request(input, init); if (new URL(request.url).pathname === '/q/changes') pulled++; return fetch(request);
  } });
  await assert.rejects(restored.runOperation(ctx, request), { code: 'OPERATION_PENDING' });
  await assert.rejects(restored.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulled, 0); assert.equal(h.count(), 0); await restored.close();
  rmSync(h.latchOptions.path);
  await assert.rejects(h.actors().runOperation(ctx, request), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), 0);
});

test('commands from two clients, consistent reads and trusted control share one lane and retain original grant provenance', async t => {
  const h = await fixture(t), a = h.context(), b = h.context(h.full, randomUUID(), randomUUID());
  const sameId = randomUUID(), firstRequest = h.request(a, sameId), secondRequest = h.request(b, sameId);
  let enter!: () => void, release!: () => void, paused = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const actor = h.actors({ authorize: async admission => {
    if (paused && ['prepare', 'execute'].includes(admission.action)) throw Object.assign(new Error('synthetic account barrier'), { code: 'FORBIDDEN' });
  }, normalize: async (request, frozen) => {
    events.push(request.clientId === a.clientId ? 'command-a' : 'command-b');
    if (request.clientId === a.clientId) { enter(); await held; }
    return h.policy.normalize(request, frozen);
  } });
  const first = actor.runOperation(a, firstRequest); await entered;
  const readTurn = actor.withAccount(h.context(h.read), {}, async runtime => {
    events.push('read'); return Number((await runtime.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins'))!.n);
  });
  const second = actor.runOperation(b, secondRequest);
  const control = actor.withAccountControl(a, async runtime => {
    assert.equal(runtime.accountId, a.accountId); await runtime.assertActive(); events.push('control'); paused = true;
  });
  release();
  const [original, observed] = await Promise.all([first, readTurn, second, control]);
  assert.equal(observed!.data, 1); assert.equal(h.count(), 2);
  assert.deepEqual(events, ['command-a', 'read', 'command-b', 'control']);
  await assert.rejects(actor.runOperation(a, h.request(a)), { code: 'FORBIDDEN' });
  const reconnected = h.context(h.full, a.clientId, randomUUID());
  const lookup = await actor.lookupOperation(reconnected, firstRequest.input.operationId);
  assert.equal(lookup.data?.intent.commandId, original!.data.intent.commandId);
  assert.equal((await actor.lookupOperation(h.context(h.read, randomUUID()), firstRequest.input.operationId)).data, null);
  const state = new DatabaseSync(join(h.path, 'operations.sqlite'));
  try {
    const origins = state.prepare('SELECT * FROM operation_grants ORDER BY client_id').all();
    assert.equal(origins.length, 2);
    assert.equal(origins.find(row => row.client_id === a.clientId)!.grant_id, a.grantId);
    assert.equal(origins.find(row => row.client_id === b.clientId)!.grant_id, b.grantId);
  } finally { state.close(); }
});

test('missing provenance, unavailable head and a latched restore refuse all new account work', async t => {
  const h = await fixture(t), ctx = h.context();
  const actor = h.actors(); await actor.runOperation(ctx, h.request(ctx)); await actor.close();
  const unavailable = h.actors({}, { fetch: async () => { throw new TypeError('synthetic upstream unavailable'); } });
  await assert.rejects(unavailable.runOperation(ctx, h.request(ctx)), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), 1); await unavailable.close();
  h.latch.markRestored();
  const latched = h.actors();
  await assert.rejects(latched.runOperation(ctx, h.request(ctx)), { code: 'OPERATION_PENDING' });
  await latched.close();
  assert.equal(h.count(), 1);
  rmSync(join(h.path, 'operations.sqlite'));
  await assert.rejects(h.actors().withAccount(ctx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), 1);
});

test('a restored latch serves an authorized product read with an honest fence and no recovery writes', async t => {
  const h = await fixture(t), fullCtx = h.context(), readCtx = h.context(h.read);
  const original = h.actors();
  const written = await original.runOperation(fullCtx, h.request(fullCtx));
  assert.equal(h.count(), 1);
  await original.close();
  const pendingCopy = join(h.root, 'pending-before-false-ack'); cpSync(h.path, pendingCopy, { recursive: true });
  const corruptions = [
    ["UPDATE operations SET state = 'backend_acknowledged', delivery = 'acknowledged'", 'ack state without acceptance'],
    ["UPDATE tuples SET disposition = 'accepted', remote_stamp = mutation_stamp WHERE outbox_id = (SELECT min(outbox_id) FROM tuples)",
      'tuple disposition without acceptance'],
    ["UPDATE tuples SET disposition = 'accepted', remote_stamp = mutation_stamp; UPDATE operations SET state = 'backend_acknowledged', delivery = 'acknowledged'",
      'ack state and tuples without acceptance'],
    ["UPDATE tuples SET disposition = 'invalid', remote_stamp = mutation_stamp WHERE outbox_id = (SELECT min(outbox_id) FROM tuples)",
      'unsupported tuple disposition'],
    ["UPDATE tuples SET record = '{}' WHERE outbox_id = (SELECT min(outbox_id) FROM tuples)", 'changed captured tuple payload'],
  ] as const;
  for (const [change, name] of corruptions) {
    await t.test(name, async () => {
      rmSync(h.path, { recursive: true }); cpSync(pendingCopy, h.path, { recursive: true });
      const forged = new DatabaseSync(join(h.path, 'journal.sqlite'));
      try {
        forged.exec(change);
        assert.equal(forged.prepare("SELECT count(*) AS n FROM journal_chain WHERE json_extract(event, '$.kind') = 'acceptance'").get()!.n, 0);
      } finally { forged.close(); }
      const normal = h.actors();
      try {
        await assert.rejects(normal.runOperation(fullCtx, h.request(fullCtx, written.data.intent.operationId)), { code: 'OPERATION_PENDING' });
        assert.equal(h.count(), 1);
      } finally { await normal.close(); }
    });
  }
  rmSync(h.path, { recursive: true }); cpSync(pendingCopy, h.path, { recursive: true });
  h.latch.markRestored();
  const paths: string[] = [];
  const latched = h.actors({ delivery: { grantStatus: async grantId => ({ accountId: fullCtx.accountId,
    clientId: fullCtx.clientId, active: grantId === fullCtx.grantId, scopes: fullCtx.scopes }) } }, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(`${request.method} ${new URL(request.url).pathname}`);
      return fetch(request);
    },
  });
  const observed = await latched.withAccount(readCtx, {}, async runtime => ({
    count: Number((await runtime.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins'))!.n),
    recovery: runtime.recovery,
  }));
  assert.equal(observed.data.count, 1);
  assert.deepEqual(observed.data.recovery, { writeFenced: true, deliveryPaused: true,
    reconnectRequired: false, recoveryReason: 'restore_latched' });
  assert.equal(paths.some(path => path.startsWith('POST /m/')), false);
  await assert.rejects(latched.lookupOperation(readCtx, written.data.intent.operationId), { code: 'OPERATION_PENDING' });
  await assert.rejects(latched.runOperation(fullCtx, h.request(fullCtx)), { code: 'OPERATION_PENDING' });
  let confirmed = false;
  await assert.rejects(latched.resumeDelivery(fullCtx, async () => { confirmed = true; }), { code: 'OPERATION_PENDING' });
  assert.equal(confirmed, false);
  assert.equal(h.count(), 1);
  const state = new DatabaseSync(join(h.path, 'operations.sqlite'), { readOnly: true });
  const journal = new DatabaseSync(join(h.path, 'journal.sqlite'), { readOnly: true });
  try {
    assert.equal(state.prepare('SELECT journal_ready FROM runtime_meta').get()!.journal_ready, 1);
    assert.equal(journal.prepare('SELECT count(*) AS n FROM operations').get()!.n, 1);
    assert.equal(journal.prepare('SELECT state FROM operations').get()!.state, 'pending_sync');
  } finally { state.close(); journal.close(); }
  await latched.close();
  const forged = new DatabaseSync(join(h.path, 'journal.sqlite'));
  try { forged.exec("UPDATE operations SET state = 'backend_acknowledged', delivery = 'acknowledged'"); }
  finally { forged.close(); }
  paths.length = 0;
  const refused = h.actors({}, { fetch: async (input, init) => {
    const request = new Request(input, init);
    paths.push(`${request.method} ${new URL(request.url).pathname}`);
    return fetch(request);
  } });
  await assert.rejects(refused.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(paths.includes('POST /q/changes'), false);
  assert.equal(paths.some(path => path.startsWith('POST /m/')), false);
  await refused.close();
});

test('a prepared intent forged as pending without capture fences normal retry and restored read', async t => {
  const h = await fixture(t), ctx = h.context(), readCtx = h.context(h.read), request = h.request(ctx);
  const prepared = h.actors({ failpoint: point => { if (point === 'after_prepare') throw new Error('synthetic prepared stop'); } });
  await assert.rejects(prepared.runOperation(ctx, request), /synthetic prepared stop/);
  await prepared.close();
  const journal = new DatabaseSync(join(h.path, 'journal.sqlite'));
  let preparedHash: string;
  try {
    preparedHash = String(journal.prepare('SELECT head_hash FROM journal_chain WHERE sequence = 1').get()!.head_hash);
    journal.prepare("UPDATE operations SET state = 'pending_sync', delivery = 'pending' WHERE operation_id = ?")
      .run(request.input.operationId);
    assert.equal(journal.prepare("SELECT count(*) AS n FROM journal_chain WHERE json_extract(event, '$.kind') = 'captured'").get()!.n, 0);
  } finally { journal.close(); }
  const client = createClient({ url: host.url, token: h.full.token });
  try {
    const head = await client.query(api.mcpRecoveryHead, {});
    assert.ok('data' in head && head.data);
    assert.equal(head.data.sequence, 0);
    assert.equal((await client.mutate(api.advanceMcpRecoveryHead, { generation: head.data.generation,
      expectedSequence: 0, expectedHash: head.data.headHash, nextHash: preparedHash })).state, 'sent');
  } finally { await client.close(); }
  const corrupted = join(h.root, 'uncaptured-operation'); cpSync(h.path, corrupted, { recursive: true });
  let normalPulls = 0;
  const normal = h.actors({}, { fetch: async (input, init) => {
    const wire = new Request(input, init);
    if (new URL(wire.url).pathname === '/q/changes') normalPulls++;
    return fetch(wire);
  } });
  await assert.rejects(normal.runOperation(ctx, request), { code: 'OPERATION_PENDING' });
  assert.equal(normalPulls, 0); assert.equal(h.count(), 0);
  await normal.close();
  rmSync(h.path, { recursive: true }); cpSync(corrupted, h.path, { recursive: true });
  h.latch.markRestored();
  let pulls = 0;
  const latched = h.actors({}, { fetch: async (input, init) => {
    const wire = new Request(input, init);
    if (new URL(wire.url).pathname === '/q/changes') pulls++;
    return fetch(wire);
  } });
  await assert.rejects(latched.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0); assert.equal(h.count(), 0);
  await latched.close();
});

test('a restored latch refuses a rolled-back local head before product work', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const original = h.actors({ failpoint: point => { if (point === 'before_prepare') throw new Error('synthetic pre-prepare stop'); } });
  await assert.rejects(original.runOperation(ctx, request), /synthetic pre-prepare stop/);
  await original.close();
  const backup = join(h.root, 'prior-account'); cpSync(h.path, backup, { recursive: true });
  const advanced = h.actors(); await advanced.runOperation(ctx, request); await advanced.close();
  rmSync(h.path, { recursive: true }); cpSync(backup, h.path, { recursive: true });
  h.latch.markRestored();
  let pulls = 0;
  const latched = h.actors({}, { fetch: async (input, init) => {
    const wire = new Request(input, init);
    if (new URL(wire.url).pathname === '/q/changes') pulls++;
    return fetch(wire);
  } });
  await assert.rejects(latched.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0); assert.equal(h.count(), 0);
  await latched.close();
});

test('a missing prepared operation row fences both protected retry and restored read', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const original = h.actors(); await original.runOperation(ctx, request); await original.close();
  const journal = new DatabaseSync(join(h.path, 'journal.sqlite'));
  try {
    assert.ok(journal.prepare("SELECT 1 FROM journal_chain WHERE json_extract(event, '$.kind') = 'prepared'").get());
    journal.exec('DELETE FROM tuples; DELETE FROM operations');
  } finally { journal.close(); }
  const corrupted = join(h.root, 'missing-prepared-row'); cpSync(h.path, corrupted, { recursive: true });
  const retry = h.actors();
  await assert.rejects(retry.runOperation(ctx, request), { code: 'OPERATION_PENDING' });
  assert.equal(h.count(), 1); await retry.close();
  rmSync(h.path, { recursive: true }); cpSync(corrupted, h.path, { recursive: true });
  h.latch.markRestored();
  let pulls = 0;
  const latched = h.actors({}, { fetch: async (input, init) => {
    const wire = new Request(input, init);
    if (new URL(wire.url).pathname === '/q/changes') pulls++;
    return fetch(wire);
  } });
  await assert.rejects(latched.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0); assert.equal(h.count(), 1);
  await latched.close();
});

test('lost operation files and a rolled-back remote head cannot turn prior write history into fresh read bootstrap', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const writer = h.actors();
  await writer.runOperation(ctx, request); assert.equal(h.count(), 1); await writer.close();
  const legacy = new DatabaseSync(join(h.path, 'replica.sqlite'));
  try { legacy.exec('DROP TABLE operation_provenance; PRAGMA user_version = 1'); } finally { legacy.close(); }
  const migrated = h.actors();
  const found = await migrated.lookupOperation(ctx, request.input.operationId);
  assert.equal(found.data?.intent.operationId, request.input.operationId);
  await migrated.close();
  const marker = new DatabaseSync(join(h.path, 'replica.sqlite'), { readOnly: true });
  try { assert.equal(marker.prepare('SELECT state FROM operation_provenance').get()!.state, 'initialized'); }
  finally { marker.close(); }
  rmSync(join(h.path, 'operations.sqlite')); rmSync(join(h.path, 'journal.sqlite'));
  const product = new DatabaseSync(join(h.path, 'product.sqlite'));
  try { product.exec('DELETE FROM command_receipts'); } finally { product.close(); }
  h.latch.markRestored();
  let pulls = 0;
  const absentHead = async (input: RequestInfo | URL, init?: RequestInit) => {
    const wire = new Request(input, init), path = new URL(wire.url).pathname;
    if (path === '/q/changes') pulls++;
    const response = await fetch(wire);
    if (path !== '/q/mcpRecoveryHead') return response;
    const body = await response.json() as Record<string, unknown>;
    const headers = new Headers(response.headers); headers.delete('content-length');
    return new Response(JSON.stringify({ ...body, data: null }), { status: response.status, headers });
  };
  const latched = h.actors({}, { fetch: absentHead });
  const replay = createClient({ url: host.url, token: h.read.token, readOnly: true, fetch: absentHead });
  try {
    const head = await replay.query(api.mcpRecoveryHead, {});
    assert.ok('data' in head && head.data === null, 'synthetic rollback must present a complete null head');
  } finally { await replay.close(); }
  const policyFree = h.actors({}, { operationPolicy: undefined, fetch: absentHead });
  await assert.rejects(policyFree.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0); await policyFree.close();
  await assert.rejects(latched.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0); assert.equal(h.count(), 1);
  await latched.close();
  rmSync(join(h.path, 'replica.sqlite'));
  const missingAnchor = h.actors();
  await assert.rejects(missingAnchor.withAccount(h.context(h.read), {}, async () => 'unsafe'), { code: 'UNAVAILABLE' });
  await missingAnchor.close();
});

test('a fresh latched account reads twice while ambiguous legacy private metadata fences', async t => {
  const ambiguous = await fixture(t), readCtx = ambiguous.context(ambiguous.read);
  const policyFree = ambiguous.actors({}, { operationPolicy: undefined });
  const initial = await policyFree.withAccount(readCtx, {}, async runtime => runtime.recovery);
  assert.equal(initial.data.recoveryReason, 'read_only_reconstruction');
  await policyFree.close();
  ambiguous.latch.markRestored();
  const read = ambiguous.actors();
  for (let turn = 0; turn < 2; turn++) {
    const observed = await read.withAccount(readCtx, {}, async runtime => runtime.recovery);
    assert.equal(observed.data.recoveryReason, 'restore_latched');
    assert.equal(observed.data.writeFenced, true);
    assert.equal(observed.data.deliveryPaused, true);
    assert.equal(readdirSync(ambiguous.path).includes('operations.sqlite'), false);
    const marker = new DatabaseSync(join(ambiguous.path, 'replica.sqlite'), { readOnly: true });
    try { assert.equal(marker.prepare('SELECT state FROM operation_provenance').get()!.state, 'never'); }
    finally { marker.close(); }
  }
  await read.close();
  const old = new DatabaseSync(join(ambiguous.path, 'replica.sqlite'));
  try { old.exec('DROP TABLE operation_provenance; PRAGMA user_version = 1'); } finally { old.close(); }
  const fenced = ambiguous.actors();
  await assert.rejects(fenced.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  await fenced.close();
  const unknown = new DatabaseSync(join(ambiguous.path, 'replica.sqlite'), { readOnly: true });
  try { assert.equal(unknown.prepare('SELECT state FROM operation_provenance').get()!.state, 'unknown'); }
  finally { unknown.close(); }
  const unconfigured = ambiguous.actors({}, { operationPolicy: undefined });
  await assert.rejects(unconfigured.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  await unconfigured.close();
  const fullCtx = ambiguous.context(), cutoff = ambiguous.actors({ delivery: { grantStatus: async () => null } });
  let commits = 0;
  await cutoff.revokeDeliveryGrant({ accountId: fullCtx.accountId, principal: fullCtx.principal,
    backendUrl: fullCtx.backendUrl, clientId: fullCtx.clientId, grantId: fullCtx.grantId }, async () => { commits++; });
  assert.equal(commits, 1);
  assert.equal(readdirSync(ambiguous.path).includes('operations.sqlite'), false);
  await assert.rejects(cutoff.runOperation(fullCtx, ambiguous.request(fullCtx)), { code: 'OPERATION_PENDING' });
  await cutoff.close();
});

test('a marked history with an incomplete sidecar cannot masquerade as a fresh latched read', async t => {
  const h = await fixture(t), readCtx = h.context(h.read), fullCtx = h.context();
  const fresh = h.actors();
  await fresh.withAccount(readCtx, {}, async runtime => runtime.recovery);
  await fresh.close();
  h.latch.markRestored();
  const cutoff = h.actors({ delivery: { grantStatus: async () => null } });
  let commits = 0;
  await cutoff.revokeDeliveryGrant({ accountId: fullCtx.accountId, principal: fullCtx.principal,
    backendUrl: fullCtx.backendUrl, clientId: fullCtx.clientId, grantId: fullCtx.grantId }, async () => { commits++; });
  assert.equal(commits, 1);
  await cutoff.close();
  const sidecar = new DatabaseSync(join(h.path, 'operations.sqlite'), { readOnly: true });
  try { assert.equal(sidecar.prepare('SELECT journal_ready FROM runtime_meta').get()!.journal_ready, 0); }
  finally { sidecar.close(); }
  assert.equal(readdirSync(h.path).includes('journal.sqlite'), false);
  const client = createClient({ url: host.url, token: h.read.token, readOnly: true });
  try {
    const head = await client.query(api.mcpRecoveryHead, {});
    assert.ok('data' in head && head.data === null);
  } finally { await client.close(); }
  let pulls = 0;
  const latched = h.actors({ delivery: { grantStatus: async () => null } }, { fetch: async (input, init) => {
    const wire = new Request(input, init);
    if (new URL(wire.url).pathname === '/q/changes') pulls++;
    return fetch(wire);
  } });
  await assert.rejects(latched.withAccount(readCtx, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
  assert.equal(pulls, 0);
});

test('missing policy, wrong client, missing scopes and invalid inputs are refused before acquiring a replica', async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx), actor = h.actors();
  await assert.rejects(actor.runOperation({ ...ctx, scopes: ['habits:read'] }, request), { code: 'FORBIDDEN' });
  await assert.rejects(actor.runOperation(ctx, { ...request, clientId: randomUUID() }), { code: 'FORBIDDEN' });
  await assert.rejects(actor.runOperation(ctx, { ...request, input: { ...request.input, operationId: 'invalid' } } as MutationRequest), { code: 'INVALID_INPUT' });
  await assert.rejects(h.actors({}, { operationPolicy: undefined }).runOperation(ctx, request), { code: 'FORBIDDEN' });
  assert.equal(readdirSync(h.local).length, 0);
  assert.throws(() => h.actors({ latch: undefined as never }), /restore latch/);
});

test('actual SIGKILL after protected core commit retains the frozen operation and executes once after process restart', { timeout: 20_000 }, async t => {
  const h = await fixture(t), ctx = h.context(), request = h.request(ctx);
  const actorBundle = resolve(`services/mcp/.artifacts/operation-child-${process.pid}.mjs`);
  const headBundle = resolve(`services/mcp/.artifacts/operation-head-${process.pid}.mjs`);
  for (const [source, output] of [['services/mcp/src/accounts/actor.ts', actorBundle], ['services/mcp/src/operations/recovery-head.ts', headBundle]]) {
    const result = spawnSync('bun', ['build', source!, '--target=node', '--packages=external', `--outfile=${output}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { AccountActors } = await import(process.argv[1]);
    const { FileRestoreLatch } = await import(process.argv[2]);
    process.once('message', async ({ root, backendUrl, ctx, request, latchOptions }) => {
      try {
        const actor = new AccountActors({ root, backendUrl, minFreeBytes: 1048576,
          operationPolicy: { latch: new FileRestoreLatch(latchOptions), authorize: async () => {},
            normalize: async (request, frozen) => ({ timeZone: 'UTC', command: { tool: 'create_checkin',
              input: { commandId: frozen.commandId, boardId: request.input.habitId, logicalDate: '2026-10-30', source: 'app' } } }),
            failpoint: point => { if (point === 'after_core_commit') process.kill(process.pid, 'SIGKILL'); } } });
        await actor.runOperation({ ...ctx, assertActive: async () => {} }, request);
        process.exit(2);
      } catch (error) { process.stderr.write(String(error)); process.exit(3); }
    });`, actorBundle, headBundle], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.setEncoding('utf8').on('data', value => { stderr = (stderr + value).slice(-4000); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(actorBundle, { force: true }); rmSync(headBundle, { force: true }); });
  const exited = once(child, 'exit');
  child.send({ root: h.local, backendUrl: host.url, ctx: { ...ctx, assertActive: undefined }, request, latchOptions: h.latchOptions });
  const [code, signal] = await exited;
  assert.equal(signal, 'SIGKILL', stderr); assert.equal(code, null); assert.equal(h.count(), 1);
  const replay = await h.actors().runOperation(ctx, request);
  assert.ok(replay.data.result?.ok); assert.equal(replay.data.state, 'pending_sync'); assert.equal(h.count(), 1);
});
