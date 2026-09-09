import {
  compareLogicalDates,
  currentLogicalDate,
  isValidLogicalDate,
  offsetMinutesAt,
} from '../calendar/logical-date';
import type { ImportDraft } from '../export/import-parsers';
import { rebuildWidgetRows } from '../persistence/projections/widget-rows';
import {
  boardIdExists,
  getBoardById,
  insertBoard,
  lastActiveOrderKey,
  listBoardAnchorDependents,
  listUndeletedBoards,
  updateBoardRow,
} from '../persistence/repositories/boards';
import {
  checkInIdExists,
  insertCheckIn,
  listRawBoardCheckIns,
} from '../persistence/repositories/check-ins';
import { insertReminder, reminderIdExists } from '../persistence/repositories/reminders';
import {
  appendOutbox,
  closeOpenPeriod,
  insertPeriod,
  saveICloudSyncEnabled,
  saveMetricsEducationDismissed,
  saveSelectedIcon,
  tombstoneBoardGraph,
} from '../persistence/repositories/support';
import { establishLegacyCheckEvidence } from './legacy-check-evidence';
import { settleAffectedCoinScopes } from './coin-settlement';
import { refreshCheckVisibility } from '../persistence/repositories/check-visibility';
import { appendCheckAction, captureBoardDatePolicies } from './check-in-mutations';
import { appendBoardPolicies, prepareBoardPolicyChange } from './board-policy-mutations';
import { reopenBoardPolicyPeriod } from '../persistence/repositories/board-policy-evidence';
import { EMPTY_BOARD_ANCHOR, normalizeBoardAnchorFields, validateBoardAnchorGraph, type BoardAnchorFields, type BoardAnchorOptions } from './board-anchor';
import type { Board, BoardKind, CheckIn, Reminder, SelectedIcon } from './entities';
import type { BoardId, CheckInId, CommandId, LogicalDate, ReminderId } from './ids';
import { isUuidV4 } from './ids';
import { orderKeyAfter, orderKeyBetween } from './order-key';
import type { DomainResult } from './result';
import { err, ok } from './result';
import {
  validateAccentHex,
  validateAmount,
  validateMinuteOfDay,
  validateNote,
  validateReminderMessage,
  validateStartOfDayMinute,
  validateSymbol,
  validateTitle,
  validateUnit,
  validateWeekdaysMask,
} from './validation';

import type { CommandContext, CommandDeps } from './command-context';
import { runCommand } from './command-context';
export { runCommand, replayCommand } from './command-context';
export type { CommandContext, CommandDeps } from './command-context';
export { setAnchorPresetMinute } from './anchor-settings-commands';
export type { BoardAnchorInput, BoardAnchorOptions } from './board-anchor';

// --- boards ------------------------------------------------------------------

export type CreateBoardInput = BoardAnchorOptions & {
  kind?: BoardKind;
  earnsCoins?: boolean;
  coinCapPerDay?: number;
  commandId: CommandId;
  title: string;
  symbol: string;
  accentHex: string;
  usesTintedBackground: boolean;
  tracksAmount: boolean;
  amountUnit?: string | null;
  quickAmount?: number;
  tracksTime: boolean;
  startOfDayMinute: number;
  metricsEnabled: boolean;
};

type BoardFieldValidation = {
  anchorFields: Partial<BoardAnchorFields>;
  coinFields: Partial<Pick<Board, 'earnsCoins' | 'coinCapPerDay'>>;
  title: string;
  symbol: string;
  accentHex: string;
  amountUnit: string | null;
  quickAmount: number;
  startOfDayMinute: number;
};

