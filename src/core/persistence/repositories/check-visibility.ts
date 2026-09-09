import { foldActiveCheckInIds, type HabitAction } from '../../domain/habit-actions';
import type { BoardId, LogicalDate } from '../../domain/ids';
import type { SqlExecutor } from '../database';
import { listHabitActionsForScopes } from './habit-actions';

// local state intersects accepted tokens with the current raw row's exact board/date.
export async function refreshCheckVisibility(
  tx: SqlExecutor, checkScopes: readonly { boardId: BoardId; logicalDate: LogicalDate }[],
): Promise<void> {
  const scopes = new Map(checkScopes.map(({ boardId, logicalDate }) =>
    [`${boardId}:${logicalDate}`, { boardId, logicalDate }]));
  if (scopes.size === 0) return;
  const grouped = new Map<string, HabitAction[]>();
  for (const action of await listHabitActionsForScopes(tx, [...scopes.values()])) {
    const key = `${action.boardId}:${action.logicalDate}`;
    const group = grouped.get(key) ?? []; group.push(action); grouped.set(key, group);
  }
  const active = [...scopes].flatMap(([key, scope]) =>
    foldActiveCheckInIds(grouped.get(key) ?? []).map(id => ({ ...scope, id })));
  await tx.runAsync(`UPDATE check_ins SET state_suppressed = CASE WHEN id IN (
    SELECT c.id FROM json_each(?) a JOIN check_ins c ON c.id = json_extract(a.value, '$.id')
      AND c.board_id = json_extract(a.value, '$.boardId')
      AND c.logical_date = json_extract(a.value, '$.logicalDate') WHERE c.deleted_at IS NULL
    ) THEN 0 ELSE 1 END
    WHERE id IN (SELECT c.id FROM json_each(?) s JOIN check_ins c
      ON c.board_id = json_extract(s.value, '$.boardId')
      AND c.logical_date = json_extract(s.value, '$.logicalDate'))`,
  [JSON.stringify(active), JSON.stringify([...scopes.values()])]);
}
