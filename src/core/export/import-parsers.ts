import { isValidLogicalDate } from '../calendar/logical-date';
import { normalizeBoardAnchorFields, type BoardAnchorInput } from '../domain/board-anchor';
import { isUuidV4, isUuidV5 } from '../domain/ids';
import type { RemoteFactCandidate } from '../domain/remote-fact-validation';
import { validateRewardFields } from '../domain/reward-validation';
import { validateTitle, validateSymbol, validateAccentHex, validateUnit, validateStartOfDayMinute, validateAmount, validateNote, validateReminderMessage,
  validateWeekdaysMask, validateMinuteOfDay } from '../domain/validation';
import type { ExportBoardV2, ExportCheckInV2, ExportReminder, ExportReward, ExportSettingsV2 } from './serialize';
import { boardLimits, boardPalette, boardSymbolAllowlist } from '../domain/entities';
import type { DomainResult } from '../domain/result';
import { err, ok } from '../domain/result';

// normalized import drafts shared by both sources; the import command maps
// them onto real records inside one exclusive transaction

export type ImportBoardDraft = {
  sourceId: string;
  title: string;
  symbol: string;
  accentHex: string;
  usesTintedBackground: boolean;
  tracksAmount: boolean;
  amountUnit: string | null;
  quickAmount: number;
  tracksTime: boolean;
  startOfDayMinute: number;
  metricsEnabled: boolean;
  createdAtUtc: number;
  archivedAtUtc: number | null;
  // own-format restores keep original ids and activity periods
  preserveId: boolean;
  periods: { startDate: string; endDate: string | null }[] | null;
  orderKey: string | null;
};

export type ImportCheckInDraft = {
  sourceId: string | null;
  sourceBoardId: string;
  occurredAtUtc: number | null;
  createdAtUtc: number;
  amount: number | null;
  note: string | null;
  // own-format restores carry the stored logical date and zone verbatim
  logicalDate: string | null;
  timeZoneId: string | null;
  offsetMinutes: number | null;
  preserveId: boolean;
};

// reminders only travel in own exports, so a restore always preserves
// their original ids
export type ImportReminderDraft = {
  sourceId: string;
  sourceBoardId: string;
  weekdaysMask: number;
  minuteOfDay: number;
  message: string | null;
  enabled: boolean;
  createdAtUtc: number;
};

export type LegacyImportDraft = {
  source: 'own' | 'ripples-csv';
  exportVersion?: 1;
  boards: ImportBoardDraft[];
  checkIns: ImportCheckInDraft[];
  reminders: ImportReminderDraft[];
};


export type ImportBoardV2Draft = Omit<ExportBoardV2, 'id'> & { sourceId: string };
export type ImportCheckInV2Draft = Omit<ExportCheckInV2, 'id' | 'boardId'> & { sourceId: string; sourceBoardId: string };
export type ImportReminderV2Draft = Omit<ExportReminder, 'id' | 'boardId'> & { sourceId: string; sourceBoardId: string };
export type ImportRewardDraft = Omit<ExportReward, 'id'> & { sourceId: string };
export type ImportSettingsDraftResult = { kind: 'valid'; value: ExportSettingsV2 } | { kind: 'absent' } | { kind: 'invalid' };
export type ImportSkippedCounts = { boards: number; checkIns: number; reminders: number; rewards: number };
export type OwnV2ImportDraft = {
  source: 'own'; exportVersion: 2; boards: ImportBoardV2Draft[]; checkIns: ImportCheckInV2Draft[];
  reminders: ImportReminderV2Draft[]; rewards: ImportRewardDraft[]; settings: ImportSettingsDraftResult;
  evidence: { sourceJson: string }; skipped: ImportSkippedCounts;
};
export type ImportDraft = LegacyImportDraft | OwnV2ImportDraft;
export type ImportPreview = ImportSkippedCounts & { habitActions: number; coinLedger: number };

const RIPPLES_DEFAULT_SYMBOL = boardSymbolAllowlist[1];
const RIPPLES_DEFAULT_COLOR = boardPalette[2].hex;

