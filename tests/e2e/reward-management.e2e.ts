import { test } from '@e2e-dev/mobile';
import { reveal } from './reveal';
import { expect } from 'e2e';

test('reward archive and restore preserve its saved price', { tags: ['deterministic', 'rewards'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const name = `QA Archive Reward ${Date.now()}`;
  await app.open();
  await screen.getByTestId('coin-balance-pill').tap();
  await screen.getByTestId('create-reward').tap();
  await screen.getByTestId('reward-title-input').fill(name);
  await screen.getByTestId('reward-cost-input').fill('7');
  await device.dismissKeyboard();
  await screen.getByTestId('reward-form-save').tap();
  await screen.getByRole('button', { name: `${name}, 7 coins` }).tap();
  await reveal(device, screen, screen.getByTestId('archive-reward'));
  await screen.getByTestId('archive-reward').tap();
  await screen.getByRole('button', { name: 'Archive', exact: true }).tap();
  await app.restart();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByRole('button', { name: `${name}, 7 coins` })).not.toBeVisible();
  await screen.getByTestId('rewards-archived').tap();
  await screen.getByRole('button', { name: `${name}, 7 coins, archived reward` }).tap();
  await screen.getByTestId('restore-reward').tap();
  await app.restart();
  await screen.getByTestId('coin-balance-pill').tap();
  await expect(screen.getByRole('button', { name: `${name}, 7 coins` })).toBeVisible();
});
