import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createBoard, createCheckIn, undoCreatedCheckIn } from '../../../src/core/domain/commands';
import type { BoardId, CheckInId, CommandId, LogicalDate } from '../../../src/core/domain/ids';
import { currentLogicalDate } from '../../../src/core/calendar/logical-date';
import { createReward, claimReward } from '../../../src/core/domain/reward-commands';
import { initializeProductDatabase } from '../../../src/core/persistence/bootstrap';
import { OperationJournal, type Failpoint, type JournalOptions, type MutationRequest } from '../src/operations/journal';
import { canonicalJson, sha256, wireIdentity, type CapturedTuple } from '../src/operations/records';
import { deleteOutboxRows } from '../../../src/core/persistence/repositories/support';
import { NodeSqlDatabase } from '../src/storage/sqlite';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};
const ids = { uuid: () => randomUUID() };
const now = Date.UTC(2026, 9, 30, 12);

async function fixture(t: TestContext, kind: 'count' | 'daily' = 'count') {
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-operation-'));
  const productPath = join(directory, 'product.sqlite');
  const journalPath = join(directory, 'journal.sqlite');
  let product = new NodeSqlDatabase(productPath);
  let journal: OperationJournal | undefined;
  t.after(async () => {
    journal?.close();
    await product.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await initializeProductDatabase(product, ids, hashing)).ok, true);
  const deps = () => ({ db: product, ids, hashing, clock: { nowUtcMs: () => now, timeZoneId: () => 'UTC' } });
  const created = await createBoard(deps(), { commandId: randomUUID() as CommandId, title: 'synthetic count',
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, kind, earnsCoins: true, coinCapPerDay: 10 });
  assert.ok(created.ok);
  const boardId = created.value.boardId;
  const open = (overrides: Partial<JournalOptions> = {}) => {
    journal = new OperationJournal({ location: journalPath, accountId: 'synthetic-account', generation: 'synthetic-generation',
      product, nowUtcMs: () => now,
      normalize: async (request, context) => {
        if (request.tool !== 'create_checkin') throw new Error('fixture requires a check-in');
        return { timeZone: request.input.timeZone, command: { tool: 'create_checkin', input: {
          commandId: context.commandId, boardId: request.input.habitId as typeof boardId,
          source: 'app', logicalDate: request.input.logicalDate as LogicalDate | undefined ?? currentLogicalDate(context.nowUtcMs, request.input.timeZone, 0),
          ...(request.input.note === undefined ? {} : { note: request.input.note }),
        } } };
      },
      execute: async intent => {
        const frozenDeps = { ...deps(), clock: { nowUtcMs: () => intent.nowUtcMs, timeZoneId: () => intent.timeZone } };
        if (intent.command.tool === 'create_checkin') return createCheckIn(frozenDeps, intent.command.input);
        if (intent.command.tool === 'undo_checkin') return undoCreatedCheckIn(frozenDeps, intent.command.input);
        return claimReward(frozenDeps, intent.command.input);
      },
      authorize: async () => undefined,
      // this local crash proof is not a remote recovery-head or restore proof.
      publish: async () => undefined,
      ...overrides,
    });
    return journal;
  };
  const request = (): MutationRequest => ({ clientId: 'synthetic-client', tool: 'create_checkin',
    input: { operationId: randomUUID(), habitId: boardId, timeZone: 'UTC' } });
  const restart = async (overrides: Partial<JournalOptions> = {}) => {
    journal?.close();
    await product.closeAsync();
    product = new NodeSqlDatabase(productPath);
    return open(overrides);
  };
  const count = async (table: string) => (await product.getFirstAsync<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))!.count;
  return { open, restart, request, count, deps, boardId, productPath, journalPath, product: () => product };
}

test('lost HTTP result and process restart return the original count effect and exact receipt', async t => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  const h = await fixture(t);
  const request = h.request();
  const original = await h.open().run(request);
  const reopened = await h.restart();
  const replayed = await reopened.run(request);
  assert.equal(await h.count('check_ins'), 1);
  assert.deepEqual(replayed, original);
});

