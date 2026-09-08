import { currentLogicalDate, offsetMinutesAt } from '../calendar/logical-date';
import { rebuildWidgetRows } from '../persistence/projections/widget-rows';
import { getBoardById } from '../persistence/repositories/boards';
import { getCheckInById, insertCheckIn, latestCheckInForDate, listBoardCheckInsForDate, updateCheckInRow } from '../persistence/repositories/check-ins';
import { appendOutbox } from '../persistence/repositories/support';
import type { Board, CheckIn, CheckInSource } from './entities';
import type { BoardId, CheckInId, CommandId, LogicalDate } from './ids';
import type { CommandContext, CommandDeps } from './command-context';
import { runCommand } from './command-context';
import { normalizeCreatedReceipt, normalizeRemovedReceipt } from './check-in-receipts';
import { appendCheckAction, captureCheckPolicy, seedLegacyCheckActions } from './check-in-mutations';
import { settleCheckCoinScope } from './coin-settlement';
import type { DomainResult } from './result';
import { err, ok } from './result';
import { validateAmount, validateLogicalDateInput, validateNote } from './validation';

// --- check-ins ---------------------------------------------------------------

export type CreateCheckInInput = {
  commandId: CommandId;
  boardId: BoardId;
  logicalDate?: LogicalDate;
  occurredAtUtc?: number;
  amount?: number;
  note?: string;
  source: Exclude<CheckInSource, 'sync'>;
};

export function createCheckIn(
  deps: CommandDeps,
  input: CreateCheckInInput,
): Promise<DomainResult<{ checkInId: CheckInId; logicalDate: LogicalDate; created: boolean }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const note = validateNote(input.note);
    if (!note.ok) return note;
    return createCheckInInTransaction(deps, context, input, note.value);
  }).then(normalizeCreatedReceipt);
}

async function createCheckInInTransaction(
  deps: CommandDeps,
  context: CommandContext,
  input: CreateCheckInInput,
  note: string | null,
): Promise<DomainResult<{ checkInId: CheckInId; logicalDate: LogicalDate; created: boolean }>> {
  const { tx, now, timeZoneId } = context;
  const board = await getBoardById(tx, input.boardId);
  if (!board) {
    return err('not_found', 'This board no longer exists.');
  }
  if (board.archivedAt !== null) {
    return err('archived', 'Restore the board to add check-ins.');
  }
  const today = currentLogicalDate(now, timeZoneId, board.startOfDayMinute);

  let amount: number | null = null;
  if (board.tracksAmount) {
    const value = validateAmount(input.amount ?? board.quickAmount);
    if (!value.ok) {
      return value;
    }
    amount = value.value;
  } else if (input.amount !== undefined) {
    return err('validation', 'This board does not track amounts.', { field: 'amount' });
  }

  let occurredAtUtc: number | null = null;
  let checkInZone: string | null = null;
  let offsetMinutes: number | null = null;
  if (board.tracksTime) {
    occurredAtUtc = input.occurredAtUtc ?? now;
    checkInZone = timeZoneId;
    offsetMinutes = offsetMinutesAt(occurredAtUtc, timeZoneId);
  }

  let logicalDate: LogicalDate;
  if (input.logicalDate !== undefined) {
    const validated = validateLogicalDateInput(input.logicalDate, today);
    if (!validated.ok) {
      return validated;
    }
    logicalDate = validated.value;
  } else if (occurredAtUtc !== null) {
    const derived = currentLogicalDate(occurredAtUtc, timeZoneId, board.startOfDayMinute);
    // a future instant must not smuggle in a future logical date
    const validated = validateLogicalDateInput(derived, today);
    if (!validated.ok) {
      return validated;
    }
    logicalDate = validated.value;
  } else {
    logicalDate = today;
  }

  if (board.kind === 'daily') {
    if (input.occurredAtUtc !== undefined) {
      return err('validation', 'Daily habits do not track exact times.', { field: 'occurredAtUtc' });
    }
    const existing = await latestCheckInForDate(tx, board.id, logicalDate);
    if (existing) return ok({ checkInId: existing.id, logicalDate, created: false });
  }
  const policy = await captureCheckPolicy(context, { boardId: board.id, logicalDate });
  if (!policy.ok) return policy;
  return ok(await insertCheckedRecord(deps, context, input.commandId, {
    boardId: board.id, logicalDate, occurredAtUtc, timeZoneId: checkInZone,
    offsetMinutes, amount, note, source: input.source,
  }, policy.value));
}