// backups written before 2026-09-30 (and every ripples json export) carry the
// inherited format name; both names describe the same versioned payload
export const OWN_EXPORT_FORMATS = ['habit-system.export', 'ripples.export'] as const;
export function isOwnExportFormat(value: unknown): boolean {
  return typeof value === 'string' && (OWN_EXPORT_FORMATS as readonly string[]).includes(value);
}

function parseInstant(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- own export format ---------------------------------------------------

export function parseOwnExport(json: string): DomainResult<ImportDraft> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return err('validation', 'This file is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    return err('validation', 'This file is not a Habit System export.');
  }
  const data = raw as Record<string, unknown>;
  if (!isOwnExportFormat(data.format)) {
    return err('validation', 'This file is not a Habit System export.');
  }
  if (data.exportVersion === 2) return parseOwnV2(data, json);
  if (data.exportVersion !== 1) {
    return err('validation', 'This export was created by a newer version of the app.');
  }
  const boards = Array.isArray(data.boards) ? data.boards : [];
  const checkIns = Array.isArray(data.checkIns) ? data.checkIns : [];
  const boardDrafts: ImportBoardDraft[] = [];
  for (const entry of boards) {
    // a malformed record skips individually; one bad row must not reject
    // an otherwise restorable file
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const board = entry as Record<string, unknown>;
    if (typeof board.id !== 'string' || typeof board.title !== 'string') {
      continue;
    }
    boardDrafts.push({
      sourceId: board.id,
      title: board.title,
      symbol: typeof board.symbol === 'string' ? board.symbol : RIPPLES_DEFAULT_SYMBOL,
      accentHex: typeof board.accentHex === 'string' ? board.accentHex : RIPPLES_DEFAULT_COLOR,
      usesTintedBackground: board.usesTintedBackground === true,
      tracksAmount: board.tracksAmount === true,
      amountUnit: typeof board.amountUnit === 'string' ? board.amountUnit : null,
      quickAmount: typeof board.quickAmount === 'number' ? board.quickAmount : 1,
      tracksTime: board.tracksTime === true,
      startOfDayMinute:
        typeof board.startOfDayMinute === 'number' ? board.startOfDayMinute : 0,
      metricsEnabled: board.metricsEnabled === true,
      createdAtUtc: typeof board.createdAtUtc === 'number' ? board.createdAtUtc : 0,
      archivedAtUtc: typeof board.archivedAtUtc === 'number' ? board.archivedAtUtc : null,
      preserveId: true,
      // malformed period entries are kept as invalid sentinels instead of
      // silently dropped, so the import command distrusts the whole list
      // and falls back to a derived lifetime period
      periods: Array.isArray(board.periods)
        ? board.periods.map((period) => {
            if (
              typeof period !== 'object' ||
              period === null ||
              typeof (period as Record<string, unknown>).startDate !== 'string'
            ) {
              return { startDate: 'invalid', endDate: null };
            }
            const record = period as Record<string, unknown>;
            return {
              startDate: record.startDate as string,
              endDate: typeof record.endDate === 'string' ? record.endDate : null,
            };
          })
        : null,
      orderKey: typeof board.orderKey === 'string' ? board.orderKey : null,
    });
  }
  const checkInDrafts: ImportCheckInDraft[] = [];
  for (const entry of checkIns) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const checkIn = entry as Record<string, unknown>;
    if (
      typeof checkIn.id !== 'string' ||
      typeof checkIn.boardId !== 'string' ||
      typeof checkIn.logicalDate !== 'string'
    ) {
      continue;
    }
    checkInDrafts.push({
      sourceId: checkIn.id,
      sourceBoardId: checkIn.boardId,
      occurredAtUtc: typeof checkIn.occurredAtUtc === 'number' ? checkIn.occurredAtUtc : null,
      createdAtUtc: typeof checkIn.createdAtUtc === 'number' ? checkIn.createdAtUtc : 0,
      amount: typeof checkIn.amount === 'number' ? checkIn.amount : null,
      note: typeof checkIn.note === 'string' ? checkIn.note : null,
      logicalDate: checkIn.logicalDate,
      timeZoneId: typeof checkIn.timeZoneId === 'string' ? checkIn.timeZoneId : null,
      offsetMinutes: typeof checkIn.offsetMinutes === 'number' ? checkIn.offsetMinutes : null,
      preserveId: true,
    });
  }
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  const reminderDrafts: ImportReminderDraft[] = [];
  for (const entry of reminders) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const reminder = entry as Record<string, unknown>;
    if (
      typeof reminder.id !== 'string' ||
      typeof reminder.boardId !== 'string' ||
      typeof reminder.weekdaysMask !== 'number' ||
      typeof reminder.minuteOfDay !== 'number'
    ) {
      continue;
    }
    reminderDrafts.push({
      sourceId: reminder.id,
      sourceBoardId: reminder.boardId,
      weekdaysMask: reminder.weekdaysMask,
      minuteOfDay: reminder.minuteOfDay,
      message: typeof reminder.message === 'string' ? reminder.message : null,
      enabled: reminder.enabled === true,
      createdAtUtc: typeof reminder.createdAtUtc === 'number' ? reminder.createdAtUtc : 0,
    });
  }
  return ok({
    source: 'own',
    boards: boardDrafts,
    checkIns: checkInDrafts,
    reminders: reminderDrafts,
  });
}

