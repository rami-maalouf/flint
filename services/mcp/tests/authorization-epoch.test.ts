import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { FileAuthorizationEpoch } from '../src/auth/epoch';
import { FileRestoreLatch } from '../src/operations/recovery-head';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'habit-mcp-epoch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'), backend = join(root, 'backend'), external = join(root, 'external');
  for (const path of [data, backend, external]) mkdirSync(path, { mode: 0o700 });
  const options = { path: join(external, 'latch'), installationId: randomUUID(), restoredDirectories: [data, backend] as const };
  return { root, options };
}

test('ready epochs survive restart; each durable restore invalidates all earlier authority', async t => {
  const { options } = fixture(t);
  FileRestoreLatch.provisionFresh(options);
  const source = new FileAuthorizationEpoch(options);
  const ready = await source.current();
  assert.equal(ready.mode, 'normal');
  assert.deepEqual(await new FileAuthorizationEpoch(options).current(), ready);
  const latch = new FileRestoreLatch(options);
  latch.markRestored();
  assert.throws(() => latch.assertReady(), { code: 'OPERATION_PENDING' });
  const first = await source.current();
  assert.equal(first.mode, 'degraded_read'); assert.notEqual(first.epoch, ready.epoch);
  assert.deepEqual(await new FileAuthorizationEpoch(options).current(), first);
  latch.markRestored();
  const second = await source.current();
  assert.equal(second.mode, 'degraded_read'); assert.notEqual(second.epoch, first.epoch);
  assert.deepEqual(await new FileAuthorizationEpoch(options).current(), second);
});

test('missing or damaged custody uses only a process-bound read epoch and never provisions', async t => {
  const { options } = fixture(t);
  const source = new FileAuthorizationEpoch(options);
  const missing = await source.current();
  assert.equal(missing.mode, 'degraded_read'); assert.deepEqual(await source.current(), missing);
  assert.notEqual((await new FileAuthorizationEpoch(options).current()).epoch, missing.epoch);
  assert.throws(() => readFileSync(options.path), { code: 'ENOENT' });
  for (const content of ['garbage', Buffer.from([0xff]), 'x'.repeat(4097)]) {
    writeFileSync(options.path, content, { mode: 0o600 });
    assert.deepEqual(await source.current(), missing);
  }
});

test('unsafe, foreign and legacy markers cannot supply durable authority', async t => {
  const { root, options } = fixture(t);
  FileRestoreLatch.provisionFresh(options);
  const readyBytes = readFileSync(options.path);
  const source = new FileAuthorizationEpoch(options);
  const ready = await source.current();
  const checkDegraded = async () => {
    const current = await source.current();
    assert.equal(current.mode, 'degraded_read'); assert.notEqual(current.epoch, ready.epoch);
  };
  chmodSync(options.path, 0o644); await checkDegraded(); chmodSync(options.path, 0o600);
  chmodSync(options.path, 0o700); await checkDegraded(); chmodSync(options.path, 0o600);
  const hardlink = join(root, 'hardlink'); linkSync(options.path, hardlink); await checkDegraded(); rmSync(hardlink);
  writeFileSync(options.path, Buffer.concat([readyBytes, Buffer.from('restored\n')])); await checkDegraded();
  new FileRestoreLatch(options).markRestored();
  assert.deepEqual(await source.current(), await new FileAuthorizationEpoch(options).current());
  writeFileSync(options.path, JSON.stringify({ installationId: randomUUID(), version: 1 }) + '\n'); await checkDegraded();
  rmSync(options.path); const target = join(root, 'target'); writeFileSync(target, readyBytes, { mode: 0o600 });
  symlinkSync(target, options.path); await checkDegraded();
  rmSync(options.path); execFileSync('mkfifo', [options.path]); await checkDegraded();
});

test('epoch custody cannot be placed inside either restored root', t => {
  const { options } = fixture(t);
  for (const root of options.restoredDirectories) {
    assert.throws(() => new FileAuthorizationEpoch({ ...options, path: join(root, 'latch') }), { code: 'OPERATION_PENDING' });
  }
});
