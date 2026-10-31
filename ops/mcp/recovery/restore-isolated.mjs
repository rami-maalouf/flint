#!/usr/bin/env node
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendStoreLink, fail, hash, options, outside, privateDir, privateFile, required, run, verifyManifest } from './common.mjs';

process.umask(0o077);
const args = options(process.argv.slice(2), ['--fixture-root', '--offhost', '--bundle', '--identity', '--age-bin', '--target', '--latch', '--installation-id', '--intent-log']);
let temporary;
function occupied(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
try {
  const fixture = args['--fixture-root'] !== undefined;
  if (fixture && process.env.MCP_RECOVERY_FIXTURE !== '1') fail('fixture mode unavailable');
  if (fixture === (args['--offhost'] === 'yes')) fail('choose fixture or off-host mode');
  const target = required(args['--target']);
  if (!isAbsolute(target) || resolve(target) !== target || basename(target) === '.') fail('invalid isolated target');
  privateDir(dirname(target));
  if (occupied(target) || ['/var/lib/habit-system-mcp', '/var/lib/habit-system-fullstack', '/etc/habit-system-mcp',
    '/opt/habit-system-mcp'].some(root => !outside(root, target))) fail('target is occupied or protected');
  if (fixture && !outside(privateDir(args['--fixture-root']), target)) fail('target overlaps fixture source');
  const installationId = required(args['--installation-id']);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installationId)) fail('invalid installation id');
  const marker = JSON.stringify({ installationId, version: 1 }) + '\nrestored\n';
  const latchContent = fixture ? readFileSync(privateFile(required(args['--latch']), true), 'utf8') :
    run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'oracle', 'sudo', '-n', 'cat',
      '/etc/habit-system-mcp/restore-latch'], 30_000, true);
  if (latchContent !== marker) {
    fail('durable restore latch required');
  }
  const identity = privateFile(required(args['--identity']));
  if (!outside(target, identity)) fail('identity cannot be in restore target');
  const age = required(args['--age-bin']);
  if (run(age, ['--version']) !== 'v1.3.2') fail('age 1.3.2 required');
  const bundlePath = privateFile(required(args['--bundle']));
  if (statSync(bundlePath).size > 16_384) fail('bundle exceeds bound');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  if (bundle.version !== 1 || !/^[0-9a-f]{40}$/.test(bundle.releaseSha) ||
    !/^[0-9a-f-]{36}$/.test(bundle.snapshotId) || typeof bundle.paired !== 'boolean') fail('invalid bundle');
  const logPath = privateFile(required(args['--intent-log']));
  if (statSync(logPath).size > 16 * 1024 * 1024) fail('controller log exceeds bound');
  const events = readFileSync(logPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const matching = events.filter(event => event.version === 1 && event.installationId === installationId &&
    event.snapshotId === bundle.snapshotId && event.releaseSha === bundle.releaseSha);
  if (!matching.some((intent, index) => intent.type === 'restore_intent' &&
    matching.some((mark, markIndex) => markIndex > index && mark.type === 'latch_marked' && mark.intentId === intent.intentId))) {
    fail('matching completed off-host restore intent required');
  }
  temporary = mkdtempSync(join(dirname(target), '.restore-'));
  const ready = join(temporary, 'ready');
  for (const kind of ['data', 'keys']) {
    const name = bundle[kind], digest = bundle[`${kind}Sha256`];
    if (name !== `${bundle.snapshotId}-${kind}.age` || !/^[0-9a-f]{64}$/.test(digest)) fail('invalid archive reference');
    const encrypted = privateFile(join(dirname(bundlePath), name));
    if (hash(encrypted) !== digest) fail('archive digest mismatch');
    const tar = join(temporary, `${kind}.tar`), output = kind === 'data' ? ready : join(ready, 'keys');
    run(age, ['-d', '-i', identity, '-o', tar, encrypted], 300_000);
    mkdirSync(output, { mode: 0o700, recursive: true });
    run('uv', ['run', '--no-project', 'python', fileURLToPath(new URL('./safe-tar.py', import.meta.url)), tar, output, kind], 300_000);
    const manifest = verifyManifest(output, kind === 'data' && bundle.paired);
    if (manifest.snapshotId !== bundle.snapshotId || manifest.releaseSha !== bundle.releaseSha ||
      (kind === 'data' && manifest.paired !== bundle.paired)) fail('archive provenance mismatch');
  }
  if (!existsSync(join(ready, 'state')) || (bundle.paired && !existsSync(join(ready, 'backend'))) ||
    !existsSync(join(ready, 'keys/config.json')) || !existsSync(join(ready, 'keys/keys.json'))) fail('incomplete snapshot');
  const accounts = join(ready, 'state/accounts');
  if (existsSync(accounts)) {
    for (const name of readdirSync(accounts)) {
      const account = join(accounts, name);
      if (!lstatSync(account).isDirectory()) fail('unsafe account entry');
      const sidecar = existsSync(join(account, 'operations.sqlite'));
      const journal = existsSync(join(account, 'journal.sqlite'));
      if (sidecar !== journal) fail('incomplete operation history');
    }
  }
  const syncTree = path => {
    for (const name of readdirSync(path)) {
      const child = join(path, name), stat = lstatSync(child);
      if (stat.isDirectory()) syncTree(child);
      else if (stat.isFile()) { const fd = openSync(child, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
      else if (stat.isSymbolicLink() && child.startsWith(join(ready, 'backend') + '/') && bundle.paired) {
        backendStoreLink(join(ready, 'backend'), child.slice(join(ready, 'backend').length + 1));
      }
      else fail('unsafe restored file');
    }
    const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  syncTree(ready);
  if (occupied(target)) fail('isolated target appeared during restore');
  renameSync(ready, target);
  const parent = openSync(dirname(target), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  console.log('isolated snapshot restored; external latch remains write-fenced');
} catch (error) {
  console.error(`isolated restore refused: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true }); }
    catch { console.error('private restore scratch cleanup needs operator attention'); process.exitCode = 1; }
  }
}
