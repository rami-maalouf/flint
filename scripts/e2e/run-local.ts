import { ownedSyntheticDevice } from './synthetic-device';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { syntheticDatabase, syntheticRows } from '../../tests/e2e/synthetic-store';

function fixtureCounts() {
  try { syntheticDatabase(); } catch (cause) {
    if (cause instanceof Error && cause.message === 'synthetic database has not been initialized') return { initialized: false, boards: 0, checks: 0, ledger: 0, rewards: 0, reminders: 0 };
    throw cause;
  }
  return { initialized: true, ...(syntheticRows('select (select count(*) from boards) boards, (select count(*) from check_ins) checks, (select count(*) from coin_ledger) ledger, (select count(*) from rewards) rewards, (select count(*) from reminders) reminders')[0] as Record<string, number>) };
}

// local evidence must come from the dedicated synthetic simulator, never personal data.
const device = process.env.E2E_DEVICE;
if (!device || process.env.E2E_SYNTHETIC_DEVICE !== device) {
  throw new Error('set matching E2E_DEVICE and E2E_SYNTHETIC_DEVICE to an isolated simulator');
}
ownedSyntheticDevice();
const metro = process.env.E2E_METRO_URL;
if (!metro) throw new Error('set E2E_METRO_URL to the isolated checkout Metro URL');
const nativeReceipt = process.env.E2E_NATIVE_RECEIPT;
if (!nativeReceipt) throw new Error('set E2E_NATIVE_RECEIPT to the exact source-build signing receipt');
const nativeReceiptText = readFileSync(nativeReceipt, 'utf8');
const beforeFixtureCounts = fixtureCounts();
const fullSuite = process.argv.slice(2).length === 0 || process.env.E2E_REQUIRE_FRESH_STORE === '1';
const resetReceiptPath = process.env.E2E_FRESH_RESET_RECEIPT;
let resetReceipt: unknown;
if (fullSuite) {
  if (!resetReceiptPath) throw new Error('full local suites require E2E_FRESH_RESET_RECEIPT from an owned reset between passes');
  const receipt = JSON.parse(readFileSync(resetReceiptPath, 'utf8')) as { device: string; app: string; resetAt: string };
  if (receipt.device !== device || receipt.app !== 'studio.orbitlabs.habitsystem.dev' || !Number.isFinite(Date.parse(receipt.resetAt))) throw new Error('fresh reset receipt does not match the owned simulator');
  if (Object.entries(beforeFixtureCounts).some(([key, value]) => key !== 'initialized' && value !== 0)) throw new Error('full local suite requires an empty owned fixture store');
  resetReceipt = receipt;
}
const ui = (option: string, value?: string) => execFileSync('xcrun', ['simctl', 'ui', device, option, ...(value ? [value] : [])], { encoding: 'utf8' }).trim();
const initialUi = { appearance: ui('appearance'), contentSize: ui('content_size') };
// each local run begins with explicit visual preconditions on the owned simulator.
ui('appearance', 'light');
ui('content_size', 'large');
const root = process.cwd();
const startedAt = new Date().toISOString();
const jsCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const jsDiff = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' });
const gitStatus = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'modules/ripples-apple', '.eas/workflows', 'tests/e2e', 'scripts/e2e', 'e2e.config.ts', 'app.json', 'app.config.js', 'package.json', 'bun.lock'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const destination = resolve('.artifacts/e2e-evidence', startedAt.replaceAll(':', '-'));
mkdirSync(destination, { recursive: true });
const args = ['run', 'test:e2e:simulator', '--video', 'off', ...process.argv.slice(2)];
const result = spawnSync('bun', args, {
  stdio: 'inherit',
  env: { ...process.env, AGENT_DEVICE_STATE_DIR: resolve('.artifacts/agent-device') },
});
const observedFinalUi = { appearance: ui('appearance'), contentSize: ui('content_size') };
const afterFixtureCounts = fixtureCounts();
// restore the suite baseline even when an appearance attempt is interrupted.
ui('appearance', 'light');
ui('content_size', 'large');
let reportFresh = false;
try {
  const report = JSON.parse(readFileSync(resolve('.e2e/report.json'), 'utf8'));
  reportFresh = Date.parse(report.run.startedAt) >= Date.parse(startedAt);
} catch { /* interrupted discovery may not write a report */ }
for (const file of reportFresh ? ['report.json', 'summary.md', 'junit.xml'] : []) {
  try { copyFileSync(resolve('.e2e', file), resolve(destination, file)); } catch { /* missing report is recorded below */ }
}
if (reportFresh) {
  try { cpSync(resolve('.e2e/artifacts'), resolve(destination, 'artifacts'), { recursive: true }); } catch { /* an attempt may have no artifacts */ }
}
writeFileSync(resolve(destination, 'provenance.json'), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), command: ['bun', ...args], root,
  device, metro, initialUi, observedFinalUi, visualBaseline: { appearance: 'light', contentSize: 'large' }, exitCode: result.status, signal: result.signal, reportFresh,
  sourceHashes,
  fixtureMode: fullSuite ? 'fresh-full-suite' : 'focused-retained-data', resetReceipt, beforeFixtureCounts, afterFixtureCounts,
  gitStatus, jsCommit, jsDiff,
  finishingGitStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
  nativeReceipt: nativeReceiptText,
}, null, 2));
console.log(`evidence: ${destination}`);
process.exit(result.status ?? 1);
