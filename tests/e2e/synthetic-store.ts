import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ownedSyntheticDevice } from '../../scripts/e2e/synthetic-device';

// reads only an explicitly opted-in synthetic simulator; never seeds or rewrites its store.
export function syntheticDatabase(): string {
  if (process.env.E2E_EAS_SIMULATOR === '1' || process.env.E2E_TARGET === 'device') throw new Error('synthetic filesystem checks require local simulator mode');
  const receipt = ownedSyntheticDevice();
  const device = receipt.device;
  const app = process.env.E2E_APP_ID ?? receipt.appId;
  if (app !== receipt.appId) throw new Error('synthetic acceptance requires the owned development identity');
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', device, app, 'data'], { encoding: 'utf8' }).trim();
  const fallback = join(data, 'Documents/SQLite/ripples.db');
  try {
    const group = execFileSync('xcrun', ['simctl', 'get_app_container', device, app, 'group.studio.orbitlabs.habitsystem'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const shared = join(group, 'ripples.db');
    if (existsSync(shared)) return shared;
  } catch { /* simulator builds without an app group use the documents store */ }
  if (!existsSync(fallback)) throw new Error('synthetic database has not been initialized');
  return fallback;
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
