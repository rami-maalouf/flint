import { createEconomicDayCloseResolver } from '../calendar/economic-day-close';
import { appendHabitAction } from '../persistence/repositories/habit-actions';
import { appendOutbox } from '../persistence/repositories/support';
import type { CommandContext, CommandDeps } from './command-context';
import type { CheckIn } from './entities';
import type { HabitAction, HabitActionKind } from './habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from './ids';
import { canonicalCoinPolicy } from './coin-policy';
import { readCoinPolicyCapture } from './coin-policy-capture';
import { ok, type DomainResult } from './result';

// resolve immutable policy before the writer allocates a stamp or changes rows.
export async function captureCheckPolicy(
  context: Pick<CommandContext, 'tx' | 'timeZoneId'>,
  check: Pick<CheckIn, 'boardId' | 'logicalDate'>,
): Promise<DomainResult<string>> {
  const policies = await captureBoardDatePolicies(context, check.boardId, [check.logicalDate]);
  return policies.ok ? ok(policies.value.get(check.logicalDate)!) : policies;
}

// date moves and deletion validate every affected date against one snapshot.
export async function captureBoardDatePolicies(
  context: Pick<CommandContext, 'tx' | 'timeZoneId'>,
  boardId: BoardId,
  dates: readonly LogicalDate[],
): Promise<DomainResult<Map<LogicalDate, string>>> {
  const policies = new Map<LogicalDate, string>();
  if (dates.length === 0) return ok(policies);
  const prepared = await readCoinPolicyCapture(context.tx, [boardId], createEconomicDayCloseResolver(context.timeZoneId));
  if (!prepared.ok) return prepared;
  for (const logicalDate of dates) {
    const captured = prepared.value({ boardId, logicalDate });
    if (!captured.ok) return captured;
    policies.set(logicalDate, canonicalCoinPolicy(captured.value));
  }
  return ok(policies);
}

export async function appendCheckAction(
  deps: CommandDeps,
  { tx, now }: CommandContext,
  commandId: CommandId,
  check: Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>,
  kind: Exclude<HabitActionKind, 'baseline' | 'policy'>,
  mutationStamp: string,
  checkInId: CheckInId | null,
  policyJson: string | null,
): Promise<HabitAction> {
  const action: HabitAction = {
    id: deps.ids.uuid() as HabitActionId,
    commandId,
    boardId: check.boardId,
    logicalDate: check.logicalDate,
    checkInId,
    kind,
    createdAt: now,
    mutationStamp,
    policyJson,
  };
  await appendHabitAction(tx, action);
  await appendOutbox(tx, 'habit_action', action.id, mutationStamp, now);
  return action;
}
