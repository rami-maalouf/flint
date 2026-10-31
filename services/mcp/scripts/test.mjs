import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

assert.equal(process.versions.node, '24.22.2', 'use the pinned Node runtime for service tests');
assert.equal(process.versions.bun, undefined, 'service tests require real Node SQLite');
const coveragePreload = new URL(import.meta.url);
coveragePreload.search = '?coverage-child-environment';
if (import.meta.url === coveragePreload.href) configureCoverageChildEnvironment();
else runTests();

function configureCoverageChildEnvironment() {
  const proofCommand = fileURLToPath(new URL('./proof-command.js', import.meta.resolve('snapback4/proof')));
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    // the proof guard sigkills this wrapper during exit, interrupting v8's json write.
    // node propagates coverage through whitelisted environments unless explicitly empty.
    if (command === process.execPath && Array.isArray(args) && args[0] === proofCommand) {
      options = { ...options, env: { ...(options?.env ?? process.env), NODE_V8_COVERAGE: '' } };
    }
    return spawn.call(this, command, args, options);
  };
  syncBuiltinESMExports();
}

function runTests() {
  const service = fileURLToPath(new URL('../', import.meta.url));
  const suite = process.argv[2] ?? 'all';
  assert.ok(['all', 'unit', 'integration', 'protocol'].includes(suite));
  const files = readdirSync(resolve(service, 'tests'), { recursive: true }).map(String).filter(path => path.endsWith('.test.ts'));
  function group(file) {
    if (/(?:^|\/)(?:protocol|http|server)/.test(file)) return 'protocol';
    if (/(?:^|\/)(?:operations|recovery-head|accounts|convergence|runtime-writes|resource-runtime|backup-restore|history-performance)/.test(file)) return 'integration';
    return 'unit';
  }
  const selected = files.filter(file => suite === 'all' || group(file) === suite);
  const runtimeFiles = [];
  for (const file of selected) {
    const source = resolve(service, 'tests', file);
    const output = resolve(service, '.artifacts', file.replace(/([^/]+)\.ts$/, `run-${process.pid}-$1.mjs`));
    const built = spawnSync('bun', ['build', source, '--target=node', '--packages=external', `--outfile=${output}`],
      { cwd: service, stdio: 'inherit' });
    if (built.status !== 0) process.exit(built.status ?? 1);
    runtimeFiles.push(output);
  }
  if (suite === 'protocol' || suite === 'all') runtimeFiles.push(resolve(service, 'proofs/auth.test.mjs'));
  assert.ok(runtimeFiles.length > 0, `no tests selected for ${suite}`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2',
    ...(process.env.MCP_TEST_COVERAGE === '1' ? ['--experimental-test-coverage', `--import=${coveragePreload.href}`] : []), ...runtimeFiles],
  { cwd: resolve(service, '../..'), stdio: 'inherit' });
  for (const file of runtimeFiles) if (file.startsWith(resolve(service, '.artifacts') + '/')) unlinkSync(file);
  process.exit(result.status ?? 1);
}
