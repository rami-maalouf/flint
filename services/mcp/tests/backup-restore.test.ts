import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileRestoreLatch } from '../src/operations/recovery-head';

const scripts = fileURLToPath(new URL('../../../ops/mcp/recovery/', import.meta.url));
const age = process.env.MCP_AGE_BIN ?? '/tmp/habit-mcp-age-1.3.2/darwin/age/age';
const keygen = process.env.MCP_AGE_KEYGEN_BIN ?? '/tmp/habit-mcp-age-1.3.2/darwin/age/age-keygen';
function run(bin: string, args: string[], expected = 0, env: Record<string, string> = {}): string {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MCP_RECOVERY_FIXTURE: '1', ...env } });
  assert.equal(result.status, expected, result.stderr);
  return result.stdout.trim();
}

test('archive a provenance stops current b and refuses ambiguous active mcp units', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-systemd-fake-'));
  try {
    const source = join(root, 'source'), state = join(root, 'external-state'), backend = join(root, 'external-backend');
    const keys = join(source, 'keys'), output = join(root, 'output'), controller = join(root, 'controller');
    const lockDir = join(root, 'lock');
    for (const path of [source, state, backend, keys, output, controller, lockDir]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(keys, 'config.json'), '{"version":2}', { mode: 0o600 });
    writeFileSync(join(keys, 'keys.json'), '{"synthetic":"key"}', { mode: 0o600 });
    const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
    const unit = (sha: string) => `habit-system-mcp@${sha}.service`;
    const active = join(root, 'active'), backendState = join(root, 'backend-state'), calls = join(root, 'systemctl-calls');
    const fake = join(root, 'systemctl');
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> "$MCP_FAKE_SYSTEMCTL_CALLS"
case "$1" in
  list-units) cat "$MCP_FAKE_SYSTEMCTL_ACTIVE" ;;
  is-active) printf '%s\\n' active ;;
  stop) if [ "$2" = habit-system-fullstack.service ]; then printf '%s\\n' inactive > "$MCP_FAKE_BACKEND_STATE";
        elif [ "$2" = "$MCP_FAKE_CURRENT_UNIT" ]; then : > "$MCP_FAKE_SYSTEMCTL_ACTIVE"; fi
        if [ "\${MCP_FAKE_STOP_FAIL_AFTER:-}" = "$2" ]; then exit 9; fi ;;
  start) if [ "$2" = habit-system-fullstack.service ]; then
           if [ "\${MCP_FAKE_START_MODE:-}" = backend-inactive ]; then printf '%s\\n' inactive > "$MCP_FAKE_BACKEND_STATE";
           else printf '%s\\n' active > "$MCP_FAKE_BACKEND_STATE"; fi
         elif [ "\${MCP_FAKE_START_MODE:-}" = inactive ]; then : > "$MCP_FAKE_SYSTEMCTL_ACTIVE";
         elif [ "\${MCP_FAKE_START_MODE:-}" = wrong ]; then
           printf '%s loaded active running synthetic\\n' "$MCP_FAKE_WRONG_UNIT" > "$MCP_FAKE_SYSTEMCTL_ACTIVE";
         elif [ "\${MCP_FAKE_START_MODE:-}" = extra ]; then
           printf '%s loaded active running synthetic\\n%s loaded active running synthetic\\n' "$2" "$MCP_FAKE_WRONG_UNIT" > "$MCP_FAKE_SYSTEMCTL_ACTIVE";
         else printf '%s loaded active running synthetic\\n' "$2" > "$MCP_FAKE_SYSTEMCTL_ACTIVE"; fi ;;
  show) cat "$MCP_FAKE_BACKEND_STATE" ;;
