import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { login, signup, type Session } from 'snapback4/auth';
import { createClient, type Client } from 'snapback4/client';
import { deploy, startServe, type ServeHost } from 'snapback4/proof';

import { api } from '../../../snapback/generated/api.ts';
import { createBoard, createCheckIn } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { claimReward, createReward } from '../../../src/core/domain/reward-commands';
import { initializeProductDatabase } from '../../../src/core/persistence/bootstrap';
import { createSnapbackTransport } from '../../../src/platform/backend/transport';
import { OperationJournal, type JournalHead, type JournalOptions, type MutationRequest } from '../src/operations/journal';
import { canonicalJson, sha256 } from '../src/operations/records';
import { FileRestoreLatch, RecoveryHeadAdapter, createSnapbackRecoveryRemote } from '../src/operations/recovery-head';
import { NodeSqlDatabase } from '../src/storage/sqlite';

const now = Date.UTC(2026, 9, 30, 12);
const ids = { uuid: () => randomUUID() };
const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

async function fixture(t: TestContext, kind: 'count' | 'claim' = 'count') {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-head-'));
  const backend = join(directory, 'backend'), local = join(directory, 'local');
  const external = join(directory, 'external');
  mkdirSync(local); mkdirSync(external);
  let host: ServeHost | undefined, product: NodeSqlDatabase | undefined, journal: OperationJournal | undefined;
  let adapter: RecoveryHeadAdapter;
  const clients: Client[] = [];
  t.after(async () => {
    try {
      journal?.close(); await product?.closeAsync();
      await Promise.all(clients.map(client => client.close()));
      await host?.stop();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const logsDir = join(directory, 'logs');
  assert.equal((await deploy(backend, resolve('snapback/schema.q'), { logsDir })).code, 0);
  const start = async () => { host = await startServe(backend, { logsDir }); };
  const stop = async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await host?.stop(); host = undefined;
  };
  await start();
  const email = `${randomUUID()}@example.test`, password = randomUUID();
  const signed = await signup(host!.url, email, password);
  assert.ok(signed.ok);
  const session = signed.session, owner = session.principal;
  const connect = (credential: Session = session, fetcher?: typeof fetch) => {
    const client = createClient({ url: host!.url, token: credential.token, fetch: fetcher }); clients.push(client); return client;
  };
  const remote = () => createSnapbackRecoveryRemote(connect());
  const options = { path: join(external, 'restore-latch'), installationId: randomUUID(), restoredDirectories: [local, backend] as const };
  FileRestoreLatch.provisionFresh(options);
  const latch = new FileRestoreLatch(options);
  const generation = randomUUID();
  const productPath = join(local, 'product.sqlite'), journalPath = join(local, 'journal.sqlite');
  product = new NodeSqlDatabase(productPath);
  assert.ok((await initializeProductDatabase(product, ids, hashing)).ok);
  const deps = () => ({ db: product!, ids, hashing, clock: { nowUtcMs: () => now, timeZoneId: () => 'UTC' } });
  const board = await createBoard(deps(), { commandId: randomUUID() as CommandId, title: 'synthetic count', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
  assert.ok(board.ok);
  const boardId = board.value.boardId;
  let rewardId: string, rewardStamp: string;
  if (kind === 'claim') {
    for (let i = 0; i < 2; i++) assert.ok((await createCheckIn(deps(), { commandId: randomUUID() as CommandId,
      boardId, logicalDate: '2026-10-30' as never, source: 'app' })).ok);
    const reward = await createReward(deps(), { commandId: randomUUID() as CommandId, title: 'synthetic tea',
      symbol: 'cup.and.saucer.fill', accentHex: '#70A7FF', costCoins: 1 });
    assert.ok(reward.ok); rewardId = reward.value.rewardId;
    rewardStamp = (await product.getFirstAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM rewards WHERE id = ?', [rewardId]))!.mutation_stamp;
  }
  let casCount = 0, authorized = true;
  const open = (overrides: Partial<JournalOptions> = {}, remoteOverride?: ReturnType<typeof remote>) => {
    const upstream = remoteOverride ?? remote();
    journal = new OperationJournal({ location: journalPath, accountId: owner, generation, product: product!, nowUtcMs: () => now,
      authorize: async () => { if (!authorized) throw new Error('revoked'); },
      normalize: async (request, context) => request.tool === 'claim_reward'
        ? { timeZone: 'UTC', command: { tool: 'claim_reward', input: { commandId: context.commandId,
          rewardId: rewardId as never, expectedMutationStamp: rewardStamp } } }
        : { timeZone: 'UTC', command: { tool: 'create_checkin', input: { commandId: context.commandId,
          boardId, logicalDate: '2026-10-30' as never, source: 'app' } } },
      execute: async intent => intent.command.tool === 'claim_reward'
        ? claimReward(deps(), intent.command.input)
        : createCheckIn(deps(), intent.command.input as never),
      publish: head => adapter.publish(head), ...overrides,
    });
    adapter = new RecoveryHeadAdapter({ owner, journal, remote: upstream, latch,
      authorize: async () => { casCount++; if (!authorized) throw new Error('revoked'); } });
    return journal;
  };
  const closeLocal = async () => { journal?.close(); journal = undefined; await product?.closeAsync(); product = undefined; };
  const reopen = () => { product = new NodeSqlDatabase(productPath); return open(); };
  const restart = async (overrides: Partial<JournalOptions> = {}, remoteOverride?: ReturnType<typeof remote>) => {
    await closeLocal(); product = new NodeSqlDatabase(productPath); return open(overrides, remoteOverride);
  };
  const snapshotLocal = async () => {
    await closeLocal(); const snapshot = join(directory, `local-${randomUUID()}`); cpSync(local, snapshot, { recursive: true }); reopen(); return snapshot;
  };
  const restoreLocal = async (snapshot: string) => {
    await closeLocal(); rmSync(local, { recursive: true }); cpSync(snapshot, local, { recursive: true }); return reopen();
  };
  const snapshotBackend = async () => {
    await stop(); const snapshot = join(directory, `backend-${randomUUID()}`); cpSync(backend, snapshot, { recursive: true });
    await start(); await closeLocal(); reopen(); return snapshot;
  };
  const restoreBackend = async (snapshot: string) => {
    await stop(); rmSync(backend, { recursive: true }); cpSync(snapshot, backend, { recursive: true }); await start();
  };
  const request = (): MutationRequest => kind === 'claim'
    ? { clientId: 'synthetic-client', tool: 'claim_reward', input: { operationId: randomUUID(), confirmationToken: randomUUID() } }
    : { clientId: 'synthetic-client', tool: 'create_checkin', input: { operationId: randomUUID(), habitId: boardId, timeZone: 'UTC' } };
  const effectCount = async () => (await product!.getFirstAsync<{ n: number }>(kind === 'claim'
    ? "SELECT count(*) AS n FROM coin_ledger WHERE delta < 0" : 'SELECT count(*) AS n FROM check_ins'))!.n;
  const upload = async (operation: Awaited<ReturnType<OperationJournal['run']>>) => {
    const client = connect();
    const transport = createSnapbackTransport({ connection: async () => ({ client, session, isCurrent: () => true }),
      bind: async () => undefined, hash: async text => sha256(text), onUpload: evidence => journal!.recordUploadAcceptance(evidence).then(() => undefined) });
    await journal!.beforeDelivery();
    await transport.ensureZone();
    await transport.upload(operation.tuples.map(tuple => tuple.record));
    assert.equal((await journal!.get(operation.intent.clientId, operation.intent.operationId))!.state, 'backend_acknowledged');
  };
  return { open, restart, request, effectCount, upload, remote, connect, owner, session, email, password, generation, latch, options,
    snapshotLocal, restoreLocal, snapshotBackend, restoreBackend, productPath, journalPath,
    journal: () => journal!, adapter: () => adapter, host: () => host!, casCount: () => casCount,
    closeJournal: () => { journal?.close(); journal = undefined; },
    revoke: () => { authorized = false; } };
}

for (const kind of ['count', 'claim'] as const) {
  test(`${kind}: old local backup plus advanced backend refuses same-id retry before another effect`, { timeout: 120_000 }, async t => {
    const h = await fixture(t, kind);
    await h.open().recover();
    const backup = await h.snapshotLocal();
    const request = h.request(), original = await h.journal().run(request);
    assert.ok(original.result?.ok); await h.upload(original);
    const before = await h.connect().query(api.changes, { after: 0 });
    assert.equal(await h.effectCount(), 1);
    await h.restoreLocal(backup);
    await assert.rejects(h.journal().recover(), { code: 'OPERATION_PENDING' });
    await assert.rejects(h.journal().run(request), { code: 'OPERATION_PENDING' });
    assert.equal(await h.effectCount(), 0);
    assert.equal((await h.remote().read())!.sequence > h.journal().head().sequence, true);
    assert.deepEqual(await h.connect().query(api.changes, { after: 0 }), before);
  });

  test(`${kind}: lost result replays exact receipt after restart; lost CAS response reconciles exact next head`, { timeout: 120_000 }, async t => {
    const h = await fixture(t, kind);
    const real = h.remote(); let lost = 0;
    const remote = { ...real, initialize: async (generation: string) => { await real.initialize(generation); lost++; throw new Error('lost genesis reply'); },
      advance: async (previous: JournalHead, next: JournalHead) => { await real.advance(previous, next); lost++; throw new Error('lost CAS reply'); } };
    const request = h.request(), original = await h.open({}, remote).run(request);
    assert.ok(original.result?.ok); assert.equal(lost, 3);
    const replayed = await (await h.restart()).run(request);
    assert.deepEqual(replayed, original); assert.equal(await h.effectCount(), 1);
  });

  test(`${kind}: matching old snapshots remain fenced by durable external restore latch`, { timeout: 120_000 }, async t => {
    const h = await fixture(t, kind);
    await h.open().recover();
    const backend = await h.snapshotBackend(), local = await h.snapshotLocal();
    const request = h.request(), original = await h.journal().run(request);
    assert.ok(original.result?.ok); await h.upload(original);
    h.latch.markRestored();
    const signal = readFileSync(h.options.path, 'utf8');
    await h.restoreBackend(backend); await h.restoreLocal(local);
    const remote = (await h.remote().read())!;
    assert.equal(remote.sequence, h.journal().head().sequence);
    assert.equal(remote.headHash, h.journal().head().headHash);
    await assert.rejects(h.journal().recover(), { code: 'OPERATION_PENDING' });
    await assert.rejects(h.journal().run(request), { code: 'OPERATION_PENDING' });
    assert.equal(await h.effectCount(), 0);
    await h.restart(); await assert.rejects(h.adapter().compare(), { code: 'OPERATION_PENDING' });
    assert.equal(readFileSync(h.options.path, 'utf8'), signal);
    assert.throws(() => FileRestoreLatch.provisionFresh(h.options));
  });
}

test('independently old backend remains fenced despite complete surviving local journal', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  const backup = await h.snapshotBackend();
  const request = h.request(), original = await h.journal().run(request); await h.upload(original);
  h.latch.markRestored(); await h.restoreBackend(backup); await h.restart();
  assert.ok((await h.remote().read())!.sequence < h.journal().head().sequence);
  const rolledBack = await h.connect().query(api.changes, { after: 0 });
  assert.ok(!('denied' in rolledBack)); assert.deepEqual(rolledBack.data, []);
  await assert.rejects(h.journal().recover(), { code: 'OPERATION_PENDING' });
  await assert.rejects(h.journal().run(request), { code: 'OPERATION_PENDING' });
  assert.equal(await h.effectCount(), 1);
});

test('read session compares matching heads without authorization or credential upgrade; every CAS reauthorizes', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  await h.journal().run(h.request());
  assert.equal(h.casCount(), 3);
  const read = await login(h.host().url, h.email, h.password, { scope: 'read' }); assert.ok(read.ok);
  const remote = createSnapbackRecoveryRemote(h.connect(read.session));
  let attempts = 0;
  const adapter = new RecoveryHeadAdapter({ owner: h.owner, journal: h.journal(), remote, latch: h.latch,
    authorize: async () => { attempts++; throw new Error('no write grant'); } });
  assert.equal(await adapter.compare(), 'current');
  await adapter.publish(h.journal().head()); assert.equal(attempts, 0);
  h.revoke(); await assert.rejects(h.journal().run(h.request()), /revoked/);
  assert.equal(await h.effectCount(), 1);
});

for (const point of ['after_prepare', 'after_core_commit', 'after_receipt_capture'] as const) {
  test(`head publication crash at ${point} resumes only known local tail and retains one effect`, { timeout: 120_000 }, async t => {
    const h = await fixture(t); const request = h.request();
    const journal = h.open({ failpoint: at => { if (at === point) throw new Error(`crash:${point}`); } });
    await assert.rejects(journal.run(request), new RegExp(`crash:${point}`));
    await (await h.restart()).recover();
    const result = await h.journal().run(request); assert.ok(result.result?.ok);
    assert.equal(await h.effectCount(), 1);
    assert.equal((await h.remote().read())!.headHash, h.journal().head().headHash);
  });
}

test('two stale service owners cannot fork an owner head or borrow another account head', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  const old = await h.snapshotLocal();
  await h.journal().run(h.request());
  await h.restoreLocal(old);
  await assert.rejects(h.journal().run(h.request()), { code: 'OPERATION_PENDING' });
  const other = await signup(h.host().url, `${randomUUID()}@example.test`, randomUUID()); assert.ok(other.ok);
  const remote = createSnapbackRecoveryRemote(h.connect(other.session));
  assert.equal(await remote.read(), null);
  await remote.initialize(randomUUID());
  const adapter = new RecoveryHeadAdapter({ owner: h.owner, journal: h.journal(), remote, latch: h.latch, authorize: async () => undefined });
  await assert.rejects(adapter.compare(), { code: 'OPERATION_PENDING' });
});

test('unavailable head, missing restore signal, and restore during publication all fence before core execution', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  const offline = createSnapbackRecoveryRemote(h.connect(h.session, async () => { throw new TypeError('network unavailable'); }));
  await h.restart({}, offline);
  await assert.rejects(h.journal().run(h.request()), { code: 'OPERATION_PENDING' });
  assert.equal(await h.effectCount(), 0);
  await h.restart({}, { ...h.remote(), advance: async (previous: JournalHead, next: JournalHead) => {
    h.latch.markRestored(); return h.remote().advance(previous, next);
  } });
  await assert.rejects(h.journal().run(h.request()), { code: 'OPERATION_PENDING' });
  assert.equal(await h.effectCount(), 0);
  rmSync(h.options.path);
  await assert.rejects(h.adapter().compare(), { code: 'OPERATION_PENDING' });
  writeFileSync(h.options.path, '{"version":1,"installationId":"untrusted-replacement"}\n');
  await assert.rejects(h.adapter().compare(), { code: 'OPERATION_PENDING' });
});

test('corrupt or missing local ancestry is refused even with matching remote head', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().run(h.request());
  for (const corrupt of [false, true]) {
    const adapter = new RecoveryHeadAdapter({ owner: h.owner, remote: h.remote(), latch: h.latch,
      authorize: async () => { throw new Error('must not send'); }, journal: {
        head: () => h.journal().head(), entryAt: (sequence: number) => {
          const entry = h.journal().entryAt(sequence);
          return sequence === 1 ? corrupt ? { ...entry!, event: canonicalJson({ corrupt: true }) } : null : entry;
        },
      } });
    await assert.rejects(adapter.compare(), { code: 'OPERATION_PENDING' });
  }
  const head = h.journal().head(); h.closeJournal();
  const image = readFileSync(h.journalPath);
  for (const corrupt of [false, true]) {
    const raw = new DatabaseSync(h.journalPath);
    if (corrupt) raw.prepare('UPDATE journal_chain SET event = ? WHERE sequence = ?').run('{}', head.sequence);
    else raw.prepare('DELETE FROM journal_chain WHERE sequence = 1').run();
    raw.close();
    assert.throws(() => h.open(), /ancestry.*corrupt/);
    writeFileSync(h.journalPath, image);
  }
});

