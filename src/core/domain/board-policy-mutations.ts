import { createEconomicDayCloseResolver } from '../calendar/economic-day-close';
import { currentLogicalDate } from '../calendar/logical-date';
import { refreshCheckVisibility } from '../persistence/repositories/check-visibility';
import { listUndeletedBoards } from '../persistence/repositories/boards';
import { readBoardPolicyPeriods, readOpenBoardPolicyDates } from '../persistence/repositories/board-policy-evidence';
import { appendHabitAction } from '../persistence/repositories/habit-actions';
import { appendOutbox } from '../persistence/repositories/support';
import { planCoinPolicyEmission, type CoinPolicyDraft } from './coin-policy-emission';
import type { CoinPolicyBoard } from './coin-policy-capture';
import { settleAffectedCoinScopes } from './coin-settlement';
import type { CommandContext, CommandDeps } from './command-context';
import type { HabitAction } from './habit-actions';
import type { BoardId, CommandId, HabitActionId, LogicalDate } from './ids';
import { ok, type DomainResult } from './result';
import { deriveStacks } from './stacks';

type PeriodChange = { boardId: BoardId; kind: 'create' | 'archive' | 'restore'; logicalDate: LogicalDate }
  | { boardId: BoardId; kind: 'delete' };
export type PreparedBoardPolicies = { drafts: readonly CoinPolicyDraft[]; reopenedPeriodId: number | null };

// prospective state is prepared once before any stamp, baseline or board write.
export async function prepareBoardPolicyChange(
  deps: Pick<CommandDeps, 'hashing'>,
  context: Pick<CommandContext, 'tx' | 'now' | 'timeZoneId'>,
  changedBoards: readonly CoinPolicyBoard[],
  periodChange?: PeriodChange,
): Promise<DomainResult<PreparedBoardPolicies>> {
  const beforeBoards = await listUndeletedBoards(context.tx);
  const changed = new Map(changedBoards.map(board => [board.id, board]));
  const afterBoards = [...beforeBoards.filter(board => !changed.has(board.id)), ...changedBoards];
  const byMember = [];
  for (const boards of [beforeBoards, afterBoards]) {
    const derived = deriveStacks(boards, { wake: 0, lunch: 0, dinner: 0, sleep: 0 });
    if (!derived.ok) return derived;
    byMember.push(new Map(derived.value.flatMap(stack => stack.orderedMemberIds.map(id => [id, stack] as const))));
  }
  const affected = new Set(changed.keys());
  const roots = new Set<BoardId>();
  const expanded = byMember.map(() => new Set<BoardId>());
  for (const id of affected) {
    byMember.forEach((map, index) => {
      const stack = map.get(id);
      if (!stack || expanded[index].has(stack.rootId)) return;
      expanded[index].add(stack.rootId);
      roots.add(stack.rootId);
      for (const member of stack.orderedMemberIds) affected.add(member);
    });
  }
  const beforePeriods = await readBoardPolicyPeriods(context.tx, [...affected]);
  const afterPeriods = new Map([...beforePeriods].map(([id, periods]) => [id, periods.map(period => ({ ...period }))]));
  let reopenedPeriodId: number | null = null;
  if (periodChange) {
    const periods = afterPeriods.get(periodChange.boardId) ?? [];
    if (periodChange.kind === 'archive') {
      for (const period of periods) if (period.endDate === null) period.endDate = periodChange.logicalDate;
    } else if (periodChange.kind === 'restore') {
      const reopened = periods.find(period => period.endDate === periodChange.logicalDate);
      if (reopened) { reopened.endDate = null; reopenedPeriodId = reopened.id; }
      else periods.push({ id: 0, startDate: periodChange.logicalDate, endDate: null });
    } else if (periodChange.kind === 'create') {
      periods.push({ id: 0, startDate: periodChange.logicalDate, endDate: null });
    }
    afterPeriods.set(periodChange.boardId, periodChange.kind === 'delete' ? [] : periods);
  }
  const dates = new Set<LogicalDate>();
  const before = beforeBoards.filter(board => affected.has(board.id));
  const after = afterBoards.filter(board => affected.has(board.id));
  for (const board of [...before, ...after]) {
    if (board.deletedAt === null) dates.add(currentLogicalDate(context.now, context.timeZoneId, board.startOfDayMinute));
  }
  for (const date of await readOpenBoardPolicyDates(context.tx, deps.hashing,
    { boardIds: [...affected], rootIds: [...roots], now: context.now })) dates.add(date);
  const planned = planCoinPolicyEmission({ before: { boards: before, periodsByBoard: beforePeriods },
    after: { boards: after, periodsByBoard: afterPeriods }, changedBoardIds: [...changed.keys()], candidateDates: [...dates] },
  createEconomicDayCloseResolver(context.timeZoneId));
  return planned.ok ? ok({ drafts: planned.value, reopenedPeriodId }) : planned;
}

// policy facts share the source command's ordered stamps and atomic settlement.
export async function appendBoardPolicies(
  deps: CommandDeps,
  context: CommandContext,
  commandId: CommandId,
  prepared: PreparedBoardPolicies,
  additionalScopes: readonly { boardId: BoardId; logicalDate: LogicalDate }[] = [],
) {
  const scopes = new Map<string, { boardId: BoardId; logicalDate: LogicalDate }>();
  for (const draft of prepared.drafts) {
    const action: HabitAction = { ...draft, id: deps.ids.uuid() as HabitActionId,
      commandId, createdAt: context.now, mutationStamp: context.stamp() };
    await appendHabitAction(context.tx, action);
    await appendOutbox(context.tx, 'habit_action', action.id, action.mutationStamp, context.now);
    scopes.set(`check:${draft.boardId}:${draft.logicalDate}`, { boardId: draft.boardId, logicalDate: draft.logicalDate });
  }
  for (const scope of additionalScopes) scopes.set(`check:${scope.boardId}:${scope.logicalDate}`, scope);
  if (scopes.size === 0) return;
  await settleAffectedCoinScopes(deps, context, { checkScopes: [...scopes.values()] });
  await refreshCheckVisibility(context.tx, [...scopes.values()]);
}
