import { getSyncSummary } from '@/core/domain/queries';
import { prepareRemoteFact, type PreparedRemoteFact } from '@/core/domain/remote-fact-validation';
import { applyRemoteFactInboxChanges, type RemoteFactInboxDisposition } from '@/core/persistence/repositories/remote-fact-inbox';

import { getProductCore, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

describe('local incoming data summary', () => {
  beforeEach(() => resetProductCoreForTests());

  it('shows empty incoming counts separately from uploads while icloud is off', async () => {
    renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
    await settle();
    for (const name of ['Waiting to upload', 'Waiting for related data', 'At processing limit', 'Conflicting or invalid data']) {
      expect(screen.getByRole('text', { name })).toHaveAccessibilityValue({ text: '0' });
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('text', { name: 'Status' })).toHaveAccessibilityValue({ text: 'Off' });
  });

  it('recovers processable local states while keeping quarantined diagnostics private and separate from uploads', async () => {
    const opened = await getProductCore();
    if (!opened.ok) throw new Error('core failed');
    const core = opened.value;
    const upserts: { prepared: PreparedRemoteFact; disposition: RemoteFactInboxDisposition }[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const factId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const value = {
        id: factId, commandId: '00000000-0000-4000-8000-000000000010',
        boardId: '00000000-0000-4000-8000-000000000011', logicalDate: '2026-09-08',
        checkInId: '00000000-0000-4000-8000-000000000012', kind: 'check',
        createdAt: index, mutationStamp: `0000000000000${index}-00000-remote`, policyJson: null,
      };
      const prepared = await prepareRemoteFact({ factType: 'habit_action', factId,
        value: index > 3 ? { ...value, privateDiagnostic: 'never display this private payload' } : value,
        enqueueOnAdmission: false }, core.hashing);
      const disposition = index === 1 ? { state: 'pending', reason: 'dependency' } as const
        : index <= 3 ? { state: 'blocked_capacity', reason: 'scope_capacity' } as const
          : { state: 'quarantined', reason: 'invalid' } as const;
      upserts.push({ prepared, disposition });
    }
    await core.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx,
      { upserts, removals: [] }, core.clock.nowUtcMs()));
    const before = await core.db.getAllAsync('SELECT * FROM remote_fact_inbox ORDER BY fact_id');
    const summary = await getSyncSummary(core);
    expect(summary).toMatchObject({ ok: true, value: { enabled: false, pendingChanges: 0,
      incoming: { pending: 1, blocked: 2, quarantined: 3 }, lastSuccessAtUtc: null } });

    renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
    await settle();
    for (const [name, count] of [['Waiting to upload', '0'], ['Waiting for related data', '0'],
      ['At processing limit', '0'], ['Conflicting or invalid data', '3']]) {
      expect(screen.getByRole('text', { name })).toHaveAccessibilityValue({ text: count });
    }
    expect(JSON.stringify(screen.toJSON())).not.toContain('never display this private payload');
    expect(await core.db.getAllAsync('SELECT * FROM remote_fact_inbox ORDER BY fact_id'))
      .toEqual(before.filter(row => (row as { state: string }).state === 'quarantined'));
    expect(await core.db.getAllAsync('SELECT * FROM habit_actions')).toHaveLength(3);
    expect(await core.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('reports unavailable counts safely and retries a failed database read', async () => {
    const opened = await getProductCore();
    if (!opened.ok) throw new Error('core failed');
    const db = opened.value.db;
    const read = db.getFirstAsync.bind(db);
    const failure = jest.spyOn(db, 'getFirstAsync').mockImplementation((sql, params) => {
      if (sql.includes('FROM remote_fact_inbox')) throw new Error('private database diagnostic');
      return read(sql, params);
    });
    try {
      renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
      await settle();
      expect(screen.getByTestId('icloud-summary-error')).toHaveTextContent('Sync information could not be loaded.');
      expect(screen.getByTestId('icloud-toggle')).toBeDisabled();
      for (const name of ['Status', 'Waiting to upload', 'Last sync', 'Waiting for related data',
        'At processing limit', 'Conflicting or invalid data']) {
        expect(screen.getByRole('text', { name })).toHaveAccessibilityValue({ text: 'Unavailable' });
      }
      expect(JSON.stringify(screen.toJSON())).not.toContain('private database diagnostic');
    } finally { failure.mockRestore(); }

    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.queryByTestId('icloud-summary-error')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByTestId('icloud-toggle')).not.toBeDisabled();
    expect(screen.getByRole('text', { name: 'Status' })).toHaveAccessibilityValue({ text: 'Off' });
    expect(screen.getByRole('text', { name: 'Waiting for related data' })).toHaveAccessibilityValue({ text: '0' });
  });
});
import { legacySyncContext } from '../../../src/testing/legacy-sync-router';