// --- ripples csv ----------------------------------------------------------

// strict rfc-4180: quoted fields, doubled quotes, commas and newlines
// inside quotes, crlf or lf row endings. malformed quoting - an unterminated
// quote, a quote inside an unquoted field, or content after a closing
// quote - rejects the file instead of silently misreading it
export function parseCsv(text: string): DomainResult<string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // set once a field was opened with a quote; only a separator or row end
  // may follow its closing quote
  let fieldQuoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      // a closing quote is only recognized when the next char is not a
      // quote, so a quote here can never directly follow a quoted field
      if (field.length > 0) {
        return err('validation', 'This file is not valid CSV: unexpected quote in a field.');
      }
      inQuotes = true;
      fieldQuoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      fieldQuoted = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      fieldQuoted = false;
      rows.push(row);
      row = [];
    } else {
      if (fieldQuoted) {
        return err('validation', 'This file is not valid CSV: content after a closing quote.');
      }
      field += char;
    }
  }
  if (inQuotes) {
    return err('validation', 'This file is not valid CSV: a quoted field never closes.');
  }
  if (field.length > 0 || fieldQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return ok(rows);
}

function roundShiftToStep(seconds: number): number {
  const minutes = Math.round(seconds / 60 / boardLimits.startOfDayMinuteStep) *
    boardLimits.startOfDayMinuteStep;
  return Math.min(boardLimits.startOfDayMinuteMax, Math.max(0, minutes));
}