function crashAt(target: Failpoint) {
  return (point: Failpoint) => { if (point === target) throw new Error(`crash:${target}`); };
}
function acceptance(tuple: CapturedTuple) {
  return { record: tuple.record, digest: tuple.digest, disposition: 'accepted' as const, remoteMutationStamp: tuple.record.mutationStamp };
}

for (const point of ['before_prepare', 'after_prepare', 'before_core_commit', 'after_core_commit',
  'before_receipt_capture', 'after_receipt_capture'] as const) {
  test(`count recovery after ${point} retains one effect, causal facts and exact tuple payloads`, async t => {
    const h = await fixture(t);
    const request = h.request();
    const journal = h.open({ failpoint: crashAt(point) });
    await assert.rejects(journal.run(request), new RegExp(`crash:${point}`));
    const committed = ['after_core_commit', 'before_receipt_capture', 'after_receipt_capture'].includes(point);
    assert.equal(await h.count('check_ins'), committed ? 1 : 0);
    const prepared = await journal.get(request.clientId, request.input.operationId);
    const reopened = await h.restart({ nowUtcMs: () => now + 86_400_000,
      ...(prepared ? { normalize: async () => { throw new Error('must reuse frozen defaults'); } } : {}) });
    await reopened.recover();
    const result = await reopened.run(request);
    assert.equal(await h.count('check_ins'), 1);
    assert.equal(await h.count('habit_actions'), 1);
    assert.equal(await h.count('coin_ledger'), 1);
    assert.equal(result.state, 'pending_sync');
    assert.equal(result.delivery, 'pending');
    assert.deepEqual(result.tuples.map(tuple => tuple.record.entityType).sort(), ['check_in', 'habit_action', 'ledger_entry']);
    assert.ok(result.result?.ok);
    assert.equal((result.result.value as { logicalDate: string }).logicalDate, point === 'before_prepare' ? '2026-10-31' : '2026-10-30');
    if (prepared) assert.equal(result.intent.commandId, prepared.intent.commandId);
    const outbox = await h.product().getAllAsync<{ id: number; mutation_stamp: string }>(
      'SELECT id, mutation_stamp FROM mutation_outbox WHERE id > ? ORDER BY id', [result.intent.baselineOutboxId]);
    assert.deepEqual(result.tuples.map(tuple => [tuple.outboxId, tuple.record.mutationStamp]), outbox.map(row => [row.id, row.mutation_stamp]));
    for (const tuple of result.tuples) {
      assert.equal(tuple.record.schemaVersion, 2);
      assert.equal(tuple.payloadHash, sha256(JSON.stringify(tuple.record)));
      assert.equal(tuple.digest, wireIdentity(tuple.record).digest);
    }
    assert.equal((await h.product().getFirstAsync<{ total: number }>('SELECT sum(delta) AS total FROM coin_ledger'))?.total, 1);
  });
}

