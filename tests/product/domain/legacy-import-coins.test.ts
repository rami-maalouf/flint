import { createBoard, createCheckIn, importSnapshot } from '@/core/domain/commands';
import { baselineAction } from '@/core/domain/habit-actions';
import type { CheckInId, LogicalDate } from '@/core/domain/ids';
import { parseOwnExport } from '@/core/export/import-parsers';
import { getExportSnapshot, serializeExport } from '@/core/export/serialize';
import { listBoardCheckIns } from '@/core/persistence/repositories/check-ins';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const date = '2026-08-30' as LogicalDate;
const importedId = '00000000-0000-4000-8000-0000000000ff' as CheckInId;

describe('explicit legacy import economic compatibility', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  async function fixture() {
    const made = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title: 'legacy mixed daily',
      kind: 'daily', earnsCoins: true, coinCapPerDay: 10, symbol: 'star.fill', accentHex: '#78D98B',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!made.ok) throw new Error(made.error.message);
    const boardId = made.value.boardId;
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app' })).toMatchObject({ ok: true });
    const exported = await getExportSnapshot(h.deps, { databaseSchemaVersion: 11, appVersion: 'test', buildVersion: 'test', locale: 'en-US' });
    if (!exported.ok) throw new Error(exported.error.message);
    const current = JSON.parse(serializeExport(exported.value));
    // project the genuine historical v1 allowlist without newer evidence or fields.
    const file = { format: 'habit-system.export', exportVersion: 1, boards: current.boards.map((row: Record<string, unknown>) =>
      Object.fromEntries(['id', 'title', 'symbol', 'accentHex', 'usesTintedBackground', 'tracksAmount', 'amountUnit',
        'quickAmount', 'tracksTime', 'startOfDayMinute', 'metricsEnabled', 'orderKey', 'createdAtUtc', 'archivedAtUtc', 'periods']
        .map(key => [key, row[key]]))), checkIns: current.checkIns, reminders: current.reminders,
      settings: { metricsEducationDismissed: current.settings.metricsEducationDismissed } };
    file.checkIns[0].id = importedId;
    const parsed = parseOwnExport(JSON.stringify(file));
    if (!parsed.ok) throw new Error(parsed.error.message);
    return { boardId, input: { commandId: h.ids.nextCommandId(), draft: parsed.value } };
  }
  async function snapshot() {
    const tables = ['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'command_receipts', 'mutation_outbox', 'app_settings', 'widget_board_rows'];
    return Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));
  }

  it('public export/parse/import preserves the source award and atomically corrects mixed Daily entitlement', async () => {
    const { boardId, input } = await fixture();
    const original = await h.db.getAllAsync<{ id: string; delta: number }>('SELECT * FROM coin_ledger ORDER BY id');
    expect(original).toHaveLength(1); expect(original[0].delta).toBe(1);
    const beforeActions = await h.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id');
    const result = await importSnapshot(h.deps, input);
    expect(result).toMatchObject({ ok: true, value: { boardsCreated: 0, checkInsCreated: 1 } });
    const ledger = await h.db.getAllAsync<{ id: string; kind: string; delta: number }>('SELECT * FROM coin_ledger ORDER BY id');
    expect(ledger.find(row => row.id === original[0].id)).toEqual(original[0]);
    expect(ledger.filter(row => row.id !== original[0].id)).toMatchObject([{ kind: 'adjustment', delta: -1 }]);
    expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
    const actions = await h.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id');
    expect(actions.filter(row => (row as { kind: string }).kind !== 'baseline')).toEqual(beforeActions);
    expect(await h.db.getFirstAsync('SELECT id, policy_json, created_at FROM habit_actions WHERE kind = ?', ['baseline']))
      .toEqual({ id: (await baselineAction({ id: importedId, boardId, logicalDate: date }, h.deps.hashing)).id, policy_json: null, created_at: 0 });
    expect(await listBoardCheckIns(h.db, boardId)).toHaveLength(2);
    const after = await snapshot();
    expect(await importSnapshot(h.deps, input)).toEqual(result);
    expect(await snapshot()).toEqual(after);
    expect(await importSnapshot(h.deps, { ...input, commandId: h.ids.nextCommandId() })).toMatchObject({ ok: true, value: { checkInsCreated: 0, checkInsSkipped: 1 } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(ledger);
  });

  it('rolls back imported payload, baseline, correction and visibility when settlement storage fails, then retries the same receipt', async () => {
    const { input } = await fixture(); const before = await snapshot();
    const run = h.db.runAsync.bind(h.db);
    const failure = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO coin_ledger')) throw new Error('injected correction failure');
      return run(sql, params);
    });
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot()).toEqual(before);
    failure.mockRestore();
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { checkInsCreated: 1 } });
    expect(await h.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 0 });
  });
});
