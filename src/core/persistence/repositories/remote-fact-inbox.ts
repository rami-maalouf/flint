import { RemoteFactAdmissionError, type PreparedRemoteFact, type RemoteFactIdentity } from '../../domain/remote-fact-validation';
import type { SqlExecutor } from '../database';

export const REMOTE_FACT_INBOX_VARIANTS = 32768;
export const REMOTE_FACT_INBOX_BYTES = 67108864;
export type RemoteFactInboxDisposition =
  | { state: 'pending'; reason: 'dependency' }
  | { state: 'blocked_capacity'; reason: 'scope_capacity' }
  | { state: 'quarantined'; reason: 'invalid' | 'conflict' };
export type RemoteFactInboxKey = RemoteFactIdentity & { payloadDigest: string };
export type RemoteFactInboxVariant = Omit<PreparedRemoteFact, 'fact'> & RemoteFactInboxDisposition & { firstSeenAt: number };
export type RemoteFactInboxCounts = { variants: number; payloadBytes: number; pending: number; blocked: number; quarantined: number };
type StoredVariant = Omit<RemoteFactInboxVariant, 'enqueueOnAdmission'> & { enqueueOnAdmission: number };

const columns = `fact_type AS factType, fact_id AS factId, payload_digest AS payloadDigest,
  payload_encoding AS payloadEncoding, payload, payload_bytes AS payloadBytes,
  logical_date AS logicalDate, scope_key AS scopeKey, state, reason,
  enqueue_on_admission AS enqueueOnAdmission, first_seen_at AS firstSeenAt`;
const identityKey = (value: RemoteFactInboxKey) => JSON.stringify([value.factType, value.factId, value.payloadDigest]);

// omitted identities selects retryable work; explicit identities include all their variants.
export async function readRemoteFactInbox(tx: SqlExecutor, identities?: readonly RemoteFactIdentity[]): Promise<RemoteFactInboxVariant[]> {
  if (identities?.length === 0) return [];
  const selected = identities && [...new Map(identities.map(({ factType, factId }) =>
    [JSON.stringify([factType, factId]), { factType, factId }])).values()];
  const rows = await tx.getAllAsync<StoredVariant>(`SELECT ${columns} FROM remote_fact_inbox
    WHERE ${identities ? `(fact_type, fact_id) IN (SELECT json_extract(value, '$.factType'),
      json_extract(value, '$.factId') FROM json_each(?))` : "state IN ('pending', 'blocked_capacity')"}
    ORDER BY logical_date, fact_type, fact_id COLLATE BINARY, payload_digest`, selected ? [JSON.stringify(selected)] : []);
  return rows.map(row => ({ ...row, enqueueOnAdmission: row.enqueueOnAdmission === 1 }) as RemoteFactInboxVariant);
}

