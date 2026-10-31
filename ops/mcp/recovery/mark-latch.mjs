#!/usr/bin/env node
import { closeSync, constants, fsyncSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, options, privateDir, required } from './common.mjs';
import { stopCurrentMcp, systemctlBinary } from './systemd.mjs';
import { acquireRecoveryLock, releaseRecoveryLock } from './lock.mjs';

process.umask(0o077);
let lock;
try {
  const args = options(process.argv.slice(2), ['--fixture-latch', '--fixture-systemctl', '--fixture-lock-dir',
    '--installation-id', '--current-release-sha', '--paired']);
  const fixture = args['--fixture-latch'] !== undefined;
  if (fixture && process.env.MCP_RECOVERY_FIXTURE !== '1') fail('fixture mode unavailable');
  if (!fixture && args['--fixture-lock-dir']) fail('fixture lock is test-only');
  if (!fixture && process.getuid() !== 0) fail('live latch mark requires root');
  lock = acquireRecoveryLock(fixture ? required(args['--fixture-lock-dir']) : '/run/habit-system-mcp-recovery');
  const installationId = required(args['--installation-id']);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installationId)) fail('invalid installation id');
  const path = fixture ? args['--fixture-latch'] : '/etc/habit-system-mcp/restore-latch';
  privateDir(dirname(path), fixture ? false : true);
  if (args['--paired'] && args['--paired'] !== 'yes') fail('invalid paired setting');
  const systemctl = systemctlBinary(fixture, args['--fixture-systemctl']);
  if (systemctl) stopCurrentMcp(systemctl, required(args['--current-release-sha']), args['--paired'] === 'yes');
  else if (args['--current-release-sha']) fail('current release requires systemd inventory');
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 4096) fail('unsafe restore latch');
    const expected = JSON.stringify({ installationId, version: 1 }) + '\n';
    if (readFileSync(fd, 'utf8') !== expected) fail('restore latch is missing or already marked');
    writeFileSync(fd, 'restored\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  console.log('restore latch durably marked; writes remain fenced');
} catch (error) {
  console.error(`restore latch refused: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  try { releaseRecoveryLock(lock); }
  catch { console.error('recovery lock release needs operator attention'); process.exitCode = 1; }
}