test('canonical original input fingerprints reject changed arguments and tool before another effect', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const request = h.request();
  const original = await journal.run(request);
  assert.equal(original.intent.fingerprint, sha256(canonicalJson({ accountId: 'synthetic-account', ...request })));
  assert.deepEqual(await journal.run({ ...request, input: Object.fromEntries(Object.entries(request.input).reverse()) } as MutationRequest), original);
  await assert.rejects(journal.run({ ...request, input: { ...request.input, note: '' } } as MutationRequest), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(journal.run({ clientId: request.clientId, tool: 'undo_checkin',
    input: { operationId: request.input.operationId, originalOperationId: randomUUID() } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(await h.count('check_ins'), 1);
  const other = await journal.run({ ...request, clientId: 'another-client' });
  assert.notEqual(other.intent.commandId, original.intent.commandId);
  assert.equal(await h.count('check_ins'), 2);
  assert.equal(await journal.get('unrelated-client', request.input.operationId), null);
});

test('preparation publication failure prevents core execution and later account commands', async t => {
  const h = await fixture(t);
  const journal = h.open({ publish: async head => { if (head.sequence > 0) throw new Error('head unavailable'); } });
  await assert.rejects(journal.run(h.request()), /head unavailable/);
  assert.equal(await h.count('check_ins'), 0);
  assert.equal(journal.head().sequence, 1);
  await assert.rejects(journal.run(h.request()), { code: 'OPERATION_PENDING' });
  await assert.rejects(journal.beforeDelivery(), { code: 'OPERATION_PENDING' });
  await (await h.restart()).recover();
  assert.equal(await h.count('check_ins'), 1);
});

test('prepared recovery without a receipt revalidates permission; receipt recovery never executes again', async t => {
  const h = await fixture(t);
  const request = h.request();
  await assert.rejects(h.open({ failpoint: crashAt('after_prepare') }).run(request), /crash:after_prepare/);
  const denied = await h.restart({ authorize: async (_intent, action) => { if (action === 'execute') throw new Error('revoked'); } });
  await assert.rejects(denied.recover(), /revoked/);
  assert.equal(await h.count('check_ins'), 0);
  const committing = await h.restart({ failpoint: crashAt('after_core_commit') });
  await assert.rejects(committing.recover(), /crash:after_core_commit/);
  const recovering = await h.restart({ execute: async () => { throw new Error('must recover the receipt'); },
    authorize: async (_intent, action) => { if (action === 'execute' || action === 'read') throw new Error('revoked'); } });
  await recovering.recover();
  assert.equal(await h.count('check_ins'), 1);
  await assert.rejects(recovering.run(request), /revoked/);
});

test('daily already checked is a durable no-op with no undo entitlement', async t => {
  const h = await fixture(t, 'daily');
  const journal = h.open();
  const actual = await journal.run(h.request());
  const request = h.request();
  const noop = await journal.run(request);
  assert.equal(noop.state, 'completed_no_mutation');
  assert.equal(noop.delivery, 'not_required');
  assert.deepEqual(noop.tuples, []);
  assert.ok(noop.result?.ok);
  assert.equal((noop.result.value as { created: boolean }).created, false);
  await assert.rejects(journal.undoTarget(request.clientId, request.input.operationId), { code: 'CONFLICT' });
  assert.equal((await journal.undoTarget(actual.intent.clientId, actual.intent.operationId)).createdByCommandId, actual.intent.commandId);
  assert.equal(await h.count('check_ins'), 1);
  assert.equal(await h.count('habit_actions'), 1);
  assert.equal(await h.count('coin_ledger'), 1);
  const replayed = await (await h.restart()).run(request);
  assert.deepEqual(replayed, noop);
});

test('core rejection is retained with its fingerprint and does not acquire delivery evidence', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const request = h.request();
  request.input = { ...request.input, habitId: randomUUID() } as typeof request.input;
  const rejected = await journal.run(request);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.delivery, 'not_required');
  assert.equal(rejected.result?.ok, false);
  assert.deepEqual(rejected.tuples, []);
  assert.deepEqual(await (await h.restart()).run(request), rejected);
  assert.equal(await h.count('check_ins'), 0);
});

test('partial upload persists exact acceptance but cannot acknowledge the whole operation or clear unknown rows', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const request = h.request();
  const result = await journal.run(request);
  const [visible, ...facts] = result.tuples;
  assert.equal(visible.record.entityType, 'check_in');
  await journal.beforeDelivery();
  assert.equal(await journal.recordUploadAcceptance(acceptance(visible)), 1);
  await journal.beforeQueueClear([visible.outboxId]);
  await deleteOutboxRows(h.product(), [visible.outboxId]);
  journal.afterQueueClear();
  const reopened = await h.restart();
  assert.equal((await reopened.get(request.clientId, request.input.operationId))?.state, 'pending_sync');
  await assert.rejects(reopened.beforeQueueClear(facts.map(tuple => tuple.outboxId)), { code: 'OPERATION_PENDING' });
  await assert.rejects(reopened.recordUploadAcceptance({ ...acceptance(facts[0]), disposition: 'unknown' as never }), { code: 'OPERATION_PENDING' });
  await assert.rejects(reopened.recordUploadAcceptance({ ...acceptance(facts[0]), digest: 'f'.repeat(64) }), { code: 'OPERATION_PENDING' });
  for (const fact of facts) assert.equal(await reopened.recordUploadAcceptance(acceptance(fact)), 1);
  const acknowledged = await reopened.get(request.clientId, request.input.operationId);
  assert.equal(acknowledged?.state, 'backend_acknowledged');
  assert.equal(acknowledged?.delivery, 'acknowledged');
  assert.deepEqual(acknowledged?.result, result.result);
});

