import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { signup, login } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe } from 'snapback4/proof';

import { api } from '../../../snapback/generated/api.ts';
import { AccountActors } from '../src/accounts/actor';
import { ensureDeliveryHistory } from '../src/accounts/operations';
import { AccountReplica } from '../src/accounts/replica';
import type { AuthContext } from '../src/auth/context';
import { OperationJournal, GENESIS_HASH } from '../src/operations/journal';
import { FileRestoreLatch } from '../src/operations/recovery-head';
import { canonicalJson, sha256 } from '../src/operations/records';

const count = 9_800;

test('near-limit retained history read measures cold and repeat admission through the real sdk', { timeout: 120_000 }, async t => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  const root = mkdtempSync(join(tmpdir(), 'mcp-history-performance-'));
  const backend = join(root, 'backend'), logs = join(root, 'logs'), local = join(root, 'accounts'), external = join(root, 'external');
  mkdirSync(local, { mode: 0o700 }); mkdirSync(external, { mode: 0o700 });
  assert.equal((await deploy(backend, resolve('snapback/schema.q'), { logsDir: logs })).code, 0);
  const host = await startServe(backend, { logsDir: logs });
  t.after(async () => { await host.stop(); rmSync(root, { recursive: true, force: true }); });
  const email = `${randomUUID()}@example.test`, password = randomUUID();
  const signed = await signup(host.url, email, password, { timeoutMs: 2000 }); assert.ok(signed.ok);
  const narrowed = await login(host.url, email, password, { scope: 'read', timeoutMs: 2000 }); assert.ok(narrowed.ok);
  const accountId = randomUUID(), clientId = randomUUID(), grantId = randomUUID();
  const context: AuthContext = { accountId, clientId, grantId, principal: narrowed.session.principal,
    backendUrl: host.url, session: narrowed.session, scopes: ['habits:read'], assertActive: async () => undefined };
  const latchOptions = { path: join(external, 'restore-latch'), installationId: randomUUID(),
    restoredDirectories: [local, backend] as const };
  FileRestoreLatch.provisionFresh(latchOptions);
  const latch = new FileRestoreLatch(latchOptions);
  const replica = new AccountReplica(local, host.url, context, { maxAccountBytes: 256 * 1024 * 1024, minFreeBytes: 1024 * 1024 });
  const generation = await (async () => {
    await ensureDeliveryHistory(replica.directory, context, replica.db, replica);
    const sidecar = new DatabaseSync(join(replica.directory, 'operations.sqlite'));
    try {
      const value = String(sidecar.prepare('SELECT generation FROM runtime_meta WHERE id = 1').get()!.generation);
      sidecar.prepare('UPDATE runtime_meta SET journal_ready = 1 WHERE id = 1').run();
      return value;
    } finally { sidecar.close(); }
  })();
  const journal = new OperationJournal({ location: join(replica.directory, 'journal.sqlite'), accountId, generation,
    product: replica.db, nowUtcMs: () => Date.now(),
    normalize: async () => { throw new Error('benchmark history is already captured'); },
    execute: async () => { throw new Error('benchmark history must never execute'); },
    authorize: async () => undefined, publish: async () => undefined });
  journal.close();
  chmodSync(join(replica.directory, 'journal.sqlite'), 0o600);
  const origins = new DatabaseSync(join(replica.directory, 'operations.sqlite'));
  const history = new DatabaseSync(join(replica.directory, 'journal.sqlite'));
  let sequence = 0, previousHash = GENESIS_HASH, priorHash = GENESIS_HASH;
  try {
    origins.exec('BEGIN IMMEDIATE'); history.exec('BEGIN IMMEDIATE');
    const insertOrigin = origins.prepare('INSERT INTO operation_grants VALUES (?, ?, ?, ?)');
    const insertOperation = history.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertEvent = history.prepare('INSERT INTO journal_chain VALUES (?, ?, ?, ?)');
    const result = { ok: false, error: { code: 'NOT_FOUND', message: 'synthetic rejected command' } };
    for (let index = 0; index < count; index++) {
      const operationId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      const commandId = `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      const fingerprint = sha256(canonicalJson({ accountId, clientId, operationId }));
      const intent = { accountId, clientId, operationId, tool: 'create_checkin', fingerprint, commandId,
        nowUtcMs: 1_760_000_000_000, timeZone: 'UTC', baselineOutboxId: 0,
        command: { tool: 'create_checkin', input: { commandId, boardId: randomUUID(), logicalDate: '2026-10-30', source: 'app' } } };
      insertOrigin.run(clientId, operationId, grantId, 'create_checkin');
      insertOperation.run(clientId, operationId, fingerprint, JSON.stringify(intent), JSON.stringify(result), 'rejected', 'not_required');
      for (const event of [{ kind: 'prepared', intent }, { kind: 'captured', clientId, operationId, result, tuples: [] }]) {
        const encoded = canonicalJson(event);
        sequence++;
        priorHash = previousHash;
        previousHash = sha256(canonicalJson({ generation, sequence, previousHash, event: encoded }));
        insertEvent.run(sequence, priorHash, previousHash, encoded);
      }
    }
    history.exec('COMMIT'); origins.exec('COMMIT');
  } catch (cause) {
    try { history.exec('ROLLBACK'); } catch { /* transaction already ended. */ }
    try { origins.exec('ROLLBACK'); } catch { /* transaction already ended. */ }
    throw cause;
  } finally { history.close(); origins.close(); await replica.close(); }
  const admin = createClient({ url: host.url, token: signed.session.token });
  try {
    const initial = await admin.mutate(api.initializeMcpRecoveryHead, { generation });
    assert.equal(initial.state, 'sent');
    assert.ok(initial.result);
    const store = new DatabaseSync(join(backend, 'store.sqlite'));
    try {
      const table = Number(store.prepare("SELECT num FROM _catalog WHERE name = 'mcpRecoveryHeads'").get()!.num);
      const id = initial.result.id;
      const row = store.prepare('SELECT data FROM r WHERE t = ? AND id = ?').get(table, id);
      assert.ok(row);
      const encoded = JSON.parse(String(row.data)) as { Row: Record<string, { Int?: number; String?: string }> };
      encoded.Row.sequence.Int = sequence;
      encoded.Row.previousHash.String = priorHash;
      encoded.Row.headHash.String = previousHash;
      assert.equal(store.prepare('UPDATE r SET data = ? WHERE t = ? AND id = ?').run(JSON.stringify(encoded), table, id).changes, 1);
    } finally { store.close(); }
    const observed = await admin.query(api.mcpRecoveryHead, {});
    assert.ok('data' in observed && observed.data);
    assert.equal(observed.data.sequence, 2 * count);
  } finally { await admin.close(); }

  let started = 0, firstPullAt = 0, networkMs = 0, admissionNetworkMs = 0, fetches = 0;
  const wrappedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    const at = performance.now();
    if (path === '/q/changes' && firstPullAt === 0) firstPullAt = at;
    const response = await fetch(request);
    const elapsed = performance.now() - at;
    networkMs += elapsed; fetches++;
    if (firstPullAt === 0) admissionNetworkMs += elapsed;
    return response;
  };
  const options = { root: local, backendUrl: host.url, minFreeBytes: 1024 * 1024, requestTimeoutMs: 60_000,
    fetch: wrappedFetch, operationPolicy: { latch, authorize: async () => undefined,
      normalize: async () => { throw new Error('benchmark must not normalize'); } } };
  const measure = async (phase: string, actor: AccountActors) => {
    started = performance.now(); firstPullAt = 0; networkMs = 0; admissionNetworkMs = 0; fetches = 0;
    const observed = await actor.withAccount(context, {}, async runtime => ({ recovery: runtime.recovery,
      count: Number((await runtime.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins'))!.n) }));
    const totalMs = performance.now() - started, admissionMs = firstPullAt - started;
    assert.equal(observed.data.count, 0);
    assert.equal(observed.data.recovery.writeFenced, true);
    assert.ok(firstPullAt > started);
    assert.ok(admissionMs < 15_000, 'retained-history read admission exceeded the default request deadline');
    const metrics = { phase, operations: count, chainEvents: sequence, totalMs: Math.round(totalMs),
      admissionMs: Math.round(admissionMs), admissionNetworkMs: Math.round(admissionNetworkMs),
      localAdmissionMs: Math.round(admissionMs - admissionNetworkMs), networkMs: Math.round(networkMs), fetches };
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    return metrics;
  };
  const actor = new AccountActors(options);
  try { await measure('cold', actor); await measure('repeat', actor); }
  finally { await actor.close(); }
  const restarted = new AccountActors(options);
  try {
    await measure('restart', restarted);
    const altered = new DatabaseSync(join(replica.directory, 'operations.sqlite'));
    try {
      const firstId = '00000000-0000-4000-8000-000000000000';
      assert.equal(altered.prepare("UPDATE operation_grants SET tool = 'undo_checkin' WHERE operation_id = ?")
        .run(firstId).changes, 1);
    } finally { altered.close(); }
    firstPullAt = 0;
    await assert.rejects(restarted.withAccount(context, {}, async () => 'unsafe'), { code: 'OPERATION_PENDING' });
    assert.equal(firstPullAt, 0);
  }
  finally { await restarted.close(); }
});
