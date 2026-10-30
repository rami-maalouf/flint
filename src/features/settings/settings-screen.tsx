import { Stack } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { getExportMeta } from '@/platform/app-metadata';
import { semanticColor, spacing } from '@/theme';

import { useScheme } from '../ui';
import { useProduct } from '../product-store/context';
import { useProductActivity } from '../product-store/use-product-activity';
import { productHref, useProductRouter } from '../sample/navigation';
import { releaseLink } from './release-links';
import type { ReleaseLinkKey } from './release-links';
import { SettingsGroup, SettingsRow } from './rows';

// the grouped settings sheet mirroring the reference: notifications first,
// support and feedback, more products, data, utilities, app information
export function SettingsScreen() {
  const router = useProductRouter();
  const { scope } = useProduct();
  const activity = useProductActivity(scope);
  const scheme = useScheme();
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const openingLink = useRef(false);
  const meta = getExportMeta();

  const openLink = useCallback((key: ReleaseLinkKey, title: string) => {
    if (!activity.active || openingLink.current) return;
    if (scope.kind === 'sample') {
      setLinkNotice('External links are unavailable in sample mode.');
      return;
    }
    const url = releaseLink(key);
    if (url === null) {
      // development builds carry no release links; the state is explicit
      setLinkNotice(`Missing release link for ${title}.`);
      return;
    }
    setLinkNotice(null);
    // support and legal destinations open in the in-app browser so the
    // person never loses their place; a store or mail scheme has to leave
    const inApp = url.startsWith('https://') && key !== 'appStoreReview';
    openingLink.current = true;
    void scope.run(async ({ effects }) => {
      if (effects.kind === 'real') await effects.openReleaseLink(url, inApp);
    }).catch(() => {
      if (activity.active) setLinkNotice(`${title} could not be opened. Try again.`);
    }).finally(() => { openingLink.current = false; });
  }, [scope, activity]);

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Settings' }} />
      {/* feedback stays above the scroll content: a notice rendered after
          the groups would sit below the fold and a tap near the top would
          appear to do nothing */}
      {linkNotice ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
          <AppText variant="footnote" testID="settings-link-notice">
            {linkNotice}
          </AppText>
        </View>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        <SettingsGroup>
          <SettingsRow
            title="Anchors"
            onPress={() => router.push('/settings/anchors')}
            testID="settings-anchors"
          />
          <SettingsRow
            title="Notifications"
            onPress={() => router.push('/settings/notifications')}
            testID="settings-notifications"
          />
        </SettingsGroup>

        <SettingsGroup title="Support and Feedback">
          <SettingsRow
            title="Request feature or report issue"
            onPress={() => openLink('feedback', 'Request feature or report issue')}
            external
            testID="settings-feedback"
          />
          <SettingsRow
            title="Rate Habit System In App Store"
            onPress={() => openLink('appStoreReview', 'Rate Habit System In App Store')}
            external
            testID="settings-rate"
          />
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            title="More products by us"
            onPress={() => openLink('moreProducts', 'More products by us')}
            external
            testID="settings-more-products"
          />
        </SettingsGroup>

        <SettingsGroup title="Data">
          <SettingsRow
            title="Account & Sync"
            onPress={() => router.push('/settings/sync')}
            testID="settings-icloud"
          />
          <SettingsRow
            title="Archived Boards"
            onPress={() => router.push('/settings/archived')}
            testID="open-archived-boards"
          />
          <SettingsRow
            title="Import Data"
            onPress={() => router.push('/settings/import')}
            testID="settings-import"
          />
        </SettingsGroup>

        <SettingsGroup title="Utilities">
          {scope.kind === 'real' ? <SettingsRow
            title="Try a sample"
            onPress={() => router.push(productHref('sample', '/'))}
            testID="settings-sample"
          /> : null}
          <SettingsRow
            title="Export Data"
            onPress={() => router.push('/settings/export')}
            testID="settings-export"
          />
          <SettingsRow
            title="App Icon"
            onPress={() => router.push('/settings/icons')}
            testID="settings-app-icon"
          />
        </SettingsGroup>

        <SettingsGroup title="App information">
          <SettingsRow
            title="Timeline"
            onPress={() => router.push('/settings/timeline')}
            testID="settings-timeline"
          />
          <SettingsRow
            title="Privacy Policy"
            onPress={() => openLink('privacyPolicy', 'Privacy Policy')}
            external
            testID="settings-privacy"
          />
          <SettingsRow
            title="Terms Of Use"
            onPress={() => openLink('termsOfUse', 'Terms Of Use')}
            external
            testID="settings-terms"
          />
          <SettingsRow
            title="Version"
            detail={`${meta.appVersion} (${meta.buildVersion})`}
            testID="settings-version"
          />
        </SettingsGroup>

      </ScrollView>
    </View>
  );
}