for (const point of ['before_ack', 'after_ack', 'before_queue_clear', 'after_queue_clear'] as const) {
  test(`delivery restart after ${point} retains acceptance before queue deletion`, async t => {
    const h = await fixture(t);
    const request = h.request();
    const journal = h.open({ failpoint: crashAt(point) });
    const original = await journal.run(request);
    await assert.rejects((async () => {
      for (const tuple of original.tuples) await journal.recordUploadAcceptance(acceptance(tuple));
      await journal.beforeQueueClear(original.tuples.map(tuple => tuple.outboxId));
      await deleteOutboxRows(h.product(), original.tuples.map(tuple => tuple.outboxId));
      journal.afterQueueClear();
    })(), new RegExp(`crash:${point}`));
    const reopened = await h.restart();
    const intermediate = await reopened.get(request.clientId, request.input.operationId);
    assert.equal(intermediate?.tuples[0].disposition, point === 'before_ack' ? null : 'accepted');
    for (const tuple of original.tuples) await reopened.recordUploadAcceptance(acceptance(tuple));
    await reopened.beforeQueueClear(original.tuples.map(tuple => tuple.outboxId));
    await deleteOutboxRows(h.product(), original.tuples.map(tuple => tuple.outboxId));
    const recovered = await reopened.run(request);
    assert.equal(recovered.state, 'backend_acknowledged');
    assert.equal(recovered.delivery, 'acknowledged');
    assert.deepEqual(recovered.result, original.result);
    assert.equal(await h.count('check_ins'), 1);
  });
}

