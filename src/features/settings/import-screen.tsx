import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { ImportSummary } from '@/core/domain/commands';
import type { ImportDraft, ImportPreview } from '@/core/export/import-parsers';
import { getImportPreview, parseOwnExport, parseRipplesCsv } from '@/core/export/import-parsers';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { useProduct } from '../product-store';
import { SettingsGroup, SettingsRow } from './rows';
import { useSettingsActivity } from './use-settings-activity';
import { importAttemptStoreFor, type ImportOwner } from './import-attempt';
import { SampleDisabledScreen } from '../sample/disabled-screen';

type ImportState =
  | { step: 'choose' }
  | { step: 'preview'; fileName: string; draft: ImportDraft; counts: ImportPreview };

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function V2Summary({ summary }: { summary: NonNullable<ImportSummary['v2']> }) {
  const remaining = summary.immutable;
  const settings = {
    restored: 'Anchor times restored.', unchanged: 'Anchor times already match.',
    preserved: 'Existing settings kept.', invalid: 'Settings could not be restored. Existing settings kept.',
  }[summary.settings];
  return (
    <>
      <AppText testID="import-reward-summary">
        {`Added ${count(summary.rewardsCreated, 'reward')}.${summary.rewardsSkipped > 0
          ? ` Skipped ${count(summary.rewardsSkipped, 'reward')} (already present or invalid).` : ''}`}
      </AppText>
      <AppText testID="import-settings-summary">{settings}</AppText>
      {remaining.pending + remaining.blocked + remaining.quarantined > 0 ? (
        <AppText variant="footnote" testID="import-history-remaining">
          {`History on this device still needs attention: ${remaining.pending} waiting for related records, ${remaining.blocked} waiting to be processed, ${remaining.quarantined} needing review.`}
        </AppText>
      ) : null}
    </>
  );
}

// two import sources: a csv export from the ripples app, and this
// app's own json export (a restore that skips records it already has)
export function ImportScreen() {
  const { scope } = useProduct();
  if (scope.kind === 'sample') return <SampleDisabledScreen title="Import Data" message="Import is disabled in sample mode." />;
  return <ImportBody />;
}

