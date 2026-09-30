import { addDays, currentLogicalDate, isValidLogicalDate, localDateOfInstant, localWallClock } from '../calendar/logical-date';
import { isDateEligible, type ActivityPeriodRange } from '../calendar/periods';
import type { Board } from './entities';
import { isUuidV4, type BoardId, type LogicalDate } from './ids';
import type { FuturePendingMissAlertRequest, MissAlertPair, MissAlertRequest, MissAlertTrigger, PendingMissAlertRequest } from './ports';

export type MissAlertBoard = Pick<Board,
  'id' | 'kind' | 'title' | 'startOfDayMinute' | 'archivedAt' | 'deletedAt'>;
export type MissAlertBoardEvidence = Readonly<{
  board: MissAlertBoard;
  periods: ActivityPeriodRange[];
  effectiveCheckedDates: LogicalDate[];
}>;
export type MissAlertTime = Readonly<{ nowUtcMs: number; timeZoneId: string; foreground: boolean }>;
export type MissAlertCandidate = MissAlertPair & Readonly<{ firstMissedDate: LogicalDate; title: string }>;

const PREFIX = 'habit-system.miss.v1:';
const body = (title: string) => `${title} was missed twice. Fix the environment before anything else today.`;
const activeDaily = (board: MissAlertBoard) => board.kind === 'daily' && board.archivedAt === null && board.deletedAt === null;

export function isMissAlertIdentifierFamily(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function missAlertIdentifier(pair: MissAlertPair): string {
  return `${PREFIX}${pair.boardId}:${pair.secondMissedDate}`;
}

export function parseMissAlertIdentifier(value: unknown): MissAlertPair | null {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  const [boardId, date] = parts;
  // preserve exact stored identity, including uppercase hex, and reject trailing newlines.
  if (boardId.length !== 36 || !isUuidV4(boardId) || date.length !== 10 || !isValidLogicalDate(date)) return null;
  return { boardId: boardId as BoardId, secondMissedDate: date };
}

export function isMissAlertPairValid(pair: MissAlertPair, evidence: MissAlertBoardEvidence | null, time: MissAlertTime): boolean {
  if (!evidence || evidence.board.id !== pair.boardId || !activeDaily(evidence.board)) return false;
  const today = currentLogicalDate(time.nowUtcMs, time.timeZoneId, evidence.board.startOfDayMinute);
  const first = addDays(pair.secondMissedDate, -1);
  if (!isValidLogicalDate(first) || pair.secondMissedDate >= today) return false;
  return [first, pair.secondMissedDate].every(date => isDateEligible(date, evidence.periods, today) &&
    !evidence.effectiveCheckedDates.includes(date));
}

export function planMissAlertPair(evidence: MissAlertBoardEvidence, time: MissAlertTime): MissAlertCandidate | null {
  if (!activeDaily(evidence.board)) return null;
  const today = currentLogicalDate(time.nowUtcMs, time.timeZoneId, evidence.board.startOfDayMinute);
  const secondMissedDate = addDays(today, -1);
  if (!isValidLogicalDate(secondMissedDate)) return null;
  const pair = { boardId: evidence.board.id, secondMissedDate };
  return isMissAlertPairValid(pair, evidence, time)
    ? { ...pair, firstMissedDate: addDays(secondMissedDate, -1), title: evidence.board.title } : null;
}

export function planMissAlertTrigger(time: MissAlertTime): MissAlertTrigger {
  const local = localWallClock(time.nowUtcMs, time.timeZoneId);
  const date = localDateOfInstant(time.nowUtcMs, time.timeZoneId);
  if (local.hour < 9) return { kind: 'local09', date };
  if (time.foreground) return { kind: 'immediate' };
  const tomorrow = addDays(date, 1);
  if (!isValidLogicalDate(tomorrow)) throw new RangeError('miss alert date outside supported range');
  return { kind: 'local09', date: tomorrow };
}

export function createMissAlertRequest(candidate: MissAlertCandidate, time: MissAlertTime): MissAlertRequest {
  return { boardId: candidate.boardId, secondMissedDate: candidate.secondMissedDate,
    identifier: missAlertIdentifier(candidate), title: candidate.title, body: body(candidate.title),
    trigger: planMissAlertTrigger(time), timeZoneId: time.timeZoneId };
}

export function futurePendingMissAlert(pending: PendingMissAlertRequest, nowUtcMs: number): FuturePendingMissAlertRequest | null {
  const { identifier, content, nextFireAtUtcMs, acceptance } = pending;
  const pair = parseMissAlertIdentifier(identifier);
  if (!pair || !content || nextFireAtUtcMs === null || !Number.isFinite(nextFireAtUtcMs) ||
    !Number.isFinite(nowUtcMs) || nextFireAtUtcMs <= nowUtcMs ||
    (acceptance !== 'confirmed' && acceptance !== 'unconfirmed')) return null;
  if (content.identifier !== identifier || content.boardId !== pair.boardId ||
    content.secondMissedDate !== pair.secondMissedDate || typeof content.title !== 'string' ||
    content.body !== body(content.title)) return null;
  return { identifier, nextFireAtUtcMs, acceptance,
    content: { ...pair, identifier, title: content.title, body: content.body } };
}