// callers have resolved the board, date, and input before this first write.
async function insertCheckedRecord(
  deps: CommandDeps,
  context: CommandContext,
  commandId: CommandId,
  fields: Pick<CheckIn, 'boardId' | 'logicalDate' | 'occurredAtUtc' | 'timeZoneId' | 'offsetMinutes' | 'amount' | 'note' | 'source'>,
  policyJson: string,
): Promise<{ checkInId: CheckInId; logicalDate: LogicalDate; created: boolean }> {
  const { tx, now, timeZoneId, stamp } = context;
  await seedLegacyCheckActions(deps, tx, await listBoardCheckInsForDate(tx, fields.boardId, fields.logicalDate), now);
  const mutationStamp = stamp();
  const checkIn: CheckIn = {
    ...fields,
    id: deps.ids.uuid() as CheckInId,
    idempotencyKey: commandId,
    createdAt: now,
    updatedAt: now,
    mutationStamp,
    deletedAt: null,
  };
  await insertCheckIn(tx, checkIn);
  await appendOutbox(tx, 'check_in', checkIn.id, mutationStamp, now);
  await appendCheckAction(deps, context, commandId, checkIn, 'check', mutationStamp, checkIn.id, policyJson);
  await settleCheckCoinScope(deps, context, { boardId: fields.boardId, logicalDate: fields.logicalDate });
  await rebuildWidgetRows(tx, now, timeZoneId);
  return { checkInId: checkIn.id, logicalDate: fields.logicalDate, created: true };
}

export type UpdateCheckInInput = {
  commandId: CommandId;
  checkInId: CheckInId;
  expectedMutationStamp: string;
  logicalDate: LogicalDate;
  occurredAtUtc?: number;
  amount?: number;
  note?: string;
};

export function updateCheckIn(
  deps: CommandDeps,
  input: UpdateCheckInInput,
): Promise<DomainResult<{ mutationStamp: string }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const note = validateNote(input.note);
    if (!note.ok) return note;
    const existing = await getCheckInById(tx, input.checkInId);
    if (!existing) {
      return err('not_found', 'This check-in no longer exists.');
    }
    if (existing.mutationStamp !== input.expectedMutationStamp) {
      return err('conflict', 'This check-in changed elsewhere. Review the latest values.');
    }
    const board = await getBoardById(tx, existing.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    if (board.archivedAt !== null) {
      return err('archived', 'Restore the board to edit its check-ins.');
    }
    const today = currentLogicalDate(now, timeZoneId, board.startOfDayMinute);
    const logicalDate = validateLogicalDateInput(input.logicalDate, today);
    if (!logicalDate.ok) {
      return logicalDate;
    }
    let amount: number | null = existing.amount;
    if (input.amount !== undefined) {
      if (!board.tracksAmount) {
        return err('validation', 'This board does not track amounts.', { field: 'amount' });
      }
      const value = validateAmount(input.amount);
      if (!value.ok) {
        return value;
      }
      amount = value.value;
    }
    let occurredAtUtc = existing.occurredAtUtc;
    let zone = existing.timeZoneId;
    let offset = existing.offsetMinutes;
    if (input.occurredAtUtc !== undefined) {
      if (!board.tracksTime) {
        return err('validation', 'This board does not track exact times.', {
          field: 'occurredAtUtc',
        });
      }
      occurredAtUtc = input.occurredAtUtc;
      zone = timeZoneId;
      offset = offsetMinutesAt(input.occurredAtUtc, timeZoneId);
    }
    if (board.kind === 'daily' && logicalDate.value !== existing.logicalDate &&
      await latestCheckInForDate(tx, board.id, logicalDate.value)) {
      return err('conflict', 'This Daily habit is already checked for that day.');
    }
    await seedLegacyCheckActions(deps, tx, await listBoardCheckInsForDate(tx, board.id, existing.logicalDate), now);
    if (logicalDate.value !== existing.logicalDate) {
      await seedLegacyCheckActions(deps, tx, await listBoardCheckInsForDate(tx, board.id, logicalDate.value), now);
      await appendCheckAction(deps, context, input.commandId, existing, 'move_out', stamp());
    }
    const mutationStamp = stamp();
    await updateCheckInRow(tx, {
      ...existing,
      logicalDate: logicalDate.value,
      occurredAtUtc,
      timeZoneId: zone,
      offsetMinutes: offset,
      amount,
      note: note.value,
      updatedAt: now,
      mutationStamp,
    });
    await appendOutbox(tx, 'check_in', existing.id, mutationStamp, now);
    if (logicalDate.value !== existing.logicalDate) {
      await appendCheckAction(deps, context, input.commandId, { ...existing, logicalDate: logicalDate.value }, 'move_in', mutationStamp);
    }
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok({ mutationStamp });
  });
}

