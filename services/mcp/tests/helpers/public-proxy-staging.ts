// explicit public proxy fixture for the reviewed oracle release.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { signup } from 'snapback4/auth';
import { authorizeSynthetic, syntheticOAuthClient } from './oauth';

const origin = 'https://habits.ramimaalouf.com';
const root = process.env.MCP_PUBLIC_PROOF_ROOT;
const marker = 'held-tools-list-response-20261031';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type ProbeRecord = { status?: number; firstChunkAt?: number; releasedAt?: number;
  upstreamEndAt?: number; downstreamClosedAt?: number; upstreamClosedAt?: number;
  bytesMatch?: boolean; upstreamBytes?: number; forwardedBytes?: number; error?: string };

function counters(path: string) {
  const probes: Record<string, ProbeRecord> = {};
  const save = () => writeFileSync(path, JSON.stringify({ probes }, null, 2) + '\n', { mode: 0o600 });
  const record = (id: string, values: ProbeRecord) => { Object.assign(probes[id] ??= {}, values); save(); };
  save();
  return record;
}

async function forwarder(listenHost: string, listenPort: number, upstreamPort: number,
  counterPath: string, holdMs: number) {
  const record = counters(counterPath);
  const server = createServer((incoming, outgoing) => {
    const id = incoming.headers['x-habit-mcp-probe-id'];
    const selected = incoming.headers['x-habit-mcp-response-probe'] === marker &&
      (id === 'flush' || id === 'cancel') && incoming.method === 'POST' && incoming.url === '/mcp';
    const headers = { ...incoming.headers };
    delete headers['x-habit-mcp-response-probe'];
    delete headers['x-habit-mcp-probe-id'];
    let upstreamResponse: IncomingMessage | undefined;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sourceHash = createHash('sha256'), targetHash = createHash('sha256');
    let sourceBytes = 0, targetBytes = 0;
    const upstream = httpRequest({ host: '127.0.0.1', port: upstreamPort, path: incoming.url,
      method: incoming.method, headers, timeout: 10_000 }, answer => {
      upstreamResponse = answer;
      if (!selected) {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
        return;
      }
      const probeId = String(id);
      record(probeId, { status: answer.statusCode });
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      const forward = (chunk: Buffer) => {
        sourceHash.update(chunk); sourceBytes += chunk.length;
        outgoing.write(chunk); targetHash.update(chunk); targetBytes += chunk.length;
      };
      const drain = () => {
        let chunk: Buffer | null;
        while ((chunk = answer.read()) !== null) forward(chunk);
      };
      answer.on('readable', () => {
        if (released) { drain(); return; }
        if (timer) return;
        const first = answer.read(1) as Buffer | null;
        if (!first) return;
        forward(first);
        record(probeId, { firstChunkAt: Date.now() });
        timer = setTimeout(() => {
          timer = undefined;
          if (outgoing.destroyed) return;
          released = true;
          record(probeId, { releasedAt: Date.now() });
          drain();
        }, holdMs);
      });
      answer.on('end', () => {
        const bytesMatch = sourceBytes === targetBytes && sourceHash.digest('hex') === targetHash.digest('hex');
        record(probeId, { upstreamEndAt: Date.now(), bytesMatch,
          upstreamBytes: sourceBytes, forwardedBytes: targetBytes });
        outgoing.end();
      });
      answer.on('close', () => record(probeId, { upstreamClosedAt: Date.now() }));
    });
    upstream.on('timeout', () => upstream.destroy(Error('upstream timeout')));
    upstream.on('error', () => {
      if (selected) record(String(id), { error: 'upstream_error' });
      if (!outgoing.headersSent) outgoing.writeHead(502);
      if (!outgoing.destroyed) outgoing.end();
    });
    outgoing.on('close', () => {
      if (outgoing.writableEnded) return;
      if (timer) clearTimeout(timer);
      if (selected) record(String(id), { downstreamClosedAt: Date.now() });
      upstreamResponse?.destroy();
      upstream.destroy();
    });
    if (!selected) { incoming.pipe(upstream); return; }
    const parts: Buffer[] = [];
    let bytes = 0;
    incoming.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16_384) {
        incoming.destroy();
        upstream.destroy();
        return;
      }
      parts.push(chunk);
    });
    incoming.on('end', () => {
      const body = Buffer.concat(parts);
      let parsed: { method?: string };
      try { parsed = JSON.parse(body.toString()); } catch { parsed = {}; }
      if (parsed.method !== 'tools/list') {
        upstream.destroy();
        outgoing.writeHead(400); outgoing.end();
        return;
      }
      upstream.end(body);
    });
  });
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(listenPort, listenHost, ok));
  return server;
}

