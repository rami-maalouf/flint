import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport, discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client';
import { CredentialVault } from '../src/auth/vault';
import { loadMcpConfig, loadMcpKeys } from '../src/config';
import { runtimeLimits, startMcpService } from '../src/startup';

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-startup-')));
  chmodSync(directory, 0o700);
  const dataDirectory = join(directory, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const configPath = join(directory, 'config.json');
  const keyFile = join(directory, 'keys.json');
  const config = { version: 1 as const, publicOrigin: 'https://habits.example.test',
    backendUrl: 'https://backend.example.test', dataDirectory, keyFile, port: 4413 };
  const keys = { version: 1, providerSecret: randomBytes(48).toString('base64'),
    cursorKey: randomBytes(32).toString('base64'), activeVaultKeyVersion: 'v1',
    vaultKeys: { v1: randomBytes(32).toString('base64') } };
  const saveConfig = (value: unknown = config) => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  const saveKeys = (value: unknown = keys) => writeFileSync(keyFile, JSON.stringify(value), { mode: 0o600 });
  saveConfig(); saveKeys();
  return { directory, dataDirectory, configPath, keyFile, config, keys, saveConfig, saveKeys,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('private versioned config and external keys load without creating or changing credentials', t => {
  const f = fixture(); t.after(f.cleanup);
  const before = readFileSync(f.keyFile);
  assert.deepEqual(loadMcpConfig(f.configPath), f.config);
  const keys = loadMcpKeys(f.config);
  assert.equal(keys.providerSecret, f.keys.providerSecret);
  assert.equal(keys.cursorKey.byteLength, 32);
  assert.equal(keys.vaultKeys.get('v1')?.byteLength, 32);
  assert.deepEqual(readFileSync(f.keyFile), before);
});

test('config rejects unknown fields, unbounded input, unsafe URLs, paths, and production port zero', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const changed of [
    { unknown: true }, { password: 'synthetic-secret' }, { version: 2 }, { port: 0 }, { port: 65536 },
    { publicOrigin: 'http://habits.example.test' }, { publicOrigin: 'https://habits.example.test/' },
    { publicOrigin: 'https://user:synthetic@habits.example.test' }, { backendUrl: 'https://backend.example.test/path' },
    { backendUrl: 'https://backend.example.test?token=synthetic' }, { dataDirectory: 'relative' },
    { keyFile: join(f.dataDirectory, 'keys.json') }, { keyFile: 'relative' },
  ]) {
    f.saveConfig({ ...f.config, ...changed });
    assert.throws(() => loadMcpConfig(f.configPath), { message: 'MCP configuration is invalid.' });
  }
  writeFileSync(f.configPath, ' '.repeat(16_385));
  assert.throws(() => loadMcpConfig(f.configPath), { message: 'MCP configuration is invalid.' });
  assert.throws(() => loadMcpConfig('relative'), { message: 'MCP configuration is invalid.' });
  writeFileSync(f.configPath, JSON.stringify(f.config).replace('"version":1', '"version":2,"version":1'));
  assert.throws(() => loadMcpConfig(f.configPath), { message: 'MCP configuration is invalid.' });
});

test('key formats fail closed before use and return only fixed safe errors', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const changed of [
    { version: 2 }, { unknown: 'synthetic' }, { providerSecret: 'short' },
    { cursorKey: randomBytes(31).toString('base64') }, { cursorKey: f.keys.cursorKey + '\n' },
    { activeVaultKeyVersion: 'missing' }, { vaultKeys: {} }, { vaultKeys: { v1: 'synthetic-invalid' } },
  ]) {
    f.saveKeys({ ...f.keys, ...changed });
    assert.throws(() => loadMcpKeys(f.config), { message: 'MCP key file is invalid.' });
  }
  writeFileSync(f.keyFile, '{"providerSecret":"synthetic-leak');
  assert.throws(() => loadMcpKeys(f.config), { message: 'MCP key file is invalid.' });
  writeFileSync(f.keyFile, ' '.repeat(65_537));
  assert.throws(() => loadMcpKeys(f.config), { message: 'MCP key file is invalid.' });
});

