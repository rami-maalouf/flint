import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

// target the native outer scroller, avoiding inert nested containers and fast flick overshoot.
export async function reveal(device: Device, screen: Screen, target: Locator, options: { direction?: 'up' | 'down' } = {}) {
  if (!await target.isVisible()) {
    const homeList = screen.getByTestId('boards-list');
    const scroller = await homeList.isVisible() ? homeList : device.locator('role=scroll-view').first();
    await expect(scroller).toBeVisible({ timeout: 30_000 });
    for (let attempt = 0; attempt < 24 && !await target.isVisible(); attempt++) {
      await scroller.swipe({ direction: options.direction ?? 'down', momentum: 'slow' });
    }
  }
  await expect(target).toBeVisible();
  let previous = '';
  let stationary = 0;
  await expect.poll(async () => {
    const box = await target.boundingBox();
    if (!box) return false;
    const current = [box.x, box.y, box.width, box.height].map(value => Math.round(value * 2)).join(',');
    stationary = current === previous ? stationary + 1 : 0;
    previous = current;
    return stationary >= 2;
  }, { timeout: 10_000, interval: 250, message: 'the revealed control must stop moving before interaction' }).toBe(true);
}
