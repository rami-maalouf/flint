import { currentLogicalDate } from '../../../../src/core/calendar/logical-date';
import type { BoardId } from '../../../../src/core/domain/ids';
import { validateAmount, validateLogicalDateInput, validateNote } from '../../../../src/core/domain/validation';
import type { NormalizeContext, OperationPolicy } from '../accounts/operations';
import type { MutationRequest } from '../operations/journal';
import { contracts } from './contracts';
import { domainValue, ToolError } from './errors';

type ClaimRequest = Extract<MutationRequest, { tool: 'claim_reward' }>;
export type ApprovedClaimNormalizer = (request: ClaimRequest, context: NormalizeContext) => ReturnType<OperationPolicy['normalize']>;
type Habit = { id: BoardId; kind: 'count' | 'daily'; tracks_amount: number; tracks_time: number;
  quick_amount: number; start_of_day_minute: number; archived_at: number | null };

// only the trusted account lane invokes this with expiring reads and an immutable command clock.
export function createMutationNormalizer(approvedClaim?: ApprovedClaimNormalizer): OperationPolicy['normalize'] {
  return async (request, frozen) => {
    if (request.tool === 'claim_reward') {
      if (!approvedClaim) throw new ToolError('CONFIRMATION_REQUIRED', 'Approve this exact reward claim in your browser first.');
      return approvedClaim(request, frozen);
    }
    if (request.tool === 'undo_checkin') {
      const input = contracts.undo_checkin.input.parse(request.input);
      const target = await frozen.undoTarget(input.originalOperationId.toLowerCase());
      if (!('timeZone' in target) || typeof target.timeZone !== 'string') {
        throw new ToolError('OPERATION_PENDING', 'The original operation time zone requires recovery.', true);
      }
      return { timeZone: target.timeZone, command: { tool: 'undo_checkin', input: {
        commandId: frozen.commandId, checkInId: target.checkInId, createdByCommandId: target.createdByCommandId,
      } } };
    }
    const input = contracts.create_checkin.input.parse(request.input);
    const habit = await frozen.read.getFirstAsync<Habit>(`SELECT id, kind, tracks_amount, tracks_time,
      quick_amount, start_of_day_minute, archived_at FROM boards WHERE id = ? AND deleted_at IS NULL`, [input.habitId]);
    if (!habit) throw new ToolError('NOT_FOUND', 'The requested habit is unavailable.');
    if (habit.archived_at !== null) throw new ToolError('CONFLICT', 'Restore this habit before adding a check-in.');
    const invalid = () => { throw new ToolError('INVALID_INPUT', 'The check-in does not match this habit or logical day.'); };
    if (input.amount !== undefined && !habit.tracks_amount) invalid();
    if (input.occurredAtUtc !== undefined && (!habit.tracks_time || habit.kind === 'daily' || input.occurredAtUtc > frozen.nowUtcMs)) invalid();
    domainValue(validateNote(input.note));
    const amount = habit.tracks_amount ? domainValue(validateAmount(input.amount ?? habit.quick_amount)) : undefined;
    const occurredAtUtc = habit.tracks_time ? input.occurredAtUtc ?? frozen.nowUtcMs : undefined;
    let today, occurrence;
    try {
      today = currentLogicalDate(frozen.nowUtcMs, input.timeZone, habit.start_of_day_minute);
      occurrence = occurredAtUtc === undefined ? today : currentLogicalDate(occurredAtUtc, input.timeZone, habit.start_of_day_minute);
    } catch { return invalid(); }
    if (input.logicalDate !== undefined && input.occurredAtUtc !== undefined && input.logicalDate !== occurrence) invalid();
    const logicalDate = domainValue(validateLogicalDateInput(input.logicalDate ?? occurrence, today));
    return { timeZone: input.timeZone, command: { tool: 'create_checkin', input: {
      commandId: frozen.commandId, boardId: habit.id, logicalDate, source: 'app',
      ...(amount !== undefined ? { amount } : {}), ...(occurredAtUtc !== undefined ? { occurredAtUtc } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    } } };
  };
}
