import { act, cleanupAsync, within } from '@testing-library/react-native';
import { getMockContext } from 'expo-router/testing-library';
import { router, type Href } from 'expo-router';
import { Alert, BackHandler } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import * as commands from '@/core/domain/commands';
import { ok } from '@/core/domain/result';
import * as product from '@/testing/product-core.mock';
import * as transfer from '@/platform/data-transfer';
import { missAlertScheduler, reminderScheduler, notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/sample-core', () => ({ openSampleCore: jest.fn() }));
const sampleFactory = jest.requireMock<{ openSampleCore: jest.Mock }>('@/platform/database/sample-core').openSampleCore;
// preload the actual full route tree outside interaction-test deadlines.
const routes = getMockContext('src/app');
for (const key of routes.keys()) routes(key);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function seed(h: TestHarness, title: string) {
  const created = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title, kind: 'count',
    symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!created.ok) throw Error(created.error.message);
  return created.value.boardId;
}
async function snapshot(h: TestHarness) {
  const tables = await h.db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return Promise.all(tables.map(async ({ name }) => [name, (await h.db.getAllAsync(`SELECT * FROM "${name}"`)).map(row => JSON.stringify(row)).sort()]));
}

let real: TestHarness, sample: TestHarness, sampleBoardId: string, disposed: boolean;
let disposeSample: () => Promise<void>;
beforeEach(async () => {
  jest.restoreAllMocks(); notificationsPlatformMock.reset(); sampleFactory.mockReset();
  real = await createTestHarness(); sample = await createTestHarness(); disposed = false;
  await seed(real, 'Real count'); sampleBoardId = await seed(sample, 'Sample count');
  jest.spyOn(product, 'getProductCore').mockResolvedValue(ok(real.deps));
  sampleFactory.mockResolvedValue(ok(sample.deps));
  const close = sample.db.closeAsync.bind(sample.db);
  disposeSample = async () => { await close(); disposed = true; };
  jest.spyOn(sample.db, 'closeAsync').mockImplementation(disposeSample);
});
afterEach(async () => { await cleanupAsync(); await settle(); if (!disposed) await sample.db.closeAsync(); await real.db.closeAsync(); });

it('opens the actual cold sample tree without opening real storage or running export cleanup', async () => {
  const clean = jest.spyOn(transfer, 'cleanupStaleExports');
  renderRouter('src/app', { initialUrl: '/sample' }); await settle();
  expect(await screen.findByText('Sample count')).toBeOnTheScreen();
  expect(screen.getByTestId('sample-chrome')).toBeOnTheScreen();
  expect(product.getProductCore).not.toHaveBeenCalled();
  expect(clean).not.toHaveBeenCalled();
  expect(sampleFactory).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  expect(disposed).toBe(true);
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
  expect(screen).toHavePathname('/');
  expect(await screen.findByText('Real count')).toBeOnTheScreen();
});

