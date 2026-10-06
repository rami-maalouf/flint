import { expect, type Locator, type Screen } from 'e2e';

// the pinned iOS runner's synthesized scroll can target a nested inert container.
// raw drags start inside the application's content area and scale with its viewport.
export async function reveal(screen: Screen, target: Locator, options: { direction?: 'up' | 'down' } = {}) {
  const viewport = await screen.getByLabel('Habit System').first().boundingBox();
  if (!viewport || viewport.height < 500) throw new Error('application viewport is unavailable');
  const x = viewport.x + viewport.width / 2;
  const top = viewport.y + viewport.height * 0.36;
  const bottom = viewport.y + viewport.height * 0.82;
  const upward = options.direction !== 'up';
  for (let attempt = 0; attempt < 16 && !await target.isVisible(); attempt++) {
    await screen.swipe({ from: { x, y: upward ? bottom : top }, to: { x, y: upward ? top : bottom } });
  }
  await expect(target).toBeVisible();
}