for (const point of ['before_prepare', 'before_prepare_commit', 'after_prepare', 'before_core_commit', 'after_core_commit',
  'before_receipt_capture', 'before_capture_commit', 'after_receipt_capture'] as const) {
  test(`real reward claim recovery after ${point} spends once and retains its original ledger receipt`, async t => {
    const h = await fixture(t);
    assert.equal((await createCheckIn(h.deps(), { commandId: randomUUID() as CommandId, boardId: h.boardId, source: 'app' })).ok, true);
    const reward = await createReward(h.deps(), { commandId: randomUUID() as CommandId, title: 'synthetic tea',
      costCoins: 1, symbol: 'star.fill', accentHex: '#70A7FF' });
    assert.ok(reward.ok, JSON.stringify(reward));
    const stamp = (await h.product().getFirstAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM rewards WHERE id = ?', [reward.value.rewardId]))!.mutation_stamp;
    const normalize: JournalOptions['normalize'] = async (request, context) => {
      assert.equal(request.tool, 'claim_reward');
      return { timeZone: 'UTC', command: { tool: 'claim_reward', input: { commandId: context.commandId,
        rewardId: reward.value.rewardId, expectedMutationStamp: stamp } } };
    };
    const request: MutationRequest = { clientId: 'synthetic-client', tool: 'claim_reward',
      input: { operationId: randomUUID(), confirmationToken: 'synthetic-approved-quote-token-for-local-proof-only' } };
    const journal = h.open({ normalize, failpoint: crashAt(point) });
    await assert.rejects(journal.run(request), new RegExp(`crash:${point}`));
    const prepared = await journal.get(request.clientId, request.input.operationId);
    const reopened = await h.restart({ normalize: prepared ? async () => { throw new Error('must reuse admitted reward and stamp'); } : normalize });
    await reopened.recover();
    const result = await reopened.run(request);
    assert.equal((await h.product().getFirstAsync<{ count: number }>("SELECT count(*) AS count FROM coin_ledger WHERE kind = 'claim'"))?.count, 1);
    assert.equal((await h.product().getFirstAsync<{ balance: number }>('SELECT sum(delta) AS balance FROM coin_ledger'))?.balance, 0);
    assert.ok(result.result?.ok);
    const value = result.result.value as { ledgerEntryId: string; costCoins: number; balance: number; titleSnapshot: string };
    assert.equal(value.costCoins, 1);
    assert.equal(value.balance, 0);
    assert.equal(value.titleSnapshot, 'synthetic tea');
    assert.equal(result.tuples.length, 1);
    assert.equal(result.tuples[0].record.entityType, 'ledger_entry');
    assert.equal(result.tuples[0].record.entityId, value.ledgerEntryId);
    assert.equal(result.tuples[0].record.fields.delta, -1);
    assert.deepEqual((await reopened.run(request)).result, result.result);
  });
}

test('actual undo journals tombstone, action and ledger reversal without losing the original create result', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const original = await journal.run(h.request());
  const target = await journal.undoTarget(original.intent.clientId, original.intent.operationId);
  const undoRequest: MutationRequest = { clientId: original.intent.clientId, tool: 'undo_checkin',
    input: { operationId: randomUUID(), originalOperationId: original.intent.operationId } };
  const reopened = await h.restart({ normalize: async (_request, context) => ({ timeZone: 'UTC',
    command: { tool: 'undo_checkin', input: { commandId: context.commandId, ...target } } }) });
  const undone = await reopened.run(undoRequest);
  assert.ok(undone.result?.ok);
  assert.deepEqual(undone.tuples.map(tuple => tuple.record.entityType).sort(), ['check_in', 'habit_action', 'ledger_entry']);
  const tombstone = undone.tuples.find(tuple => tuple.record.entityType === 'check_in')!;
  assert.equal(tombstone.record.deleted, true);
  assert.equal(tombstone.record.fields.note, null);
  assert.equal((await h.product().getFirstAsync<{ balance: number }>('SELECT sum(delta) AS balance FROM coin_ledger'))?.balance, 0);
  assert.equal(await h.count('habit_actions'), 2);
  assert.deepEqual((await reopened.get(original.intent.clientId, original.intent.operationId))?.result, original.result);
  assert.deepEqual((await (await h.restart()).run(undoRequest)).result, undone.result);
  assert.equal(await h.count('habit_actions'), 2);
  assert.equal((await h.product().getFirstAsync<{ count: number }>("SELECT count(*) AS count FROM coin_ledger WHERE kind = 'reversal'"))?.count, 1);
});

test('newer accepted mutable tuple settles an older local tuple only as superseded; immutable facts still need delivery', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const original = await journal.run(h.request());
  const target = await journal.undoTarget(original.intent.clientId, original.intent.operationId);
  const reopened = await h.restart({ normalize: async (_request, context) => ({ timeZone: 'UTC',
    command: { tool: 'undo_checkin', input: { commandId: context.commandId, ...target } } }) });
  const undone = await reopened.run({ clientId: original.intent.clientId, tool: 'undo_checkin',
    input: { operationId: randomUUID(), originalOperationId: original.intent.operationId } });
  const tombstone = undone.tuples.find(tuple => tuple.record.entityType === 'check_in')!;
  assert.equal(await reopened.recordUploadAcceptance(acceptance(tombstone)), 2);
  const partial = await reopened.get(original.intent.clientId, original.intent.operationId);
  assert.equal(partial?.state, 'pending_sync');
  assert.equal(partial?.tuples[0].disposition, 'superseded');
  for (const fact of original.tuples.filter(tuple => tuple.record.entityType !== 'check_in')) {
    await assert.rejects(reopened.recordUploadAcceptance({ ...acceptance(fact), disposition: 'superseded',
      remoteMutationStamp: tombstone.record.mutationStamp }), { code: 'OPERATION_PENDING' });
    await reopened.recordUploadAcceptance(acceptance(fact));
  }
  const delivered = await reopened.get(original.intent.clientId, original.intent.operationId);
  assert.equal(delivered?.state, 'backend_acknowledged');
  assert.equal(delivered?.delivery, 'superseded');
  assert.deepEqual(delivered?.result, original.result);
});

