import { execFileSync } from 'node:child_process';
import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';
import { localSyntheticEnabled } from './local-mode';
import { reveal } from './reveal';
import { syntheticQuickControl } from './synthetic-store';

for (const appearance of ['light', 'dark'] as const) {
  test(`${appearance} appearance at largest Dynamic Type keeps completion and navigation reachable`, {
    skip: !localSyntheticEnabled, tags: ['deterministic', 'accessibility'], timeout: 240_000,
  }, async ({ app, screen, device, agent }) => {
    const ui = (...args: string[]) => execFileSync('xcrun', ['simctl', 'ui', process.env.E2E_DEVICE!, ...args], { encoding: 'utf8' }).trim();
    const previousAppearance = ui('appearance');
    const previousSize = ui('content_size');
    try {
      ui('appearance', appearance);
      ui('content_size', 'accessibility-extra-extra-extra-large');
      await app.open();
      await expect(screen.getByTestId('create-board')).toBeVisible();
      await screen.getByTestId('create-board').tap();
      const title = `QA Accessible ${appearance} ${Date.now()}`;
      await screen.getByTestId('board-title-input').fill(title);
      await device.dismissKeyboard();
      await reveal(device, screen, screen.getByTestId('board-form-save'));
      await screen.getByTestId('board-form-save').tap();
      const board = screen.getByRole('button', { name: title, exact: true });
      await reveal(device, screen, board);
      const quick = screen.getByTestId(syntheticQuickControl(title));
      await reveal(device, screen, quick);
      const bounds = await quick.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      await app.screenshot(`${appearance}-largest-type-home`);
      await agent.assert('At the largest text size, this habit card and its completion control remain readable, reachable and free of clipped text or overlapping controls. Inspect the screenshot.', { vision: 'only' });
      await quick.tap();
      await expect(quick).toBeChecked();
      await board.tap();
      await expect(screen.getByTestId('board-heatmap')).toBeVisible();
      await app.screenshot(`${appearance}-largest-type-detail`);
      await agent.assert('This habit detail screen has readable headings and no clipped or overlapping navigation controls at the largest text size. Inspect the screenshot.', { vision: 'only' });
      await app.restart();
      await screen.getByTestId('open-settings').tap();
      await reveal(device, screen, screen.getByTestId('settings-export'));
      await expect(screen.getByTestId('settings-export')).toBeVisible();
      await app.screenshot(`${appearance}-largest-type-settings`);
      await agent.assert('These settings rows remain readable and do not overlap or clip their labels at the largest text size. Inspect the screenshot.', { vision: 'only' });
    } finally {
      if (previousAppearance === 'light' || previousAppearance === 'dark') ui('appearance', previousAppearance);
      if (previousSize !== 'unknown' && previousSize !== 'unsupported') ui('content_size', previousSize);
    }
  });
}