test('a lost CAS reply with unchanged or forked remote state never authorizes execution or blind retry', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  const real = h.remote(); let calls = 0;
  await h.restart({}, { ...real, advance: async () => { calls++; throw new Error('request was not accepted'); } });
  await assert.rejects(h.journal().run(h.request()), { code: 'OPERATION_PENDING' });
  assert.equal(calls, 1); assert.equal(await h.effectCount(), 0);
  assert.equal((await h.remote().read())!.sequence, 0);
  await h.restart({}, { ...h.remote(), advance: async (previous: JournalHead, next: JournalHead) => {
    calls++; await h.remote().advance(previous, { ...next, headHash: 'f'.repeat(64) }); throw new Error('competing owner won');
  } });
  await assert.rejects(h.journal().recover(), { code: 'OPERATION_PENDING' });
  assert.equal(calls, 2); assert.equal(await h.effectCount(), 0);
  await h.restart(); await assert.rejects(h.journal().recover(), { code: 'OPERATION_PENDING' });
});

test('read credential cannot publish a tail even if its local authorization callback mistakenly allows it', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  const read = await login(h.host().url, h.email, h.password, { scope: 'read' }); assert.ok(read.ok);
  await h.restart({}, createSnapbackRecoveryRemote(h.connect(read.session)));
  await assert.rejects(h.journal().run(h.request()), { code: 'OPERATION_PENDING' });
  assert.equal(await h.effectCount(), 0); assert.equal((await h.remote().read())!.sequence, 0);
});