export async function readRemoteFactInboxCounts(tx: SqlExecutor): Promise<RemoteFactInboxCounts> {
  const row = (await tx.getFirstAsync<Record<keyof RemoteFactInboxCounts, string>>(`SELECT
    CAST(COUNT(*) AS TEXT) AS variants,
    CAST(COALESCE(SUM(payload_bytes), 0) AS TEXT) AS payloadBytes,
    CAST(COALESCE(SUM(state = 'pending'), 0) AS TEXT) AS pending,
    CAST(COALESCE(SUM(state = 'blocked_capacity'), 0) AS TEXT) AS blocked,
    CAST(COALESCE(SUM(state = 'quarantined'), 0) AS TEXT) AS quarantined FROM remote_fact_inbox`))!;
  const counts = {} as RemoteFactInboxCounts;
  for (const key of ['variants', 'payloadBytes', 'pending', 'blocked', 'quarantined'] as const) {
    const value = Number(row[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new RemoteFactAdmissionError('integrity');
    counts[key] = value;
  }
  return counts;
}

function samePayload(left: RemoteFactInboxVariant, right: Omit<PreparedRemoteFact, 'fact'>) {
  if (left.payload !== right.payload || left.payloadEncoding !== right.payloadEncoding ||
    left.payloadBytes !== right.payloadBytes || left.logicalDate !== right.logicalDate || left.scopeKey !== right.scopeKey) {
    throw new RemoteFactAdmissionError('integrity');
  }
}

function adjustCounts(counts: RemoteFactInboxCounts, row: RemoteFactInboxVariant, direction: 1 | -1) {
  counts.variants += direction;
  counts.payloadBytes += direction * row.payloadBytes;
  const state = row.state === 'blocked_capacity' ? 'blocked' : row.state;
  counts[state] += direction;
}

// the caller holds an exclusive transaction; capacity is checked against the complete final plan.
export async function applyRemoteFactInboxChanges(tx: SqlExecutor, changes: {
  upserts: readonly { prepared: PreparedRemoteFact; disposition: RemoteFactInboxDisposition }[];
  removals: readonly RemoteFactInboxKey[];
}, acquiredNow: number): Promise<{ localChanged: boolean; counts: RemoteFactInboxCounts }> {
  if (!Number.isSafeInteger(acquiredNow) || acquiredNow < 0 || Object.is(acquiredNow, -0)) {
    throw new RemoteFactAdmissionError('envelope');
  }
  const counts = await readRemoteFactInboxCounts(tx);
  const identities = [...new Map([...changes.removals, ...changes.upserts.map(item => item.prepared)]
    .map(({ factType, factId }) => [JSON.stringify([factType, factId]), { factType, factId }])).values()];
  const existing = new Map((await readRemoteFactInbox(tx, identities)).map(row => [identityKey(row), row]));
  const planned = new Map<string, RemoteFactInboxVariant | null>();
  for (const removal of changes.removals) planned.set(identityKey(removal), null);
  for (const { prepared, disposition } of changes.upserts) {
    if (prepared.payloadEncoding === 'rejected_json_v1' &&
      (disposition.state !== 'quarantined' || disposition.reason !== 'invalid')) {
      throw new RemoteFactAdmissionError('integrity');
    }
    const key = identityKey(prepared);
    const previous = existing.get(key);
    const pending = planned.get(key);
    if (previous) samePayload(previous, prepared);
    if (pending) samePayload(pending, prepared);
    const { fact: _fact, ...stored } = prepared;
    planned.set(key, { ...stored, ...disposition, firstSeenAt: previous?.firstSeenAt ?? acquiredNow,
      enqueueOnAdmission: prepared.enqueueOnAdmission || previous?.enqueueOnAdmission === true || pending?.enqueueOnAdmission === true });
  }
  for (const [key, next] of planned) {
    const previous = existing.get(key);
    if (previous) adjustCounts(counts, previous, -1);
    if (next) adjustCounts(counts, next, 1);
  }
  if (counts.variants > REMOTE_FACT_INBOX_VARIANTS || counts.payloadBytes > REMOTE_FACT_INBOX_BYTES) {
    throw new RemoteFactAdmissionError('capacity');
  }
  let localChanged = false;
  for (const [key, next] of planned) {
    const previous = existing.get(key);
    if (next === null) {
      if (previous) {
        await tx.runAsync('DELETE FROM remote_fact_inbox WHERE fact_type = ? AND fact_id = ? AND payload_digest = ?',
          [previous.factType, previous.factId, previous.payloadDigest]);
        localChanged = true;
      }
    } else if (!previous) {
      await tx.runAsync(`INSERT INTO remote_fact_inbox (fact_type, fact_id, payload_digest, payload_encoding,
        payload, payload_bytes, logical_date, scope_key, state, reason, enqueue_on_admission, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [next.factType, next.factId, next.payloadDigest,
        next.payloadEncoding, next.payload, next.payloadBytes, next.logicalDate, next.scopeKey,
        next.state, next.reason, Number(next.enqueueOnAdmission), next.firstSeenAt]);
      localChanged = true;
    } else if (previous.state !== next.state || previous.reason !== next.reason || previous.enqueueOnAdmission !== next.enqueueOnAdmission) {
      await tx.runAsync(`UPDATE remote_fact_inbox SET state = ?, reason = ?, enqueue_on_admission = ?
        WHERE fact_type = ? AND fact_id = ? AND payload_digest = ?`, [next.state, next.reason,
        Number(next.enqueueOnAdmission), next.factType, next.factId, next.payloadDigest]);
      localChanged = true;
    }
  }
  return { localChanged, counts };
}
