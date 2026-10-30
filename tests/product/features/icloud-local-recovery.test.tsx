import { act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { prepareRemoteFacts } from '@/core/domain/remote-fact-validation';
import { applyRemoteFactInboxChanges } from '@/core/persistence/repositories/remote-fact-inbox';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { cloudKitTransport } from '@/platform/sync';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

it('keeps foreground local recovery working after turning iCloud off in Settings', async () => {
  resetProductCoreForTests();
  const handlers = new Set<(state: AppStateStatus) => void>();
  const subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.add(handler);
    return { remove: () => { handlers.delete(handler); } };
  });
  const opened = await getProductCore();
  if (!opened.ok) throw new Error('core failed');
  const core = opened.value;
  await setICloudSyncEnabled(core, { commandId: newCommandId(), enabled: true });
  const rendered = renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
  try {
    await settle();
    fireEvent(screen.getByTestId('icloud-toggle'), 'valueChange', false);
    await settle();
    expect(screen.getByRole('text', { name: 'Status' })).toHaveAccessibilityValue({ text: 'Off' });
    const ensure = jest.spyOn(cloudKitTransport, 'ensureZone');
    const upload = jest.spyOn(cloudKitTransport, 'upload');
    const fetch = jest.spyOn(cloudKitTransport, 'fetchChanges');
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    const [prepared] = await prepareRemoteFacts([{ factType: 'habit_action', factId: source.id,
      value: source, enqueueOnAdmission: false }], core.hashing);
    await core.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts: [{ prepared, disposition: { state: 'pending', reason: 'dependency' } }], removals: [] }, 100));
    expect(await getLedgerEntry(core.db, award.id)).toBeNull();
    await act(async () => { for (const handler of handlers) handler('active'); });
    await settle();
    await settle();
    expect(await getLedgerEntry(core.db, award.id)).toEqual(award);
    expect(screen.getByRole('text', { name: 'Status' })).toHaveAccessibilityValue({ text: 'Off' });
    expect(screen.getByRole('text', { name: 'Waiting for related data' })).toHaveAccessibilityValue({ text: '0' });
    expect(ensure).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rendered.unmount();
    subscription.mockRestore();
    jest.restoreAllMocks();
  }
});
import { legacySyncContext } from '../../../src/testing/legacy-sync-router';