test('unknown generation, absent metadata for a nonempty journal, and remote forks are fenced', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().run(h.request());
  const head = (await h.remote().read())!;
  for (const value of [null, { ...head, generation: randomUUID() }, { ...head, headHash: 'a'.repeat(64) },
    { ...head, previousHash: 'b'.repeat(64) }, { ...head, sequence: head.sequence + 1 }]) {
    const adapter = new RecoveryHeadAdapter({ owner: h.owner, journal: h.journal(), latch: h.latch,
      remote: { ...h.remote(), read: async () => value }, authorize: async () => { throw new Error('must not send'); } });
    await assert.rejects(adapter.publish(h.journal().head()), { code: 'OPERATION_PENDING' });
  }
});

test('a fully retained durable tail publishes each known event in order and authorizes every CAS', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  // intentionally withhold publication in fixture setup to exercise multi-event catch-up.
  // the ordinary journal publisher must never permit execution this way.
  await (await h.restart({ publish: async () => undefined })).run(h.request());
  assert.equal(h.journal().head().sequence, 2);
  const real = h.remote(), advanced: number[] = [];
  await h.restart({}, { ...real, advance: async (previous: JournalHead, next: JournalHead) => {
    assert.equal(h.casCount(), advanced.length + 2);
    assert.equal(next.sequence, previous.sequence + 1);
    assert.equal(next.previousHash, previous.headHash);
    advanced.push(next.sequence); return real.advance(previous, next);
  } });
  assert.equal(await h.adapter().compare(), 'unpublished');
  await h.adapter().publish(h.journal().head());
  assert.deepEqual(advanced, [1, 2]);
  assert.equal(await h.adapter().compare(), 'current');
  assert.equal(await h.effectCount(), 1);
  await assert.rejects(h.adapter().publish({ ...h.journal().head(), headHash: 'e'.repeat(64) }), { code: 'OPERATION_PENDING' });
});

test('restore latch refuses placement inside either restored directory and has no automatic reprovisioning', { timeout: 120_000 }, async t => {
  const h = await fixture(t); await h.open().recover();
  for (const root of h.options.restoredDirectories) {
    assert.throws(() => FileRestoreLatch.provisionFresh({ ...h.options, path: join(root, 'latch') }), { code: 'OPERATION_PENDING' });
  }
  h.latch.markRestored();
  assert.throws(() => h.latch.assertReady(), { code: 'OPERATION_PENDING' });
  assert.throws(() => FileRestoreLatch.provisionFresh(h.options), { code: 'EEXIST' });
  assert.throws(() => new FileRestoreLatch(h.options).assertReady(), { code: 'OPERATION_PENDING' });
});
