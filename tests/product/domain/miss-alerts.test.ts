import type { BoardId, LogicalDate } from '@/core/domain/ids';
import {
  createMissAlertRequest, futurePendingMissAlert, isMissAlertIdentifierFamily,
  isMissAlertPairValid, missAlertIdentifier, parseMissAlertIdentifier,
  planMissAlertPair, planMissAlertTrigger,
  type MissAlertBoardEvidence, type MissAlertTime,
} from '@/core/domain/miss-alerts';
import type { PendingMissAlertRequest } from '@/core/domain/ports';

const id = 'ABCDEF00-0000-4000-8000-000000000001' as BoardId;
const day = (value: string) => value as LogicalDate;
const pair = { boardId: id, secondMissedDate: day('2026-09-08') };
const time: MissAlertTime = { nowUtcMs: Date.parse('2026-09-09T12:00:00Z'), timeZoneId: 'America/New_York', foreground: true };
const evidence = (): MissAlertBoardEvidence => ({ board: { id, title: 'Read 漫画', kind: 'daily',
  startOfDayMinute: 0, archivedAt: null, deletedAt: null },
periods: [{ startDate: day('2026-09-01'), endDate: null }], effectiveCheckedDates: [] });

it('uses exactly two most recent closed eligible dates and builds a note-free request', () => {
  const candidate = planMissAlertPair(evidence(), time)!;
  expect(candidate).toEqual({ ...pair, firstMissedDate: '2026-09-07', title: 'Read 漫画' });
  expect(createMissAlertRequest(candidate, time)).toEqual({ ...pair,
    identifier: `habit-system.miss.v1:${id}:2026-09-08`, title: 'Read 漫画',
    body: 'Read 漫画 was missed twice. Fix the environment before anything else today.',
    timeZoneId: 'America/New_York', trigger: { kind: 'local09', date: '2026-09-09' } });
});

