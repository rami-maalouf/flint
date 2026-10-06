import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('an unavailable board deep link offers recovery to boards', { tags: ['deterministic', 'recovery'] }, async ({ app, screen, device }) => {
  await app.open();
  await device.openLink('habitsystem://boards/00000000-0000-4000-8000-000000000000');
  await expect(screen.getByTestId('board-recovery-home')).toBeVisible();
  await screen.getByTestId('board-recovery-home').tap();
  await expect(screen.getByTestId('create-board')).toBeVisible();
});