export function validateBoardFields(
  input: BoardAnchorOptions & {
    kind?: BoardKind;
    earnsCoins?: boolean;
    coinCapPerDay?: number;
    title: string;
    symbol: string;
    accentHex: string;
    tracksAmount: boolean;
    amountUnit?: string | null;
    quickAmount?: number;
    startOfDayMinute: number;
  },
  // updates retain the saved amount configuration when fields are omitted,
  // so turning amount tracking off never erases unit or quick amount
  fallback: { amountUnit: string | null; quickAmount: number } = {
    amountUnit: null,
    quickAmount: 1,
  },
): DomainResult<BoardFieldValidation> {
  if (input.kind !== undefined && input.kind !== 'count' && input.kind !== 'daily') {
    return err('validation', 'Choose a valid habit kind.', { field: 'kind' });
  }
  const coinFields: BoardFieldValidation['coinFields'] = {};
  if (input.earnsCoins !== undefined) {
    if (typeof input.earnsCoins !== 'boolean') {
      return err('validation', 'Choose whether this habit earns coins.', { field: 'earnsCoins' });
    }
    coinFields.earnsCoins = input.earnsCoins;
  }
  if (input.coinCapPerDay !== undefined) {
    if (!Number.isInteger(input.coinCapPerDay) || input.coinCapPerDay < 1 || input.coinCapPerDay > 10) {
      return err('validation', 'Choose a daily coin cap from 1 to 10.', { field: 'coinCapPerDay' });
    }
    coinFields.coinCapPerDay = input.coinCapPerDay;
  }
  const title = validateTitle(input.title);
  if (!title.ok) {
    return title;
  }
  const symbol = validateSymbol(input.symbol);
  if (!symbol.ok) {
    return symbol;
  }
  const accent = validateAccentHex(input.accentHex);
  if (!accent.ok) {
    return accent;
  }
  const unit =
    input.amountUnit === undefined ? ok(fallback.amountUnit) : validateUnit(input.amountUnit);
  if (!unit.ok) {
    return unit;
  }
  const quickAmountRaw = input.quickAmount ?? fallback.quickAmount;
  const quickAmount = validateAmount(quickAmountRaw, 'quickAmount');
  if (!quickAmount.ok) {
    return quickAmount;
  }
  const startOfDay = validateStartOfDayMinute(input.startOfDayMinute);
  if (!startOfDay.ok) {
    return startOfDay;
  }
  const anchorFields = normalizeBoardAnchorFields(input);
  if (!anchorFields.ok) return anchorFields;
  return ok({
    anchorFields: anchorFields.value,
    coinFields,
    title: title.value,
    symbol: symbol.value,
    accentHex: accent.value,
    amountUnit: unit.value,
    quickAmount: quickAmount.value,
    startOfDayMinute: startOfDay.value,
  });
}

export function createBoard(
  deps: CommandDeps,
  input: CreateBoardInput,
): Promise<DomainResult<{ boardId: BoardId }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const fields = validateBoardFields(input);
    if (!fields.ok) return fields;
    const board = await createBoardInTransaction(deps, context, input, fields.value);
    return board.ok ? ok({ boardId: board.value.id }) : board;
  });
}

