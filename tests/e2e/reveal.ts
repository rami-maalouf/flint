import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

// target the native outer scroller, avoiding inert nested containers and fast flick overshoot.
export async function reveal(device: Device, screen: Screen, target: Locator, options: { direction?: 'up' | 'down' } = {}) {
  void screen;
  if (await target.isVisible()) return;
  const homeList = screen.getByTestId('boards-list');
  const scroller = await homeList.isVisible() ? homeList : device.locator('role=scroll-view').first();
  await expect(scroller).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 24 && !await target.isVisible(); attempt++) {
    await scroller.swipe({ direction: options.direction ?? 'down', momentum: 'slow' });
  }
  await expect(target).toBeVisible();
}
