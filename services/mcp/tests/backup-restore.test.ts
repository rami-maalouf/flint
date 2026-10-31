import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.throws(() => new FileRestoreLatch({ path: latch, installationId,
      restoredDirectories: [state, backend] }).assertReady());
    const restored = join(root, 'restored-a');
    run(process.execPath, [join(scripts, 'restore-isolated.mjs'), '--fixture-root', source,
      '--bundle', bundle, '--identity', identity, '--age-bin', age, '--target', restored,
      '--latch', latch, '--installation-id', installationId,
      '--intent-log', join(controller, 'restore-intents.jsonl')]);
    assert.equal(existsSync(join(restored, 'state')), true);
    assert.equal(existsSync(join(restored, 'backend')), true);
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
      '--fixture-lock-dir', lockDir, '--installation-id', installationId];
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