// callers validate first; the shared envelope owns the receipt and transaction.
export async function createBoardInTransaction(
  deps: CommandDeps,
  context: CommandContext,
  input: CreateBoardInput,
  fields: BoardFieldValidation,
): Promise<DomainResult<Board>> {
  const { tx, now, timeZoneId, stamp } = context;
  if (fields.anchorFields.anchorKind === 'board') {
    const anchor = validateBoardAnchorGraph(null, fields.anchorFields.anchorBoardId!, await listUndeletedBoards(tx));
    if (!anchor.ok) return anchor;
  }
  const boardId = deps.ids.uuid() as BoardId;
  const orderKey = orderKeyAfter(await lastActiveOrderKey(tx));
  const prospective: Omit<Board, 'mutationStamp'> = {
    id: boardId,
    kind: input.kind ?? 'count',
    anchorRelation: null,
    anchorKind: null,
    anchorBoardId: null,
    anchorPreset: null,
    anchorText: null,
    usualTimeMinute: null,
    requiredInStack: true,
    ...fields.anchorFields,
    earnsCoins: false,
    coinCapPerDay: 1,
    ...fields.coinFields,
    title: fields.title,
    symbol: fields.symbol,
    accentHex: fields.accentHex,
    usesTintedBackground: input.usesTintedBackground,
    tracksAmount: input.kind !== 'daily' && input.tracksAmount,
    amountUnit: fields.amountUnit,
    quickAmount: fields.quickAmount,
    tracksTime: input.kind !== 'daily' && input.tracksTime,
    startOfDayMinute: fields.startOfDayMinute,
    metricsEnabled: input.metricsEnabled,
    orderKey,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const today = currentLogicalDate(now, timeZoneId, prospective.startOfDayMinute);
  const policies = await prepareBoardPolicyChange(deps, context, [prospective], { kind: 'create', boardId, logicalDate: today });
  if (!policies.ok) return policies;
  const mutationStamp = stamp();
  const board: Board = { ...prospective, mutationStamp };
  await insertBoard(tx, board);
  const periodId = await insertPeriod(tx, boardId, today, mutationStamp);
  await appendOutbox(tx, 'board', boardId, mutationStamp, now);
  await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
  await appendBoardPolicies(deps, context, input.commandId, policies.value);
  await rebuildWidgetRows(tx, now, timeZoneId);
  return ok(board);
}

export type UpdateBoardInput = Omit<CreateBoardInput, 'commandId'> & {
  commandId: CommandId;
  boardId: BoardId;
  expectedMutationStamp: string;
};

export function updateBoard(
  deps: CommandDeps,
  input: UpdateBoardInput,
): Promise<DomainResult<{ mutationStamp: string }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const fields = validateBoardFields(input);
    if (!fields.ok) return fields;
    const { tx, now, timeZoneId, stamp } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    if (board.archivedAt !== null) {
      return err('archived', 'Restore the board before editing it.');
    }
    if (board.mutationStamp !== input.expectedMutationStamp) {
      return err('conflict', 'This board changed elsewhere. Review the latest values.');
    }
    const anchored = { ...board, ...fields.value.anchorFields };
    if (anchored.anchorKind === 'board') {
      const anchor = validateBoardAnchorGraph(board.id, anchored.anchorBoardId, await listUndeletedBoards(tx));
      if (!anchor.ok) return anchor;
    }
    const updated: Board = {
      ...board,
      ...fields.value.anchorFields,
      ...fields.value.coinFields,
      kind: input.kind ?? board.kind,
      title: fields.value.title,
      symbol: fields.value.symbol,
      accentHex: fields.value.accentHex,
      usesTintedBackground: input.usesTintedBackground,
      tracksAmount: (input.kind ?? board.kind) !== 'daily' && input.tracksAmount,
      // omitted amount configuration retains the saved values
      amountUnit: input.amountUnit === undefined ? board.amountUnit : fields.value.amountUnit,
      quickAmount: input.quickAmount === undefined ? board.quickAmount : fields.value.quickAmount,
      tracksTime: (input.kind ?? board.kind) !== 'daily' && input.tracksTime,
      startOfDayMinute: fields.value.startOfDayMinute,
      metricsEnabled: input.metricsEnabled,
      updatedAt: now,
    };
    const policies = await prepareBoardPolicyChange(deps, context, [updated]);
    if (!policies.ok) return policies;
    const mutationStamp = stamp();
    updated.mutationStamp = mutationStamp;
    await updateBoardRow(tx, updated);
    await appendOutbox(tx, 'board', board.id, mutationStamp, now);
    await appendBoardPolicies(deps, context, input.commandId, policies.value);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok({ mutationStamp });
  });
}

export type ReorderBoardInput = {
  commandId: CommandId;
  boardId: BoardId;
  previousBoardId: BoardId | null;
  nextBoardId: BoardId | null;
};

