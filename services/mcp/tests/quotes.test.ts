import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { RewardQuoteStore } from '../src/rewards/quotes';
import { approvedClaimNormalizer, RewardPreviewTools } from '../src/rewards/tools';
import { createBoard } from '../../../src/core/domain/commands';
import { createReward } from '../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { AuthContext } from '../src/auth/context';
import { claimReward, createCheckIn, createCorePorts, getCoinTotals, initializeProductDatabase, NodeSqlDatabase } from '../src/core';
import type { Metadata } from '../src/tools/contracts';

function fixture(t: TestContext, maxQuotes = 100) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-reward-quotes-'))), location = join(directory, 'quotes.sqlite');
  const key = randomBytes(32), identity = { accountId: randomUUID(), clientId: randomUUID(), grantId: randomUUID() };
  const input = { rewardId: randomUUID(), operationId: randomUUID(), timeZone: 'America/Toronto' };
  let now = Date.parse('2026-10-30T12:00:00Z');
  const preview = { reward: { id: input.rewardId, title: 'synthetic reward', costCoins: 5, symbol: 'star.fill',
    accentHex: '#70A7FF', mutationStamp: '01792900000000-00001-synthetic', archivedAt: null }, balance: 12, balanceAfterClaim: 7 };
  let store = new RewardQuoteStore({ location, key, publicOrigin: 'https://habits.example.test', nowUtcMs: () => now, maxQuotes });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { identity, input, preview, location, key, get store() { return store; }, owner: { accountId: identity.accountId, providerSessionId: randomUUID() },
    claim: { accountId: identity.accountId, clientId: identity.clientId, operationId: input.operationId },
    setNow: (value: number) => { now = value; },
    reopen: () => { store.close(); store = new RewardQuoteStore({ location, key, publicOrigin: 'https://habits.example.test', nowUtcMs: () => now, maxQuotes }); },
  };
}

test('durable operation-bound preview has a stable opaque token and cannot spend or approve on view', t => {
  const h = fixture(t), quote = h.store.issue(h.identity, h.input, h.preview);
  assert.equal(quote.operationId, h.input.operationId); assert.equal(quote.balanceAfterClaim, 7);
  const url = new URL(quote.confirmationUrl);
  assert.equal(url.origin, 'https://habits.example.test'); assert.equal(url.pathname, '/mcp/reward-confirmation');
  assert.equal(url.searchParams.get('token'), quote.confirmationToken);
  assert.equal(h.store.view(quote.confirmationToken, h.owner.accountId).approved, false);
  assert.throws(() => h.store.admit(quote.confirmationToken, h.claim), { code: 'CONFIRMATION_REQUIRED' });
  h.reopen();
  assert.deepEqual(h.store.issue(h.identity, h.input, h.preview), quote);
  h.store.approve(quote.confirmationToken, h.owner);
  h.reopen();
  const admitted = h.store.admit(quote.confirmationToken, h.claim);
  assert.equal(admitted.reward.costCoins, 5); assert.equal(admitted.timeZone, h.input.timeZone);
  assert.deepEqual(h.store.admit(quote.confirmationToken, h.claim), admitted);
  // approval verification before journal prepare must not strand the operation after a crash.
  assert.deepEqual(h.store.issue(h.identity, h.input, h.preview), quote);
  assert.ok(!JSON.stringify(quote).includes(h.identity.accountId));
  assert.ok(!readFileSync(h.location).includes(Buffer.from(quote.confirmationToken)));
});

test('account, client, operation, token tampering and expiry cannot authorize another claim', t => {
  const h = fixture(t), quote = h.store.issue(h.identity, h.input, h.preview);
  assert.throws(() => h.store.view(quote.confirmationToken, randomUUID()), { code: 'FORBIDDEN' });
  assert.throws(() => h.store.approve(quote.confirmationToken, { ...h.owner, accountId: randomUUID() }), { code: 'FORBIDDEN' });
  h.store.approve(quote.confirmationToken, h.owner);
  for (const changed of [{ accountId: randomUUID() }, { clientId: randomUUID() }, { operationId: randomUUID() }]) {
    assert.throws(() => h.store.admit(quote.confirmationToken, { ...h.claim, ...changed }), { code: 'FORBIDDEN' });
  }
  const tampered = quote.confirmationToken.slice(0, -1) + (quote.confirmationToken.endsWith('a') ? 'b' : 'a');
  assert.throws(() => h.store.admit(tampered, h.claim), { code: 'CONFIRMATION_REQUIRED' });
  h.setNow(quote.expiresAtUtc);
  assert.throws(() => h.store.admit(quote.confirmationToken, h.claim), { code: 'CONFIRMATION_EXPIRED' });
});

