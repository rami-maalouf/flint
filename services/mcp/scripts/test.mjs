import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

assert.equal(process.versions.node, '24.22.2', 'use the pinned Node runtime for service tests');
assert.equal(process.versions.bun, undefined, 'service tests require real Node SQLite');
const service = fileURLToPath(new URL('../', import.meta.url));
const suite = process.argv[2] ?? 'all';
assert.ok(['all', 'unit', 'integration', 'protocol'].includes(suite));
const files = readdirSync(resolve(service, 'tests'), { recursive: true }).map(String).filter(path => path.endsWith('.test.ts'));
function group(file) {
  if (/(?:^|\/)(?:protocol|http|server)/.test(file)) return 'protocol';
  if (/(?:^|\/)(?:operations|recovery-head|accounts|convergence|runtime-writes|resource-runtime|backup-restore)/.test(file)) return 'integration';
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
  ...(process.env.MCP_TEST_COVERAGE === '1' ? ['--experimental-test-coverage'] : []), ...runtimeFiles],
{ cwd: resolve(service, '../..'), stdio: 'inherit' });
for (const file of runtimeFiles) if (file.startsWith(resolve(service, '.artifacts') + '/')) unlinkSync(file);
process.exit(result.status ?? 1);
