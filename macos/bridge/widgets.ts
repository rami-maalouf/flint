import { nextWidgetRefreshUtc } from '../../src/core/calendar/widget-refresh';
import { getHomeBoardProjection, getBoardHeatmap, getBoardSummary } from '../../src/core/domain/queries';
import { getCoinTotals } from '../../src/core/domain/coin-queries';
import { deps } from './runtime';

export async function getWidgetSnapshot(environment: unknown = 'Development') {
  if (environment !== 'Development' && environment !== 'Production') {
    return { ok: false, error: { code: 'validation', message: 'Unknown widget environment.', retryable: false } };
  }
  // freeze the query clock so a day boundary cannot split one published snapshot.
  const generatedAtUtc = deps.clock.nowUtcMs();
  const timeZoneID = deps.clock.timeZoneId();
  const queryDeps = { ...deps, clock: { nowUtcMs: () => generatedAtUtc, timeZoneId: () => timeZoneID } };
  const cards = await getHomeBoardProjection(queryDeps);
  if (!cards.ok) return cards;
  const coins = await getCoinTotals(queryDeps);
  if (!coins.ok) return coins;
  const habits = [];
  for (const card of cards.value) {
    const heatmap = await getBoardHeatmap(queryDeps, card.board.id);
    if (!heatmap.ok) return heatmap;
    const summary = await getBoardSummary(queryDeps, card.board.id);
    if (!summary.ok) return summary;
    if (!heatmap.value || !summary.value) continue;
    const weeks = heatmap.value.weeks.map(week => week.days);
    const todayCount = weeks.flat().find(day => day.isToday)?.count ?? 0;
    habits.push({ id: card.board.id, title: card.board.title, symbol: card.board.symbol,
      accentHex: card.board.accentHex, kind: card.board.kind, logicalDate: card.today,
      checkedToday: card.daily?.checkedToday ?? todayCount > 0, todayCount,
      currentStreak: card.board.metricsEnabled ? summary.value.currentStreak : null, weeks });
  }
  return { ok: true, value: { schemaVersion: 1, environment, generatedAtUtc,
    expiresAtUtc: nextWidgetRefreshUtc(generatedAtUtc, timeZoneID, cards.value.map(card => card.board.startOfDayMinute)),
    timeZoneID, balance: coins.value.balance, habits } };
}