esac
`, { mode: 0o700 });
    chmodSync(fake, 0o700);
    const environment = { MCP_FAKE_SYSTEMCTL_ACTIVE: active, MCP_FAKE_BACKEND_STATE: backendState,
      MCP_FAKE_SYSTEMCTL_CALLS: calls, MCP_FAKE_WRONG_UNIT: unit(b),
      MCP_FAKE_CURRENT_UNIT: unit(a) };
    writeFileSync(active, `${unit(a)} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(calls, '');
    const identity = join(controller, 'identity.txt');
    run(keygen, ['-o', identity]);
    const recipient = run(keygen, ['-y', identity]);
    const nested = join(backend, 'inside'); mkdirSync(nested, { mode: 0o700 });
    const nestedState = join(state, 'inside'); mkdirSync(nestedState, { mode: 0o700 });
    for (const unsafe of [nested, nestedState]) run(process.execPath, [join(scripts, 'backup.mjs'),
      '--fixture-root', source, '--fixture-state-root', state, '--fixture-backend-root', backend,
      '--fixture-lock-dir', lockDir,
      '--fixture-systemctl', fake, '--output-dir', unsafe, '--recipient', recipient,
      '--age-bin', age, '--release-sha', a], 1, environment);
    assert.equal(readFileSync(calls, 'utf8'), '');
    const ready = run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-state-root', state, '--fixture-backend-root', backend, '--fixture-lock-dir', lockDir,
      '--fixture-systemctl', fake, '--output-dir', output, '--recipient', recipient,
      '--age-bin', age, '--release-sha', a], 0, environment);
    assert.match(ready, /snapshot .* ready/);
    assert.match(readFileSync(calls, 'utf8'), new RegExp(`stop ${unit(a)}`));
    const bundle = join(output, 'bundle.json');
    const latch = join(controller, 'restore-latch'), installationId = 'synthetic-deployment';
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    writeFileSync(active, `${unit(b)} loaded active running synthetic\n`);
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir,
      '--controller-dir', controller, '--bundle', bundle,
      '--installation-id', installationId, '--current-release-sha', b, '--latch', latch], 0,
    { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.match(readFileSync(calls, 'utf8'), new RegExp(`stop ${unit(b)}`));
    assert.match(readFileSync(calls, 'utf8'), /stop habit-system-fullstack\.service/);
    assert.equal(readFileSync(active, 'utf8'), '');
    assert.equal(readFileSync(backendState, 'utf8'), 'inactive\n');
    const events = readFileSync(join(controller, 'restore-intents.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { releaseSha: string; currentReleaseSha: string });
    assert.equal(events.length, 2);
    assert.equal(events[0].releaseSha, a);
    assert.equal(events[0].currentReleaseSha, b);
    const retryController = join(root, 'retry-controller'); mkdirSync(retryController, { mode: 0o700 });
    const retryLatch = join(retryController, 'restore-latch'), retryId = 'retry-installation';
    const retainedIntent = randomUUID();
    FileRestoreLatch.provisionFresh({ path: retryLatch, installationId: retryId,
      restoredDirectories: [state, backend] });
    writeFileSync(join(retryController, 'restore-intents.jsonl'), JSON.stringify({ version: 1,
      type: 'restore_intent', intentId: retainedIntent, installationId: retryId,
      snapshotId: JSON.parse(readFileSync(bundle, 'utf8')).snapshotId, releaseSha: a,
      currentReleaseSha: b, paired: true }) + '\n', { mode: 0o600 });
    writeFileSync(active, `${unit(b)} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir, '--controller-dir', retryController,
      '--bundle', bundle, '--installation-id', retryId, '--current-release-sha', b,
      '--latch', retryLatch], 1, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.equal(readFileSync(active, 'utf8'), `${unit(b)} loaded active running synthetic\n`);
    run(process.execPath, [join(scripts, 'mark-latch.mjs'), '--fixture-latch', retryLatch,
      '--fixture-lock-dir', lockDir, '--fixture-systemctl', fake, '--installation-id', retryId,
      '--current-release-sha', b, '--paired', 'yes', '--restore-intent-id', retainedIntent], 0,
    { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    const markerBeforeRetry = readFileSync(retryLatch, 'utf8');
    const retryArgs = [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir, '--controller-dir', retryController,
      '--bundle', bundle, '--installation-id', retryId, '--current-release-sha', b,
      '--latch', retryLatch, '--retry-intent-id', retainedIntent];
    run(process.execPath, retryArgs, 0, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.equal(readFileSync(retryLatch, 'utf8'), markerBeforeRetry);
    assert.equal(readFileSync(join(retryController, 'restore-intents.jsonl'), 'utf8').trim().split('\n').length, 2);
    run(process.execPath, retryArgs, 1, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
    const restored = join(root, 'restored-a');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', restored,
      '--latch', latch, '--installation-id', installationId,
      '--intent-log', join(controller, 'restore-intents.jsonl')]);
    assert.equal(existsSync(join(restored, 'state')), true);
    assert.equal(existsSync(join(restored, 'backend')), true);
    run(process.execPath, [join(scripts, 'mark-latch.mjs'), '--fixture-latch', latch,
      '--fixture-lock-dir', lockDir, '--fixture-systemctl', fake, '--installation-id', installationId,
      '--current-release-sha', b, '--paired', 'yes', '--restore-intent-id', randomUUID()], 0,
    { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    const staleEpoch = join(root, 'stale-epoch');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', staleEpoch,
      '--latch', latch, '--installation-id', installationId,
      '--intent-log', join(controller, 'restore-intents.jsonl')], 1);
    assert.equal(existsSync(staleEpoch), false);
    const secondController = join(root, 'ambiguous-controller'); mkdirSync(secondController, { mode: 0o700 });
    const secondLatch = join(secondController, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: secondLatch, installationId: 'ambiguous-installation',
      restoredDirectories: [state, backend] });
    writeFileSync(active, `${unit(b)} loaded active running synthetic\n${unit(c)} loaded active running synthetic\n`);
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir,
      '--controller-dir', secondController, '--bundle', bundle,
      '--installation-id', 'ambiguous-installation', '--current-release-sha', b,
      '--latch', secondLatch], 1, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /stop /);
    new FileRestoreLatch({ path: secondLatch, installationId: 'ambiguous-installation',
      restoredDirectories: [state, backend] }).assertReady();
    const staleController = join(root, 'stale-controller'); mkdirSync(staleController, { mode: 0o700 });
    const staleLatch = join(staleController, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: staleLatch, installationId: 'stale-installation',
      restoredDirectories: [state, backend] });
    writeFileSync(active, `${unit(b)} loaded active running synthetic\n`);
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir,
      '--controller-dir', staleController, '--bundle', bundle,
      '--installation-id', 'stale-installation', '--current-release-sha', a,
      '--latch', staleLatch], 1, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(b) });
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /stop /);
    new FileRestoreLatch({ path: staleLatch, installationId: 'stale-installation',
      restoredDirectories: [state, backend] }).assertReady();
    const stickyController = join(root, 'sticky-controller'); mkdirSync(stickyController, { mode: 0o700 });
    const stickyLatch = join(stickyController, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: stickyLatch, installationId: 'sticky-installation',
      restoredDirectories: [state, backend] });
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir,
      '--controller-dir', stickyController, '--bundle', bundle,
      '--installation-id', 'sticky-installation', '--current-release-sha', b,
      '--latch', stickyLatch], 1, { ...environment, MCP_FAKE_CURRENT_UNIT: unit(c) });
    assert.match(readFileSync(calls, 'utf8'), new RegExp(`stop ${unit(b)}`));
    new FileRestoreLatch({ path: stickyLatch, installationId: 'sticky-installation',
      restoredDirectories: [state, backend] }).assertReady();
    const stillActiveOutput = join(root, 'still-active-output'); mkdirSync(stillActiveOutput, { mode: 0o700 });
    writeFileSync(active, `${unit(a)} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-state-root', state, '--fixture-backend-root', backend, '--fixture-lock-dir', lockDir,
      '--fixture-systemctl', fake, '--output-dir', stillActiveOutput, '--recipient', recipient,
      '--age-bin', age, '--release-sha', a], 1,
    { ...environment, MCP_FAKE_CURRENT_UNIT: unit(c) });
    assert.equal(existsSync(join(stillActiveOutput, 'bundle.json')), false);
    assert.match(readFileSync(calls, 'utf8'), new RegExp(`start ${unit(a)}`));
    const ambiguousOutput = join(root, 'ambiguous-output'); mkdirSync(ambiguousOutput, { mode: 0o700 });
    writeFileSync(active, `${unit(a)} loaded active running synthetic\n${unit(b)} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-state-root', state, '--fixture-backend-root', backend, '--fixture-lock-dir', lockDir,
      '--fixture-systemctl', fake, '--output-dir', ambiguousOutput, '--recipient', recipient,
      '--age-bin', age, '--release-sha', a], 1, environment);
    assert.equal(existsSync(join(ambiguousOutput, 'bundle.json')), false);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /stop /);
    const failedOutput = join(root, 'failed-output'); mkdirSync(failedOutput, { mode: 0o700 });
    writeFileSync(active, `${unit(a)} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(calls, '');
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-state-root', state, '--fixture-backend-root', backend, '--fixture-lock-dir', lockDir,
      '--fixture-systemctl', fake, '--output-dir', failedOutput, '--recipient', recipient,
      '--age-bin', age, '--release-sha', a], 1,
    { ...environment, MCP_FAKE_STOP_FAIL_AFTER: unit(a) });
    const failureCalls = readFileSync(calls, 'utf8');
    assert.match(failureCalls, new RegExp(`stop ${unit(a)}`));
    assert.match(failureCalls, new RegExp(`start ${unit(a)}`));
    assert.match(failureCalls, /start habit-system-fullstack\.service/);
    assert.equal(existsSync(join(failedOutput, 'bundle.json')), false);
    for (const mode of ['inactive', 'wrong', 'extra', 'backend-inactive']) {
      const retainedOutput = join(root, `retained-${mode}`); mkdirSync(retainedOutput, { mode: 0o700 });
      writeFileSync(active, `${unit(a)} loaded active running synthetic\n`);
      writeFileSync(backendState, 'active\n');
      const result = spawnSync(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
        '--fixture-state-root', state, '--fixture-backend-root', backend, '--fixture-lock-dir', lockDir,
        '--fixture-systemctl', fake, '--output-dir', retainedOutput, '--recipient', recipient,
        '--age-bin', age, '--release-sha', a], { encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, MCP_RECOVERY_FIXTURE: '1', ...environment, MCP_FAKE_START_MODE: mode } });
      assert.equal(existsSync(join(retainedOutput, 'bundle.json')), true, mode);
      assert.equal(result.status, 1, mode);
      assert.doesNotMatch(result.stdout, /snapshot .* ready/, mode);
      assert.match(result.stderr, /restart verification failed/, mode);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exclusive recovery lock excludes a second backup and restore marker until restart', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-recovery-lock-'));
  let child: ReturnType<typeof spawn> | undefined;
  let childDone: Promise<number | null> | undefined;
  const release = join(root, 'release'), releaseRestart = join(root, 'release-restart');
  try {
    const source = join(root, 'source'), state = join(source, 'state'), backend = join(source, 'backend');
    const keys = join(source, 'keys'), outputA = join(root, 'output-a'), outputB = join(root, 'output-b');
    const lockDir = join(root, 'lock'), controller = join(root, 'controller');
    for (const path of [source, state, backend, keys, outputA, outputB, lockDir, controller]) {
      mkdirSync(path, { mode: 0o700 });
    }
    writeFileSync(join(keys, 'config.json'), '{"version":2}', { mode: 0o600 });
    writeFileSync(join(keys, 'keys.json'), '{"synthetic":"key"}', { mode: 0o600 });
    const sha = 'a'.repeat(40), unit = `habit-system-mcp@${sha}.service`;
    const active = join(root, 'active'), backendState = join(root, 'backend-state'), marker = join(root, 'paused');
    const restartMarker = join(root, 'restart-paused'), calls = join(root, 'calls');
    writeFileSync(active, `${unit} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(calls, '');
    const fake = join(root, 'systemctl');
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> "$MCP_FAKE_CALLS"
case "$1" in
  list-units) cat "$MCP_FAKE_ACTIVE" ;;
  is-active) printf '%s\\n' active ;;
  stop) if [ "\${MCP_FAKE_PAUSE:-}" = 1 ]; then : > "$MCP_FAKE_MARKER";
          while [ ! -e "$MCP_FAKE_RELEASE" ]; do sleep 0.02; done; fi
        if [ "$2" = "$MCP_FAKE_UNIT" ]; then : > "$MCP_FAKE_ACTIVE";
        elif [ "$2" = habit-system-fullstack.service ]; then printf '%s\\n' inactive > "$MCP_FAKE_BACKEND_STATE"; fi ;;
  start) if [ "\${MCP_FAKE_PAUSE_RESTART:-}" = 1 ]; then : > "$MCP_FAKE_RESTART_MARKER";
           while [ ! -e "$MCP_FAKE_RESTART_RELEASE" ]; do sleep 0.02; done; fi
         if [ "$2" = "$MCP_FAKE_UNIT" ]; then printf '%s loaded active running synthetic\\n' "$2" > "$MCP_FAKE_ACTIVE";
         elif [ "$2" = habit-system-fullstack.service ]; then printf '%s\\n' active > "$MCP_FAKE_BACKEND_STATE"; fi ;;
  show) cat "$MCP_FAKE_BACKEND_STATE" ;;
esac
`, { mode: 0o700 });
    const identity = join(controller, 'identity.txt');
    run(keygen, ['-o', identity]);
    const recipient = run(keygen, ['-y', identity]);
    const env = { ...process.env, MCP_RECOVERY_FIXTURE: '1', MCP_FAKE_CALLS: calls,
      MCP_FAKE_ACTIVE: active, MCP_FAKE_BACKEND_STATE: backendState,
      MCP_FAKE_MARKER: marker, MCP_FAKE_RELEASE: release,
      MCP_FAKE_RESTART_MARKER: restartMarker, MCP_FAKE_RESTART_RELEASE: releaseRestart,
      MCP_FAKE_UNIT: unit };
    const backup = (output: string) => [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir, '--output-dir', output,
      '--recipient', recipient, '--age-bin', age, '--release-sha', sha];
    child = spawn(process.execPath, backup(outputA), { env: { ...env, MCP_FAKE_PAUSE: '1',
      MCP_FAKE_PAUSE_RESTART: '1' }, stdio: 'ignore' });
    childDone = new Promise(resolve => child!.once('close', resolve));
    for (let i = 0; i < 250 && !existsSync(marker); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(marker), true, 'first backup must hold the lock during stop');
    const second = spawnSync(process.execPath, backup(outputB), { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /recovery lock unavailable/);
    const latch = join(controller, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: latch, installationId: 'locked-installation',
      restoredDirectories: [state, backend] });
    const markArgs = [join(scripts, 'mark-latch.mjs'), '--fixture-latch', latch,
      '--fixture-systemctl', fake, '--fixture-lock-dir', lockDir, '--installation-id', 'locked-installation',
      '--current-release-sha', sha];
    const mark = spawnSync(process.execPath, markArgs, { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(mark.status, 1);
    assert.match(mark.stderr, /recovery lock unavailable/);
    new FileRestoreLatch({ path: latch, installationId: 'locked-installation',
      restoredDirectories: [state, backend] }).assertReady();
    writeFileSync(release, '');
    for (let i = 0; i < 250 && !existsSync(restartMarker); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(restartMarker), true, 'lock must remain held through restart attempts');
    const duringRestart = spawnSync(process.execPath, backup(outputB), { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(duringRestart.status, 1);
    assert.match(duringRestart.stderr, /recovery lock unavailable/);
    const markDuringRestart = spawnSync(process.execPath, markArgs, { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(markDuringRestart.status, 1);
    assert.match(markDuringRestart.stderr, /recovery lock unavailable/);
    writeFileSync(releaseRestart, '');
    const exit = await childDone;
    child = undefined;
    assert.equal(exit, 0);
    assert.equal(existsSync(join(outputA, 'bundle.json')), true);
    assert.equal(existsSync(join(outputB, 'bundle.json')), false);
  } finally {
    writeFileSync(release, '');
    writeFileSync(releaseRestart, '');
    if (child) await childDone;
    rmSync(root, { recursive: true, force: true });
  }
});

test('sigkill releases the os recovery lock without clearing a latch', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-killed-lock-'));
  let child: ReturnType<typeof spawn> | undefined;
  let childDone: Promise<number | null> | undefined;
  try {
    const lockDir = join(root, 'lock'), controller = join(root, 'controller');
    const state = join(root, 'state'), backend = join(root, 'backend');
    for (const path of [lockDir, controller, state, backend]) mkdirSync(path, { mode: 0o700 });
    const marker = join(root, 'held'), holder = join(root, 'holder.mjs');
    const importUrl = pathToFileURL(join(scripts, 'lock.mjs')).href;
    writeFileSync(holder, `import { writeFileSync } from 'node:fs';
import { acquireRecoveryLock } from ${JSON.stringify(importUrl)};
acquireRecoveryLock(process.argv[2]);
writeFileSync(process.argv[3], 'held');
setInterval(() => {}, 1000);
`, { mode: 0o600 });
    child = spawn(process.execPath, [holder, lockDir, marker], { stdio: 'ignore' });
    childDone = new Promise(resolve => child!.once('close', resolve));
    for (let i = 0; i < 250 && !existsSync(marker); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(marker), true);
    const latch = join(controller, 'restore-latch'), installationId = 'killed-lock-installation';
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    const markArgs = [join(scripts, 'mark-latch.mjs'), '--fixture-latch', latch,
      '--fixture-lock-dir', lockDir, '--installation-id', installationId,
      '--restore-intent-id', randomUUID()];
    const blocked = spawnSync(process.execPath, markArgs, { encoding: 'utf8', timeout: 3000,
      env: { ...process.env, MCP_RECOVERY_FIXTURE: '1' } });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /recovery lock unavailable/);
    child.kill('SIGKILL');
    await childDone;
    child = undefined;
    run(process.execPath, markArgs);
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
  } finally {
    if (child) { child.kill('SIGKILL'); await childDone; }
    rmSync(root, { recursive: true, force: true });
  }
});
function db(path: string, table: string, value: string): void {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE ${table}(value TEXT);`);
  sqlite.prepare(`INSERT INTO ${table}(value) VALUES (?)`).run(value);
  sqlite.close();
}
function openWal(path: string, table: string, value: string): DatabaseSync {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE ${table}(value TEXT);`);
  sqlite.prepare(`INSERT INTO ${table}(value) VALUES (?)`).run(value);
  return sqlite;
}

test('encrypted paired snapshot preserves pending queue and fences even matching old heads', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-backup-'));
  try {
    const source = join(root, 'source'), state = join(source, 'state'), backend = join(source, 'backend');
    const keys = join(source, 'keys'), offhost = join(root, 'offhost'), controller = join(root, 'controller');
    for (const path of [source, state, backend, keys, offhost, controller]) mkdirSync(path, { mode: 0o700 });
    const accounts = join(state, 'accounts'); mkdirSync(accounts, { mode: 0o700 });
    const account = join(accounts, 'synthetic-account'); mkdirSync(account, { mode: 0o700 });
    const stores = [
      [join(state, 'provider.sqlite'), 'grants', 'old-grant'],
      [join(state, 'vault.sqlite'), 'credentials', 'encrypted-synthetic-token'],
      [join(state, 'quotes.sqlite'), 'quotes', 'old-quote'],
      [join(account, 'replica.sqlite'), 'binding', 'old-replica'],
      [join(account, 'product.sqlite'), 'habits', 'old-product'],
      [join(account, 'delivery.sqlite'), 'delivery', 'old-delivery'],
      [join(account, 'operations.sqlite'), 'pending_queue', 'operation-1'],
      [join(account, 'journal.sqlite'), 'chain', 'old-chain'],
      [join(backend, 'deployment.sqlite'), 'head', 'old-matching-head'],
    ] as const;
    const opened = stores.map(([path, table, value]) => openWal(path, table, value));
    writeFileSync(join(keys, 'config.json'), '{"version":2}', { mode: 0o600 });
    writeFileSync(join(keys, 'keys.json'), '{"synthetic":"key"}', { mode: 0o600 });
    const identity = join(controller, 'identity.txt');
    run(keygen, ['-o', identity]);
    const recipient = run(keygen, ['-y', identity]);
    const latch = join(controller, 'restore-latch');
    const installationId = 'synthetic-installation';
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller, '--output-dir', offhost,
      '--recipient', recipient, '--age-bin', age, '--release-sha', 'a'.repeat(40)]);
    for (const connection of opened) connection.close();
    const bundle = join(offhost, 'bundle.json');
    assert.equal(readdirSync(offhost).filter(name => name.endsWith('.age')).length, 2);
    const manifest = JSON.parse(readFileSync(bundle, 'utf8')) as { data: string; keys: string };
    assert.equal(readFileSync(join(offhost, manifest.data), 'utf8').startsWith('age-encryption.org/v1'), true);
    db(join(account, 'operations.sqlite'), 'advanced', 'acknowledged-after-backup');
    db(join(backend, 'deployment.sqlite'), 'advanced', 'acknowledged-after-backup');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller,
      '--controller-dir', controller, '--bundle', bundle, '--installation-id', installationId, '--latch', latch]);
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
    const restored = join(root, 'restored');
    const intentLog = join(controller, 'restore-intents.jsonl');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', restored, '--latch', latch,
      '--installation-id', installationId, '--intent-log', intentLog]);
    for (const [path, table, value] of stores) {
      const target = join(restored, path.slice(source.length + 1));
      assert.equal(existsSync(`${target}-wal`), true, `${target} must retain its wal`);
      const connection = new DatabaseSync(target);
      assert.equal(connection.prepare(`SELECT value FROM ${table}`).get()?.value, value, target);
      connection.close();
    }
    assert.deepEqual(JSON.parse(readFileSync(join(restored, 'keys/config.json'), 'utf8')), { version: 2 });
    assert.deepEqual(JSON.parse(readFileSync(join(restored, 'keys/keys.json'), 'utf8')), { synthetic: 'key' });
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
    const missing = join(root, 'missing-key'); writeFileSync(missing, 'AGE-SECRET-KEY-INVALID\n');
    const refused = join(root, 'refused');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', missing, '--age-bin', age, '--target', refused, '--latch', latch,
      '--installation-id', installationId, '--intent-log', intentLog], 1);
    assert.equal(existsSync(refused), false);
    appendFileSync(join(offhost, manifest.data), 'damaged');
    const damaged = join(root, 'damaged');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', damaged, '--latch', latch,
      '--installation-id', installationId, '--intent-log', intentLog], 1);
    assert.equal(existsSync(damaged), false);
    rmSync(join(account, 'journal.sqlite'));
    const incompleteOffhost = join(root, 'incomplete-offhost'), secondController = join(root, 'second-controller');
    mkdirSync(incompleteOffhost, { mode: 0o700 }); mkdirSync(secondController, { mode: 0o700 });
    const secondLatch = join(secondController, 'restore-latch'), secondId = 'second-installation';
    FileRestoreLatch.provisionFresh({ path: secondLatch, installationId: secondId,
      restoredDirectories: [state, backend] });
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', secondController, '--output-dir', incompleteOffhost,
      '--recipient', recipient, '--age-bin', age, '--release-sha', 'a'.repeat(40)]);
    const incompleteBundle = join(incompleteOffhost, 'bundle.json');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', secondController,
      '--controller-dir', secondController, '--bundle', incompleteBundle,
      '--installation-id', secondId, '--latch', secondLatch]);
    const incompleteTarget = join(root, 'incomplete-target');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', incompleteBundle, '--identity', identity, '--age-bin', age,
      '--target', incompleteTarget, '--latch', secondLatch, '--installation-id', secondId,
      '--intent-log', join(secondController, 'restore-intents.jsonl')], 1);
    assert.equal(existsSync(incompleteTarget), false);
    assert.throws(() => new FileRestoreLatch({ path: secondLatch, installationId: secondId,
      restoredDirectories: [state, backend] }).assertReady());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native snapback release store link and group writable descendants survive a fenced paired restore', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-native-layout-'));
  try {
    const source = join(root, 'source'), state = join(source, 'state'), backend = join(source, 'backend');
    const keys = join(source, 'keys'), offhost = join(root, 'offhost'), controller = join(root, 'controller');
    for (const path of [source, state, backend, keys, offhost, controller]) mkdirSync(path, { mode: 0o700 });
    const releases = join(backend, 'releases'), release = join(releases, '1'), internal = join(release, '.snapback4');
    const snapback = join(release, 'snapback');
    for (const path of [releases, release, snapback]) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o775); }
    writeFileSync(join(snapback, 'provenance.json'), '{"synthetic":true}\n');
    mkdirSync(internal, { mode: 0o700 });
    const store = join(backend, 'store.sqlite');
    const connection = new DatabaseSync(store);
    connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT);');
    connection.prepare('INSERT INTO records VALUES (?, ?)').run('record-1', 'pending-effect');
    writeFileSync(join(backend, 'releases.jsonl'), '{"version":1}\n');
    symlinkSync('../../../store.sqlite', join(internal, 'store.sqlite'));
    writeFileSync(join(keys, 'config.json'), '{"version":2}', { mode: 0o600 });
    writeFileSync(join(keys, 'keys.json'), '{"synthetic":"key"}', { mode: 0o600 });
    const identity = join(controller, 'identity.txt');
    run(keygen, ['-o', identity]);
    const recipient = run(keygen, ['-y', identity]);
    const sha = 'b'.repeat(40), installationId = 'snapback-native-layout';
    const latch = join(controller, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller, '--output-dir', offhost, '--recipient', recipient,
      '--age-bin', age, '--release-sha', sha]);
    connection.close();
    const bundle = join(offhost, 'bundle.json');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller, '--controller-dir', controller, '--bundle', bundle,
      '--installation-id', installationId, '--latch', latch]);
    const restored = join(root, 'restored');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', restored,
      '--latch', latch, '--installation-id', installationId,
      '--intent-log', join(controller, 'restore-intents.jsonl')]);
    const link = join(restored, 'backend/releases/1/.snapback4/store.sqlite');
    assert.equal(readlinkSync(link), '../../../store.sqlite');
    assert.equal(realpathSync(link), join(restored, 'backend/store.sqlite'));
    assert.equal(lstatSync(join(restored, 'backend/releases/1')).mode & 0o777, 0o700);
    assert.equal(existsSync(join(restored, 'backend/store.sqlite-wal')), true);
    const restoredDb = new DatabaseSync(link);
    assert.equal(restoredDb.prepare('SELECT value FROM records WHERE id = ?').get('record-1')?.value, 'pending-effect');
    restoredDb.close();
    assert.equal(readFileSync(join(restored, 'backend/releases.jsonl'), 'utf8'), '{"version":1}\n');
    assert.equal(readFileSync(join(restored, 'backend/releases/1/snapback/provenance.json'), 'utf8'), '{"synthetic":true}\n');
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restore marker binds each durable intent to a distinct issuing epoch', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-intent-epoch-'));
  try {
    const state = join(root, 'state'), backend = join(root, 'backend'), controller = join(root, 'controller');
    for (const path of [state, backend, controller]) mkdirSync(path, { mode: 0o700 });
    const installationId = 'epoch-installation', latch = join(controller, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    const release = 'a'.repeat(40), unit = `habit-system-mcp@${release}.service`;
    const active = join(root, 'active'), backendState = join(root, 'backend-state'), fake = join(root, 'systemctl');
    writeFileSync(active, `${unit} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    writeFileSync(fake, `#!/bin/sh
case "$1" in
  list-units) cat "$MCP_FAKE_ACTIVE" ;;
  stop) if [ "$2" = habit-system-fullstack.service ]; then printf '%s\\n' inactive > "$MCP_FAKE_BACKEND_STATE";
        else : > "$MCP_FAKE_ACTIVE"; fi ;;
  show) cat "$MCP_FAKE_BACKEND_STATE" ;;
