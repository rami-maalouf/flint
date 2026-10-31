// explicit synthetic paired restore rehearsal. never imported by the test suite.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { auth, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startServe } from 'snapback4/proof';
import { createBoard, createCheckIn } from '../../../../src/core/domain/commands';
import { createReward } from '../../../../src/core/domain/reward-commands';
import type { CommandId } from '../../../../src/core/domain/ids';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../../src/core';
import { FileRestoreLatch } from '../../src/operations/recovery-head';
import { authorizeSyntheticWrite } from './write-oauth';
import { authorizeSynthetic, syntheticOAuthClient } from './oauth';

const oracleRoot = '/home/ubuntu/habit-mcp-staging-acceptance-20261030';
const source = `${oracleRoot}/reviewed-b3f05d2/fixture`;
const sourceLatch = `${oracleRoot}/reviewed-b3f05d2/external-restore-latch/restore-latch`;
const oracleNode = '/home/ubuntu/habit-mcp-proof-20261030/node-v24.22.2-linux-arm64/bin/node';
const oracleCli = '/opt/habit-system-fullstack/snapback4';
const oracleAge = '/home/ubuntu/habit-mcp-release-20261030-a6978ec/tools/age';
const oracleMain = process.env.MCP_PAIR_ORACLE_MAIN ?? '';
const reviewedMainHash = process.env.MCP_PAIR_MAIN_SHA256 ?? '';
const reviewedSha = process.env.MCP_PAIR_RELEASE_SHA ?? '';
const priorMainHash = 'edddaac92d0b179566b10780b9d4c2bb01cfe81b0ffee0e3681e54a9a05e5e0a';
const priorReleaseSha = 'b3f05d24f9f58f11e1f5efaa0e17a9d7969c3728';
const cliHash = '80bb7af237548866228c7dff6889c7b779b777d1342c76e4b10effa1de88ebcf';
const macRoot = '/Users/rami/Private';
const backupParent = `${macRoot}/habit-system-mcp-backups`;
const controller = `${macRoot}/habit-system-mcp-controller`;
const rehearsalParent = `${macRoot}/habit-system-mcp-rehearsals`;
const identity = `${macRoot}/habit-system-mcp-age/identity.txt`;
const ports = { main: 4450, public: 4451, backend: 4452, low: 4453, high: 4455 };
const publicOrigin = `https://127.0.0.1:${ports.public}`;
const backendUrl = `https://127.0.0.1:${ports.backend}`;
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
type ToolResult = { isError?: boolean; structuredContent?: unknown };
type Receipt = { operationId: string; state: string; delivery: string; result?: { checkinId?: string; balanceAfterClaim?: number } };
type Quote = { operationId: string; confirmationToken: string; confirmationUrl: string; balance: number;
  expiresAtUtc: number; reward: { id: string } };
type Bundle = { version: number; snapshotId: string; releaseSha: string; paired: boolean; data: string; dataSha256: string;
  keys: string; keysSha256: string };

