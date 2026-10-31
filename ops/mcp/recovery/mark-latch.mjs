#!/usr/bin/env node
import { closeSync, constants, fsyncSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, options, parseRestoreLatch, privateDir, required, validRestoreIntentId } from './common.mjs';
import { activeMcpUnits, requireStoppedMcp, stopCurrentMcp, systemctlBinary } from './systemd.mjs';
import { acquireRecoveryLock, releaseRecoveryLock } from './lock.mjs';

process.umask(0o077);
let lock;
try {
  const args = options(process.argv.slice(2), ['--fixture-latch', '--fixture-systemctl', '--fixture-lock-dir',
    '--installation-id', '--current-release-sha', '--paired', '--restore-intent-id']);
  const fixture = args['--fixture-latch'] !== undefined;
  if (fixture && process.env.MCP_RECOVERY_FIXTURE !== '1') fail('fixture mode unavailable');
  if (!fixture && args['--fixture-lock-dir']) fail('fixture lock is test-only');
  if (!fixture && process.getuid() !== 0) fail('live latch mark requires root');
  lock = acquireRecoveryLock(fixture ? required(args['--fixture-lock-dir']) : '/run/habit-system-mcp-recovery');
  const installationId = required(args['--installation-id']);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installationId)) fail('invalid installation id');
  const intentId = validRestoreIntentId(required(args['--restore-intent-id']));
  const path = fixture ? args['--fixture-latch'] : '/etc/habit-system-mcp/restore-latch';
  privateDir(dirname(path), fixture ? false : true);
  if (args['--paired'] && args['--paired'] !== 'yes') fail('invalid paired setting');
  const systemctl = systemctlBinary(fixture, args['--fixture-systemctl']);
  const currentSha = args['--current-release-sha'];
  if (systemctl && !/^[0-9a-f]{40}$/.test(required(currentSha))) fail('invalid current release sha');
  if (!systemctl && currentSha) fail('current release requires systemd inventory');
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const readLatch = () => {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
        before.size < 1 || before.size > 4096) fail('unsafe restore latch');
      const buffer = Buffer.alloc(4097), length = readSync(fd, buffer, 0, buffer.length, 0);
      const after = fstatSync(fd);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) fail('restore latch changed during check');
      const content = buffer.subarray(0, length).toString('utf8');
      if (!Buffer.from(content).equals(buffer.subarray(0, length))) fail('invalid restore latch encoding');
      return content;
    };
    const before = readLatch(), parsed = parseRestoreLatch(before, installationId);
    if (parsed.ids.includes(intentId) && parsed.lastId !== intentId) fail('restore intent epoch already superseded');
    if (parsed.lastId === intentId) {
      if (!systemctl) fail('retry requires stopped unit inventory');
      requireStoppedMcp(systemctl, args['--paired'] === 'yes');
    } else {
      if (systemctl) {
        if (parsed.ids.length > 0 && activeMcpUnits(systemctl).length === 0) {
          requireStoppedMcp(systemctl, args['--paired'] === 'yes');
        } else stopCurrentMcp(systemctl, currentSha, args['--paired'] === 'yes');
      } else if (parsed.ids.length > 0) fail('later restore requires stopped unit inventory');
      if (readLatch() !== before) fail('restore latch changed during quiescence');
      const record = `restored ${intentId}\n`;
      if (Buffer.byteLength(before + record) > 4096) fail('restore latch record bound exceeded');
      writeFileSync(fd, record); fsyncSync(fd);
    }
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
