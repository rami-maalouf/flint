import { test } from '@e2e-dev/mobile';
import { localSyntheticEnabled } from './local-mode';
import { reveal } from './reveal';
import { expect } from 'e2e';
import { syntheticQuickControl } from './synthetic-store';

test('anchored daily stack completion earns and reverses its bonus', { skip: !localSyntheticEnabled, tags: ['deterministic', 'stacks'], timeout: 240_000 }, async ({ app, screen, device }) => {
  const root = `QA Stack Root ${Date.now()}`;
  const leaf = `${root} next`;
  await app.open();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toBeVisible();
  const baseline = Number((await screen.getByTestId('coins-balance').textContent())?.match(/-?\d+/)?.[0]);
  await device.back();
  for (const title of [root, leaf]) {
    await screen.getByTestId('create-board').tap();
    await screen.getByTestId('board-title-input').fill(title);
    await device.dismissKeyboard();
    await reveal(device, screen, screen.getByTestId('board-anchor-row'));
    await screen.getByTestId('board-anchor-row').tap();
    if (title === root) await screen.getByTestId('anchor-preset-wake').tap();
    else await screen.getByRole('button', { name: root, exact: true }).tap();
    await screen.getByTestId('anchor-picker-done').tap();
    await reveal(device, screen, screen.getByTestId('earn-coins-toggle'));
    await screen.getByTestId('earn-coins-toggle').tap();
    await screen.getByTestId('board-form-save').tap();
    await expect(screen.getByRole('button', { name: title, exact: true })).toBeVisible();
  }
  for (const title of [root, leaf]) {
    const quick = screen.getByTestId(syntheticQuickControl(title));
    await reveal(device, screen, quick);
    await quick.tap();
    await expect(quick).toBeChecked();
  }
  await screen.getByTestId('open-stacks').tap();
  const complete = screen.getByRole('button', { name: new RegExp(`${root}.*2 of 2 required habits checked`) });
  await expect(complete).toBeVisible();
  await complete.tap();
  await expect(screen.getByTestId('stack-detail')).toBeVisible();
  await expect(screen.getByTestId('stack-heatmap')).toBeVisible();
  await app.restart();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toHaveText(new RegExp(`(?:^|\\D)${baseline + 3}(?:\\D|$)`));
  await app.restart();
  const leafQuick = screen.getByTestId(syntheticQuickControl(leaf));
  await reveal(device, screen, leafQuick);
  await leafQuick.tap();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByTestId('coins-balance')).toHaveText(new RegExp(`(?:^|\\D)${baseline + 1}(?:\\D|$)`));
});
