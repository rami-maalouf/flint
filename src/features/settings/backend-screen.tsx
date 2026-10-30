import { Host, Switch } from '@expo/ui';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import { getSyncSummary } from '@/core/domain/queries';
import { backendSession, backendUrl, bindSession } from '@/platform/backend';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { useProduct, useProductQuery } from '../product-store';
import { SampleDisabledScreen } from '../sample/disabled-screen';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { SettingsGroup, SettingsRow } from './rows';
import { useSettingsActivity } from './use-settings-activity';

const labels = {
  idle: 'Off', syncing: 'Syncing…', up_to_date: 'Up to date', offline: 'Offline',
  signed_out: 'Sign in again', needs_attention: 'Needs attention',
};

export function BackendSyncScreen() {
  const { scope } = useProduct();
  return scope.kind === 'sample'
    ? <SampleDisabledScreen title="Account & Sync" message="Account sync is disabled in sample mode." />
    : <BackendBody />;
}

function BackendBody() {
  const scheme = useScheme();
  const { scope, nextCommandId, invalidate, sync, syncNow, pauseSync, resumeSync } = useProduct();
  const activity = useSettingsActivity(scope);
  const account = useSyncExternalStore(backendSession.subscribe, backendSession.getSnapshot, backendSession.getSnapshot);
  const summary = useProductQuery(core => getSyncSummary(core), []);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const ready = summary.status === 'ready' ? summary.value : null;
  const enabled = ready?.enabled === true;
  useEffect(() => {
    if (activity.active) void scope.run(() => backendSession.restore()).catch(() => {});
  }, [scope, activity]);

  const perform = (work: () => Promise<void>) => {
    if (!activity.active || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    void work().catch(cause => {
      if (activity.active) setError(cause instanceof Error ? cause.message : 'This action could not finish. Try again.');
    }).finally(() => {
      pending.current = false;
      if (activity.active) setBusy(false);
    });
  };
  const setEnabled = async (next: boolean) => {
    if (!next) pauseSync();
    try {
      await scope.run(async ({ core }) => {
        // the inherited database column is the sole-provider sync switch.
        const result = await setICloudSyncEnabled(core, { commandId: nextCommandId(), enabled: next });
        if (!result.ok) throw new Error(result.error.message);
      });
      if (activity.active) invalidate();
    } finally { if (activity.active) resumeSync(); }
  };
  const connect = () => perform(async () => {
    await scope.run(async ({ core }) => {
      await backendSession.signIn(mode, email, password, session => bindSession(core, session));
    });
    if (!activity.active) return;
    setPassword('');
    await setEnabled(true);
  });
  const signOut = () => perform(async () => {
    pauseSync();
    let notice: unknown;
    await scope.run(async () => {
      try { await backendSession.signOut(); } catch (cause) { notice = cause; }
    });
    if (activity.active) await setEnabled(false);
    if (notice) throw notice;
  });
  const inputStyle = {
    minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    fontSize: 17, color: semanticColor('label', scheme),
  } as const;
  const lastSync = ready?.lastSuccessAtUtc;
  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Account & Sync' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl,
          maxWidth: 600, width: '100%', alignSelf: 'center' }}
      >
        <View style={{ gap: spacing.sm }}>
          <AppText variant="title2">Your habits, everywhere</AppText>
          <AppText variant="footnote">
            Everything works offline. Connect an account to keep your habits and history in sync across your devices.
          </AppText>
        </View>
        {account.status === 'loading' ? <AppText testID="backend-loading">Opening your saved sign-in…</AppText>
          : account.status === 'error' ? <View style={{ gap: spacing.md }}>
            <InlineError message={account.error!} />
            <PrimaryButton title="Try Again" onPress={() => perform(async () => { await scope.run(() => backendSession.restore()); })} />
          </View>
          : account.session ? <View style={{ gap: spacing.lg }} testID="backend-connected">
            <SettingsGroup title="Your account">
              <SettingsRow title="Account" detail="Connected" />
              <View style={{ padding: spacing.lg }}>
                <Host matchContents>
                  <Switch label="Sync with your account" value={enabled} disabled={busy || ready === null}
                    onValueChange={next => perform(() => setEnabled(next))} testID="backend-toggle" />
                </Host>
              </View>
            </SettingsGroup>
            <SettingsGroup title="Sync">
              <SettingsRow title="Status" detail={ready ? enabled ? labels[sync.status] : 'Off' : 'Loading…'} testID="backend-status" />
              <SettingsRow title="Waiting to upload" detail={ready ? String(ready.pendingChanges) : '…'} testID="backend-pending" />
              <SettingsRow title="Last sync" detail={lastSync ? new Intl.DateTimeFormat(undefined,
                { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastSync)) : 'Never'} testID="backend-last-sync" />
            </SettingsGroup>
            {enabled ? <PrimaryButton title={sync.busy ? 'Syncing…' : 'Sync Now'} disabled={busy || sync.busy}
              onPress={() => { if (activity.active) syncNow(); }} testID="backend-sync-now" /> : null}
            <ProductPressable label="Sign Out" onPress={signOut} disabled={busy} testID="backend-sign-out">
              <AppText>Sign Out</AppText>
            </ProductPressable>
            <AppText variant="footnote">Signing out keeps all of your data on this device.</AppText>
          </View>
            : <View style={{ gap: spacing.lg }}>
              <View style={{ backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
                borderRadius: radius.lg, borderCurve: radiusCurve, overflow: 'hidden' }}>
                <TextInput accessibilityLabel="Email" placeholder="Email" keyboardType="email-address" autoComplete="email"
                  textContentType="emailAddress" autoCapitalize="none" autoCorrect={false} value={email}
                  onChangeText={setEmail} editable={!busy} style={inputStyle} testID="backend-email" />
                <TextInput accessibilityLabel="Password" placeholder="Password" secureTextEntry autoCapitalize="none"
                  autoCorrect={false} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  textContentType={mode === 'signup' ? 'newPassword' : 'password'} value={password}
                  onChangeText={setPassword} editable={!busy} style={inputStyle} testID="backend-password" />
              </View>
              <AppText variant="footnote">
                Connecting turns on sync and sends your local habits and history to your private account on the self-hosted server.
                {mode === 'signup' ? ' Use a password of at least 8 characters.' : ''}
              </AppText>
              <PrimaryButton title={busy ? 'Connecting…' : mode === 'signup' ? 'Create Account & Sync' : 'Sign In & Sync'}
                onPress={connect} disabled={busy || !email.trim() || !password} testID="backend-connect" />
              <ProductPressable label={mode === 'login' ? 'Create an account' : 'Already have an account? Sign in'}
                onPress={() => { if (activity.active) { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); } }}
                disabled={busy} testID="backend-mode">
                <AppText>{mode === 'login' ? 'Create an account' : 'Already have an account? Sign in'}</AppText>
              </ProductPressable>
            </View>}
        <SettingsGroup title="Incoming data on this device">
          <SettingsRow title="Waiting for related data" detail={ready ? String(ready.incoming.pending) : '…'} />
          <SettingsRow title="At processing limit" detail={ready ? String(ready.incoming.blocked) : '…'} />
          <SettingsRow title="Conflicting or invalid data" detail={ready ? String(ready.incoming.quarantined) : '…'} />
        </SettingsGroup>
        {error || sync.error ? <InlineError message={error ?? sync.error!} testID="backend-error" /> : null}
        {summary.status === 'error' ? <InlineError message="Sync information could not be loaded. Your local data is still available." /> : null}
        <AppText variant="footnote">Server: {new URL(backendUrl).host}</AppText>
      </ScrollView>
    </View>
  );
}