test('changed reward versions require new approval and insufficient or negative balances cannot be approved', t => {
  const h = fixture(t), original = h.store.issue(h.identity, h.input, h.preview);
  h.store.approve(original.confirmationToken, h.owner);
  const changed = { ...h.preview, reward: { ...h.preview.reward, costCoins: 6, mutationStamp: '01792900000000-00002-synthetic' }, balanceAfterClaim: 6 };
  const next = h.store.issue(h.identity, h.input, changed);
  assert.notEqual(next.confirmationToken, original.confirmationToken);
  assert.throws(() => h.store.admit(original.confirmationToken, h.claim), { code: 'CONFIRMATION_EXPIRED' });
  assert.throws(() => h.store.admit(next.confirmationToken, h.claim), { code: 'CONFIRMATION_REQUIRED' });
  for (const balance of [0, -5]) {
    const poor = h.store.issue(h.identity, { ...h.input, operationId: randomUUID() }, { ...h.preview, balance, balanceAfterClaim: null });
    assert.equal(poor.balance, balance);
    assert.throws(() => h.store.approve(poor.confirmationToken, h.owner), { code: 'CONFIRMATION_REQUIRED' });
  }
  assert.throws(() => h.store.issue(h.identity, { ...h.input, rewardId: randomUUID() }, changed), { code: 'INVALID_INPUT' });
  assert.throws(() => h.store.issue(h.identity, { ...h.input, timeZone: 'UTC' }, changed), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('authenticated stored payload and approval state refuse tampering; retained quote capacity is bounded', t => {
  const h = fixture(t, 1), quote = h.store.issue(h.identity, h.input, h.preview);
  assert.throws(() => h.store.issue(h.identity, { ...h.input, operationId: randomUUID() }, h.preview), { code: 'RATE_LIMITED' });
  const db = new DatabaseSync(h.location);
  try { db.prepare('UPDATE reward_quotes SET approval = ?, approval_mac = ?').run(JSON.stringify({ approvedAtUtc: 1, providerSessionId: 'forged', admittedAtUtc: null }), '0'.repeat(64)); }
  finally { db.close(); }
  assert.throws(() => h.store.admit(quote.confirmationToken, h.claim), { code: 'UNAVAILABLE' });
});

test('indexed identity cannot retarget a different authenticated quote payload', t => {
  const h = fixture(t), quote = h.store.issue(h.identity, h.input, h.preview);
  const foreign = { ...h.identity, accountId: randomUUID() };
  const db = new DatabaseSync(h.location);
  try { db.prepare('UPDATE reward_quotes SET account_id = ?').run(foreign.accountId); }
  finally { db.close(); }
  assert.throws(() => h.store.issue(foreign, h.input, h.preview), { code: 'UNAVAILABLE' });
  assert.throws(() => h.store.view(quote.confirmationToken, h.identity.accountId), { code: 'UNAVAILABLE' });
});

test('a different key cannot reopen an existing quote database or create mixed-key state', t => {
  const h = fixture(t); h.store.issue(h.identity, h.input, h.preview);
  assert.throws(() => new RewardQuoteStore({ location: h.location, key: randomBytes(32), publicOrigin: 'https://habits.example.test' }), { code: 'UNAVAILABLE' });
  assert.throws(() => new RewardQuoteStore({ location: h.location, key: h.key, publicOrigin: 'https://another.example.test' }), { code: 'UNAVAILABLE' });
});

test('two real SQLite issuer workers cannot exceed one retained quote slot', { timeout: 15_000 }, async t => {
  const h = fixture(t, 1), bundle = resolve(`services/mcp/.artifacts/quote-capacity-${process.pid}.mjs`);
  t.after(() => rmSync(bundle, { force: true }));
  const built = spawnSync('bun', ['build', 'services/mcp/src/rewards/quotes.ts', '--target=node', '--packages=external', `--outfile=${bundle}`], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const shared = new SharedArrayBuffer(12);
  const workers = [0, 1].map(index => new Worker(`
    const { workerData: d, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const gate = new Int32Array(d.shared);
    let writing = false, preTransactionCount = false;
    const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'BEGIN IMMEDIATE' && preTransactionCount && d.index === 1 && Atomics.load(gate, 2) === 0) {
        Atomics.wait(gate, 2, 0, 3000);
      }
      const result = exec.call(this, sql);
      if (sql.startsWith('BEGIN IMMEDIATE')) writing = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') writing = false;
      if (sql === 'COMMIT' && preTransactionCount && d.index === 0) {
        Atomics.store(gate, 2, 1); Atomics.notify(gate, 2);
      }
      return result;
    };
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (sql !== 'SELECT count(*) AS n FROM reward_quotes') return statement;
      return { get() {
        const result = statement.get();
        // force the historical pre-transaction capacity race without blocking a correctly locked decision.
        if (!writing) {
          preTransactionCount = true;
          Atomics.add(gate, 1, 1); Atomics.notify(gate, 1);
          if (Atomics.load(gate, 1) < 2) Atomics.wait(gate, 1, 1, 3000);
        }
        return result;
      } };
    };
    (async () => {
      const { RewardQuoteStore } = await import(d.bundle);
      const store = new RewardQuoteStore({ location: d.location, key: d.key, publicOrigin: 'https://habits.example.test',
        nowUtcMs: () => Date.parse('2026-10-30T12:00:00Z'), maxQuotes: 1 });
      Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
      if (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1, 3000);
      try { store.issue(d.identity, d.input, d.preview); parentPort.postMessage({ ok: true }); }
      catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
      finally { store.close(); }
    })().catch(error => { parentPort.postMessage({ ok: false, code: error.code }); });
  `, { eval: true, workerData: { index, shared, bundle: pathToFileURL(bundle).href, location: h.location, key: h.key,
    identity: h.identity, input: { ...h.input, operationId: randomUUID() }, preview: h.preview } }));
  t.after(async () => { await Promise.allSettled(workers.map(worker => worker.terminate())); });
  const results = await Promise.all(workers.map(worker => new Promise<{ ok: boolean }>((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('Synthetic issuer worker failed.')); });
  })));
  assert.equal(results.filter(result => result.ok).length, 1);
  const db = new DatabaseSync(h.location);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM reward_quotes').get()!.n, 1); }
  finally { db.close(); }
});

test('core preview writes no product rows and approved claim normalization permits affordable balance movement', async t => {
  const h = fixture(t), db = new NodeSqlDatabase(); t.after(() => db.closeAsync());
  const now = Date.parse('2026-10-30T12:00:00Z'), ports = createCorePorts('UTC', now), deps = { db, ...ports };
  assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
  const board = await createBoard(deps, { commandId: randomUUID() as CommandId, title: 'synthetic earning', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, earnsCoins: true, coinCapPerDay: 10 });
  const reward = await createReward(deps, { commandId: randomUUID() as CommandId, title: 'synthetic cost', costCoins: 2,
    symbol: 'star.fill', accentHex: '#70A7FF' });
  assert.ok(board.ok && reward.ok);
  for (let n = 0; n < 5; n++) assert.ok((await createCheckIn(deps, { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' })).ok);
  const context: AuthContext = { ...h.identity, principal: 'synthetic', backendUrl: 'https://synthetic.test', scopes: ['coins:read'],
    session: { principal: 'synthetic', token: 'synthetic-never-sent', kind: 'user', scope: 'read', expiresAt: now + 86_400_000 }, assertActive: async () => {} };
  const meta: Metadata = { observedAtUtc: now, lastCompletedPullAtUtc: now, backendRevision: null, syncStatus: 'up_to_date',
    pendingLocalDeliveries: 0, admission: { pending: 0, blocked: 0, quarantined: 0, deferred: 0 }, usedCached: false };
  const before = await db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id');
  const preview = new RewardPreviewTools({ quotes: h.store, accounts: { withAccount: async (_ctx, _options, work) => {
    await db.execAsync('PRAGMA query_only = ON');
    try { return { data: await work({ db, ...ports, meta, recovery: { writeFenced: true, deliveryPaused: true,
      reconnectRequired: false, recoveryReason: null }, signal: new AbortController().signal }), meta }; }
    finally { await db.execAsync('PRAGMA query_only = OFF'); }
  } } });
  const input = { ...h.input, rewardId: reward.value.rewardId };
  const quoted = await preview.invoke(input, context), data = quoted.data;
  assert.deepEqual(await db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'), before);
  await assert.rejects(preview.invoke(input, { ...context, scopes: ['habits:read'] }), { code: 'FORBIDDEN' });
  h.store.approve(data.confirmationToken, h.owner);
  assert.ok((await createCheckIn(deps, { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' })).ok);
  const beforeClaim = await getCoinTotals(deps); assert.ok(beforeClaim.ok);
  const command = await approvedClaimNormalizer(h.store)({ clientId: context.clientId, tool: 'claim_reward',
    input: { operationId: input.operationId, confirmationToken: data.confirmationToken } },
  { commandId: randomUUID() as CommandId, nowUtcMs: now, context, read: db, undoTarget: async () => { throw new Error('not used'); } });
  assert.equal(command.command.tool, 'claim_reward');
  if (command.command.tool !== 'claim_reward') throw new Error('expected claim');
  const result = await claimReward(deps, command.command.input); assert.ok(result.ok);
  assert.equal(result.value.balance, beforeClaim.value.balance - 2);
  assert.equal((await db.getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM coin_ledger WHERE kind = 'claim'"))!.n, 1);
});
