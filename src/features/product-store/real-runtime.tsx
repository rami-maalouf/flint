import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { createCheckIn } from '@/core/domain/commands';
import type { CommandId } from '@/core/domain/ids';
import { parseBoardId } from '@/core/domain/ids';
import { getBoard, getSyncSummary } from '@/core/domain/queries';
import { refreshWidgetProjection } from '@/core/domain/widget-projection';
import type { DomainError } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';
import { getProductCore } from '@/platform/database/product-core';
import {
  installNotificationHandler,
  addNotificationDestinationListener,
  addNotificationDeliveryListener,
  getInitialNotificationDestination,
  missAlertScheduler,
  reminderScheduler,
} from '@/platform/notifications';
import { addWidgetQuickActionListener, refreshWidgets } from '@/platform/widgets';
import { addSignificantTimeChangeListener } from '@/platform/time-change';
import { spacing } from '@/theme';
import { cloudKitAvailable } from '@/platform/sync';
import { backendSession, backendTransport, observeBackendChanges } from '@/platform/backend';
import { cleanupStaleExports, pickImportFile, saveAndShareExport } from '@/platform/data-transfer';
import { supportsAlternateIcons, setAlternateIcon } from '@/platform/alternate-icons';

import { INITIAL_SYNC, SyncCoordinator } from './sync-coordinator';
import { NotificationCoordinator } from './notification-coordinator';
import { ProductContext, type FeatureEffects, type ProductContextValue } from './context';

import { createOperationOwner, type OperationOwner } from './operation-scope';
import { RealRuntimeHost } from './real-runtime-host';
import { useOptionalSampleSession } from '../sample/session-context';
import type { RealProductProviderProps } from './provider';

const noSubscription = () => () => {};
const noScope = () => null;

type ProviderState =
  | { status: 'loading' }
  | { status: 'ready'; core: ProductCore; owner: OperationOwner }
  | { status: 'error'; error: DomainError };

