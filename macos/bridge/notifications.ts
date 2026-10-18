import type { CommandId } from '../../src/core/domain/ids';
import { getPendingMissAlertCount, reconcileMissAlerts } from '../../src/core/domain/miss-alert-reconciliation';
import { planMissAlertTrigger } from '../../src/core/domain/miss-alerts';
import type { MissAlertEffectContext, MissAlertRequest, MissAlertScheduler, PendingMissAlertRequest,
  ReminderScheduler, ReminderScheduleRequest } from '../../src/core/domain/ports';
import * as commands from '../../src/core/domain/reminder-commands';
import { ok } from '../../src/core/domain/result';
import { missNotificationContent, readMissContent } from '../../src/platform/notifications/miss-content';
import { deps, nativeAsync, type Operations } from './runtime';

type NativeState = { generation: number; foreground: boolean; effectsEnabled: boolean };
type Inventory = { identifier: string; title: string; body: string; data: Record<string, unknown>;
  reminder: ReminderScheduleRequest | null; nextFireAtUtcMs: number | null; repeats: boolean };
const invoke = <T>(method: string, payload: Record<string, unknown> = {}) => nativeAsync<T>('notifications', { method, ...payload });
const inventory = () => invoke<Inventory[]>('pending');
const retired = { kind: 'retired' } as const;

export const reminderScheduler: ReminderScheduler = {
  authorization: () => invoke('authorization'),
  requestAuthorization: () => invoke('requestAuthorization'),
  remainingCapacity: async () => Math.max(0, 64 - (await inventory()).length),
  pendingIdentifiers: async () => (await inventory()).map(row => row.identifier),
  pendingRequests: async () => (await inventory()).map(row => ({ identifier: row.identifier, request: row.reminder })),
  schedule: request => invoke('scheduleReminder', { request: { ...request } }),
  async cancel(identifiers) { await invoke('cancel', { identifiers: [...identifiers] }); },
};

async function pendingMissRequests(): Promise<PendingMissAlertRequest[]> {
  return (await inventory()).map(row => ({ identifier: row.identifier, content: readMissContent(row.identifier, row),
    nextFireAtUtcMs: row.repeats ? null : row.nextFireAtUtcMs, acceptance: 'confirmed' }));
}

function snapshotContext(context: MissAlertEffectContext): MissAlertEffectContext {
  const clock = context.clock;
  return { clock: { nowUtcMs: clock.nowUtcMs.bind(clock), timeZoneId: clock.timeZoneId.bind(clock) },
    isCurrent: context.isCurrent.bind(context), isForeground: context.isForeground.bind(context) };
}

