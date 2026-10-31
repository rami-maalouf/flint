import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type ClientRequest } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import { AccountActors } from '../src/accounts/actor';
import { accountDirectory } from '../src/accounts/replica';
import { runtimeLimits } from '../src/startup';
import { fullService } from './helpers/full-service';

const node = process.execPath;
const serviceDirectory = resolve('services/mcp');
const host = 'habits.example.test';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function exchange(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host, ...options.headers }, timeout: 4000 }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('synthetic HTTP deadline exceeded')));
    req.on('error', reject); req.end(options.body);
  });
}

async function runtime(t: import('node:test').TestContext) {
  assert.equal(process.version, 'v24.22.2');
  assert.equal(process.versions.bun, undefined);
  const createdDirectory = mkdtempSync(join(tmpdir(), 'mcp-resource-'));
  const cleanups: Array<() => Promise<void> | void> = [() => rmSync(createdDirectory, { recursive: true, force: true })];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Synthetic resource runtime cleanup failed.');
  });
  const directory = realpathSync(createdDirectory);
  const executable = join(serviceDirectory, '.artifacts', `resource-main-${process.pid}-${randomUUID()}.mjs`);
  cleanups.push(() => rmSync(executable, { force: true }));
  const dataDirectory = join(directory, 'data'), keyFile = join(directory, 'keys.json'), configPath = join(directory, 'config.json');
  mkdirSync(dataDirectory, { mode: 0o700 }); chmodSync(directory, 0o700);
  const port = await freePort();
  const config = { version: 1, publicOrigin: `https://${host}`, backendUrl: 'https://backend.example.test',
    dataDirectory, keyFile, port };
  const keys = { version: 1, providerSecret: randomBytes(48).toString('base64'),
    cursorKey: randomBytes(32).toString('base64'), activeVaultKeyVersion: 'v1',
    vaultKeys: { v1: randomBytes(32).toString('base64') } };
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const build = spawnSync('bun', ['build', 'src/main.ts', '--target=node', '--packages=external', `--outfile=${executable}`],
    { cwd: serviceDirectory, encoding: 'utf8', timeout: 20_000 });
  assert.equal(build.status, 0, build.stderr);
  const child = spawn(node, [executable], { cwd: serviceDirectory,
    env: { PATH: process.env.PATH, MCP_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (!output.includes('MCP service ready.') && Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(output, /MCP service ready\./);
  assert.equal((await exchange(port, '/mcp/health')).status, 200);
  return { child, exited, output: () => output, port, keys, keyFile, dataDirectory };
}

function partial(port: number, declaredBytes: number): ClientRequest {
  const req = request({ host: '127.0.0.1', port, path: '/mcp/auth/oauth2/register', method: 'POST',
    headers: { host, 'content-type': 'application/json', 'content-length': String(declaredBytes) } });
  req.on('error', () => undefined);
  req.write('{');
  return req;
}

test('real executable rejects adversarial bodies, bounds partial HTTP load, and recovers its SQLite owner', { timeout: 35_000 }, async t => {
  const h = await runtime(t);
  const initial = statSync(join(h.dataDirectory, 'ownership.sqlite')).size;
  const malformed = await exchange(h.port, '/mcp/auth/oauth2/register', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"client_name":"\u0000private sentinel"}' });
  assert.ok(malformed.status >= 400 && malformed.status < 500);
  assert.ok(!malformed.body.includes('private sentinel'));
  const tooLarge = await exchange(h.port, '/mcp/auth/oauth2/register', { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(runtimeLimits.maxBodyBytes + 1) },
    body: 'x'.repeat(runtimeLimits.maxBodyBytes + 1) });
  assert.equal(tooLarge.status, 413);
  const occupied = Array.from({ length: runtimeLimits.maxConcurrentRequests }, () => partial(h.port, 128));
  t.after(() => occupied.forEach(req => req.destroy()));
  await Promise.all(occupied.map(req => once(req, 'socket')));
  const overload = await exchange(h.port, '/mcp/health');
  assert.equal(overload.status, 503);
  occupied.forEach(req => req.destroy());
  assert.equal((await exchange(h.port, '/mcp/health')).status, 200);
  assert.equal(statSync(join(h.dataDirectory, 'ownership.sqlite')).size, initial);
  for (const secret of [h.keys.providerSecret, readFileSync(h.keyFile, 'utf8'), 'private sentinel']) {
    assert.ok(!h.output().includes(secret));
  }
});

test('a slow body is closed by the request deadline and SIGTERM drains accepted work', { timeout: 35_000 }, async t => {
  const h = await runtime(t);
  const slow = partial(h.port, 128); t.after(() => slow.destroy());
  const started = Date.now();
  const settled = new Promise<number | null>(resolve => {
    slow.once('response', response => { response.resume(); resolve(response.statusCode ?? null); });
    slow.once('close', () => resolve(null));
  });
  const status = await settled;
  const elapsed = Date.now() - started;
  assert.ok(status === 408 || status === null, `slow body status ${status}`);
  assert.ok(elapsed >= 8_000 && elapsed < 14_000, `slow body elapsed ${elapsed}ms`);
  assert.equal((await exchange(h.port, '/mcp/health')).status, 200);
  const accepted = request({ host: '127.0.0.1', port: h.port, path: '/mcp/auth/oauth2/register', method: 'POST',
    headers: { host, expect: '100-continue', 'content-type': 'application/json', 'content-length': '2' } });
  accepted.on('error', () => undefined); t.after(() => accepted.destroy());
  const admitted = once(accepted, 'continue'); accepted.flushHeaders(); await admitted;
  const response = new Promise<number>(resolve => accepted.once('response', incoming => { incoming.resume(); resolve(incoming.statusCode!); }));
  h.child.kill('SIGTERM');
  accepted.end('{}');
  assert.equal(await response, 503);
  assert.equal(await h.exited, 0);
  assert.match(h.output(), /MCP service stopped\./);
  await assert.rejects(exchange(h.port, '/mcp/health'));
});

test('a dropped MCP stream retains one durable operation and the next authorized call succeeds', { timeout: 40_000 }, async t => {
  const h = await fullService(t);
  const account = await h.account();
  const board = await createBoard({ db: account.seed, ...h.ports }, {
    commandId: randomUUID() as CommandId, title: 'synthetic dropped stream', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10,
  });
  assert.ok(board.ok);
  await account.sync();
  const { context } = await account.authorize();
  const client = await account.connect();
  const operationId = randomUUID();
  const dropped = await new Promise<{ status: number; contentType: string }>((resolve, reject) => {
    const url = new URL(h.publicOrigin);
    const req = request({ host: url.hostname, port: Number(url.port), path: '/mcp', method: 'POST',
      headers: { authorization: `Bearer ${account.provider.tokens()!.access_token}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, response => {
      const details = { status: response.statusCode!, contentType: String(response.headers['content-type']) };
      response.destroy(); resolve(details);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'create_checkin', arguments: { operationId, habitId: board.value.boardId, timeZone: 'UTC' },
    } }));
  });
  assert.equal(dropped.status, 200);
  assert.match(dropped.contentType, /text\/event-stream/);
  const replay = await client.callTool({ name: 'create_checkin', arguments: {
    operationId, habitId: board.value.boardId, timeZone: 'UTC',
  } });
  assert.equal(replay.isError, undefined, JSON.stringify(replay));
  const receipt = (replay.structuredContent as { data: { operationId: string; result: { checkinId: string } } }).data;
  assert.equal(receipt.operationId, operationId);
  const productPath = join(accountDirectory(h.replicas, context.accountId), 'product.sqlite');
  const db = new DatabaseSync(productPath, { readOnly: true });
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM check_ins WHERE id = ?').get(receipt.result.checkinId);
    assert.equal(count?.n, 1);
    const all = db.prepare('SELECT COUNT(*) AS n FROM check_ins WHERE board_id = ?').get(board.value.boardId);
    assert.equal(all?.n, 1);
  } finally { db.close(); }
  const next = await client.callTool({ name: 'get_operation', arguments: { operationId } });
  assert.equal(next.isError, undefined, JSON.stringify(next));
  assert.equal((next.structuredContent as { data: { operationId: string } }).data.operationId, operationId);
});

test('real account SQLite refuses low disk and a competing process lock, then recovers after upstream timeout', { timeout: 35_000 }, async t => {
  const h = await fullService(t);
  const account = await h.account();
  const { context } = await account.authorize();
  const title = 'synthetic resource account';
  const board = await createBoard({ db: account.seed, ...h.ports }, {
    commandId: randomUUID() as CommandId, title, symbol: 'star.fill', accentHex: '#70A7FF',
    usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0,
    metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10,
  });
  assert.ok(board.ok); await account.sync();
  const read = async (actor: AccountActors) => actor.withAccount(context, {}, async ({ db }) =>
    (await db.getAllAsync<{ title: string }>('SELECT title FROM boards')).map(row => row.title));
  assert.deepEqual((await read(h.accounts)).data, [title]);
  await h.accounts.close();
  const backendUrl = 'https://snapback.synthetic.test';
  const backendFetch: typeof fetch = (input, init) => {
    const incoming = new Request(input, init), url = new URL(incoming.url);
    assert.equal(url.origin, backendUrl);
    return fetch(h.host.url + url.pathname + url.search, incoming);
  };
  const actors: AccountActors[] = [];
  const makeActor = (options: ConstructorParameters<typeof AccountActors>[0]) => {
    const actor = new AccountActors(options); actors.push(actor); return actor;
  };
  t.after(async () => { await Promise.all(actors.map(actor => actor.close())); });
  const base = { root: h.replicas, backendUrl, fetch: backendFetch, minFreeBytes: 1024 * 1024 };
  const productPath = join(accountDirectory(h.replicas, context.accountId), 'product.sqlite');
  const initial = readFileSync(productPath);
  await assert.rejects(read(makeActor({ ...base, minFreeBytes: Number.MAX_SAFE_INTEGER })), { code: 'UNAVAILABLE' });
  assert.deepEqual(readFileSync(productPath), initial);
  const holderScript = `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; PRAGMA user_version = 1');
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });`;
  const lockPath = join(accountDirectory(h.replicas, context.accountId), 'replica.sqlite');
  const holder = spawn(node, ['-e', holderScript, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let holderError = '';
  holder.stderr!.on('data', chunk => { holderError += chunk; });
  const holderExited = new Promise<number | null>(resolve => holder.once('exit', resolve));
  t.after(async () => { if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGTERM'); await holderExited; } });
  const [locked] = await once(holder.stdout!, 'data');
  assert.match(String(locked), /locked/, holderError);
  assert.equal(holder.exitCode, null, holderError);
  const probe = spawnSync(node, ['-e', "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')", lockPath], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(probe.status, 0, probe.stderr);
  const busy = makeActor({ ...base, requestTimeoutMs: 1000 });
  await assert.rejects(read(busy), { code: 'UNAVAILABLE' });
  holder.kill('SIGTERM'); assert.equal(await holderExited, 0, holderError);
  await busy.close();
  let aborted = false;
  const stalled = makeActor({ ...base, pullTimeoutMs: 100, requestTimeoutMs: 1500,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
  const started = Date.now();
  await assert.rejects(read(stalled), { code: 'UNAVAILABLE' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
  await stalled.close();
  assert.deepEqual((await read(makeActor(base))).data, [title]);
  assert.deepEqual(readFileSync(productPath), initial);
});

test('account shutdown completes an admitted write after a paused upstream upload', { timeout: 35_000 }, async t => {
  const h = await fullService(t);
  const account = await h.account();
  const board = await createBoard({ db: account.seed, ...h.ports }, {
    commandId: randomUUID() as CommandId, title: 'synthetic shutdown operation', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10,
  });
  assert.ok(board.ok); await account.sync();
  const { context } = await account.authorize();
  const client = await account.connect();
  const originalFetch = globalThis.fetch;
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!held && url.pathname === '/m/uploadRecord') {
      held = true; entered(); await resume;
    }
    return originalFetch(input, init);
  };
  t.after(() => { release(); globalThis.fetch = originalFetch; });
  const operationId = randomUUID();
  const call = client.callTool({ name: 'create_checkin', arguments: {
    operationId, habitId: board.value.boardId, timeZone: 'UTC',
  } });
  let uploadDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([paused, new Promise<never>((_resolve, reject) => {
      uploadDeadline = setTimeout(() => reject(new Error('synthetic upload was not reached')), 5000);
    })]);
  } finally { clearTimeout(uploadDeadline); }
  const productPath = join(accountDirectory(h.replicas, context.accountId), 'product.sqlite');
  const beforeClose = new DatabaseSync(productPath, { readOnly: true });
  try { assert.equal(beforeClose.prepare('SELECT COUNT(*) AS n FROM check_ins WHERE board_id = ?').get(board.value.boardId)?.n, 1); }
  finally { beforeClose.close(); }
  let closed = false;
  const shutdown = h.accounts.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(closed, false);
  release();
  const result = await call;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal((result.structuredContent as { data: { operationId: string } }).data.operationId, operationId);
  await shutdown;
  globalThis.fetch = originalFetch;
  const settled = new DatabaseSync(productPath, { readOnly: true });
  try { assert.equal(settled.prepare('SELECT COUNT(*) AS n FROM check_ins WHERE board_id = ?').get(board.value.boardId)?.n, 1); }
  finally { settled.close(); }
});
