import { act } from '@testing-library/react-native';
import { getMockContext } from 'expo-router/testing-library';
import { createBoard } from '@/core/domain/commands';
import type { PendingMissAlertRequest } from '@/core/domain/ports';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { missAlertScheduler, notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { renderRouter, screen, settle } from '@/testing/render';

// load the complete actual route modules before interaction-test deadlines begin.
const actualRoutes = getMockContext('src/app');
for (const key of actualRoutes.keys()) actualRoutes(key);

async function seed() {
  const opened = await getProductCore(); if (!opened.ok) throw Error('expected core');
  mockClock.utcMs = Date.UTC(2026, 7, 1, 12);
  const result = await createBoard(opened.value, { commandId: newCommandId(), title: 'Miss count', kind: 'daily', symbol: 'book.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true });
  if (!result.ok) throw Error('expected board');
  mockClock.utcMs = Date.UTC(2026, 7, 30, 12);
  return { core: opened.value, boardId: result.value.boardId };
}

describe('pending miss alert Settings', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); notificationsPlatformMock.reset(); });

  it('shows the actual exact-id pending count and refreshes on delivery without counting historical SQL statuses', async () => {
    const { core, boardId } = await seed();
    const pending: PendingMissAlertRequest[] = [];
    for (let day = 20; day <= 25; day++) {
      const date = `2026-08-${day}`;
      const identifier = `habit-system.miss.v1:${boardId}:${date}`;
      const status = day === 23 ? 'denied' : day === 24 ? 'error' : 'scheduled';
      const nativeId = day === 23 || day === 24 ? null : identifier;
      await core.db.runAsync('INSERT INTO miss_alerts VALUES (?, ?, ?, ?)', [boardId, date, nativeId, status]);
      if (day !== 25) pending.push({ identifier, content: null, nextFireAtUtcMs: mockClock.utcMs + 60_000, acceptance: 'confirmed' });
    }
    jest.spyOn(missAlertScheduler, 'pendingRequests').mockImplementation(async () => [...pending, pending[0]]);
    renderRouter('src/app', { initialUrl: '/settings/notifications' });
    await screen.findByTestId('notifications-miss-count'); await settle();
    expect(screen.getByTestId('notifications-miss-count')).toHaveTextContent(/^Pending miss alerts3$/);
    const before = await core.db.getAllAsync('SELECT * FROM miss_alerts WHERE second_missed_date <= ?', ['2026-08-25']);
    pending.splice(1, 1);
    act(() => notificationsPlatformMock.emitDelivery()); await settle();
    expect(screen.getByTestId('notifications-miss-count')).toHaveTextContent(/^Pending miss alerts2$/);
    expect(await core.db.getAllAsync('SELECT * FROM miss_alerts WHERE second_missed_date <= ?', ['2026-08-25'])).toEqual(before);
  });

  it('shows unavailable, never zero or private native text, after an inventory failure', async () => {
    await seed();
    jest.spyOn(missAlertScheduler, 'pendingRequests').mockRejectedValue(new Error('private native SQLite path'));
    renderRouter('src/app', { initialUrl: '/settings/notifications' });
    await screen.findByTestId('notifications-miss-count'); await settle();
    expect(screen.getByTestId('notifications-miss-count')).toHaveTextContent(/^Pending miss alertsUnavailable$/);
    expect(screen.queryByText(/private native SQLite path/)).toBeNull();
  });

  it.each(['cold', 'running'])('opens the board from a %s missed-pair tap without creating a check', async when => {
    const { core, boardId } = await seed();
    const destination = { kind: 'board' as const, boardId };
    if (when === 'cold') notificationsPlatformMock.initialDestination = destination;
    renderRouter('src/app', { initialUrl: '/settings/notifications' });
    await settle(); await settle();
    if (when === 'running') act(() => notificationsPlatformMock.emitDestination(destination));
    await settle(); await settle();
    expect(screen).toHavePathname(`/boards/${boardId}`);
    expect(await core.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    expect(await core.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
  });
});
