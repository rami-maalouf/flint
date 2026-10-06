import { ownedSyntheticDevice } from './synthetic-device';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve, join } from 'node:path';
import { supportedSyntheticStores } from '../../tests/e2e/synthetic-store';

// destructive fixture setup is restricted to the task-owned simulator and app identity.
if (process.env.E2E_EAS_SIMULATOR === '1' || process.env.E2E_TARGET === 'device') throw new Error('synthetic reset requires local simulator mode');
const device = ownedSyntheticDevice();
const owned = device.device;
const app = device.appId;
const artifact = process.env.E2E_NATIVE_APP;
if (!artifact) throw new Error('set E2E_NATIVE_APP to the verified development-signed native app');
function gitRepository(cwd: string): string {
  return realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
}

function refuseActiveRepositoryRunner(): void {
  const processes = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  for (const line of processes.split('\n')) {
    const candidate = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!candidate) continue;
    // inspect runtime invocations, excluding shells and inline code that merely mention a runner.
    const args = Array.from(candidate[2].matchAll(/"([^"\n]*)"|'([^'\n]*)'|(\S+)/g), match => match[1] ?? match[2] ?? match[3]);
    if (!['bun', 'node', 'e2e'].includes(basename(args[0] ?? '')) || args.some(arg => /^(?:-e|-p|--eval(?:=|$)|--print(?:=|$))/.test(arg))) continue;
    const runner = args.some((arg, index) => /(?:^|\/)e2e\/dist\/run\/worker\/entry\.js$/.test(arg) ||
      /(?:^|\/)scripts\/e2e\/run-local\.ts$/.test(arg) ||
      (/(?:^|\/)(?:e2e\/dist\/cli\/bin\.js|\.bin\/e2e|e2e)$/.test(arg) && args[index + 1] === 'run') ||
      (arg === 'run' && /^test:e2e(?:$|:)/.test(args[index + 1] ?? '')));
    if (!runner) continue;
    let owner: string;
    let current: string;
    try {
      const fields = execFileSync('lsof', ['-a', '-p', candidate[1], '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
      const paths = fields.filter(field => field.startsWith('n')).map(field => field.slice(1));
      if (paths.length !== 1 || !isAbsolute(paths[0])) throw new Error('runner cwd is unavailable');
      owner = gitRepository(realpathSync(paths[0]));
      current = gitRepository(process.cwd());
    } catch (cause) { throw new Error('cannot establish e2e runner repository ownership; refusing reset', { cause }); }
    if (owner === current) throw new Error('cannot reset while there is an active e2e worker or runner in this repository');
  }
}
refuseActiveRepositoryRunner();
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
