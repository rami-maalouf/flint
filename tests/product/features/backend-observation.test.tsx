import { act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { setICloudSyncEnabled } from '@/core/domain/commands';
import { backendSession, backendTransport, observeBackendChanges, resetBackendMock } from '@/testing/backend.mock';
import { getProductCore, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

const initialAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;
afterEach(() => {
  Object.defineProperty(AppState, 'currentState', initialAppState);
  jest.restoreAllMocks();
});

it('keeps observation stable across sync refreshes and suspends it while backgrounded', async () => {
  resetProductCoreForTests(); resetBackendMock();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const listeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
  const opened = await getProductCore();
  if (!opened.ok) throw new Error('core unavailable');
  await setICloudSyncEnabled(opened.value, { commandId: newCommandId(), enabled: true });
  await backendSession.signIn('login', 'person@example.test', 'strong-password', async () => {});
  const stop = jest.fn();
  observeBackendChanges.mockResolvedValue(stop);
  const fetch = jest.spyOn(backendTransport, 'fetchChanges');
  const rendered = renderRouter('src/app', { initialUrl: '/settings/sync' });
  try {
    await screen.findByTestId('backend-connected'); await settle();
    expect(observeBackendChanges).toHaveBeenCalledTimes(1);
    const initialFetches = fetch.mock.calls.length;
    act(() => observeBackendChanges.mock.calls[0][0]()); await settle();
    expect(fetch.mock.calls.length).toBeGreaterThan(initialFetches);
    fireEvent.press(screen.getByTestId('backend-sync-now')); await settle();
    expect(observeBackendChanges).toHaveBeenCalledTimes(1);
    act(() => { for (const listener of listeners) listener('background'); }); await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => { for (const listener of listeners) listener('active'); }); await settle();
    expect(observeBackendChanges).toHaveBeenCalledTimes(2);
  } finally { rendered.unmount(); }
});

it('closes an observer that finishes opening after its provider unmounts', async () => {
  resetProductCoreForTests(); resetBackendMock();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const opened = await getProductCore();
  if (!opened.ok) throw new Error('core unavailable');
  await setICloudSyncEnabled(opened.value, { commandId: newCommandId(), enabled: true });
  await backendSession.signIn('login', 'person@example.test', 'strong-password', async () => {});
  let finish!: (stop: () => void) => void;
  observeBackendChanges.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const rendered = renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByTestId('backend-connected'); await settle();
  expect(observeBackendChanges).toHaveBeenCalledTimes(1);
  rendered.unmount();
  const stop = jest.fn();
  await act(async () => { finish(stop); await Promise.resolve(); });
  expect(stop).toHaveBeenCalledTimes(1);
});
