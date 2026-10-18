import './runtime';
import { createEconomicDayCloseResolver } from '../../src/core/calendar/economic-day-close';
import { currentLogicalDate } from '../../src/core/calendar/logical-date';
import boundaries from '../../src/core/calendar/fixtures/economic-day-close.json';
import historical from '../../src/core/calendar/fixtures/hermes-historical.json';
import type { LogicalDate } from '../../src/core/domain/ids';

const failures: string[] = [];
for (const vector of boundaries) {
  const actual = createEconomicDayCloseResolver(vector.zone)(vector.date as LogicalDate, vector.shift);
  if (actual !== vector.expectedUtcMs) failures.push(`${vector.zone}/${vector.date}: ${actual}`);
}
for (const vector of historical.cases) {
  if (currentLogicalDate(vector.instant, historical.timeZoneId, 0) !== vector.expected) failures.push(vector.expected);
}
const utf8 = [
  ['', []], ['a\0é', [97, 0, 195, 169]], ['\ud800', [239, 191, 189]],
  ['\udc00', [239, 191, 189]], ['\ud83d\ude00', [240, 159, 152, 128]],
] as const;
for (const [source, expected] of utf8) {
  if (JSON.stringify([...new TextEncoder().encode(source)]) !== JSON.stringify(expected)) failures.push('utf8 mismatch');
}
(globalThis as typeof globalThis & { parityFailures: string[] }).parityFailures = failures;
