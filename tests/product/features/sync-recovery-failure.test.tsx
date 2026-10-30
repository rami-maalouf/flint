import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { prepareRemoteFacts } from '@/core/domain/remote-fact-validation';
import { applyRemoteFactInboxChanges } from '@/core/persistence/repositories/remote-fact-inbox';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { SyncTransportError } from '@/core/sync/transport';
import { cloudKitTransport } from '@/platform/sync';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';
import { legacySyncContext } from '../../../src/testing/legacy-sync-router';

it('refreshes committed incoming data in Settings when later sync retry storage fails', async () => {
  resetProductCoreForTests();
  const opened = await getProductCore();
  if (!opened.ok) throw new Error('core failed');
  const core = opened.value;
  expect(await setICloudSyncEnabled(core, { commandId: newCommandId(), enabled: true })).toMatchObject({ ok: true });
  const source = checkFixture.cases[0].actions[0] as HabitAction;
  const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
  const [prepared] = await prepareRemoteFacts([{ factType: 'habit_action', factId: source.id,
    value: source, enqueueOnAdmission: false }], core.hashing);
  await core.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx, {
    upserts: [{ prepared, disposition: { state: 'pending', reason: 'dependency' } }], removals: [],
  }, 100));
  const markers = await core.db.getAllAsync('SELECT * FROM sync_state');
  await core.db.execAsync(`CREATE TEMP TRIGGER reject_retry_metadata BEFORE INSERT ON sync_state
    WHEN NEW.retry_state IS NOT NULL BEGIN SELECT RAISE(ABORT, 'private retry metadata'); END;`);
  const ensure = jest.spyOn(cloudKitTransport, 'ensureZone')
    .mockRejectedValue(new SyncTransportError('offline', 'private network detail'));
  const rendered = renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
  try {
    await settle();
    await settle();
    expect(await getLedgerEntry(core.db, award.id)).toEqual(award);
    expect(await core.db.getAllAsync('SELECT * FROM remote_fact_inbox')).toEqual([]);
    expect(await core.db.getAllAsync('SELECT * FROM sync_state')).toEqual(markers);
    expect(screen.getByTestId('icloud-error')).toHaveTextContent('Sync could not finish. Try again.');
    expect(screen.queryByText(/private retry metadata|private network detail/)).toBeNull();
    expect(screen.getByRole('text', { name: 'Waiting for related data' })).toHaveAccessibilityValue({ text: '0' });
    expect(ensure).toHaveBeenCalledTimes(1);
    const accepted = await core.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id');
    const ledger = await core.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    fireEvent.press(screen.getByTestId('icloud-sync-now'));
    await settle();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('text', { name: 'Waiting for related data' })).toHaveAccessibilityValue({ text: '0' });
    expect(await core.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id')).toEqual(accepted);
    expect(await core.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(ledger);
    expect(await core.db.getAllAsync('SELECT * FROM sync_state')).toEqual(markers);
  } finally {
    rendered.unmount();
    await core.db.execAsync('DROP TRIGGER reject_retry_metadata');
    jest.restoreAllMocks();
  }
});