export function reorderBoard(
  deps: CommandDeps,
  input: ReorderBoardInput,
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async ({ tx, now, timeZoneId, stamp }) => {
    const board = await getBoardById(tx, input.boardId);
    if (!board || board.archivedAt !== null) {
      return err('not_found', 'This board is not in the active list.');
    }
    const previous = input.previousBoardId ? await getBoardById(tx, input.previousBoardId) : null;
    const next = input.nextBoardId ? await getBoardById(tx, input.nextBoardId) : null;
    if ((input.previousBoardId && !previous) || (input.nextBoardId && !next)) {
      return err('not_found', 'A neighboring board no longer exists.');
    }
    const mutationStamp = stamp();
    const orderKey = orderKeyBetween(previous?.orderKey ?? null, next?.orderKey ?? null);
    await updateBoardRow(tx, { ...board, orderKey, updatedAt: now, mutationStamp });
    await appendOutbox(tx, 'board', board.id, mutationStamp, now);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}

export function archiveBoard(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    if (board.archivedAt !== null) {
      return err('archived', 'This board is already archived.');
    }
    const today = currentLogicalDate(now, timeZoneId, board.startOfDayMinute);
    const policies = await prepareBoardPolicyChange(deps, context, [{ ...board, archivedAt: now }],
      { kind: 'archive', boardId: board.id, logicalDate: today });
    if (!policies.ok) return policies;
    const mutationStamp = stamp();
    await updateBoardRow(tx, { ...board, archivedAt: now, updatedAt: now, mutationStamp });
    const closedPeriodIds = await closeOpenPeriod(tx, board.id, today, mutationStamp);
    // schedule rows survive the archive: they hold the native identifiers
    // the reminder reconciler needs to actually cancel the requests
    await appendOutbox(tx, 'board', board.id, mutationStamp, now);
    for (const periodId of closedPeriodIds) {
      await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
    }
    await appendBoardPolicies(deps, context, input.commandId, policies.value);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}

export function restoreBoard(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    if (board.archivedAt === null) {
      return err('validation', 'This board is not archived.');
    }
    const today = currentLogicalDate(now, timeZoneId, board.startOfDayMinute);
    // restored boards go to the end of the active order
    const orderKey = orderKeyAfter(await lastActiveOrderKey(tx));
    const policies = await prepareBoardPolicyChange(deps, context, [{ ...board, archivedAt: null, orderKey }],
      { kind: 'restore', boardId: board.id, logicalDate: today });
    if (!policies.ok) return policies;
    const mutationStamp = stamp();
    await updateBoardRow(tx, {
      ...board,
      archivedAt: null,
      orderKey,
      updatedAt: now,
      mutationStamp,
    });
    // same-day close and reopen merge into one period
    const reopenedId = policies.value.reopenedPeriodId;
    if (reopenedId !== null) await reopenBoardPolicyPeriod(tx, reopenedId, mutationStamp);
    const periodId = reopenedId ?? (await insertPeriod(tx, board.id, today, mutationStamp));
    await appendOutbox(tx, 'board', board.id, mutationStamp, now);
    await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
    await appendBoardPolicies(deps, context, input.commandId, policies.value);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}

export function deleteBoard(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async (context) => {
    const { tx, now, timeZoneId, stamp } = context;
    const board = await getBoardById(tx, input.boardId);
    if (!board) {
      return err('not_found', 'This board no longer exists.');
    }
    const dependents = await listBoardAnchorDependents(tx, board.id);
    const checks = await listRawBoardCheckIns(tx, board.id);
    const dates = [...new Set(checks.map((check) => check.logicalDate))];
    const policies = await captureBoardDatePolicies(context, board.id, dates);
    if (!policies.ok) return policies;
    const boardPolicies = await prepareBoardPolicyChange(deps, context,
      [{ ...board, deletedAt: now }, ...dependents.map(dependent => ({ ...dependent, ...EMPTY_BOARD_ANCHOR, updatedAt: now }))],
      { kind: 'delete', boardId: board.id });
    if (!boardPolicies.ok) return boardPolicies;
    const mutationStamp = stamp();
    for (const check of checks) {
      await appendCheckAction(deps, context, input.commandId, check, 'uncheck', mutationStamp,
        check.id, policies.value.get(check.logicalDate)!);
    }
    for (const dependent of dependents) {
      await updateBoardRow(tx, { ...dependent, ...EMPTY_BOARD_ANCHOR, updatedAt: now, mutationStamp });
      await appendOutbox(tx, 'board', dependent.id, mutationStamp, now);
    }
    const descendants = await tombstoneBoardGraph(tx, board.id, now, mutationStamp);
    await appendOutbox(tx, 'board', board.id, mutationStamp, now);
    // descendant tombstones must reach sync so remote replicas delete them
    for (const checkInId of descendants.checkInIds) {
      await appendOutbox(tx, 'check_in', checkInId, mutationStamp, now);
    }
    for (const reminderId of descendants.reminderIds) {
      await appendOutbox(tx, 'reminder', reminderId, mutationStamp, now);
    }
    for (const periodId of descendants.periodIds) {
      await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
    }
    await appendBoardPolicies(deps, context, input.commandId, boardPolicies.value, dates.map(logicalDate => ({ boardId: board.id, logicalDate })));
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(undefined);
  });
}

