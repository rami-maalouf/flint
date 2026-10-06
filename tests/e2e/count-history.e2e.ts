import { replaceField } from './replace-field';
import { test } from '@e2e-dev/mobile';
import { reveal } from './reveal';
import { expect } from 'e2e';

test('count board amounts and notes persist through check-in edit and deletion', { tags: ['deterministic', 'history'], timeout: 240_000 }, async ({ app, screen, device }) => {
  const name = `QA Count ${Date.now()}`;
  const note = `QA note ${Date.now()}`;
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await screen.getByTestId('create-board').tap();
  await expect(screen.getByTestId('board-title-input')).toBeVisible();
  await screen.getByTestId('board-title-input').fill(name);
  await device.dismissKeyboard();
  await reveal(device, screen, screen.getByTestId('board-kind-picker'));
  await screen.getByTestId('board-kind-picker').tap();
  await screen.getByRole('button', { name: 'Count', exact: true }).tap();
  await reveal(device, screen, screen.getByTestId('amounts-toggle'));
  await screen.getByTestId('amounts-toggle').tap();
  await screen.getByTestId('unit-input').fill('cups');
  await device.dismissKeyboard();
  await screen.getByTestId('board-form-save').tap();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  await reveal(device, screen, screen.getByRole('button', { name, exact: true }));
  await screen.getByRole('button', { name, exact: true }).tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
  await reveal(device, screen, screen.getByTestId('detail-add-check-in'));
  await screen.getByTestId('detail-add-check-in').tap();
  await replaceField(screen.getByTestId('check-in-amount'), '2', {device, screen, numeric: true});
  await replaceField(screen.getByTestId('check-in-note'), note);
  await screen.getByTestId('check-in-save').tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
  await reveal(device, screen, screen.getByTestId('open-journal'));
  await screen.getByTestId('open-journal').tap();
  await expect(screen.getByRole('button', { name: new RegExp(`2 cups.*${note}`) })).toBeVisible();
  await screen.getByLabel(new RegExp(note)).first().tap();
  await expect(screen.getByTestId('check-in-note')).toHaveValue(note);
  await expect(screen.getByTestId('check-in-amount')).toHaveValue('2');
  await replaceField(screen.getByTestId('check-in-amount'), '3', { device, screen, numeric: true });
  await replaceField(screen.getByTestId('check-in-note'), `${note} edited`);
  await screen.getByTestId('check-in-save').tap();
  await expect(screen.getByRole('button', { name: new RegExp(`3 cups.*${note} edited`) })).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await reveal(device, screen, screen.getByRole('button', { name, exact: true }));
  await screen.getByRole('button', { name, exact: true }).tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
  await screen.getByTestId('open-journal').tap();
  await expect(screen.getByRole('button', { name: new RegExp(`3 cups.*${note} edited`) })).toBeVisible();
  await screen.getByLabel(new RegExp(`${note} edited`)).first().tap();
  await expect(screen.getByTestId('check-in-note')).toBeVisible();
  const grabber = screen.getByRole('button', { name: 'Sheet Grabber', exact: true });
  if (await grabber.isVisible()) {
    const box = await grabber.boundingBox();
    if (!box) throw new Error('the visible sheet grabber has no bounds');
    await screen.swipe({
      from: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      to: { x: box.x + box.width / 2, y: box.y / 4 },
    });
    await expect.poll(async () => (await grabber.boundingBox())?.y ?? Infinity,
      { timeout: 10_000, message: 'the check-in sheet must expand before scrolling to delete' }).toBeLessThan(box.y / 2);
  }
  await reveal(device, screen, screen.getByTestId('delete-check-in'));
  await screen.getByTestId('delete-check-in').tap();
  await screen.getByRole('group', { name: 'Delete Check-In', exact: true }).getByRole('button', { name: 'Delete Check-In', exact: true }).tap();
  await expect(screen.getByTestId('journal-empty')).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await reveal(device, screen, screen.getByRole('button', { name, exact: true }));
  await screen.getByRole('button', { name, exact: true }).tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
  await reveal(device, screen, screen.getByTestId('open-journal'));
  await screen.getByTestId('open-journal').tap();
  await expect(screen.getByTestId('journal-empty')).toBeVisible();
});