export function parseRipplesCsv(text: string): DomainResult<LegacyImportDraft> {
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return parsed;
  }
  const rows = parsed.value.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length < 2) {
    return err('validation', 'This file has no importable rows.');
  }
  const header = rows[0].map((cell) => cell.trim());
  const column = (name: string) => header.indexOf(name);
  // every column this parser reads must be present; a partial schema would
  // import lossy data (no amounts, no archive state, no notes) silently
  const required = [
    'entity',
    'board_id',
    'board_name',
    'board_amountKind',
    'board_createdAt',
    'board_dayStartShiftSeconds',
    'board_defaultAmount',
    'board_tracksCheckinTime',
    'board_tracksPerformanceMetrics',
    'board_archivedAt',
    'checkin_id',
    'checkin_boardId',
    'checkin_createdAt',
    'checkin_amount',
    'checkin_note',
  ];
  for (const name of required) {
    if (column(name) < 0) {
      return err('validation', 'This file does not look like a Ripples CSV export.');
    }
  }
  const cell = (row: string[], name: string): string => {
    const index = column(name);
    return index >= 0 && index < row.length ? row[index].trim() : '';
  };

  const boards: ImportBoardDraft[] = [];
  const checkIns: ImportCheckInDraft[] = [];
  for (const row of rows.slice(1)) {
    const entity = cell(row, 'entity');
    if (entity === 'Board') {
      const sourceId = cell(row, 'board_id');
      const title = cell(row, 'board_name');
      if (sourceId.length === 0 || title.length === 0) {
        return err('validation', 'A board row in this file is missing its id or name.');
      }
      const amountKind = cell(row, 'board_amountKind');
      const createdAt = parseInstant(cell(row, 'board_createdAt'));
      if (createdAt === null) {
        return err('validation', `The board "${title}" has an unreadable creation date.`);
      }
      const shiftSeconds = Number(cell(row, 'board_dayStartShiftSeconds') || '0');
      const defaultAmountText = cell(row, 'board_defaultAmount');
      const defaultAmount = Number(defaultAmountText);
      // a present but unreadable archive date must not silently restore an
      // archived board as active
      const archivedAtText = cell(row, 'board_archivedAt');
      const archivedAtUtc = parseInstant(archivedAtText);
      if (archivedAtText.length > 0 && archivedAtUtc === null) {
        return err('validation', `The board "${title}" has an unreadable archive date.`);
      }
      boards.push({
        sourceId,
        title,
        symbol: RIPPLES_DEFAULT_SYMBOL,
        accentHex: RIPPLES_DEFAULT_COLOR,
        usesTintedBackground: true,
        tracksAmount: amountKind.length > 0,
        amountUnit: amountKind.length > 0 ? amountKind : null,
        quickAmount:
          defaultAmountText.length > 0 && Number.isFinite(defaultAmount) && defaultAmount > 0
            ? defaultAmount
            : 1,
        tracksTime: cell(row, 'board_tracksCheckinTime') === 'true',
        startOfDayMinute: Number.isFinite(shiftSeconds) ? roundShiftToStep(shiftSeconds) : 0,
        metricsEnabled: cell(row, 'board_tracksPerformanceMetrics') !== 'false',
        createdAtUtc: createdAt,
        archivedAtUtc,
        preserveId: false,
        periods: null,
        orderKey: null,
      });
    } else if (entity === 'Checkin') {
      const sourceBoardId = cell(row, 'checkin_boardId');
      const createdAt = parseInstant(cell(row, 'checkin_createdAt'));
      if (sourceBoardId.length === 0 || createdAt === null) {
        return err('validation', 'A check-in row in this file is missing its board or date.');
      }
      const amountText = cell(row, 'checkin_amount');
      const amount = Number(amountText);
      const note = cell(row, 'checkin_note');
      checkIns.push({
        sourceId: null,
        sourceBoardId,
        occurredAtUtc: createdAt,
        createdAtUtc: createdAt,
        amount: amountText.length > 0 && Number.isFinite(amount) ? amount : null,
        note: note.length > 0 ? note : null,
        logicalDate: null,
        timeZoneId: null,
        offsetMinutes: null,
        preserveId: false,
      });
    } else {
      return err('validation', `This file contains an unknown row type "${entity}".`);
    }
  }
  if (boards.length === 0) {
    return err('validation', 'This file has no boards to import.');
  }
  return ok({ source: 'ripples-csv', boards, checkIns, reminders: [] });
}

// v2 keeps mutable product validation separate from opaque immutable admission.
const V2_COLLECTIONS = ['boards', 'checkIns', 'reminders', 'rewards', 'habitActions', 'coinLedger'] as const;
const ORDER_KEY = /^[0-9a-z]+$/;
const CHECK_SOURCES = new Set(['app', 'widget', 'shortcut', 'siri', 'sync']);
const ownObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000;
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
const rewardTimestamp = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!ownObject(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return null;
    result[key] = value[key];
  }
  return result;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid import collection.');
  const count = value.length;
  const result: unknown[] = [];
  for (let index = 0; index < count; index++) result.push(value[index]);
  return result;
}

function v2Collections(value: unknown): Record<typeof V2_COLLECTIONS[number], unknown[]> {
  const captured = fields(value, ['format', 'exportVersion', ...V2_COLLECTIONS]);
  if (captured === null || !isOwnExportFormat(captured.format) || captured.exportVersion !== 2) {
    throw new Error('Invalid version two import.');
  }
  return { boards: array(captured.boards), checkIns: array(captured.checkIns), reminders: array(captured.reminders),
    rewards: array(captured.rewards), habitActions: array(captured.habitActions), coinLedger: array(captured.coinLedger) };
}

