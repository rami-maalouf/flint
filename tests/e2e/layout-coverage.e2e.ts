import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

for (const name of ['Full-width cards', 'Two-column grid', 'Compact rows', '14-day summary']) {
  test(`layout persists ${name} across relaunch`, { tags: ['deterministic', 'layout'] }, async ({ app, screen }) => {
    await app.open();
    await screen.getByTestId('open-board-layout').tap();
    await screen.getByLabel(name).tap();
    await expect(screen.getByLabel(name)).toBeSelected();
    await screen.getByTestId('done-board-layout').tap();
    await app.restart();
    await screen.getByTestId('open-board-layout').tap();
    await expect(screen.getByLabel(name)).toBeSelected();
    await screen.getByTestId('done-board-layout').tap();
  });
}