test('same-stamp payload mismatch or unknown remote disposition refuses queue-clearing callback completion', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const original = await journal.run(h.request());
  const visible = original.tuples[0];
  const record = { ...visible.record, fields: { ...visible.record.fields, note: 'different payload' } };
  await assert.rejects(journal.recordUploadAcceptance({ ...acceptance(visible), record, digest: wireIdentity(record).digest }), { code: 'OPERATION_PENDING' });
  await assert.rejects(journal.beforeQueueClear([visible.outboxId]), { code: 'OPERATION_PENDING' });
  const newer = '99999999999999-00000-synthetic';
  await assert.rejects(journal.recordUploadAcceptance({ ...acceptance(visible), record, digest: wireIdentity(record).digest,
    disposition: 'superseded', remoteMutationStamp: newer }), { code: 'OPERATION_PENDING' });
  assert.equal(await journal.recordUploadAcceptance({ ...acceptance(visible), disposition: 'superseded', remoteMutationStamp: newer }), 1);
  assert.equal((await journal.get(original.intent.clientId, original.intent.operationId))?.tuples[0].disposition, 'superseded');
  assert.equal((await journal.get(original.intent.clientId, original.intent.operationId))?.state, 'pending_sync');
});

test('multipart Unicode note uses full payload hash and the actual transport multipart digest separately', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const request = h.request();
  assert.equal(request.tool, 'create_checkin');
  if (request.tool !== 'create_checkin') throw new Error('check-in fixture');
  request.input.note = '漢'.repeat(9000);
  const operation = await journal.run(request);
  const tuple = operation.tuples.find(tuple => tuple.record.entityType === 'check_in')!;
  const payload = JSON.stringify(tuple.record);
  const scalars = [...payload];
  const parts: string[] = [];
  for (let offset = 0; offset < scalars.length; offset += 8192) parts.push(scalars.slice(offset, offset + 8192).join(''));
  assert.ok(parts.length > 1);
  assert.equal(tuple.payloadHash, sha256(payload));
  assert.notEqual(tuple.digest, tuple.payloadHash);
  assert.equal(tuple.digest, parts.reduce((hash, part) => sha256(hash + sha256(part)), ''));
  assert.equal(await journal.recordUploadAcceptance(acceptance(tuple)), 1);
});

for (const point of ['before_prepare_commit', 'before_capture_commit', 'before_ack_commit'] as const) {
  test(`${point} rolls back the operation/evidence update and its chain entry together`, async t => {
    const h = await fixture(t);
    const request = h.request();
    const journal = h.open({ failpoint: crashAt(point) });
    if (point === 'before_ack_commit') {
      const result = await journal.run(request);
      assert.equal(journal.head().sequence, 2);
      await assert.rejects(journal.recordUploadAcceptance(acceptance(result.tuples[0])), /crash:before_ack_commit/);
      assert.equal(journal.head().sequence, 2);
      assert.equal((await journal.get(request.clientId, request.input.operationId))?.tuples[0].disposition, null);
    } else {
      await assert.rejects(journal.run(request), new RegExp(`crash:${point}`));
      assert.equal(journal.head().sequence, point === 'before_prepare_commit' ? 0 : 1);
      const operation = await journal.get(request.clientId, request.input.operationId);
      assert.equal(operation?.state ?? null, point === 'before_prepare_commit' ? null : 'prepared');
      assert.deepEqual(operation?.tuples ?? [], []);
    }
    const reopened = await h.restart();
    await reopened.recover();
    assert.equal((await reopened.run(request)).state, 'pending_sync');
    assert.equal(await h.count('check_ins'), 1);
  });
}