it('keeps the actual real draft mounted while sample edits stay in memory and Close discards a dirty sample form', async () => {
  const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  renderRouter('src/app', { initialUrl: '/boards/new' });
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Retained real draft');
  act(() => router.push('/sample')); await settle();
  expect(await screen.findByText('Sample count')).toBeOnTheScreen();
  const before = await snapshot(real);
  fireEvent.press(screen.getByTestId('create-board')); await settle();
  expect(screen).toHavePathname('/sample/boards/new');
  fireEvent.changeText(await within(screen.getByTestId('sample-host')).findByTestId('board-title-input'), 'Created in sample');
  fireEvent.press(within(screen.getByTestId('sample-host')).getByTestId('board-form-save')); await settle();
  expect(await screen.findByText('Created in sample')).toBeOnTheScreen();
  expect(await sample.db.getFirstAsync('SELECT COUNT(*) AS n FROM boards')).toEqual({ n: 2 });
  expect(await snapshot(real)).toEqual(before);
  fireEvent.press(screen.getByTestId('create-board')); await settle();
  fireEvent.changeText(await within(screen.getByTestId('sample-host')).findByTestId('board-title-input'), 'Discard this sample draft');
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  expect(disposed).toBe(true);
  expect(alerts).not.toHaveBeenCalled();
  expect(screen).toHavePathname('/boards/new');
  expect(screen.getByTestId('board-title-input').props.value).toBe('Retained real draft');
  expect(await real.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Real count' }]);
});

it('closes an actual opening route without mounting its late memory result', async () => {
  const held = gate();
  sampleFactory.mockImplementation(async () => { await held.promise; return ok(sample.deps); });
  renderRouter('src/app', { initialUrl: '/sample' }); await settle();
  expect(screen.getByText('Preparing three years of sample data...')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  expect(screen.getByText('Closing sample...')).toBeOnTheScreen();
  expect(product.getProductCore).not.toHaveBeenCalled();
  await act(async () => { held.resolve(); }); await settle();
  expect(disposed).toBe(true);
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Sample count')).toBeNull();
  expect(screen).toHavePathname('/');
});

const unavailable = [
  ['settings/import', 'Import is disabled in sample mode.'],
  ['settings/export', 'Export is disabled in sample mode.'],
  ['settings/sync', 'Account sync is disabled in sample mode.'],
  ['settings/icons', 'App icons are disabled in sample mode.'],
  ['settings/notifications', 'Notifications are disabled in sample mode.'],
  ['boards/:board/reminders/new', 'Reminders are unavailable in Sample mode.'],
  ['boards/:board/reminders/00000000-0000-4000-8000-000000000001', 'Reminders are unavailable in Sample mode.'],
  ['boards/:board/quick-action', 'Widget actions are disabled in sample mode.'],
  ['boards/:board/check-ins/new?source=widget', 'Widget actions are disabled in sample mode.'],
] as const;
it.each(unavailable)('keeps direct /sample/%s disabled without granting native or real-store authority', async (path, message) => {
  const permission = jest.spyOn(reminderScheduler, 'authorization');
  const missed = jest.spyOn(missAlertScheduler, 'pendingRequests');
  const pick = jest.spyOn(transfer, 'pickImportFile');
  const share = jest.spyOn(transfer, 'saveAndShareExport');
  const before = await snapshot(sample);
  renderRouter('src/app', { initialUrl: `/sample/${path.replace(':board', sampleBoardId)}` }); await settle();
  expect(screen.getByText(message)).toBeOnTheScreen();
  expect(screen.getByTestId('sample-chrome')).toBeOnTheScreen();
  expect(product.getProductCore).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled(); expect(missed).not.toHaveBeenCalled();
  expect(pick).not.toHaveBeenCalled(); expect(share).not.toHaveBeenCalled();
  expect(await snapshot(sample)).toEqual(before);
});

it('recovers a malformed sample identity to sample Home without a real opener', async () => {
  renderRouter('src/app', { initialUrl: '/sample/boards/not-an-id' }); await settle();
  expect(screen.getByText('This board link is not valid.')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('recovery-home')); await settle();
  expect(screen).toHavePathname('/sample');
  expect(screen.getByText('Sample count')).toBeOnTheScreen();
  expect(sampleFactory).toHaveBeenCalledTimes(1);
  expect(product.getProductCore).not.toHaveBeenCalled();
});

it('recovers an unknown cold sample path inside sample mode without opening real storage', async () => {
  renderRouter('src/app', { initialUrl: '/sample/unknown/deep/path' }); await settle();
  expect(screen.getByText('This screen does not exist.')).toBeOnTheScreen();
  expect(product.getProductCore).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Go to the sample screen')); await settle();
  expect(screen).toHavePathname('/sample');
  expect(screen.getByText('Sample count')).toBeOnTheScreen();
  expect(product.getProductCore).not.toHaveBeenCalled();
});

it('recovers a warm unknown sample path without another presentation and closes to its real predecessor', async () => {
  renderRouter('src/app', { initialUrl: '/settings' }); await settle();
  fireEvent.press(screen.getByTestId('settings-sample')); await settle();
  expect(screen.getByText('Sample count')).toBeOnTheScreen();
  const realBefore = await snapshot(real);
  act(() => router.push('/sample/unknown/deep/path' as Href)); await settle();
  expect(screen.getByText('This screen does not exist.')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Go to the sample screen')); await settle();
  expect(screen).toHavePathname('/sample');
  expect(screen.getAllByTestId('sample-host')).toHaveLength(1);
  expect(screen.getByText('Sample count')).toBeOnTheScreen();
  expect(sampleFactory).toHaveBeenCalledTimes(1);
  expect(sample.db.closeAsync).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  expect(disposed).toBe(true);
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
  expect(screen).toHavePathname('/settings');
  expect(await snapshot(real)).toEqual(realBefore);
});

it('closes the warm sample root on native navigator Back and returns to its exact predecessor', async () => {
  renderRouter('src/app', { initialUrl: '/settings' }); await settle();
  act(() => router.push('/sample' as Href)); await settle();
  expect(screen.getByText('Sample count')).toBeOnTheScreen();
  act(() => router.back()); await settle();
  expect(disposed).toBe(true);
  expect(screen).toHavePathname('/settings');
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
});

it('joins and disposes sample before an external replacement can initialize a real runtime', async () => {
  const held = gate();
  jest.spyOn(sample.db, 'closeAsync').mockImplementation(async () => { await held.promise; await disposeSample(); });
  renderRouter('src/app', { initialUrl: '/sample' }); await settle();
  act(() => router.replace('/settings')); await settle();
  expect(product.getProductCore).not.toHaveBeenCalled();
  expect(screen.getByText('Closing sample...')).toBeOnTheScreen();
  await act(async () => { held.resolve(); }); await settle();
  expect(disposed).toBe(true);
  expect(screen).toHavePathname('/settings');
  expect(product.getProductCore).toHaveBeenCalledTimes(1);
});

it('handles hardware Back at the cold sample root by closing before returning to real Home', async () => {
  const listeners: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  const add = BackHandler.addEventListener.bind(BackHandler);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
    listeners.push(handler); return add(event, handler);
  });
  renderRouter('src/app', { initialUrl: '/sample' }); await settle();
  let handled = false;
  act(() => { for (const callback of [...listeners].reverse()) {
    if (callback({ type: 'hardwareBackPress', timeStamp: 0 })) { handled = true; break; }
  } });
  await settle();
  expect(handled).toBe(true);
  expect(disposed).toBe(true);
  expect(screen).toHavePathname('/');
});

it('joins an accepted actual sample create before disposing its dirty route and never replays it', async () => {
  const entered = gate(), response = gate();
  const actual = commands.createBoard;
  const create = jest.spyOn(commands, 'createBoard').mockImplementation(async (...args) => {
    const result = await actual(...args); entered.resolve(); await response.promise; return result;
  });
  const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  renderRouter('src/app', { initialUrl: '/sample/boards/new' });
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Accepted before Close');
  fireEvent.press(screen.getByTestId('board-form-save')); await entered.promise;
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  expect(screen.getByText('Closing sample...')).toBeOnTheScreen();
  expect(sample.db.closeAsync).not.toHaveBeenCalled();
  expect(product.getProductCore).not.toHaveBeenCalled();
  expect(await sample.db.getAllAsync('SELECT title FROM boards ORDER BY title')).toEqual([
    { title: 'Accepted before Close' }, { title: 'Sample count' },
  ]);
  await act(async () => { response.resolve(); }); await settle();
  expect(create).toHaveBeenCalledTimes(1);
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
  expect(alerts).not.toHaveBeenCalled();
  expect(screen).toHavePathname('/');
  expect(await real.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Real count' }]);
});

it('keeps cold nested history, native create, saved record and native Close on one sample connection', async () => {
  const realBefore = await snapshot(real);
  renderRouter('src/app', { initialUrl: `/sample/boards/${sampleBoardId}/check-ins` }); await settle();
  expect(screen.getByTestId('history-empty')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('add-check-in')); await settle();
  expect(screen).toHavePathname(`/sample/boards/${sampleBoardId}/check-ins/new`);
  fireEvent.changeText(await screen.findByTestId('check-in-note'), 'Kept in memory');
  fireEvent.press(screen.getByTestId('check-in-save')); await settle();
  expect(await sample.db.getAllAsync('SELECT note FROM check_ins')).toEqual([{ note: 'Kept in memory' }]);
  expect(screen).toHavePathname(`/sample/boards/${sampleBoardId}/check-ins`);
  expect(await snapshot(real)).toEqual(realBefore);
  fireEvent.press(screen.getByTestId('add-check-in')); await settle();
  const sheet = within(screen.getByTestId('bottom-sheet'));
  expect(sheet.getByText('Sample data. Nothing here is saved.')).toBeOnTheScreen();
  fireEvent.press(sheet.getByTestId('sample-close')); await settle();
  expect(disposed).toBe(true);
  expect(sampleFactory).toHaveBeenCalledTimes(1);
  expect(screen).toHavePathname('/');
});

it('retains the existing development seeder under the real provider without a sample alias', async () => {
  renderRouter('src/app', { initialUrl: '/reference-august-2026' }); await settle();
  expect(screen.getByTestId('reference-seed-action')).toBeOnTheScreen();
  expect(product.getProductCore).toHaveBeenCalledTimes(1);
  expect(sampleFactory).not.toHaveBeenCalled();
});

it('does not change a closing cold nested route when hardware Back arrives before disposal finishes', async () => {
  const listeners: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  const add = BackHandler.addEventListener.bind(BackHandler);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
    listeners.push(handler); return add(event, handler);
  });
  const held = gate();
  jest.spyOn(sample.db, 'closeAsync').mockImplementation(async () => { await held.promise; await disposeSample(); });
  const initialUrl = `/sample/boards/${sampleBoardId}`;
  const rendered = renderRouter('src/app', { initialUrl }); await settle();
  fireEvent.press(screen.getByTestId('sample-close')); await settle();
  const closingPath = rendered.getPathname();
  try {
    let handled = false;
    act(() => { for (const callback of [...listeners].reverse()) {
      if (callback({ type: 'hardwareBackPress', timeStamp: 0 })) { handled = true; break; }
    } }); await settle();
    expect(handled).toBe(true);
    expect(screen).toHavePathname(closingPath);
    expect(product.getProductCore).not.toHaveBeenCalled();
  } finally { await act(async () => { held.resolve(); }); await settle(); }
  expect(screen).toHavePathname('/');
  expect(sample.db.closeAsync).toHaveBeenCalledTimes(1);
});

it('opens a fresh memory connection from the real Settings entry after every Close', async () => {
  const second = await createTestHarness();
  await seed(second, 'Fresh second sample');
  const secondClose = jest.spyOn(second.db, 'closeAsync');
  sampleFactory.mockResolvedValueOnce(ok(sample.deps)).mockResolvedValueOnce(ok(second.deps));
  try {
    renderRouter('src/app', { initialUrl: '/settings' }); await settle();
    fireEvent.press(screen.getByTestId('settings-sample')); await settle();
    expect(screen).toHavePathname('/sample');
    expect(screen.getByText('Sample count')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('sample-close')); await settle();
    expect(screen).toHavePathname('/settings');
    fireEvent.press(screen.getByTestId('settings-sample')); await settle();
    expect(screen.getByText('Fresh second sample')).toBeOnTheScreen();
    expect(screen.queryByText('Sample count')).toBeNull();
    expect(sampleFactory).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByTestId('sample-close')); await settle();
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname('/settings');
  } finally { await cleanupAsync(); await settle(); if (secondClose.mock.calls.length === 0) await second.db.closeAsync(); }
});
