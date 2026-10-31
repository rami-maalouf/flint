#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdtempSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copySingle, copyTree, durableFile, fail, hash, options, outside, privateDir, privateFile, required, run } from './common.mjs';
import { backupStopUnits, requireActiveBackupUnits, systemctlBinary } from './systemd.mjs';
import { acquireRecoveryLock, releaseRecoveryLock } from './lock.mjs';

process.umask(0o077);
process.env.COPYFILE_DISABLE = '1';
const args = options(process.argv.slice(2), ['--fixture-root', '--fixture-state-root', '--fixture-backend-root',
  '--fixture-systemctl', '--fixture-lock-dir', '--live', '--paired', '--output-dir', '--recipient', '--age-bin', '--release-sha']);
const fixture = args['--fixture-root'] !== undefined;
const live = args['--live'] === 'yes';
let temporary, active = [], produced = [], lock, restartContext, completedSnapshotId;
try {
  if (fixture === live || (fixture && process.env.MCP_RECOVERY_FIXTURE !== '1')) fail('choose one authorized mode');
  if (!fixture && (args['--fixture-state-root'] || args['--fixture-backend-root'] || args['--fixture-lock-dir'])) {
    fail('fixture options are test-only');
  }
  lock = acquireRecoveryLock(fixture ? required(args['--fixture-lock-dir']) : '/run/habit-system-mcp-recovery');
  const releaseSha = required(args['--release-sha']);
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) fail('invalid release sha');
  const paired = fixture || args['--paired'] === 'yes';
  if (args['--paired'] && args['--paired'] !== 'yes') fail('invalid paired setting');
  const recipient = required(args['--recipient']);
  if (!/^age1[0-9a-z]{20,120}$/.test(recipient)) fail('invalid age recipient');
  const age = required(args['--age-bin']);
  if (run(age, ['--version']) !== 'v1.3.2') fail('age 1.3.2 required');
  const output = privateDir(required(args['--output-dir']));
  if (readdirSync(output).length !== 0) fail('snapshot output must be empty');
  const source = fixture ? privateDir(args['--fixture-root']) : null;
  if (live && process.getuid() !== 0) fail('live snapshot requires root');
  const state = fixture ? privateDir(args['--fixture-state-root'] ?? join(source, 'state')) : '/var/lib/habit-system-mcp';
  const backend = fixture ? privateDir(args['--fixture-backend-root'] ?? join(source, 'backend')) : '/var/lib/habit-system-fullstack';
  const keyFile = fixture ? join(source, 'keys/keys.json') : '/etc/habit-system-mcp/keys.json';
  const configFile = fixture ? join(source, 'keys/config.json') : '/etc/habit-system-mcp/config.json';
  if (!outside(state, output) || !outside(backend, output) || (fixture && !outside(source, output))) {
    fail('snapshot output overlaps application or backend state');
  }
  const systemctl = systemctlBinary(fixture, args['--fixture-systemctl']);
  if (systemctl) {
    restartContext = { systemctl, releaseSha, paired };
    backupStopUnits(systemctl, releaseSha, paired, units => { active = [...units].reverse(); });
  }
  temporary = mkdtempSync(join(output, '.snapshot-'));
  const data = join(temporary, 'data'), keys = join(temporary, 'keys');
  mkdirSync(data, { mode: 0o700 }); mkdirSync(keys, { mode: 0o700 });
  const id = randomUUID();
  const entries = copyTree(state, join(data, 'state')).map(row => ({ ...row, path: `state/${row.path}` }));
  if (paired) entries.push(...copyTree(backend, join(data, 'backend')).map(row => ({ ...row, path: `backend/${row.path}` })));
  writeFileSync(join(data, 'manifest.json'), JSON.stringify({ version: 1, snapshotId: id, releaseSha,
    paired, files: entries.sort((a, b) => a.path.localeCompare(b.path)) }), { mode: 0o600 });
  const keyEntries = [copySingle(configFile, join(keys, 'config.json')), copySingle(keyFile, join(keys, 'keys.json'))];
  writeFileSync(join(keys, 'manifest.json'), JSON.stringify({ version: 1, snapshotId: id, releaseSha,
    files: keyEntries.sort((a, b) => a.path.localeCompare(b.path)) }), { mode: 0o600 });
  const artifacts = {};
  for (const [kind, directory] of [['data', data], ['keys', keys]]) {
    const tar = join(temporary, `${kind}.tar`), name = `${id}-${kind}.age`, encrypted = join(output, name);
    run('tar', ['-C', directory, '-cf', tar, '.'], 300_000);
    produced.push(encrypted);
    run(age, ['-r', recipient, '-o', encrypted, tar], 300_000);
    const fd = openSync(encrypted, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    artifacts[kind] = name;
    artifacts[`${kind}Sha256`] = hash(encrypted);
  }
  const bundle = join(output, 'bundle.json');
  produced.push(bundle);
  durableFile(bundle, JSON.stringify({ version: 1, snapshotId: id, releaseSha, paired, ...artifacts }) + '\n');
  completedSnapshotId = id;
} catch (error) {
  for (const path of produced) {
    try { rmSync(path, { force: true }); }
    catch { console.error('partial encrypted artifact cleanup needs operator attention'); }
  }
  console.error(`backup refused: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true }); }
    catch { console.error('private snapshot cleanup needs operator attention'); process.exitCode = 1; }
  }
  for (const unit of active) {
    try { run(restartContext.systemctl, ['start', unit], 60_000); }
    catch { console.error('service restart needs operator attention'); process.exitCode = 1; }
  }
  if (active.length > 0) {
    try { requireActiveBackupUnits(restartContext.systemctl, restartContext.releaseSha, restartContext.paired); }
    catch { console.error('restart verification failed: expected units are inactive or ambiguous'); process.exitCode = 1; }
  }
  try { releaseRecoveryLock(lock); }
  catch { console.error('recovery lock release needs operator attention'); process.exitCode = 1; }
  if (completedSnapshotId) {
    if (process.exitCode === undefined || process.exitCode === 0) {
      console.log(`encrypted snapshot ${completedSnapshotId} ready for independent off-host transfer and verification`);
    } else {
      console.error('encrypted bundle retained; operational completion failed; verify artifact and service state separately');
    }
  }
}