function assertHeld(firstByteMs: number, endMs: number, holdMs: number) {
  assert.ok(firstByteMs > 0 && firstByteMs < 1500, 'first response byte was not flushed promptly');
  assert.ok(endMs - firstByteMs >= holdMs - 150, 'response completed before the configured hold');
}

function post(headers: Record<string, string>, body: string, cancelOnFirstByte = false, splitBody = false) {
  return new Promise<{ status: number; firstByteMs: number; endMs?: number; contentType?: string; body?: string }>((ok, fail) => {
    const started = performance.now();
    let settled = false;
    const complete = (value: { status: number; firstByteMs: number; endMs?: number;
      contentType?: string; body?: string }) => { if (!settled) { settled = true; ok(value); } };
    const outgoing = httpsRequest(origin + '/mcp', { method: 'POST', headers, timeout: 10_000 }, answer => {
      const chunks: Buffer[] = [];
      let firstByteMs = 0;
      answer.on('data', (chunk: Buffer) => {
        firstByteMs ||= performance.now() - started;
        if (cancelOnFirstByte) {
          complete({ status: answer.statusCode ?? 0, firstByteMs });
          outgoing.destroy();
          return;
        }
        chunks.push(chunk);
      });
      answer.on('end', () => complete({ status: answer.statusCode ?? 0, firstByteMs,
        endMs: performance.now() - started, contentType: String(answer.headers['content-type']),
        body: Buffer.concat(chunks).toString() }));
      answer.on('error', fail);
    });
    outgoing.on('error', error => { if (!settled) fail(error); });
    outgoing.on('timeout', () => outgoing.destroy(Error('public proxy request timed out')));
    if (splitBody) {
      outgoing.write(body.slice(0, 1));
      setTimeout(() => outgoing.end(body.slice(1)), 2500);
    } else outgoing.end(body);
  });
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await pause(50);
  assert.ok(check(), label);
}

