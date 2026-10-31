#!/usr/bin/env node
import { closeSync, constants, fsyncSync, openSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fail, options, outside, privateDir, privateFile, required, run } from './common.mjs';
import { acquireRecoveryLock, releaseRecoveryLock } from './lock.mjs';
import { systemctlBinary } from './systemd.mjs';

process.umask(0o077);
const args = options(process.argv.slice(2), ['--output-dir', '--fixture-backend-root', '--fixture-systemctl',
  '--fixture-lock-dir', '--fixture-tar']);
const fixture = args['--fixture-backend-root'] !== undefined;
let lock, archive, created = false, complete = false, restart = false, systemctl;
const unit = 'habit-system-fullstack.service';
try {
  if (process.version !== 'v24.22.2') fail('pinned node 24.22.2 required');
  if (fixture !== (process.env.MCP_RECOVERY_FIXTURE === '1') ||
    (!fixture && (args['--fixture-systemctl'] || args['--fixture-lock-dir'] || args['--fixture-tar']))) {
    fail('fixture options are test-only');
  }
  if (!fixture && process.getuid() !== 0) fail('live native backup requires root');
  lock = acquireRecoveryLock(fixture ? required(args['--fixture-lock-dir']) : '/run/habit-system-mcp-recovery');
  const backend = fixture ? privateDir(args['--fixture-backend-root']) : privateDir('/var/lib/habit-system-fullstack', true);
  const output = privateDir(required(args['--output-dir']));
  if (!outside(backend, output)) fail('native backup output overlaps backend state');
  systemctl = systemctlBinary(fixture, args['--fixture-systemctl']);
  if (!systemctl) fail('systemctl required');
  const tar = fixture && args['--fixture-tar'] ? privateFile(args['--fixture-tar']) : '/usr/bin/tar';
  const state = () => run(systemctl, ['show', '--property=ActiveState', '--value', unit]);
  const initial = state();
  if (initial !== 'active' && initial !== 'inactive') fail('ambiguous backend unit state');
  restart = initial === 'active';
  if (restart) run(systemctl, ['stop', unit], 60_000);
  if (state() !== 'inactive') fail('backend unit remains active');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  archive = join(output, `habit-system-${stamp}.tar.gz`);
  const fd = openSync(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  created = true; closeSync(fd);
  run(tar, ['-czf', archive, '-C', backend, 'deployment'], 300_000);
  chmodSync(archive, 0o600);
  const read = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(read); } finally { closeSync(read); }
  const parent = openSync(output, constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  complete = true;
} catch (error) {
  console.error(`native backup refused: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  if (created && !complete) {
    try { rmSync(archive, { force: true }); }
    catch { console.error('partial native archive cleanup needs operator attention'); process.exitCode = 1; }
  }
  if (restart) {
    try { run(systemctl, ['start', unit], 60_000); }
    catch { console.error('backend restart needs operator attention'); process.exitCode = 1; }
  }
  if (systemctl) {
    try {
      const expected = restart ? 'active' : 'inactive';
      if (run(systemctl, ['show', '--property=ActiveState', '--value', unit]) !== expected) {
        fail('backend state differs from initial state');
      }
      if (restart && run(systemctl, ['is-active', unit]) !== 'active') fail('backend is not active');
    } catch { console.error('backend restart verification failed'); process.exitCode = 1; }
  }
  try { releaseRecoveryLock(lock); }
  catch { console.error('recovery lock release needs operator attention'); process.exitCode = 1; }
  if (complete) {
    if (process.exitCode === undefined || process.exitCode === 0) console.log(archive);
    else console.error('native archive retained; operational completion failed; verify artifact and backend state separately');
  }
}
