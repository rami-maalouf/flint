import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createBoard, archiveBoard, createCheckIn } from '../../../src/core/domain/commands';
import { createReward, archiveReward, deleteReward } from '../../../src/core/domain/reward-commands';
import type { BoardId, CommandId } from '../../../src/core/domain/ids';
import type { DomainResult } from '../../../src/core/domain/result';
import type { AccountRuntime } from '../src/accounts/actor';
import type { AuthContext } from '../src/auth/context';
import { createCorePorts, initializeProductDatabase, NodeSqlDatabase } from '../src/core';
import { CursorCodec } from '../src/tools/cursors';
import { ReadTools } from '../src/tools/reads';
import { contracts, validateResult } from '../src/tools/contracts';
import { publicError, domainValue } from '../src/tools/errors';

function value<T>(result: DomainResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
async function fixture(t: TestContext) {
  assert.equal(process.version, 'v24.22.2');
  const path = mkdtempSync(join(tmpdir(), 'habit-mcp-reads-'));
  const db = new NodeSqlDatabase(join(path, 'product.sqlite'));
  t.after(async () => { await db.closeAsync(); rmSync(path, { recursive: true, force: true }); });
  const ports = createCorePorts('America/Toronto', Date.UTC(2026, 9, 30, 5));
  value(await initializeProductDatabase(db, ports.ids, ports.hashing));
  const deps = { db, ...ports };
  const context: AuthContext = { accountId: 'account', clientId: 'client', grantId: 'grant', principal: 'principal',
    backendUrl: 'https://example.test', scopes: ['habits:read', 'coins:read'],
    session: { principal: 'principal', scope: 'read', kind: 'user', token: 'synthetic', expiresAt: Date.now() + 60_000 },
    assertActive: async () => {} };
  const meta = { observedAtUtc: Date.now(), lastCompletedPullAtUtc: Date.now(), backendRevision: '1',
    syncStatus: 'up_to_date' as const, pendingLocalDeliveries: 0,
    admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
  const runtime: AccountRuntime = { ...deps, meta, signal: new AbortController().signal,
    recovery: { writeFenced: true, deliveryPaused: true, reconnectRequired: false, recoveryReason: null } };
  let opens = 0;
  const tools = new ReadTools({ cursors: new CursorCodec(randomBytes(32)),
    accounts: { withAccount: async (_ctx, _options, work) => { opens++; return { data: await work(runtime), meta }; } } });
  const board = async (title: string, startOfDayMinute = 0) => value(await createBoard(deps, {
    commandId: randomUUID() as CommandId, title, symbol: 'star.fill', accentHex: '#78D98B',
    usesTintedBackground: false, tracksAmount: false, amountUnit: null, quickAmount: 1,
    tracksTime: false, startOfDayMinute, metricsEnabled: true,
  })).boardId;
  return { db, deps, context, tools, board, runtime, opens: () => opens };
}

test('authenticated opaque cursors reject tampering, other account, tool, filters and permission before opening a replica', async t => {
  const h = await fixture(t);
  await h.board('same'); await h.board('same'); await h.board('last');
  const first = await h.tools.invoke('list_habits', { limit: 1 }, h.context);
  validateResult('list_habits', first);
  const cursor = (first.data as { nextCursor: string }).nextCursor;
  assert.ok(cursor);
  const before = h.opens();
  for (const [tool, input, context] of [
    ['list_habits', { cursor: cursor + 'x' }, h.context],
    ['list_habits', { cursor }, { ...h.context, accountId: 'another' }],
    ['list_habits', { cursor }, { ...h.context, clientId: 'another' }],
    ['list_habits', { cursor, lifecycle: 'archived' }, h.context],
    ['list_rewards', { cursor }, h.context],
  ] as const) await assert.rejects(h.tools.invoke(tool, input, context), { code: 'INVALID_INPUT' });
  assert.equal(h.opens(), before);
  await assert.rejects(h.tools.invoke('list_habits', { owner: 'another' }, h.context), { code: 'INVALID_INPUT' });
  await assert.rejects(h.tools.invoke('list_habits', {}, { ...h.context, scopes: ['coins:read'] }), { code: 'FORBIDDEN' });
  assert.equal(h.opens(), before);
});

test('coin and reward reads preserve negative totals, historical snapshots, archived state and ordered continuation', async t => {
  const h = await fixture(t);
  const fields = { title: 'same', costCoins: 2, symbol: 'star.fill', accentHex: '#78D98B' };
  const first = value(await createReward(h.deps, { ...fields, commandId: randomUUID() as CommandId })).rewardId;
  const second = value(await createReward(h.deps, { ...fields, commandId: randomUUID() as CommandId })).rewardId;
  const listed = await h.tools.invoke('list_rewards', { limit: 1 }, h.context);
  validateResult('list_rewards', listed);
  const page = listed.data as { items: { id: string }[]; nextCursor: string };
  assert.equal(page.items[0].id, first);
  const continued = await h.tools.invoke('list_rewards', { limit: 1, cursor: page.nextCursor }, h.context);
  assert.equal((continued.data as typeof page).items[0].id, second);
  value(await archiveReward(h.deps, { rewardId: second, commandId: randomUUID() as CommandId }));
  assert.equal(((await h.tools.invoke('list_rewards', { lifecycle: 'archived' }, h.context)).data as typeof page).items[0].id, second);
  for (let index = 0; index < 3; index++) await h.db.runAsync(`INSERT INTO coin_ledger
    (id, kind, delta, reward_id, reward_title_snapshot, logical_date, created_at, mutation_stamp)
    VALUES (?, 'claim', -2, ?, 'historical title', '2026-10-30', ?, '00000000000000-00000-test')`, [randomUUID(), first, index]);
  value(await deleteReward(h.deps, { rewardId: first, commandId: randomUUID() as CommandId }));
  assert.deepEqual((await h.tools.invoke('get_coin_balance', {}, h.context)).data, { earned: 0, spent: 6, balance: -6 });
  const history = await h.tools.invoke('get_coin_history', { limit: 2 }, h.context);
  validateResult('get_coin_history', history);
  const coinPage = history.data as { items: { createdAt: number; reference: { title: string } }[]; nextCursor: string };
  assert.deepEqual(coinPage.items.map(row => row.createdAt), [2, 1]);
  assert.ok(coinPage.items.every(row => row.reference.title === 'historical title'));
  const last = await h.tools.invoke('get_coin_history', { cursor: coinPage.nextCursor }, h.context);
  assert.deepEqual((last.data as typeof coinPage).items.map(row => row.createdAt), [0]);
  const opens = h.opens();
  await assert.rejects(h.tools.invoke('get_coin_balance', {}, { ...h.context, scopes: ['habits:read'] }), { code: 'FORBIDDEN' });
  assert.equal(h.opens(), opens);
});

test('current stack snapshots use root day boundaries with bounded detail and no historical simulation', async t => {
  const h = await fixture(t);
  const root = await h.board('root', 240), child = await h.board('child');
  await h.db.runAsync("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [root, child]);
  const list = await h.tools.invoke('list_stacks', { timeZone: 'America/Toronto', limit: 1 }, h.context);
  validateResult('list_stacks', list);
  const data = list.data as { items: { rootId: string; currentRun: { logicalDate: string } }[] };
  assert.equal(data.items[0].rootId, root);
  assert.equal(data.items[0].currentRun.logicalDate, '2026-10-29');
  const detail = await h.tools.invoke('get_stack', { timeZone: 'America/Toronto', rootHabitId: root }, h.context);
  validateResult('get_stack', detail);
  assert.equal((detail.data as { heatmap: object[] }).heatmap.length, 365);
  await assert.rejects(h.tools.invoke('get_stack', { timeZone: 'UTC', rootHabitId: child }, h.context), { code: 'NOT_FOUND' });
  await assert.rejects(h.tools.invoke('list_stacks', { timeZone: 'UTC', asOf: '2026-10-29' }, h.context), { code: 'INVALID_INPUT' });
});

test('cursor keys survive restart, expire and are independent from caller key mutation; errors redact SQL', () => {
  const key = randomBytes(32), original = Buffer.from(key);
  const binding = { accountId: 'a', clientId: 'c', tool: 'test', filters: {} };
  const codec = new CursorCodec(key, () => 1);
  key.fill(0);
  const cursor = codec.encode(binding, { id: 'position' });
  const schema = contracts.list_habits.input;
  assert.throws(() => new CursorCodec(original, () => 86_400_002).decode(binding, cursor, schema), { code: 'INVALID_INPUT' });
  const inputCursor = codec.encode(binding, { lifecycle: 'active' });
  assert.deepEqual(new CursorCodec(original, () => 2).decode(binding, inputCursor, schema), { lifecycle: 'active' });
  assert.throws(() => domainValue({ ok: false, error: { code: 'database', message: 'SQL SECRET token', retryable: true } }),
    error => { assert.ok(!String(error).includes('SECRET')); return true; });
  assert.ok(!JSON.stringify(publicError(new Error('SQL SECRET token'))).includes('SECRET'));
});

test('valid imported long order keys always emit usable continuation or a clear bounded error', async t => {
  const h = await fixture(t);
  const first = await h.board('first'), second = await h.board('second');
  await h.db.runAsync('UPDATE boards SET order_key = ? WHERE id = ?', ['1'.repeat(256), first]);
  await h.db.runAsync('UPDATE boards SET order_key = ? WHERE id = ?', ['2'.repeat(256), second]);
  const page = await h.tools.invoke('list_habits', { limit: 1 }, h.context);
  const cursor = (page.data as { nextCursor: string }).nextCursor;
  assert.ok(cursor.length <= 4096);
  const next = await h.tools.invoke('list_habits', { cursor, limit: 1 }, h.context);
  assert.equal((next.data as { items: { id: string }[] }).items[0].id, second);
  await h.db.runAsync('UPDATE boards SET order_key = ? WHERE id = ?', ['1'.repeat(5000), first]);
  await assert.rejects(h.tools.invoke('list_habits', { limit: 1 }, h.context), { code: 'UNAVAILABLE' });
});

test('large note pages shorten to the complete JSON byte budget with usable continuation', async t => {
  const h = await fixture(t);
  const id = await h.board('notes');
  for (let index = 0; index < 20; index++) value(await createCheckIn(h.deps, {
    commandId: randomUUID() as CommandId, boardId: id, source: 'app', note: 'x'.repeat(8000),
  }));
  const context = { ...h.context, scopes: [...h.context.scopes, 'habits:notes:read' as const] };
  const first = await h.tools.invoke('get_checkin_history', { habitId: id, limit: 100 }, context);
  const page = first.data as { items: { id: string }[]; nextCursor: string };
  assert.ok(page.items.length > 0 && page.items.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 131_072);
  const next = await h.tools.invoke('get_checkin_history', { habitId: id, limit: 100, cursor: page.nextCursor }, context);
  assert.equal(new Set([...page.items, ...(next.data as typeof page).items].map(row => row.id)).size, 20);
});

test('habit pages preserve exact ids, lifecycle, duplicate titles and continuation after insertion/deletion', async t => {
  const h = await fixture(t);
  const ids = [await h.board('duplicate'), await h.board('duplicate'), await h.board('third')];
  const first = await h.tools.invoke('list_habits', { limit: 1 }, h.context);
  const page = first.data as { items: { id: string; title: string }[]; nextCursor: string };
  assert.equal(page.items[0].id, ids[0]);
  await h.board('new');
  await h.db.runAsync('UPDATE boards SET deleted_at = ? WHERE id = ?', [1, ids[1]]);
  const second = await h.tools.invoke('list_habits', { limit: 2, cursor: page.nextCursor }, h.context);
  assert.deepEqual((second.data as { items: { id: string }[] }).items.map(row => row.id), [ids[2], (await h.db.getFirstAsync<{ id: string }>('SELECT id FROM boards ORDER BY order_key DESC LIMIT 1'))!.id]);
  value(await archiveBoard(h.deps, { commandId: randomUUID() as CommandId, boardId: ids[2] }));
  const archived = await h.tools.invoke('list_habits', { lifecycle: 'archived' }, h.context);
  assert.equal((archived.data as { items: unknown[] }).items.length, 1);
  const detail = await h.tools.invoke('get_habit', { habitId: ids[2] }, h.context);
  assert.equal((detail.data as { id: string }).id, ids[2]);
  await assert.rejects(h.tools.invoke('get_habit', { habitId: randomUUID() }, h.context), { code: 'NOT_FOUND' });
});

test('today uses the immutable request zone and individual board boundaries; status reports the actual fence', async t => {
  const h = await fixture(t);
  await h.board('midnight'); await h.board('late', 240);
  const result = await h.tools.invoke('get_today', { timeZone: 'America/Toronto' }, h.context);
  validateResult('get_today', result);
  assert.deepEqual((result.data as { items: { logicalDate: string }[] }).items.map(row => row.logicalDate), ['2026-10-30', '2026-10-29']);
  const status = await h.tools.invoke('get_sync_status', {}, h.context);
  assert.deepEqual(status.data, h.runtime.recovery);
});

test('history is a bounded deterministic keyset with effective rows only and separate note authority', async t => {
  const h = await fixture(t);
  const id = await h.board('history');
  for (let index = 0; index < 5; index++) value(await createCheckIn(h.deps, {
    commandId: randomUUID() as CommandId, boardId: id, source: 'app', note: `private ${index}`,
  }));
  const rows = await h.db.getAllAsync<{ id: string }>('SELECT id FROM check_ins ORDER BY logical_date DESC, created_at DESC, id DESC');
  const first = await h.tools.invoke('get_checkin_history', { habitId: id, limit: 2 }, h.context);
  validateResult('get_checkin_history', first);
  const page = first.data as { items: { id: string; note?: string }[]; nextCursor: string };
  assert.deepEqual(page.items.map(row => row.id), rows.slice(0, 2).map(row => row.id));
  assert.ok(page.items.every(row => !Object.hasOwn(row, 'note')));
  await h.db.runAsync('UPDATE check_ins SET state_suppressed = 1 WHERE id = ?', [rows[2].id]);
  const next = await h.tools.invoke('get_checkin_history', { habitId: id, limit: 2, cursor: page.nextCursor }, h.context);
  assert.deepEqual((next.data as { items: { id: string }[] }).items.map(row => row.id), rows.slice(3).map(row => row.id));
  const notes = await h.tools.invoke('get_checkin_history', { habitId: id, limit: 1 },
    { ...h.context, scopes: [...h.context.scopes, 'habits:notes:read'] });
  assert.ok(Object.hasOwn((notes.data as { items: object[] }).items[0], 'note'));
  const count = h.opens();
  await assert.rejects(h.tools.invoke('get_checkin_history', { habitId: id, cursor: page.nextCursor },
    { ...h.context, scopes: [...h.context.scopes, 'habits:notes:read'] }), { code: 'INVALID_INPUT' });
  assert.equal(h.opens(), count);
  const empty = await h.tools.invoke('get_checkin_history', { habitId: id, fromDate: '2026-10-01', toDate: '2026-10-02' }, h.context);
  assert.deepEqual(empty.data, { items: [], nextCursor: null });
  await assert.rejects(h.tools.invoke('get_checkin_history', { habitId: randomUUID() as BoardId }, h.context), { code: 'NOT_FOUND' });
});
