import type { WidgetBoardRow } from '@/core/domain/entities';

export { nextWidgetRefreshUtc } from '@/core/calendar/widget-refresh';

// props handed to the widget timeline; rows follow active home order and
// carry everything a family needs to render without ad hoc queries
export type WidgetRowProps = {
  boardId: string;
  kind: WidgetBoardRow['kind'];
  title: string;
  symbol: string;
  accentHex: string;
  checkedToday: boolean;
  // seven logical days ending today; daily values are binary, count values are counts.
  strip: number[];
};

export type BoardsWidgetProps = {
  rows: WidgetRowProps[];
  // set on the entry after the next logical-day boundary: the strip may be
  // stale, and accessibility asks to open the app to refresh
  stale: boolean;
};

// spec row budgets per home screen family
export const WIDGET_ROW_LIMITS = {
  systemSmall: 1,
  systemMedium: 3,
  systemLarge: 7,
  systemExtraLarge: 12,
} as const;

const MAX_ROWS = WIDGET_ROW_LIMITS.systemExtraLarge;

export function widgetPropsFromProjection(rows: WidgetBoardRow[]): BoardsWidgetProps {
  return {
    rows: rows.slice(0, MAX_ROWS).map((row) => ({
      boardId: row.boardId,
      kind: row.kind,
      title: row.title,
      symbol: row.symbol,
      accentHex: row.accentHex,
      checkedToday: row.strip[row.strip.length - 1] > 0,
      strip: row.kind === 'daily' ? row.strip.map((count) => count > 0 ? 1 : 0) : row.strip,
    })),
    stale: false,
  };
}