test('private file validation rejects symlinks, hardlinks, unsafe modes, and unsafe directory ancestors', t => {
  const f = fixture(); t.after(f.cleanup);
  chmodSync(f.keyFile, 0o644);
  assert.throws(() => loadMcpKeys(f.config), { message: 'MCP storage must be private.' });
  chmodSync(f.keyFile, 0o600);
  const hardlink = join(f.directory, 'hardlink'); linkSync(f.keyFile, hardlink);
  assert.throws(() => loadMcpKeys(f.config), { message: 'MCP storage must be private.' });
  rmSync(hardlink);
  const alias = join(f.directory, 'alias'); symlinkSync(f.keyFile, alias);
  assert.throws(() => loadMcpKeys({ ...f.config, keyFile: alias }), { message: 'MCP storage must be private.' });
  const parentAlias = join(f.directory, 'alias-directory'); symlinkSync(f.directory, parentAlias);
  assert.throws(() => loadMcpConfig(join(parentAlias, 'config.json')), { message: 'MCP storage must be private.' });
  chmodSync(f.configPath, 0o640);
  assert.throws(() => loadMcpConfig(f.configPath), { message: 'MCP storage must be private.' });
  chmodSync(f.configPath, 0o600); chmodSync(f.dataDirectory, 0o755);
  assert.throws(() => loadMcpConfig(f.configPath), { message: 'MCP storage must be private.' });
});

function http(port: number, path: string, options: { host?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: options.host ?? 'habits.example.test', ...options.headers }, timeout: 3000 }, response => {
      const parts: Buffer[] = [];
      response.on('data', chunk => parts.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('synthetic request timed out')));
    req.on('error', reject); req.end(options.body);
  });
}
function proxyFetch(port: number): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://habits.example.test');
    const headers = Object.fromEntries(new Headers(input instanceof Request ? input.headers : init?.headers));
    const result = await http(port, url.pathname + url.search, { method: init?.method ?? 'GET', headers,
      body: init?.body as string | undefined });
    return new Response(result.body, { status: result.status, headers: result.headers as Record<string, string> });
  };
}

test('GET and HEAD reject body framing before dispatch without consuming an unbounded stream', async t => {
  const f = fixture(); t.after(f.cleanup);
  const service = await startMcpService({ ...f.config, port: 0 }, { allowTestPort: true });
  t.after(() => service.close());
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/mcp/health', '/mcp', '/.well-known/oauth-protected-resource/mcp']) {
      for (const size of [1, runtimeLimits.maxBodyBytes + 1]) {
        const framed = await http(service.address.port, path, { method,
          headers: { 'transfer-encoding': 'chunked' }, body: 'x'.repeat(size) });
        assert.equal(framed.status, 400, `${method} ${path} chunked ${size}`);
        assert.equal(framed.headers.connection, 'close');
      }
      const framed = await http(service.address.port, path, { method,
        headers: { 'content-length': '1' }, body: 'x' });
      assert.equal(framed.status, 400, `${method} ${path} content-length`);
    }
  }
  assert.equal((await http(service.address.port, '/mcp/health')).status, 200);
  assert.equal((await http(service.address.port, '/mcp/health', { headers: { 'content-length': '0' } })).status, 200);
});

test('factory binds loopback, exposes generic readiness, fixes HTTPS discovery, and bounds malformed traffic', { timeout: 15_000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const service = await startMcpService({ ...f.config, port: 0 }, { allowTestPort: true });
  t.after(() => service.close());
  assert.equal(service.address.address, '127.0.0.1');
  const port = service.address.port;
  assert.deepEqual(JSON.parse((await http(port, '/mcp/health')).body), { status: 'ok' });
  assert.deepEqual(JSON.parse((await http(port, '/mcp/ready')).body), { status: 'ready' });
  assert.equal((await http(port, '/mcp', { host: 'attacker.example.test' })).status, 403);
  const challenge = await http(port, '/mcp', { headers: { 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'http' } });
  assert.equal(challenge.status, 401);
  assert.match(String(challenge.headers['www-authenticate']), /https:\/\/habits\.example\.test\/\.well-known\/oauth-protected-resource\/mcp/);
  const fetchFn = proxyFetch(port);
  const resource = await discoverOAuthProtectedResourceMetadata('https://habits.example.test/mcp', {}, fetchFn);
  assert.equal(resource.resource, 'https://habits.example.test/mcp');
  const metadata = await discoverAuthorizationServerMetadata(resource.authorization_servers![0], { fetchFn });
  assert.equal(metadata!.issuer, 'https://habits.example.test/mcp/auth');
  const client = new Client({ name: 'synthetic-startup', version: '1' });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(resource.resource), { fetch: fetchFn })));
  await client.close();
  assert.equal((await http(port, '/mcp', { headers: { oversized: 'x'.repeat(17_000) } })).status, 431);
  assert.equal((await http(port, '/mcp', { method: 'POST', body: 'x'.repeat(65_537),
    headers: { 'content-type': 'application/json', 'content-length': '65537' } })).status, 413);
  assert.equal((await http(port, '/mcp', { method: 'POST', body: 'x'.repeat(65_537),
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })).status, 413);
  assert.equal((await http(port, '/mcp', { headers: Object.fromEntries(Array.from({ length: 66 }, (_, index) => [`x-${index}`, '1'])) })).status, 431);
  await service.close(); await service.close();
  assert.equal((await service.fetch(new Request(f.config.publicOrigin + '/mcp/ready'))).status, 503);
  await assert.rejects(http(port, '/mcp/health'));
});

