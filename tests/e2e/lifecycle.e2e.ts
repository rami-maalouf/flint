import { replaceField } from "./replace-field";
import { test } from '@e2e-dev/mobile';
import { localSyntheticEnabled } from './local-mode';
import { reveal } from './reveal';
import { expect } from 'e2e';
import { syntheticQuickControl } from './synthetic-store';

// unique synthetic entities keep retries independent without resetting personal data.
test('daily completion, undo, persisted coins and reward refusal', { skip: !localSyntheticEnabled, tags: ['deterministic', 'lifecycle'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const name = `QA Daily ${Date.now()}`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toBeVisible();
  const baseline = Number((await screen.getByTestId('coins-balance').textContent())?.match(/-?\d+/)?.[0]);
  await device.back();
  await screen.getByTestId('create-board').tap();
  await replaceField(screen.getByTestId('board-title-input'), name, { device, screen });
  await device.dismissKeyboard();
  await reveal(device, screen, screen.getByTestId('earn-coins-toggle'));
  await screen.getByTestId('earn-coins-toggle').tap();
  await expect(screen.getByTestId('earn-coins-toggle')).toBeChecked();
  await screen.getByTestId('board-form-save').tap();
  await reveal(device, screen, screen.getByRole('button', { name }));
  const quick = screen.getByTestId(syntheticQuickControl(name));
  await reveal(device, screen, quick);
  await quick.tap();
  await screen.getByTestId('undo-check-in').tap();
  await reveal(device, screen, quick);
  await expect(quick).not.toBeChecked();
  await quick.tap();
  await expect(quick).toBeChecked();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await reveal(device, screen, quick);
  await expect(quick).toBeChecked();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toBeVisible();
  await screen.getByTestId('coins-history-link').tap();
  await expect(screen.getByTestId('coin-history-list')).toBeVisible();
  await expect(screen.getByLabel(new RegExp(name))).toHaveCount(3);
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('coin-balance-pill').tap();
  await screen.getByTestId('create-reward').tap();
  const reward = `QA Reward ${Date.now()}`;
  await replaceField(screen.getByTestId('reward-title-input'), reward, { device, screen });
  await replaceField(screen.getByTestId('reward-cost-input'), '1', { device, screen, numeric: true });
  await device.dismissKeyboard();
  await screen.getByTestId('reward-form-save').tap();
  const claim = screen.getByRole('button', { name: `Claim ${reward} for 1 coin` });
  for (let attempt = 0; attempt < 8 && !await claim.isVisible(); attempt++) {
    await screen.swipe({ from: { x: 200, y: 720 }, to: { x: 200, y: 300 } });
  }
  await screen.getByRole('button', { name: `Claim ${reward} for 1 coin` }).tap();
  await screen.getByRole('button', { name: 'Claim', exact: true }).tap();
  await expect(screen.getByTestId('reward-claim-success')).toContainText(reward);
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toHaveText(new RegExp(`(?:^|\\D)${baseline}(?:\\D|$)`));
  const rewardEdit = screen.getByRole('button', { name: `${reward}, 1 coin` });
  for (let attempt = 0; attempt < 8 && !await rewardEdit.isVisible(); attempt++) {
    await screen.swipe({ from: { x: 200, y: 720 }, to: { x: 200, y: 300 } });
  }
  await screen.getByRole('button', { name: `${reward}, 1 coin` }).tap();
  await replaceField(screen.getByTestId('reward-cost-input'), '100000', { device, screen, numeric: true });
  await device.dismissKeyboard();
  await screen.getByTestId('reward-form-save').tap();
  const refusal = screen.getByRole('button', { name: `Claim ${reward} for 100000 coins` });
  for (let attempt = 0; attempt < 8 && !await refusal.isVisible(); attempt++) {
    await screen.swipe({ from: { x: 200, y: 720 }, to: { x: 200, y: 300 } });
  }
  await screen.getByRole('button', { name: `Claim ${reward} for 100000 coins` }).tap();
  await expect(screen.getByTestId('reward-claim-error')).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toHaveText(new RegExp(`(?:^|\\D)${baseline}(?:\\D|$)`));
});

test('board detail exposes history, journal and analytics', { skip: !localSyntheticEnabled, tags: ['deterministic'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const name = `QA History ${Date.now()}`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('create-board').tap();
  await replaceField(screen.getByTestId('board-title-input'), name, { device, screen });
  await device.dismissKeyboard();
  await screen.getByTestId('board-form-save').tap();
  await reveal(device, screen, screen.getByRole('button', { name }));
  await screen.getByRole('button', { name }).tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
  await reveal(device, screen, screen.getByTestId('open-check-ins'));
  await screen.getByTestId('open-check-ins').tap();
  await expect(screen.getByText('Check-Ins', { exact: false }).first()).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await reveal(device, screen, screen.getByRole('button', { name }));
  await screen.getByRole('button', { name }).tap();
  await reveal(device, screen, screen.getByTestId('open-journal'));
  await screen.getByTestId('open-journal').tap();
  await expect(screen.getByText('Journal').first()).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await reveal(device, screen, screen.getByRole('button', { name }));
  await screen.getByRole('button', { name }).tap();
  await reveal(device, screen, screen.getByTestId('open-analytics'));
  await screen.getByTestId('open-analytics').tap();
  await expect(screen.getByText('Analytics').first()).toBeVisible();
});
