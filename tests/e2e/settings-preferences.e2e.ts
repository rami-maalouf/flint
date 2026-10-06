import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';
import { reveal } from './reveal';

async function dismissIconNotice(screen: import('e2e').Screen) {
  const ok = screen.getByRole('button', { name: 'OK', exact: true });
  if (await ok.isVisible()) await ok.tap();
}

test('alternate app icon selection persists and returns to the default', { tags: ['deterministic', 'settings'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const open = async () => {
    await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByTestId('open-settings')).toBeVisible();
    await screen.getByTestId('open-settings').tap();
    await reveal(device, screen, screen.getByTestId('settings-app-icon'));
    await screen.getByTestId('settings-app-icon').tap();
    await expect(screen.getByTestId('icon-preview-default')).toBeVisible();
  };
  await open();
  const midnight = screen.getByRole('button', { name: 'Use Midnight icon', exact: true });
  await expect(midnight).toBeEnabled();
  try {
    await midnight.tap();
    await dismissIconNotice(screen);
    await expect(midnight).toBeSelected();
    await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await open();
    await expect(midnight).toBeSelected();
  } finally {
    const standard = screen.getByRole('button', { name: 'Use Default icon', exact: true });
    if (await standard.isVisible()) {
      await standard.tap();
      await dismissIconNotice(screen);
      await expect(standard).toBeSelected();
    }
  }
});

test('iCloud setting persists off and on without claiming account sync', { tags: ['deterministic', 'settings'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const open = async () => {
    await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByTestId('open-settings')).toBeVisible();
    await screen.getByTestId('open-settings').tap();
    await reveal(device, screen, screen.getByTestId('settings-icloud'));
    await screen.getByTestId('settings-icloud').tap();
    await expect(screen.getByTestId('icloud-toggle')).toBeEnabled();
  };
  await open();
  const toggle = screen.getByTestId('icloud-toggle');
  const original = await toggle.isChecked();
  try {
    if (original) await toggle.tap();
    await expect(toggle).not.toBeChecked();
    await expect(screen.getByTestId('icloud-status')).toContainText('Off');
    await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await open();
    await expect(toggle).not.toBeChecked();
    await toggle.tap();
    await expect(toggle).toBeChecked();
    await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await open();
    await expect(toggle).toBeChecked();
  } finally {
    if (await toggle.isVisible() && (await toggle.isChecked()) !== original) await toggle.tap();
  }
});
