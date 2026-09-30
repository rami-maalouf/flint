import { act } from '@testing-library/react-native';
import { AppState, Platform, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { createBoard } from '@/core/domain/commands';
import type { MissAlertRequest, MissAlertScheduler, PendingMissAlertRequest } from '@/core/domain/ports';
import { ProductProvider, useProduct } from '@/features/product-store';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { renderComponent, screen, settle } from '@/testing/render';
import { notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import * as notificationPlatform from '@/testing/notifications-platform.mock';

function scheduler() {
  const pending = new Map<string, PendingMissAlertRequest>();
  const port: MissAlertScheduler = {
    authorization: jest.fn(async () => 'granted' as const),
    pendingRequests: jest.fn(async () => [...pending.values()]),
    presentedIdentifiers: jest.fn(async () => []),
    schedule: jest.fn(async (request: MissAlertRequest) => {
      pending.set(request.identifier, { identifier: request.identifier, content: { ...request },
        nextFireAtUtcMs: Date.UTC(2026, 7, 30, 13), acceptance: 'confirmed' });
      return { kind: 'accepted' as const };
    }),
    refreshPending: jest.fn(async () => ({ kind: 'unchanged' as const })),
    cancel: jest.fn(async id => { pending.delete(id); return { kind: 'cancelled' as const }; }),
  };
  return { port, pending };
}

async function seeded() {
  const opened = await getProductCore();
  if (!opened.ok) throw Error('expected core');
  mockClock.zone = 'America/New_York'; mockClock.utcMs = Date.UTC(2026, 7, 28, 12);
  const result = await createBoard(opened.value, { commandId: newCommandId(), title: 'Two misses', kind: 'daily',
    symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!result.ok) throw Error('expected board');
  mockClock.utcMs = Date.UTC(2026, 7, 30, 12);
  return opened.value;
}

let invalidate = () => {};
function Probe() {
  const value = useProduct();
  useEffect(() => { invalidate = value.invalidate; }, [value.invalidate]);
  return <View><Text testID="product-revision">{value.version}</Text><Text testID="miss-revision">{value.missAlertVersion}</Text></View>;
}

describe('miss alert provider lifecycle', () => {
  const listeners = new Set<(value: string) => void>();
  beforeEach(() => {
    jest.restoreAllMocks(); jest.useFakeTimers(); resetProductCoreForTests(); notificationsPlatformMock.reset(); listeners.clear();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      listeners.add(handler as (value: string) => void);
      return { remove: () => listeners.delete(handler as (value: string) => void) };
    });
  });

  it('schedules from actual SQL once and publishes only a miss count revision', async () => {
    const core = await seeded(); const { port } = scheduler();
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(await core.db.getAllAsync('SELECT status, native_identifier FROM miss_alerts'))
      .toEqual([{ status: 'scheduled', native_identifier: expect.stringContaining('habit-system.miss.v1:') }]);
    expect(screen.getByTestId('product-revision')).toHaveTextContent('0');
    expect(Number(screen.getByTestId('miss-revision').props.children)).toBeGreaterThan(0);
    await settle(); expect(port.schedule).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it.each([null, 'unknown'])('waits for an explicit active event when initial AppState is %s', async initial => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: initial });
    const core = await seeded(); const { port } = scheduler();
    mockClock.utcMs = Date.UTC(2026, 7, 30, 16);
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    expect(port.schedule).not.toHaveBeenCalled();
    expect(await core.db.getAllAsync('SELECT * FROM miss_alerts')).toEqual([]);
    act(() => { for (const listener of listeners) listener('active'); });
    await settle(); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(jest.mocked(port.schedule).mock.calls[0][0].trigger).toEqual({ kind: 'immediate' });
    mounted.unmount();
  });

  it('does not turn retryable miss-row transitions into a product invalidation loop', async () => {
    const core = await seeded(); const { port } = scheduler();
    jest.mocked(port.schedule).mockResolvedValue({ kind: 'not_accepted', code: 'schedule_failed' });
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('product-revision')).toHaveTextContent('0');
    mockClock.utcMs += 30_000;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle();
    expect(port.schedule).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('product-revision')).toHaveTextContent('0');
    mounted.unmount();
  });

  it('coalesces a mutation while an actual accepted effect is held and keeps its receipt-like outcome', async () => {
    const core = await seeded(); const { port, pending } = scheduler();
    let release!: () => void;
    jest.mocked(port.schedule).mockImplementationOnce(async request => {
      await new Promise<void>(resolve => { release = resolve; });
      pending.set(request.identifier, { identifier: request.identifier, content: request,
        nextFireAtUtcMs: mockClock.utcMs + 3_600_000, acceptance: 'confirmed' });
      return { kind: 'accepted' };
    });
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    act(() => { invalidate(); invalidate(); });
    await act(async () => { release(); }); await settle(); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(await core.db.getAllAsync('SELECT status FROM miss_alerts')).toEqual([{ status: 'scheduled' }]);
    mounted.unmount();
  });

  it('retires a backgrounded inspection then reconciles on the next active transition', async () => {
    const core = await seeded(); const { port } = scheduler();
    let release!: (value: PendingMissAlertRequest[]) => void;
    jest.mocked(port.pendingRequests).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle();
    act(() => { for (const listener of listeners) listener('background'); });
    await act(async () => { release([]); }); await settle();
    expect(port.schedule).not.toHaveBeenCalled();
    act(() => { for (const listener of listeners) listener('active'); });
    await settle(); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    mounted.unmount();
    const reads = jest.mocked(port.pendingRequests).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(180_000); });
    expect(port.pendingRequests).toHaveBeenCalledTimes(reads);
  });

  it('refreshes the pending count at native expiry even when no delivery callback arrives', async () => {
    const core = await seeded(); const { port, pending } = scheduler();
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    const revision = Number(screen.getByTestId('miss-revision').props.children);
    pending.clear(); mockClock.utcMs += 3_600_000;
    await act(async () => { jest.advanceTimersByTime(3_600_000); }); await settle();
    expect(Number(screen.getByTestId('miss-revision').props.children)).toBeGreaterThan(revision);
    expect(screen.getByTestId('product-revision')).toHaveTextContent('0');
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(await core.db.getAllAsync('SELECT status FROM miss_alerts')).toEqual([{ status: 'scheduled' }]);
    mounted.unmount();
  });

  it('observes Android clock changes without querying SQL each ordinary minute', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const core = await seeded(); const { port } = scheduler();
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    const reads = jest.mocked(port.pendingRequests).mock.calls.length;
    const sql = jest.spyOn(core.db, 'withTransactionAsync');
    mockClock.utcMs += 60_000;
    await act(async () => { jest.advanceTimersByTime(60_000); }); await settle();
    expect(port.pendingRequests).toHaveBeenCalledTimes(reads);
    expect(sql).not.toHaveBeenCalled();
    mockClock.zone = 'America/Los_Angeles'; mockClock.utcMs += 60_000;
    await act(async () => { jest.advanceTimersByTime(60_000); }); await settle();
    expect(jest.mocked(port.pendingRequests).mock.calls.length).toBeGreaterThan(reads);
    expect(sql).toHaveBeenCalled();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    const changedZoneReads = jest.mocked(port.pendingRequests).mock.calls.length;
    mockClock.utcMs += 120_000;
    await act(async () => { jest.advanceTimersByTime(60_000); }); await settle();
    expect(jest.mocked(port.pendingRequests).mock.calls.length).toBeGreaterThan(changedZoneReads);
    mounted.unmount(); const final = jest.mocked(port.pendingRequests).mock.calls.length;
    mockClock.utcMs += 3_600_000;
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(port.pendingRequests).toHaveBeenCalledTimes(final);
  });

  it('retires a replaced native port before dispatch and lets the replacement reconcile', async () => {
    const core = await seeded(); const old = scheduler(), next = scheduler();
    let release!: (value: PendingMissAlertRequest[]) => void;
    jest.mocked(old.port.pendingRequests).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={old.port}><Probe /></ProductProvider>);
    await settle();
    mounted.rerender(<ProductProvider coreOverride={core} missAlertSchedulerOverride={next.port}><Probe /></ProductProvider>);
    await settle(); await settle();
    await act(async () => release([])); await settle();
    expect(old.port.schedule).not.toHaveBeenCalled();
    expect(next.port.schedule).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('reconciles the next closed day even when the actual widget cache transaction fails', async () => {
    const core = await seeded(); const { port } = scheduler();
    mockClock.utcMs = Date.UTC(2026, 7, 30, 4) - 1000;
    const run = core.db.runAsync.bind(core.db);
    let failures = 0;
    jest.spyOn(core.db, 'runAsync').mockImplementation((sql, params) => {
      if (sql === 'DELETE FROM widget_board_rows') { failures++; return Promise.reject(Error('cache locked')); }
      return run(sql, params);
    });
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle(); await settle();
    expect(failures).toBe(1);
    expect(port.schedule).not.toHaveBeenCalled();
    mockClock.utcMs = Date.UTC(2026, 7, 30, 4);
    await act(async () => { jest.advanceTimersByTime(1000); }); await settle();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(await core.db.getAllAsync('SELECT second_missed_date, status FROM miss_alerts'))
      .toEqual([{ second_missed_date: '2026-08-29', status: 'scheduled' }]);
    expect(screen.getByTestId('product-revision')).toHaveTextContent('0');
    mounted.unmount();
  });

  it('ignores a late cold-start response and queued tap after provider retirement', async () => {
    const core = await seeded(); const { port } = scheduler();
    let release!: (value: { kind: 'board'; boardId: string }) => void;
    jest.spyOn(notificationPlatform, 'getInitialNotificationDestination').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const push = jest.spyOn(router, 'push').mockImplementation(() => {});
    const mounted = renderComponent(<ProductProvider coreOverride={core} missAlertSchedulerOverride={port}><Probe /></ProductProvider>);
    await settle();
    const queued = [...notificationsPlatformMock.destinationHandlers];
    mounted.unmount();
    const destination = { kind: 'board' as const, boardId: '00000000-0000-4000-8000-000000000001' };
    await act(async () => { release(destination); queued.forEach(callback => callback(destination)); });
    expect(push).not.toHaveBeenCalled();
    expect(notificationsPlatformMock.destinationHandlers.size).toBe(0);
    expect(notificationsPlatformMock.deliveryHandlers.size).toBe(0);
  });
});
