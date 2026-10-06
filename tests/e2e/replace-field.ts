import { expect, type Locator, type Screen } from 'e2e';
import type { Device } from '@e2e-dev/mobile';

type InputContext = { device: Device; screen: Screen; numeric?: boolean };

// wait for the keyboard and the presented field before injecting into a native sheet.
export async function replaceField(input: Locator, value: string, { device, screen, numeric }: InputContext) {
  await expect(input).toBeVisible();
  await input.tap();
  const firstKey = device.locator("role=key").first();
  await expect(firstKey).toBeVisible();
  for (let attempt = 0; attempt < 8; attempt++) {
    const field = await input.boundingBox();
    const key = await firstKey.boundingBox();
    if (!field || !key) throw new Error("focused input and keyboard bounds are required");
    if (field.y + field.height < key.y - 60) break;
    await screen.swipe({
      from: { x: 16, y: key.y - 80 },
      to: { x: 16, y: Math.max(140, key.y - 260) },
    });
  }
  const field = await input.boundingBox();
  const key = await firstKey.boundingBox();
  expect(field).not.toBeNull();
  expect(key).not.toBeNull();
  expect(field!.y + field!.height).toBeLessThan(key!.y - 60);
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
    // ios exposes an empty field's placeholder as its value; verify the committed result below.
    await input.fill(value);
  }
  await expect(input).toHaveValue(value);
}