async function probe() {
  assert.ok(root, 'set MCP_PUBLIC_PROOF_ROOT');
  const selectorFile = process.env.MCP_PUBLIC_SELECTOR_FILE;
  assert.ok(selectorFile, 'set MCP_PUBLIC_SELECTOR_FILE');
  const selector = readFileSync(selectorFile, 'utf8').trim();
  assert.ok(selector.length >= 20, 'missing private route selector');
  const evidence: Record<string, unknown> = { kind: 'public_proxy_staging', at: new Date().toISOString(),
    release: 'b3f05d24f9f58f11e1f5efaa0e17a9d7969c3728', sdk: '2.4.0',
    protocol: '2026-07-28', checks: {} };
  const checks = evidence.checks as Record<string, unknown>;
  const actualFetch = globalThis.fetch;
  let listEnvelope: Record<string, unknown> | undefined;
  let listHeaders: Record<string, string> | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin && (url.pathname.startsWith('/mcp') || url.pathname.startsWith('/.well-known/'))) {
      request.headers.set('X-Habit-MCP-Staging', selector);
      if (url.pathname === '/mcp' && request.method === 'POST') {
        const value = await request.clone().json().catch(() => undefined);
        if (value?.method === 'tools/list') {
          listEnvelope = value;
          listHeaders = Object.fromEntries(request.headers);
        }
      }
    }
    return actualFetch(request);
  };
  let client: Client | undefined;
  try {
    const anonymous = await fetch(origin + '/mcp');
    const challenge = anonymous.headers.get('www-authenticate') ?? '';
    checks.anonymous = { status: anonymous.status, challengePresent:
      challenge.includes('/.well-known/oauth-protected-resource/mcp') };
    assert.equal(anonymous.status, 401);
    assert.equal((checks.anonymous as { challengePresent: boolean }).challengePresent, true);
    const resource = await fetch(origin + '/.well-known/oauth-protected-resource/mcp');
    const authorization = await fetch(origin + '/.well-known/oauth-authorization-server/mcp/auth');
    checks.metadata = { resourceStatus: resource.status, authorizationStatus: authorization.status };
    assert.equal(resource.status, 200); assert.equal(authorization.status, 200);
    const foreign = await fetch(origin + '/mcp', { headers: { origin: 'https://invalid.example' } });
    checks.invalidOrigin = { status: foreign.status };
    assert.equal(foreign.status, 403);
    const selectorFree = await actualFetch(origin + '/mcp/health');
    checks.selectorFree = { status: selectorFree.status };
    assert.equal(selectorFree.status, 404);
    const credentials = { email: `mcp-public-proof-${randomUUID()}@example.test`,
      password: randomBytes(32).toString('base64url') };
    assert.equal((await signup(origin, credentials.email, credentials.password)).ok, true);
    const provider = syntheticOAuthClient('Synthetic public proxy response proof');
    await authorizeSynthetic(origin + '/mcp', provider, credentials);
    client = new Client({ name: 'synthetic-public-response-proof', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    checks.sdk = { connected: true, toolCount: tools.length };
    assert.equal(tools.length, 15);
    const read = await client.callTool({ name: 'list_habits', arguments: { freshness: 'require_sync' } });
    assert.equal(read.isError, undefined);
    checks.read = { ok: true };
    const denied = await client.callTool({ name: 'create_checkin',
      arguments: { operationId: randomUUID(), habitId: randomUUID() } });
    const code = (denied.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
    checks.scope = { code };
    assert.equal(code, 'FORBIDDEN');
    assert.ok(listEnvelope && listHeaders, 'sdk request envelope was not captured');
    const body = JSON.stringify({ ...listEnvelope, id: 8481 });
    const headers = { ...listHeaders, 'content-length': String(Buffer.byteLength(body)) };
    const delayedBody = body.padEnd(2048);
    const delayed = await post({ ...headers, 'content-length': String(Buffer.byteLength(delayedBody)) },
      delayedBody, false, true);
    checks.delayedBody = { status: delayed.status, firstByteMs: delayed.firstByteMs,
      endMs: delayed.endMs };
    assert.equal(delayed.status, 200);
    assert.ok(delayed.firstByteMs >= 2400, 'delayed request body was not held');
    const heldHeaders = { ...headers, 'x-habit-mcp-response-probe': marker,
      'x-habit-mcp-probe-id': 'flush' };
    const held = await post(heldHeaders, body);
    assert.equal(held.status, 200);
    assertHeld(held.firstByteMs, held.endMs ?? 0, 3000);
    assert.ok(held.contentType?.includes('application/json'));
    assert.equal(JSON.parse(held.body ?? '{}').result?.tools?.length, 15);
    const counterPath = root + '/forwarder-counters.json';
    const state = () => JSON.parse(readFileSync(counterPath, 'utf8')) as { probes: Record<string, ProbeRecord> };
    await until(() => state().probes.flush?.bytesMatch === true, 'forwarder did not preserve response bytes');
    const flushRecord = state().probes.flush;
    assert.ok(flushRecord.firstChunkAt && flushRecord.releasedAt &&
      flushRecord.releasedAt - flushRecord.firstChunkAt >= 2850,
    'forwarder released the response before the hold elapsed');
    assert.equal(flushRecord.upstreamBytes, flushRecord.forwardedBytes);
    checks.responseFlush = { status: held.status, firstByteMs: Math.round(held.firstByteMs),
      endMs: Math.round(held.endMs ?? 0), forwarder: flushRecord };
    const cancel = await post({ ...headers, 'x-habit-mcp-response-probe': marker,
      'x-habit-mcp-probe-id': 'cancel' }, body, true);
    assert.equal(cancel.status, 200);
    assert.ok(cancel.firstByteMs > 0 && cancel.firstByteMs < 1500);
    await until(() => Boolean(state().probes.cancel?.downstreamClosedAt &&
      state().probes.cancel?.upstreamClosedAt), 'cancel did not close both proxy legs');
    const cancelRecord = state().probes.cancel;
    assert.ok(cancelRecord.firstChunkAt && cancelRecord.downstreamClosedAt &&
      cancelRecord.downstreamClosedAt >= cancelRecord.firstChunkAt, 'client did not abort during the hold');
    assert.ok(cancelRecord.upstreamClosedAt &&
      cancelRecord.upstreamClosedAt >= cancelRecord.downstreamClosedAt,
    'upstream did not close after downstream cancellation');
    assert.equal(cancelRecord.releasedAt, undefined, 'response was released before client cancellation');
    assert.equal(cancelRecord.upstreamEndAt, undefined, 'upstream completed before client cancellation');
    checks.responseCancel = { firstByteMs: Math.round(cancel.firstByteMs),
      forwarder: cancelRecord };
    const health = await fetch(origin + '/mcp/health');
    assert.equal(health.status, 200);
    const recovered = await client.callTool({ name: 'list_habits', arguments: {} });
    assert.equal(recovered.isError, undefined);
    checks.recovery = { healthStatus: health.status, readOk: true };
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await client?.close();
    globalThis.fetch = actualFetch;
    writeFileSync(root + '/public-proxy-evidence.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: evidence.ok, evidence: root + '/public-proxy-evidence.json',
      error: evidence.error ?? null }) + '\n');
  }
}

