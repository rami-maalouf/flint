import type { HabitAction } from '../../domain/habit-actions';
import { canonicalHabitAction, validateHabitAction } from '../../domain/habit-actions';
import { CoinContractError } from '../../domain/coin-policy';
import type { BoardId, LogicalDate } from '../../domain/ids';
import type { SqlExecutor } from '../database';

type ActionRow = {
  id: HabitAction['id']; command_id: HabitAction['commandId']; board_id: BoardId;
  logical_date: LogicalDate; check_in_id: HabitAction['checkInId']; kind: HabitAction['kind'];
  created_at: number; mutation_stamp: string; policy_json: string | null;
};

function fromRow(row: ActionRow): HabitAction {
  return { id: row.id, commandId: row.command_id, boardId: row.board_id,
    logicalDate: row.logical_date, checkInId: row.check_in_id, kind: row.kind,
    createdAt: row.created_at, mutationStamp: row.mutation_stamp, policyJson: row.policy_json };
}

export async function appendHabitAction(tx: SqlExecutor, action: HabitAction): Promise<boolean> {
  const validated = validateHabitAction(action);
  if (!validated.ok) {
    if (validated.error.code === 'capacity') throw new CoinContractError('size');
    throw new Error('Invalid habit action.');
  }
  const existing = await tx.getFirstAsync<ActionRow>('SELECT * FROM habit_actions WHERE id = ?', [action.id]);
  if (existing) {
    if (canonicalHabitAction(fromRow(existing)) !== canonicalHabitAction(action)) {
      throw new Error('Immutable habit action conflicts with its saved payload.');
    }
    return false;
  }
  await tx.runAsync(`INSERT INTO habit_actions
    (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [action.id, action.commandId, action.boardId,
    action.logicalDate, action.checkInId, action.kind, action.createdAt, action.mutationStamp, action.policyJson]);
  return true;
}

export async function listHabitActions(
  tx: SqlExecutor, boardId: BoardId, logicalDate: LogicalDate,
): Promise<HabitAction[]> {
  const rows = await tx.getAllAsync<ActionRow>(`SELECT * FROM habit_actions
    WHERE board_id = ? AND logical_date = ? ORDER BY mutation_stamp, id`, [boardId, logicalDate]);
  return rows.map(fromRow);
}

// exact pairs share one read without combining unrelated boards and dates.
export async function listHabitActionsForScopes(
  tx: SqlExecutor, scopes: readonly { boardId: BoardId; logicalDate: LogicalDate }[],
): Promise<HabitAction[]> {
  const pairs = [...new Map(scopes.map(({ boardId, logicalDate }) =>
    [`${boardId}:${logicalDate}`, { boardId, logicalDate }])).values()];
  if (pairs.length === 0) return [];
  const rows = await tx.getAllAsync<ActionRow>(`SELECT a.* FROM habit_actions a
    JOIN json_each(?) s ON a.board_id = json_extract(s.value, '$.boardId')
      AND a.logical_date = json_extract(s.value, '$.logicalDate')`, [JSON.stringify(pairs)]);
  return rows.map(fromRow);
}