function missScheduler(generation: number): MissAlertScheduler {
  // expiry conservatively retires every plan at the next minute, including every possible
  // logical-date boundary. the native service also checks lifecycle generation and zone.
  const guardFor = (context: MissAlertEffectContext) => ({ generation, timeZoneId: context.clock.timeZoneId(),
    expiresAt: (Math.floor(context.clock.nowUtcMs() / 60_000) + 1) * 60_000 });
  const valid = (request: MissAlertRequest, context: MissAlertEffectContext) => context.isCurrent() &&
    context.clock.timeZoneId() === request.timeZoneId && readMissContent(request.identifier, missNotificationContent(request)) !== null;
  const dispatch = async (request: MissAlertRequest, context: MissAlertEffectContext, replacement: boolean) => {
    if (!valid(request, context)) return retired;
    const trigger = planMissAlertTrigger({ nowUtcMs: context.clock.nowUtcMs(), timeZoneId: request.timeZoneId,
      foreground: context.isForeground() });
    return invoke<Awaited<ReturnType<MissAlertScheduler['schedule']>>>('scheduleMiss', {
      request: { ...request, trigger }, replacement, guard: guardFor(context),
    });
  };
  return {
    authorization: reminderScheduler.authorization,
    pendingRequests: pendingMissRequests,
    presentedIdentifiers: () => invoke('presented'),
    async schedule(request, context) {
      const owned = { ...request, trigger: { ...request.trigger } };
      context = snapshotContext(context);
      try {
        if (!valid(owned, context)) return retired;
        const pending = await pendingMissRequests();
        if (!valid(owned, context)) return retired;
        const existing = pending.find(row => row.identifier === owned.identifier);
        if (existing) return { kind: existing.content ? 'accepted' : 'unknown' };
        if (pending.length >= 64) return { kind: 'not_accepted', code: 'capacity' };
        return await dispatch(owned, context, false);
      } catch { return { kind: 'unknown' }; }
    },
    async refreshPending(input, context) {
      const owned = { ...input.replacement, trigger: { ...input.replacement.trigger } };
      const observed = { ...input.observed, content: { ...input.observed.content } };
      const retainedAcceptance = input.retainedAcceptance;
      context = snapshotContext(context);
      try {
        if (!valid(owned, context)) return retired;
        if (observed.identifier !== owned.identifier || observed.content.boardId !== owned.boardId ||
          observed.content.secondMissedDate !== owned.secondMissedDate || !Number.isFinite(observed.nextFireAtUtcMs) ||
          !['confirmed', 'unresolved'].includes(retainedAcceptance)) return { kind: 'unchanged' };
        const presented = await invoke<string[]>('presented');
        if (!valid(owned, context)) return retired;
        if (presented.includes(owned.identifier)) return { kind: 'unchanged' };
        const pending = await pendingMissRequests();
        if (!valid(owned, context)) return retired;
        const live = pending.find(row => row.identifier === owned.identifier && row.content &&
          row.nextFireAtUtcMs !== null && row.nextFireAtUtcMs > context.clock.nowUtcMs());
        if (!live) return { kind: 'unchanged' };
        // native repeats inventory and delivery checks before dispatch and confirms dated
        // cancellation before an immediate replacement, so stale observations cannot reissue.
        return await dispatch(owned, context, true);
      } catch { return { kind: 'unknown' }; }
    },
    async cancel(identifier, context) {
      if (!context.isCurrent()) return retired;
      try { return await invoke('cancelMiss', { identifier, guard: guardFor(context) }); }
      catch { return { kind: 'unknown' }; }
    },
  };
}

export function installNotificationOperations(operations: Operations): void {
  const reminderDeps = { ...deps, scheduler: reminderScheduler };
  operations.createReminder = input => commands.createReminder(reminderDeps, input as commands.CreateReminderInput);
  operations.updateReminder = input => commands.updateReminder(reminderDeps, input as commands.UpdateReminderInput);
  operations.deleteReminder = input => commands.deleteReminder(reminderDeps, input as Parameters<typeof commands.deleteReminder>[1]);
  operations.setReminderEnabled = input => commands.setReminderEnabled(reminderDeps, input as Parameters<typeof commands.setReminderEnabled>[1]);
  operations.requestNotificationAuthorization = async () => ok(await reminderScheduler.requestAuthorization());
  operations.notificationStatus = async () => {
    const state = await invoke<NativeState>('state');
    const pending = await getPendingMissAlertCount({ db: deps.db, scheduler: missScheduler(state.generation) });
    if (!pending.ok) return pending;
    return ok({ authorization: await reminderScheduler.authorization(), remainingCapacity: await reminderScheduler.remainingCapacity(),
      pendingMissAlerts: pending.value, effectsEnabled: state.effectsEnabled });
  };
  operations.reconcileNotifications = async () => {
    const state = await invoke<NativeState>('state');
    if (!state.effectsEnabled) return ok({ reminders: { updated: 0 }, missAlerts: {
      localChanged: false, refreshPendingCount: false, nextRunAtUtcMs: null, error: null,
    } });
    const reminders = await commands.reconcileReminderSchedules(reminderDeps, { commandId: deps.ids.uuid() as CommandId });
    if (!reminders.ok) return reminders;
    const zone = deps.clock.timeZoneId();
    const minute = Math.floor(deps.clock.nowUtcMs() / 60_000);
    const missAlerts = await reconcileMissAlerts({ ...deps, scheduler: missScheduler(state.generation) }, {
      isForeground: () => state.foreground, isCurrent: () => zone === deps.clock.timeZoneId(),
    });
    const changedDuringRun = zone !== deps.clock.timeZoneId() || minute !== Math.floor(deps.clock.nowUtcMs() / 60_000);
    return ok({ reminders: reminders.value, missAlerts: changedDuringRun
      ? { ...missAlerts, nextRunAtUtcMs: deps.clock.nowUtcMs() + 1000 } : missAlerts });
  };
}
