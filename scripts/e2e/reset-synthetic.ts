import { ownedSyntheticDevice } from './synthetic-device';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// destructive fixture setup is restricted to the task-owned simulator and app identity.
const device = ownedSyntheticDevice();
const owned = device.device;
const app = device.appId;
const artifact = process.env.E2E_NATIVE_APP;
if (!artifact) throw new Error('set E2E_NATIVE_APP to the verified development-signed native app');
const processes = execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8' });
if (processes.includes(`${process.cwd()}/node_modules/e2e/dist/run/worker/entry.js`)) throw new Error('cannot reset while this checkout has an active e2e worker');
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(artifact, 'Info.plist')], { encoding: 'utf8' }));
if (info.CFBundleIdentifier !== app || info.RipplesAppGroupIdentifier !== 'group.studio.orbitlabs.habitsystem') {
  throw new Error('native identity mismatch');
}
let group: string | undefined;
try { group = execFileSync('xcrun', ['simctl', 'get_app_container', owned, app, 'group.studio.orbitlabs.habitsystem'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* fresh install has no group */ }
if (group && !group.includes(`/Devices/${owned}/data/Containers/Shared/AppGroup/`)) throw new Error('unexpected group path');
const archive = resolve('.artifacts/synthetic-resets', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(archive, { recursive: true });
if (group && existsSync(join(group, 'ripples.db'))) {
  execFileSync('sqlite3', [join(group, 'ripples.db'), `.backup '${join(archive, 'before.db')}'`]);
}
try { execFileSync('xcrun', ['simctl', 'terminate', owned, app], { stdio: 'ignore' }); } catch { /* not running */ }
execFileSync('xcrun', ['simctl', 'uninstall', owned, app]);
// an app-group directory can outlive uninstall; only this task's identified database is removed.
if (group) for (const suffix of ['', '-wal', '-shm']) rmSync(join(group, `ripples.db${suffix}`), { force: true });
if (group && existsSync(join(group, 'ripples.db'))) throw new Error('synthetic database survived reset');
execFileSync('xcrun', ['simctl', 'install', owned, artifact]);
const receipt = { device: owned, name: device.name, app, artifact: resolve(artifact), preservedDatabase: existsSync(join(archive, 'before.db')), archive, resetAt: new Date().toISOString(), emptyDatabaseVerified: true };
writeFileSync(join(archive, 'receipt.json'), JSON.stringify(receipt, null, 2));
writeFileSync(resolve('.artifacts/synthetic-reset-latest.json'), JSON.stringify(receipt, null, 2));
console.log(`synthetic reset receipt: ${archive}`);
