import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDiagnostic, recordDiagnostic } from '../src/diagnostics';
import { DEFAULT_SERVICE_LIMITS, LimitedRequestError, ServiceLimits } from '../src/limits';

test('actual node http requests receive 429, retry-after, and recover after cancellation and handler failure', async () => {
  let now = 0;
  const limits = new ServiceLimits({ now: () => now, limits: { activeGlobal: 1, loginPerMinute: 4 } });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let enteredBlocked!: () => void;
  const blockedEntered = new Promise<void>(resolve => { enteredBlocked = resolve; });
  let enteredCancel!: () => void, finishedCancel!: () => void;
  const cancelEntered = new Promise<void>(resolve => { enteredCancel = resolve; });
  const cancelFinished = new Promise<void>(resolve => { finishedCancel = resolve; });
  const server = createServer(async (request, response) => {
    let release: () => void;
    try { release = limits.enter('login'); }
    catch (cause) {
      assert.ok(cause instanceof LimitedRequestError);
      response.writeHead(429, { 'retry-after': String(cause.retryAfterSeconds) });
      response.end('rate_limited');
      return;
    }
    try {
      if (request.url === '/blocked') { enteredBlocked(); await blocked; }
      if (request.url === '/cancel') {
        enteredCancel();
        await new Promise<void>(resolve => response.once('close', resolve));
        return;
      }
      if (request.url === '/failure') throw new Error('private failure');
      response.writeHead(204); response.end();
    } catch {
      response.writeHead(503); response.end();
    } finally { release(); if (request.url === '/cancel') finishedCancel(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const first = fetch(url + '/blocked');
    await blockedEntered;
    const busy = await fetch(url);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '1');
    unblock();
    assert.equal((await first).status, 204);
    assert.equal((await fetch(url + '/failure')).status, 503);
    const controller = new AbortController();
    const cancelled = fetch(url + '/cancel', { signal: controller.signal });
    await cancelEntered;
    controller.abort();
    await assert.rejects(cancelled);
    await cancelFinished;
    assert.equal((await fetch(url)).status, 204);
    assert.equal((await fetch(url)).status, 429);
    now = 60_000;
    assert.equal((await fetch(url)).status, 204);
  } finally { unblock(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('default limits and every rate window have exact bounded admission', () => {
  assert.deepEqual(DEFAULT_SERVICE_LIMITS, { activeGlobal: 16, mcpPerGrantPerMinute: 120,
    mcpGlobalPerMinute: 600, loginPerMinute: 30, registrationPerHour: 30, tokenPerMinute: 300,
    maxWindowEntries: 4096 });
  for (const [kind, option, windowMs] of [
    ['login', 'loginPerMinute', 60_000], ['registration', 'registrationPerHour', 3_600_000],
    ['token', 'tokenPerMinute', 60_000], ['mcp', 'mcpPerGrantPerMinute', 60_000],
  ] as const) {
    let now = 0;
    const limits = new ServiceLimits({ now: () => now, limits: { [option]: 2 } });
    const key = kind === 'mcp' ? randomUUID() : undefined;
    limits.enter(kind, key)(); limits.enter(kind, key)();
    assert.throws(() => limits.enter(kind, key), (cause: unknown) =>
      cause instanceof LimitedRequestError && cause.retryAfterSeconds === windowMs / 1000);
    now = windowMs - 1;
    assert.throws(() => limits.enter(kind, key));
    now = windowMs;
    limits.enter(kind, key)();
  }
});

test('global mcp rate, active slots, and idempotent release cannot be bypassed', () => {
  const limits = new ServiceLimits({ limits: { activeGlobal: 2, mcpGlobalPerMinute: 2 } });
  const first = limits.enter('mcp', randomUUID());
  const second = limits.enter('mcp', randomUUID());
  assert.throws(() => limits.enter('login'), LimitedRequestError);
  first(); first(); second();
  assert.throws(() => limits.enter('mcp', randomUUID()), LimitedRequestError);
  limits.enter('login')();
});

test('the per-grant map fails closed at capacity and expired grants free entries', () => {
  let now = 0;
  const limits = new ServiceLimits({ now: () => now, limits: { maxWindowEntries: 1 } });
  const first = randomUUID(), second = randomUUID();
  limits.enter('mcp', first)();
  assert.throws(() => limits.enter('mcp', second), LimitedRequestError);
  now = 60_000;
  limits.enter('mcp', second)();
});

test('case changes and clock rollback cannot reset a grant window', () => {
  let now = 10_000;
  const limits = new ServiceLimits({ now: () => now, limits: { mcpPerGrantPerMinute: 1 } });
  const grantId = randomUUID();
  limits.enter('mcp', grantId.toUpperCase())();
  now = 0;
  assert.throws(() => limits.enter('mcp', grantId), (cause: unknown) =>
    cause instanceof LimitedRequestError && cause.retryAfterSeconds === 60);
  now = 70_000;
  limits.enter('mcp', grantId)();
});

test('verified uuid v7 grant ids are admitted under the opaque grant contract', () => {
  const uuid7 = randomUUID().replace(/-4([0-9a-f]{3})-/, '-7$1-');
  const limits = new ServiceLimits();
  assert.doesNotThrow(() => limits.enter('mcp', uuid7)());
});

test('invalid kinds, keys, options, and clocks fail without reflecting private input', () => {
  const limits = new ServiceLimits();
  for (const [kind, key] of [['mcp', 'Bearer private-token'], ['mcp', undefined],
    ['login', randomUUID()], ['private-title', undefined]] as const) {
    assert.throws(() => limits.enter(kind as 'mcp', key), (cause: unknown) =>
      cause instanceof LimitedRequestError && !cause.message.includes('private'));
  }
  assert.throws(() => new ServiceLimits({ limits: { activeGlobal: 0 } }), TypeError);
  assert.throws(() => new ServiceLimits({ limits: { activeGlobal: 17 } }), TypeError);
  assert.throws(() => new ServiceLimits({ now: () => Number.NaN }).enter('login'), TypeError);
});

test('constructor accessors cannot replace validated caps or options', () => {
  let capReads = 0;
  const overrides = { get activeGlobal() { capReads++; return capReads === 1 ? 1 : 1000; } };
  assert.throws(() => new ServiceLimits({ limits: overrides }), TypeError);
  assert.equal(capReads, 0);

  let optionReads = 0;
  const options = { get limits() { optionReads++; return { activeGlobal: 1 }; },
    get now() { optionReads++; return () => 0; } };
  assert.throws(() => new ServiceLimits(options), TypeError);
  assert.equal(optionReads, 0);
});

test('diagnostics accept only bounded identifiers, known tools and enums, and never serialize private input', () => {
  const requestId = randomUUID(), operationId = randomUUID();
  const event = buildDiagnostic({ requestId, operationId, tool: 'create_checkin', durationMs: 12.5,
    errorCode: 'RATE_LIMITED', delivery: 'pending' });
  assert.deepEqual(event, { requestId, operationId, tool: 'create_checkin', durationMs: 12.5,
    errorCode: 'RATE_LIMITED', delivery: 'pending' });
  assert.equal(Object.isFrozen(event), true);
  let observed: unknown;
  recordDiagnostic(event, value => { observed = value; });
  assert.deepEqual(observed, event);
  for (const payload of [
    { ...event, bearer: 'private bearer' }, { ...event, title: 'private title' },
    { ...event, balance: 100 }, { ...event, errorMessage: 'private SQL' },
    { ...event, requestId: 'private identity' }, { ...event, tool: 'private_tool' },
    { ...event, durationMs: Infinity }, { ...event, durationMs: 600_001 },
    { ...event, errorCode: 'private_error' }, { ...event, delivery: 'private_state' },
  ]) {
    assert.throws(() => buildDiagnostic(payload));
    assert.equal(JSON.stringify(observed).includes('private'), false);
  }
});

test('diagnostic accessors cannot swap a validated id for private text', () => {
  const valid = randomUUID();
  let reads = 0;
  const input = { durationMs: 1, get requestId() {
    reads++;
    return reads <= 2 ? valid : 'private sentinel';
  } };
  assert.throws(() => buildDiagnostic(input), TypeError);
  assert.equal(reads, 0);

  let nestedReads = 0;
  const nested = Object.defineProperty({}, 'private', { get() { nestedReads++; return 'private sentinel'; } });
  assert.throws(() => buildDiagnostic({ requestId: valid, durationMs: 1, operationId: nested }), TypeError);
  assert.equal(nestedReads, 0);
});
