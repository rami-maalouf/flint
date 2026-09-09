import { bonusAwardRow, bonusReversalRow, type BonusCoinScope } from './bonus-coin-causes';
import { compareBonusActions } from './bonus-evidence';
import { canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { CoinContractError, parseCoinPolicy, type CoinPolicy } from './coin-policy';
import type { HabitAction } from './habit-actions';
import type { Hashing } from './ports';

type RecoveredAward = { source: HabitAction; policy: CoinPolicy };
type SourceCandidates = { source: HabitAction; addedBoards: Set<string>;
  candidates: Map<string, { policy: CoinPolicy; expected: CoinLedgerRow }> };

// classify sequentially in one captured context; each proof subset/replan gets a new factory.
export function prepareBonusOrdinaryValidator(inputScope: BonusCoinScope, inputActions: readonly HabitAction[], hashing: Hashing) {
  const scope = { ...inputScope };
  const actions = inputActions.map(action => Object.freeze({ ...action }));
  const byAction = new Map(actions.map(action => [action.id, action]));
  const sources = new Map<string, SourceCandidates>();
  // each declared proof gets its own cache; candidates cannot leak across evidence subsets.
  async function recoverAward(row: CoinLedgerRow): Promise<RecoveredAward> {
    let prepared = sources.get(row.sourceActionId!);
    if (!prepared) {
      const source = byAction.get(row.sourceActionId!);
      if (!source) throw new CoinContractError('missing');
      if (source.kind !== 'check' || source.policyJson === null) throw new CoinContractError('invalid');
      const policies: CoinPolicy[] = [];
      for (const action of actions) {
        if (action.kind !== 'policy' || action.boardId !== scope.rootId || action.policyJson === null ||
          compareBonusActions(action, source) > 0) continue;
        const policy = parseCoinPolicy(action.policyJson);
        if (policy.rootId === scope.rootId) policies.push(policy);
      }
      const observed = parseCoinPolicy(source.policyJson);
      if (observed.rootId === scope.rootId) policies.push(observed);
      const unique = new Map(policies.map(policy => [JSON.stringify([policy.rootId, policy.requiredBoardIds,
        policy.bonusClosesAtUtc, policy.bonusEnabled]), policy]));
      const candidates: SourceCandidates['candidates'] = new Map();
      for (const policy of unique.values()) {
        const expected = await bonusAwardRow(scope, source, policy, hashing);
        candidates.set(expected.id, { policy, expected });
      }
      const addedBoards = new Set(actions.filter(action => ['baseline', 'check', 'move_in'].includes(action.kind) &&
        compareBonusActions(action, source) <= 0).map(action => action.boardId));
      prepared = { source, addedBoards, candidates };
      sources.set(source.id, prepared);
    }
    const match = prepared.candidates.get(row.id);
    if (!match) throw new CoinContractError('missing');
    const { policy, expected } = match;
    if (!policy.bonusEnabled || !policy.requiredBoardIds.includes(prepared.source.boardId) ||
      canonicalCoinLedger(expected) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
    if (policy.requiredBoardIds.some(boardId => !prepared.addedBoards.has(boardId))) throw new CoinContractError('missing');
    return { source: prepared.source, policy };
  }

  return async (inputRows: readonly CoinLedgerRow[]): Promise<void> => {
    const rows = inputRows.map(row => Object.freeze({ ...row }));
    // intrinsic causes remain valid even when full-union replay changes entitlement.
    const awards = new Map<string, RecoveredAward>();
    const saved = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) if (row.kind === 'run_bonus') awards.set(row.id, await recoverAward(row));
    for (const row of rows) {
      if (row.kind === 'run_bonus') continue;
      const original = saved.get(row.reversesId!);
      if (!original) throw new CoinContractError('missing');
      const held = awards.get(original.id);
      if (!held) throw new CoinContractError('invalid');
      const cause = byAction.get(row.sourceActionId!);
      if (!cause) throw new CoinContractError('missing');
      if (!['uncheck', 'move_out'].includes(cause.kind) || !held.policy.requiredBoardIds.includes(cause.boardId) ||
        compareBonusActions(cause, held.source) <= 0 || cause.createdAt >= held.policy.bonusClosesAtUtc!) throw new CoinContractError('invalid');
      if (cause.checkInId !== null && !actions.some(action => action.boardId === cause.boardId &&
        action.checkInId === cause.checkInId && ['baseline', 'check', 'move_in'].includes(action.kind) &&
        compareBonusActions(action, cause) < 0)) throw new CoinContractError('missing');
      if (canonicalCoinLedger(row) !== canonicalCoinLedger(await bonusReversalRow(cause, original, hashing))) throw new CoinContractError('invalid');
    }
  };
}

export async function validateBonusOrdinary(scope: BonusCoinScope, actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], hashing: Hashing): Promise<void> {
  await prepareBonusOrdinaryValidator(scope, actions, hashing)(rows);
}
