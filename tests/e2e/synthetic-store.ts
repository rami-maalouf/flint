import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { ownedSyntheticDevice, type SyntheticDeviceReceipt } from '../../scripts/e2e/synthetic-device';

export function supportedSyntheticStores(receipt: SyntheticDeviceReceipt): { group?: string; databases: string[] } {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(receipt.device)) throw new Error('unexpected device identity');
  function container(kind: string, subtree: string): string | undefined {
    let path: string;
    try {
      path = execFileSync('xcrun', ['simctl', 'get_app_container', receipt.device, receipt.appId, kind], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (cause) {
      if (kind === 'data') throw new Error('cannot resolve synthetic data container before reset or inspection', { cause });
      return undefined; /* builds without app groups use the documents store */
    }
    const marker = `/Devices/${receipt.device}/data/Containers/${subtree}/`;
    const index = path.indexOf(marker);
    if (!isAbsolute(path) || index < 0) throw new Error('unexpected synthetic container path');
    const canonical = realpathSync(path);
    const expectedRoot = path.slice(0, index) + marker;
    if (!canonical.startsWith(expectedRoot) || canonical.slice(expectedRoot.length).includes(sep)) throw new Error('unexpected synthetic container realpath');
    return canonical;
  }
  const group = container(receipt.appGroup, 'Shared/AppGroup');
  const data = container('data', 'Data/Application');
  const databases: string[] = [];
  for (const [root, relative] of [[group, 'ripples.db'], [data, 'Documents/SQLite/ripples.db']] as const) {
    if (!root) continue;
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const canonical = realpathSync(path);
    if (!canonical.startsWith(root + sep) || canonical !== path) throw new Error('unexpected synthetic database realpath');
    databases.push(canonical);
  }
  return { group, databases };
}

// reads only an explicitly opted-in synthetic simulator; never seeds or rewrites its store.
export function syntheticDatabase(): string {
  if (process.env.E2E_EAS_SIMULATOR === '1' || process.env.E2E_TARGET === 'device') throw new Error('synthetic filesystem checks require local simulator mode');
  const receipt = ownedSyntheticDevice();
  const app = process.env.E2E_APP_ID ?? receipt.appId;
  if (app !== receipt.appId) throw new Error('synthetic acceptance requires the owned development identity');
  const source = supportedSyntheticStores(receipt).databases[0];
  if (!source) throw new Error('synthetic database has not been initialized');
  return source;
}

export function syntheticRows(query: string): unknown[] {
  const result = execFileSync('sqlite3', ['-readonly', '-json', syntheticDatabase(), query], { encoding: 'utf8' });
  return result.trim() ? JSON.parse(result) : [];
}

export function syntheticBoardId(title: string): string {
  if (!title.startsWith('QA ')) throw new Error('only test-owned board titles may be resolved');
  const escaped = title.replaceAll("'", "''");
  const rows = syntheticRows(`select id from boards where title='${escaped}' and deleted_at is null`) as { id: string }[];
  if (rows.length !== 1) throw new Error(`expected one synthetic board, found ${rows.length}`);
  return rows[0].id;
}

export function syntheticQuickControl(title: string): string {
  const id = syntheticBoardId(title);
  const boards = syntheticRows('select id from boards where deleted_at is null and archived_at is null order by order_key, id') as { id: string }[];
  const index = boards.findIndex(board => board.id === id);
  if (index < 0) throw new Error('test-owned board is not active');
  return `board-card-${index}-quick`;
}
