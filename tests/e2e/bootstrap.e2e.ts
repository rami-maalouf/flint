import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('development client connects to the isolated checkout', { tags: ['bootstrap'], skip: process.env.E2E_BOOTSTRAP !== '1', timeout: 180_000 }, async ({ app, device, screen }) => {
  await app.open();
  const metro = process.env.E2E_METRO_URL ?? 'http://127.0.0.1:8085';
  await device.openLink(`habitsystem://expo-development-client/?url=${encodeURIComponent(metro)}`);
  await device.alert('accept');
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 90_000 });
});
