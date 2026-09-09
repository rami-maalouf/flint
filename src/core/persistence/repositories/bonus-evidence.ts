import { isValidLogicalDate } from '../../calendar/logical-date';
import { assertCoinLedgerShape, canonicalCoinLedger, type CoinLedgerRow } from '../../domain/coin-ledger';
import { COIN_PROOF_FACTS, CoinContractError, parseCoinPolicy } from '../../domain/coin-policy';
import { coinDigest, compareCoinTuple, parseCoinProvenance } from '../../domain/coin-provenance';
import { canonicalHabitAction, validateHabitAction, type HabitAction } from '../../domain/habit-actions';
import { isUuidV4, type BoardId, type LogicalDate } from '../../domain/ids';
import type { Hashing } from '../../domain/ports';
import type { SqlExecutor } from '../database';

export type BonusEvidenceScope = { rootId: BoardId; logicalDate: LogicalDate };
type CheckScope = { boardId: BoardId; logicalDate: LogicalDate };
export type BonusEvidenceGroup = { scope: BonusEvidenceScope; actions: HabitAction[]; rows: CoinLedgerRow[];
 };
const actionColumns = `a.id, a.command_id AS commandId, a.board_id AS boardId,
  a.logical_date AS logicalDate, a.check_in_id AS checkInId, a.kind,
  a.created_at AS createdAt, a.mutation_stamp AS mutationStamp, a.policy_json AS policyJson`;
const ledgerColumns = `l.id, l.kind, l.delta, l.board_id AS boardId, l.check_in_id AS checkInId,
  l.run_key AS runKey, l.reward_id AS rewardId, l.reward_title_snapshot AS rewardTitleSnapshot,
  l.reverses_id AS reversesId, l.scope_key AS scopeKey, l.source_action_id AS sourceActionId,
  l.reconciliation_key AS reconciliationKey, l.adjusts_id AS adjustsId,
  l.provenance_json AS provenanceJson, l.logical_date AS logicalDate,
  l.created_at AS createdAt, l.mutation_stamp AS mutationStamp, l.deleted_at AS deletedAt`;
const key = (id: string, date: string) => `${id}|${date}`;
const scopeKey = (scope: BonusEvidenceScope) => `bonus:${scope.rootId}:${scope.logicalDate}`;
function validScope(id: BoardId, date: LogicalDate) {
  if (typeof id !== 'string' || !isUuidV4(id) || !isValidLogicalDate(date)) throw new CoinContractError('invalid');
}
function checkedAction(action: HabitAction) {
  const result = validateHabitAction(action);
  if (!result.ok) throw new CoinContractError(result.error.code === 'capacity' ? 'size' : 'invalid');
  if (Object.is(action.createdAt, -0)) throw new CoinContractError('invalid');
  return action;
}
function references(row: CoinLedgerRow) {
  const facts = row.provenanceJson === null ? [] : parseCoinProvenance(row.provenanceJson);
  return { facts,
    actions: [...new Set([row.sourceActionId, ...facts.filter(f => f[0] === 'habit_action').map(f => f[1])].filter(id => id !== null))],
    rows: [...new Set([row.reversesId, row.adjustsId, ...facts.filter(f => f[0] === 'ledger_entry').map(f => f[1])].filter(id => id !== null))] };
}