test('chain ancestry binds every durable transition and refuses corrupt ancestry without resetting', async t => {
  const h = await fixture(t);
  const journal = h.open();
  const result = await journal.run(h.request());
  await journal.recordUploadAcceptance(acceptance(result.tuples[0]));
  assert.equal(journal.head().sequence, 3);
  assert.equal(journal.entryAt(0)?.headHash, '0'.repeat(64));
  for (let sequence = 1; sequence <= journal.head().sequence; sequence++) {
    const entry = journal.entryAt(sequence)!;
    assert.equal(entry.previousHash, journal.entryAt(sequence - 1)!.headHash);
    assert.equal(entry.headHash, sha256(canonicalJson({ generation: entry.generation, sequence,
      previousHash: entry.previousHash, event: entry.event })));
  }
  const head = journal.head();
  assert.deepEqual((await h.restart()).head(), head);
  const raw = new DatabaseSync(h.journalPath);
  raw.prepare("UPDATE journal_chain SET event = '{}' WHERE sequence = 2").run();
  raw.close();
  await assert.rejects(h.restart(), /ancestry.*corrupt/);
});

test('publication observes durable prepared and captured ancestry; capture publication loss never permits another effect', async t => {
  const h = await fixture(t);
  const request = h.request();
  const journal = h.open({ publish: async head => {
    const observed = new DatabaseSync(h.journalPath);
    try {
      assert.equal(Number(observed.prepare('SELECT coalesce(max(sequence), 0) AS sequence FROM journal_chain').get()!.sequence), head.sequence);
      if (head.sequence === 1) assert.equal(await h.count('check_ins'), 0);
      if (head.sequence === 2) throw new Error('lost captured head response');
    } finally { observed.close(); }
  } });
  await assert.rejects(journal.run(request), /lost captured head response/);
  assert.equal(await h.count('check_ins'), 1);
  const reopened = await h.restart({ execute: async () => { throw new Error('must replay the result'); } });
  const result = await reopened.run(request);
  assert.ok(result.result?.ok);
  assert.equal(await h.count('check_ins'), 1);
});

test('real core receipt insertion failure rolls back all product writes and retains the same prepared command', async t => {
  const h = await fixture(t);
  const request = h.request();
  await h.product().execAsync("CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END");
  const journal = h.open();
  await assert.rejects(journal.run(request), { code: 'OPERATION_PENDING' });
  const prepared = await journal.get(request.clientId, request.input.operationId);
  assert.equal(await h.count('check_ins'), 0);
  assert.equal(await h.count('habit_actions'), 0);
  assert.equal(await h.count('coin_ledger'), 0);
  await h.product().execAsync('DROP TRIGGER fail_receipt');
  const reopened = await h.restart();
  await reopened.recover();
  assert.equal((await reopened.run(request)).intent.commandId, prepared?.intent.commandId);
  assert.equal(await h.count('check_ins'), 1);
});

test('changed mutable evidence before capture fails closed and retains prepared intent', async t => {
  const h = await fixture(t);
  const request = h.request();
  const journal = h.open({ failpoint: crashAt('after_core_commit') });
  await assert.rejects(journal.run(request), /crash:after_core_commit/);
  const prepared = await journal.get(request.clientId, request.input.operationId);
  const row = (await h.product().getFirstAsync<{ id: string }>('SELECT id FROM check_ins'))!;
  // deliberately violate the account lane contract to prove identifiable interference is refused.
  assert.equal((await undoCreatedCheckIn(h.deps(), { commandId: randomUUID() as CommandId,
    checkInId: row.id as CheckInId, createdByCommandId: prepared!.intent.commandId })).ok, true);
  const reopened = await h.restart();
  await assert.rejects(reopened.recover(), /changed before capture/);
  assert.equal((await reopened.get(request.clientId, request.input.operationId))?.state, 'prepared');
  await assert.rejects(reopened.beforeQueueClear([]), { code: 'OPERATION_PENDING' });
});