export { createCheckIn, updateCheckIn, removeCheckIn, removeLatestCheckIn, undoCreatedCheckIn, toggleDailyCheckIn } from './check-in-commands';
export type { CreateCheckInInput, UpdateCheckInInput, ExpectedCheckIn } from './check-in-commands';

// --- settings ----------------------------------------------------------------

export function setSelectedIcon(
  deps: CommandDeps,
  input: { commandId: CommandId; icon: SelectedIcon },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async ({ tx }) => {
    await saveSelectedIcon(tx, input.icon);
    return ok(undefined);
  });
}

export function setICloudSyncEnabled(
  deps: CommandDeps,
  input: { commandId: CommandId; enabled: boolean },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async ({ tx }) => {
    await saveICloudSyncEnabled(tx, input.enabled);
    return ok(undefined);
  });
}

export function dismissMetricsEducation(
  deps: CommandDeps,
  input: { commandId: CommandId; boardId: BoardId },
): Promise<DomainResult<void>> {
  return runCommand(deps, input.commandId, async ({ tx, now, settings, stamp }) => {
    if (!settings.metricsEducationDismissed.includes(input.boardId)) {
      const dismissed = [...settings.metricsEducationDismissed, input.boardId];
      const mutationStamp = stamp();
      await saveMetricsEducationDismissed(tx, dismissed, mutationStamp);
      await appendOutbox(tx, 'settings', 'app-settings', mutationStamp, now);
    }
    return ok(undefined);
  });
}

// --- import ---------------------------------------------------------------

export type ImportSnapshotInput = {
  commandId: CommandId;
  draft: ImportDraft;
};

export type ImportSummary = {
  boardsCreated: number;
  boardsSkipped: number;
  checkInsCreated: number;
  checkInsSkipped: number;
  remindersCreated: number;
  remindersSkipped: number;
};

// stored dates survive zone-changing archive and restore operations exactly.
// reversed ranges are empty and overlaps retain their existing union meaning;
// only malformed endpoints invalidate the list and require lifetime fallback.
function sanitizeImportPeriods(
  periods: { startDate: string; endDate: string | null }[],
): { startDate: LogicalDate; endDate: LogicalDate | null }[] {
  const cleaned: { startDate: LogicalDate; endDate: LogicalDate | null }[] = [];
  for (const period of periods) {
    if (typeof period !== 'object' || period === null) {
      return [];
    }
    if (typeof period.startDate !== 'string' || !isValidLogicalDate(period.startDate)) {
      return [];
    }
    if (period.endDate !== null) {
      if (typeof period.endDate !== 'string' || !isValidLogicalDate(period.endDate)) {
        return [];
      }
    }
    cleaned.push({
      startDate: period.startDate as LogicalDate,
      endDate: period.endDate as LogicalDate | null,
    });
  }
  return cleaned;
}