export function RealProductProvider({ children, coreOverride, syncTransportOverride, missAlertSchedulerOverride }: RealProductProviderProps) {
  const session = useOptionalSampleSession();
  const [host] = useState(() => new RealRuntimeHost());
  const revision = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  // feature ports are fixed for this runtime; a replaced test scheduler only
  // changes the notification coordinator and count observer.
  const [effects] = useState<FeatureEffects>(() => ({
    kind: 'real', reminders: reminderScheduler, missAlerts: missAlertSchedulerOverride ?? missAlertScheduler,
    cloudKitAvailable, pickImportFile, saveAndShareExport, supportsAlternateIcons, setAlternateIcon,
    openSystemSettings: Linking.openSettings,
    openReleaseLink: async (url, inApp) => {
      if (inApp) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- evaluate the browser only for an accepted real operation
        const { openBrowserAsync } = require('expo-web-browser') as typeof import('expo-web-browser');
        await openBrowserAsync(url);
      } else await Linking.openURL(url);
    },
  }));
  const ready = useCallback((core: ProductCore): Extract<ProviderState, { status: 'ready' }> => {
    const owner = createOperationOwner(core, effects);
    return { status: 'ready', core, owner };
  }, [effects]);
  const [state, setState] = useState<ProviderState>(() => coreOverride ? ready(coreOverride) : { status: 'loading' });
  const owner = state.status === 'ready' ? state.owner : null;
  const scope = useSyncExternalStore(owner?.subscribe ?? noSubscription, owner?.getScope ?? noScope,
    owner?.getScope ?? noScope);
  useEffect(() => { if (owner) host.attach(owner); }, [host, owner]);

  useEffect(() => {
    let current = true;
    const unregister = session?.registerRealHost(host);
    // strict-mode replay reuses the host and resumes only after its old work joins.
    if (!host.isCurrent(host.getSnapshot()) && (!session || session.getSnapshot().status === 'idle')) {
      void host.suspend().then(() => {
        if (current && (!session || session.getSnapshot().status === 'idle')) host.resume();
      }).catch(() => {});
    }
    return () => { current = false; unregister?.(); void host.suspend().catch(() => {}); };
  }, [host, session]);
  const cleanedExports = useRef(false);
  useEffect(() => {
    if (cleanedExports.current || !host.isCurrent(revision)) return;
    cleanedExports.current = true;
    // cleanup is best effort, once per real mount; an async adapter still joins.
    void host.track(async () => { await cleanupStaleExports(); }).catch(() => {});
  }, [host, revision]);
  useEffect(() => {
    if (!host.isCurrent(revision)) return;
    return host.retain(installNotificationHandler());
  }, [host, revision]);
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [sync, setSync] = useState(INITIAL_SYNC);
  const [missAlertVersion, setMissAlertVersion] = useState(0);
  const missScheduler = missAlertSchedulerOverride ?? missAlertScheduler;
  const notificationsRef = useRef<NotificationCoordinator | null>(null);
  const active = useRef(AppState.currentState === 'active');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [backendEnabled, setBackendEnabled] = useState(false);
  const backendAccount = useSyncExternalStore(backendSession.subscribe, backendSession.getSnapshot, backendSession.getSnapshot);
  const projectionGeneration = useRef(0);
  const refreshQueries = useCallback(() => {
    projectionGeneration.current += 1;
    setVersion((current) => current + 1);
  }, []);
  const coordinatorRef = useRef<SyncCoordinator | null>(null);

  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision)) return;
    const coordinator = new SyncCoordinator(state.core, syncTransportOverride ?? backendTransport, setSync, refreshQueries);
    coordinatorRef.current = coordinator;
    void coordinator.request();
    return host.retain(() => {
      coordinatorRef.current = null;
      return coordinator.dispose();
    });
  }, [state, host, revision, refreshQueries, syncTransportOverride]);

  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision) || syncTransportOverride) return;
    let cancelled = false;
    void host.track(async () => {
      const summary = await getSyncSummary(state.core);
      if (!cancelled && host.isCurrent(revision) && summary.ok) setBackendEnabled(summary.value.enabled);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [state, host, revision, version, syncTransportOverride]);

  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision) || syncTransportOverride ||
      !foreground || !backendEnabled || !backendAccount.session) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void host.track(async () => {
      const cleanup = await observeBackendChanges(() => {
        if (!cancelled && host.isCurrent(revision)) void coordinatorRef.current?.request();
      });
      if (cancelled || !host.isCurrent(revision)) cleanup();
      else stop = cleanup;
    }).catch(() => {});
    return host.retain(() => { cancelled = true; stop?.(); });
  }, [state, host, revision, foreground, backendEnabled, backendAccount.session, syncTransportOverride]);

  const syncNow = useCallback(() => { if (scope?.isCurrent()) void coordinatorRef.current?.request(); }, [scope]);
  const pauseSync = useCallback(() => { if (scope?.isCurrent()) coordinatorRef.current?.pause(); }, [scope]);
  const resumeSync = useCallback(() => { if (scope?.isCurrent()) coordinatorRef.current?.resume(); }, [scope]);

  const opening = useRef<{ attempt: number; promise: Promise<ProviderState> } | null>(null);
  useEffect(() => {
    if (coreOverride) return;
    let cancelled = false;
    if (opening.current?.attempt !== attempt) {
      if (!host.isCurrent(revision)) return;
      opening.current = { attempt, promise: host.track(async () => {
        try {
          const result = await getProductCore();
          if (!result.ok) return { status: 'error', error: result.error };
          const opened = ready(result.value);
          host.attach(opened.owner);
          return opened;
        } catch (cause) {
          return { status: 'error', error: { code: 'database', retryable: true,
            message: cause instanceof Error ? cause.message : String(cause) } };
        }
      }) };
    }
    void opening.current.promise.then(result => { if (!cancelled) setState(result); });
    return () => { cancelled = true; };
  }, [coreOverride, attempt, host, ready, revision]);

  const invalidate = useCallback(() => {
    if (!scope?.isCurrent()) return;
    refreshQueries();
    syncNow();
  }, [scope, refreshQueries, syncNow]);

  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision)) return;
    active.current = AppState.currentState === 'active';
    const coordinator = new NotificationCoordinator(state.core, missScheduler, reminderScheduler,
      active.current, () => setMissAlertVersion(value => value + 1), invalidate);
    notificationsRef.current = coordinator;
    return host.retain(() => { notificationsRef.current = null; return coordinator.dispose(); });
  }, [state, host, revision, missScheduler, invalidate]);

  // miss-only progress has its own observer revision and cannot trigger this effect.
  useEffect(() => { notificationsRef.current?.request(); }, [state, version, missScheduler, revision]);

  useEffect(() => {
    if (!host.isCurrent(revision)) return;
    const remove = addNotificationDeliveryListener(() => {
      if (host.isCurrent(revision)) setMissAlertVersion(value => value + 1);
    });
    return host.retain(remove);
  }, [host, revision]);

  useEffect(() => {
    if (!host.isCurrent(revision)) return;
    return host.retain(addSignificantTimeChangeListener(invalidate));
  }, [host, revision, invalidate]);

  // cache refresh, publication, and foreground expiry share one snapshot.
  // generation changes invalidate late results before their effects can commit.
  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision)) return;
    const core = state.core;
    const generation = projectionGeneration.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !cancelled && host.isCurrent(revision) && generation === projectionGeneration.current;
    const retry = () => {
      // retain the stale timeline and retry at a bounded rate while foregrounded.
      if (isCurrent()) timer = setTimeout(invalidate, 30_000);
    };
    void host.track(async () => {
      const result = await refreshWidgetProjection(core);
      if (!isCurrent()) return;
      if (!result.ok) { retry(); return; }
      const delay = result.value.expiresAtUtc - core.clock.nowUtcMs();
      if (delay > 0) await refreshWidgets(result.value);
      if (isCurrent()) timer = setTimeout(invalidate, Math.max(0, delay));
    }).catch(retry);
    return host.retain(() => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
  }, [host, revision, invalidate, state, version]);

  // out-of-process writers (widgets, automations, sync) mutate the same
  // database; returning to the foreground refreshes every mounted query.
  // the in-process database-change hook lands with the widget stage.
  useEffect(() => {
    if (!host.isCurrent(revision)) return;
    const subscription = AppState.addEventListener('change', (appState) => {
      if (!host.isCurrent(revision)) return;
      active.current = appState === 'active';
      setForeground(active.current);
      notificationsRef.current?.setActive(active.current);
      if (appState === 'active') {
        invalidate();
      }
    });
    return host.retain(() => subscription?.remove?.());
  }, [host, revision, invalidate]);

  // daily events open explicit fresh-state actions; count events retain
  // their existing quick-create behavior and form fallback.
  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision)) return;
    const core = state.core;
    let cancelled = false;
    const remove = addWidgetQuickActionListener((value) => {
      const boardId = parseBoardId(value);
      if (!boardId || !host.isCurrent(revision)) return;
      void host.track(async () => {
        const board = await getBoard(core, boardId);
        if (cancelled || !host.isCurrent(revision)) return;
        if (!board.ok || board.value.kind === 'daily') {
          router.navigate(`/boards/${boardId}/quick-action`);
          return;
        }
        const result = await createCheckIn(core, {
          commandId: core.ids.uuid() as CommandId, boardId, source: 'widget',
        });
        if (cancelled || !host.isCurrent(revision)) return;
        if (result.ok) {
          invalidate();
        } else {
          router.navigate(`/boards/${boardId}/check-ins/new?source=widget`);
        }
      }).catch(() => {});
    });
    return host.retain(() => { cancelled = true; remove(); });
  }, [host, revision, invalidate, state]);

  const initialResponseRead = useRef(false);
  // a tapped reminder deep-links to its board's add check-in sheet, both
  // while running and when the tap cold-started the app
  useEffect(() => {
    if (state.status !== 'ready' || !host.isCurrent(revision)) return;
    const open = ({ boardId, kind }: { boardId: string; kind: 'board' | 'new-check' }) => {
      if (!cancelled && host.isCurrent(revision)) router.push(kind === 'board' ? `/boards/${boardId}` : `/boards/${boardId}/check-ins/new`);
    };
    let cancelled = false;
    if (!initialResponseRead.current) {
      initialResponseRead.current = true;
      void host.track(async () => {
        const destination = await getInitialNotificationDestination();
        if (destination) open(destination);
      }).catch(() => {});
    }
    const remove = addNotificationDestinationListener(open);
    return host.retain(() => { cancelled = true; remove(); });
  }, [state.status, host, revision]);

  const value = useMemo<ProductContextValue | null>(() => {
    if (state.status !== 'ready' || !owner || !scope) {
      return null;
    }
    return {
      core: owner.core,
      scope,
      closeSample: null,
      version,
      invalidate,
      nextCommandId: () => {
        if (!scope.isCurrent()) throw new Error('The product scope is inactive.');
        return state.core.ids.uuid() as CommandId;
      },
      sync,
      syncNow,
      pauseSync,
      resumeSync,
      missAlertScheduler: missScheduler,
      missAlertVersion,
    };
  }, [state, owner, scope, version, invalidate, sync, syncNow, pauseSync, resumeSync, missScheduler, missAlertVersion]);

  if (state.status === 'loading') {
    return <View testID="product-loading" />;
  }

  if (state.status === 'error') {
    // a failed migration or open never creates a replacement database
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}
        testID="product-recovery"
      >
        <AppText variant="title2" accessibilityRole="header">
          Your data could not be opened
        </AppText>
        <AppText>{state.error.message}</AppText>
        <AppText
          accessibilityRole="button"
          onPress={() => {
            if (!host.isCurrent(revision)) return;
            setState({ status: 'loading' });
            setAttempt((current) => current + 1);
          }}
          style={{ minHeight: 44 }}
        >
          Try again
        </AppText>
      </View>
    );
  }

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}
