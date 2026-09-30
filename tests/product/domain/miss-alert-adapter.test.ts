import { Platform } from 'react-native';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import type { MissAlertEffectContext, MissAlertRequest, MissAlertScheduler } from '@/core/domain/ports';
import { createReminder } from '@/core/domain/reminder-commands';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness } from '../helpers/test-db';
import shared from '@/core/automations/fixtures/miss-alert-contract.json';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(), getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn(), getPresentedNotificationsAsync: jest.fn(),
  getNextTriggerDateAsync: jest.fn(), scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(), addNotificationReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(), clearLastNotificationResponse: jest.fn(),
  SchedulableTriggerInputTypes: { WEEKLY: 'weekly', CALENDAR: 'calendar', DAILY: 'daily', DATE: 'date' },
}));

const native = jest.requireMock<Record<string, jest.Mock>>('expo-notifications');
const { missAlertScheduler: adapter } = jest.requireActual<{ missAlertScheduler: MissAlertScheduler }>(
  '../../../src/platform/notifications/index');
const boardId = '00000000-0000-4000-8000-00000000A001' as BoardId;
const secondMissedDate = '2026-01-08' as LogicalDate;
const identifier = `habit-system.miss.v1:${boardId}:${secondMissedDate}`;
const title = 'Café pause';
const body = 'Café pause was missed twice. Fix the environment before anything else today.';
const content = { title, body, data: { boardId, secondMissedDate } };
const fire = Date.UTC(2026, 0, 9, 14);
const calendar = { type: 'calendar', repeats: false, dateComponents: {
  year: 2026, month: 1, day: 9, hour: 9, minute: 0, second: 0,
  calendar: 'iso8601', timeZone: null, isLeapMonth: false, isRepeatedDay: false,
} };
const request = (): MissAlertRequest => ({ identifier, boardId, secondMissedDate, title, body,
  trigger: { kind: 'local09', date: '2026-01-09' as LogicalDate }, timeZoneId: 'America/New_York' });
let now: number;
const context = (): MissAlertEffectContext => ({
  clock: { nowUtcMs: () => now, timeZoneId: () => 'America/New_York' },
  isCurrent: () => true, isForeground: () => true,
});

