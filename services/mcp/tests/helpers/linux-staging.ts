// explicit linux arm64 synthetic acceptance helper. never imported by the test suite.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe } from 'snapback4/proof';
import { createBoard } from '../../../../src/core/domain/commands';
import type { CommandId } from '../../../../src/core/domain/ids';
import { accountDirectory } from '../../src/accounts/replica';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../../src/core';
import { FileRestoreLatch } from '../../src/operations/recovery-head';
import { readToolNames } from '../../src/tools/reads';
import { authorizeSyntheticWrite } from './write-oauth';
import { authorizeSynthetic, syntheticOAuthClient } from './oauth';

const node = '/home/ubuntu/habit-mcp-proof-20261030/node-v24.22.2-linux-arm64/bin/node';
const cli = '/opt/habit-system-fullstack/snapback4';
const expectedCli = '80bb7af237548866228c7dff6889c7b779b777d1342c76e4b10effa1de88ebcf';
const ports = { main: 4450, publicTls: 4451, backendTls: 4452, snapbackLow: 4453, snapbackHigh: 4455 };
const unit = 'habit-mcp-synthetic-acceptance-20261030';
const ownedRoot = '/home/ubuntu/habit-mcp-staging-acceptance-20261030';
const root = process.env.MCP_STAGING_ROOT ?? ownedRoot;
const fixture = join(root, 'fixture');
const state = join(fixture, 'state');
const backend = join(fixture, 'backend');
const keys = join(fixture, 'keys');
const external = join(root, 'external-restore-latch');
const publicOrigin = `https://127.0.0.1:${ports.publicTls}`;
const backendUrl = `https://127.0.0.1:${ports.backendTls}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence: Record<string, unknown> = { kind: 'synthetic_linux_arm64', artifact: process.env.MCP_STAGING_ARTIFACT_LABEL ?? 'unreviewed_fixture', ports, observations: {} };
const observations = evidence.observations as Record<string, unknown>;
const cleanup: Array<() => Promise<void> | void> = [];

function command(binary: string, args: string[], timeout = 30_000) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout, env: { ...process.env, PATH: process.env.PATH } });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${binary} ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function free(port: number) {
  const probe = createServer();
  try { await new Promise<void>((ok, fail) => probe.once('error', fail).listen(port, '127.0.0.1', ok)); }
  finally { await new Promise<void>(ok => probe.close(() => ok())); }
}
async function close(server: ReturnType<typeof createTlsServer>) {
  server.closeAllConnections();
  await new Promise<void>(ok => server.close(() => ok()));
}
function certs() {
  const dir = join(root, 'tls'); mkdirSync(dir, { mode: 0o700 });
  const caKey = join(dir, 'ca.key'), caCert = join(dir, 'ca.pem');
  const leafKey = join(dir, 'leaf.key'), csr = join(dir, 'leaf.csr'), leafCert = join(dir, 'leaf.pem');
  const ext = join(dir, 'leaf.ext');
  writeFileSync(ext, 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=synthetic-mcp-ca', '-keyout', caKey, '-out', caCert]);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', leafKey, '-out', csr]);
  command('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
    '-out', leafCert, '-days', '1', '-sha256', '-extfile', ext]);
  command('openssl', ['verify', '-CAfile', caCert, leafCert]);
  chmodSync(caKey, 0o600); chmodSync(leafKey, 0o600);
  return { caCert, key: readFileSync(leafKey), cert: readFileSync(leafCert) };
}
function tlsProxy(port: number, destination: URL, tls: { key: Buffer; cert: Buffer },
  hold?: { reached: () => void; release: Promise<void> }, preserveHost = false,
  queryHold?: { armed: () => boolean; reached: () => void; release: Promise<void> }) {
  let heldOnce = false, queryHeld = false;
  const server = createTlsServer(tls, (incoming, response) => {
    const upstream = httpRequest({ hostname: destination.hostname, port: destination.port,
      path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: preserveHost ? incoming.headers.host : destination.host },
      timeout: 15_000 }, answer => {
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
      };
      const selectedHold = hold && !heldOnce && incoming.url?.startsWith('/m/uploadRecord') ? hold :
        queryHold && !queryHeld && queryHold.armed() && incoming.url?.startsWith('/q/') ? queryHold : undefined;
      if (selectedHold) {
        if (selectedHold === hold) heldOnce = true;
        else queryHeld = true;
        const chunks: Buffer[] = [];
        answer.on('data', chunk => chunks.push(Buffer.from(chunk)));
        answer.on('end', () => {
          const heldAt = performance.now();
          selectedHold.reached();
          void selectedHold.release.then(() => {
            if (selectedHold === hold) observations.heldUploadResponseMs = Math.round(performance.now() - heldAt);
            else observations.cancelledQueryHoldMs = Math.round(performance.now() - heldAt);
            if (response.destroyed) return;
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            response.end(Buffer.concat(chunks));
          });
        });
      } else send();
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(upstream);
    response.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
  });
  return new Promise<typeof server>((ok, fail) => server.once('error', fail)
    .listen(port, '127.0.0.1', () => ok(server)));
}
function sample(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  return { rssBytes: rss, fd: readdirSync(`/proc/${pid}/fd`).length,
    cpuTicks: Number(stat[13]) + Number(stat[14]) };
}
async function metrics(pid: number, end: Promise<unknown>) {
  const values: ReturnType<typeof sample>[] = [];
  let active = true; void end.finally(() => { active = false; });
  while (active) { try { values.push(sample(pid)); } catch { break; } await pause(50); }
  const first = values[0], last = values.at(-1);
  return { samples: values.length, peakRssBytes: Math.max(...values.map(v => v.rssBytes)),
    peakFd: Math.max(...values.map(v => v.fd)), cpuTicks: first && last ? last.cpuTicks - first.cpuTicks : 0 };
}
function unitProperty(name: string) { return command('sudo', ['-n', 'systemctl', 'show', unit, `--property=${name}`, '--value']); }
async function waitReady() {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try { const response = await fetch(`${publicOrigin}/mcp/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return; } catch { /* startup is asynchronous */ }
    await pause(100);
  }
  throw Error('synthetic main did not become ready');
}
function startMain(main: string, caCert: string, config: string) {
  assert.equal(unitProperty('LoadState') === 'not-found' || unitProperty('ActiveState') === 'inactive', true,
    `owned transient unit ${unit} already exists`);
  command('sudo', ['-n', 'systemd-run', '--collect', '--unit', unit, '--uid=ubuntu', '--gid=ubuntu',
    '--property=MemoryMax=536870912', '--property=CPUQuota=100%', '--property=TasksMax=128',
    '--property=NoNewPrivileges=yes', `--setenv=MCP_CONFIG_PATH=${config}`,
    `--setenv=NODE_EXTRA_CA_CERTS=${caCert}`, '--working-directory', resolve(main, '..'),
    node, main]);
  const pid = Number(unitProperty('MainPID'));
  assert.ok(pid > 1, 'transient main pid missing');
  assert.equal(unitProperty('MemoryMax'), '536870912');
  assert.equal(unitProperty('CPUQuotaPerSecUSec'), '1s');
  observations.unitLimits = { memoryMaxBytes: Number(unitProperty('MemoryMax')),
    cpuQuota: unitProperty('CPUQuotaPerSecUSec'), tasksMax: Number(unitProperty('TasksMax')) };
  return pid;
}
async function stopMain() {
  if (unitProperty('LoadState') !== 'not-found' && unitProperty('ActiveState') !== 'inactive') {
    command('sudo', ['-n', 'systemctl', 'stop', unit]);
  }
}
function databaseCount(path: string, boardId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM check_ins WHERE board_id = ?').get(boardId)?.n); }
  finally { db.close(); }
}
function receipt(result: { isError?: boolean; structuredContent?: unknown }) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return (result.structuredContent as { data: { operationId: string; state: string; result: { checkinId: string } } }).data;
}
async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function expectedHash(name: string) {
  const value = process.env[name];
  assert.match(value ?? '', /^[a-f0-9]{64}$/, `set ${name} to the reviewed sha256`);
  return value!;
}

