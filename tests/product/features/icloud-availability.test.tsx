import { act } from '@testing-library/react-native';
import { Dimensions } from 'react-native';

import { createBoard, setICloudSyncEnabled } from '@/core/domain/commands';
import { toSchema2SyncRecord } from '@/core/sync/schema-2-records';
import * as sync from '@/platform/sync';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { renderRouter, screen, settle } from '../../../src/testing/render';
import { legacySyncContext } from '../../../src/testing/legacy-sync-router';

jest.mock('@/platform/sync', () => ({
  ...jest.requireActual('@/platform/sync'),
  cloudKitAvailable: jest.fn(async () => false),
}));

const initialWindow = Dimensions.get('window');
const initialScreen = Dimensions.get('screen');

describe('runtime icloud availability', () => {
  beforeEach(() => {
    resetProductCoreForTests();
    jest.mocked(sync.cloudKitAvailable).mockReset();
  });

  afterEach(() => {
    act(() => Dimensions.set({ window: initialWindow, screen: initialScreen }));
    jest.restoreAllMocks();
  });

  it('hides the unavailable message when the native account check succeeds', async () => {
    jest.mocked(sync.cloudKitAvailable).mockResolvedValue(true);
    renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
    await settle();
    expect(sync.cloudKitAvailable).toHaveBeenCalled();
    expect(screen.queryByTestId('icloud-unavailable')).toBeNull();
  });

  it.each([false, 'reject'])('explains unavailable icloud without exposing account details (%s)', async (outcome) => {
    if (outcome === 'reject') {
      jest.mocked(sync.cloudKitAvailable).mockRejectedValue(new Error('private account details'));
    } else {
      jest.mocked(sync.cloudKitAvailable).mockResolvedValue(false);
    }
    renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
    await settle();
    expect(screen.getByTestId('icloud-unavailable')).toHaveTextContent(/changes stay queued/);
    expect(screen.queryByText(/private account details/)).toBeNull();
  });

  it.each([true, false])('separates a received dependency deferral from native availability (%s)', async available => {
    jest.mocked(sync.cloudKitAvailable).mockResolvedValue(available);
    const opened = await getProductCore();
    if (!opened.ok) throw new Error('core failed');
    const core = opened.value;
    const created = await createBoard(core, { commandId: newCommandId(), title: 'retained board',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!created.ok) throw new Error('board creation failed');
    expect(await setICloudSyncEnabled(core, { commandId: newCommandId(), enabled: true })).toMatchObject({ ok: true });
    const board = await core.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM boards WHERE id = ?', [created.value.boardId]);
    if (!board) throw new Error('created board missing');
    const record = { ...toSchema2SyncRecord('board', created.value.boardId, '01900000000000-00001-remote', {
      ...board, anchor_kind: 'board', anchor_relation: 'after',
      anchor_board_id: '00000000-0000-4000-8000-000000000999', anchor_preset: null, anchor_text: null,
    }), entityType: 'board' as const };
    jest.spyOn(sync.cloudKitTransport, 'ensureZone').mockResolvedValue();
    jest.spyOn(sync.cloudKitTransport, 'upload').mockResolvedValue();
    jest.spyOn(sync.cloudKitTransport, 'fetchChanges').mockResolvedValue({ records: [record], nextToken: 'deferred', more: false });
    const rendered = renderRouter(legacySyncContext, { initialUrl: '/settings/sync' });
    try {
      await settle();
      await settle();
      expect(screen.getByRole('text', { name: 'Status' })).toHaveAccessibilityValue({ text: 'Needs Attention' });
      expect(screen.getByRole('button', { name: 'Sync Now' })).not.toBeDisabled();
      const lastSync = screen.getByRole('text', { name: 'Last sync' }).props.accessibilityValue.text;
      expect(lastSync).not.toBe('Never');
      for (const fontScale of [1, 2.8, 1]) {
        act(() => Dimensions.set({ window: { ...initialWindow, width: 393, fontScale }, screen: initialScreen }));
        for (const [title, value] of [['Status', 'Needs Attention'], ['Last sync', lastSync]]) {
          expect(screen.getAllByRole('text', { name: title })).toHaveLength(1);
          expect(screen.getByRole('text', { name: title })).toHaveAccessibilityValue({ text: value });
          expect(screen.getByText(value)).toBeOnTheScreen();
          expect(screen.queryByRole('button', { name: title })).toBeNull();
        }
      }
      const deferred = await core.db.getAllAsync<{ payload: string }>('SELECT payload FROM sync_deferred');
      expect(deferred.map(row => JSON.parse(row.payload))).toEqual([record]);
      expect(await core.db.getFirstAsync('SELECT * FROM boards WHERE id = ?', [created.value.boardId])).toEqual(board);
      expect(await core.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
      expect(await core.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
      if (available) expect(screen.queryByTestId('icloud-unavailable')).toBeNull();
      else expect(screen.getByTestId('icloud-unavailable')).toHaveTextContent(/iCloud is unavailable on this device right now/);
      expect(screen.queryByTestId('icloud-error')).toBeNull();
    } finally {
      rendered.unmount();
    }
  });
});
