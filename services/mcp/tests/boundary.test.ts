import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const service = fileURLToPath(new URL('../', import.meta.url));
test('the production core bundle contains no mobile runtime imports', () => {
  const build = spawnSync('bun', ['build', 'src/core.ts', '--target=node', '--packages=external',
    '--outfile=.artifacts/core-boundary.js', '--metafile=.artifacts/core-boundary.json'], { cwd: service, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const graph = JSON.parse(readFileSync(new URL('../.artifacts/core-boundary.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(graph.inputs).some(path => path.includes('core/domain/check-in-commands.ts')));
  for (const [path, input] of Object.entries(graph.inputs) as [string, { imports: { path: string }[] }][]) {
    assert.ok(!/(?:^|\/)(?:expo[^/]*|react(?:-native)?)(?:\/|$)/.test(path), path);
    for (const dependency of input.imports) {
      assert.ok(!/^(?:expo(?:-|\/|$)|react(?:-native)?(?:\/|$))/.test(dependency.path), dependency.path);
    }
  }
  const execute = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const core = await import("./.artifacts/core-boundary.js"); const db = new core.NodeSqlDatabase(); await db.closeAsync();'],
  { cwd: service, encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr);
});
