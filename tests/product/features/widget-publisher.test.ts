import { addUserInteractionListener } from 'expo-widgets';

import cases from '@/core/automations/fixtures/widget-refresh.json';
import type { WidgetBoardRow } from '@/core/domain/entities';
import { addWidgetQuickActionListener, refreshWidgets } from '@/platform/widgets/index.ios';
import widget from '@/platform/widgets/boards-widget';

jest.mock('expo-widgets', () => ({ addUserInteractionListener: jest.fn() }));
jest.mock('@/platform/widgets/boards-widget', () => ({
  __esModule: true, default: { updateTimeline: jest.fn() },
}));

describe('native widget publisher adapter', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it.each(cases.boundaryCases)('publishes prepared timestamps unchanged at $name', async (entry) => {
    const props = { rows: cases.propsCases.map((item) => item.expected), stale: false };
    await refreshWidgets({
      generatedAtUtc: entry.nowUtcMs, expiresAtUtc: entry.expectedExpiresAtUtc,
      rows: cases.propsCases.map((item) => item.row as WidgetBoardRow),
    });
    expect(widget.updateTimeline).toHaveBeenCalledWith([
      { date: new Date(entry.nowUtcMs), props },
      { date: new Date(entry.expectedExpiresAtUtc), props: { ...props, stale: true } },
    ]);
  });

  it('keeps publication failure from failing an app mutation', async () => {
    jest.mocked(widget.updateTimeline).mockImplementationOnce(() => { throw new Error('extension unavailable'); });
    await expect(refreshWidgets({ rows: [], generatedAtUtc: 1, expiresAtUtc: 2 })).resolves.toBeUndefined();
  });

  it('forwards only quick events and disposes the native subscription', () => {
    const remove = jest.fn();
    jest.mocked(addUserInteractionListener).mockReturnValue({ remove });
    const handler = jest.fn();
    const dispose = addWidgetQuickActionListener(handler);
    const receive = jest.mocked(addUserInteractionListener).mock.calls[0][0];
    const event = { source: 'HabitSystemBoards', target: 'quick:board-id' };
    receive(event as Parameters<typeof receive>[0]);
    receive({ ...event, target: 'open:board-id' } as Parameters<typeof receive>[0]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('board-id');
    dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
