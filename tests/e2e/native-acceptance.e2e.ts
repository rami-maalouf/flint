import { test } from '@e2e-dev/mobile';
import { localSyntheticEnabled } from './local-mode';
import { expect } from 'e2e';
import { syntheticBoardId, syntheticRows } from './synthetic-store';

// only an explicitly prepared, test-owned shortcut may run on the opted-in simulator.
test('composed Shortcuts daily action persists in the shared database', {
  tags: ['acceptance', 'shortcuts'], timeout: 240_000,
  skip: !localSyntheticEnabled || !process.env.E2E_SYNTHETIC_SHORTCUT || !process.env.E2E_SHORTCUT_BOARD,
}, async ({ app, screen, device, agent }) => {
  const title = process.env.E2E_SHORTCUT_BOARD!;
  const shortcut = process.env.E2E_SYNTHETIC_SHORTCUT!;
  if (!title.startsWith('QA ') || !shortcut.startsWith('QA ')) throw new Error('native acceptance requires test-owned QA entities');
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  const id = syntheticBoardId(title);
  const before = syntheticRows(`select id from check_ins where board_id='${id}' and deleted_at is null`);
  await device.openApp('com.apple.shortcuts');
  await agent.act('Run the prepared synthetic shortcut {{shortcut}} once. It checks the test-owned daily habit; do not edit or run other shortcuts.', {
    params: { shortcut },
  });
  await expect.poll(() => syntheticRows(`select id from check_ins where board_id='${id}' and deleted_at is null`).length).toBe(before.length + 1);
  await app.open();
  await screen.getByRole('button', { name: title, exact: true }).tap();
  await expect(screen.getByTestId('board-heatmap')).toBeVisible();
});
