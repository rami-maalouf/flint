import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';
import { authenticate, resetBackendMock, restoreAccount, revokeAccount } from '../../../src/testing/backend.mock';
import { resetProductCoreForTests } from '../../../src/testing/product-core.mock';

beforeEach(() => { resetProductCoreForTests(); resetBackendMock(); });

it('keeps local use available and connects an account through the existing sync queue', async () => {
  renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByTestId('backend-email');
  expect(screen.getByText(/Everything works offline/)).toBeOnTheScreen();
  fireEvent.changeText(screen.getByTestId('backend-email'), 'person@example.test');
  fireEvent.changeText(screen.getByTestId('backend-password'), 'strong-password');
  fireEvent.press(screen.getByTestId('backend-connect'));
  await settle();
  await screen.findByTestId('backend-connected');
  expect(authenticate).toHaveBeenCalledWith('login', 'person@example.test', 'strong-password');
  expect(screen.getByTestId('backend-pending')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('backend-sign-out'));
  await settle();
  expect(await screen.findByTestId('backend-email')).toBeOnTheScreen();
});

it('preserves the sign-in draft when a request fails', async () => {
  authenticate.mockRejectedValueOnce(new TypeError('offline'));
  renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByTestId('backend-email');
  fireEvent.changeText(screen.getByTestId('backend-email'), 'person@example.test');
  fireEvent.changeText(screen.getByTestId('backend-password'), 'strong-password');
  fireEvent.press(screen.getByTestId('backend-connect'));
  await settle();
  expect(await screen.findByTestId('backend-error')).toHaveTextContent(/server could not be reached/i);
  expect(screen.getByTestId('backend-email')).toHaveProp('value', 'person@example.test');
  expect(screen.getByTestId('backend-password')).toHaveProp('value', 'strong-password');
});

it('creates an account, pauses sync, and resumes through the same durable queue', async () => {
  renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByTestId('backend-email');
  fireEvent.press(screen.getByTestId('backend-mode'));
  expect(screen.getByText(/at least 8 characters/)).toBeOnTheScreen();
  fireEvent.changeText(screen.getByTestId('backend-email'), 'new@example.test');
  fireEvent.changeText(screen.getByTestId('backend-password'), 'new-strong-password');
  fireEvent.press(screen.getByTestId('backend-connect'));
  await screen.findByTestId('backend-connected');
  await settle();
  expect(authenticate).toHaveBeenCalledWith('signup', 'new@example.test', 'new-strong-password');
  fireEvent(screen.getByTestId('backend-toggle'), 'valueChange', false);
  await settle();
  expect(screen.getByTestId('backend-status')).toHaveAccessibilityValue({ text: 'Off' });
  expect(screen.queryByTestId('backend-sync-now')).toBeNull();
  fireEvent(screen.getByTestId('backend-toggle'), 'valueChange', true);
  await settle();
  expect(screen.getByTestId('backend-sync-now')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('backend-sync-now'));
  await settle();
  expect(screen.getByRole('text', { name: 'Waiting for related data' })).toHaveAccessibilityValue({ text: '0' });
});

it('recovers when saved sign-in storage is temporarily unavailable', async () => {
  restoreAccount.mockRejectedValueOnce(new Error('private keychain detail'));
  renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByText(/saved sign-in could not be opened/);
  expect(screen.queryByText(/private keychain detail/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Try Again' }));
  expect(await screen.findByTestId('backend-email')).toBeOnTheScreen();
});

it('signs out locally when server revocation is unavailable and explains recovery', async () => {
  renderRouter('src/app', { initialUrl: '/settings/sync' });
  await screen.findByTestId('backend-email');
  fireEvent.changeText(screen.getByTestId('backend-email'), 'person@example.test');
  fireEvent.changeText(screen.getByTestId('backend-password'), 'strong-password');
  fireEvent.press(screen.getByTestId('backend-connect'));
  await screen.findByTestId('backend-connected');
  await settle();
  revokeAccount.mockRejectedValueOnce(new TypeError('private network detail'));
  fireEvent.press(screen.getByTestId('backend-sign-out'));
  await screen.findByTestId('backend-email');
  expect(await screen.findByTestId('backend-error')).toHaveTextContent(/signed out on this device/);
  expect(screen.queryByText(/private network detail/)).toBeNull();
});
