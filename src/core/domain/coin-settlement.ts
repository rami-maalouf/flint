import type { SqlExecutor } from '../persistence/database';
import { readBoardPolicyScopes } from '../persistence/repositories/board-policy-evidence';
import { readAffectedBonusEvidence } from '../persistence/repositories/bonus-evidence';
import { appendLedgerEntry } from '../persistence/repositories/ledger';
import { appendOutbox } from '../persistence/repositories/support';
import type { CoinLedgerRow } from './coin-ledger';
import { reconcileCheckCoins } from './coin-reconciliation';
import type { CheckCoinScope } from './coins';
import type { CommandContext, CommandDeps } from './command-context';
import { reconcileBonusCoins } from './bonus-reconciliation';
import type { BonusCoinScope } from './bonus-coin-causes';
import type { HabitAction } from './habit-actions';

// callers own the transaction and validate the economic cause before appending.
export async function appendLocalLedgerEntry(tx: SqlExecutor, row: CoinLedgerRow, now: number): Promise<boolean> {
  const inserted = await appendLedgerEntry(tx, row);
  if (inserted) await appendOutbox(tx, 'ledger_entry', row.id, row.mutationStamp, now);
  return inserted;
}

// every source fact is present before settlement; all effects share the caller's transaction.
export async function settleAffectedCoinScopes(
  deps: Pick<CommandDeps, 'hashing'>,
  context: Pick<CommandContext, 'tx' | 'now'>,
  input: { checkScopes: readonly CheckCoinScope[]; rootScopes?: readonly BonusCoinScope[] },
): Promise<void> {
  const scopes = new Map(input.checkScopes.map(({ boardId, logicalDate }) =>
    [`check:${boardId}:${logicalDate}`, { boardId, logicalDate }]));
  const groups = await readAffectedBonusEvidence(context.tx, deps.hashing, { checkScopes: [...scopes.values()], rootScopes: input.rootScopes });
  if (scopes.size > 0) {
    const evidence = await readBoardPolicyScopes(context.tx, [...scopes.values()]);
    const actions = new Map<string, HabitAction[]>();
    const rows = new Map<string, CoinLedgerRow[]>();
    for (const action of evidence.actions) {
      const key = `check:${action.boardId}:${action.logicalDate}`;
      const group = actions.get(key) ?? []; group.push(action); actions.set(key, group);
    }
    for (const row of evidence.rows) {
      const group = rows.get(row.scopeKey!) ?? []; group.push(row); rows.set(row.scopeKey!, group);
    }
    for (const [key, scope] of scopes) {
      const result = await reconcileCheckCoins(scope, actions.get(key) ?? [], rows.get(key) ?? [], deps.hashing);
      for (const row of result.appendedRows) await appendLocalLedgerEntry(context.tx, row, context.now);
    }
  }
  for (const group of groups) {
    const result = await reconcileBonusCoins(group.scope, group.actions, group.rows, deps.hashing);
    for (const row of result.appendedRows) await appendLocalLedgerEntry(context.tx, row, context.now);
  }
}