test('journal refuses a product database, wrong account, changed generation, unknown schema and omitted publisher', async t => {
  const h = await fixture(t);
  h.open();
  await assert.rejects(h.restart({ accountId: 'other-account' }), /binding mismatch/);
  // restart may fail before replacing the closed handle, so construct directly for refusal probes.
  const options = { location: h.journalPath, accountId: 'synthetic-account', generation: 'synthetic-generation',
    product: h.product(), nowUtcMs: () => now, normalize: async () => { throw new Error('not reached'); },
    execute: async () => { throw new Error('not reached'); }, authorize: async () => undefined, publish: async () => undefined };
  assert.throws(() => new OperationJournal({ ...options, generation: 'other-generation' }), /binding mismatch/);
  assert.throws(() => new OperationJournal({ ...options, location: h.productPath }), /unknown journal schema or product database/);
  assert.throws(() => new OperationJournal({ ...options, publish: undefined as never }), /publication.*required/);
  const raw = new DatabaseSync(h.journalPath);
  raw.exec('PRAGMA user_version = 2');
  assert.throws(() => new OperationJournal(options), /schema.*mismatch/);
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 2);
  raw.close();
});

test('hard process crash after core commit recovers the original effect without a graceful SQLite close', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  if (process.env.M04_CRASH_PRODUCT) {
    const product = new NodeSqlDatabase(process.env.M04_CRASH_PRODUCT);
    const request = JSON.parse(process.env.M04_CRASH_REQUEST!) as MutationRequest;
    const journal = new OperationJournal({ location: process.env.M04_CRASH_JOURNAL!, product,
      accountId: 'synthetic-account', generation: 'synthetic-generation', nowUtcMs: () => now,
      normalize: async (input, context) => {
        if (input.tool !== 'create_checkin') throw new Error('check-in worker');
        return { timeZone: input.input.timeZone, command: { tool: 'create_checkin', input: {
          commandId: context.commandId, boardId: input.input.habitId as BoardId, source: 'app',
          logicalDate: currentLogicalDate(context.nowUtcMs, input.input.timeZone, 0),
        } } };
      },
      execute: async intent => {
        if (intent.command.tool !== 'create_checkin') throw new Error('check-in worker');
        return createCheckIn({ db: product, ids, hashing, clock: { nowUtcMs: () => intent.nowUtcMs, timeZoneId: () => intent.timeZone } }, intent.command.input);
      },
      authorize: async () => undefined, publish: async () => undefined,
      failpoint: point => { if (point === 'after_core_commit') process.kill(process.pid, 'SIGKILL'); },
    });
    await journal.run(request);
    throw new Error('worker did not reach crash point');
  }
  const h = await fixture(t);
  const request = h.request();
  const child = spawnSync(process.execPath, ['--test-name-pattern=^hard process crash', fileURLToPath(import.meta.url)], {
    env: { ...process.env, M04_CRASH_PRODUCT: h.productPath, M04_CRASH_JOURNAL: h.journalPath,
      M04_CRASH_REQUEST: JSON.stringify(request) }, timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr + child.stdout);
  assert.equal(await h.count('check_ins'), 1);
  const reopened = await h.restart({ execute: async () => { throw new Error('must use durable receipt'); } });
  await reopened.recover();
  const result = await reopened.run(request);
  assert.equal(result.state, 'pending_sync');
  assert.equal(result.tuples.length, 3);
  assert.equal(await h.count('check_ins'), 1);
  assert.equal(await h.count('coin_ledger'), 1);
});