function evidenceCandidates(data: Pick<ReturnType<typeof v2Collections>, 'habitActions' | 'coinLedger'>): RemoteFactCandidate[] {
  const candidates: RemoteFactCandidate[] = [];
  for (const [factType, values] of [['habit_action', data.habitActions], ['ledger_entry', data.coinLedger]] as const) {
    for (const value of values) {
      if (!ownObject(value) || !Object.hasOwn(value, 'id') || typeof value.id !== 'string' ||
        !(isUuidV4(value.id) || isUuidV5(value.id))) throw new Error('Invalid immutable identity.');
      candidates.push({ factType, factId: value.id, value, enqueueOnAdmission: true });
    }
  }
  return candidates;
}

export function readOwnV2Evidence(sourceJson: string): DomainResult<RemoteFactCandidate[]> {
  try { return ok(evidenceCandidates(v2Collections(JSON.parse(sourceJson)))); }
  catch { return err('validation', 'This file has invalid version 2 data.'); }
}

function periodList(value: unknown): ExportBoardV2['periods'] | null {
  if (!Array.isArray(value)) return null;
  const result: ExportBoardV2['periods'] = [];
  for (const item of array(value)) {
    const row = fields(item, ['startDate', 'endDate']);
    if (row === null || typeof row.startDate !== 'string' || !isValidLogicalDate(row.startDate) ||
      (row.endDate !== null && (typeof row.endDate !== 'string' || !isValidLogicalDate(row.endDate)))) return null;
    result.push({ startDate: row.startDate, endDate: row.endDate as string | null });
  }
  return result;
}

function boardV2(value: unknown, idKey: string): ImportBoardV2Draft | null {
  const row = fields(value, [idKey, 'kind', 'anchorRelation', 'anchorKind', 'anchorBoardId', 'anchorPreset', 'anchorText',
    'usualTimeMinute', 'requiredInStack', 'earnsCoins', 'coinCapPerDay', 'title', 'symbol', 'accentHex', 'usesTintedBackground',
    'tracksAmount', 'amountUnit', 'quickAmount', 'tracksTime', 'startOfDayMinute', 'metricsEnabled', 'orderKey',
    'createdAtUtc', 'archivedAtUtc', 'periods']);
  if (row === null || typeof row[idKey] !== 'string' || !isUuidV4(row[idKey] as string) ||
    !['daily', 'count'].includes(row.kind as string) || typeof row.title !== 'string' || typeof row.symbol !== 'string' ||
    typeof row.accentHex !== 'string' || (row.amountUnit !== null && typeof row.amountUnit !== 'string') ||
    typeof row.quickAmount !== 'number' || typeof row.startOfDayMinute !== 'number' ||
    ['usesTintedBackground', 'tracksAmount', 'tracksTime', 'metricsEnabled', 'requiredInStack', 'earnsCoins'].some(key => typeof row[key] !== 'boolean') ||
    (row.kind === 'daily' && (row.tracksAmount !== false || row.tracksTime !== false)) ||
    (row.usualTimeMinute !== null && typeof row.usualTimeMinute !== 'number') ||
    !Number.isInteger(row.coinCapPerDay) || (row.coinCapPerDay as number) < 1 || (row.coinCapPerDay as number) > 10 ||
    typeof row.orderKey !== 'string' || !ORDER_KEY.test(row.orderKey) || !timestamp(row.createdAtUtc) ||
    !nullableTimestamp(row.archivedAtUtc)) return null;
  const title = validateTitle(row.title); const symbol = validateSymbol(row.symbol);
  const accent = validateAccentHex(row.accentHex); const unit = validateUnit(row.amountUnit);
  const quick = validateAmount(row.quickAmount, 'quickAmount'); const start = validateStartOfDayMinute(row.startOfDayMinute);
  const periods = periodList(row.periods);
  if (!title.ok || !symbol.ok || !accent.ok || !unit.ok || !quick.ok || !start.ok || periods === null) return null;
  let anchor: BoardAnchorInput | null;
  if (row.anchorKind === null) anchor = null;
  else if (row.anchorKind === 'board') anchor = { kind: 'board', relation: row.anchorRelation as never, boardId: row.anchorBoardId as never };
  else if (row.anchorKind === 'preset') anchor = { kind: 'preset', relation: row.anchorRelation as never, preset: row.anchorPreset as never };
  else if (row.anchorKind === 'text') anchor = { kind: 'text', relation: row.anchorRelation as never, text: row.anchorText as never };
  else return null;
  const normalized = normalizeBoardAnchorFields({ anchor, usualTimeMinute: row.usualTimeMinute as number | null,
    requiredInStack: row.requiredInStack as boolean });
  if (!normalized.ok || ['anchorRelation', 'anchorKind', 'anchorBoardId', 'anchorPreset', 'anchorText'].some(key =>
    row[key] !== normalized.value[key as keyof typeof normalized.value]) || row.anchorBoardId === row[idKey]) return null;
  return { sourceId: row[idKey] as string, kind: row.kind as ExportBoardV2['kind'],
    anchorRelation: normalized.value.anchorRelation!, anchorKind: normalized.value.anchorKind!,
    anchorBoardId: normalized.value.anchorBoardId!, anchorPreset: normalized.value.anchorPreset!, anchorText: normalized.value.anchorText!,
    usualTimeMinute: normalized.value.usualTimeMinute!, requiredInStack: row.requiredInStack as boolean,
    earnsCoins: row.earnsCoins as boolean, coinCapPerDay: row.coinCapPerDay as number,
    title: title.value, symbol: symbol.value, accentHex: accent.value, usesTintedBackground: row.usesTintedBackground as boolean,
    tracksAmount: row.tracksAmount as boolean, amountUnit: unit.value, quickAmount: quick.value,
    tracksTime: row.tracksTime as boolean, startOfDayMinute: start.value, metricsEnabled: row.metricsEnabled as boolean,
    orderKey: row.orderKey, createdAtUtc: row.createdAtUtc, archivedAtUtc: row.archivedAtUtc as number | null, periods };
}

