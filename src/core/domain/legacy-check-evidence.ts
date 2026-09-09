import type { SqlExecutor } from '../persistence/database';
import { appendHabitAction, listHabitActionsForScopes } from '../persistence/repositories/habit-actions';
import { appendOutbox } from '../persistence/repositories/support';
import type { CheckIn } from './entities';
import { baselineAction, type HabitAction } from './habit-actions';
import type { Hashing } from './ports';

// only migration and validated legacy compatibility boundaries grant baseline authority.
export async function establishLegacyCheckEvidence(
  { tx, now, hashing }: { tx: SqlExecutor; now: number; hashing: Hashing },
  checks: readonly Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>[],
) {
  const identities = new Map(checks.map(({ id, boardId, logicalDate }) =>
    [`${boardId}:${logicalDate}:${id}`, { id, boardId, logicalDate }]));
  const checkScopes = [...new Map(checks.map(({ boardId, logicalDate }) =>
    [`${boardId}:${logicalDate}`, { boardId, logicalDate }])).values()];
  const existing = await listHabitActionsForScopes(tx, checkScopes);
  const known = new Set(existing.map(action => `${action.boardId}:${action.logicalDate}:${action.checkInId}`));
  const actions: HabitAction[] = [];
  for (const [key, check] of identities) {
    if (known.has(key)) continue;
    const action = await baselineAction(check, hashing);
    // the exclusive caller and complete scope prefetch exclude an identical saved baseline.
    await appendHabitAction(tx, action);
    await appendOutbox(tx, 'habit_action', action.id, action.mutationStamp, now);
    actions.push(action);
  }
  return { actions, checkScopes };
}