// one exclusive transaction maps normalized import drafts onto real
// records: an own-format restore keeps original ids and periods and skips
// records that already exist, while a ripples csv import always creates
// fresh records and derives periods and logical dates from its instants
export function importSnapshot(
  deps: CommandDeps,
  input: ImportSnapshotInput,
): Promise<DomainResult<ImportSummary>> {
  return runCommand(deps, input.commandId, (context) =>
    importSnapshotInTransaction(deps, context, input.draft, 'preserve-history'),
  );
}

// callers that need another invariant in the same exclusive transaction
// can reuse the import mapping without nesting a command transaction.
export async function importSnapshotInTransaction(
  deps: CommandDeps,
  { tx, now, timeZoneId, stamp }: CommandContext,
  importDraft: ImportDraft,
  earningMode: 'preserve-history',
): Promise<DomainResult<ImportSummary>> {
    if (earningMode !== 'preserve-history') {
      return err('validation', 'Import must preserve historical earnings.');
    }
    const summary: ImportSummary = {
      boardsCreated: 0,
      boardsSkipped: 0,
      checkInsCreated: 0,
      checkInsSkipped: 0,
      remindersCreated: 0,
      remindersSkipped: 0,
    };
    const legacyChecks: CheckIn[] = [];
    const boardIdBySource = new Map<string, BoardId>();
    const boardMeta = new Map<
      BoardId,
      { startOfDayMinute: number; tracksAmount: boolean; tracksTime: boolean }
    >();
    let lastKey = await lastActiveOrderKey(tx);

    for (const draft of importDraft.boards) {
      // invalid records skip individually instead of failing the import
      const fields = validateBoardFields({
        title: draft.title,
        symbol: draft.symbol,
        accentHex: draft.accentHex,
        tracksAmount: draft.tracksAmount,
        amountUnit: draft.amountUnit,
        quickAmount: draft.quickAmount,
        startOfDayMinute: draft.startOfDayMinute,
      });
      if (!fields.ok) {
        summary.boardsSkipped += 1;
        continue;
      }
      if (draft.preserveId) {
        if (!isUuidV4(draft.sourceId)) {
          summary.boardsSkipped += 1;
          continue;
        }
        const existing = await getBoardById(tx, draft.sourceId as BoardId);
        if (existing) {
          // a restore over existing data keeps the live record and still
          // routes the file's check-ins to it
          boardIdBySource.set(draft.sourceId, existing.id);
          boardMeta.set(existing.id, {
            startOfDayMinute: existing.startOfDayMinute,
            tracksAmount: existing.tracksAmount,
            tracksTime: existing.tracksTime,
          });
          summary.boardsSkipped += 1;
          continue;
        }
        if (await boardIdExists(tx, draft.sourceId as BoardId)) {
          // a tombstoned row still owns its primary key; the deleted board
          // stays deleted and its check-ins are not rerouted
          summary.boardsSkipped += 1;
          continue;
        }
      }
      const boardId = (draft.preserveId ? draft.sourceId : deps.ids.uuid()) as BoardId;
      const mutationStamp = stamp();
      const createdAt = Math.min(draft.createdAtUtc, now);
      const archivedAt =
        draft.archivedAtUtc === null ? null : Math.min(draft.archivedAtUtc, now);
      // a preserved key must stay inside the generator's base-36 alphabet;
      // anything else would poison the high-water mark and break every
      // later generated key, so a malformed key is regenerated instead
      const preservedKey =
        draft.orderKey !== null && /^[0-9a-z]+$/.test(draft.orderKey) ? draft.orderKey : null;
      const orderKey = preservedKey ?? orderKeyAfter(lastKey);
      // every used key folds into the high-water mark, preserved ones
      // included, so later generated keys cannot collide or interleave
      if (lastKey === null || orderKey > lastKey) {
        lastKey = orderKey;
      }
      const board: Board = {
        id: boardId,
        kind: 'count',
        anchorRelation: null,
        anchorKind: null,
        anchorBoardId: null,
        anchorPreset: null,
        anchorText: null,
        usualTimeMinute: null,
        requiredInStack: true,
        earnsCoins: false,
        coinCapPerDay: 1,
        title: fields.value.title,
        symbol: fields.value.symbol,
        accentHex: fields.value.accentHex,
        usesTintedBackground: draft.usesTintedBackground,
        tracksAmount: draft.tracksAmount,
        amountUnit: fields.value.amountUnit,
        quickAmount: fields.value.quickAmount,
        tracksTime: draft.tracksTime,
        startOfDayMinute: fields.value.startOfDayMinute,
        metricsEnabled: draft.metricsEnabled,
        orderKey,
        archivedAt,
        createdAt,
        updatedAt: now,
        mutationStamp,
        deletedAt: null,
      };
      await insertBoard(tx, board);
      await appendOutbox(tx, 'board', boardId, mutationStamp, now);
      const restoredPeriods = draft.periods === null ? [] : sanitizeImportPeriods(draft.periods);
      if (restoredPeriods.length > 0) {
        // an own-format restore replays its recorded activity periods
        for (const period of restoredPeriods) {
          const periodId = await insertPeriod(tx, boardId, period.startDate, mutationStamp, period.endDate);
          await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
        }
      } else {
        // ripples imports, and own restores whose period list is missing or
        // empty or malformed, derive one period from creation to archive
        const startDate = currentLogicalDate(
          createdAt,
          timeZoneId,
          fields.value.startOfDayMinute,
        );
        const periodId = await insertPeriod(tx, boardId, startDate, mutationStamp);
        if (archivedAt !== null) {
          const archivedDate = currentLogicalDate(
            archivedAt,
            timeZoneId,
            fields.value.startOfDayMinute,
          );
          const endDate =
            compareLogicalDates(archivedDate, startDate) < 0 ? startDate : archivedDate;
          await closeOpenPeriod(tx, boardId, endDate, mutationStamp);
        }
        await appendOutbox(tx, 'activity_period', String(periodId), mutationStamp, now);
      }
      boardIdBySource.set(draft.sourceId, boardId);
      boardMeta.set(boardId, {
        startOfDayMinute: fields.value.startOfDayMinute,
        tracksAmount: draft.tracksAmount,
        tracksTime: draft.tracksTime,
      });
      summary.boardsCreated += 1;
    }

    for (const draft of importDraft.checkIns) {
      const boardId = boardIdBySource.get(draft.sourceBoardId);
      if (!boardId) {
        summary.checkInsSkipped += 1;
        continue;
      }
      if (draft.preserveId && draft.sourceId !== null) {
        if (!isUuidV4(draft.sourceId)) {
          summary.checkInsSkipped += 1;
          continue;
        }
        // the raw check covers live and tombstoned rows: both own the
        // primary key, and a deleted check-in stays deleted
        if (await checkInIdExists(tx, draft.sourceId as CheckInId)) {
          summary.checkInsSkipped += 1;
          continue;
        }
      }
      const meta = boardMeta.get(boardId) as {
        startOfDayMinute: number;
        tracksAmount: boolean;
        tracksTime: boolean;
      };
      const instant = draft.occurredAtUtc;
      let logicalDate: LogicalDate;
      if (draft.logicalDate !== null && isValidLogicalDate(draft.logicalDate)) {
        logicalDate = draft.logicalDate;
      } else if (instant !== null) {
        // a malformed stored date falls back to the instant's logical date
        logicalDate = currentLogicalDate(instant, timeZoneId, meta.startOfDayMinute);
      } else {
        summary.checkInsSkipped += 1;
        continue;
      }
      const today = currentLogicalDate(now, timeZoneId, meta.startOfDayMinute);
      if (logicalDate > today) {
        // future rows never enter the store
        summary.checkInsSkipped += 1;
        continue;
      }
      const note = validateNote(draft.note);
      // amounts pass the same domain gate as user input; an out-of-range
      // value is dropped, not a reason to lose the record
      const amountResult =
        meta.tracksAmount && draft.amount !== null ? validateAmount(draft.amount) : null;
      const mutationStamp = stamp();
      const checkInId = (
        draft.preserveId && draft.sourceId !== null ? draft.sourceId : deps.ids.uuid()
      ) as CheckInId;
      // a same-day instant from a skewed source clock is clamped so no
      // stored occurrence sits in the future
      const storedInstant =
        meta.tracksTime && instant !== null ? Math.min(instant, now) : null;
      // a clamp moved the occurrence, so the recorded offset no longer
      // describes it; recompute in the record's own zone
      const instantClamped = storedInstant !== null && storedInstant !== instant;
      const checkIn: CheckIn = {
        id: checkInId,
        boardId,
        logicalDate,
        occurredAtUtc: storedInstant,
        timeZoneId:
          storedInstant === null ? null : (draft.timeZoneId ?? timeZoneId),
        offsetMinutes:
          storedInstant === null
            ? null
            : instantClamped
              ? offsetMinutesAt(storedInstant, draft.timeZoneId ?? timeZoneId)
              : (draft.offsetMinutes ?? offsetMinutesAt(storedInstant, timeZoneId)),
        amount: amountResult !== null && amountResult.ok ? amountResult.value : null,
        // an over-long note is dropped, not a reason to lose the record
        note: note.ok ? note.value : null,
        source: 'app',
        idempotencyKey: deps.ids.uuid() as CommandId,
        createdAt: Math.min(draft.createdAtUtc, now),
        updatedAt: now,
        mutationStamp,
        deletedAt: null,
      };
      await insertCheckIn(tx, checkIn);
      legacyChecks.push(checkIn);
      await appendOutbox(tx, 'check_in', checkInId, mutationStamp, now);
      summary.checkInsCreated += 1;
    }

    for (const draft of importDraft.reminders) {
      const boardId = boardIdBySource.get(draft.sourceBoardId);
      if (!boardId) {
        summary.remindersSkipped += 1;
        continue;
      }
      const mask = validateWeekdaysMask(draft.weekdaysMask);
      const minute = validateMinuteOfDay(draft.minuteOfDay);
      const message = validateReminderMessage(draft.message);
      if (!mask.ok || !minute.ok || !message.ok) {
        summary.remindersSkipped += 1;
        continue;
      }
      if (!isUuidV4(draft.sourceId)) {
        summary.remindersSkipped += 1;
        continue;
      }
      // the raw check covers live and tombstoned rows
      if (await reminderIdExists(tx, draft.sourceId as ReminderId)) {
        summary.remindersSkipped += 1;
        continue;
      }
      const mutationStamp = stamp();
      const reminder: Reminder = {
        id: draft.sourceId as ReminderId,
        boardId,
        weekdaysMask: mask.value,
        minuteOfDay: minute.value,
        message: message.value,
        // rules and enabled state restore; the schedule itself is rebuilt
        // by the reminder reconciler after the import
        enabled: draft.enabled,
        nativeIdentifiers: [],
        scheduleState: 'idle',
        lastScheduleError: null,
        createdAt: Math.min(draft.createdAtUtc, now),
        updatedAt: now,
        mutationStamp,
        deletedAt: null,
      };
      await insertReminder(tx, reminder);
      await appendOutbox(tx, 'reminder', reminder.id, mutationStamp, now);
      summary.remindersCreated += 1;
    }

    const legacy = await establishLegacyCheckEvidence({ tx, now, hashing: deps.hashing }, legacyChecks);
    await settleAffectedCoinScopes(deps, { tx, now }, { checkScopes: legacy.checkScopes });
    await refreshCheckVisibility(tx, legacy.checkScopes);
    await rebuildWidgetRows(tx, now, timeZoneId);
    return ok(summary);
}