// caller owns the read snapshot; no clock, topology, or economic inference belongs here.
export async function readAffectedBonusEvidence(tx: SqlExecutor, hashing: Pick<Hashing, 'sha256'>,
  input: { checkScopes: readonly CheckScope[]; rootScopes?: readonly BonusEvidenceScope[] }): Promise<BonusEvidenceGroup[]> {
  const checks = new Map<string, CheckScope>();
  const scopes = new Map<string, BonusEvidenceScope>();
  function addScope(scope: BonusEvidenceScope) { validScope(scope.rootId, scope.logicalDate); scopes.set(scopeKey(scope), scope); }
  for (const scope of input.checkScopes) { validScope(scope.boardId, scope.logicalDate); checks.set(key(scope.boardId, scope.logicalDate), scope); }
  for (const scope of input.rootScopes ?? []) addScope(scope);
  if (checks.size === 0 && scopes.size === 0) return [];
  const actions = new Map<string, HabitAction>();
  const rows = new Map<string, CoinLedgerRow>();
  function saveActions(found: HabitAction[]) { for (const action of found) actions.set(action.id, checkedAction(action)); }
  function saveRows(found: CoinLedgerRow[]) { for (const row of found) rows.set(row.id, assertCoinLedgerShape(row)); }
  if (checks.size > 0) {
    const pairs = JSON.stringify([...checks.values()]);
    const selected = await tx.getAllAsync<HabitAction>(`SELECT DISTINCT ${actionColumns} FROM json_each(?) scopes JOIN habit_actions a
      ON a.board_id = json_extract(scopes.value, '$.boardId') AND a.logical_date = json_extract(scopes.value, '$.logicalDate')`, [pairs]);
    const reverse = await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
      WHERE a.logical_date IN (SELECT DISTINCT json_extract(value, '$.logicalDate') FROM json_each(?)) AND a.kind IN ('check','uncheck','move_out','move_in','policy') AND a.policy_json IS NOT NULL AND CASE
        WHEN json_valid(a.policy_json) = 0 THEN 1
        WHEN json_type(a.policy_json, '$.rootId') IS NOT 'text' AND json_type(a.policy_json, '$.rootId') IS NOT 'null' THEN 1
        WHEN json_type(a.policy_json, '$.requiredBoardIds') IS NOT 'array' THEN 1
        ELSE EXISTS (SELECT 1 FROM json_each(?) scopes JOIN json_each(a.policy_json, '$.requiredBoardIds') members
          ON members.value = json_extract(scopes.value, '$.boardId')
          WHERE a.logical_date = json_extract(scopes.value, '$.logicalDate')) END`, [pairs, pairs]);
    saveActions([...selected, ...reverse]);
    for (const action of actions.values()) {
      const rootId = action.policyJson === null ? null : parseCoinPolicy(action.policyJson).rootId;
      if (rootId !== null) addScope({ rootId: rootId as BoardId, logicalDate: action.logicalDate });
    }
    // a retained award can still identify its root when the changed source observed no root.
    const ids = JSON.stringify(selected.map(action => action.id));
    const retained = await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
      WHERE l.logical_date IN (SELECT json_extract(value, '$.logicalDate') FROM json_each(?))
      AND l.scope_key LIKE 'bonus:%' AND (l.source_action_id IN (SELECT value FROM json_each(?)) OR
        (l.provenance_json IS NOT NULL AND CASE WHEN json_valid(l.provenance_json) = 0 THEN 1
          WHEN json_type(l.provenance_json, '$.facts') IS NOT 'array' THEN 1
          ELSE EXISTS (SELECT 1 FROM json_each(l.provenance_json, '$.facts') facts
            WHERE json_extract(facts.value, '$[0]') = 'habit_action'
              AND json_extract(facts.value, '$[1]') IN (SELECT value FROM json_each(?))) END))`, [pairs, ids, ids]);
    saveRows(retained);
    for (const row of retained) addScope({ rootId: row.scopeKey!.split(':')[1] as BoardId, logicalDate: row.logicalDate });
  }
  if (scopes.size === 0) return [];
  const orderedScopes = [...scopes.values()].sort((a, b) => compareCoinTuple([a.rootId, a.logicalDate], [b.rootId, b.logicalDate]));
  saveActions(await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
    WHERE a.logical_date IN (SELECT DISTINCT json_extract(value, '$.logicalDate') FROM json_each(?))
    AND EXISTS (SELECT 1 FROM json_each(?) scopes WHERE a.logical_date = json_extract(scopes.value, '$.logicalDate')
      AND (a.board_id = json_extract(scopes.value, '$.rootId') OR (a.policy_json IS NOT NULL AND CASE
        WHEN json_valid(a.policy_json) = 0 THEN 1
        ELSE json_extract(a.policy_json, '$.rootId') = json_extract(scopes.value, '$.rootId') END)))`,
  [JSON.stringify(orderedScopes), JSON.stringify(orderedScopes)]));
  saveRows(await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
    WHERE l.scope_key IN (SELECT value FROM json_each(?))`, [JSON.stringify(orderedScopes.map(scopeKey))]));
  const refs = new Map<string, ReturnType<typeof references>>();
  let pending = [...rows.values()];
  while (pending.length > 0) {
    const actionIds = new Set<string>(); const rowIds = new Set<string>();
    for (const row of pending) {
      const ref = references(row); refs.set(row.id, ref);
      for (const id of ref.actions) if (!actions.has(id)) actionIds.add(id);
      for (const id of ref.rows) if (!rows.has(id)) rowIds.add(id);
    }
    if (actionIds.size > 0) {
      saveActions(await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
        WHERE a.id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...actionIds])]));
      if ([...actionIds].some(id => !actions.has(id))) throw new CoinContractError('missing');
    }
    pending = rowIds.size === 0 ? [] : await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
      WHERE l.id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...rowIds])]);
    saveRows(pending);
    if ([...rowIds].some(id => !rows.has(id))) throw new CoinContractError('missing');
  }
  const digestCache = new Map<string, string>();
  for (const row of rows.values()) {
    const ref = refs.get(row.id)!;
    for (const id of ref.actions) if (actions.get(id)!.logicalDate !== row.logicalDate) throw new CoinContractError('invalid');
    for (const id of ref.rows) if (rows.get(id)!.scopeKey !== row.scopeKey) throw new CoinContractError('invalid');
    if (row.reversesId !== null && rows.get(row.reversesId)!.kind !== 'run_bonus') throw new CoinContractError('invalid');
    if (row.adjustsId !== null && (rows.get(row.adjustsId)!.kind !== 'adjustment' || rows.get(row.adjustsId)!.adjustsId !== null)) throw new CoinContractError('invalid');
    for (const fact of ref.facts) {
      if (fact[0] === 'ledger_entry' && !['run_bonus', 'reversal'].includes(rows.get(fact[1])!.kind)) throw new CoinContractError('invalid');
      const id = JSON.stringify(fact.slice(0, 2)); let digest = digestCache.get(id);
      if (digest === undefined) {
        digest = await coinDigest(fact[0] === 'habit_action' ? canonicalHabitAction(actions.get(fact[1])!) : canonicalCoinLedger(rows.get(fact[1])!), hashing);
        digestCache.set(id, digest);
      }
      if (digest !== fact[2]) throw new CoinContractError('invalid');
    }
  }
  const observations = new Map<string, HabitAction[]>();
  for (const action of actions.values()) {
    if (action.policyJson === null) continue;
    const rootId = parseCoinPolicy(action.policyJson).rootId;
    if (rootId === null) continue;
    const observed = observations.get(key(rootId, action.logicalDate)) ?? [];
    observed.push(action);
    observations.set(key(rootId, action.logicalDate), observed);
  }
  const members = new Map<string, Set<BoardId>>();
  const pairs = new Map<string, CheckScope>();
  for (const scope of orderedScopes) {
    const ids = new Set<BoardId>([scope.rootId]);
    for (const action of observations.get(key(scope.rootId, scope.logicalDate)) ?? []) {
      ids.add(action.boardId);
      for (const id of parseCoinPolicy(action.policyJson!).requiredBoardIds) ids.add(id as BoardId);
    }
    members.set(scopeKey(scope), ids);
    for (const boardId of ids) pairs.set(key(boardId, scope.logicalDate), { boardId, logicalDate: scope.logicalDate });
  }
  saveActions(await tx.getAllAsync<HabitAction>(`SELECT DISTINCT ${actionColumns} FROM json_each(?) scopes JOIN habit_actions a
    ON a.board_id = json_extract(scopes.value, '$.boardId') AND a.logical_date = json_extract(scopes.value, '$.logicalDate')`, [JSON.stringify([...pairs.values()])]));
  const actionsByPair = new Map<string, HabitAction[]>();
  for (const action of actions.values()) {
    const pair = key(action.boardId, action.logicalDate);
    const group = actionsByPair.get(pair) ?? [];
    group.push(action);
    actionsByPair.set(pair, group);
  }
  const rowsByScope = new Map<string, CoinLedgerRow[]>();
  for (const row of rows.values()) {
    const group = rowsByScope.get(row.scopeKey!) ?? [];
    group.push(row);
    rowsByScope.set(row.scopeKey!, group);
  }
  return orderedScopes.map(scope => {
    const ids = members.get(scopeKey(scope))!;
    const groupRows = rowsByScope.get(scopeKey(scope)) ?? [];
    const groupActions = new Map<string, HabitAction>();
    for (const boardId of ids) {
      const pair = key(boardId, scope.logicalDate);
      for (const action of actionsByPair.get(pair) ?? []) groupActions.set(action.id, action);
    }
    // referenced causes remain available for missing-control recovery before scope validation.
    for (const row of groupRows) for (const id of refs.get(row.id)!.actions) groupActions.set(id, actions.get(id)!);
    if (groupActions.size + groupRows.filter(row => row.kind !== 'adjustment').length > COIN_PROOF_FACTS) throw new CoinContractError('size');
    return { scope, actions: [...groupActions.values()].sort((a, b) => Number(a.kind !== 'baseline') - Number(b.kind !== 'baseline') || compareCoinTuple([a.mutationStamp, a.id], [b.mutationStamp, b.id])),
      rows: groupRows.sort((a, b) => compareCoinTuple([a.mutationStamp, a.id], [b.mutationStamp, b.id])) };
  });
}
