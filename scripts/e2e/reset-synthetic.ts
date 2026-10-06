import { ownedSyntheticDevice } from './synthetic-device';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { supportedSyntheticStores } from '../../tests/e2e/synthetic-store';

// destructive fixture setup is restricted to the task-owned simulator and app identity.
if (process.env.E2E_EAS_SIMULATOR === '1' || process.env.E2E_TARGET === 'device') throw new Error('synthetic reset requires local simulator mode');
const device = ownedSyntheticDevice();
const owned = device.device;
const app = device.appId;
const artifact = process.env.E2E_NATIVE_APP;
if (!artifact) throw new Error('set E2E_NATIVE_APP to the verified development-signed native app');
const processes = execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8' });
const runnerMarkers = ['/e2e/dist/run/worker/entry.js', '/e2e/dist/cli/bin.js run', '/node_modules/.bin/e2e run', 'scripts/e2e/run-local.ts'];
if (runnerMarkers.some(marker => processes.includes(marker))) throw new Error('cannot reset while there is an active e2e worker or runner');
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(artifact, 'Info.plist')], { encoding: 'utf8' }));
if (info.CFBundleIdentifier !== app || info.RipplesAppGroupIdentifier !== 'group.studio.orbitlabs.habitsystem') {
  throw new Error('native identity mismatch');
}
const stores = supportedSyntheticStores(device);
const { group } = stores;
const archive = resolve('.artifacts/synthetic-resets', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(archive, { recursive: true });
try { execFileSync('xcrun', ['simctl', 'terminate', owned, app], { stdio: 'ignore' }); } catch { /* not running */ }
const databases = stores.databases.map((source, index) => {
  const backup = join(archive, index === 0 ? 'before.db' : `before-${index}.db`);
  execFileSync('sqlite3', ['-readonly', source, `.backup ${JSON.stringify(backup)}`]);
  const integrityCheck = execFileSync('sqlite3', ['-readonly', backup, 'pragma integrity_check'], { encoding: 'utf8' }).trim();
  if (integrityCheck !== 'ok' || statSync(backup).size === 0) throw new Error('synthetic database backup failed verification');
  return { source, backup, integrityCheck, bytes: statSync(backup).size, sha256: createHash('sha256').update(readFileSync(backup)).digest('hex') };
});
// preserve archive evidence even if uninstall or reinstall subsequently fails.
writeFileSync(join(archive, 'preservation.json'), JSON.stringify({ device: owned, app, sourceDatabase: stores.databases[0] ?? null, databases }, null, 2));
execFileSync('xcrun', ['simctl', 'uninstall', owned, app]);
// an app-group directory can outlive uninstall; only this task's identified database is removed.
if (group) for (const suffix of ['', '-wal', '-shm']) rmSync(join(group, `ripples.db${suffix}`), { force: true });
if (stores.databases.some(source => existsSync(source)) || (group && existsSync(join(group, 'ripples.db')))) throw new Error('synthetic database survived reset');
execFileSync('xcrun', ['simctl', 'install', owned, artifact]);
const receipt = { device: owned, name: device.name, app, artifact: resolve(artifact), sourceDatabase: stores.databases[0] ?? null, databases, preservedDatabase: databases.length > 0, archive, resetAt: new Date().toISOString(), emptyDatabaseVerified: true };
writeFileSync(join(archive, 'receipt.json'), JSON.stringify(receipt, null, 2));
writeFileSync(resolve('.artifacts/synthetic-reset-latest.json'), JSON.stringify(receipt, null, 2));
console.log(`synthetic reset receipt: ${archive}`);
