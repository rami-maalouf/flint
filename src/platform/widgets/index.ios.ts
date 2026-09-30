import { addUserInteractionListener } from 'expo-widgets';

import type { WidgetProjectionSnapshot } from '@/core/domain/widget-projection';
import { widgetPropsFromProjection } from '@/features/widgets/widget-props';

import HabitSystemBoardsWidget from './boards-widget';

// pushes the current widget projection into the widget timeline: one entry
// now, and one stale-marked entry past the next logical-day boundary so an
// unrefreshed widget asks to be opened instead of showing wrong days
export async function refreshWidgets(snapshot: WidgetProjectionSnapshot): Promise<void> {
  try {
    const props = widgetPropsFromProjection(snapshot.rows);
    HabitSystemBoardsWidget.updateTimeline([
      { date: new Date(snapshot.generatedAtUtc), props },
      { date: new Date(snapshot.expiresAtUtc), props: { ...props, stale: true } },
    ]);
  } catch {
    // widget refresh is best effort; the app itself stays authoritative
  }
}

// widget quick-action button presses arrive as interaction events with a
// `quick:<boardId>` target
export function addWidgetQuickActionListener(handler: (boardId: string) => void): () => void {
  const subscription = addUserInteractionListener((event) => {
    if (typeof event.target === 'string' && event.target.startsWith('quick:')) {
      handler(event.target.slice('quick:'.length));
    }
  });
  return () => subscription.remove();
}
