import { test } from '@e2e-dev/mobile';
import { reveal } from './reveal';
import { expect } from 'e2e';

const pages = [
  ['settings-anchors', 'anchor-wake'],
  ['settings-notifications', 'notifications-status'],
  ['settings-icloud', 'icloud-status'],
  ['open-archived-boards', 'archived-empty'],
  ['settings-import', 'import-own'],
  ['settings-export', 'export-start'],
  ['settings-app-icon', 'icon-preview-default'],
] as const;
for (const [row, assertion] of pages) {
  test(`settings opens ${row} with its actual content`, { tags: ['deterministic', 'settings'] }, async ({ app, screen }) => {
    await app.open();
    await screen.getByTestId('open-settings').tap();
    await reveal(screen, screen.getByTestId(row));
    await screen.getByTestId(row).tap();
    await expect(screen.getByTestId(assertion)).toBeVisible();
  });
}

test('anchor editor cancels without changing the stored time', { tags: ['deterministic'] }, async ({ app, screen, device }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  await screen.getByTestId('settings-anchors').tap();
  const label = await screen.getByTestId('anchor-wake').textContent();
  await screen.getByTestId('anchor-wake').tap();
  await expect(screen.getByTestId('anchor-minute-picker')).toBeVisible();
  await screen.getByTestId('anchor-cancel').tap();
  await expect(screen.getByTestId('anchor-minute-picker')).not.toBeVisible();
  await device.back();
  await screen.getByTestId('settings-anchors').tap();
  await expect(screen.getByTestId('anchor-wake')).toHaveText(label ?? '');
});

test('settings timeline renders the current release notes', { tags: ['deterministic', 'settings'] }, async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  await reveal(screen, screen.getByTestId('settings-timeline'));
  await screen.getByTestId('settings-timeline').tap();
  await expect(screen.getByText('In development')).toBeVisible();
});
