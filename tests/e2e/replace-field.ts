import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

type InputContext = { device: Device; screen: Screen; numeric?: boolean };

// wait for the keyboard and the presented field before injecting into a native sheet.
export async function replaceField(input: Locator, value: string, { device, screen, numeric }: InputContext) {
  await expect(input).toBeVisible();
  await input.tap();
  await expect(device.locator('role=key').first()).toBeVisible();
  let previousBounds = '';
  let stationary = 0;
  await expect.poll(async () => {
    const box = await input.boundingBox();
    if (!box) return false;
    const bounds = [box.x, box.y, box.width, box.height].map(n => Math.round(n)).join(',');
    stationary = bounds === previousBounds ? stationary + 1 : 0;
    previousBounds = bounds;
    return stationary >= 2;
  }, { timeout: 10_000, interval: 250, message: 'the focused input must settle with its keyboard visible' }).toBe(true);
  if (numeric) {
    const previous = await input.inputValue();
    const box = await input.boundingBox();
    if (!box) throw new Error('focused numeric input bounds are unavailable');
    await screen.tapAt({ x: box.x + box.width - 1, y: box.y + box.height / 2 });
    const remove = device.locator('role=key label=Delete');
    await expect(remove).toBeVisible();
    for (const character of previous) {
      void character;
      await remove.tap();
    }
    await expect(input).toHaveValue('');
    for (const character of value) {
      if (!/[0-9.]/.test(character)) throw new Error('numeric keyboard entry supports digits and decimal points only');
      await device.locator(`role=key label="${character}"`).tap();
    }
  } else {
    await input.clear();
    await expect(input).toHaveValue('');
    await input.fill(value);
  }
  await expect(input).toHaveValue(value);
}