function checkV2(value: unknown, idKey: string, parentKey: string): ImportCheckInV2Draft | null {
  const row = fields(value, [idKey, parentKey, 'logicalDate', 'occurredAtUtc', 'timeZoneId', 'offsetMinutes', 'amount', 'note', 'source', 'createdAtUtc']);
  if (row === null || typeof row[idKey] !== 'string' || !isUuidV4(row[idKey] as string) || typeof row[parentKey] !== 'string' ||
    !isUuidV4(row[parentKey] as string) || typeof row.logicalDate !== 'string' || !isValidLogicalDate(row.logicalDate) ||
    (row.amount !== null && typeof row.amount !== 'number') || (row.note !== null && typeof row.note !== 'string') ||
    typeof row.source !== 'string' || !CHECK_SOURCES.has(row.source) || !timestamp(row.createdAtUtc)) return null;
  const note = validateNote(row.note); const amount = row.amount === null ? ok(null) : validateAmount(row.amount);
  if (!note.ok || !amount.ok) return null;
  if (!(row.occurredAtUtc === null && row.timeZoneId === null && row.offsetMinutes === null)) {
    if (!timestamp(row.occurredAtUtc) || typeof row.timeZoneId !== 'string' || typeof row.offsetMinutes !== 'number' ||
      !Number.isFinite(row.offsetMinutes) || Math.abs(row.offsetMinutes) > 1440) return null;
    try { new Intl.DateTimeFormat('en', { timeZone: row.timeZoneId }).format(row.occurredAtUtc); }
    catch { return null; }
  }
  return { sourceId: row[idKey] as string, sourceBoardId: row[parentKey] as string, logicalDate: row.logicalDate,
    occurredAtUtc: row.occurredAtUtc as number | null, timeZoneId: row.timeZoneId as string | null,
    offsetMinutes: row.offsetMinutes as number | null, amount: amount.value, note: note.value,
    source: row.source as ExportCheckInV2['source'], createdAtUtc: row.createdAtUtc };
}

