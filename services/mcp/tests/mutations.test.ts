import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createBoard, updateBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { AuthContext } from '../src/auth/context';
import { createCheckIn, createCorePorts, initializeProductDatabase, NodeSqlDatabase, undoCreatedCheckIn } from '../src/core';
import { OperationJournal, type MutationRequest } from '../src/operations/journal';
import { createMutationNormalizer } from '../src/tools/normalize';
import { MutationTools } from '../src/tools/mutations';
import { operationSchema, type Metadata } from '../src/tools/contracts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-mutation-tools-'));
  const db = new NodeSqlDatabase(join(directory, 'product.sqlite'));
  let now = Date.parse('2026-11-02T12:00:00Z');
  const ports = createCorePorts('UTC', now);
  assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
  const ctx: AuthContext = { accountId: randomUUID(), clientId: randomUUID(), grantId: randomUUID(),
    principal: 'synthetic-principal', backendUrl: 'https://synthetic.test', scopes: ['habits:read', 'checkins:write'],
    session: { principal: 'synthetic-principal', token: 'synthetic-never-sent', kind: 'user', scope: 'full', expiresAt: now + 86_400_000 },
    assertActive: async () => {} };
  const metadata: Metadata = { observedAtUtc: now, lastCompletedPullAtUtc: now, backendRevision: 'synthetic',
    syncStatus: 'up_to_date', pendingLocalDeliveries: 0, admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
  const normalize = createMutationNormalizer();
  const journal: OperationJournal = new OperationJournal({ location: join(directory, 'journal.sqlite'), product: db,
    accountId: ctx.accountId, generation: randomUUID(), nowUtcMs: () => now, authorize: async () => {}, publish: async () => {},
    normalize: (request, frozen) => normalize(request, { ...frozen, context: ctx, read: db,
      undoTarget: async id => {
        const target = await journal.undoTarget(ctx.clientId, id), original = await journal.get(ctx.clientId, id);
        return { ...target, timeZone: original!.intent.timeZone };
      } }),
    execute: intent => {
      const deps = { db, ...createCorePorts(intent.timeZone, intent.nowUtcMs) };
      if (intent.command.tool === 'create_checkin') return createCheckIn(deps, intent.command.input);
      if (intent.command.tool === 'undo_checkin') return undoCreatedCheckIn(deps, intent.command.input);
      throw new Error('claim execution is not enabled');
    } });
  const tools = new MutationTools({ accounts: {
    runOperation: async (_context, request) => ({ data: await journal.run(request), meta: metadata }),
    lookupOperation: async (_context, id) => ({ data: await journal.get(ctx.clientId, id), meta: metadata }),
  } });
  const board = async (changes: Partial<Parameters<typeof createBoard>[1]> = {}) => {
    const result = await createBoard({ db, ...ports }, { commandId: randomUUID() as CommandId, title: 'synthetic habit',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
      startOfDayMinute: 0, metricsEnabled: true, kind: 'count', ...changes });
    assert.ok(result.ok); return result.value.boardId;
  };
  const create = (habitId: string, changes: Record<string, unknown> = {}) => tools.invoke('create_checkin',
    { operationId: randomUUID(), habitId, timeZone: 'UTC', ...changes }, ctx);
  t.after(async () => { journal.close(); await db.closeAsync(); rmSync(directory, { recursive: true, force: true }); });
  return { db, ctx, journal, tools, board, create, setNow: (value: number) => { now = value; } };
}

