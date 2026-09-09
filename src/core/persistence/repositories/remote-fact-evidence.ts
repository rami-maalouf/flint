import { isValidLogicalDate } from '../../calendar/logical-date';
import { assertCoinLedgerShape, type CoinLedgerRow } from '../../domain/coin-ledger';
import { CoinContractError } from '../../domain/coin-policy';
import { validateHabitAction, type HabitAction } from '../../domain/habit-actions';
import { isUuidV4, isUuidV5, type BoardId, type LogicalDate } from '../../domain/ids';
import { RemoteFactAdmissionError, type CanonicalRemoteFact, type RemoteFactIdentity } from '../../domain/remote-fact-validation';
import type { SqlExecutor, SqlValue } from '../database';

export type RemoteCheckScope = { boardId: BoardId; logicalDate: LogicalDate };
export type RemoteRootScope = { rootId: BoardId; logicalDate: LogicalDate };
export type RemoteEvidenceSelection = {
  checkScopes?: readonly RemoteCheckScope[];
  rootScopes?: readonly RemoteRootScope[];
  reverseScopes?: readonly RemoteCheckScope[];
  after?: RemoteFactIdentity;
  limit?: number;
};
export type RemoteEvidencePage = { facts: CanonicalRemoteFact[]; nextCursor: RemoteFactIdentity | null };
const BATCH_SIZE = 64;
const actionColumns = `a.id, a.command_id AS commandId, a.board_id AS boardId,
  a.logical_date AS logicalDate, a.check_in_id AS checkInId, a.kind,
  a.created_at AS createdAt, a.mutation_stamp AS mutationStamp, a.policy_json AS policyJson`;
const ledgerColumns = `l.id, l.kind, l.delta, l.board_id AS boardId, l.check_in_id AS checkInId,
  l.run_key AS runKey, l.reward_id AS rewardId, l.reward_title_snapshot AS rewardTitleSnapshot,
  l.reverses_id AS reversesId, l.scope_key AS scopeKey, l.source_action_id AS sourceActionId,
  l.reconciliation_key AS reconciliationKey, l.adjusts_id AS adjustsId,
  l.provenance_json AS provenanceJson, l.logical_date AS logicalDate,
  l.created_at AS createdAt, l.mutation_stamp AS mutationStamp, l.deleted_at AS deletedAt`;
const key = (identity: RemoteFactIdentity) => `${identity.factType}|${identity.factId}`;
// identities are unique before sorting, so there is no equal-key branch.
const compare = (a: RemoteFactIdentity, b: RemoteFactIdentity) => key(a) < key(b) ? -1 : 1;

function snapshotIdentity(input: RemoteFactIdentity): RemoteFactIdentity {
  const { factType, factId } = input;
  if (!['habit_action', 'ledger_entry'].includes(factType) || typeof factId !== 'string' ||
    !(isUuidV4(factId) || isUuidV5(factId))) throw new RemoteFactAdmissionError('envelope');
  return { factType, factId };
}

function snapshotScopes(input: readonly { boardId?: BoardId; rootId?: BoardId; logicalDate: LogicalDate }[], field: 'boardId' | 'rootId') {
  const scopes = new Map<string, { id: string; logicalDate: LogicalDate }>();
  for (const scope of input) {
    const id = scope[field]; const logicalDate = scope.logicalDate;
    if (typeof id !== 'string' || !isUuidV4(id) || typeof logicalDate !== 'string' || !isValidLogicalDate(logicalDate)) {
      throw new RemoteFactAdmissionError('envelope');
    }
    scopes.set(`${id}|${logicalDate}`, { id, logicalDate });
  }
  return [...scopes.values()];
}