it.each([['2026-09-07'], ['2026-09-08'], ['2026-09-07', '2026-09-07']].map(checked => ({ checked })))('a surviving effective token prevents a miss: %j', ({ checked }) => {
  expect(planMissAlertPair({ ...evidence(), effectiveCheckedDates: checked.map(day) }, time)).toBeNull();
});
it('ignores unrelated checked dates and stack/earning metadata', () => {
  const source = evidence();
  const board = { ...source.board, requiredInStack: false, earnsCoins: false,
    anchorBoardId: '00000000-0000-4000-8000-000000000099', usualTimeMinute: 1380 };
  expect(planMissAlertPair({ ...source, board, effectiveCheckedDates: [day('2026-09-06'), day('2026-09-09')] }, time)).toMatchObject(pair);
});
it.each([{ kind: 'count' as const }, { archivedAt: 0 }, { deletedAt: 0 }])('does not target inactive or Count boards: %j', change => {
  const source = evidence();
  expect(planMissAlertPair({ ...source, board: { ...source.board, ...change } }, time)).toBeNull();
  expect(isMissAlertPairValid(pair, { ...source, board: { ...source.board, ...change } }, time)).toBe(false);
});
it.each([
  [], [{ startDate: day('2026-09-08'), endDate: null }],
  [{ startDate: day('2026-09-09'), endDate: day('2026-09-01') }],
  [{ startDate: day('2026-09-01'), endDate: day('2026-09-06') }, { startDate: day('2026-09-08'), endDate: null }],
].map(periods => ({ periods })))('never skips a pre-creation or archived gap to find two older misses', ({ periods }) => {
  expect(planMissAlertPair({ ...evidence(), periods }, time)).toBeNull();
});
it('uses inclusive endpoints, same-day restore and overlapping ranges', () => {
  expect(planMissAlertPair({ ...evidence(), periods: [
    { startDate: day('2026-09-07'), endDate: day('2026-09-07') },
    { startDate: day('2026-09-08'), endDate: day('2026-09-08') },
    { startDate: day('2026-09-08'), endDate: null },
  ] }, time)).toMatchObject(pair);
});
it.each([
  [0, '2026-09-09T03:59:59Z', '2026-09-07'], [0, '2026-09-09T04:00:00Z', '2026-09-08'],
  [240, '2026-09-09T07:59:59Z', '2026-09-07'], [240, '2026-09-09T08:00:00Z', '2026-09-08'],
  [720, '2026-09-09T15:59:59Z', '2026-09-07'], [720, '2026-09-09T16:00:00Z', '2026-09-08'],
])('uses the board own shift %s at %s', (shift, instant, second) => {
  const source = evidence();
  expect(planMissAlertPair({ ...source, board: { ...source.board, startOfDayMinute: shift } },
    { ...time, nowUtcMs: Date.parse(instant) })).toMatchObject({ secondMissedDate: second });
});
it.each([
  ['2026-03-08T06:59:00Z', 120, '2026-03-06'], ['2026-03-08T07:00:00Z', 120, '2026-03-07'],
  ['2026-11-01T05:45:00Z', 90, '2026-10-31'], ['2026-11-01T06:15:00Z', 90, '2026-10-30'],
  ['2026-11-01T06:30:00Z', 90, '2026-10-31'],
])('retains civil-label behavior across gap/fold: %s', (instant, shift, second) => {
  const source = evidence();
  source.periods[0].startDate = day('2026-01-01');
  expect(planMissAlertPair({ ...source, board: { ...source.board, startOfDayMinute: shift } },
    { ...time, nowUtcMs: Date.parse(instant) })).toMatchObject({ secondMissedDate: second });
});
it('old truthful pairs survive time passing, while backfill and reopening invalidate them', () => {
  expect(isMissAlertPairValid(pair, evidence(), { ...time, nowUtcMs: Date.parse('2026-09-20T12:00:00Z') })).toBe(true);
  expect(isMissAlertPairValid(pair, { ...evidence(), effectiveCheckedDates: [pair.secondMissedDate] }, time)).toBe(false);
  expect(isMissAlertPairValid(pair, evidence(), { ...time, timeZoneId: 'Pacific/Honolulu', nowUtcMs: Date.parse('2026-09-09T05:00:00Z') })).toBe(false);
  expect(isMissAlertPairValid(pair, null, time)).toBe(false);
  expect(isMissAlertPairValid({ ...pair, boardId: '00000000-0000-4000-8000-000000000002' as BoardId }, evidence(), time)).toBe(false);
});
it('does not fabricate dates before the supported civil calendar', () => {
  const source = evidence(); source.periods[0].startDate = day('0000-01-01');
  for (const instant of ['0000-01-01T12:00:00Z', '0000-01-02T12:00:00Z'])
    expect(planMissAlertPair(source, { ...time, nowUtcMs: Date.parse(instant), timeZoneId: 'UTC' })).toBeNull();
  expect(isMissAlertPairValid({ ...pair, secondMissedDate: day('0000-01-01') }, source, time)).toBe(false);
});
it.each([
  ['2026-09-09T12:59:59Z', true, { kind: 'local09', date: '2026-09-09' }],
  ['2026-09-09T13:00:00Z', true, { kind: 'immediate' }],
  ['2026-09-09T23:00:00Z', true, { kind: 'immediate' }],
  ['2026-09-09T13:00:00Z', false, { kind: 'local09', date: '2026-09-10' }],
  ['2026-09-09T12:00:00Z', false, { kind: 'local09', date: '2026-09-09' }],
])('plans one civil 09:00 or immediate, %s foreground=%s', (instant, foreground, expected) => {
  expect(planMissAlertTrigger({ ...time, nowUtcMs: Date.parse(instant), foreground })).toEqual(expected);
});
it('refuses an unrepresentable future fire date', () => {
  expect(() => planMissAlertTrigger({ nowUtcMs: Date.parse('9999-12-31T20:00:00Z'), timeZoneId: 'UTC', foreground: false })).toThrow();
});
it('round-trips exact UUID bytes and boundary dates without changing identity', () => {
  for (const date of ['0000-02-29', '2026-09-08', '9999-12-31']) {
    const value = { ...pair, secondMissedDate: day(date) };
    expect(parseMissAlertIdentifier(missAlertIdentifier(value))).toEqual(value);
  }
});
it.each([null, 7, [], 'other:abc', 'habit-system.miss.v1:', `habit-system.miss.v1:${id}:2026-02-30`,
  `habit-system.miss.v1:${id}:2026-09-08:extra`, `habit-system.miss.v1:${id}:2026-09-08\n`,
  `habit-system.miss.v1:${id}\n:2026-09-08`, `habit-system.miss.v1:not-a-uuid:2026-09-08`, `habit-system.miss.v1:${id.replace("-4000-", "-5000-")}:2026-09-08`,
])('rejects malformed identifier while retaining broad namespace visibility: %j', input => {
  expect(parseMissAlertIdentifier(input)).toBeNull();
  expect(isMissAlertIdentifierFamily(input)).toBe(typeof input === 'string' && input.startsWith('habit-system.miss.v1:'));
});
function pending(): PendingMissAlertRequest {
  const request = createMissAlertRequest(planMissAlertPair(evidence(), time)!, time);
  return { identifier: request.identifier, content: request, nextFireAtUtcMs: time.nowUtcMs + 60000, acceptance: 'unconfirmed' };
}
it('captures a future pending observation without promoting its acceptance or borrowing mutable content', () => {
  const source = pending(); const captured = futurePendingMissAlert(source, time.nowUtcMs)!;
  expect(captured.acceptance).toBe('unconfirmed');
  expect(captured.content).not.toBe(source.content);
  expect(futurePendingMissAlert({ ...source, acceptance: 'confirmed' }, time.nowUtcMs)?.acceptance).toBe('confirmed');
});
it.each([
  { content: null }, { identifier: 'ordinary-reminder' }, { nextFireAtUtcMs: null },
  { nextFireAtUtcMs: Infinity }, { nextFireAtUtcMs: time.nowUtcMs }, { nextFireAtUtcMs: time.nowUtcMs - 1 },
  { acceptance: 'invented' },
])('withholds pending refresh authority for %j', change => {
  expect(futurePendingMissAlert({ ...pending(), ...change } as PendingMissAlertRequest, time.nowUtcMs)).toBeNull();
});
it('rejects mismatched native content and an invalid observation clock', () => {
  const source = pending(); const content = source.content!;
  for (const change of [{ identifier: 'bad' }, { boardId: 'wrong' }, { secondMissedDate: '2026-09-07' },
    { title: 7 }, { body: 'wrong content' }]) {
    expect(futurePendingMissAlert({ ...source, content: { ...content, ...change } } as PendingMissAlertRequest, time.nowUtcMs)).toBeNull();
  }
  expect(futurePendingMissAlert(source, NaN)).toBeNull();
});
