import { test } from '@e2e-dev/mobile';
import { localSyntheticEnabled } from './local-mode';
import { reveal } from './reveal';
import { expect } from 'e2e';
import { syntheticBoardId, syntheticRows } from './synthetic-store';

function storedCounts() {
  return syntheticRows('select (select count(*) from boards) boards, (select count(*) from check_ins) checks, (select count(*) from coin_ledger) ledger');
}

test('export opens a real share sheet and cancellation preserves stored records', { skip: !localSyntheticEnabled, tags: ['deterministic', 'backup'], timeout: 180_000 }, async ({ app, screen, device }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByTestId('open-settings')).toBeVisible();
  const before = storedCounts();
  await screen.getByTestId('open-settings').tap();
  await reveal(device, screen, screen.getByTestId('settings-export'));
  await screen.getByTestId('settings-export').tap();
  await screen.getByTestId('export-start').tap();
  await expect(screen.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Close', exact: true }).tap();
  await expect(screen.getByTestId('export-shared')).toBeVisible();
  await app.restart();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
  expect(storedCounts()).toEqual(before);
});

// provider fixtures are selected through the real Files picker; no product services are mocked.
for (const [source, variable, expectedBoardVariable, outcome] of [
  ['own', 'E2E_JSON_IMPORT_FILE', 'E2E_JSON_IMPORT_BOARD', 'import-done'],
  ['ripples', 'E2E_CSV_IMPORT_FILE', 'E2E_CSV_IMPORT_BOARD', 'import-done'],
  ['own', 'E2E_INVALID_IMPORT_FILE', '', 'import-error'],
] as const) {
  test(`Files picker ${variable} imports or rejects the selected fixture`, {
    tags: ['acceptance', 'backup'], skip: !localSyntheticEnabled || !process.env[variable] || (outcome === 'import-done' && !process.env[expectedBoardVariable]), timeout: 240_000,
  }, async ({ app, screen, device, agent }) => {
    await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible({ timeout: 60_000 });
    await screen.getByTestId('open-settings').tap();
    await reveal(device, screen, screen.getByTestId('settings-import'));
    await screen.getByTestId('settings-import').tap();
    const before = storedCounts();
    await screen.getByTestId(`import-${source}`).tap();
    await agent.act('Select the synthetic import fixture named {{filename}} in the Files picker.', {
      params: { filename: process.env[variable]! },
    });
    if (outcome === 'import-done') {
      await expect(screen.getByTestId('import-preview')).toBeVisible();
      await screen.getByTestId('import-confirm').tap();
      await expect(screen.getByTestId(outcome)).toBeVisible();
      await expect(screen.getByTestId('import-summary')).toContainText('Added');
      expect(syntheticBoardId(process.env[expectedBoardVariable]!)).toBeTruthy();
      const imported = storedCounts();
      await screen.getByTestId('import-again').tap();
      await screen.getByTestId(`import-${source}`).tap();
      await agent.act('Select the same synthetic import fixture named {{filename}} in the Files picker.', {
        params: { filename: process.env[variable]! },
      });
      await screen.getByTestId('import-confirm').tap();
      await expect(screen.getByTestId('import-done')).toBeVisible();
      expect(storedCounts()).toEqual(imported);
    } else {
      await expect(screen.getByTestId(outcome)).toBeVisible();
      expect(storedCounts()).toEqual(before);
    }
    await app.restart();
    await expect(screen.getByTestId('create-board')).toBeVisible();
  });
}