function reminderV2(value: unknown, idKey: string, parentKey: string): ImportReminderV2Draft | null {
  const row = fields(value, [idKey, parentKey, 'weekdaysMask', 'minuteOfDay', 'message', 'enabled', 'createdAtUtc']);
  if (row === null || typeof row[idKey] !== 'string' || !isUuidV4(row[idKey] as string) || typeof row[parentKey] !== 'string' ||
    !isUuidV4(row[parentKey] as string) || typeof row.weekdaysMask !== 'number' || typeof row.minuteOfDay !== 'number' ||
    (row.message !== null && typeof row.message !== 'string') || typeof row.enabled !== 'boolean' || !timestamp(row.createdAtUtc)) return null;
  const mask = validateWeekdaysMask(row.weekdaysMask); const minute = validateMinuteOfDay(row.minuteOfDay);
  const message = validateReminderMessage(row.message);
  return mask.ok && minute.ok && message.ok ? { sourceId: row[idKey] as string, sourceBoardId: row[parentKey] as string,
    weekdaysMask: mask.value, minuteOfDay: minute.value, message: message.value, enabled: row.enabled, createdAtUtc: row.createdAtUtc } : null;
}

function rewardV2(value: unknown, idKey: string): ImportRewardDraft | null {
  const row = fields(value, [idKey, 'title', 'costCoins', 'symbol', 'accentHex', 'orderKey', 'createdAtUtc', 'archivedAtUtc']);
  if (row === null || typeof row[idKey] !== 'string' || !isUuidV4(row[idKey] as string) || typeof row.title !== 'string' ||
    typeof row.costCoins !== 'number' || typeof row.symbol !== 'string' || typeof row.accentHex !== 'string' ||
    typeof row.orderKey !== 'string' || !ORDER_KEY.test(row.orderKey) || !rewardTimestamp(row.createdAtUtc) ||
    (row.archivedAtUtc !== null && !rewardTimestamp(row.archivedAtUtc))) return null;
  const result = validateRewardFields({ title: row.title, costCoins: row.costCoins, symbol: row.symbol, accentHex: row.accentHex });
  return result.ok ? { sourceId: row[idKey] as string, title: result.value.title, costCoins: result.value.costCoins,
    symbol: result.value.symbol, accentHex: result.value.accentHex, orderKey: row.orderKey,
    createdAtUtc: row.createdAtUtc as number, archivedAtUtc: row.archivedAtUtc as number | null } : null;
}

function settingsV2(value: unknown): ImportSettingsDraftResult {
  const row = fields(value, ['metricsEducationDismissed', 'wakeMinute', 'lunchMinute', 'dinnerMinute', 'sleepMinute']);
  if (row === null || !Array.isArray(row.metricsEducationDismissed)) return { kind: 'invalid' };
  const dismissed = array(row.metricsEducationDismissed);
  if (dismissed.some(id => typeof id !== 'string' || !isUuidV4(id)) ||
    ['wakeMinute', 'lunchMinute', 'dinnerMinute', 'sleepMinute'].some(key =>
      typeof row[key] !== 'number' || !normalizeBoardAnchorFields({ usualTimeMinute: row[key] as number }).ok)) return { kind: 'invalid' };
  return { kind: 'valid', value: { metricsEducationDismissed: [...new Set(dismissed as string[])],
    wakeMinute: row.wakeMinute as number, lunchMinute: row.lunchMinute as number,
    dinnerMinute: row.dinnerMinute as number, sleepMinute: row.sleepMinute as number } };
}

