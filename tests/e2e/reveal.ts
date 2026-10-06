import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

// target the native outer scroller, avoiding inert nested containers and fast flick overshoot.
export async function reveal(device: Device, screen: Screen, target: Locator, options: { direction?: 'up' | 'down' } = {}) {
  const viewport = await device.locator("role=application").first().boundingBox();
  const reachable = async () => {
    if (!await target.isVisible()) return false;
    const box = await target.boundingBox();
    if (!box || !viewport) return false;
    return box.y >= viewport.y + 24 && box.y + box.height <= viewport.y + viewport.height - 24;
  };
  if (!await reachable()) {
    const homeList = screen.getByTestId('boards-list');
    const scroller = await homeList.isVisible() ? homeList : device.locator('role=scroll-view').first();
    await expect(scroller).toBeVisible({ timeout: 30_000 });
    for (let attempt = 0; attempt < 24 && !await reachable(); attempt++) {
      const box = await scroller.boundingBox();
      if (!box) throw new Error('the active scroller has no visible bounds');
      // the left gutter avoids multiline inputs and embedded heatmaps consuming the gesture.
      const x = box.x + Math.min(16, box.width / 10);
      const down = options.direction !== 'up';
      await screen.swipe({
        from: { x, y: box.y + box.height * (down ? 0.75 : 0.5) },
        to: { x, y: box.y + box.height * (down ? 0.5 : 0.75) },
      });
    }
  }
  await expect(target).toBeVisible();
  expect(await reachable()).toBe(true);
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
