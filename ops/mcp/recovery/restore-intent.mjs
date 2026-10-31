#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendDurable, fail, hash, options, outside, privateDir, privateFile, required, run } from './common.mjs';

process.umask(0o077);
try {
  const args = options(process.argv.slice(2), ['--fixture-root', '--fixture-systemctl', '--fixture-lock-dir',
    '--controller-dir', '--bundle', '--installation-id', '--latch', '--current-release-sha']);
  const fixture = args['--fixture-root'] !== undefined;
  if (fixture && process.env.MCP_RECOVERY_FIXTURE !== '1') fail('fixture mode unavailable');
  if (!fixture && args['--fixture-lock-dir']) fail('fixture lock is test-only');
  const controller = privateDir(required(args['--controller-dir']));
  if (!outside(process.cwd(), controller)) fail('controller must be outside checkout');
  if (fixture && !outside(privateDir(args['--fixture-root']), controller)) fail('controller must be outside restored state');
  const bundlePath = privateFile(required(args['--bundle']));
  if (statSync(bundlePath).size > 16_384) fail('bundle exceeds bound');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  if (bundle.version !== 1 || !/^[0-9a-f]{40}$/.test(bundle.releaseSha) ||
    !/^[0-9a-f-]{36}$/.test(bundle.snapshotId) || typeof bundle.paired !== 'boolean') fail('invalid bundle');
  for (const kind of ['data', 'keys']) {
    const name = bundle[kind], digest = bundle[`${kind}Sha256`];
    if (name !== `${bundle.snapshotId}-${kind}.age` || !/^[0-9a-f]{64}$/.test(digest) ||
      hash(privateFile(join(dirname(bundlePath), name))) !== digest) fail('archive digest mismatch');
  }
  const installationId = required(args['--installation-id']);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installationId)) fail('invalid installation id');
  const currentReleaseSha = args['--current-release-sha'];
  if (!fixture || args['--fixture-systemctl']) {
    if (!/^[0-9a-f]{40}$/.test(required(currentReleaseSha))) fail('invalid current release sha');
  } else if (currentReleaseSha) fail('current release requires systemd inventory');
  const intentId = randomUUID(), log = join(controller, 'restore-intents.jsonl');
  appendDurable(log, JSON.stringify({ version: 1, type: 'restore_intent', intentId,
    installationId, snapshotId: bundle.snapshotId, releaseSha: bundle.releaseSha, currentReleaseSha,
    recordedAt: new Date().toISOString() }) + '\n');
  if (fixture) {
    run(process.execPath, [fileURLToPath(new URL('./mark-latch.mjs', import.meta.url)),
      '--fixture-latch', required(args['--latch']), '--installation-id', installationId,
      '--fixture-lock-dir', required(args['--fixture-lock-dir']),
      ...(args['--fixture-systemctl'] ? ['--fixture-systemctl', args['--fixture-systemctl'],
        '--current-release-sha', currentReleaseSha, ...(bundle.paired ? ['--paired', 'yes'] : [])] : [])]);
  } else {
    const node = `/opt/habit-system-mcp/releases/${currentReleaseSha}/node/bin/node`;
    const command = `/opt/habit-system-mcp/recovery/mark-latch.mjs`;
    run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'oracle',
      'sudo', '-n', node, command, '--installation-id', installationId,
      '--current-release-sha', currentReleaseSha, ...(bundle.paired ? ['--paired', 'yes'] : [])], 90_000);
  }
  appendDurable(log, JSON.stringify({ version: 1, type: 'latch_marked', intentId,
    installationId, snapshotId: bundle.snapshotId, releaseSha: bundle.releaseSha, currentReleaseSha,
    recordedAt: new Date().toISOString() }) + '\n');
  console.log('restore intent retained off host and latch marked; no state replaced');
} catch (error) {
  console.error(`restore intent refused: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
