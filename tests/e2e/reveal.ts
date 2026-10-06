import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

// the pinned ios runner's synthesized scroll can target a nested inert container.
// raw drags start inside the application's content area and scale with its viewport.
export async function reveal(device: Device, screen: Screen, target: Locator, options: { direction?: 'up' | 'down' } = {}) {
  if (await target.isVisible()) return;
  const scroller = device.locator('role=scroll-view').first();
  await expect(scroller).toBeVisible({ timeout: 30_000 });
  const viewport = await scroller.boundingBox();
  if (!viewport || viewport.height < 100) throw new Error('scrollable content bounds are unavailable');
  const x = viewport.x + viewport.width / 2;
  const top = viewport.y + viewport.height * 0.36;
  const bottom = viewport.y + viewport.height * 0.82;
  const upward = options.direction !== 'up';
  for (let attempt = 0; attempt < 16 && !await target.isVisible(); attempt++) {
    await screen.swipe({ from: { x, y: upward ? bottom : top }, to: { x, y: upward ? top : bottom } });
  }
  await expect(target).toBeVisible();
}