// shape defects in accepted storage are operation failures, never candidate decisions.
function checkedFact(fact: CanonicalRemoteFact): CanonicalRemoteFact {
  try {
    if (fact.factType === 'habit_action') {
      if (!validateHabitAction(fact.value).ok || Object.is(fact.value.createdAt, -0)) {
        throw new RemoteFactAdmissionError('integrity');
      }
    } else assertCoinLedgerShape(fact.value);
  } catch (cause) {
    if (cause instanceof CoinContractError) throw new RemoteFactAdmissionError('integrity');
    throw cause;
  }
  return fact;
}

async function hydrate(tx: SqlExecutor, identities: readonly RemoteFactIdentity[]) {
  const found = new Map<string, CanonicalRemoteFact>();
  const actions = identities.filter(item => item.factType === 'habit_action').map(item => item.factId);
  const rows = identities.filter(item => item.factType === 'ledger_entry').map(item => item.factId);
  if (actions.length > 0) {
    for (const value of await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
      WHERE a.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(actions)])) {
      found.set(key({ factType: 'habit_action', factId: value.id }), checkedFact({ factType: 'habit_action', value }));
    }
  }
  if (rows.length > 0) {
    for (const value of await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
      WHERE l.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(rows)])) {
      found.set(key({ factType: 'ledger_entry', factId: value.id }), checkedFact({ factType: 'ledger_entry', value }));
    }
  }
  const facts: CanonicalRemoteFact[] = []; const missing: RemoteFactIdentity[] = [];
  for (const identity of identities) {
    const fact = found.get(key(identity));
    if (fact === undefined) missing.push(identity); else facts.push(fact);
  }
  return { facts, missing };
}

// callers chunk visited dependency frontiers; wrong-role rows remain present knowledge.
export async function readRemoteFactsById(tx: SqlExecutor, input: readonly RemoteFactIdentity[]) {
  const unique = new Map<string, RemoteFactIdentity>();
  for (const item of input) { const identity = snapshotIdentity(item); unique.set(key(identity), identity); }
  if (unique.size > BATCH_SIZE) throw new RemoteFactAdmissionError('envelope');
  return hydrate(tx, [...unique.values()].sort(compare));
}

