import { reconcileCoinEvidence } from './coin-reconciliation-core';
import { canonicalCoinLedger, checkCoinRow } from './coin-ledger';
import type { CoinLedgerRow } from './coin-ledger';
import { CoinContractError, parseCoinPolicy } from './coin-policy';
import { compareCoinTuple } from './coin-provenance';
import { orderedCoinActions, replayCheckCoins } from './coins';
import type { CheckCoinScope } from './coins';
import type { HabitAction } from './habit-actions';
import type { Hashing } from './ports';

export async function validateCheckOrdinary(actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], hashing: Hashing) {
  const causes = new Map(actions.map((action) => [action.id, action]));
  const awards = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const cause = causes.get(row.sourceActionId!);
    if (!cause) throw new CoinContractError('missing');
    let expected: CoinLedgerRow;
    if (row.kind === 'check') {
      if (cause.kind !== 'check' || cause.policyJson === null || !parseCoinPolicy(cause.policyJson).earnsCoins) throw new CoinContractError('invalid');
      expected = await checkCoinRow(cause, hashing);
    } else {
      const award = awards.get(row.reversesId!);
      if (!award) throw new CoinContractError('missing');
      const source = causes.get(award.sourceActionId!);
      if (!source) throw new CoinContractError('missing');
      if (award.kind !== 'check' || !['uncheck', 'move_out'].includes(cause.kind) ||
        (cause.checkInId !== null && cause.checkInId !== award.checkInId) || source.policyJson === null ||
        cause.createdAt >= parseCoinPolicy(source.policyJson).checkClosesAtUtc ||
        compareCoinTuple([cause.mutationStamp, cause.id], [source.mutationStamp, source.id]) <= 0) throw new CoinContractError('invalid');
      expected = await checkCoinRow(cause, hashing, award);
    }
    if (canonicalCoinLedger(row) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  }
}

export async function reconcileCheckCoins(scope: CheckCoinScope, inputActions: readonly HabitAction[], inputRows: readonly CoinLedgerRow[], hashing: Hashing) {
  const actions = orderedCoinActions(scope, inputActions);
  return reconcileCoinEvidence({
    scopeKey: `check:${scope.boardId}:${scope.logicalDate}`, logicalDate: scope.logicalDate, awardKind: 'check',
    replay: evidence => replayCheckCoins(scope, evidence, hashing),
    validateOrdinary: (evidence, rows) => validateCheckOrdinary(evidence, rows, hashing),
  }, actions, inputRows, hashing);
}
