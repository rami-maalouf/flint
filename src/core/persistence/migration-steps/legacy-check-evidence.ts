import { isValidLogicalDate } from '../../calendar/logical-date';
import type { BonusCoinScope } from '../../domain/bonus-coin-causes';
import { CoinContractError } from '../../domain/coin-policy';
import { settleAffectedCoinScopes } from '../../domain/coin-settlement';
import type { CheckCoinScope } from '../../domain/coins';
import type { CheckIn } from '../../domain/entities';
import { isUuidV4, type BoardId, type LogicalDate } from '../../domain/ids';
import { establishLegacyCheckEvidence } from '../../domain/legacy-check-evidence';
import type { Hashing } from '../../domain/ports';
import type { SqlExecutor } from '../database';
import { refreshCheckVisibility } from '../repositories/check-visibility';

// executed only by the named schema step while its migration transaction is held.
export async function migrateLegacyCheckEvidence(tx: SqlExecutor, hashing: Hashing, now: number): Promise<void> {
  const checks = await tx.getAllAsync<Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>>(
    `SELECT id, board_id AS boardId, logical_date AS logicalDate FROM check_ins
     WHERE deleted_at IS NULL ORDER BY board_id, logical_date, id`);
  const { actions } = await establishLegacyCheckEvidence({ tx, hashing, now }, checks);
  const checkScopes = new Map<string, CheckCoinScope>(actions.map(({ boardId, logicalDate }) =>
    [`check:${boardId}:${logicalDate}`, { boardId, logicalDate }]));
  const rootScopes: BonusCoinScope[] = [];
  const existing = await tx.getAllAsync<{ scopeKey: string; logicalDate: LogicalDate }>(
    `SELECT DISTINCT scope_key AS scopeKey, logical_date AS logicalDate FROM coin_ledger
     WHERE scope_key IS NOT NULL ORDER BY scope_key, logical_date`);
  for (const { scopeKey, logicalDate } of existing) {
    const [kind, owner] = scopeKey.split(':');
    if (!['check', 'bonus'].includes(kind) || !isUuidV4(owner) || !isValidLogicalDate(logicalDate) ||
      scopeKey !== `${kind}:${owner}:${logicalDate}`) throw new CoinContractError('invalid');
    if (kind === 'check') checkScopes.set(scopeKey, { boardId: owner as BoardId, logicalDate });
    else rootScopes.push({ rootId: owner as BoardId, logicalDate });
  }
  await settleAffectedCoinScopes({ hashing }, { tx, now }, { checkScopes: [...checkScopes.values()], rootScopes });
  await refreshCheckVisibility(tx, checks);
}