async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.22.2'); assert.equal(process.versions.bun, undefined);
  assert.ok(resolve(root) === root && (root === ownedRoot || root.startsWith(ownedRoot + '/')),
    'staging root must stay inside owned subtree');
  assert.equal(await sha256(cli), expectedCli);
  const mainFile = process.env.MCP_STAGING_MAIN, schema = process.env.MCP_STAGING_SCHEMA;
  assert.ok(mainFile && schema && existsSync(mainFile) && existsSync(schema), 'set MCP_STAGING_MAIN and MCP_STAGING_SCHEMA');
  assert.ok(realpathSync(mainFile).startsWith(ownedRoot + '/') && realpathSync(schema).startsWith(ownedRoot + '/'),
    'main and schema must be private staging artifacts');
  const releaseArchive = process.env.MCP_STAGING_RELEASE_ARCHIVE;
  assert.ok(releaseArchive && existsSync(releaseArchive), 'set MCP_STAGING_RELEASE_ARCHIVE');
  const expectedMain = expectedHash('MCP_STAGING_EXPECTED_MAIN_SHA256');
  const expectedSchema = expectedHash('MCP_STAGING_EXPECTED_SCHEMA_SHA256');
  const expectedArchive = expectedHash('MCP_STAGING_EXPECTED_RELEASE_SHA256');
  const expectedSource = expectedHash('MCP_STAGING_EXPECTED_SOURCE_SHA256');
  const expectedCommit = process.env.MCP_STAGING_EXPECTED_RELEASE_COMMIT;
  assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/, 'set MCP_STAGING_EXPECTED_RELEASE_COMMIT');
  const provenancePath = resolve(realpathSync(mainFile), '..', '..', '..', '..', 'PROVENANCE');
  assert.ok(existsSync(provenancePath), 'reviewed release provenance is missing');
  const provenance = Object.fromEntries(readFileSync(provenancePath, 'utf8').trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    assert.ok(separator > 0, 'invalid release provenance');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const observed = { mainSha256: await sha256(mainFile), schemaSha256: await sha256(schema),
    releaseSha256: await sha256(releaseArchive), provenance };
  evidence.release = { expected: { mainSha256: expectedMain, schemaSha256: expectedSchema,
    releaseSha256: expectedArchive, sourceSha256: expectedSource, commit: expectedCommit }, observed };
  assert.equal(observed.mainSha256, expectedMain, 'reviewed main digest mismatch');
  assert.equal(observed.schemaSha256, expectedSchema, 'reviewed schema digest mismatch');
  assert.equal(observed.releaseSha256, expectedArchive, 'reviewed release archive digest mismatch');
  assert.equal(command('tar', ['-xOzf', releaseArchive, './PROVENANCE']),
    readFileSync(provenancePath, 'utf8').trim(), 'extracted provenance differs from release archive');
  assert.equal(provenance.release_sha, expectedCommit, 'release commit mismatch');
  assert.equal(provenance.source_archive_sha256, expectedSource, 'source archive digest mismatch');
  assert.equal(provenance.snapback_binary_sha256, expectedCli, 'release snapback digest mismatch');
  assert.equal(provenance.node_version, '24.22.2', 'release node version mismatch');
  assert.equal(provenance.bun_version, '1.4.3', 'release bun version mismatch');
  assert.equal(process.env.MCP_STAGING_KEEP_FIXTURE === '1' || process.env.MCP_STAGING_KEEP_FIXTURE === undefined, true);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(root), root, 'staging root must be physical');
  chmodSync(root, 0o700);
  for (const path of [fixture, external, join(root, 'tls'), join(root, 'snapback-logs'), join(root, 'seed.sqlite')]) {
    assert.equal(existsSync(path), false, `owned fixture path already exists: ${path}`);
  }
  for (const path of [fixture, state, backend, keys, external]) mkdirSync(path, { mode: 0o700 });
  cleanup.push(() => {
    const paths = process.env.MCP_STAGING_KEEP_FIXTURE === '1' ? ['tls', 'snapback-logs', 'seed.sqlite'] :
      ['fixture', 'external-restore-latch', 'tls', 'snapback-logs', 'seed.sqlite'];
    for (const name of paths) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  });
  for (let port = ports.main; port <= ports.snapbackHigh; port++) await free(port);
  const tls = certs();
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(tls.caCert, 'utf8')]);
  const spawnedEnvironment = { ...process.env, SNAPBACK4_BIN: cli,
    PORT_LO: String(ports.snapbackLow), PORT_HI: String(ports.snapbackHigh) };
  const deployed = await deploy(backend, schema, { logsDir: join(root, 'snapback-logs'), env: spawnedEnvironment,
    args: ['--staging'] });
  assert.equal(deployed.code, 0, deployed.stderr);
  const host = await startServe(backend, { logsDir: join(root, 'snapback-logs'), env: spawnedEnvironment });
  cleanup.push(() => host.stop());
  assert.ok(Number(new URL(host.url).port) >= ports.snapbackLow && Number(new URL(host.url).port) <= ports.snapbackHigh);
  let reached!: () => void, release!: () => void;
  const uploadReached = new Promise<void>(ok => { reached = ok; });
  const uploadRelease = new Promise<void>(ok => { release = ok; });
  cleanup.push(() => release());
  let queryArmed = false, queryReached!: () => void, queryRelease!: () => void;
  const queryEntered = new Promise<void>(ok => { queryReached = ok; });
  const queryWait = new Promise<void>(ok => { queryRelease = ok; });
  cleanup.push(() => queryRelease());
  const backendServer = await tlsProxy(ports.backendTls, new URL(host.url), tls,
    { reached, release: uploadRelease }, false,
    { armed: () => queryArmed, reached: queryReached, release: queryWait });
  cleanup.push(() => close(backendServer));
  const publicServer = await tlsProxy(ports.publicTls, new URL(`http://127.0.0.1:${ports.main}`), tls,
    undefined, true);
  cleanup.push(() => close(publicServer));
  const keyFile = join(keys, 'keys.json'), configFile = join(keys, 'config.json');
  const material = { version: 1, providerSecret: randomBytes(48).toString('base64'),
    cursorKey: randomBytes(32).toString('base64'), activeVaultKeyVersion: 'v1',
    vaultKeys: { v1: randomBytes(32).toString('base64') } };
  writeFileSync(keyFile, JSON.stringify(material), { mode: 0o600 });
  const installationId = randomUUID(), latch = join(external, 'restore-latch');
  FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
  writeFileSync(configFile, JSON.stringify({ version: 2, publicOrigin, backendUrl,
    dataDirectory: state, keyFile, port: ports.main,
    operations: { installationId, latchPath: latch, backendDirectory: backend } }), { mode: 0o600 });
  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
  const signed = await signup(host.url, credentials.email, credentials.password); assert.ok(signed.ok);
  const seed = new NodeSqlDatabase(join(root, 'seed.sqlite'));
  let boardId: string;
  try {
    const corePorts = createCorePorts('UTC');
    assert.ok((await initializeProductDatabase(seed, corePorts.ids, corePorts.hashing)).ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const board = await createBoard({ db: seed, ...corePorts }, { commandId: randomUUID() as CommandId,
      title: 'synthetic linux staging board', symbol: 'star.fill', accentHex: '#70A7FF',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0,
      metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok); boardId = board.value.boardId;
    const upstream = createClient({ url: host.url, token: signed.session.token });
    try {
      const transport = createSnapbackTransport({ connection: async () => ({ client: upstream,
        session: signed.session, isCurrent: () => true }), bind: async () => undefined,
        hash: async value => createHash('sha256').update(value).digest('hex') });
      const result = await runSync({ db: seed, ...corePorts, transport, random: () => 0.5 });
      assert.ok(result.ok && result.value.status === 'up_to_date', JSON.stringify(result));
    } finally { await upstream.close(); }
  } finally { await seed.closeAsync(); }
  cleanup.push(() => stopMain());
  const pid = startMain(mainFile, tls.caCert, configFile);
  await waitReady();
  let stopMonitor!: () => void;
  const monitorEnd = new Promise<void>(ok => { stopMonitor = ok; });
  cleanup.push(() => stopMonitor());
  const measured = metrics(pid, monitorEnd);
  const anonymousStart = performance.now();
  const anonymous = await fetch(`${publicOrigin}/mcp`);
  observations.anonymous = { status: anonymous.status, challenge: anonymous.headers.get('www-authenticate'),
    latencyMs: Math.round(performance.now() - anonymousStart) };
  assert.equal(anonymous.status, 401);
  const provider = syntheticOAuthClient(`synthetic linux staging ${randomUUID()}`);
  await authorizeSyntheticWrite(`${publicOrigin}/mcp`, provider, credentials);
  const client = new Client({ name: 'linux-synthetic-acceptance', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } } }));
  const listStart = performance.now();
  const names = (await client.listTools()).tools.map(tool => tool.name);
  const expectedTools = [...readToolNames, 'create_checkin', 'undo_checkin', 'get_operation',
    'get_reward_claim_preview', 'claim_reward'].sort();
  observations.toolList = { names: names.sort(), latencyMs: Math.round(performance.now() - listStart) };
  assert.deepEqual(names, expectedTools);
  const readStart = performance.now();
  const habits = await client.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(habits.isError, undefined, JSON.stringify(habits));
  observations.readLatencyMs = Math.round(performance.now() - readStart);
  const loadLatencies = await Promise.all(Array.from({ length: 8 }, async () => {
    const started = performance.now();
    const result = await client.callTool({ name: 'list_habits', arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return Math.round(performance.now() - started);
  }));
  observations.boundedReadLoadMs = loadLatencies.sort((a, b) => a - b);
  const accountId = createHash('sha256').update(JSON.stringify([backendUrl, signed.session.principal])).digest('hex');
  const replica = accountDirectory(join(state, 'accounts'), accountId);
  const productPath = join(replica, 'product.sqlite'), journalPath = join(replica, 'journal.sqlite');
  assert.equal(databaseCount(productPath, boardId), 0);
  const holderScript = `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    process.stdout.write('locked\\n');
    process.on('SIGTERM', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
    setInterval(() => {}, 1000);`;
  const holder = spawn(node, ['-e', holderScript, productPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let holderError = ''; holder.stderr!.on('data', part => { holderError += String(part); });
  const holderExited = new Promise<number | null>(ok => holder.once('exit', ok));
  cleanup.push(async () => { if (holder.exitCode === null && holder.signalCode === null) {
    holder.kill('SIGTERM'); await holderExited; } });
  const [holderReady] = await Promise.race([once(holder.stdout!, 'data'),
    pause(5000).then(() => { throw Error(`sqlite lock holder did not start: ${holderError}`); })]);
  assert.match(String(holderReady), /locked/, holderError);
  const busyStart = performance.now();
  const busy = await client.callTool({ name: 'list_habits', arguments: {} });
  observations.busyDb = { refused: busy.isError === true, latencyMs: Math.round(performance.now() - busyStart),
    code: (busy.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? null };
  assert.equal(busy.isError, true, 'busy product database must refuse the read');
  holder.kill('SIGTERM'); assert.equal(await holderExited, 0, holderError);
  const recoveredRead = await client.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(recoveredRead.isError, undefined, JSON.stringify(recoveredRead));
  observations.busyDb = { ...observations.busyDb as object, recovered: true };
  queryArmed = true;
  const controller = new AbortController();
  const cancelledCall = fetch(`${publicOrigin}/mcp`, { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${provider.tokens()!.access_token}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 913, method: 'tools/call', params: {
      name: 'list_habits', arguments: { freshness: 'require_sync' } } }) })
    .then(async response => { await response.text(); return 'completed'; }).catch(() => 'cancelled');
  await Promise.race([queryEntered, pause(10_000).then(() => { throw Error('query hold not reached'); })]);
  await pause(2500);
  controller.abort(); queryRelease();
  observations.cancelledTlsCall = await cancelledCall;
  assert.equal(observations.cancelledTlsCall, 'cancelled');
  assert.equal((await fetch(`${publicOrigin}/mcp/health`)).status, 200);
  const afterCancel = await client.callTool({ name: 'list_habits', arguments: {} });
  assert.equal(afterCancel.isError, undefined, JSON.stringify(afterCancel));
  observations.cancelledTlsRecovered = true;
  const operationId = randomUUID();
  const writeStart = performance.now();
  const call = client.callTool({ name: 'create_checkin', arguments: { operationId, habitId: boardId, timeZone: 'UTC' } });
  await Promise.race([uploadReached, pause(15_000).then(() => { throw Error('upload response not reached'); })]);
  assert.equal(databaseCount(productPath, boardId), 1, 'local effect must precede held upload response');
  const pre = new DatabaseSync(journalPath, { readOnly: true });
  try { observations.journalAtSignal = pre.prepare('SELECT state, delivery FROM operations WHERE operation_id = ?').get(operationId); }
  finally { pre.close(); }
  assert.equal((observations.journalAtSignal as { state?: string } | undefined)?.state, 'pending_sync');
  assert.equal((observations.journalAtSignal as { delivery?: string } | undefined)?.delivery, 'pending');
  const signalAt = Date.now();
  observations.unitAtHold = { memoryCurrentBytes: Number(unitProperty('MemoryCurrent')),
    memoryPeakBytes: Number(unitProperty('MemoryPeak')),
    cpuUsageNSec: Number(unitProperty('CPUUsageNSec')),
    memoryMaxBytes: Number(unitProperty('MemoryMax')),
    cpuQuota: unitProperty('CPUQuotaPerSecUSec'), fd: sample(pid).fd,
    rssBytes: sample(pid).rssBytes };
  command('sudo', ['-n', 'kill', '-TERM', String(pid)]);
  await pause(150);
  assert.equal(unitProperty('MainPID'), String(pid), 'main must still drain paused write');
  release();
  await pause(10);
  assert.ok(Number(observations.heldUploadResponseMs) >= 100, 'upload response was not held through SIGTERM');
  const callOutcome = receipt(await call);
  observations.sigterm = { signalAt, callOutcome, callElapsedMs: Math.round(performance.now() - writeStart) };
  assert.equal(callOutcome.operationId, operationId, 'sdk receipt operation id mismatch');
  assert.equal(callOutcome.state, 'backend_acknowledged', 'sdk receipt must acknowledge write');
  assert.equal((callOutcome as { delivery?: string }).delivery, 'acknowledged');
  const checkinId = callOutcome.result.checkinId;
  assert.ok(typeof checkinId === 'string' && checkinId.length > 0, 'sdk receipt missing check-in id');
  const stopDeadline = Date.now() + 30_000;
  while (unitProperty('ActiveState') === 'active' && Date.now() < stopDeadline) await pause(100);
  assert.notEqual(unitProperty('ActiveState'), 'active', 'main did not stop');
  observations.mainExit = { result: unitProperty('Result'), execMainStatus: unitProperty('ExecMainStatus') };
  assert.equal((observations.mainExit as { result: string }).result, 'success', 'main unit failed during drain');
  assert.equal((observations.mainExit as { execMainStatus: string }).execMainStatus, '0', 'main process did not exit cleanly');
  assert.equal(databaseCount(productPath, boardId), 1);
  const post = new DatabaseSync(journalPath, { readOnly: true });
  try { observations.journalAfterStop = post.prepare('SELECT state, delivery FROM operations WHERE operation_id = ?').get(operationId); }
  finally { post.close(); }
  assert.equal((observations.journalAfterStop as { state?: string } | undefined)?.state, 'backend_acknowledged');
  assert.equal((observations.journalAfterStop as { delivery?: string } | undefined)?.delivery, 'acknowledged');
  stopMonitor();
  const metricsResult = await measured;
  observations.resources = metricsResult;
  await client.close();
  const restartPid = startMain(mainFile, tls.caCert, configFile);
  await waitReady();
  const retryClient = new Client({ name: 'linux-synthetic-retry', version: '1' });
  cleanup.push(() => retryClient.close());
  await retryClient.connect(new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } } }));
  const retry = await retryClient.callTool({ name: 'create_checkin', arguments: { operationId, habitId: boardId, timeZone: 'UTC' } });
  const retryReceipt = receipt(retry);
  observations.retry = { receipt: retryReceipt, count: databaseCount(productPath, boardId), restartPid };
  assert.equal(retryReceipt.operationId, operationId, 'retry operation id mismatch');
  assert.equal(retryReceipt.result.checkinId, checkinId, 'retry check-in id mismatch');
  assert.equal(retryReceipt.state, 'backend_acknowledged', 'retry must remain acknowledged');
  assert.equal(databaseCount(productPath, boardId), 1);
  await retryClient.close(); await stopMain();
  const lowState = join(root, 'low-state'), lowExternal = join(root, 'low-external');
  const lowConfig = join(root, 'low-config.json');
  assert.equal(existsSync(lowState) || existsSync(lowExternal) || existsSync(lowConfig), false);
  mkdirSync(lowState, { mode: 0o700 }); mkdirSync(lowExternal, { mode: 0o700 });
  cleanup.push(async () => {
    await stopMain();
    if (existsSync(lowState)) {
      const mounted = spawnSync('findmnt', ['-n', '-o', 'FSTYPE', '--mountpoint', lowState], { encoding: 'utf8' });
      if (mounted.status === 0 && mounted.stdout.trim() === 'tmpfs') command('sudo', ['-n', 'umount', lowState]);
    }
    for (const path of [lowState, lowExternal, lowConfig]) rmSync(path, { recursive: true, force: true });
  });
  command('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', 'size=16m,mode=0700,uid=1001,gid=1001', 'tmpfs', lowState]);
  const lowStat = command('stat', ['-f', '-c', '%T %a %S', lowState]).split(' ');
  assert.equal(lowStat[0], 'tmpfs');
  const freeBytes = Number(lowStat[1]) * Number(lowStat[2]);
  assert.ok(freeBytes < 64 * 1024 * 1024);
  const lowLatch = join(lowExternal, 'restore-latch'), lowInstallation = randomUUID();
  FileRestoreLatch.provisionFresh({ path: lowLatch, installationId: lowInstallation,
    restoredDirectories: [lowState, backend] });
  writeFileSync(lowConfig, JSON.stringify({ version: 2, publicOrigin, backendUrl,
    dataDirectory: lowState, keyFile, port: ports.main,
    operations: { installationId: lowInstallation, latchPath: lowLatch, backendDirectory: backend } }), { mode: 0o600 });
  startMain(mainFile, tls.caCert, lowConfig); await waitReady();
  const lowProvider = syntheticOAuthClient(`synthetic low disk ${randomUUID()}`);
  await authorizeSynthetic(`${publicOrigin}/mcp`, lowProvider, credentials);
  const lowClient = new Client({ name: 'linux-low-disk', version: '1' });
  cleanup.push(() => lowClient.close());
  await lowClient.connect(new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${lowProvider.tokens()!.access_token}` } } }));
  const lowStarted = performance.now();
  const refused = await lowClient.callTool({ name: 'list_habits', arguments: {} });
  observations.lowDisk = { filesystem: lowStat[0], freeBytes, refused: refused.isError === true,
    code: (refused.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? null,
    latencyMs: Math.round(performance.now() - lowStarted) };
  assert.equal(refused.isError, true, 'low-disk account read must refuse');
  await lowClient.close(); await stopMain();
  command('sudo', ['-n', 'umount', lowState]);
  for (const path of [lowState, lowExternal, lowConfig]) rmSync(path, { recursive: true, force: true });
  observations.fixtureLayout = { state: 'fixture/state', backend: 'fixture/backend', keys: 'fixture/keys',
    latch: 'external-restore-latch/restore-latch', stopped: true };
}

try { await main(); evidence.ok = true; }
catch (error) { evidence.ok = false; evidence.error = String(error); process.exitCode = 1; }
finally {
  const failures: string[] = [];
  for (const step of cleanup.reverse()) try { await step(); } catch (error) { failures.push(String(error)); }
  if (failures.length) { evidence.cleanupErrors = failures; process.exitCode = 1; }
  if (existsSync(root)) {
    const output = join(root, 'evidence.json'); writeFileSync(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
}