test('real core receipts return bounded public operations, freeze defaults and replay across midnight', async t => {
  const h = await fixture(t), habitId = await h.board({ tracksAmount: true, quickAmount: 7.5 });
  const operationId = randomUUID(), input = { operationId, habitId, timeZone: 'Asia/Tokyo', note: ' synthetic note ' };
  const first = await h.tools.invoke('create_checkin', input, h.ctx);
  assert.equal(first.data.state, 'pending_sync'); assert.equal(first.data.delivery, 'pending');
  assert.deepEqual(first.data.result, { checkinId: (first.data.result as { checkinId: string }).checkinId,
    habitId, logicalDate: '2026-11-02', created: true });
  const original = await h.journal.get(h.ctx.clientId, operationId); assert.ok(original);
  assert.equal(original.intent.command.tool, 'create_checkin');
  if (original.intent.command.tool === 'create_checkin') assert.equal(original.intent.command.input.amount, 7.5);
  h.setNow(Date.parse('2026-11-04T12:00:00Z'));
  const current = await h.db.getFirstAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM boards WHERE id = ?', [habitId]);
  assert.ok(current);
  assert.ok((await updateBoard({ db: h.db, ...createCorePorts('UTC', Date.parse('2026-11-04T12:00:00Z')) }, { commandId: randomUUID() as CommandId,
    boardId: habitId, expectedMutationStamp: current.mutation_stamp, title: 'synthetic habit', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: true, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, quickAmount: 99 })).ok);
  assert.deepEqual((await h.tools.invoke('create_checkin', input, h.ctx)).data, first.data);
  assert.deepEqual((await h.tools.invoke('get_operation', { operationId }, h.ctx)).data, first.data);
  assert.equal((await h.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins'))!.n, 1);
  const serialized = JSON.stringify(first);
  for (const secret of ['synthetic note', 'fingerprint', 'tuples', 'commandId', h.ctx.grantId, h.ctx.accountId]) assert.ok(!serialized.includes(secret));
  await assert.rejects(h.tools.invoke('create_checkin', { ...input, amount: 8 }, h.ctx), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.ok(operationSchema.safeParse(first.data).success);
});

test('daily creation is deliberate and undo targets only an actual created operation', async t => {
  const h = await fixture(t), habitId = await h.board({ kind: 'daily' });
  const first = await h.create(habitId), noop = await h.create(habitId);
  assert.equal((first.data.result as { created: boolean }).created, true);
  assert.equal((noop.data.result as { created: boolean }).created, false);
  assert.equal(noop.data.state, 'completed_no_mutation');
  await assert.rejects(h.tools.invoke('undo_checkin', { operationId: randomUUID(), originalOperationId: noop.data.operationId }, h.ctx), { code: 'CONFLICT' });
  const input = { operationId: randomUUID(), originalOperationId: first.data.operationId };
  const undone = await h.tools.invoke('undo_checkin', input, h.ctx);
  assert.deepEqual(undone.data.result, { checkinId: (first.data.result as { checkinId: string }).checkinId, undone: true });
  assert.deepEqual((await h.tools.invoke('undo_checkin', input, h.ctx)).data, undone.data);
  assert.equal((await h.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins WHERE deleted_at IS NULL'))!.n, 0);
});

test('occurrence inputs use the habit boundary across DST gaps, folds and fractional historical offsets', async t => {
  const h = await fixture(t), habitId = await h.board({ tracksTime: true, startOfDayMinute: 180 });
  for (const [instant, date, offset] of [
    ['2026-03-08T09:30:00Z', '2026-03-07', -480], ['2026-03-08T10:30:00Z', '2026-03-08', -420],
    ['2026-11-01T08:30:00Z', '2026-10-31', -420], ['2026-11-01T09:30:00Z', '2026-10-31', -480],
  ] as const) {
    const created = await h.create(habitId, { timeZone: 'America/Los_Angeles', logicalDate: date, occurredAtUtc: Date.parse(instant) });
    const row = await h.db.getFirstAsync<{ occurred_at_utc: number; offset_minutes: number; logical_date: string }>(
      'SELECT occurred_at_utc, offset_minutes, logical_date FROM check_ins WHERE id = ?', [(created.data.result as { checkinId: string }).checkinId]);
    assert.deepEqual({ ...row }, { occurred_at_utc: Date.parse(instant), offset_minutes: offset, logical_date: date });
  }
  const past = -2208988800000.5;
  const created = await h.create(habitId, { timeZone: 'Europe/Paris', occurredAtUtc: past });
  const row = await h.db.getFirstAsync<{ occurred_at_utc: number; offset_minutes: number }>(
    'SELECT occurred_at_utc, offset_minutes FROM check_ins WHERE id = ?', [(created.data.result as { checkinId: string }).checkinId]);
  assert.deepEqual({ ...row }, { occurred_at_utc: past, offset_minutes: 9.35 });
});

test('future, inconsistent, unsupported and unapproved inputs fail before a new product effect', async t => {
  const h = await fixture(t), count = await h.board(), timed = await h.board({ tracksTime: true }), daily = await h.board({ kind: 'daily' });
  for (const [habitId, changes] of [
    [count, { amount: 2 }], [count, { occurredAtUtc: 1 }], [daily, { occurredAtUtc: 1 }],
    [timed, { occurredAtUtc: Date.parse('2026-11-03T12:00:00Z') }], [count, { logicalDate: '2026-11-03' }],
    [timed, { logicalDate: '2026-11-01', occurredAtUtc: Date.parse('2026-11-02T11:00:00Z') }],
  ] as const) await assert.rejects(h.create(habitId, changes), { code: 'INVALID_INPUT' });
  assert.equal((await h.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM check_ins'))!.n, 0);
  await assert.rejects(h.tools.invoke('create_checkin', { operationId: randomUUID(), habitId: count, timeZone: 'UTC', owner: 'foreign' }, h.ctx), { code: 'INVALID_INPUT' });
  await assert.rejects(h.tools.invoke('get_operation', { operationId: randomUUID() }, { ...h.ctx, scopes: ['checkins:write'] }), { code: 'FORBIDDEN' });
  await assert.rejects(h.tools.invoke('create_checkin', { operationId: randomUUID(), habitId: count, timeZone: 'UTC' }, { ...h.ctx, scopes: ['habits:read'] }), { code: 'FORBIDDEN' });
  const request: MutationRequest = { clientId: h.ctx.clientId, tool: 'claim_reward', input: { operationId: randomUUID(), confirmationToken: 'x'.repeat(32) } };
  await assert.rejects(h.journal.run(request), { code: 'CONFIRMATION_REQUIRED' });
});