function ImportBody() {
  const scheme = useScheme();
  const { core, scope, invalidate, nextCommandId } = useProduct();
  const store = useMemo(() => importAttemptStoreFor(core), [core]);
  const attempt = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const owner = useSettingsActivity(scope);
  const picking = useRef<ImportOwner | null>(null);
  const [state, setState] = useState<ImportState>({ step: 'choose' });
  const selection = useRef<ImportState>(state);
  const [pickError, setPickError] = useState<string | null>(null);
  useEffect(() => store.registerInvalidation(invalidate), [store, invalidate]);

  const pick = useCallback(
    async (source: 'ripples-csv' | 'own') => {
      if (!scope.isCurrent()) return;
      const current = owner;
      if (!current?.active || picking.current === current || store.getSnapshot().phase !== 'idle') return;
      picking.current = current;
      setPickError(null);
      try {
        const dispatch = await scope.run(({ effects }) => {
          if (effects.kind !== 'real') throw new Error('Import is disabled in sample mode.');
          return effects.pickImportFile();
        });
        if (!scope.isCurrent() || !current.active || !dispatch.started || store.getSnapshot().phase !== 'idle') return;
        const picked = dispatch.value;
        if (!picked.ok) {
          setPickError(picked.error.message);
          return;
        }
        if (picked.value === null) {
          // cancelling the picker keeps the chooser open
          return;
        }
        const parsed =
          source === 'ripples-csv'
            ? parseRipplesCsv(picked.value.contents)
            : parseOwnExport(picked.value.contents);
        if (!parsed.ok) {
          setPickError(parsed.error.message);
          return;
        }
        const counts = getImportPreview(parsed.value);
        if (!counts.ok) {
          setPickError(counts.error.message);
          return;
        }
        const preview: ImportState = { step: 'preview', fileName: picked.value.name, draft: parsed.value, counts: counts.value };
        selection.current = preview;
        setState(preview);
      } catch {
        if (scope.isCurrent() && current.active) setPickError('The file could not be read. Try again.');
      } finally {
        if (picking.current === current) picking.current = null;
      }
    },
    [store, scope, owner],
  );

  const runImport = useCallback(async () => {
    if (!scope.isCurrent()) return;
    const current = owner;
    if (!current?.active) return;
    setPickError(null);
    try {
      if (attempt.phase === 'uncertain') await scope.run(({ core: accepted }) => store.retry(current, attempt.commandId, invalidate, accepted));
      else if (attempt.phase === 'idle' && state.step === 'preview' && selection.current === state) {
        const pending = scope.run(({ core: accepted }) => store.start(current, state.fileName, state.draft, nextCommandId, invalidate, accepted));
        if (store.getSnapshot().phase === 'running') {
          selection.current = { step: 'choose' };
          setState(selection.current);
        }
        await pending;
      }
    } catch {
      if (scope.isCurrent() && current.active) setPickError('The import could not be started. Try again.');
    }
  }, [store, scope, owner, invalidate, nextCommandId, state, attempt]);

  const preview = attempt.phase === 'running' || attempt.phase === 'uncertain' ? attempt
    : attempt.phase === 'idle' && state.step === 'preview'
      ? { ...state.counts, fileName: state.fileName, source: state.draft.source, exportVersion: state.draft.exportVersion }
      : null;
  const error = attempt.phase === 'uncertain' || attempt.phase === 'failed' ? attempt.error?.message : pickError;
  const another = () => {
    if (!scope.isCurrent()) return;
    const current = owner;
    if (current && (attempt.phase === 'done' || attempt.phase === 'failed') && store.startAnother(current, attempt.commandId)) {
      selection.current = { step: 'choose' };
      setState(selection.current); setPickError(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Import Data' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        {attempt.phase === 'idle' && state.step === 'choose' ? (
          <>
            <AppText variant="subheadline">
              Imports add habits and history. Existing habits and rewards keep their current settings.
            </AppText>
            <SettingsGroup title="Import from">
              <SettingsRow
                title="Ripples (CSV export)"
                onPress={() => void pick('ripples-csv')}
                testID="import-ripples"
              />
              <SettingsRow
                title="This app (JSON export)"
                onPress={() => void pick('own')}
                testID="import-own"
              />
            </SettingsGroup>
          </>
        ) : null}

        {preview ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="import-preview"
          >
            <AppText variant="headline">{preview.fileName}</AppText>
            <AppText testID="import-preview-counts">
              {`${[count(preview.boards, 'board'), count(preview.checkIns, 'check-in'),
                ...(preview.exportVersion === 2 && preview.rewards > 0 ? [count(preview.rewards, 'reward')] : []),
                ...(preview.exportVersion === 2 && preview.reminders > 0 ? [count(preview.reminders, 'reminder')] : []),
              ].join(', ')}.`}
            </AppText>
            {preview.exportVersion === 2 ? (
              <AppText variant="footnote">
                Existing settings are kept. An empty app can also restore the saved anchor times.
                {' '}Restoring check and coin history does not earn coins again.
              </AppText>
            ) : null}
            <AppText variant="footnote">
              {preview.source === 'ripples-csv'
                ? 'Boards keep their original creation dates, so streaks and consistency include the imported history.'
                : 'Records that already exist are skipped, so restoring the same file twice is safe.'}
            </AppText>
            <PrimaryButton
              title={attempt.phase === 'running' ? 'Importing…' : attempt.phase === 'uncertain' ? 'Retry import' : 'Import'}
              onPress={() => void runImport()}
              disabled={attempt.phase === 'running'}
              testID="import-confirm"
            />
          </View>
        ) : null}

        {attempt.phase === 'done' ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="import-done"
          >
            <AppText variant="headline">Import complete</AppText>
            <AppText testID="import-summary">
              {`Added ${count(attempt.summary.boardsCreated, 'board')} and ${count(attempt.summary.checkInsCreated, 'check-in')}.${
                attempt.summary.boardsSkipped + attempt.summary.checkInsSkipped > 0
                  ? ` Skipped ${count(attempt.summary.boardsSkipped, 'board')} and ${count(attempt.summary.checkInsSkipped, 'check-in')} that already existed or were invalid.`
                  : ''
              }`}
            </AppText>
            {attempt.summary.remindersCreated + attempt.summary.remindersSkipped > 0 ? (
              <AppText testID="import-reminder-summary">
                {`Added ${count(attempt.summary.remindersCreated, 'reminder')}.${attempt.summary.remindersSkipped > 0
                  ? ` Skipped ${count(attempt.summary.remindersSkipped, 'reminder')} (already present or invalid).` : ''}`}
              </AppText>
            ) : null}
            {attempt.summary.v2 ? <V2Summary summary={attempt.summary.v2} /> : null}
            <PrimaryButton
              title="Import another file"
              onPress={another}
              testID="import-again"
            />
          </View>
        ) : null}

        {attempt.phase === 'failed' ? <PrimaryButton title="Import another file" onPress={another} testID="import-again" /> : null}

        {error ? <InlineError message={error} testID="import-error" /> : null}
      </ScrollView>
    </View>
  );
}