function digest(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function checked(binary: string, args: string[], timeout = 60_000, env = process.env) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout, env });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${binary} ${args[0] ?? ''} failed: ${result.stderr?.slice(0, 400)}`);
  return result.stdout.trim();
}
function oracleRuntimeEnv() {
  assert.match(reviewedSha, /^[0-9a-f]{40}$/);
  assert.match(reviewedMainHash, /^[0-9a-f]{64}$/);
  assert.ok(oracleMain.startsWith(`${oracleRoot}/`) && oracleMain.endsWith('/services/mcp/dist/main.js'));
  return ['env', `MCP_PAIR_RELEASE_SHA=${reviewedSha}`, `MCP_PAIR_MAIN_SHA256=${reviewedMainHash}`,
    `MCP_PAIR_ORACLE_MAIN=${oracleMain}`];
}
function unitNames(root: string) {
  assert.match(root, /^\/home\/ubuntu\/habit-mcp-staging-acceptance-20261030\/paired-[0-9a-f-]{36}$/);
  const id = root.split('/').at(-1)!.slice(7).replaceAll('-', '');
  return { main: `habit-mcp-paired-${id}-main.service`,
    backend: `habit-mcp-paired-${id}-backend.service`,
    expected: `habit-system-mcp@${reviewedSha}.service` };
}
function linuxProcessStart(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function probeOracleWorker(root: string, nonce: string) {
  unitNames(root);
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  if (!existsSync(root)) {
    await portsFree();
    emit({ rootAbsent: true, identityMatched: false, workerAlive: false, portsFree: true });
    return;
  }
  privateDirectory(root);
  const marker = join(root, 'worker-identity.json');
  assert.ok(existsSync(marker), 'owned worker identity is missing');
  const identity = JSON.parse(readFileSync(marker, 'utf8')) as { nonce: string; pid: number; startTicks: string };
  assert.equal(identity.nonce, nonce, 'owned worker identity does not match this launch');
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
  const workerAlive = linuxProcessStart(identity.pid) === identity.startTicks;
  let free = true;
  try { await portsFree(); } catch { free = false; }
  emit({ rootAbsent: false, identityMatched: true, pid: identity.pid, startTicks: identity.startTicks,
    workerAlive, portsFree: free });
}
async function terminateOracleWorker(root: string, nonce: string, bundle: string) {
  unitNames(root);
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  privateDirectory(root);
  const identity = JSON.parse(readFileSync(join(root, 'worker-identity.json'), 'utf8')) as {
    nonce: string; pid: number; startTicks: string };
  assert.equal(identity.nonce, nonce, 'owned worker termination identity changed');
  if (linuxProcessStart(identity.pid) !== identity.startTicks) { emit({ exited: true }); return; }
  const command = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0');
  assert.equal(command[0], oracleNode, 'owned worker executable changed');
  assert.equal(command[1], bundle, 'owned worker bundle changed');
  assert.equal(command[2], 'oracle-worker', 'owned worker mode changed');
  assert.equal(command[3], root, 'owned worker root changed');
  assert.ok(command[4] === 'fresh' || command[4] === 'existing');
  assert.equal(command[5], nonce, 'owned worker nonce changed');
  process.kill(identity.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 60 && linuxProcessStart(identity.pid) === identity.startTicks; attempt++) await pause(250);
  if (linuxProcessStart(identity.pid) === identity.startTicks) process.kill(identity.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 20 && linuxProcessStart(identity.pid) === identity.startTicks; attempt++) await pause(250);
  assert.notEqual(linuxProcessStart(identity.pid), identity.startTicks, 'owned remote worker did not terminate');
  emit({ exited: true });
}
function unitState(unit: string, property = 'ActiveState') {
  return checked('sudo', ['-n', 'systemctl', 'show', `--property=${property}`, '--value', unit]);
}
async function cleanupOwnedUnits(units: string[], cleanup: (unit: string) => Promise<void>, reload: () => void) {
  const results = await Promise.allSettled(units.map(cleanup));
  let reloadFailure: unknown;
  try { reload(); } catch (error) { reloadFailure = error; }
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (reloadFailure) failures.push(reloadFailure);
  if (failures.length) throw new AggregateError(failures, 'owned units could not all be cleaned');
}
function systemctlAudit(root: string, event: object) {
  const path = join(root, 'fixture-systemctl-audit.jsonl');
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function oracleSystemctl(root: string, args: string[]) {
  const names = unitNames(root);
  privateDirectory(root);
  const alias = args.at(-1);
  const mapped = alias === names.expected ? names.main :
    alias === 'habit-system-fullstack.service' ? names.backend : undefined;
  const inventory = ['list-units', '--all', '--type=service', '--state=active', '--plain',
    '--no-legend', '--no-pager', '--full', 'habit-system-mcp@*.service'];
  if (JSON.stringify(args) === JSON.stringify(inventory)) {
    const output = checked('sudo', ['-n', 'systemctl', ...inventory.slice(0, -1), names.main]);
    const rows = output ? output.split('\n') : [];
    assert.ok(rows.length <= 1 && rows.every(row => row.trim().startsWith(`${names.main} `)),
      'owned unit inventory was ambiguous');
    const state = unitState(names.main);
    systemctlAudit(root, { command: 'inventory', actualUnit: names.main, actualState: state });
    if (rows.length) process.stdout.write(rows[0].replace(names.main, names.expected) + '\n');
    return;
  }
  assert.ok(mapped, 'fixture systemctl refused an unowned unit');
  const verb = args[0];
  const allowed = (verb === 'is-active' || verb === 'stop' || verb === 'start') && args.length === 2 ||
    verb === 'show' && args.length === 4 && args[1] === '--property=ActiveState' && args[2] === '--value';
  assert.ok(allowed, 'fixture systemctl refused an unsupported command');
  const realArgs = verb === 'show' ? ['show', '--property=ActiveState', '--value', mapped] : [verb, mapped];
  const result = spawnSync('sudo', ['-n', 'systemctl', ...realArgs], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `owned systemctl ${verb} failed: ${result.stderr?.slice(0, 200)}`);
  const state = unitState(mapped);
  systemctlAudit(root, { command: verb, actualUnit: mapped, actualState: state });
  process.stdout.write(result.stdout);
}
function wrapperSource(binary: string, args: string[]) {
  return `#!${binary}\nimport { spawnSync } from 'node:child_process';\n` +
    `const result = spawnSync(${JSON.stringify(args[0])}, ${JSON.stringify(args.slice(1))}.concat(process.argv.slice(2)), ` +
    `{ encoding: 'utf8', timeout: 65000 });\n` +
    `if (result.stdout) process.stdout.write(result.stdout);\n` +
    `if (result.stderr) process.stderr.write(result.stderr);\n` +
    `process.exit(result.status ?? 1);\n`;
}
async function oracleUnits(root: string, action: 'start' | 'status' | 'cleanup') {
  const output = checked('ssh', ['-o', 'BatchMode=yes', 'oracle', ...oracleRuntimeEnv(), oracleNode,
    process.env.MCP_PAIR_ORACLE_BUNDLE!, 'oracle-units', root, action], 90_000);
  return JSON.parse(output) as { main: string; backend: string; mainPid: number; backendPid: number;
    limits?: { memoryMaxBytes: number; cpuQuota: string; tasksMax: number } };
}
async function manageOracleUnits(root: string, action: 'start' | 'status' | 'cleanup') {
  const names = unitNames(root);
  assert.ok(['start', 'status', 'cleanup'].includes(action), 'unsupported owned unit action');
  if (action === 'start') {
    await portsFree();
    assert.equal(digest(oracleMain), reviewedMainHash);
    assert.equal(digest(oracleCli), cliHash);
    const fixture = join(root, 'unit-fixture'), external = join(root, 'unit-external');
    ensureNew(external); cpSync(join(root, 'external/restore-latch'), join(external, 'restore-latch'));
    cpSync(join(root, 'fixture'), fixture, { recursive: true, preserveTimestamps: true });
    const configPath = join(fixture, 'keys/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    Object.assign(config, { dataDirectory: join(fixture, 'state'), port: ports.main,
      operations: { ...config.operations, backendDirectory: join(fixture, 'backend'),
        latchPath: join(external, 'restore-latch') } });
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const wrapper = join(root, 'fixture-systemctl');
    writeFileSync(wrapper, wrapperSource(oracleNode,
      [...oracleRuntimeEnv(), oracleNode, process.argv[1]!, 'oracle-systemctl', root]), { mode: 0o700 });
    const common = 'Type=simple\nUser=ubuntu\nGroup=ubuntu\nMemoryMax=536870912\nCPUQuota=100%\nTasksMax=128\nRuntimeMaxSec=900\n';
    const units = [
      { name: names.backend, body: `[Unit]\nDescription=owned synthetic paired backend\n[Service]\n${common}` +
        `SuccessExitStatus=143\nExecStart=${oracleCli} serve ${join(fixture, 'backend')} --bind 127.0.0.1 --port ${ports.low}\n` },
      { name: names.main, body: `[Unit]\nDescription=owned synthetic paired main\n[Service]\n${common}` +
        `Environment=MCP_CONFIG_PATH=${configPath}\nExecStart=${oracleNode} ${oracleMain}\n` },
    ];
    for (const unit of units) {
      const localFile = join(root, unit.name);
      writeFileSync(localFile, unit.body, { mode: 0o600 });
      checked('sudo', ['-n', 'install', '-m', '0644', localFile, `/run/systemd/system/${unit.name}`]);
    }
    checked('sudo', ['-n', 'systemctl', 'daemon-reload']);
    for (const unit of units) checked('sudo', ['-n', 'systemctl', 'start', unit.name]);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (unitState(names.main) === 'active' && unitState(names.backend) === 'active') break;
      await pause(500);
    }
  }
  if (action === 'cleanup') {
    await cleanupOwnedUnits([names.main, names.backend], async unit => {
      if (unitState(unit) === 'active') checked('sudo', ['-n', 'systemctl', 'stop', unit]);
      if (unitState(unit) === 'failed') checked('sudo', ['-n', 'systemctl', 'reset-failed', unit]);
      checked('sudo', ['-n', 'rm', '-f', `/run/systemd/system/${unit}`]);
    }, () => { checked('sudo', ['-n', 'systemctl', 'daemon-reload']); });
  }
  const main = unitState(names.main), backend = unitState(names.backend);
  const mainPid = Number(unitState(names.main, 'MainPID'));
  const backendPid = Number(unitState(names.backend, 'MainPID'));
  if (action === 'cleanup') {
    assert.deepEqual([main, backend, mainPid, backendPid], ['inactive', 'inactive', 0, 0],
      'owned unit cleanup left an active or failed service');
    assert.equal(existsSync(`/run/systemd/system/${names.main}`), false);
    assert.equal(existsSync(`/run/systemd/system/${names.backend}`), false);
    await portsFree();
  }
  let limits: { memoryMaxBytes: number; cpuQuota: string; tasksMax: number } | undefined;
  if (action === 'start') {
    assert.deepEqual([main, backend], ['active', 'active']);
    assert.match(readFileSync(`/proc/${mainPid}/cmdline`, 'utf8'), /main\.js/);
    assert.match(readFileSync(`/proc/${backendPid}/cmdline`, 'utf8'), /snapback4/);
    limits = { memoryMaxBytes: Number(unitState(names.main, 'MemoryMax')),
      cpuQuota: unitState(names.main, 'CPUQuotaPerSecUSec'), tasksMax: Number(unitState(names.main, 'TasksMax')) };
    assert.deepEqual(limits, { memoryMaxBytes: 536_870_912, cpuQuota: '1s', tasksMax: 128 });
    assert.deepEqual({ memoryMaxBytes: Number(unitState(names.backend, 'MemoryMax')),
      cpuQuota: unitState(names.backend, 'CPUQuotaPerSecUSec'), tasksMax: Number(unitState(names.backend, 'TasksMax')) },
    limits);
  }
  process.stdout.write(JSON.stringify({ main, backend, mainPid, backendPid, limits }) + '\n');
}
function refused(binary: string, args: string[], timeout = 60_000, env = process.env) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout, env });
  assert.notEqual(result.status, 0, `${binary} ${args[0] ?? ''} unexpectedly succeeded`);
  return { exitCode: result.status, targetAbsent: true };
}
function privateDirectory(path: string) {
  assert.equal(resolve(path), path);
  assert.equal(realpathSync(path), path);
  assert.equal(statSync(path).mode & 0o077, 0, `unsafe directory ${path}`);
}
function ensureNew(path: string) { assert.equal(existsSync(path), false, `refusing occupied path ${path}`); mkdirSync(path, { mode: 0o700 }); }
function data<T>(response: ToolResult): T {
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return (response.structuredContent as { data: T }).data;
}
function errorCode(response: ToolResult) {
  assert.equal(response.isError, true, JSON.stringify(response));
  return (response.structuredContent as { error: { code: string } }).error.code;
}
async function free(port: number) {
  const probe = createServer();
  try { await new Promise<void>((ok, fail) => probe.once('error', fail).listen(port, '127.0.0.1', ok)); }
  finally { await new Promise<void>(ok => probe.close(() => ok())); }
}
async function portsFree() { for (let port = ports.main; port <= ports.high; port++) await free(port); }
function certs(directory: string) {
  ensureNew(directory);
  try {
    const caKey = join(directory, 'ca.key'), caCert = join(directory, 'ca.pem');
    const leafKey = join(directory, 'leaf.key'), csr = join(directory, 'leaf.csr'), leafCert = join(directory, 'leaf.pem');
    const ext = join(directory, 'leaf.ext');
    writeFileSync(ext, 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
    checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-subj', `/CN=synthetic-paired-ca-${randomUUID()}`, '-keyout', caKey, '-out', caCert]);
    checked('openssl', ['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=127.0.0.1',
      '-keyout', leafKey, '-out', csr]);
    checked('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
      '-out', leafCert, '-days', '1', '-sha256', '-extfile', ext]);
    checked('openssl', ['verify', '-CAfile', caCert, leafCert]);
    return { ca: readFileSync(caCert, 'utf8'), caPath: caCert, key: readFileSync(leafKey), cert: readFileSync(leafCert) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
function tlsProxy(port: number, destination: URL, tls: { key: Buffer; cert: Buffer },
  hold?: { armed: () => boolean; reached: () => void }) {
  let held = false;
  const server = createTlsServer(tls, (incoming, response) => {
    const upstream = httpRequest({ hostname: destination.hostname, port: destination.port, path: incoming.url,
      method: incoming.method, headers: { ...incoming.headers, host: port === ports.public ? incoming.headers.host : destination.host },
      timeout: 15_000 }, answer => {
      if (hold?.armed() && !held && incoming.url?.startsWith('/m/uploadRecord')) {
        held = true;
        const chunks: Buffer[] = [];
        answer.on('data', chunk => chunks.push(Buffer.from(chunk)));
        answer.on('end', () => { hold.reached(); });
        return;
      }
      response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(upstream);
    response.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
  });
  return new Promise<typeof server>((ok, fail) => server.once('error', error => {
    server.close(); fail(error);
  }).listen(port, '127.0.0.1', () => ok(server)));
}
async function closeServer(server: ReturnType<typeof createTlsServer>) {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
async function closeAcquired(steps: Array<() => Promise<void>>) {
  const results = await Promise.allSettled(steps.map(step => step()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'owned resource cleanup failed');
}
function requireMixedStartup(started: boolean, failure?: unknown) {
  if (started) return;
  if (failure instanceof Error) throw failure;
  throw Error('mixed graph did not start', { cause: failure });
}
async function selfCheck() {
  assert.throws(() => requireMixedStartup(false,
    Error('RecoveryFenceError: restore_latched\nFatalError: unrelated crash')), /FatalError/);
  assert.throws(() => requireMixedStartup(false, Error('reviewed runtime did not become ready')),
    /did not become ready/);
  requireMixedStartup(true);
  const closed: number[] = [];
  await assert.rejects(closeAcquired([
    async () => { closed.push(1); throw Error('synthetic cleanup failure'); },
    async () => { closed.push(2); },
  ]), AggregateError);
  assert.deepEqual(closed.sort(), [1, 2]);
  const units: string[] = [];
  await assert.rejects(cleanupOwnedUnits(['first', 'second'], async unit => {
    units.push(unit);
    if (unit === 'first') throw Error('synthetic first unit stop failure');
  }, () => { units.push('reload'); }), AggregateError);
  assert.deepEqual(units.sort(), ['first', 'reload', 'second']);
  const failedEvidence: Record<string, unknown> = {};
  assert.equal(finalizeEvidence(failedEvidence, true, [Error('synthetic cleanup failure')]), false);
  assert.equal(failedEvidence.ok, false);
  assert.equal((JSON.parse(JSON.stringify(failedEvidence)) as { ok: boolean }).ok, false);
}
function finalizeEvidence(evidence: Record<string, unknown>, assertionsPassed: boolean, cleanupFailures: unknown[]) {
  const ok = assertionsPassed && cleanupFailures.length === 0;
  evidence.ok = ok;
  if (cleanupFailures.length) evidence.cleanupFailures = cleanupFailures.map(String);
  return ok;
}
async function waitHealth() {
  const deadline = Date.now() + 15_000;
  let lastObservation = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${publicOrigin}/mcp/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      lastObservation = `HTTP ${response.status}`;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      lastObservation = typeof (cause as { code?: unknown } | undefined)?.code === 'string'
        ? String((cause as { code: string }).code) : error instanceof Error ? error.message : String(error);
    }
    await pause(100);
  }
  throw Error(`reviewed runtime did not become ready: ${lastObservation}`);
}
function operationAccount(path: string, operationId: string) {
  const accounts = join(path, 'state/accounts');
  const account = readdirSync(accounts).map(name => join(accounts, name)).find(directory => {
    const db = join(directory, 'journal.sqlite');
    if (!existsSync(db)) return false;
    const view = new DatabaseSync(db, { readOnly: true });
    try { return !!view.prepare('SELECT 1 FROM operations WHERE operation_id = ?').get(operationId); }
    finally { view.close(); }
  });
  assert.ok(account, 'expected account journal absent');
  return account;
}
function sample(path: string, operationId: string, boardId: string) {
  const account = operationAccount(path, operationId);
  const product = new DatabaseSync(join(account, 'product.sqlite'), { readOnly: true });
  const journal = new DatabaseSync(join(account, 'journal.sqlite'), { readOnly: true });
  try {
    const row = journal.prepare('SELECT client_id, intent, result, state, delivery FROM operations WHERE operation_id = ?').get(operationId);
    assert.ok(row && typeof row.intent === 'string' && typeof row.result === 'string', 'durable operation receipt absent');
    const intent = JSON.parse(row.intent) as { clientId: string; operationId: string; commandId: string };
    const receipt = JSON.parse(row.result) as { ok: boolean; value?: { checkInId?: string } };
    const core = product.prepare('SELECT outcome FROM command_receipts WHERE command_id = ?').get(intent.commandId);
    assert.equal(core?.outcome, row.result, 'journal and core receipt diverged');
    assert.equal(intent.operationId, operationId);
    assert.equal(row.client_id, intent.clientId, 'stored operation client lineage diverged');
    assert.equal(receipt.ok, true);
    const checkInId = receipt.value?.checkInId;
    if (typeof checkInId !== 'string') throw Error('retained check-in id absent');
    const effectRows = Number(product.prepare('SELECT COUNT(*) n FROM check_ins WHERE id = ? AND board_id = ?')
      .get(checkInId, boardId)?.n);
    return { account: account.split('/').at(-1), checkins: Number(product.prepare('SELECT COUNT(*) n FROM check_ins WHERE board_id = ?').get(boardId)?.n),
      effectRows,
      outbox: Number(product.prepare('SELECT COUNT(*) n FROM mutation_outbox').get()?.n),
      operation: { state: row.state, delivery: row.delivery },
      receipt: { clientId: intent.clientId, operationId: intent.operationId, commandId: intent.commandId,
        checkInId, matchesCore: true },
      pendingTuples: Number(journal.prepare('SELECT COUNT(*) n FROM tuples WHERE disposition IS NULL').get()?.n),
      head: journal.prepare('SELECT sequence, head_hash FROM journal_chain ORDER BY sequence DESC LIMIT 1').get(),
      quotes: (() => { const quotes = new DatabaseSync(join(path, 'state/quotes.sqlite'), { readOnly: true });
        try { return Number(quotes.prepare('SELECT COUNT(*) n FROM reward_quotes').get()?.n); }
        finally { quotes.close(); } })() };
  } finally { journal.close(); product.close(); }
}

function queueSnapshot(path: string, operationId: string, clientId: string) {
  const account = operationAccount(path, operationId);
  const product = new DatabaseSync(join(account, 'product.sqlite'), { readOnly: true });
  const journal = new DatabaseSync(join(account, 'journal.sqlite'), { readOnly: true });
  try {
    const outbox = product.prepare('SELECT id, entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox ORDER BY id')
      .all();
    const tuples = journal.prepare(`SELECT outbox_id, client_id, operation_id, entity_type, entity_id, mutation_stamp,
      payload_hash, digest, record, disposition, remote_stamp FROM tuples ORDER BY outbox_id`).all();
    const operation = journal.prepare(`SELECT client_id, operation_id, fingerprint, intent, result, state, delivery
      FROM operations WHERE client_id = ? AND operation_id = ?`).get(clientId, operationId);
    assert.ok(operation, 'held operation binding absent');
    assert.ok(outbox.length > 0 && tuples.length > 0, 'held queue rows absent');
    assert.ok(outbox.length <= 64 && tuples.length <= 64, 'synthetic queue exceeds inspection bound');
    const pending = tuples.filter(row => row.disposition === null);
    assert.ok(pending.length > 0, 'held pending tuples absent');
    for (const tuple of pending) {
      assert.equal(tuple.client_id, clientId, 'pending tuple client binding differs');
      assert.equal(tuple.operation_id, operationId, 'pending tuple operation binding differs');
      const queued = outbox.find(row => row.id === tuple.outbox_id);
      assert.ok(queued, 'pending tuple lacks its queued outbox row');
      assert.equal(tuple.entity_type, queued.entity_type);
      assert.equal(tuple.entity_id, queued.entity_id);
      assert.equal(tuple.mutation_stamp, queued.mutation_stamp);
    }
    const snapshot = { outbox, tuples, operation };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1_048_576, 'synthetic queue exceeds byte bound');
    return snapshot;
  } finally { journal.close(); product.close(); }
}
function queueHashes(snapshot: ReturnType<typeof queueSnapshot>) {
  return Object.fromEntries((['outbox', 'tuples', 'operation'] as const).map(kind =>
    [kind, createHash('sha256').update(JSON.stringify(snapshot[kind])).digest('hex')])) as
    { outbox: string; tuples: string; operation: string };
}
function assertQueueRetained(held: ReturnType<typeof queueSnapshot>, path: string,
  operationId: string, clientId: string) {
  const restored = queueSnapshot(path, operationId, clientId);
  const expected = queueHashes(held), actual = queueHashes(restored);
  for (const kind of ['outbox', 'tuples', 'operation'] as const) {
    assert.equal(actual[kind], expected[kind], `cold restored A ${kind} differs from held rows`);
  }
  return { hashes: actual, outboxRows: restored.outbox.length,
    tupleRows: restored.tuples.length, pendingRows: restored.tuples.filter(row => row.disposition === null).length };
}

function retainedQuote(path: string, quote: Quote) {
  const view = new DatabaseSync(join(path, 'state/quotes.sqlite'), { readOnly: true });
  try {
    const row = view.prepare('SELECT id, payload FROM reward_quotes WHERE operation_id = ?')
      .get(quote.operationId) as { id: string; payload: string } | undefined;
    assert.ok(row, 'retained quote row absent');
    const token = /^rq1\.([0-9a-f-]{36})\.[a-f0-9]{64}$/.exec(quote.confirmationToken);
    assert.ok(token, 'quote token has an unexpected form');
    assert.equal(row.id, token[1], 'retained quote token no longer names the stored row');
    const payload = JSON.parse(row.payload) as { operationId?: string; expiresAtUtc?: number; reward?: { id?: string } };
    assert.equal(payload.operationId, quote.operationId);
    assert.equal(payload.expiresAtUtc, quote.expiresAtUtc);
    assert.equal(payload.reward?.id, quote.reward.id);
    return { expiresAtUtc: payload.expiresAtUtc };
  } finally { view.close(); }
}

async function oracleWorker(root: string, existing: boolean, nonce: string) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.version, 'v24.22.2');
  unitNames(root);
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  const fixture = join(root, 'fixture'), state = join(fixture, 'state'), backend = join(fixture, 'backend');
  const external = join(root, 'external'), latch = join(external, 'restore-latch');
  if (!existing) ensureNew(root);
  else privateDirectory(root);
  const startTicks = linuxProcessStart(process.pid);
  assert.ok(startTicks, 'owned worker process identity unavailable');
  const marker = join(root, 'worker-identity.json');
  const markerFd = openSync(marker, 'w', 0o600);
  try { writeSync(markerFd, JSON.stringify({ nonce, pid: process.pid, startTicks })); fsyncSync(markerFd); }
  finally { closeSync(markerFd); }
  emit({ type: 'worker_started', nonce, pid: process.pid, startTicks });
  assert.equal(digest(oracleCli), cliHash); assert.equal(digest(oracleMain), reviewedMainHash);
  assert.equal(checked(oracleAge, ['--version']), 'v1.3.2');
  await portsFree();
  if (!existing) {
    cpSync(source, fixture, { recursive: true, preserveTimestamps: true });
    ensureNew(external); copyFileSync(sourceLatch, latch);
    const config = JSON.parse(readFileSync(join(fixture, 'keys/config.json'), 'utf8'));
    assert.equal(config.version, 2);
    Object.assign(config, { dataDirectory: state, backendUrl, publicOrigin, port: ports.main,
      keyFile: join(fixture, 'keys/keys.json'), operations: { ...config.operations, backendDirectory: backend, latchPath: latch } });
    writeFileSync(join(fixture, 'keys/config.json'), JSON.stringify(config), { mode: 0o600 });
  } else assert.ok(existsSync(fixture));
  const tlsDir = join(root, `tls-${randomUUID()}`);
  const tls = certs(tlsDir);
  setDefaultCACertificates([...getCACertificates('default'), tls.ca]);
  let armed = false;
  let host: Awaited<ReturnType<typeof startServe>> | undefined;
  let backendServer: ReturnType<typeof createTlsServer> | undefined;
  let publicServer: ReturnType<typeof createTlsServer> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  let shutdownRequested = false;
  const childLog = join(root, `main-${randomUUID()}.log`);
  const chunks: Buffer[] = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await closeAcquired([
      async () => {
        const running = child;
        if (!running) return;
        if (running.exitCode === null && running.signalCode === null) { running.kill('SIGTERM');
          await Promise.race([new Promise<void>(ok => running.once('exit', () => ok())), pause(10_000)]); }
        if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
        writeFileSync(childLog, Buffer.concat(chunks), { mode: 0o600 });
      },
      async () => { if (publicServer) await closeServer(publicServer); },
      async () => { if (backendServer) await closeServer(backendServer); },
      async () => { if (host) await host.stop(); },
    ]);
  };
  const onTerminate = () => { shutdownRequested = true; input?.close(); };
  process.on('SIGTERM', onTerminate);
  try {
    host = await startServe(backend, { logsDir: join(root, `snapback-logs-${randomUUID()}`),
      env: { ...process.env, SNAPBACK4_BIN: oracleCli, PORT_LO: String(ports.low), PORT_HI: String(ports.high) } });
    if (shutdownRequested) throw Error('owned worker shutdown requested during backend start');
    backendServer = await tlsProxy(ports.backend, new URL(host.url), tls,
      { armed: () => armed, reached: () => emit({ type: 'held' }) });
    if (shutdownRequested) throw Error('owned worker shutdown requested during TLS start');
    publicServer = await tlsProxy(ports.public, new URL(`http://127.0.0.1:${ports.main}`), tls);
    if (shutdownRequested) throw Error('owned worker shutdown requested during TLS start');
    const running = spawn(oracleNode, [oracleMain], { cwd: resolve(oracleMain, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MCP_CONFIG_PATH: join(fixture, 'keys/config.json'), NODE_EXTRA_CA_CERTS: tls.caPath } });
    child = running;
    for (const stream of [running.stdout, running.stderr]) stream.on('data', part => {
      if (chunks.reduce((n, c) => n + c.length, 0) < 65_536) chunks.push(Buffer.from(part));
    });
    await waitHealth();
    if (shutdownRequested) throw Error('owned worker shutdown requested before readiness');
    const config = JSON.parse(readFileSync(join(fixture, 'keys/config.json'), 'utf8'));
    emit({ type: 'ready', ca: Buffer.from(tls.ca).toString('base64'), mainHash: digest(oracleMain),
      fixture: 'owned-copy', installationId: config.operations.installationId, pid: running.pid });
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    if (shutdownRequested) input.close();
    for await (const line of input) {
      const message = JSON.parse(line) as { command: string; operationId?: string; boardId?: string; clientId?: string };
      if (message.command === 'arm') { armed = true; emit({ type: 'armed' }); }
      else if (message.command === 'inspect') {
        assert.ok(message.operationId && message.boardId);
        emit({ type: 'inspection', value: sample(fixture, message.operationId, message.boardId) });
      } else if (message.command === 'inspect-queue') {
        assert.ok(message.operationId && message.clientId);
        emit({ type: 'queue-inspection', value: queueSnapshot(fixture, message.operationId, message.clientId) });
      } else if (message.command === 'kill') { running.kill('SIGKILL'); emit({ type: 'killed' }); }
      else if (message.command === 'stop') { await stop(); emit({ type: 'stopped' }); break; }
      else throw Error('unknown worker command');
    }
  } finally {
    process.removeListener('SIGTERM', onTerminate);
    await closeAcquired([
      stop,
      async () => { rmSync(tlsDir, { recursive: true, force: true }); },
    ]);
  }
  process.stdout.write('', () => process.exit(0));
}
function emit(value: object) { process.stdout.write(JSON.stringify(value) + '\n'); }

class RemoteWorker {
  private readonly events: Array<Record<string, unknown>> = [];
  private readonly waiting: Array<{ type: string; resolve: (value: Record<string, unknown>) => void }> = [];
  readonly process: ChildProcessWithoutNullStreams;
  private readonly errors: Buffer[] = [];
  readonly nonce = randomUUID();
  constructor(private readonly bundle: string, private readonly root: string, existing: boolean) {
    this.process = spawn('ssh', ['-T', '-o', 'BatchMode=yes', 'oracle', ...oracleRuntimeEnv(), oracleNode, bundle,
      'oracle-worker', root, existing ? 'existing' : 'fresh', this.nonce], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.process.stdout, crlfDelay: Infinity }).on('line', line => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (event.type === 'error') {
        for (const wait of this.waiting.splice(0)) wait.resolve(event);
        this.events.push(event);
        return;
      }
      const index = this.waiting.findIndex(wait => wait.type === event.type);
      if (index < 0) this.events.push(event);
      else this.waiting.splice(index, 1)[0].resolve(event);
    });
    this.process.stderr.on('data', part => { if (this.errors.length < 64) this.errors.push(Buffer.from(part)); });
    this.process.stdin.on('error', () => undefined);
  }
  send(command: string, extra: object = {}) { this.process.stdin.write(JSON.stringify({ command, ...extra }) + '\n'); }
  async wait(type: string, timeout = 20_000) {
    const failure = this.events.find(event => event.type === 'error');
    if (failure) throw Error(`oracle worker failed: ${failure.message}`);
    const index = this.events.findIndex(event => event.type === type);
    if (index >= 0) return this.events.splice(index, 1)[0];
    const event = await Promise.race([new Promise<Record<string, unknown>>(ok => this.waiting.push({ type, resolve: ok })),
      pause(timeout).then(() => { throw Error(`oracle worker ${type} timed out`); })]);
    if (event.type === 'error') throw Error(`oracle worker failed: ${event.message}`);
    return event;
  }
  async stop(logPath: string) {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      try { this.send('stop'); await this.wait('stopped', 5_000); }
      catch { this.process.stdin.end(); }
      await Promise.race([new Promise<void>(ok => this.process.once('exit', () => ok())), pause(5_000)]);
      if (this.process.exitCode === null && this.process.signalCode === null) {
        this.process.kill('SIGTERM');
        await Promise.race([new Promise<void>(ok => this.process.once('exit', () => ok())), pause(5_000)]);
      }
      if (this.process.exitCode === null && this.process.signalCode === null) {
        this.process.kill('SIGKILL');
        await Promise.race([new Promise<void>(ok => this.process.once('exit', () => ok())), pause(5_000)]);
      }
    }
    writeFileSync(logPath, Buffer.concat(this.errors), { mode: 0o600 });
    assert.equal(this.process.exitCode, 0, 'oracle worker failed');
  }
  async verifyGone() {
    let forcedTermination = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = JSON.parse(checked('ssh', ['-o', 'BatchMode=yes', 'oracle', ...oracleRuntimeEnv(),
        oracleNode, this.bundle, 'oracle-worker-probe', this.root, this.nonce], 20_000)) as {
        rootAbsent: boolean; identityMatched: boolean; pid?: number; startTicks?: string;
        workerAlive: boolean; portsFree: boolean };
      assert.ok(result.rootAbsent || result.identityMatched, 'remote worker identity was not verified');
      if (!result.workerAlive && result.portsFree) return { ...result, forcedTermination };
      if (result.workerAlive && !forcedTermination && attempt >= 4) {
        checked('ssh', ['-o', 'BatchMode=yes', 'oracle', ...oracleRuntimeEnv(), oracleNode,
          this.bundle, 'oracle-worker-terminate', this.root, this.nonce], 30_000);
        forcedTermination = true;
      }
      await pause(250);
    }
    throw Error('owned remote worker or listener remained after shutdown');
  }
}

