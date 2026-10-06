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
  test(`settings opens ${row} with its actual content`, { tags: ['deterministic', 'settings'] }, async ({ app, screen, device }) => {
    await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await screen.getByTestId('open-settings').tap();
    await reveal(device, screen, screen.getByTestId(row));
    await screen.getByTestId(row).tap();
    await expect(screen.getByTestId(assertion)).toBeVisible();
  });
}

test('anchor editor cancels without changing the stored time', { tags: ['deterministic'] }, async ({ app, screen, device }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('open-settings').tap();
  await screen.getByTestId('settings-anchors').tap();
  const label = await screen.getByTestId('anchor-wake').textContent();
  await screen.getByTestId('anchor-wake').tap();
  await expect(screen.getByTestId('anchor-minute-picker')).toBeVisible();
  await screen.getByTestId('anchor-cancel').tap();
  await expect(screen.getByTestId('anchor-minute-picker')).not.toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({timeout: 60_000});
  await screen.getByTestId('open-settings').tap();
  await screen.getByTestId('settings-anchors').tap();
  await expect(screen.getByTestId('anchor-wake')).toHaveText(label ?? '');
});

test('a changed global wake anchor persists after saving and reopening', { tags: ['settings'], timeout: 180_000 }, async ({ app, screen, agent }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('open-settings').tap();
  await screen.getByTestId('settings-anchors').tap();
  const row = screen.getByTestId('anchor-wake');
  await expect(row).toBeVisible();
  const original = await row.textContent();
  const chosen = original?.includes('5:45') ? '6:00 AM' : '5:45 AM';
  await row.tap();
  await expect(screen.getByTestId('anchor-minute-picker')).toBeVisible();
  await agent.act(`select ${chosen} in the visible anchor time wheel, leaving the editor open`);
  await screen.getByTestId('anchor-save').tap();
  await expect(screen.getByTestId('anchor-minute-picker')).not.toBeVisible();
  await expect(row).toHaveText(new RegExp(chosen.replace(' ', '\\s*')));
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('open-settings').tap();
  await screen.getByTestId('settings-anchors').tap();
  await expect(row).toHaveText(new RegExp(chosen.replace(' ', '\\s*')));
});

test('settings timeline renders the current release notes', { tags: ['deterministic', 'settings'] }, async ({ app, screen, device }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('open-settings').tap();
  await reveal(device, screen, screen.getByTestId('settings-timeline'));
  await screen.getByTestId('settings-timeline').tap();
  await expect(screen.getByText('In development')).toBeVisible();
});