// finish all pages with the same selection in one caller-owned snapshot before deriving E.
export async function readRemoteFactEvidencePage(tx: SqlExecutor, input: RemoteEvidenceSelection): Promise<RemoteEvidencePage> {
  const checks = snapshotScopes(input.checkScopes ?? [], 'boardId');
  const roots = snapshotScopes(input.rootScopes ?? [], 'rootId');
  const reverse = snapshotScopes(input.reverseScopes ?? [], 'boardId');
  const after = input.after === undefined ? undefined : snapshotIdentity(input.after);
  const limit = input.limit === undefined ? 32 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > BATCH_SIZE) throw new RemoteFactAdmissionError('envelope');
  const selections: string[] = []; const params: SqlValue[] = [];
  if (checks.length > 0) {
    const pairs = JSON.stringify(checks);
    selections.push(`SELECT 'habit_action' AS factType, a.id AS factId FROM json_each(?) pairs JOIN habit_actions a
      ON a.board_id = json_extract(pairs.value, '$.id') AND a.logical_date = json_extract(pairs.value, '$.logicalDate')`);
    selections.push(`SELECT 'ledger_entry' AS factType, l.id AS factId FROM json_each(?) pairs JOIN coin_ledger l
      ON l.scope_key = 'check:' || json_extract(pairs.value, '$.id') || ':' || json_extract(pairs.value, '$.logicalDate')`);
    params.push(pairs, pairs);
  }
  if (roots.length > 0) {
    const pairs = JSON.stringify(roots);
    selections.push(`SELECT 'habit_action' AS factType, a.id AS factId FROM json_each(?) pairs JOIN habit_actions a
      ON a.board_id = json_extract(pairs.value, '$.id') AND a.logical_date = json_extract(pairs.value, '$.logicalDate')`);
    selections.push(`SELECT 'habit_action' AS factType, a.id AS factId FROM habit_actions a
      WHERE a.logical_date IN (SELECT DISTINCT json_extract(value, '$.logicalDate') FROM json_each(?))
      AND a.policy_json IS NOT NULL AND CASE WHEN json_valid(a.policy_json) = 0 THEN 1
        ELSE (a.logical_date, json_extract(a.policy_json, '$.rootId')) IN
          (SELECT json_extract(value, '$.logicalDate'), json_extract(value, '$.id') FROM json_each(?)) END`);
    selections.push(`SELECT 'ledger_entry' AS factType, l.id AS factId FROM json_each(?) pairs JOIN coin_ledger l
      ON l.scope_key = 'bonus:' || json_extract(pairs.value, '$.id') || ':' || json_extract(pairs.value, '$.logicalDate')`);
    params.push(pairs, pairs, pairs, pairs);
  }
  if (reverse.length > 0) {
    const pairs = JSON.stringify(reverse);
    selections.push(`SELECT 'habit_action' AS factType, a.id AS factId FROM habit_actions a
      WHERE a.logical_date IN (SELECT json_extract(value, '$.logicalDate') FROM json_each(?))
      AND a.kind IN ('check','uncheck','move_out','move_in','policy') AND a.policy_json IS NOT NULL AND CASE
        WHEN json_valid(a.policy_json) = 0 THEN 1
        WHEN json_type(a.policy_json, '$.requiredBoardIds') IS NOT 'array' THEN 1
        ELSE EXISTS (SELECT 1 FROM json_each(a.policy_json, '$.requiredBoardIds') members
          WHERE (a.logical_date, members.value) IN
            (SELECT json_extract(value, '$.logicalDate'), json_extract(value, '$.id') FROM json_each(?))) END`);
    selections.push(`SELECT 'ledger_entry' AS factType, l.id AS factId FROM coin_ledger l
      WHERE l.logical_date IN (SELECT json_extract(value, '$.logicalDate') FROM json_each(?))
      AND l.scope_key LIKE 'bonus:%' AND (EXISTS (SELECT 1 FROM habit_actions a
        WHERE a.id = l.source_action_id AND a.logical_date = l.logical_date AND (a.board_id, a.logical_date) IN
          (SELECT json_extract(value, '$.id'), json_extract(value, '$.logicalDate') FROM json_each(?))) OR
        (l.provenance_json IS NOT NULL AND CASE WHEN json_valid(l.provenance_json) = 0 THEN 1
          WHEN json_type(l.provenance_json, '$.facts') IS NOT 'array' THEN 1
          ELSE EXISTS (SELECT 1 FROM json_each(l.provenance_json, '$.facts') facts
            WHERE json_extract(facts.value, '$[0]') = 'habit_action' AND EXISTS (SELECT 1 FROM habit_actions a
              WHERE a.id = json_extract(facts.value, '$[1]') AND a.logical_date = l.logical_date AND (a.board_id, a.logical_date) IN
                (SELECT json_extract(value, '$.id'), json_extract(value, '$.logicalDate') FROM json_each(?)))) END))`);
    params.push(pairs, pairs, pairs, pairs, pairs);
  }
  if (selections.length === 0) return { facts: [], nextCursor: null };
  const cursor = after === undefined ? '' : 'WHERE (factType COLLATE BINARY, factId COLLATE BINARY) > (?, ?)';
  if (after !== undefined) params.push(after.factType, after.factId);
  params.push(limit + 1);
  const keys = await tx.getAllAsync<RemoteFactIdentity>(`WITH selected AS (${selections.join(' UNION ')})
    SELECT factType, factId FROM selected ${cursor} ORDER BY factType COLLATE BINARY, factId COLLATE BINARY LIMIT ?`, params);
  const visible = keys.slice(0, limit);
  const { facts, missing } = await hydrate(tx, visible);
  if (missing.length > 0) throw new RemoteFactAdmissionError('integrity');
  return { facts, nextCursor: keys.length > limit ? visible[visible.length - 1] : null };
}