esac
`, { mode: 0o700 });
    const env = { MCP_FAKE_ACTIVE: active, MCP_FAKE_BACKEND_STATE: backendState };
    const mark = (id: string) => [join(scripts, 'mark-latch.mjs'), '--fixture-latch', latch,
      '--fixture-lock-dir', controller, '--fixture-systemctl', fake, '--current-release-sha', release,
      '--paired', 'yes', '--installation-id', installationId, '--restore-intent-id', id];
    const first = randomUUID();
    run(process.execPath, mark(first), 0, env);
    assert.equal(readFileSync(latch, 'utf8'), `${JSON.stringify({ installationId, version: 1 })}\nrestored ${first}\n`);
    const epoch = new FileRestoreLatch({ path: latch, installationId, restoredDirectories: [state, backend] });
    const firstGeneration = epoch.readGeneration();
    assert.equal(firstGeneration?.restored, true);
    const second = randomUUID();
    run(process.execPath, mark(second), 0, env);
    assert.equal(readFileSync(latch, 'utf8'), `${JSON.stringify({ installationId, version: 1 })}\nrestored ${first}\nrestored ${second}\n`);
    assert.notEqual(epoch.readGeneration()?.generation, firstGeneration?.generation);
    writeFileSync(active, `${unit} loaded active running synthetic\n`);
    writeFileSync(backendState, 'active\n');
    run(process.execPath, mark(second), 1, env);
    assert.equal(readFileSync(latch, 'utf8').endsWith(`restored ${second}\n`), true);
    run(process.execPath, mark(first), 1, env);
    assert.equal(readFileSync(latch, 'utf8').endsWith(`restored ${second}\n`), true);
    const legacy = join(controller, 'legacy-latch');
    FileRestoreLatch.provisionFresh({ path: legacy, installationId, restoredDirectories: [state, backend] });
    appendFileSync(legacy, 'restored\n');
    const legacyMark = mark(randomUUID());
    legacyMark[legacyMark.indexOf('--fixture-latch') + 1] = legacy;
    run(process.execPath, legacyMark, 1, env);
    assert.equal(readFileSync(active, 'utf8'), `${unit} loaded active running synthetic\n`);
    assert.throws(() => epoch.assertReady());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-first-mutation revoked delivery sidecar restores without inventing a journal', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-delivery-only-'));
  try {
    const source = join(root, 'source'), state = join(source, 'state'), backend = join(source, 'backend');
    const keys = join(source, 'keys'), offhost = join(root, 'offhost'), controller = join(root, 'controller');
    const account = join(state, 'accounts/synthetic-account');
    for (const path of [source, state, backend, keys, offhost, controller, join(state, 'accounts'), account]) {
      mkdirSync(path, { mode: 0o700 });
    }
    const accountId = 'synthetic-account', backendUrl = 'https://synthetic.example', principal = 'synthetic-principal';
    const generation = randomUUID();
    const replica = new DatabaseSync(join(account, 'replica.sqlite'));
    replica.exec(`CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
      backend_url TEXT NOT NULL, principal TEXT NOT NULL, healthy_pull_at INTEGER, healthy_revision TEXT);
      CREATE TABLE operation_provenance (id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('never', 'initialized', 'unknown'))); PRAGMA user_version = 2;`);
    replica.prepare('INSERT INTO binding VALUES (1, ?, ?, ?, NULL, NULL)').run(accountId, backendUrl, principal);
    replica.prepare("INSERT INTO operation_provenance VALUES (1, 'initialized')").run(); replica.close();
    chmodSync(join(account, 'replica.sqlite'), 0o600);
    const product = new DatabaseSync(join(account, 'product.sqlite'));
    product.exec(`CREATE TABLE sync_account_bindings (provider TEXT PRIMARY KEY, account_digest TEXT NOT NULL);
      CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY);
      CREATE TABLE mutation_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, mutation_stamp TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    const digest = createHash('sha256').update(JSON.stringify([backendUrl, principal])).digest('hex');
    product.prepare('INSERT INTO sync_account_bindings VALUES (?, ?)').run('snapback4', digest);
    product.prepare('INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES (?, ?, ?, ?)')
      .run('settings', 'synthetic-read-derived', 'synthetic-stamp', 42);
    product.close(); chmodSync(join(account, 'product.sqlite'), 0o600);
    const sidecar = new DatabaseSync(join(account, 'operations.sqlite'));
    sidecar.exec(`CREATE TABLE runtime_meta (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
      backend_url TEXT NOT NULL, principal TEXT NOT NULL, generation TEXT NOT NULL, journal_ready INTEGER NOT NULL);
      CREATE TABLE operation_grants (client_id TEXT NOT NULL, operation_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      tool TEXT NOT NULL, PRIMARY KEY (client_id, operation_id));
      CREATE TABLE delivery_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL,
      initialized INTEGER NOT NULL CHECK (initialized IN (0, 1))); PRAGMA user_version = 1;`);
    sidecar.prepare('INSERT INTO runtime_meta VALUES (1, ?, ?, ?, ?, 0)').run(accountId, backendUrl, principal, generation);
    sidecar.prepare('INSERT INTO delivery_anchor VALUES (1, ?, 1)').run(generation); sidecar.close();
    chmodSync(join(account, 'operations.sqlite'), 0o600);
    const delivery = new DatabaseSync(join(account, 'delivery.sqlite'));
    delivery.exec(`CREATE TABLE delivery_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
      account_id TEXT NOT NULL, backend_url TEXT NOT NULL, principal TEXT NOT NULL);
      CREATE TABLE revoked_grants (grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL);
      CREATE TABLE owner_resumes (outbox_id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL);
      CREATE TABLE account_pause (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL CHECK (paused IN (0, 1)));
      PRAGMA user_version = 1;`);
    delivery.prepare('INSERT INTO delivery_meta VALUES (1, 1, ?, ?, ?)').run(accountId, backendUrl, principal);
    delivery.prepare('INSERT INTO revoked_grants VALUES (?, ?)').run('revoked-synthetic-grant', 'synthetic-client');
    delivery.prepare('INSERT INTO account_pause VALUES (1, 0)').run(); delivery.close();
    chmodSync(join(account, 'delivery.sqlite'), 0o600);
    writeFileSync(join(keys, 'config.json'), '{"version":2}', { mode: 0o600 });
    writeFileSync(join(keys, 'keys.json'), '{"synthetic":"key"}', { mode: 0o600 });
    const identity = join(controller, 'identity.txt'); run(keygen, ['-o', identity]);
    const recipient = run(keygen, ['-y', identity]);
    const installationId = 'delivery-only-installation', latch = join(controller, 'restore-latch');
    FileRestoreLatch.provisionFresh({ path: latch, installationId, restoredDirectories: [state, backend] });
    run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller, '--output-dir', offhost, '--recipient', recipient,
      '--age-bin', age, '--release-sha', 'a'.repeat(40)]);
    const bundle = join(offhost, 'bundle.json');
    run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
      '--fixture-lock-dir', controller, '--controller-dir', controller, '--bundle', bundle,
      '--installation-id', installationId, '--latch', latch]);
    const restored = join(root, 'restored');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', restored,
      '--latch', latch, '--installation-id', installationId,
      '--intent-log', join(controller, 'restore-intents.jsonl')]);
    assert.equal(existsSync(join(restored, 'state/accounts/synthetic-account/journal.sqlite')), false);
    const read = new DatabaseSync(join(restored, 'state/accounts/synthetic-account/operations.sqlite'), { readOnly: true });
    assert.equal(read.prepare('SELECT journal_ready FROM runtime_meta WHERE id = 1').get()?.journal_ready, 0);
    read.close();
    const queued = new DatabaseSync(join(restored, 'state/accounts/synthetic-account/product.sqlite'), { readOnly: true });
    assert.deepEqual(queued.prepare('SELECT id, entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox').all()
      .map(row => ({ ...row })),
      [{ id: 1, entity_type: 'settings', entity_id: 'synthetic-read-derived', mutation_stamp: 'synthetic-stamp', created_at: 42 }]);
    queued.close();
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
    const execute = (file: string, sql: string) => {
      const connection = new DatabaseSync(join(account, file));
      try { connection.exec(sql); } finally { connection.close(); }
    };
    const sidecarPath = join(account, 'operations.sqlite'), journalPath = join(account, 'journal.sqlite');
    const savedSidecar = join(root, 'saved-operations.sqlite');
    const variants = [
      { name: 'ready-journal-missing', change: () => execute('operations.sqlite', 'UPDATE runtime_meta SET journal_ready = 1'),
        reset: () => execute('operations.sqlite', 'UPDATE runtime_meta SET journal_ready = 0') },
      { name: 'unknown-generation', change: () => execute('operations.sqlite', "UPDATE runtime_meta SET generation = 'unknown'"),
        reset: () => execute('operations.sqlite', `UPDATE runtime_meta SET generation = '${generation}'`) },
      { name: 'origin-row', change: () => execute('operations.sqlite', "INSERT INTO operation_grants VALUES ('client', 'operation', 'grant', 'tool')"),
        reset: () => execute('operations.sqlite', 'DELETE FROM operation_grants') },
      { name: 'owner-resume', change: () => execute('delivery.sqlite', "INSERT INTO owner_resumes VALUES (1, 'grant')"),
        reset: () => execute('delivery.sqlite', 'DELETE FROM owner_resumes') },
      { name: 'delivery-identity', change: () => execute('delivery.sqlite', "UPDATE delivery_meta SET principal = 'other'"),
        reset: () => execute('delivery.sqlite', `UPDATE delivery_meta SET principal = '${principal}'`) },
      { name: 'product-receipt', change: () => execute('product.sqlite', "INSERT INTO command_receipts VALUES ('command')"),
        reset: () => execute('product.sqlite', 'DELETE FROM command_receipts') },
      { name: 'unknown-replica-provenance', change: () => execute('replica.sqlite', "UPDATE operation_provenance SET state = 'unknown'"),
        reset: () => execute('replica.sqlite', "UPDATE operation_provenance SET state = 'initialized'") },
      { name: 'journal-without-sidecar', change: () => {
        renameSync(sidecarPath, savedSidecar); writeFileSync(journalPath, 'synthetic', { mode: 0o600 });
      }, reset: () => { rmSync(journalPath); renameSync(savedSidecar, sidecarPath); } },
    ];
    for (const variant of variants) {
      variant.change();
      try {
        const output = join(root, `${variant.name}-output`), ownController = join(root, `${variant.name}-controller`);
        mkdirSync(output, { mode: 0o700 }); mkdirSync(ownController, { mode: 0o700 });
        const ownLatch = join(ownController, 'restore-latch'), ownId = `delivery-${variant.name}`;
        FileRestoreLatch.provisionFresh({ path: ownLatch, installationId: ownId,
          restoredDirectories: [state, backend] });
        run(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
          '--fixture-lock-dir', ownController, '--output-dir', output, '--recipient', recipient,
          '--age-bin', age, '--release-sha', 'a'.repeat(40)]);
        const ownBundle = join(output, 'bundle.json');
        run(process.execPath, [join(scripts, 'restore-intent.mjs'), '--fixture-root', source,
          '--fixture-lock-dir', ownController, '--controller-dir', ownController, '--bundle', ownBundle,
          '--installation-id', ownId, '--latch', ownLatch]);
        const target = join(root, `${variant.name}-restored`);
        run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
          '--bundle', ownBundle, '--identity', identity, '--age-bin', age, '--target', target,
          '--latch', ownLatch, '--installation-id', ownId,
          '--intent-log', join(ownController, 'restore-intents.jsonl')], 1);
        assert.equal(existsSync(target), false, variant.name);
      } finally { variant.reset(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paired backup refuses foreign links, escaped stores, world writable directories and hardlinks before encryption', () => {
  const cases = [
    { name: 'foreign link', alter: (backend: string, root: string) => symlinkSync(join(root, 'outside'), join(backend, 'foreign')) },
    { name: 'absolute store link', alter: (backend: string) => symlinkSync('/tmp/store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite')) },
    { name: 'wrong relative store link', alter: (backend: string) => symlinkSync('../../../../store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite')) },
    { name: 'chained store link', alter: (backend: string) => {
      symlinkSync('other.sqlite', join(backend, 'store.sqlite'));
      writeFileSync(join(backend, 'other.sqlite'), 'chain');
      symlinkSync('../../../store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite'));
    } },
    { name: 'world writable descendant', alter: (backend: string) => {
      chmodSync(join(backend, 'releases/1'), 0o777);
      symlinkSync('../../../store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite'));
    } },
    { name: 'group writable assets', alter: (backend: string) => {
      const assets = join(backend, 'assets'); mkdirSync(assets, { mode: 0o700 }); chmodSync(assets, 0o775);
    } },
    { name: 'group writable unrelated release child', alter: (backend: string) => {
      const other = join(backend, 'releases/1/other'); mkdirSync(other, { mode: 0o700 }); chmodSync(other, 0o775);
    } },
    { name: 'group writable nested snapback child', alter: (backend: string) => {
      const nested = join(backend, 'releases/1/snapback'); mkdirSync(nested, { mode: 0o700 });
      const other = join(nested, 'other'); mkdirSync(other, { mode: 0o700 }); chmodSync(other, 0o775);
    } },
    { name: 'hardlinked store', alter: (backend: string) => {
      writeFileSync(join(backend, 'store.sqlite'), 'store');
      const other = join(backend, 'other.sqlite');
      run('ln', [join(backend, 'store.sqlite'), other]);
      symlinkSync('../../../store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite'));
    } },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-link-refusal-'));
    try {
      const source = join(root, 'source'), state = join(source, 'state'), backend = join(source, 'backend');
      const keys = join(source, 'keys'), output = join(root, 'output'), lock = join(root, 'lock');
      for (const path of [source, state, backend, keys, output, lock]) mkdirSync(path, { mode: 0o700 });
      mkdirSync(join(backend, 'releases'), { mode: 0o700 });
      mkdirSync(join(backend, 'releases/1'), { mode: 0o700 });
      mkdirSync(join(backend, 'releases/1/.snapback4'), { mode: 0o700 });
      writeFileSync(join(keys, 'config.json'), '{}', { mode: 0o600 });
      writeFileSync(join(keys, 'keys.json'), '{}', { mode: 0o600 });
      scenario.alter(backend, root);
      const identity = join(root, 'identity.txt');
      run(keygen, ['-o', identity]);
      const recipient = run(keygen, ['-y', identity]);
      const result = spawnSync(process.execPath, [join(scripts, 'backup.mjs'), '--fixture-root', source,
        '--fixture-lock-dir', lock, '--output-dir', output, '--recipient', recipient,
        '--age-bin', age, '--release-sha', 'a'.repeat(40)],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, MCP_RECOVERY_FIXTURE: '1' } });
      assert.equal(result.status, 1, scenario.name);
      assert.match(result.stderr, /backup refused/, scenario.name);
      assert.equal(readdirSync(output).length, 0, scenario.name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('isolated tar validator rejects foreign links, chained stores and unrelated group writable directories before extraction', () => {
  for (const scenario of ['foreign', 'chained', 'group writable assets']) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-tar-link-refusal-'));
    try {
      const source = join(root, 'source'), backend = join(source, 'backend');
      const output = join(root, 'output'), archive = join(root, 'crafted.tar');
      mkdirSync(source, { mode: 0o700 }); mkdirSync(backend, { mode: 0o700 });
      mkdirSync(output, { mode: 0o700 });
      if (scenario === 'foreign') {
        symlinkSync('/etc/passwd', join(backend, 'foreign'));
      } else if (scenario === 'chained') {
        mkdirSync(join(backend, 'releases'), { mode: 0o700 });
        mkdirSync(join(backend, 'releases/1'), { mode: 0o700 });
        mkdirSync(join(backend, 'releases/1/.snapback4'), { mode: 0o700 });
        symlinkSync('other.sqlite', join(backend, 'store.sqlite'));
        writeFileSync(join(backend, 'other.sqlite'), 'synthetic');
        symlinkSync('../../../store.sqlite', join(backend, 'releases/1/.snapback4/store.sqlite'));
      } else {
        const assets = join(backend, 'assets'); mkdirSync(assets, { mode: 0o700 }); chmodSync(assets, 0o775);
      }
      run('tar', ['-C', source, '-cf', archive, '.']);
      const result = spawnSync('uv', ['run', '--no-project', 'python', join(scripts, 'safe-tar.py'),
        archive, output, 'data'], { encoding: 'utf8', timeout: 30_000 });
      assert.notEqual(result.status, 0, scenario);
      assert.equal(readdirSync(output).length, 0, scenario);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