function tunnel() {
  return spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${ports.public}:127.0.0.1:${ports.public}`,
    '-L', `127.0.0.1:${ports.backend}:127.0.0.1:${ports.backend}`, 'oracle'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
}
async function stopTunnel(child: ReturnType<typeof tunnel>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await Promise.race([new Promise<void>(ok => child.once('exit', () => ok())), pause(5000)]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function connect(token: string) {
  const client = new Client({ name: 'paired-synthetic-rehearsal', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicOrigin}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
async function seed(root: string) {
  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
  const signed = await signup(backendUrl, credentials.email, credentials.password); assert.ok(signed.ok);
  const db = new NodeSqlDatabase(join(root, 'seed.sqlite'));
  try {
    const ports = createCorePorts('UTC');
    assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
    await db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const board = await createBoard({ db, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic paired board', symbol: 'star.fill', accentHex: '#70A7FF',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0,
      metricsEnabled: true, kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok);
    const reward = await createReward({ db, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic paired reward', costCoins: 3, symbol: 'star.fill', accentHex: '#70A7FF' });
    assert.ok(reward.ok);
    for (let index = 0; index < 4; index++) assert.ok((await createCheckIn({ db, ...ports },
      { commandId: randomUUID() as CommandId, boardId: board.value.boardId, source: 'app' })).ok);
    const upstream = createClient({ url: backendUrl, token: signed.session.token });
    try {
      const transport = createSnapbackTransport({ connection: async () => ({ client: upstream,
        session: signed.session, isCurrent: () => true }), bind: async () => undefined,
        hash: async value => createHash('sha256').update(value).digest('hex') });
      const synced = await runSync({ db, ...ports, transport, random: () => 0.5 });
      assert.ok(synced.ok && synced.value.status === 'up_to_date', JSON.stringify(synced));
    } finally { await upstream.close(); }
    return { boardId: board.value.boardId, rewardId: reward.value.rewardId, credentials,
      principal: signed.session.principal };
  } finally { await db.closeAsync(); }
}
function verifyBundle(directory: string): Bundle {
  const bundle = JSON.parse(readFileSync(join(directory, 'bundle.json'), 'utf8')) as Bundle;
  assert.equal(bundle.version, 1); assert.equal(bundle.releaseSha, reviewedSha); assert.equal(bundle.paired, true);
  for (const kind of ['data', 'keys'] as const) {
    assert.equal(bundle[kind], `${bundle.snapshotId}-${kind}.age`);
    assert.equal(digest(join(directory, bundle[kind])), bundle[`${kind}Sha256`]);
  }
  assert.deepEqual(readdirSync(directory).sort(), [bundle.data, bundle.keys, 'bundle.json'].sort());
  return bundle;
}
function remoteBackup(root: string, label: string, recipient: string, systemctl?: string) {
  const output = `${root}/encrypted-${label}`;
  const link = checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'readlink',
    `${root}/fixture/backend/releases/1/.snapback4/store.sqlite`]);
  assert.equal(link, '../../../store.sqlite', 'native Snapback internal link changed');
  const releasesMode = checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'stat', '-c', '%a',
    `${root}/fixture/backend/releases`]);
  assert.equal(releasesMode, '775', 'native Snapback release directory mode changed');
  checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'mkdir', '-m', '700', output, `${root}/lock-${label}`]);
  checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'env', 'MCP_RECOVERY_FIXTURE=1', oracleNode,
    `${root}/recovery/backup.mjs`, '--fixture-root', `${root}/fixture`, '--fixture-lock-dir', `${root}/lock-${label}`,
    '--paired', 'yes', '--output-dir', output, '--recipient', recipient, '--age-bin', oracleAge,
    '--release-sha', reviewedSha, ...(systemctl ? ['--fixture-systemctl', systemctl] : [])], 300_000);
  const metadata = checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'cat', `${output}/bundle.json`]);
  const bundle = JSON.parse(metadata) as Bundle;
  assert.match(bundle.snapshotId, /^[0-9a-f-]{36}$/);
  const local = join(backupParent, `paired-${root.split('/').at(-1)}-${label}`);
  ensureNew(local);
  for (const name of [bundle.data, bundle.keys, 'bundle.json']) {
    assert.match(name, /^[a-z0-9.-]+$/);
    checked('scp', ['-q', `oracle:${output}/${name}`, join(local, name)], 300_000);
    chmodSync(join(local, name), 0o600);
  }
  return { local, bundle: verifyBundle(local), nativeLayout: { releasesMode, storeLink: link } };
}
function recoveryArgs(recovery: string, name: string) { return join(recovery, `${name}.mjs`); }
function fixtureControl(root: string, label: string, installationId: string) {
  const fixture = join(root, `control-${label}`), external = join(root, `external-${label}`);
  const lock = join(root, `lock-${label}`), latch = join(external, 'restore-latch');
  for (const path of [fixture, external, lock]) ensureNew(path);
  for (const name of ['state', 'backend']) ensureNew(join(fixture, name));
  FileRestoreLatch.provisionFresh({ path: latch, installationId,
    restoredDirectories: [join(fixture, 'state'), join(fixture, 'backend')] });
  return { fixture, lock, latch };
}
function restorePair(root: string, label: string, backup: { local: string; bundle: Bundle },
  recovery: string, age: string, key: string, installationId: string, systemctl?: string) {
  const control = fixtureControl(root, label, installationId);
  const latch = new FileRestoreLatch({ path: control.latch, installationId,
    restoredDirectories: [join(control.fixture, 'state'), join(control.fixture, 'backend')] });
  const originalEpoch = latch.readGeneration();
  assert.ok(originalEpoch && !originalEpoch.restored);
  const env = { ...process.env, MCP_RECOVERY_FIXTURE: '1' };
  const bundle = join(backup.local, 'bundle.json'), intentLog = join(controller, 'restore-intents.jsonl');
  const priorLines = existsSync(intentLog) ? readFileSync(intentLog, 'utf8').trim().split('\n').length : 0;
  checked(process.execPath, [recoveryArgs(recovery, 'restore-intent'), '--fixture-root', control.fixture,
    '--fixture-lock-dir', control.lock, '--controller-dir', controller, '--bundle', bundle,
    '--installation-id', installationId, '--latch', control.latch,
    ...(systemctl ? ['--fixture-systemctl', systemctl, '--current-release-sha', reviewedSha] : [])], 90_000, env);
  const newLines = readFileSync(intentLog, 'utf8').trim().split('\n').slice(priorLines);
  assert.equal(newLines.length, 2, 'controller must durably record exactly one intent and latch receipt');
  const controllerReceipt = newLines.map(line => JSON.parse(line) as {
    type: string; intentId: string; snapshotId: string; currentReleaseSha?: string });
  assert.deepEqual(controllerReceipt.map(row => row.type), ['restore_intent', 'latch_marked']);
  assert.equal(controllerReceipt[0].intentId, controllerReceipt[1].intentId);
  assert.ok(controllerReceipt.every(row => row.snapshotId === backup.bundle.snapshotId));
  if (systemctl) assert.ok(controllerReceipt.every(row => row.currentReleaseSha === reviewedSha));
  const marked = readFileSync(control.latch, 'utf8');
  assert.equal(marked, JSON.stringify({ installationId, version: 1 }) +
    `\nrestored ${controllerReceipt[0].intentId}\n`);
  const restoredEpoch = latch.readGeneration();
  assert.ok(restoredEpoch?.restored && restoredEpoch.generation !== originalEpoch.generation);
  const missing = join(root, `missing-${label}`); ensureNew(missing);
  copyFileSync(bundle, join(missing, 'bundle.json')); copyFileSync(join(backup.local, backup.bundle.data), join(missing, backup.bundle.data));
  const missingTarget = join(root, `refused-missing-${label}`);
  refused(process.execPath, [recoveryArgs(recovery, 'restore-isolated'), '--fixture-root', control.fixture,
    '--bundle', join(missing, 'bundle.json'), '--identity', key, '--age-bin', age, '--target', missingTarget,
    '--latch', control.latch, '--installation-id', installationId, '--intent-log', intentLog], 60_000, env);
  assert.equal(existsSync(missingTarget), false);
  const wrongKey = join(root, `wrong-${label}.txt`);
  checked(join(dirname(age), 'age-keygen'), ['-o', wrongKey]);
  const wrongTarget = join(root, `refused-wrong-${label}`);
  refused(process.execPath, [recoveryArgs(recovery, 'restore-isolated'), '--fixture-root', control.fixture,
    '--bundle', bundle, '--identity', wrongKey, '--age-bin', age, '--target', wrongTarget,
    '--latch', control.latch, '--installation-id', installationId, '--intent-log', intentLog], 60_000, env);
  assert.equal(existsSync(wrongTarget), false);
  const target = join(root, `restored-${label}`);
  checked(process.execPath, [recoveryArgs(recovery, 'restore-isolated'), '--fixture-root', control.fixture,
    '--bundle', bundle, '--identity', key, '--age-bin', age, '--target', target,
    '--latch', control.latch, '--installation-id', installationId, '--intent-log', intentLog], 300_000, env);
  assert.equal(readFileSync(control.latch, 'utf8'), marked);
  assert.ok(existsSync(join(target, 'state/provider.sqlite')) && existsSync(join(target, 'state/vault.sqlite')));
  return { target, latch: control.latch, marked, authorizationEpoch: restoredEpoch.generation,
    controllerReceipt: { intentId: controllerReceipt[0].intentId, types: controllerReceipt.map(row => row.type),
      snapshotId: backup.bundle.snapshotId },
    negative: { missingKey: true, wrongIdentity: true } };
}

async function openMacGraph(root: string, target: string, latch: string, main: string, cli: string) {
  await portsFree();
  const runtime = join(root, `runtime-${randomUUID()}`);
  cpSync(target, runtime, { recursive: true, preserveTimestamps: true });
  const state = join(runtime, 'state'), backend = join(runtime, 'backend');
  const configFile = join(runtime, 'keys/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  Object.assign(config, { publicOrigin, backendUrl, dataDirectory: state, keyFile: join(runtime, 'keys/keys.json'),
    port: ports.main, operations: { ...config.operations, latchPath: latch, backendDirectory: backend } });
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const tlsDir = join(root, `tls-${randomUUID()}`), tls = certs(tlsDir);
  setDefaultCACertificates([...getCACertificates('default'), tls.ca]);
  let host: Awaited<ReturnType<typeof startServe>> | undefined;
  let backendServer: ReturnType<typeof createTlsServer> | undefined;
  let publicServer: ReturnType<typeof createTlsServer> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const output: Buffer[] = [];
  const clients = new Set<Client>();
  const connectRead = async (token: string) => {
    const client = await connect(token); clients.add(client); return client;
  };
  const stop = async () => {
    await closeAcquired([
      async () => {
        const result = await Promise.allSettled([...clients].map(client => client.close()));
        const failures = result.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(entry => entry.reason), 'SDK client cleanup failed');
      },
      async () => {
        const running = child;
        if (!running) return;
        if (running.exitCode === null && running.signalCode === null) { running.kill('SIGTERM');
          await Promise.race([new Promise<void>(ok => running.once('exit', () => ok())), pause(10_000)]); }
        if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
        writeFileSync(join(root, `runtime-${randomUUID()}.log`), Buffer.concat(output), { mode: 0o600 });
      },
      async () => { if (publicServer) await closeServer(publicServer); },
      async () => { if (backendServer) await closeServer(backendServer); },
      async () => { if (host) await host.stop(); },
      async () => { rmSync(tlsDir, { recursive: true, force: true }); },
    ]);
  };
  try {
    host = await startServe(backend, { logsDir: join(root, `snapback-logs-${randomUUID()}`),
      env: { ...process.env, SNAPBACK4_BIN: cli, PORT_LO: String(ports.low), PORT_HI: String(ports.high) } });
    backendServer = await tlsProxy(ports.backend, new URL(host.url), tls);
    publicServer = await tlsProxy(ports.public, new URL(`http://127.0.0.1:${ports.main}`), tls);
    const running = spawn(process.execPath, [main], { cwd: resolve(main, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MCP_CONFIG_PATH: configFile, NODE_EXTRA_CA_CERTS: tls.caPath } });
    child = running;
    for (const stream of [running.stdout, running.stderr]) stream.on('data', part => {
      if (output.length < 64) output.push(Buffer.from(part));
    });
    await waitHealth();
    return { connectRead, runtime, stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'graph startup and cleanup failed', { cause: cleanupError });
    }
    throw error;
  }
}