async function selfTest() {
  const upstream = createServer((_request, response) => {
    const body = JSON.stringify({ jsonrpc: '2.0', result: { tools: Array(15).fill({ name: 'fixture' }) } });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
  const upstreamPort = (upstream.address() as { port: number }).port;
  async function trial(holdMs: number) {
    const path = '/tmp/mcp-public-proxy-self-test-' + randomUUID() + '.json';
    const server = await forwarder('127.0.0.1', 0, upstreamPort, path, holdMs);
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise<{ first: number; end: number }>((ok, fail) => {
        const start = performance.now(); let first = 0;
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/mcp',
          headers: { 'x-habit-mcp-response-probe': marker, 'x-habit-mcp-probe-id': 'flush' } }, response => {
          response.on('data', () => { first ||= performance.now() - start; });
          response.on('end', () => ok({ first, end: performance.now() - start }));
        });
        req.on('error', fail);
        req.end(JSON.stringify({ method: 'tools/list' }));
      });
    } finally {
      await new Promise<void>(ok => server.close(() => ok()));
      rmSync(path, { force: true });
    }
  }
  try {
    const broken = await trial(0);
    assert.throws(() => assertHeld(broken.first, broken.end, 3000), /response completed before/);
    const held = await trial(300);
    assertHeld(held.first, held.end, 300);
    process.stdout.write('self-test: unheld response rejected; held response accepted\n');
  } finally { await new Promise<void>(ok => upstream.close(() => ok())); }
}

if (process.argv[2] === 'forwarder') {
  assert.ok(root, 'set MCP_PUBLIC_PROOF_ROOT');
  await forwarder('127.0.0.1', 4413, 4415, root + '/forwarder-counters.json', 3000);
  process.stdout.write('fixture forwarder ready on loopback 4413\n');
} else if (process.argv[2] === 'probe') await probe();
else if (process.argv[2] === 'self-test') await selfTest();
else throw Error('choose forwarder, probe, or self-test');