function mutableV2(data: { boards: unknown[]; checkIns: unknown[]; reminders: unknown[]; rewards: unknown[] },
  representation: 'file' | 'draft', skipped: ImportSkippedCounts) {
  const id = representation === 'file' ? 'id' : 'sourceId';
  const parent = representation === 'file' ? 'boardId' : 'sourceBoardId';
  function decode<Value>(name: keyof ImportSkippedCounts, entries: unknown[], leaf: (value: unknown) => Value | null): Value[] {
    const result: Value[] = [];
    for (const entry of entries) {
      const decoded = leaf(entry);
      if (decoded === null) skipped[name] = safeCount(skipped[name] + 1);
      else result.push(decoded);
    }
    return result;
  }
  return { boards: decode('boards', data.boards, value => boardV2(value, id)),
    checkIns: decode('checkIns', data.checkIns, value => checkV2(value, id, parent)),
    reminders: decode('reminders', data.reminders, value => reminderV2(value, id, parent)),
    rewards: decode('rewards', data.rewards, value => rewardV2(value, id)) };
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) throw new Error('Invalid import count.');
  return value as number;
}

function parseOwnV2(data: Record<string, unknown>, sourceJson: string): DomainResult<OwnV2ImportDraft> {
  try {
    const collections = v2Collections(data); evidenceCandidates(collections);
    const skipped: ImportSkippedCounts = { boards: 0, checkIns: 0, reminders: 0, rewards: 0 };
    const mutable = mutableV2(collections, 'file', skipped);
    return ok({ source: 'own', exportVersion: 2, ...mutable, skipped, evidence: { sourceJson },
      settings: Object.hasOwn(data, 'settings') ? settingsV2(data.settings) : { kind: 'absent' } });
  } catch { return err('validation', 'This file has invalid version 2 data.'); }
}

// shared with synchronous command/ui capture; no stored admission authority is inferred.
export function captureOwnV2ImportDraft(value: OwnV2ImportDraft): OwnV2ImportDraft {
  const data = fields(value, ['source', 'exportVersion', 'boards', 'checkIns', 'reminders', 'rewards', 'skipped', 'settings', 'evidence']);
  if (data === null || data.source !== 'own' || data.exportVersion !== 2) throw new Error('Invalid import draft.');
  const counts = fields(data.skipped, ['boards', 'checkIns', 'reminders', 'rewards']);
  const evidence = fields(data.evidence, ['sourceJson']);
  if (counts === null || evidence === null || typeof evidence.sourceJson !== 'string') throw new Error('Invalid import draft.');
  const decoded = readOwnV2Evidence(evidence.sourceJson);
  if (!decoded.ok) throw new Error('Invalid import evidence.');
  const skipped = { boards: safeCount(counts.boards), checkIns: safeCount(counts.checkIns),
    reminders: safeCount(counts.reminders), rewards: safeCount(counts.rewards) };
  const mutable = mutableV2({ boards: array(data.boards), checkIns: array(data.checkIns),
    reminders: array(data.reminders), rewards: array(data.rewards) }, 'draft', skipped);
  const setting = fields(data.settings, ['kind']);
  if (setting === null || !['valid', 'absent', 'invalid'].includes(setting.kind as string)) throw new Error('Invalid import settings.');
  const settings = setting.kind === 'valid' ? settingsV2(fields(data.settings, ['value'])?.value)
    : { kind: setting.kind as 'absent' | 'invalid' };
  return { source: 'own', exportVersion: 2, ...mutable, skipped, settings, evidence: { sourceJson: evidence.sourceJson } };
}

export function getImportPreview(draft: ImportDraft): DomainResult<ImportPreview> {
  try {
    if (draft.exportVersion !== 2) return ok({ boards: draft.boards.length, checkIns: draft.checkIns.length,
      reminders: draft.reminders.length, rewards: 0, habitActions: 0, coinLedger: 0 });
    const evidence = readOwnV2Evidence(draft.evidence.sourceJson);
    if (!evidence.ok) return evidence;
    return ok({ boards: safeCount(draft.boards.length + safeCount(draft.skipped.boards)),
      checkIns: safeCount(draft.checkIns.length + safeCount(draft.skipped.checkIns)),
      reminders: safeCount(draft.reminders.length + safeCount(draft.skipped.reminders)),
      rewards: safeCount(draft.rewards.length + safeCount(draft.skipped.rewards)),
      habitActions: evidence.value.filter(row => row.factType === 'habit_action').length,
      coinLedger: evidence.value.filter(row => row.factType === 'ledger_entry').length });
  } catch { return err('validation', 'This import preview is invalid.'); }
}