function hidden(html: string, name: string) {
  const encoded = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(encoded, `missing synthetic ${name} field`);
  return encoded.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
async function approveQuote(quote: Quote, cookieHeader: string) {
  const page = await fetch(quote.confirmationUrl, { headers: { cookie: cookieHeader } });
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const cookie = cookieHeader + '; ' + page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const approved = await fetch(`${publicOrigin}/mcp/reward-confirmation`, { method: 'POST',
    headers: { cookie, origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: hidden(html, 'token'), csrf: hidden(html, 'csrf'), decision: 'approve' }) });
  assert.equal(approved.status, 200, await approved.clone().text());
}
async function assertOldAuthorityRevoked(provider: ReturnType<typeof syntheticOAuthClient>,
  oldToken: string, oldCookie: string) {
  const access = await fetch(`${publicOrigin}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${oldToken}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stale-paired', version: '1' } } }) });
  assert.equal(access.status, 401, 'pre-restore access token regained authority');
  const oldRefresh = provider.tokens()?.refresh_token;
  const clientId = provider.clientInformation()?.client_id;
  assert.ok(oldRefresh && clientId, 'pre-restore OAuth custody absent');
  const refresh = await fetch(`${publicOrigin}/mcp/auth/oauth2/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId,
      resource: `${publicOrigin}/mcp`,
    }) });
  assert.equal(refresh.status, 400, 'pre-restore refresh token regained authority');
  const refreshBody = await refresh.json() as { error?: unknown };
  assert.equal(refreshBody.error, 'invalid_grant', 'stale refresh returned the wrong OAuth refusal');
  const browser = await fetch(provider.authorizationUrl(), { redirect: 'manual',
    headers: { cookie: oldCookie } });
  assert.equal(browser.status, 401, 'pre-restore browser session regained authority');
  return { accessStatus: access.status, refreshStatus: refresh.status,
    refreshError: refreshBody.error, browserStatus: browser.status };
}
async function assertFullConsentForbidden() {
  const provider = syntheticOAuthClient(`blocked restored write ${randomUUID()}`);
  assert.equal(await auth(provider, { serverUrl: `${publicOrigin}/mcp`,
    scope: 'habits:read checkins:write offline_access' }), 'REDIRECT');
  const start = await fetch(provider.authorizationUrl(), { redirect: 'manual' });
  assert.equal(start.status, 200, 'full-write authorization did not return its redirect envelope');
  assert.match(start.headers.get('content-type') ?? '', /^application\/json/);
  const envelope = await start.json() as { redirect?: unknown; url?: unknown };
  assert.equal(envelope.redirect, true);
  assert.equal(typeof envelope.url, 'string');
  const signInUrl = new URL(envelope.url as string, publicOrigin);
  assert.equal(signInUrl.origin, publicOrigin);
  assert.equal(signInUrl.pathname, '/mcp/sign-in');
  const signIn = await fetch(signInUrl, { redirect: 'manual' });
  assert.equal(signIn.status, 403, 'full-write sign-in opened under degraded read');
  const consentUrl = new URL(signInUrl);
  consentUrl.pathname = '/mcp/consent';
  const consent = await fetch(consentUrl, { redirect: 'manual' });
  assert.equal(consent.status, 403, 'full consent opened under degraded read');
  return consent.status;
}
async function freshReadConnection(graph: Awaited<ReturnType<typeof openMacGraph>>,
  original: ReturnType<typeof syntheticOAuthClient>, credentials: { email: string; password: string },
  boardId?: string) {
  const client = syntheticOAuthClient(`restored synthetic read ${randomUUID()}`);
  const registered = original.clientInformation();
  assert.ok(registered?.client_id, 'original client registration absent');
  client.saveClientInformation(registered);
  await authorizeSynthetic(`${publicOrigin}/mcp`, client, credentials);
  assert.equal(client.clientInformation()?.client_id, registered.client_id, 'client lineage changed');
  const token = client.tokens()?.access_token;
  assert.ok(token, 'fresh read token absent');
  const sdk = await graph.connectRead(token);
  if (boardId) {
    const board = data<{ id: string; title: string }>(await sdk.callTool({ name: 'get_habit',
      arguments: { habitId: boardId } }));
    assert.equal(board.id, boardId, 'recovered SDK read did not return the seeded board');
    assert.equal(board.title, 'synthetic paired board');
  }
  return { sdk, clientId: registered.client_id };
}
function installCA(value: unknown) {
  if (typeof value !== 'string') throw Error('oracle CA certificate missing');
  const cert = Buffer.from(value, 'base64').toString('utf8');
  assert.match(cert, /BEGIN CERTIFICATE/);
  setDefaultCACertificates([...getCACertificates('default'), cert]);
}
async function run() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.22.2'); assert.equal(process.versions.bun, undefined);
  assert.equal(process.env.MCP_PAIR_AUTH_EPOCH_APPROVED, '1', 'new runtime and recovery reviews must be accepted');
  assert.equal(process.env.MCP_PAIR_PORTS_RELEASED, '1', 'coordinate 4450-4455 with Linux helper owner');
  oracleRuntimeEnv();
  assert.notEqual(reviewedSha, priorReleaseSha, 'the old reviewed release cannot prove the new authorization epoch');
  assert.notEqual(reviewedMainHash, priorMainHash, 'the old main cannot prove the new authorization epoch');
  const age = process.env.MCP_PAIR_AGE_MAC, main = process.env.MCP_PAIR_MAIN_MAC;
  const bundle = process.env.MCP_PAIR_ORACLE_BUNDLE;
  assert.ok(age && main && bundle, 'set pinned Mac age, reviewed Mac main and Oracle helper bundle paths');
  assert.equal(digest(main), reviewedMainHash, 'Mac main must equal the newly reviewed ARM bundle');
  assert.ok(bundle.startsWith(`${oracleRoot}/`));
  assert.equal(checked(age, ['--version']), 'v1.3.2');
  const cli = resolve('services/mcp/node_modules/snapback4-darwin-arm64/snapback4');
  assert.match(checked(cli, ['--version']), /0\.4\.49/);
  for (const path of [backupParent, controller, rehearsalParent, dirname(identity)]) privateDirectory(path);
  assert.equal(statSync(identity).mode & 0o077, 0, 'age identity must be private');
  const recipient = checked(join(dirname(age), 'age-keygen'), ['-y', identity]);
  assert.match(recipient, /^age1[0-9a-z]{20,120}$/);
  assert.equal(checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'systemctl', 'show',
    'habit-mcp-synthetic-acceptance-20261030', '--property=ActiveState', '--value']), 'inactive');
  checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'test', '-d', source]);
  checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'test', '-f', sourceLatch]);
  await portsFree();
  const id = randomUUID(), oracle = `${oracleRoot}/paired-${id}`, local = join(rehearsalParent, `paired-${id}`);
  ensureNew(local);
  const recovery = resolve('ops/mcp/recovery');
  const evidence: Record<string, unknown> = { kind: 'synthetic_actual_sdk_paired_restore', id,
    reviewedSha, reviewedMainHash, helperBundleSha256: digest(process.argv[1]!),
    oracleSnapbackSha256: cliHash, macSnapbackSha256: digest(cli), macAgeSha256: digest(age),
    recoveryHashes: Object.fromEntries(readdirSync(recovery)
      .filter(name => name.endsWith('.mjs')).map(name => [name, digest(join(recovery, name))])),
    oracleFixture: 'private cold copy of reviewed-b3f05d2/fixture',
    controllerMode: 'mac fixture intent and latch with scoped real oracle synthetic systemd units' };
  let worker: RemoteWorker | undefined, forwarding: ReturnType<typeof tunnel> | undefined;
  let unitsStarted = false;
  let installationId = '';
  let assertionsPassed = false;
  const stopRemote = async (label: string) => {
    const acquiredWorker = worker, acquiredTunnel = forwarding;
    worker = undefined; forwarding = undefined;
    await closeAcquired([
      async () => {
        if (!acquiredWorker) return;
        let stopFailure: unknown;
        try { await acquiredWorker.stop(join(local, `oracle-${label}.log`)); }
        catch (error) { stopFailure = error; }
        let proofFailure: unknown;
        try {
          const proof = await acquiredWorker.verifyGone();
          const stops = (evidence.remoteWorkerStops ??= []) as object[];
          stops.push({ label, ...proof, sshExitCode: acquiredWorker.process.exitCode });
        } catch (error) { proofFailure = error; }
        if (stopFailure || proofFailure) {
          throw new AggregateError([stopFailure, proofFailure].filter(Boolean), 'remote worker stop or proof failed');
        }
      },
      async () => { if (acquiredTunnel) await stopTunnel(acquiredTunnel); },
    ]);
  };
  const launch = async (existing: boolean) => {
    await portsFree();
    worker = new RemoteWorker(bundle, oracle, existing);
    const started = await worker.wait('worker_started', 30_000);
    assert.equal(started.nonce, worker.nonce);
    assert.ok(Number.isSafeInteger(started.pid) && typeof started.startTicks === 'string');
    const ready = await worker.wait('ready', 30_000);
    installCA(ready.ca);
    if (typeof ready.installationId !== 'string') throw Error('oracle installation id missing');
    installationId = ready.installationId;
    forwarding = tunnel();
    await pause(400);
    assert.equal(forwarding.exitCode, null, 'ssh TLS tunnel exited');
    await waitHealth();
  };
  try {
    await launch(false);
    const seeded = await seed(local);
    const provider = syntheticOAuthClient(`synthetic paired ${id}`);
    const browser = await authorizeSyntheticWrite(`${publicOrigin}/mcp`, provider, seeded.credentials,
      'habits:read coins:read checkins:write rewards:claim offline_access');
    const token = provider.tokens()!.access_token;
    let client = await connect(token);
    data(await client.callTool({ name: 'list_habits', arguments: {} }));
    const quote = data<Quote>(await client.callTool({ name: 'get_reward_claim_preview', arguments: {
      operationId: randomUUID(), rewardId: seeded.rewardId, timeZone: 'UTC' } }));
    const pendingId = randomUUID();
    worker!.send('arm'); await worker!.wait('armed');
    const pendingCall = client.callTool({ name: 'create_checkin', arguments: {
      operationId: pendingId, habitId: seeded.boardId, timeZone: 'UTC' } }).catch(() => undefined);
    await worker!.wait('held', 30_000);
    worker!.send('inspect', { operationId: pendingId, boardId: seeded.boardId });
    const atHold = (await worker!.wait('inspection')).value as ReturnType<typeof sample>;
    assert.deepEqual(atHold.operation, { state: 'pending_sync', delivery: 'pending' });
    assert.ok(atHold.outbox > 0 && atHold.pendingTuples > 0 && atHold.quotes > 0);
    assert.equal(atHold.checkins, 5, 'four seeded check-ins plus the held SDK check-in required');
    assert.equal(atHold.effectRows, 1, 'held SDK receipt must name the fifth stored check-in');
    assert.equal(atHold.receipt.clientId, provider.clientInformation()?.client_id,
      'held operation did not retain the original OAuth client lineage');
    worker!.send('inspect-queue', { operationId: pendingId, clientId: atHold.receipt.clientId });
    const heldQueue = (await worker!.wait('queue-inspection')).value as ReturnType<typeof queueSnapshot>;
    const heldQueueHashes = queueHashes(heldQueue);
    assert.equal(heldQueue.outbox.length, atHold.outbox);
    assert.equal(heldQueue.tuples.filter(row => row.disposition === null).length, atHold.pendingTuples);
    worker!.send('kill'); await worker!.wait('killed');
    await Promise.race([pendingCall, pause(10_000)]);
    await client.close().catch(() => undefined);
    evidence.atHeldResponse = { state: atHold.operation, outbox: atHold.outbox,
      pendingTuples: atHold.pendingTuples, quoteRows: atHold.quotes, checkins: atHold.checkins,
      fifthCheckinId: atHold.receipt.checkInId, clientId: atHold.receipt.clientId,
      journalHead: atHold.head, coreAndJournalReceiptMatch: atHold.receipt.matchesCore,
      queueHashes: heldQueueHashes };
    await stopRemote('pending');
    checked('scp', ['-q', '-r', recovery, `oracle:${oracle}/recovery`], 60_000);
    const archiveA = remoteBackup(oracle, 'a', recipient);
    evidence.archiveA = { snapshotId: archiveA.bundle.snapshotId, dataSha256: archiveA.bundle.dataSha256,
      keysSha256: archiveA.bundle.keysSha256, offhostVerified: true, nativeLayout: archiveA.nativeLayout };
    await launch(true);
    client = await connect(token);
    const laterId = randomUUID();
    const later = data<Receipt>(await client.callTool({ name: 'create_checkin', arguments: {
      operationId: laterId, habitId: seeded.boardId, timeZone: 'UTC' } }));
    assert.equal(later.state, 'backend_acknowledged');
    await approveQuote(quote, browser.cookieHeader());
    const claimed = data<Receipt>(await client.callTool({ name: 'claim_reward', arguments: {
      operationId: quote.operationId, confirmationToken: quote.confirmationToken } }));
    assert.equal(claimed.state, 'backend_acknowledged');
    worker!.send('inspect', { operationId: laterId, boardId: seeded.boardId });
    const advanced = (await worker!.wait('inspection')).value as ReturnType<typeof sample>;
    assert.ok(advanced.checkins > atHold.checkins);
    assert.equal(advanced.effectRows, 1);
    assert.equal(advanced.receipt.clientId, atHold.receipt.clientId);
    evidence.advanced = { countState: later.state, claimState: claimed.state,
      checkins: advanced.checkins, journalHead: advanced.head };
    await client.close();
    await stopRemote('advanced');
    unitsStarted = true;
    const activeUnits = await oracleUnits(oracle, 'start');
    assert.deepEqual([activeUnits.main, activeUnits.backend], ['active', 'active']);
    const oracleWrapper = `${oracle}/fixture-systemctl`;
    const macWrapper = join(local, 'fixture-systemctl');
    writeFileSync(macWrapper, wrapperSource(process.execPath,
      ['ssh', '-o', 'BatchMode=yes', 'oracle', ...oracleRuntimeEnv(), oracleNode, bundle, 'oracle-systemctl', oracle]),
    { mode: 0o700 });
    const archiveB = remoteBackup(oracle, 'b', recipient, oracleWrapper);
    const afterBackup = await oracleUnits(oracle, 'status');
    assert.deepEqual([afterBackup.main, afterBackup.backend], ['active', 'active']);
    evidence.archiveB = { snapshotId: archiveB.bundle.snapshotId, dataSha256: archiveB.bundle.dataSha256,
      keysSha256: archiveB.bundle.keysSha256, offhostVerified: true, nativeLayout: archiveB.nativeLayout,
      actualOracleUnitRestart: afterBackup };
    const restoredA = restorePair(local, 'a', archiveA, recovery, age, identity, installationId, macWrapper);
    const afterIntent = await oracleUnits(oracle, 'status');
    assert.deepEqual([afterIntent.main, afterIntent.backend], ['inactive', 'inactive']);
    const audit = checked('ssh', ['-o', 'BatchMode=yes', 'oracle', 'cat',
      `${oracle}/fixture-systemctl-audit.jsonl`]).split('\n').map(line => JSON.parse(line) as {
      command: string; actualUnit: string; actualState: string });
    const names = unitNames(oracle);
    assert.deepEqual(audit.filter(row => row.command === 'stop').map(row => row.actualUnit),
      [names.main, names.backend, names.main, names.backend]);
    assert.deepEqual(audit.filter(row => row.command === 'start').map(row => row.actualUnit),
      [names.backend, names.main]);
    assert.ok(audit.filter(row => row.command === 'stop').every(row => row.actualState === 'inactive'));
    assert.ok(audit.filter(row => row.command === 'start').every(row => row.actualState === 'active'));
    evidence.syntheticSystemd = { beforeBackup: activeUnits, afterBackup, afterOffhostIntent: afterIntent,
      mappedUnits: [names.main, names.backend], actualStopCalls: 4, actualStartCalls: 2,
      controllerReceipt: restoredA.controllerReceipt,
      latchMarkedAfterOracleStop: true };
    const restoredB = restorePair(local, 'b', archiveB, recovery, age, identity, installationId);
    evidence.restoreRefusals = { a: restoredA.negative, b: restoredB.negative,
      missingTargetsAbsent: true, wrongIdentityTargetsAbsent: true };
    evidence.controllerB = restoredB.controllerReceipt;
    const restoredAQueue = assertQueueRetained(heldQueue, restoredA.target, pendingId, atHold.receipt.clientId);
    evidence.archiveAQueue = { ...restoredAQueue, checkedBeforeReopen: true };
    const recovered = await openMacGraph(local, restoredA.target, restoredA.latch, main, cli);
    try {
      const stale = await assertOldAuthorityRevoked(provider, token, browser.cookieHeader());
      const read = await freshReadConnection(recovered, provider, seeded.credentials, seeded.boardId);
      const before = sample(recovered.runtime, pendingId, seeded.boardId);
      assert.deepEqual(before.operation, { state: 'pending_sync', delivery: 'pending' });
      assert.equal(before.receipt.operationId, pendingId);
      assert.equal(before.receipt.checkInId, atHold.receipt.checkInId);
      assert.equal(before.receipt.clientId, atHold.receipt.clientId);
      assert.equal(read.clientId, before.receipt.clientId, 'restored A changed stored client lineage');
      assert.equal(before.receipt.matchesCore, true);
      assert.equal(before.checkins, atHold.checkins, 'old matching pair created a second effect');
      assert.equal(before.effectRows, 1, 'restored A lost the fifth check-in row');
      const status = data<{ writeFenced: boolean }>(await read.sdk.callTool({ name: 'get_sync_status', arguments: {} }));
      assert.equal(status.writeFenced, true);
      const blockedLookup = await read.sdk.callTool({ name: 'get_operation', arguments: { operationId: pendingId } });
      assert.equal(errorCode(blockedLookup), 'OPERATION_PENDING', 'marked restore latch must fence public lookup');
      assert.equal(before.quotes, 1, 'restored A lost the retained quote row');
      const quoteAtRestore = retainedQuote(recovered.runtime, quote);
      const previewStartedAt = Date.now();
      const quoteAgain = data<Quote>(await read.sdk.callTool({ name: 'get_reward_claim_preview', arguments: {
        operationId: quote.operationId, rewardId: seeded.rewardId, timeZone: 'UTC' } }));
      const previewFinishedAt = Date.now();
      assert.equal(quoteAgain.operationId, quote.operationId);
      assert.equal(quoteAgain.reward.id, seeded.rewardId);
      assert.ok(quoteAgain.expiresAtUtc > previewStartedAt, 'preview returned an expired quote');
      let quotePreviewOutcome = 'expiry_boundary';
      if (quoteAtRestore.expiresAtUtc > previewFinishedAt) {
        assert.equal(quoteAgain.confirmationToken, quote.confirmationToken, 'unexpired retained quote changed');
        quotePreviewOutcome = 'retained_valid_quote';
      } else if (quoteAtRestore.expiresAtUtc <= previewStartedAt) {
        assert.notEqual(quoteAgain.confirmationToken, quote.confirmationToken, 'expired quote was reused');
        quotePreviewOutcome = 'renewed_expired_quote';
      }
      retainedQuote(recovered.runtime, quoteAgain);
      const fenced = await read.sdk.callTool({ name: 'create_checkin', arguments: {
        operationId: pendingId, habitId: seeded.boardId, timeZone: 'UTC' } });
      assert.equal(errorCode(fenced), 'FORBIDDEN', 'read grant admitted a write before actor fence');
      const fullConsentStatus = await assertFullConsentForbidden();
      const after = sample(recovered.runtime, pendingId, seeded.boardId);
      assert.equal(after.checkins, before.checkins); assert.equal(after.outbox, before.outbox);
      assert.equal(after.effectRows, 1);
      assert.deepEqual(after.receipt, before.receipt, 'retained receipt changed after refused retry');
      assert.equal(readFileSync(restoredA.latch, 'utf8'), restoredA.marked);
      evidence.recoveredA = { oldAuthority: stale, freshRead: { boardId: seeded.boardId,
        sameClientId: read.clientId === provider.clientInformation()?.client_id },
      retainedReceipt: before.receipt, publicLookupFenced: errorCode(blockedLookup),
      queue: before.outbox, quoteAtRestoreRetained: true, quotePreviewOutcome, journalHead: before.head,
      oneEffect: true, sameIdWriteDenied: errorCode(fenced), fullConsentStatus,
      writeFenced: status.writeFenced, authorizationEpoch: restoredA.authorizationEpoch,
      latchRetained: true };
    } finally { await recovered.stop(); }
    const recoveredB = await openMacGraph(local, restoredB.target, restoredB.latch, main, cli);
    try {
      const stale = await assertOldAuthorityRevoked(provider, token, browser.cookieHeader());
      const read = await freshReadConnection(recoveredB, provider, seeded.credentials, seeded.boardId);
      const before = sample(recoveredB.runtime, laterId, seeded.boardId);
      const heldInB = sample(recoveredB.runtime, pendingId, seeded.boardId);
      assert.equal(heldInB.receipt.checkInId, atHold.receipt.checkInId);
      assert.equal(heldInB.receipt.clientId, atHold.receipt.clientId);
      assert.equal(heldInB.effectRows, 1, 'restored B lost the fifth check-in row');
      assert.deepEqual(before.operation, { state: 'backend_acknowledged', delivery: 'acknowledged' });
      assert.equal(before.checkins, advanced.checkins);
      assert.equal(before.effectRows, 1);
      assert.equal(before.receipt.clientId, advanced.receipt.clientId);
      assert.equal(read.clientId, before.receipt.clientId, 'restored B changed stored client lineage');
      assert.equal(before.receipt.checkInId, advanced.receipt.checkInId);
      const status = data<{ writeFenced: boolean }>(await read.sdk.callTool({ name: 'get_sync_status', arguments: {} }));
      assert.equal(status.writeFenced, true);
      const blockedLookup = await read.sdk.callTool({ name: 'get_operation', arguments: { operationId: laterId } });
      assert.equal(errorCode(blockedLookup), 'OPERATION_PENDING', 'marked restore latch must fence B lookup');
      const denied = await read.sdk.callTool({ name: 'create_checkin', arguments: {
        operationId: laterId, habitId: seeded.boardId, timeZone: 'UTC' } });
      assert.equal(errorCode(denied), 'FORBIDDEN');
      const fullConsentStatus = await assertFullConsentForbidden();
      const after = sample(recoveredB.runtime, laterId, seeded.boardId);
      assert.equal(after.checkins, before.checkins);
      assert.equal(after.effectRows, 1);
      assert.deepEqual(after.receipt, before.receipt);
      const heldAfter = sample(recoveredB.runtime, pendingId, seeded.boardId);
      assert.deepEqual(heldAfter.receipt, heldInB.receipt);
      assert.equal(heldAfter.effectRows, 1);
      assert.equal(readFileSync(restoredB.latch, 'utf8'), restoredB.marked);
      evidence.recoveredB = { oldAuthority: stale, freshSeededBoardRead: true,
        retainedReceipt: before.receipt, oneEffect: true, publicLookupFenced: errorCode(blockedLookup),
        writeDenied: errorCode(denied), fullConsentStatus,
        writeFenced: status.writeFenced, authorizationEpoch: restoredB.authorizationEpoch,
        latchRetained: true };
    } finally { await recoveredB.stop(); }
    for (const [label, stateFrom, backendFrom, latch] of [
      ['advanced-backend', restoredA.target, restoredB.target, restoredA.latch],
      ['advanced-local', restoredB.target, restoredA.target, restoredB.latch],
    ] as const) {
      const mixed = join(local, `mixed-${label}`);
      cpSync(stateFrom, mixed, { recursive: true, preserveTimestamps: true });
      rmSync(join(mixed, 'backend'), { recursive: true, force: true });
      cpSync(join(backendFrom, 'backend'), join(mixed, 'backend'), { recursive: true, preserveTimestamps: true });
      const expectedLatch = label === 'advanced-backend' ? restoredA.marked : restoredB.marked;
      assert.equal(readFileSync(latch, 'utf8'), expectedLatch);
      const before = sample(mixed, pendingId, seeded.boardId);
      assert.equal(before.effectRows, 1, 'mixed graph lost the held fifth check-in');
      assert.equal(before.receipt.checkInId, atHold.receipt.checkInId);
      assert.equal(before.receipt.clientId, atHold.receipt.clientId);
      let graph: Awaited<ReturnType<typeof openMacGraph>>;
      try {
        graph = await openMacGraph(local, mixed, latch, main, cli);
      } catch (failure) {
        const after = sample(mixed, pendingId, seeded.boardId);
        assert.equal(after.checkins, before.checkins);
        assert.equal(after.effectRows, before.effectRows);
        assert.deepEqual(after.receipt, before.receipt);
        assert.equal(readFileSync(latch, 'utf8'), expectedLatch);
        evidence[label] = { outcome: 'startup_failed', reason: String(failure),
          retainedReceipt: after.receipt, checkins: after.checkins, externalLatchRetained: true };
        requireMixedStartup(false, failure);
        throw failure;
      }
      try {
        const read = await freshReadConnection(graph, provider, seeded.credentials);
        const status = await read.sdk.callTool({ name: 'get_sync_status', arguments: {} });
        assert.equal(errorCode(status), 'UNAVAILABLE', 'mixed graph exposed status before a complete pull');
        const cachedStatus = await read.sdk.callTool({ name: 'get_sync_status',
          arguments: { freshness: 'allow_cached' } });
        assert.equal(errorCode(cachedStatus), 'UNAVAILABLE', 'mixed graph exposed an unsafe cached status');
        const fullConsentStatus = await assertFullConsentForbidden();
        const readResult = await read.sdk.callTool({ name: 'get_habit', arguments: { habitId: seeded.boardId } });
        const readOutcome = errorCode(readResult);
        assert.equal(readOutcome, 'UNAVAILABLE', 'mixed graph returned product data before a complete pull');
        const lookupResult = await read.sdk.callTool({ name: 'get_operation', arguments: { operationId: pendingId } });
        const lookupOutcome = errorCode(lookupResult);
        assert.equal(lookupOutcome, label === 'advanced-backend' ? 'UNAVAILABLE' : 'OPERATION_PENDING');
        const result = await read.sdk.callTool({ name: 'create_checkin', arguments: {
          operationId: randomUUID(), habitId: seeded.boardId, timeZone: 'UTC' } });
        assert.equal(errorCode(result), 'FORBIDDEN', 'mixed graph admitted a write with degraded read authority');
        const after = sample(graph.runtime, pendingId, seeded.boardId);
        assert.equal(after.checkins, before.checkins);
        assert.equal(after.effectRows, before.effectRows);
        assert.deepEqual(after.receipt, before.receipt);
        assert.equal(readFileSync(latch, 'utf8'), expectedLatch);
        requireMixedStartup(true);
        evidence[label] = { outcome: 'graph_started', syncStatusOutcome: errorCode(status),
          cachedSyncOutcome: errorCode(cachedStatus), readOutcome, lookupOutcome,
          writeDenied: errorCode(result), fullConsentStatus,
          retainedReceipt: after.receipt, checkins: after.checkins, externalLatchRetained: true };
      } finally { await graph.stop(); }
    }
    assertionsPassed = true;
  } catch (failure) {
    evidence.failure = String(failure); throw failure;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await stopRemote('finally'); }
    catch (failure) { cleanupFailures.push(failure); process.exitCode = 1; }
    if (unitsStarted) {
      try { evidence.oracleUnitCleanup = await oracleUnits(oracle, 'cleanup'); }
      catch (failure) { cleanupFailures.push(failure); process.exitCode = 1; }
    }
    finalizeEvidence(evidence, assertionsPassed, cleanupFailures);
    writeFileSync(join(local, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: evidence.ok, evidence: join(local, 'evidence.json') }) + '\n');
  }
}

