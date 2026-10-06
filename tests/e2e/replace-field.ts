import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

export async function replaceField(input: Locator, value: string, options?: { device: Device; screen: Screen; numeric: true }) {
  await expect(input).toBeVisible();
  if (options) {
    const previous = await input.inputValue();
    await input.tap();
    const remove = options.device.locator('role=key label=Delete');
    await expect(remove).toBeVisible();
    // focusing expands the sheet; only use the field's bounds after the keyboard appears.
    const box = await input.boundingBox();
    if (!box) throw new Error('focused numeric input bounds are unavailable');
    await options.screen.tapAt({ x: box.x + box.width - 1, y: box.y + box.height / 2 });
    for (const character of previous) {
      void character;
      await remove.tap();
    }
  } else {
    await input.clear();
  }
  await input.fill(value);
  await expect(input).toHaveValue(value);
}