export function removeCheckIn(
  deps: CommandDeps,
  input: { commandId: CommandId; checkInId: CheckInId; expectedMutationStamp?: string },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const existing = await getCheckInById(tx, input.checkInId);
    if (!existing) {
      return err('not_found', 'This check-in no longer exists.');
    }
    if (
      input.expectedMutationStamp !== undefined &&
      existing.mutationStamp !== input.expectedMutationStamp
    ) {
      return err('conflict', 'This check-in changed elsewhere. Review the latest values.');
    }
    const board = await getBoardById(tx, existing.boardId);
    if (board && board.archivedAt !== null) {
      return err('archived', 'Restore the board to delete its check-ins.');
    }
    const policy = board ? await captureCheckPolicy(context, existing) : ok(null);
    if (!policy.ok) return policy;
    await seedLegacyCheckActions(deps, tx, await listBoardCheckInsForDate(tx, existing.boardId, existing.logicalDate), now);
    const mutationStamp = stamp();
    await updateCheckInRow(tx, { ...existing, deletedAt: now, updatedAt: now, mutationStamp });
    await appendOutbox(tx, 'check_in', existing.id, mutationStamp, now);
    await appendCheckAction(deps, context, input.commandId, existing, 'uncheck', mutationStamp, existing.id, policy.value);
    await settleCheckCoinScope(deps, context, existing);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}

// removes the newest record of one logical day. the lookup happens inside
// the command envelope so a retry replays its receipt rather than resolving
// a different still-live record (or reporting Not Found after success).
export function removeLatestCheckIn(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId; logicalDate?: LogicalDate; expectedCheckIns?: ExpectedCheckIn[] },
): Promise<DomainResult<{ removedCheckInId: CheckInId; removedCheckInIds: CheckInId[]; logicalDate: LogicalDate }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    if (board.archivedAt !== null) {
      return err('archived', 'Restore the board to delete its check-ins.');
    }
    const logicalDate =
      input.logicalDate ?? currentLogicalDate(now, timeZoneId, board.startOfDayMinute);
    const validDate = validateLogicalDateInput(logicalDate, currentLogicalDate(now, timeZoneId, board.startOfDayMinute));
    if (!validDate.ok) return validDate;
    const checks = await listBoardCheckInsForDate(tx, board.id, logicalDate);
    if (!matchesExpectedChecks(checks, input.expectedCheckIns)) {
      return err('conflict', 'The check-ins for this day changed. Review them before removing.');
    }
    const latest = await latestCheckInForDate(tx, board.id, logicalDate);
    if (!latest) {
      return err('not_found', 'There is no check-in to remove for that day.');
    }
    const policy = await captureCheckPolicy(context, latest);
    if (!policy.ok) return policy;
    const removedCheckInIds = await removeDateChecks(deps, context, input.commandId, board, latest, policy.value);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok({ removedCheckInId: latest.id, removedCheckInIds, logicalDate });
  }).then(normalizeRemovedReceipt);
}