test('same-process duplicate ownership refuses before opening shared provider, vault, or actors', async t => {
  const f = fixture(); t.after(f.cleanup);
  const config = { ...f.config, port: 0 };
  const service = await startMcpService(config, { allowTestPort: true });
  t.after(() => service.close());
  await assert.rejects(startMcpService(config, { allowTestPort: true }), { message: 'MCP data directory is already in use.' });
  const outsider = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(join(f.dataDirectory, 'ownership.sqlite'))});
     try { db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); process.exitCode = 2; }
     catch (error) { process.exitCode = error.errcode === 5 ? 0 : 3; } finally { db.close(); }`], { encoding: 'utf8', timeout: 3000 });
  assert.equal(outsider.status, 0, outsider.stderr);
  assert.equal((await http(service.address.port, '/mcp/ready')).status, 200);
  await service.close();
  const restarted = await startMcpService(config, { allowTestPort: true }); await restarted.close();
});

test('shutdown refuses an accepted exchange while draining the existing connection', { timeout: 10_000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const service = await startMcpService({ ...f.config, port: 0 }, { allowTestPort: true }); t.after(() => service.close());
  const req = request({ host: '127.0.0.1', port: service.address.port, path: '/mcp/auth/oauth2/register', method: 'POST',
    headers: { host: 'habits.example.test', expect: '100-continue', 'content-type': 'application/json', 'content-length': '2' } });
  t.after(() => req.destroy());
  const response = new Promise<number>(resolve => req.once('response', response => { response.resume(); resolve(response.statusCode!); }));
  const accepted = once(req, 'continue'); req.flushHeaders(); await accepted;
  const closed = service.close(); req.end('{}');
  assert.equal(await response, 503); await closed;
  await assert.rejects(http(service.address.port, '/mcp/health'));
});

test('slow headers expire and excess OS connections are dropped', { timeout: 12_000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const service = await startMcpService({ ...f.config, port: 0 }, { allowTestPort: true }); t.after(() => service.close());
  const sockets: Socket[] = [];
  for (let index = 0; index < runtimeLimits.maxConnections; index++) {
    const socket = connect(service.address.port, '127.0.0.1'); sockets.push(socket); await once(socket, 'connect');
  }
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const excess = connect(service.address.port, '127.0.0.1'); sockets.push(excess);
  excess.setTimeout(2000, () => excess.destroy(new Error('excess synthetic connection was not dropped')));
  await once(excess, 'close'); assert.ok(sockets.slice(0, -1).every(socket => !socket.destroyed));
  for (const socket of sockets) socket.destroy();
  const slow = connect(service.address.port, '127.0.0.1'); t.after(() => slow.destroy());
  slow.setTimeout(8000, () => slow.destroy(new Error('slow synthetic header did not expire')));
  let reply = ''; slow.on('data', chunk => { reply += chunk; });
  slow.write('GET /mcp/health HTTP/1.1\r\nHost: habits.example.test\r\n');
  await once(slow, 'close'); assert.match(reply, /^HTTP\/1\.1 408 Request Timeout/);
});

test('unsafe durable files and invalid keys fail without binding or resetting state', async t => {
  const f = fixture(); t.after(f.cleanup);
  const port = await freePort();
  f.saveKeys({ ...f.keys, cursorKey: 'synthetic-invalid' });
  await assert.rejects(startMcpService({ ...f.config, port }), { message: 'MCP key file is invalid.' });
  await assert.rejects(http(port, '/mcp/health'));
  f.saveKeys();
  const file = join(f.dataDirectory, 'provider.sqlite');
  writeFileSync(file, 'synthetic-retained-state', { mode: 0o644 });
  await assert.rejects(startMcpService({ ...f.config, port }), { message: 'MCP storage must be private.' });
  assert.equal(readFileSync(file, 'utf8'), 'synthetic-retained-state');
  await assert.rejects(http(port, '/mcp/health'));
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('actual executable owns all state across processes, SIGKILL releases ownership, and signals drain without resetting keys', { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const serviceDirectory = resolve('services/mcp');
  const built = spawnSync('bun', ['build', 'src/main.ts', '--target=node', '--packages=external', '--outfile=.artifacts/startup-main.mjs'],
    { cwd: serviceDirectory, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const executable = join(serviceDirectory, '.artifacts/startup-main.mjs');
  const port = await freePort(); f.saveConfig({ ...f.config, port });
  const originalKeys = readFileSync(f.keyFile);
  const binding = { backend: f.config.backendUrl, principal: 'synthetic-principal', accountId: 'synthetic-account',
    grantId: 'synthetic-grant', scope: 'read' as const };
  const token = 'synthetic-persisted-session';
  const seed = new CredentialVault({ location: join(f.dataDirectory, 'vault.sqlite'), activeKeyVersion: 'v1',
    keys: new Map([['v1', Buffer.from(f.keys.vaultKeys.v1, 'base64')]]) });
  seed.put(binding, { principal: binding.principal, kind: 'session', token, expiresAt: Date.now() + 60_000, scope: 'read' }); seed.close();
  const children: ChildProcess[] = [];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  function launch(configPath = f.configPath) {
    const child = spawn(process.execPath, [executable], { cwd: serviceDirectory,
      env: { PATH: process.env.PATH, MCP_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    return { child, exited, output: () => output };
  }
  async function ready(child: ReturnType<typeof launch>) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.output().includes('MCP service ready.')) return;
      assert.equal(child.child.exitCode, null, child.output());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('synthetic child did not become ready');
  }
  const first = launch(); await ready(first);
  const metadata = await discoverOAuthProtectedResourceMetadata(f.config.publicOrigin + '/mcp', {}, proxyFetch(port));
  assert.equal(metadata.resource, f.config.publicOrigin + '/mcp');
  const jwksBefore = await http(port, '/mcp/auth/jwks'); assert.equal(jwksBefore.status, 200);
  const duplicate = launch(); assert.equal(await duplicate.exited, 1);
  assert.match(duplicate.output(), /MCP data directory is already in use\./);
  assert.equal((await http(port, '/mcp/ready')).status, 200);
  first.child.kill('SIGKILL'); await first.exited;
  const second = launch(); await ready(second);
  assert.deepEqual(JSON.parse((await http(port, '/mcp/auth/jwks')).body), JSON.parse(jwksBefore.body));
  second.child.kill('SIGTERM'); assert.equal(await second.exited, 0);
  assert.match(second.output(), /MCP service stopped\./);
  await assert.rejects(http(port, '/mcp/ready'));
  const third = launch(); await ready(third); third.child.kill('SIGINT'); assert.equal(await third.exited, 0);
  assert.deepEqual(readFileSync(f.keyFile), originalKeys);
  const vault = new CredentialVault({ location: join(f.dataDirectory, 'vault.sqlite'), activeKeyVersion: 'v1',
    keys: new Map([['v1', Buffer.from(f.keys.vaultKeys.v1, 'base64')]]) });
  assert.equal(vault.get(binding).token, token); vault.close();
  const lock = new DatabaseSync(join(f.dataDirectory, 'ownership.sqlite'));
  assert.equal(lock.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
  lock.exec('BEGIN EXCLUSIVE; ROLLBACK'); lock.close();
  for (const process of [first, duplicate, second, third]) {
    assert.ok(!process.output().includes(token)); assert.ok(!process.output().includes(f.keys.providerSecret));
    assert.ok(!process.output().includes(f.keyFile)); assert.ok(!process.output().includes('SELECT '));
  }
  f.saveConfig({ ...f.config, port, unknown: 'synthetic-secret' });
  const invalid = launch(); assert.equal(await invalid.exited, 1);
  assert.match(invalid.output(), /MCP configuration is invalid\./);
  await assert.rejects(http(port, '/mcp/health'));
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(executable)})`],
    { cwd: serviceDirectory, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
});
