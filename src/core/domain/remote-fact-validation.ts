import { isValidLogicalDate } from '../calendar/logical-date';
import { assertCoinLedgerShape, canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { COIN_RECORD_BYTES, CoinContractError } from './coin-policy';
import { baselineAction, canonicalHabitAction, validateHabitAction, type HabitAction } from './habit-actions';
import { isUuidV4, isUuidV5, type CheckInId, type LogicalDate } from './ids';
import type { Hashing } from './ports';

export type RemoteFactType = 'habit_action' | 'ledger_entry';
export type RemoteFactIdentity = { factType: RemoteFactType; factId: string };
export type RemoteFactCandidate = RemoteFactIdentity & { value: unknown; enqueueOnAdmission: boolean };
export type CanonicalRemoteFact =
  | { factType: 'habit_action'; value: HabitAction }
  | { factType: 'ledger_entry'; value: CoinLedgerRow };
export type PreparedRemoteFact = RemoteFactIdentity & {
  payloadDigest: string;
  payloadEncoding: 'canonical_v1' | 'rejected_json_v1';
  payload: string;
  payloadBytes: number;
  logicalDate: LogicalDate | null;
  scopeKey: string | null;
  enqueueOnAdmission: boolean;
  fact: CanonicalRemoteFact | null;
};

// these errors must escape a receipt-writing transaction before domain mapping.
export class RemoteFactAdmissionError extends Error {
  constructor(readonly reason: 'envelope' | 'capacity' | 'integrity') {
    super(`Remote fact admission ${reason}.`);
  }
}

const actionFields = ['id', 'commandId', 'boardId', 'logicalDate', 'checkInId', 'kind',
  'createdAt', 'mutationStamp', 'policyJson'];

function snapshotJson(value: unknown): { payload: string; value: unknown; signedZero: boolean } {
  let payload: string;
  let signedZero = false;
  try {
    payload = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new RemoteFactAdmissionError('envelope');
      }
      if (Object.is(item, -0)) signedZero = true;
      return item;
    });
  } catch (cause) {
    if (cause instanceof TypeError) throw new RemoteFactAdmissionError('envelope');
    throw cause;
  }
  return { payload, value: JSON.parse(payload) as unknown, signedZero };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function selectors(factType: RemoteFactType, value: unknown) {
  const row = record(value);
  const logicalDate = typeof row?.logicalDate === 'string' && isValidLogicalDate(row.logicalDate)
    ? row.logicalDate as LogicalDate : null;
  let scopeKey: string | null = null;
  if (logicalDate !== null && row !== null) {
    if (factType === 'habit_action' && typeof row.boardId === 'string' && isUuidV4(row.boardId)) {
      scopeKey = `check:${row.boardId}:${logicalDate}`;
    } else if (factType === 'ledger_entry' && typeof row.scopeKey === 'string') {
      const parts = row.scopeKey.split(':');
      if (parts.length === 3 && ['check', 'bonus'].includes(parts[0]) &&
        isUuidV4(parts[1]) && parts[2] === logicalDate) scopeKey = row.scopeKey;
    }
  }
  return { logicalDate, scopeKey };
}

function validateShape(factType: RemoteFactType, factId: string, value: unknown): CanonicalRemoteFact | null {
  const row = record(value);
  if (row === null || row.id !== factId) return null;
  if (factType === 'habit_action') {
    if (Object.keys(row).length !== actionFields.length || actionFields.some(key => !(key in row))) return null;
    const action = row as HabitAction;
    const result = validateHabitAction(action);
    if (!result.ok && result.error.code === 'capacity') throw new RemoteFactAdmissionError('capacity');
    return result.ok ? { factType, value: action } : null;
  }
  try {
    return { factType, value: assertCoinLedgerShape(row) };
  } catch (cause) {
    if (cause instanceof CoinContractError && cause.reason === 'size') throw new RemoteFactAdmissionError('capacity');
    if (cause instanceof CoinContractError) return null;
    throw cause;
  }
}

export async function prepareRemoteFact(candidate: RemoteFactCandidate, hashing: Hashing): Promise<PreparedRemoteFact> {
  if (!candidate) throw new RemoteFactAdmissionError('envelope');
  const { factType, factId, enqueueOnAdmission, value } = candidate;
  if ((factType !== 'habit_action' && factType !== 'ledger_entry') ||
    typeof factId !== 'string' || !(isUuidV4(factId) || isUuidV5(factId)) ||
    typeof enqueueOnAdmission !== 'boolean') throw new RemoteFactAdmissionError('envelope');
  const snapshot = snapshotJson(value);
  let fact = snapshot.signedZero ? null : validateShape(factType, factId, snapshot.value);
  if (fact?.factType === 'habit_action' && fact.value.kind === 'baseline') {
    // hashing is outside shape catches: an unavailable port is never a rejected fact.
    const expected = await baselineAction({ id: fact.value.checkInId as CheckInId,
      boardId: fact.value.boardId, logicalDate: fact.value.logicalDate }, hashing);
    if (expected.id !== fact.value.id) fact = null;
  }
  const payload = fact === null ? snapshot.payload : fact.factType === 'habit_action'
    ? canonicalHabitAction(fact.value) : canonicalCoinLedger(fact.value);
  const payloadEncoding = fact === null ? 'rejected_json_v1' : 'canonical_v1';
  const payloadBytes = new TextEncoder().encode(payload).length;
  if (payloadBytes > COIN_RECORD_BYTES) throw new RemoteFactAdmissionError('capacity');
  const digestInput = fact === null
    ? JSON.stringify(['habit-remote-rejected-json-v1', factType, factId, payload]) : payload;
  const digest = await hashing.sha256(new TextEncoder().encode(digestInput));
  if (digest.length !== 32) throw new Error('SHA-256 must return 32 bytes.');
  return { factType, factId,
    payloadDigest: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    payloadEncoding, payload, payloadBytes, ...selectors(factType, snapshot.value), enqueueOnAdmission, fact };
}