describe('actual miss notification adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    now = fire - 60 * 60_000;
    native.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    native.getAllScheduledNotificationsAsync.mockResolvedValue([]);
    native.getPresentedNotificationsAsync.mockResolvedValue([]);
    native.getNextTriggerDateAsync.mockResolvedValue(fire);
    native.scheduleNotificationAsync.mockImplementation(async input => input.identifier);
    native.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  });

  it('submits exact captured content and an unpinned one-shot January calendar on ios', async () => {
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'accepted' });
    expect(native.scheduleNotificationAsync).toHaveBeenCalledWith({ identifier,
      content: { ...content, sound: 'default' },
      trigger: { type: 'calendar', year: 2026, month: 1, day: 9, hour: 9, minute: 0, second: 0, repeats: false } });
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('uses Android DAILY only as a resolver, then submits one DATE', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'accepted' });
    expect(native.getNextTriggerDateAsync).toHaveBeenCalledWith({ type: 'daily', hour: 9, minute: 0 });
    expect(native.scheduleNotificationAsync.mock.calls[0][0].trigger).toEqual({ type: 'date', date: fire });
  });

  it('retains native identifiers and old captured content while distinguishing acceptance evidence', async () => {
    native.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier, content, trigger: calendar },
      { identifier: 'ordinary', content: { data: { boardId, reminderId: 'r' } }, trigger: { type: 'weekly' } },
      { identifier: 'habit-system.miss.v1:malformed', content, trigger: null },
    ]);
    expect(await adapter.pendingRequests()).toEqual([
      { identifier, content: { identifier, title, body, boardId, secondMissedDate }, nextFireAtUtcMs: fire, acceptance: 'confirmed' },
      { identifier: 'ordinary', content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' },
      { identifier: 'habit-system.miss.v1:malformed', content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' },
    ]);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content,
      trigger: { type: 'date', repeats: false, value: fire } }]);
    expect(await adapter.pendingRequests()).toEqual([{ identifier,
      content: { identifier, title, body, boardId, secondMissedDate }, nextFireAtUtcMs: fire, acceptance: 'unconfirmed' }]);
  });

  it.each(['ios', 'android'] as const)('does not add an already present exact request on %s', async os => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content,
      trigger: os === 'ios' ? calendar : { type: 'date', repeats: false, value: fire } }]);
    expect(await adapter.schedule(request(), context())).toEqual({ kind: os === 'ios' ? 'accepted' : 'unknown' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'] as const)('classifies the same native scheduling code using %s acceptance guarantees', async os => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    native.scheduleNotificationAsync.mockRejectedValue(Object.assign(new Error('private device path'), {
      code: 'ERR_NOTIFICATIONS_FAILED_TO_SCHEDULE',
    }));
    expect(await adapter.schedule(request(), context())).toEqual(os === 'ios'
      ? { kind: 'not_accepted', code: 'schedule_failed' } : { kind: 'unknown' });
  });

  it('refuses capacity before a native add and never prompts', async () => {
    native.getAllScheduledNotificationsAsync.mockResolvedValue(Array.from({ length: 64 }, (_, i) => ({ identifier: `ordinary-${i}` })));
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'not_accepted', code: 'capacity' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('retires during native inspection without dispatching', async () => {
    let release!: (rows: unknown[]) => void;
    native.getAllScheduledNotificationsAsync.mockReturnValue(new Promise(resolve => { release = resolve; }));
    let current = true;
    const run = adapter.schedule(request(), { ...context(), isCurrent: () => current });
    await Promise.resolve(); await Promise.resolve();
    current = false;
    release([]);
    expect(await run).toEqual({ kind: 'retired' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('crossing 09:00 while resolving submits immediate with the same identity', async () => {
    native.getNextTriggerDateAsync.mockImplementation(async () => { now = fire; return fire; });
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'accepted' });
    expect(native.scheduleNotificationAsync.mock.calls[0][0]).toMatchObject({ identifier, trigger: null });
  });

  it('preserves factual native success after retirement during add', async () => {
    let current = true;
    native.scheduleNotificationAsync.mockImplementation(async () => { current = false; return identifier; });
    expect(await adapter.schedule(request(), { ...context(), isCurrent: () => current })).toEqual({ kind: 'accepted' });
  });

  it('sanitizes inspection failures and exposes presented ids without a permission request', async () => {
    native.getPresentedNotificationsAsync.mockResolvedValue([{ request: { identifier } }]);
    expect(await adapter.presentedIdentifiers()).toEqual([identifier]);
    native.getAllScheduledNotificationsAsync.mockRejectedValue(new Error('private device path'));
    await expect(adapter.pendingRequests()).rejects.not.toThrow('private device path');
    native.getPermissionsAsync.mockRejectedValue(new Error('private authorization path'));
    await expect(adapter.authorization()).rejects.not.toThrow('private authorization path');
  });

  it.each([0, 1, 2, 3, 4])('matches ios authorization status %s without prompting', async status => {
    native.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, ios: { status } });
    expect(await adapter.authorization()).toBe(status === 2 ? 'granted' : status === 1 ? 'denied' : 'undetermined');
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([
    { ...content, data: { boardId } },
    { ...content, data: { boardId, secondMissedDate, reminderId: 'not-miss' } },
    { ...content, data: { boardId: boardId.toLowerCase(), secondMissedDate } },
    { ...content, body: body.normalize('NFD') },
  ])('retains malformed owned content as null', async malformed => {
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content: malformed, trigger: calendar }]);
    expect(await adapter.pendingRequests()).toEqual([{ identifier, content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' }]);
  });

  it('rejects inherited payload identities with two unrelated own keys for both pending evidence and taps', async () => {
    const platform = jest.requireActual<typeof import('../../../src/platform/notifications/index')>('../../../src/platform/notifications/index');
    const data = Object.assign(Object.create({ boardId, secondMissedDate }), { extraA: 'one', extraB: 'two' });
    const raw = { identifier, content: { ...content, data }, trigger: calendar };
    native.getAllScheduledNotificationsAsync.mockResolvedValue([raw]);
    expect({ pending: await adapter.pendingRequests(),
      destination: platform.notificationDestinationFromResponse({ notification: { request: raw } } as never) }).toEqual({
      pending: [{ identifier, content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' }], destination: null,
    });
  });

  it('captures request and method receivers before inventory waits', async () => {
    let release!: (rows: unknown[]) => void;
    native.getAllScheduledNotificationsAsync.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const input = request();
    const clock = { current: now, zone: 'America/New_York', nowUtcMs() { return this.current; }, timeZoneId() { return this.zone; } };
    const guard = { current: true, clock, isCurrent() { return this.current; }, isForeground() { return this.current; } };
    const run = adapter.schedule(input, guard);
    await Promise.resolve(); await Promise.resolve();
    Object.assign(input, { title: 'changed', body: 'changed', identifier: 'changed', timeZoneId: 'UTC' });
    clock.nowUtcMs = () => 0; clock.timeZoneId = () => 'UTC'; guard.isCurrent = () => false;
    release([]);
    expect(await run).toEqual({ kind: 'accepted' });
    expect(native.scheduleNotificationAsync.mock.calls[0][0]).toMatchObject({ identifier, content });
  });

  it('unknown thrown objects cannot turn an already dispatched add into retry permission', async () => {
    native.scheduleNotificationAsync.mockRejectedValue(Object.defineProperty({}, 'code', { get() { throw Error('private'); } }));
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'unknown' });
  });

  const refresh = (retainedAcceptance: 'confirmed' | 'unresolved' = 'confirmed') => ({
    observed: { identifier, content: { identifier, title, body, boardId, secondMissedDate },
      nextFireAtUtcMs: fire, acceptance: 'unconfirmed' as const },
    replacement: request(), retainedAcceptance,
  });

  it.each(['confirmed', 'unresolved'] as const)('Android unchanged future refresh uses retained %s acceptance', async retained => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content, trigger: { type: 'date', repeats: false, value: fire } }]);
    expect(await adapter.refreshPending(refresh(retained), context())).toEqual({ kind: retained === 'confirmed' ? 'unchanged' : 'accepted' });
    expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(retained === 'confirmed' ? 0 : 1);
  });

  it.each(['absent', 'past', 'presented', 'malformed'] as const)('does not reissue a %s consumed request', async state => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    native.getAllScheduledNotificationsAsync.mockResolvedValue(state === 'absent' ? [] : [{ identifier,
      content: state === 'malformed' ? { ...content, body: 'wrong' } : content,
      trigger: { type: 'date', repeats: false, value: state === 'past' ? now : fire } }]);
    if (state === 'presented') native.getPresentedNotificationsAsync.mockResolvedValue([{ request: { identifier } }]);
    expect(await adapter.refreshPending(refresh('unresolved'), context())).toEqual({ kind: 'unchanged' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(native.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels Android DATE before immediate and records cancellation if the invocation retires', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    now = fire;
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content, trigger: { type: 'date', repeats: false, value: fire + 60_000 } }]);
    let current = true;
    native.cancelScheduledNotificationAsync.mockImplementation(async () => { current = false; });
    expect(await adapter.refreshPending(refresh(), { ...context(), isCurrent: () => current })).toEqual({ kind: 'cancelled' });
    expect(native.cancelScheduledNotificationAsync).toHaveBeenCalledWith(identifier);
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('confirms Android cancellation and re-inspects before replacing a future DATE with immediate', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    now = fire;
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content, trigger: { type: 'date', repeats: false, value: fire + 60_000 } }]);
    const order: string[] = [];
    native.cancelScheduledNotificationAsync.mockImplementation(async () => {
      order.push('cancel'); native.getAllScheduledNotificationsAsync.mockResolvedValue([]);
    });
    native.scheduleNotificationAsync.mockImplementation(async () => { order.push('add'); return identifier; });
    expect(await adapter.refreshPending(refresh(), context())).toEqual({ kind: 'accepted' });
    expect(order).toEqual(['cancel', 'add']);
    expect(native.getAllScheduledNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(native.scheduleNotificationAsync.mock.calls[0][0].trigger).toBeNull();
  });

  it('a lost cancellation response stops immediate replacement and standalone cancellation remains unknown', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    now = fire;
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content, trigger: { type: 'date', repeats: false, value: fire + 60_000 } }]);
    native.cancelScheduledNotificationAsync.mockRejectedValue(new Error('private'));
    expect(await adapter.refreshPending(refresh(), context())).toEqual({ kind: 'unknown' });
    expect(await adapter.cancel(identifier, context())).toEqual({ kind: 'unknown' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('rechecks 09:00 after the final refresh inspection on %s', async os => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    const stored = [{ identifier, content, trigger: { type: 'date', repeats: false, value: fire + 60_000 } }];
    native.getAllScheduledNotificationsAsync.mockResolvedValueOnce(stored).mockImplementationOnce(async () => {
      now = fire; return stored;
    }).mockResolvedValue([]);
    expect(await adapter.refreshPending(refresh(), context())).toEqual({ kind: 'accepted' });
    expect(native.scheduleNotificationAsync.mock.calls[0][0].trigger).toBeNull();
    expect(native.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(os === 'android' ? 1 : 0);
  });

  it('finishes the native lane while a real reminder command holds SQL and waits for it', async () => {
    const h = await createTestHarness();
    try {
      const id = await createBoardForTest(h);
      const { reminderScheduler } = jest.requireActual<typeof import('../../../src/platform/notifications/index')>(
        '../../../src/platform/notifications/index');
      let release!: (rows: unknown[]) => void;
      let inventoryEntered!: () => void;
      const entered = new Promise<void>(resolve => { inventoryEntered = resolve; });
      native.getAllScheduledNotificationsAsync.mockImplementationOnce(() => {
        inventoryEntered(); return new Promise(resolve => { release = resolve; });
      }).mockResolvedValue([]);
      let transactionActive = false;
      const original = h.db.withExclusiveTransactionAsync.bind(h.db);
      const spy = jest.spyOn(h.db, 'withExclusiveTransactionAsync').mockImplementation(work => original(async tx => {
        transactionActive = true;
        try { return await work(tx); } finally { transactionActive = false; }
      }));
      const trace: { kind: string; transactionActive: boolean }[] = [];
      native.scheduleNotificationAsync.mockImplementation(async input => {
        trace.push({ kind: input.identifier ? 'miss' : 'reminder', transactionActive });
        return input.identifier ?? 'weekly-native';
      });
      const miss = adapter.schedule(request(), context());
      await entered;
      let scheduleReached!: () => void;
      const reached = new Promise<void>(resolve => { scheduleReached = resolve; });
      const reminder = createReminder({ ...h.deps, scheduler: { ...reminderScheduler, schedule: input => {
        scheduleReached(); return reminderScheduler.schedule(input);
      } } }, { commandId: h.ids.nextCommandId(), boardId: id, weekdaysMask: 1, minuteOfDay: 480, enabled: true });
      await reached;
      release([]);
      expect(await miss).toEqual({ kind: 'accepted' });
      expect(await reminder).toMatchObject({ ok: true, value: { scheduleState: 'scheduled' } });
      expect(trace).toEqual([{ kind: 'miss', transactionActive: true }, { kind: 'reminder', transactionActive: true }]);
      expect(await h.db.getAllAsync('SELECT s.native_identifier, r.schedule_state FROM reminder_schedule s JOIN reminders r ON r.id = s.reminder_id'))
        .toEqual([{ native_identifier: 'weekly-native', schedule_state: 'scheduled' }]);
      spy.mockRestore();
    } finally { await h.db.closeAsync(); }
  });

  it('serializes the last capacity slot across miss and ordinary scheduling', async () => {
    const { reminderScheduler } = jest.requireActual<typeof import('../../../src/platform/notifications/index')>(
      '../../../src/platform/notifications/index');
    const stored: unknown[] = Array.from({ length: 63 }, (_, index) => ({ identifier: `existing-${index}` }));
    let release!: (rows: unknown[]) => void;
    let inventoryEntered!: () => void;
    const entered = new Promise<void>(resolve => { inventoryEntered = resolve; });
    const firstSnapshot = [...stored];
    native.getAllScheduledNotificationsAsync.mockImplementationOnce(() => {
      inventoryEntered(); return new Promise(resolve => { release = resolve; });
    }).mockImplementation(async () => [...stored]);
    native.scheduleNotificationAsync.mockImplementation(async input => {
      stored.push({ identifier: input.identifier ?? 'weekly-native' });
      return input.identifier ?? 'weekly-native';
    });
    const miss = adapter.schedule(request(), context());
    await entered;
    const ordinary = reminderScheduler.schedule({ reminderId: 'r', boardId, weekday: 1, minuteOfDay: 480, title: 'r', body: 'r' });
    release(firstSnapshot);
    const results = await Promise.allSettled([miss, ordinary]);
    expect(stored).toHaveLength(64);
    expect(results[0]).toEqual({ status: 'fulfilled', value: { kind: 'accepted' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'schedule_failed' } });
  });

  it.each(shared.payloads)('agrees with the literal native payload and route: $name', async vector => {
    const platform = jest.requireActual<typeof import('../../../src/platform/notifications/index')>(
      '../../../src/platform/notifications/index');
    const raw = { identifier: vector.identifier, content: { title: vector.title, body: vector.body, data: vector.data }, trigger: calendar };
    native.getAllScheduledNotificationsAsync.mockResolvedValue([raw]);
    const [pending] = await adapter.pendingRequests();
    expect(pending.identifier).toBe(vector.identifier);
    expect(pending.content).toEqual(vector.valid ? { identifier: vector.identifier, title: vector.title,
      body: vector.body, boardId: vector.data.boardId, secondMissedDate: vector.data.secondMissedDate } : null);
    expect(platform.notificationDestinationFromResponse({ notification: { request: raw } } as never))
      .toEqual(vector.destination === null ? null : { kind: vector.destination, boardId: vector.data.boardId });
  });

  it('uses the next local 09:00 with one-based December components outside foreground', async () => {
    now = Date.UTC(2026, 11, 9, 16);
    native.getNextTriggerDateAsync.mockResolvedValue(Date.UTC(2026, 11, 10, 14));
    expect(await adapter.schedule(request(), { ...context(), isForeground: () => false })).toEqual({ kind: 'accepted' });
    expect(native.scheduleNotificationAsync.mock.calls[0][0].trigger).toEqual({ type: 'calendar',
      year: 2026, month: 12, day: 10, hour: 9, minute: 0, second: 0, repeats: false });
  });

  it.each([{ month: 13 }, { day: 32 }, { hour: 8 }, { timeZone: 'UTC' }, { calendar: 'hebrew' }])(
    'does not adopt a pinned or malformed calendar as a future request: %j', async changed => {
      native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content,
        trigger: { ...calendar, dateComponents: { ...calendar.dateComponents, ...changed } } }]);
      expect((await adapter.pendingRequests())[0]).toMatchObject({ identifier, nextFireAtUtcMs: null });
      expect(native.getNextTriggerDateAsync).not.toHaveBeenCalled();
    });

  it('captures the entire pending inventory before resolving any native calendar', async () => {
    let release!: (value: number) => void;
    const rows = [{ identifier, content: { ...content }, trigger: structuredClone(calendar) },
      { identifier, content: { ...content }, trigger: structuredClone(calendar) }];
    native.getAllScheduledNotificationsAsync.mockResolvedValue(rows);
    native.getNextTriggerDateAsync.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(fire);
    const reading = adapter.pendingRequests(); await Promise.resolve(); await Promise.resolve();
    rows[1].content.title = 'changed'; rows[1].trigger.dateComponents.month = 12;
    release(fire);
    expect((await reading).map(value => [value.content?.title, value.nextFireAtUtcMs])).toEqual([[title, fire], [title, fire]]);
    expect(native.getNextTriggerDateAsync.mock.calls[1][0].month).toBe(1);
  });

  it('sanitizes malformed native identities instead of returning a partial inventory', async () => {
    native.getAllScheduledNotificationsAsync.mockResolvedValue([{ identifier, content, trigger: calendar }, { identifier: 5 }]);
    await expect(adapter.pendingRequests()).rejects.toThrow('Notifications could not be checked. Try again.');
    native.getPresentedNotificationsAsync.mockResolvedValue([{ request: { identifier: null } }]);
    await expect(adapter.presentedIdentifiers()).rejects.toThrow('Notifications could not be checked. Try again.');
  });

  it.each([null, Number.NaN, fire - 3_600_000])('never dispatches an unresolved or expired native trigger %s', async value => {
    native.getNextTriggerDateAsync.mockResolvedValue(value);
    expect(await adapter.schedule(request(), context())).toEqual({ kind: 'not_accepted', code: 'schedule_failed' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('retires when the zone changes inside native resolution and honors a cancelled guard before queue dispatch', async () => {
    let zone = 'America/New_York';
    native.getNextTriggerDateAsync.mockImplementation(async () => { zone = 'UTC'; return fire; });
    expect(await adapter.schedule(request(), { ...context(), clock: { nowUtcMs: () => now, timeZoneId: () => zone } }))
      .toEqual({ kind: 'retired' });
    expect(await adapter.cancel(identifier, { ...context(), isCurrent: () => false })).toEqual({ kind: 'retired' });
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(native.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it.each(['retained', 'full', 'inspection-failed', 'retired'])('does not re-add after Android cancellation when %s', async state => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' }); now = fire;
    let current = true;
    const row = { identifier, content, trigger: { type: 'date', repeats: false, value: fire + 60_000 } };
    native.getAllScheduledNotificationsAsync.mockResolvedValueOnce([row]).mockImplementation(async () => {
      if (state === 'inspection-failed') throw Error('private');
      if (state === 'retired') current = false;
      return state === 'retained' ? [row] : state === 'full' ? Array.from({ length: 64 }, (_, index) => ({ identifier: `r-${index}` })) : [];
    });
    expect(await adapter.refreshPending(refresh(), { ...context(), isCurrent: () => current })).toEqual(state === 'full'
      ? { kind: 'not_accepted', code: 'capacity' } : { kind: state === 'retired' ? 'cancelled' : 'unknown' });
    expect(native.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('consumes cold response once, routes only valid live callbacks and removes both native listeners', async () => {
    const platform = jest.requireActual<typeof import('../../../src/platform/notifications/index')>('../../../src/platform/notifications/index');
    const response = { notification: { request: { identifier, content, trigger: calendar } } };
    native.getLastNotificationResponseAsync.mockResolvedValue(response);
    native.clearLastNotificationResponse.mockImplementation(() => { native.getLastNotificationResponseAsync.mockResolvedValue(null); });
    expect(await platform.getInitialNotificationDestination()).toEqual({ kind: 'board', boardId });
    expect(await platform.getInitialNotificationDestination()).toBeNull();
    expect(native.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    const removeTap = jest.fn(), removeDelivery = jest.fn();
    native.addNotificationResponseReceivedListener.mockReturnValue({ remove: removeTap });
    native.addNotificationReceivedListener.mockReturnValue({ remove: removeDelivery });
    const tapped = jest.fn(), delivered = jest.fn();
    const stopTap = platform.addNotificationDestinationListener(tapped);
    const stopDelivery = platform.addNotificationDeliveryListener(delivered);
    native.addNotificationResponseReceivedListener.mock.calls[0][0](response);
    native.addNotificationResponseReceivedListener.mock.calls[0][0]({ notification: { request: { identifier, content: { data: { boardId } } } } });
    native.addNotificationReceivedListener.mock.calls[0][0]();
    expect(tapped.mock.calls).toEqual([[{ kind: 'board', boardId }]]);
    expect(delivered).toHaveBeenCalledTimes(1);
    stopTap(); stopDelivery(); expect(removeTap).toHaveBeenCalledTimes(1); expect(removeDelivery).toHaveBeenCalledTimes(1);
  });
});
