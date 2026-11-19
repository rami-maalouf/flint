import { createBoard, createCheckIn } from '@/core/domain/commands';
import type { LogicalDate } from '@/core/domain/ids';
import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function seed(kind: 'daily' | 'count', dates: string[], metricsEnabled = true) {
  const core = await getProductCore();
  if (!core.ok) throw new Error(core.error.message);
  const board = await createBoard(core.value, {
    commandId: newCommandId(), kind, title: 'Read a little every day', symbol: 'book.fill',
    accentHex: '#8E8E93', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled,
  });
  if (!board.ok) throw new Error(board.error.message);
  for (const date of dates) {
    const check = await createCheckIn(core.value, {
      commandId: newCommandId(), boardId: board.value.boardId, source: 'app', logicalDate: date as LogicalDate,
    });
    expect(check.ok).toBe(true);
  }
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

beforeEach(resetProductCoreForTests);

it.each(['daily', 'count'] as const)('shows a %s streak in every layout, extends it on check-in, and restores it on undo', async kind => {
  await seed(kind, ['2026-08-28', '2026-08-29']);
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('board-card-0');
  expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent('2');
  expect(screen.getByRole('button', { name: 'Read a little every day' }).props.accessibilityHint).toContain('2-day streak');
  await press('board-card-0-quick');
  expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent('3');
  if (kind === 'count') {
    await press('board-card-0-quick');
    expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent('3');
    await press('undo-check-in');
    expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent('3');
  } else {
    await press('undo-check-in');
    expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent('2');
  }
  await press('open-board-layout');
  for (const layout of ['grid', 'cards', 'summary', 'compact']) {
    await press(`layout-${layout}`);
    expect(screen.getByTestId('board-card-0-half-streak')).toHaveTextContent(kind === 'daily' ? /^2$/ : /^3$/);
    expect(screen.getByTestId('board-card-0-streak')).toHaveTextContent(kind === 'daily' ? '2' : '3');
  }
});

it.each([
  ['no history', [], true],
  ['a first day', ['2026-08-30'], true],
  ['a missed day', ['2026-08-27', '2026-08-28'], true],
  ['disabled metrics', ['2026-08-28', '2026-08-29'], false],
] as const)('keeps the card quiet with %s', async (_state, dates, metricsEnabled) => {
  await seed('daily', [...dates], metricsEnabled);
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('board-card-0');
  expect(screen.queryByTestId('board-card-0-streak')).toBeNull();
  await press('open-board-layout');
  await press('layout-summary');
  expect(screen.queryByTestId('board-card-0-streak')).toBeNull();
});

it('shows an alternating half streak on Home after the regular streak ends', async () => {
  await seed('daily', ['2026-08-26', '2026-08-28']);
  renderRouter('src/app', { initialUrl: '/' });
  expect(await screen.findByTestId('board-card-0-half-streak')).toHaveTextContent(/^2$/);
  expect(screen.queryByTestId('board-card-0-streak')).toBeNull();
});
