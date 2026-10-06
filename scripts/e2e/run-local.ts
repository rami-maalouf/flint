import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// local evidence must come from the dedicated synthetic simulator, never personal data.
const device = process.env.E2E_DEVICE;
if (!device || process.env.E2E_SYNTHETIC_DEVICE !== device) {
  throw new Error('set matching E2E_DEVICE and E2E_SYNTHETIC_DEVICE to an isolated simulator');
}
const inventory = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' })) as { devices: Record<string, { udid: string; name: string }[]> };
const selected = Object.values(inventory.devices).flat().find(entry => entry.udid === device);
if (device !== 'E2CB451D-AC1F-42BB-96A3-ED4FF08E01D0' || selected?.name !== 'Habit-System-TesterArmy-E2E') {
  throw new Error('local evidence requires the exact task-owned synthetic simulator');
}
const metro = process.env.E2E_METRO_URL;
if (!metro) throw new Error('set E2E_METRO_URL to the isolated checkout Metro URL');
const nativeReceipt = process.env.E2E_NATIVE_RECEIPT;
if (!nativeReceipt) throw new Error('set E2E_NATIVE_RECEIPT to the exact source-build signing receipt');
const root = process.cwd();
const startedAt = new Date().toISOString();
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'modules/ripples-apple/ios', 'tests/e2e', 'scripts/e2e', 'e2e.config.ts', 'app.json', 'app.config.js', 'package.json', 'bun.lock'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const destination = resolve('.artifacts/e2e-evidence', startedAt.replaceAll(':', '-'));
mkdirSync(destination, { recursive: true });
const args = ['run', 'test:e2e:simulator', '--video', 'off', ...process.argv.slice(2)];
const result = spawnSync('bun', args, {
  stdio: 'inherit',
  env: { ...process.env, AGENT_DEVICE_STATE_DIR: resolve('.artifacts/agent-device') },
});
let reportFresh = false;
try {
  const report = JSON.parse(readFileSync(resolve('.e2e/report.json'), 'utf8'));
  reportFresh = Date.parse(report.run.startedAt) >= Date.parse(startedAt);
} catch { /* interrupted discovery may not write a report */ }
for (const file of reportFresh ? ['report.json', 'summary.md', 'junit.xml'] : []) {
  try { copyFileSync(resolve('.e2e', file), resolve(destination, file)); } catch { /* missing report is recorded below */ }
}
writeFileSync(resolve(destination, 'provenance.json'), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), command: ['bun', ...args], root,
  device, metro, exitCode: result.status, signal: result.signal, reportFresh,
  sourceHashes,
  gitStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
  jsCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  jsDiff: execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' }),
  nativeReceipt: readFileSync(nativeReceipt, 'utf8'),
}, null, 2));
console.log(`evidence: ${destination}`);
process.exit(result.status ?? 1);
