import { replaceField } from "./replace-field";
import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';
import { localSyntheticEnabled } from './local-mode';
import { reveal } from './reveal';
import { syntheticBoardId, syntheticQuickControl, syntheticRows } from './synthetic-store';

test('moving a test-owned board above its adjacent sibling persists its order', { skip: !localSyntheticEnabled, tags: ['deterministic', 'boards'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const first = `QA Order ${Date.now()}`;
  const second = `${first} next`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  for (const title of [first, second]) {
    await screen.getByTestId('create-board').tap();
    await replaceField(screen.getByTestId('board-title-input'), title, { device, screen });
    await device.dismissKeyboard();
    await screen.getByTestId('board-form-save').tap();
    await reveal(device, screen, screen.getByRole('button', { name: title, exact: true }));
  }
  const a = syntheticBoardId(first);
  const b = syntheticBoardId(second);
  const order = () => (syntheticRows('select id from boards where archived_at is null and deleted_at is null order by order_key, id') as { id: string }[]).map(row => row.id);
  expect(order().indexOf(b)).toBe(order().indexOf(a) + 1);
  const move = screen.getByTestId(syntheticQuickControl(second).replace('-quick', '-move-up'));
  await screen.getByTestId('toggle-edit-boards').tap();
  await reveal(device, screen, move);
  await move.tap();
  await expect.poll(() => order().indexOf(a) - order().indexOf(b)).toBe(1);
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  expect(order().indexOf(b)).toBe(order().indexOf(a) - 1);
});
