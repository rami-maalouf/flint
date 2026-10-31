import { createHash } from 'node:crypto';

import type { SqlExecutor } from '../../../../src/core/persistence/database';
import { readRawRow } from '../../../../src/core/persistence/repositories/support';
import { readUniquePeriodAlias } from '../../../../src/core/persistence/repositories/sync-periods';
import { periodEntityId, SETTINGS_ENTITY_ID } from '../../../../src/core/sync/records';
import { schema2SpecFor, toSchema2SyncRecord } from '../../../../src/core/sync/schema-2-records';
import { captureSyncPage } from '../../../../src/core/sync/sync-page';
import type { WireSyncEntityType, WireSyncRecord } from '../../../../src/core/sync/transport';

export const MAX_OPERATION_TUPLES = 4096;
export const MAX_OPERATION_BYTES = 16 * 1024 * 1024;
export type UploadAcceptance = { record: WireSyncRecord; digest: string;
  disposition: 'accepted' | 'superseded'; remoteMutationStamp: string };
export type CapturedTuple = { outboxId: number; record: WireSyncRecord; payloadHash: string; digest: string;
  disposition: UploadAcceptance['disposition'] | null; remoteMutationStamp: string | null };

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// original requests have no derived defaults. reject values json would silently erase.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Expected finite JSON input.');
}

// keep both the complete payload hash and the pinned transport's multipart digest.
export function wireIdentity(value: WireSyncRecord) {
  const record = captureSyncPage({ records: [value], nextToken: null, more: false }, null).records[0];
  const payload = JSON.stringify(record);
  const parts: string[] = [];
  let part: string[] = [];
  for (const scalar of payload) {
    part.push(scalar);
    if (part.length === 8192) { parts.push(part.join('')); part = []; }
  }
  if (part.length) parts.push(part.join(''));
  const digest = parts.length === 1 ? sha256(payload) : parts.reduce((hash, piece) => sha256(hash + sha256(piece)), '');
  return { record, payload, payloadHash: sha256(payload), digest };
}

export async function maxOutboxId(tx: SqlExecutor): Promise<number> {
  const row = await tx.getFirstAsync<{ id: number }>('SELECT coalesce(max(id), 0) AS id FROM mutation_outbox');
  if (!row || !Number.isSafeInteger(row.id) || row.id < 0) throw new Error('Invalid outbox baseline.');
  return row.id;
}

// the account lane must not run later commands, reconciliation or sync before capture.
export async function captureNewTuples(tx: SqlExecutor, baseline: number): Promise<CapturedTuple[]> {
  const rows = await tx.getAllAsync<{ id: number; entity_type: WireSyncEntityType; entity_id: string; mutation_stamp: string }>(
    'SELECT id, entity_type, entity_id, mutation_stamp FROM mutation_outbox WHERE id > ? ORDER BY id LIMIT ?',
    [baseline, MAX_OPERATION_TUPLES + 1],
  );
  if (rows.length > MAX_OPERATION_TUPLES) throw new Error('Operation tuple bound exceeded; recovery required.');
  const tuples: CapturedTuple[] = [];
  let bytes = 0;
  for (const row of rows) {
    const spec = schema2SpecFor(row.entity_type);
    if (!spec) throw new Error('Unsupported operation outbox entity.');
    const raw = await readRawRow(tx, spec.table, spec.idColumn, row.entity_type === 'settings' ? '1' : row.entity_id);
    if (!raw) throw new Error('Operation evidence is missing; recovery required.');
    const stamp = row.entity_type === 'settings' ? raw.settings_mutation_stamp : raw.mutation_stamp;
    if (stamp !== row.mutation_stamp) throw new Error('Operation evidence changed before capture; recovery required.');
    const entityId = row.entity_type === 'activity_period' ? periodEntityId(String(raw.board_id), String(raw.start_date))
      : row.entity_type === 'settings' ? SETTINGS_ENTITY_ID : row.entity_id;
    if (row.entity_type === 'activity_period') await readUniquePeriodAlias(tx, String(raw.board_id), String(raw.start_date));
    const identity = wireIdentity(toSchema2SyncRecord(row.entity_type, entityId, stamp, raw));
    bytes += Buffer.byteLength(identity.payload);
    if (bytes > MAX_OPERATION_BYTES) throw new Error('Operation evidence byte bound exceeded; recovery required.');
    tuples.push({ outboxId: row.id, record: identity.record, payloadHash: identity.payloadHash, digest: identity.digest,
      disposition: null, remoteMutationStamp: null });
  }
  return tuples;
}