// undo removes only the check-in created by the quick action it belongs to
export function undoCreatedCheckIn(
  deps: CommandDeps,
  input: { commandId: CommandId; checkInId: CheckInId; createdByCommandId: CommandId },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const existing = await getCheckInById(tx, input.checkInId);
    if (!existing) {
      return err('not_found', 'This check-in was already removed.');
    }
    if (existing.idempotencyKey !== input.createdByCommandId) {
      return err('conflict', 'Undo can only remove the check-in it belongs to.');
    }
    const board = await getBoardById(tx, existing.boardId);
    if (board && board.archivedAt !== null) {
      return err('archived', 'Restore the board to change its check-ins.');
    }
    const policy = board ? await captureCheckPolicy(context, existing) : ok(null);
    if (!policy.ok) return policy;
    await seedLegacyCheckActions(deps, tx, await listBoardCheckInsForDate(tx, existing.boardId, existing.logicalDate), now);
    const mutationStamp = stamp();
    await updateCheckInRow(tx, { ...existing, deletedAt: now, updatedAt: now, mutationStamp });
    await appendOutbox(tx, 'check_in', existing.id, mutationStamp, now);
    await appendCheckAction(deps, context, input.commandId, existing, 'uncheck', mutationStamp, existing.id, policy.value);
    await settleCheckCoinScope(deps, context, existing);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}


async function removeDateChecks(
  deps: CommandDeps,
  context: CommandContext,
  commandId: CommandId,
  board: Board,
  latest: CheckIn,
  policyJson: string,
): Promise<CheckInId[]> {
  const { tx, now, stamp } = context;
  const all = await listBoardCheckInsForDate(tx, board.id, latest.logicalDate);
  await seedLegacyCheckActions(deps, tx, all, now);
  const removed = board.kind === 'daily' ? all : [latest];
  const mutationStamp = stamp();
  for (const check of removed) {
    await updateCheckInRow(tx, { ...check, deletedAt: now, updatedAt: now, mutationStamp });
    await appendOutbox(tx, 'check_in', check.id, mutationStamp, now);
  }
  await appendCheckAction(deps, context, commandId, latest, 'uncheck', mutationStamp,
    board.kind === 'daily' ? null : latest.id, policyJson);
  await settleCheckCoinScope(deps, context, latest);
  return removed.map((check) => check.id);
}

export function toggleDailyCheckIn(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId; logicalDate?: LogicalDate; expectedCheckIns?: ExpectedCheckIn[]; source?: 'app' | 'widget' },
): Promise<DomainResult<{ checked: boolean; created: boolean; checkInId: CheckInId | null; logicalDate: LogicalDate; removedCheckInIds: CheckInId[] }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) return err('not_found', 'This board no longer exists.');
    if (board.archivedAt !== null) return err('archived', 'Restore the board to change its check-ins.');
    if (board.kind !== 'daily') return err('validation', 'Only Daily habits can be toggled.');
    const today = currentLogicalDate(now, timeZoneId, board.startOfDayMinute);
    const date = validateLogicalDateInput(input.logicalDate ?? today, today);
    if (!date.ok) return date;
    const checks = await listBoardCheckInsForDate(tx, board.id, date.value);
    if (!matchesExpectedChecks(checks, input.expectedCheckIns)) {
      return err('conflict', 'The check-ins for this day changed. Review them before toggling.');
    }
    const latest = await latestCheckInForDate(tx, board.id, date.value);
    const policy = await captureCheckPolicy(context, { boardId: board.id, logicalDate: date.value });
    if (!policy.ok) return policy;
    if (latest) {
      const removedCheckInIds = await removeDateChecks(deps, context, input.commandId, board, latest, policy.value);
      await rebuildWidgetRows(tx, now, timeZoneId);
      return ok({ checked: false, created: false, checkInId: null, logicalDate: date.value, removedCheckInIds });
    }
    const created = await insertCheckedRecord(deps, context, input.commandId, {
      boardId: board.id, logicalDate: date.value, occurredAtUtc: null, timeZoneId: null,
      offsetMinutes: null, amount: null, note: null, source: input.source ?? 'app',
    }, policy.value);
    return ok({ ...created, checked: true, removedCheckInIds: [] });
  });
}

export type ExpectedCheckIn = { checkInId: CheckInId; mutationStamp: string };

function matchesExpectedChecks(checks: readonly CheckIn[], expected: readonly ExpectedCheckIn[] | undefined): boolean {
  if (expected === undefined) return true;
  const actual = checks.map((check) => JSON.stringify([check.id, check.mutationStamp])).sort();
  const selected = expected.map((check) => JSON.stringify([check.checkInId, check.mutationStamp])).sort();
  return JSON.stringify(actual) === JSON.stringify(selected);
}
