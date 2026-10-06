import { replaceField } from './replace-field';
import { test } from '@e2e-dev/mobile';
import { reveal } from './reveal';
import { expect } from 'e2e';

test('reminder creation, edit and deletion persist without sending external messages', { tags: ['deterministic', 'reminders'], timeout: 240_000 }, async ({ app, screen, device }) => {
  const name = `QA Reminder ${Date.now()}`;
  const message = `QA remind ${Date.now()}`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('create-board').tap();
  await screen.getByTestId('board-title-input').fill(name);
  await device.dismissKeyboard();
  await screen.getByTestId('board-form-save').tap();
  await screen.getByRole('button', { name, exact: true }).tap();
  await screen.getByTestId('edit-board').tap();
  await expect(screen.getByTestId('board-title-input')).toBeVisible();
  await reveal(device, screen, screen.getByTestId('add-reminder-row'));
  await screen.getByTestId('add-reminder-row').tap();
  await replaceField(screen.getByTestId('reminder-message'), message);
  await device.dismissKeyboard();
  await screen.getByTestId('reminder-save').tap();
  {
    const allow = screen.getByRole('button', {name: 'Allow', exact: true});
    if (await allow.isVisible()) await allow.tap();
  }
  await reveal(device, screen, screen.getByRole('button', { name: /^Reminder / }).first());
  await screen.getByRole('button', { name: /^Reminder / }).first().tap();
  await expect(screen.getByTestId('reminder-message')).toHaveValue(message);
  await screen.getByTestId('reminder-message').fill(`${message} edited`);
  await device.dismissKeyboard();
  await screen.getByTestId('reminder-save').tap();
  {
    const allow = screen.getByRole('button', {name: 'Allow', exact: true});
    if (await allow.isVisible()) await allow.tap();
  }
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByRole('button', { name, exact: true }).tap();
  await screen.getByTestId('edit-board').tap();
  await expect(screen.getByTestId('board-title-input')).toBeVisible();
  await reveal(device, screen, screen.getByRole('button', { name: /^Reminder / }).first());
  await screen.getByRole('button', { name: /^Reminder / }).first().tap();
  await expect(screen.getByTestId('reminder-message')).toHaveValue(`${message} edited`);
  await reveal(device, screen, screen.getByTestId('delete-reminder'));
  await screen.getByTestId('delete-reminder').tap();
  await screen.getByRole('button', { name: 'Delete Reminder', exact: true }).last().tap();
  await expect(screen.getByRole('button', { name: /^Reminder / })).toHaveCount(0);
});
