import { replaceField } from "./replace-field";
import { test } from '@e2e-dev/mobile';
import { localSyntheticEnabled } from './local-mode';
import { expect } from 'e2e';
import { syntheticBoardId, syntheticRows } from './synthetic-store';
import { reveal } from './reveal';

test('widget daily deep link completes, undoes and preserves a check after restart', { skip: !localSyntheticEnabled, tags: ['deterministic', 'widget'], timeout: 180_000 }, async ({ app, screen, device }) => {
  const name = `QA Widget ${Date.now()}`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('create-board').tap();
  await replaceField(screen.getByTestId('board-title-input'), name, { device, screen });
  await device.dismissKeyboard();
  await screen.getByTestId('board-form-save').tap();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  await reveal(device, screen, screen.getByRole('button', { name, exact: true }));
  await expect(screen.getByRole('button', { name, exact: true })).toBeVisible();
  const id = syntheticBoardId(name);
  await device.openLink(`habitsystem://boards/${id}/quick-action`);
  await expect(screen.getByTestId('daily-widget-action')).toHaveText('Check');
  const action = await screen.getByTestId("daily-widget-action").boundingBox();
  expect(action).not.toBeNull();
  await screen.tapAt({ x: action!.x + action!.width / 2, y: action!.y + action!.height / 2 });
  const checks = () => syntheticRows(`select id from check_ins where board_id='${id}' and deleted_at is null`);
  expect(checks()).toHaveLength(1);
  const undo = await screen.getByTestId("daily-widget-undo").boundingBox();
  expect(undo).not.toBeNull();
  // the undo affordance expires after five seconds; use its observed bounds immediately.
  await screen.tapAt({ x: undo!.x + undo!.width / 2, y: undo!.y + undo!.height / 2 });
  await expect.poll(() => checks().length).toBe(0);
  await expect(screen.getByTestId('daily-widget-action')).toHaveText('Check');
  await screen.getByTestId('daily-widget-action').tap();
  await expect(screen.getByTestId('daily-widget-action')).toHaveText('Uncheck');
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await device.openLink(`habitsystem://boards/${id}/quick-action`);
  await expect(screen.getByTestId('daily-widget-action')).toHaveText('Uncheck');
});
