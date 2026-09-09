import { isValidLogicalDate } from '../calendar/logical-date';
import type { CheckIn } from './entities';
import { uuidV5 } from './deterministic-ids';
import { COIN_RECORD_BYTES, CoinContractError, parseCoinPolicy } from './coin-policy';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from './ids';
import { isUuidV4, isUuidV5 } from './ids';
import type { Hashing } from './ports';
import type { DomainResult } from './result';
import { err, ok } from './result';

export type HabitActionKind = 'check' | 'uncheck' | 'move_out' | 'move_in' | 'policy' | 'baseline';
export type HabitAction = {
  id: HabitActionId;
  commandId: CommandId | null;
  boardId: BoardId;
  logicalDate: LogicalDate;
  checkInId: CheckInId | null;
  kind: HabitActionKind;
  createdAt: number;
  mutationStamp: string;
  policyJson: string | null;
};

const kinds: readonly string[] = ['check', 'uncheck', 'move_out', 'move_in', 'policy', 'baseline'];
const BASELINE_STAMP = '00000000000000-00000-baseline';

export function validateHabitAction(action: HabitAction): DomainResult<HabitAction> {
  const baseline = action.kind === 'baseline';
  if (
    typeof action.id !== 'string' || typeof action.boardId !== 'string' ||
    typeof action.logicalDate !== 'string' || typeof action.kind !== 'string' ||
    typeof action.mutationStamp !== 'string' ||
    (action.commandId !== null && typeof action.commandId !== 'string') ||
    (action.checkInId !== null && typeof action.checkInId !== 'string') ||
    !(baseline ? isUuidV5(action.id) : isUuidV4(action.id)) ||
    !(baseline ? action.commandId === null : action.commandId !== null && isUuidV4(action.commandId)) ||
    !isUuidV4(action.boardId) || !isValidLogicalDate(action.logicalDate) ||
    !kinds.includes(action.kind) ||
    (action.checkInId !== null && !isUuidV4(action.checkInId)) ||
    (action.checkInId === null && action.kind !== 'uncheck' && action.kind !== 'policy') ||
    (action.kind === 'policy' && action.checkInId !== null) ||
    !Number.isSafeInteger(action.createdAt) || action.createdAt < 0 ||
    !/^\d{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$/.test(action.mutationStamp) ||
    (action.policyJson !== null && Object.is(action.createdAt, -0)) ||
    (baseline && (action.mutationStamp !== BASELINE_STAMP ||
      action.createdAt !== 0 || action.policyJson !== null))
  ) return err('validation', 'Invalid habit action.');
  try {
    if (action.policyJson !== null) parseCoinPolicy(action.policyJson);
    if (new TextEncoder().encode(canonicalHabitAction(action)).length > COIN_RECORD_BYTES) {
      throw new CoinContractError('size');
    }
  } catch (cause) {
    if ((cause as CoinContractError).reason === 'size') {
      return err('capacity', 'Habit evidence exceeds the supported record size.', { retryable: true });
    }
    return err('validation', 'Invalid habit action.');
  }
  return ok(action);
}

export function canonicalHabitAction(action: HabitAction): string {
  return JSON.stringify([action.id, action.commandId, action.boardId, action.logicalDate,
    action.checkInId, action.kind, action.createdAt, action.mutationStamp, action.policyJson]);
}

export async function baselineAction(
  check: Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>,
  hashing: Pick<Hashing, 'sha1'>,
): Promise<HabitAction> {
  const name = JSON.stringify(['habit-baseline-v1', check.id, check.boardId, check.logicalDate]);
  return {
    id: await uuidV5(name, hashing) as HabitActionId,
    commandId: null,
    boardId: check.boardId,
    logicalDate: check.logicalDate,
    checkInId: check.id,
    kind: 'baseline',
    createdAt: 0,
    mutationStamp: BASELINE_STAMP,
    policyJson: null,
  };
}

function compareActions(left: HabitAction, right: HabitAction): number {
  const rank = Number(left.kind !== 'baseline') - Number(right.kind !== 'baseline');
  if (rank !== 0) return rank;
  if (left.mutationStamp !== right.mutationStamp) {
    return left.mutationStamp < right.mutationStamp ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function foldActiveCheckInIds(actions: readonly HabitAction[]): CheckInId[] {
  const active = new Map<CheckInId, HabitAction>();
  for (const action of [...actions].sort(compareActions)) {
    if (action.kind === 'policy') continue;
    if (action.kind === 'uncheck' || action.kind === 'move_out') {
      if (action.checkInId === null) active.clear();
      else active.delete(action.checkInId);
    } else active.set(action.checkInId as CheckInId, action);
  }
  const remaining = [...active.values()].sort(compareActions);
  return remaining.map(action => action.checkInId as CheckInId);
}

export function foldDailyActions(actions: readonly HabitAction[]): { checked: boolean; checkInId: CheckInId | null } {
  const active = foldActiveCheckInIds(actions);
  return { checked: active.length > 0, checkInId: active[active.length - 1] ?? null };
}
