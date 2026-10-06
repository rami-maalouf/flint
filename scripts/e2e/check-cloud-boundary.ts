import { execFileSync } from 'node:child_process';

// deliberately pass local flags too: the cloud boundary must take precedence.
const localFiles = new Set(['backup', 'board-management', 'lifecycle', 'stacks', 'native-acceptance', 'widget-links', 'sample-mode', 'coin-cap', 'ordering', 'appearance'].map(name => `tests/e2e/${name}.e2e.ts`));
const portableFiles = new Set(['count-history', 'layout-coverage', 'settings-flows', 'reminders', 'reward-management', 'recovery'].map(name => `tests/e2e/${name}.e2e.ts`));
const report = JSON.parse(execFileSync('node', ['node_modules/e2e/dist/cli/bin.js', 'list', '--reporter', 'json'], {
  encoding: 'utf8',
  env: { ...process.env, E2E_EAS_SIMULATOR: '1', E2E_DEVICE: 'synthetic', E2E_SYNTHETIC_DEVICE: 'synthetic' },
})) as { pairs: { file: string; disposition: string }[] };
for (const pair of report.pairs) {
  if (localFiles.has(pair.file) && pair.disposition !== 'skip') throw new Error(`cloud selected local filesystem acceptance: ${pair.file}`);
  if (portableFiles.has(pair.file) && pair.disposition !== 'run') throw new Error(`cloud omitted portable UI coverage: ${pair.file}`);
}
const portable = report.pairs.filter(pair => portableFiles.has(pair.file)).length;
if (!portable) throw new Error('portable coverage was not discovered');
console.log(`cloud discovery: ${portable} new portable UI tests selected; local filesystem acceptance excluded`);