if (process.argv[2] === 'oracle-worker') {
  oracleWorker(process.argv[3]!, process.argv[4] === 'existing', process.argv[5]!).catch(error => {
    emit({ type: 'error', message: String(error) }); process.exitCode = 1;
  });
} else if (process.argv[2] === 'oracle-worker-probe') {
  probeOracleWorker(process.argv[3]!, process.argv[4]!)
    .catch(error => { process.stderr.write(`owned worker probe failed: ${String(error)}\n`); process.exitCode = 1; });
} else if (process.argv[2] === 'oracle-worker-terminate') {
  terminateOracleWorker(process.argv[3]!, process.argv[4]!, process.argv[1]!)
    .catch(error => { process.stderr.write(`owned worker termination refused: ${String(error)}\n`); process.exitCode = 1; });
} else if (process.argv[2] === 'oracle-systemctl') {
  try { oracleSystemctl(process.argv[3]!, process.argv.slice(4)); }
  catch (error) { process.stderr.write(`owned unit wrapper refused: ${String(error)}\n`); process.exitCode = 1; }
} else if (process.argv[2] === 'oracle-units') {
  manageOracleUnits(process.argv[3]!, process.argv[4] as 'start' | 'status' | 'cleanup')
    .catch(error => { process.stderr.write(`owned unit phase failed: ${String(error)}\n`); process.exitCode = 1; });
} else if (process.argv[2] === 'run') {
  run().catch(error => { process.stderr.write(`paired rehearsal failed: ${String(error)}\n`); process.exitCode = 1; });
} else if (process.argv[2] === 'self-check') {
  selfCheck().catch(error => { process.stderr.write(`paired self-check failed: ${String(error)}\n`); process.exitCode = 1; });
}
