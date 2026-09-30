import { createBoard, importSnapshot } from '@/core/domain/commands';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { CoinContractError } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { listBoardCheckIns } from '@/core/persistence/repositories/check-ins';
import type { LegacyImportDraft, OwnV2ImportDraft } from '@/core/export/import-parsers';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const id = (n: number) => `a0000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const board = (n: number, parent: number | null = null) => ({
  sourceId: id(n), title: `board ${n}`, symbol: 'star.fill', accentHex: '#78D98B',
  kind: 'daily' as const, anchorRelation: parent === null ? null : 'after' as const,
  anchorKind: parent === null ? null : 'board' as const, anchorBoardId: parent === null ? null : id(parent),
  anchorPreset: null, anchorText: null, usualTimeMinute: 0, requiredInStack: true,
  earnsCoins: true, coinCapPerDay: 3, usesTintedBackground: false,
  tracksAmount: false, amountUnit: null, quickAmount: 1, tracksTime: false,
  startOfDayMinute: 0, metricsEnabled: true, orderKey: 'a',
  createdAtUtc: 1900000000000.5, archivedAtUtc: null,
  periods: [{ startDate: '2030-01-03', endDate: '2030-01-01' }, { startDate: '2020-01-01', endDate: null }],
});
const settings = { metricsEducationDismissed: [id(1)], wakeMinute: 0, lunchMinute: 735, dinnerMinute: 1095, sleepMinute: 1425 };
const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const evidence = (habitActions: unknown[] = [], coinLedger: unknown[] = []) => ({ sourceJson: JSON.stringify({
  format: 'habit-system.export', exportVersion: 2, boards: [], checkIns: [], reminders: [], rewards: [], habitActions, coinLedger,
}) });
const reminder = (n: number, parent = 1) => ({ sourceId: id(n), sourceBoardId: id(parent),
  weekdaysMask: 127, minuteOfDay: 0, message: 'remember', enabled: true, createdAtUtc: 1900000000001.5 });
const reward = (n: number) => ({ sourceId: id(n), title: 'restored reward', costCoins: 5,
  symbol: 'star.fill', accentHex: '#78D98B', orderKey: 'a', createdAtUtc: 1900000000001, archivedAtUtc: 1900000000002 });
const check = (n: number, parent = 1) => ({ sourceId: id(n), sourceBoardId: id(parent), logicalDate: '2026-08-30',
  occurredAtUtc: null, timeZoneId: null, offsetMinutes: null, amount: null, note: null, source: 'app' as const, createdAtUtc: 1 });
function draft(patch: Partial<OwnV2ImportDraft> = {}): OwnV2ImportDraft {
  return { source: 'own', exportVersion: 2, boards: [], checkIns: [], reminders: [], rewards: [],
    settings: { kind: 'valid', value: settings }, skipped: { boards: 0, checkIns: 0, reminders: 0, rewards: 0 },
    evidence: { sourceJson: JSON.stringify({ format: 'habit-system.export', exportVersion: 2,
      boards: [], checkIns: [], reminders: [], rewards: [], habitActions: [], coinLedger: [] }) }, ...patch };
}
const tables = ['boards', 'board_activity_periods', 'check_ins', 'reminders', 'rewards', 'habit_actions', 'coin_ledger',
  'remote_fact_inbox', 'mutation_outbox', 'command_receipts', 'app_settings', 'widget_board_rows'];
async function snapshot(h: TestHarness) { return Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`))); }

describe('own format 2 public import transaction', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it('preserves forward anchors, exact periods and old hidden Daily payload without inferring earning evidence', async () => {
    const input = { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1, 2), { ...board(2), periods: [] }],
      checkIns: [{ sourceId: id(3), sourceBoardId: id(1), logicalDate: '2030-01-03', occurredAtUtc: 1900000000123.5,
        timeZoneId: 'Pacific/Auckland', offsetMinutes: 780.5, amount: 7, note: 'old amount and time', source: 'shortcut', createdAtUtc: 1900000000001.5 }],
    }) };
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { boardsCreated: 2, checkInsCreated: 1,
      v2: { settings: 'restored', immutable: { admitted: 0, generated: 0 } } } });
    expect(await h.db.getFirstAsync('SELECT kind, anchor_board_id, earns_coins, coin_cap_per_day, created_at FROM boards WHERE id = ?', [id(1)]))
      .toEqual({ kind: 'daily', anchor_board_id: id(2), earns_coins: 1, coin_cap_per_day: 3, created_at: 1900000000000.5 });
    expect(await h.db.getAllAsync('SELECT start_date, end_date FROM board_activity_periods WHERE board_id = ? ORDER BY id', [id(1)]))
      .toEqual([{ start_date: '2030-01-03', end_date: '2030-01-01' }, { start_date: '2020-01-01', end_date: null }]);
    expect(await h.db.getAllAsync('SELECT * FROM board_activity_periods WHERE board_id = ?', [id(2)])).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT logical_date, occurred_at_utc, offset_minutes, amount, source, created_at, state_suppressed FROM check_ins'))
      .toEqual({ logical_date: '2030-01-03', occurred_at_utc: 1900000000123.5, offset_minutes: 780.5, amount: 7,
        source: 'shortcut', created_at: 1900000000001.5, state_suppressed: 1 });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('rejects a cycle and its new dependents independent of input order while restoring unrelated rows', async () => {
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [board(3, 1), board(1, 2), board(2, 1), board(4)],
      checkIns: [{ sourceId: id(5), sourceBoardId: id(3), logicalDate: '2026-08-30', occurredAtUtc: null,
        timeZoneId: null, offsetMinutes: null, amount: null, note: null, source: 'app', createdAtUtc: 0 }],
    }) });
    expect(result).toMatchObject({ ok: true, value: { boardsCreated: 1, boardsSkipped: 3, checkInsSkipped: 1 } });
    expect(await h.db.getAllAsync('SELECT id FROM boards')).toEqual([{ id: id(4) }]);
  });

  it('restores fresh settings once and replays the receipt before inspecting poisoned replacement input', async () => {
    const commandId = h.ids.nextCommandId(); const result = await importSnapshot(h.deps, { commandId, draft: draft() });
    expect(result).toMatchObject({ ok: true, value: { v2: { settings: 'restored' } } });
    expect(await h.db.getFirstAsync('SELECT wake_minute, lunch_minute, dinner_minute, sleep_minute, metrics_education_dismissed FROM app_settings'))
      .toEqual({ wake_minute: 0, lunch_minute: 735, dinner_minute: 1095, sleep_minute: 1425, metrics_education_dismissed: JSON.stringify([id(1)]) });
    const saved = await h.db.getFirstAsync<{ settings_mutation_stamp: string }>('SELECT settings_mutation_stamp FROM app_settings');
    expect(await h.db.getAllAsync("SELECT entity_type, entity_id, mutation_stamp FROM mutation_outbox WHERE entity_type = 'settings'"))
      .toEqual([{ entity_type: 'settings', entity_id: 'app-settings', mutation_stamp: saved!.settings_mutation_stamp }]);
    const before = await snapshot(h);
    expect(await importSnapshot(h.deps, { commandId, draft: null as never })).toEqual(result);
    expect(await importSnapshot(h.deps, { commandId, get draft(): never { throw new Error('private getter'); } })).toEqual(result);
    expect(await snapshot(h)).toEqual(before);
  });

  it('rolls back all restored values on a late receipt failure without exposing source text, then retries', async () => {
    const input = { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1)] }) };
    const before = await snapshot(h); const run = h.db.runAsync.bind(h.db);
    const fault = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO command_receipts')) throw new Error('private imported note');
      return run(sql, params);
    });
    const result = await importSnapshot(h.deps, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(JSON.stringify(result)).not.toContain('private imported note');
    expect(await snapshot(h)).toEqual(before); fault.mockRestore();
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { boardsCreated: 1 } });
  });

  it('retains accepted immutable bytes for absent parents, resolves pending evidence and queues each identity once', async () => {
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence([], [award]) }) }))
      .toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 0, generated: 0, pending: 1 } } } });
    const imported = { commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence([source]) }) };
    expect(await importSnapshot(h.deps, imported)).toMatchObject({ ok: true, value: {
      v2: { immutable: { admitted: 2, generated: 0, pending: 0, duplicates: 0 } } } });
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([source]);
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await h.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
    const before = await snapshot(h); expect(await importSnapshot(h.deps, imported)).toMatchObject({ ok: true });
    expect(await snapshot(h)).toEqual(before);
    const queue = await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id');
    expect(await importSnapshot(h.deps, { ...imported, commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence([source], [award]) }) }))
      .toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 0, generated: 0, duplicates: 2 } } } });
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id')).toEqual(queue);
  });

  it('projects a raw restored check from genuine evidence and generates only its canonical missing award', async () => {
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [{ ...board(1), sourceId: source.boardId }],
      checkIns: [{ ...check(2), sourceId: source.checkInId!, sourceBoardId: source.boardId, logicalDate: source.logicalDate }],
      evidence: evidence([source]),
    }) });
    expect(result).toMatchObject({ ok: true, value: { checkInsCreated: 1, v2: { immutable: { admitted: 1, generated: 1 } } } });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await listBoardCheckIns(h.db, source.boardId)).toHaveLength(1);
    expect(await h.db.getAllAsync("SELECT * FROM habit_actions WHERE kind = 'baseline'")).toEqual([]);
  });

  it('admits an orphan claim with its original title and quarantines identifiable extra fields and signed zero', async () => {
    const claim: CoinLedgerRow = { ...award, id: id(55) as never, kind: 'claim', delta: -100,
      boardId: null, checkInId: null, scopeKey: null, sourceActionId: null, rewardId: id(90) as never,
      rewardTitleSnapshot: 'original reward title' };
    const inputEvidence = evidence([{ ...source, secret: 'private extra' }, { ...source, id: id(56), createdAt: 0 }], [claim]);
    inputEvidence.sourceJson = inputEvidence.sourceJson.replace('"createdAt":0', '"createdAt":-0');
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ evidence: inputEvidence }) });
    expect(result).toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 1, generated: 0, quarantined: 2 } } } });
    expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
    expect(await h.db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private extra');
    expect(await h.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: -100 });
  });

  it.each(['hash', 'generated ledger', 'projection', 'hlc'])('rolls back settings, rows, evidence and queue after a %s failure, then retries', async stage => {
    const input = { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1)], evidence: evidence([source]) }) };
    const before = await snapshot(h); const run = h.db.runAsync.bind(h.db);
    const fault = stage === 'hash' ? jest.spyOn(h.deps.hashing, 'sha256').mockRejectedValue(new CoinContractError('size'))
      : jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
        if ((stage === 'generated ledger' && sql.includes('INSERT INTO coin_ledger')) ||
          (stage === 'projection' && sql.includes('DELETE FROM widget_board_rows')) ||
          (stage === 'hlc' && sql.includes('UPDATE app_settings SET hlc_wall_time'))) throw new Error('private failure');
        return run(sql, params);
      });
    const result = await importSnapshot(h.deps, input);
    expect(result).toMatchObject({ ok: false, error: { code: stage === 'hash' ? 'platform' : 'database', retryable: true } });
    expect(JSON.stringify(result)).not.toContain('private failure'); expect(await snapshot(h)).toEqual(before);
    fault.mockRestore();
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { boardsCreated: 1, v2: { immutable: { admitted: 1, generated: 1 } } } });
  });

  it('preserves existing and tombstoned identity ownership while attaching new children to an existing archived parent', async () => {
    const initial = draft({ boards: [{ ...board(1), archivedAtUtc: 1900000000001 }, board(2)],
      checkIns: [check(3)], reminders: [reminder(4)], rewards: [reward(5)] });
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: initial })).toMatchObject({ ok: true });
    for (const [table, n] of [['boards', 2], ['check_ins', 3], ['reminders', 4], ['rewards', 5]] as const) {
      await h.db.runAsync(`UPDATE ${table} SET deleted_at = 7 WHERE id = ?`, [id(n)]);
    }
    const preserved = await Promise.all(['boards', 'check_ins', 'reminders', 'rewards'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`)));
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [board(1, 99), board(2), board(6, 2), board(7, 99), board(8, 1), board(8, 1)],
      checkIns: [check(3), check(9), check(10, 2), check(9)], reminders: [reminder(4), reminder(11), reminder(12, 2), reminder(11)],
      rewards: [reward(5), reward(13), reward(13)],
    }) });
    expect(result).toMatchObject({ ok: true, value: { boardsCreated: 1, boardsSkipped: 5, checkInsCreated: 1, checkInsSkipped: 3,
      remindersCreated: 1, remindersSkipped: 3, v2: { rewardsCreated: 1, rewardsSkipped: 2, settings: 'preserved' } } });
    for (const [index, table] of ['boards', 'check_ins', 'reminders', 'rewards'].entries()) {
      const rows = await h.db.getAllAsync<{ id: string }>(`SELECT * FROM ${table} ORDER BY id`);
      expect(rows.filter(row => (preserved[index] as { id: string }[]).some(old => old.id === row.id))).toEqual(preserved[index]);
    }
    expect(await h.db.getFirstAsync('SELECT enabled, schedule_state, created_at FROM reminders WHERE id = ?', [id(11)]))
      .toEqual({ enabled: 1, schedule_state: 'idle', created_at: 1900000000001.5 });
    expect(await h.db.getFirstAsync('SELECT archived_at, created_at FROM rewards WHERE id = ?', [id(13)]))
      .toEqual({ archived_at: 1900000000002, created_at: 1900000000001 });
  });

  it.each(['absent', 'invalid', 'default', 'configured', 'pending', 'local preferences'])('uses the acquired settings eligibility rule for %s', async state => {
    if (state === 'configured') await h.db.runAsync("UPDATE app_settings SET settings_mutation_stamp = '00000000000001-00000-device'");
    if (state === 'pending') await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ settings: { kind: 'absent' }, evidence: evidence([], [award]) }) });
    if (state === 'local preferences') await h.db.runAsync("UPDATE app_settings SET selected_icon = 'paper', icloud_sync_enabled = 1");
    const value = state === 'default' ? { metricsEducationDismissed: [], wakeMinute: 420, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1380 } : settings;
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ settings:
      state === 'absent' || state === 'invalid' ? { kind: state } : { kind: 'valid', value } }) });
    const status = state === 'default' ? 'unchanged' : state === 'configured' || state === 'pending' ? 'preserved'
      : state === 'local preferences' ? 'restored' : 'invalid';
    expect(result).toMatchObject({ ok: true, value: { v2: { settings: status } } });
    expect(await h.db.getAllAsync("SELECT id FROM mutation_outbox WHERE entity_type = 'settings'"))
      .toHaveLength(status === 'restored' ? 1 : 0);
  });

  it('captures the complete caller input before queued work and evaluates settings after the preceding commit', async () => {
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const writer = h.db.withExclusiveTransactionAsync(async tx => {
      entered(); await hold; await tx.runAsync('UPDATE app_settings SET wake_minute = 15');
    });
    await started;
    const input = { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1)], evidence: evidence([source]) }) };
    const commandId = input.commandId;
    const result = importSnapshot(h.deps, input);
    input.commandId = h.ids.nextCommandId(); input.draft.boards[0].title = 'mutated'; input.draft.boards.length = 0;
    input.draft.evidence.sourceJson = 'bad'; input.draft.settings = { kind: 'absent' };
    release(); await writer;
    expect(await result).toMatchObject({ ok: true, value: { boardsCreated: 1, v2: { settings: 'preserved', immutable: { admitted: 1 } } } });
    expect(await h.db.getFirstAsync('SELECT title FROM boards WHERE id = ?', [id(1)])).toEqual({ title: 'board 1' });
    expect(await h.db.getFirstAsync('SELECT command_id FROM command_receipts WHERE command_id = ?', [commandId])).not.toBeNull();
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([source]);
  });

  it('maps unretainable evidence size and malformed input without persisting a failure receipt', async () => {
    const before = await snapshot(h);
    for (const value of [draft({ evidence: { sourceJson: 'bad' } }), null]) {
      expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: value as never }))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(await snapshot(h)).toEqual(before);
    }
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [board(1)], evidence: evidence([{ ...source, policyJson: ' '.repeat(196609) }]),
    }) });
    expect(result).toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
  });

  it.each(['boards', 'checkIns', 'reminders', 'rewards'] as const)('rejects unsafe %s summary arithmetic atomically', async table => {
    const values = { boards: [board(1)], checkIns: [check(2)], reminders: [reminder(3)], rewards: [reward(4)] };
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft(values) })).toMatchObject({ ok: true });
    const input = draft({ [table]: values[table], skipped: { boards: 0, checkIns: 0, reminders: 0, rewards: 0, [table]: Number.MAX_SAFE_INTEGER } });
    const before = await snapshot(h);
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: input }))
      .toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
  });

  it('keeps malformed accepted storage an integrity failure and rolls back the unrelated imported board', async () => {
    await h.db.runAsync(`INSERT INTO habit_actions
      (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [source.id, source.commandId, source.boardId, source.logicalDate,
      source.checkInId, source.kind, source.createdAt, source.mutationStamp, 'private broken stored policy']);
    const before = await snapshot(h);
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [board(1)], evidence: evidence([source]),
    }) });
    expect(result).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(JSON.stringify(result)).not.toContain('private broken'); expect(await snapshot(h)).toEqual(before);
  });

  it.each(['correction', 'overlap'] as const)('restores self-contained %s proofs after their dependencies and preserves canonical cancellation rows', async name => {
    const vector = checkFixture[name];
    const staged = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence([], vector.existingRows) }) });
    expect(staged).toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 0, generated: 0, pending: vector.existingRows.length } } } });
    const finished = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence(vector.actions) }) });
    expect(finished).toMatchObject({ ok: true, value: { v2: { immutable: { pending: 0, blocked: 0, quarantined: 0 } } } });
    for (const row of [...vector.existingRows, ...vector.expectedAppend] as CoinLedgerRow[]) {
      expect(await getLedgerEntry(h.db, row.id)).toEqual(row);
    }
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS rows, SUM(delta) AS balance FROM coin_ledger'))
      .toEqual({ rows: vector.existingRows.length + vector.expectedAppend.length, balance: vector.balance });
    const immutable = await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    const queue = await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id');
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ evidence: evidence(vector.actions, [...vector.existingRows, ...vector.expectedAppend]) }) }))
      .toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 0, generated: 0 } } } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(immutable);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id')).toEqual(queue);
  });

  it.each([false, true])('rejects the full dependent cycle component with reversed input %s', async reverse => {
    const rows = [board(1, 2), board(2, 3), board(3, 1), board(4, 1), board(5, 4), board(6), board(7, 6)];
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ boards: reverse ? rows.reverse() : rows }) });
    expect(result).toMatchObject({ ok: true, value: { boardsCreated: 2, boardsSkipped: 5 } });
    expect(await h.db.getAllAsync('SELECT id, anchor_board_id FROM boards ORDER BY id'))
      .toEqual([{ id: id(6), anchor_board_id: null }, { id: id(7), anchor_board_id: id(6) }]);
  });

  it('restores the carried v5 baseline as state-only evidence without minting a new action or award', async () => {
    const baseline = checkFixture.cases.find(vector => vector.name === 'baseline blocks promotion of retained token')!.actions[1] as HabitAction;
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [{ ...board(1), sourceId: baseline.boardId }],
      checkIns: [{ ...check(2), sourceId: baseline.checkInId!, sourceBoardId: baseline.boardId, logicalDate: baseline.logicalDate }],
      evidence: evidence([baseline]),
    }) });
    expect(result).toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 1, generated: 0 } } } });
    expect(await listHabitActions(h.db, baseline.boardId, baseline.logicalDate)).toEqual([baseline]);
    expect(await listBoardCheckIns(h.db, baseline.boardId)).toHaveLength(1);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('observes only accepted immutable stamps and preserves sequencing for the next public command', async () => {
    const rejected = { ...source, id: id(75), mutationStamp: '09000000000000-00000-rejected', kind: 'invalid' };
    const result = await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      settings: { kind: 'absent' }, evidence: evidence([source, rejected]),
    }) });
    expect(result).toMatchObject({ ok: true, value: { v2: { immutable: { admitted: 1, generated: 1, quarantined: 1 } } } });
    expect(await h.db.getFirstAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'))
      .toEqual({ hlc_wall_time: 1788825600000, hlc_counter: 1 });
    expect(await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title: 'later', symbol: 'star.fill', accentHex: '#78D98B',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: false }))
      .toMatchObject({ ok: true });
    expect((await h.db.getFirstAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM boards'))!.mutation_stamp > source.mutationStamp).toBe(true);
  });

  it('bounds raw identity reads to the incoming IDs and does not pass private payload fields to SQL lookup', async () => {
    const read = jest.spyOn(h.db, 'getAllAsync');
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1)],
      checkIns: [check(2)], reminders: [reminder(3)], rewards: [reward(4)] }) })).toMatchObject({ ok: true });
    const calls = read.mock.calls.filter(([sql]) => /^SELECT id FROM (boards|check_ins|reminders|rewards)\s/.test(sql));
    expect(calls).toHaveLength(4);
    for (const [index, [sql, params]] of calls.entries()) {
      expect(sql).toContain('WHERE id IN (SELECT value FROM json_each(?))');
      expect(params).toEqual([JSON.stringify([id(index + 1)])]);
    }
  });

  it.each([false, true])('keeps the genuine v1 reminder identity skip contract for deleted=%s', async deleted => {
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: draft({
      boards: [board(1)], reminders: [reminder(2)],
    }) })).toMatchObject({ ok: true });
    if (deleted) await h.db.runAsync('UPDATE reminders SET deleted_at = 5 WHERE id = ?', [id(2)]);
    const old = await h.db.getAllAsync('SELECT * FROM reminders');
    const legacy: LegacyImportDraft = { source: 'own', exportVersion: 1,
      boards: [{ ...board(1), preserveId: true }], checkIns: [], reminders: [reminder(2)] };
    expect(await importSnapshot(h.deps, { commandId: h.ids.nextCommandId(), draft: legacy }))
      .toEqual({ ok: true, value: { boardsCreated: 0, boardsSkipped: 1, checkInsCreated: 0, checkInsSkipped: 0,
        remindersCreated: 0, remindersSkipped: 1 } });
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual(old);
  });

  it('maps actual receipt lookup SQL failures privately before any writes and retries once storage recovers', async () => {
    const input = { commandId: h.ids.nextCommandId(), draft: draft({ boards: [board(1)] }) };
    const before = await snapshot(h);
    await h.db.execAsync('ALTER TABLE command_receipts RENAME TO saved_receipts');
    await h.db.execAsync('CREATE VIEW command_receipts AS SELECT * FROM private_database_path_sentinel');
    try {
      expect(await importSnapshot(h.deps, input)).toEqual({ ok: false, error: {
        code: 'database', message: 'The import could not be completed. Try again.', retryable: true,
      } });
    } finally {
      await h.db.execAsync('DROP VIEW command_receipts');
      await h.db.execAsync('ALTER TABLE saved_receipts RENAME TO command_receipts');
    }
    expect(await snapshot(h)).toEqual(before);
    expect(await importSnapshot(h.deps, input)).toMatchObject({ ok: true, value: { boardsCreated: 1 } });
  });

  it('maps unreadable receipt JSON privately while replaying actual stored failure outcomes unchanged', async () => {
    const commandId = h.ids.nextCommandId(); const input = { commandId, draft: draft({ boards: [board(1)] }) };
    await h.db.runAsync('INSERT INTO command_receipts (command_id, outcome, created_at) VALUES (?, ?, ?)',
      [commandId, 'private_receipt_payload', 0]);
    const before = await snapshot(h);
    expect(await importSnapshot(h.deps, input)).toEqual({ ok: false, error: {
      code: 'database', message: 'The import could not be completed. Try again.', retryable: true,
    } });
    expect(await snapshot(h)).toEqual(before);
    const saved = { ok: false, error: { code: 'validation', message: 'original saved result', retryable: false } };
    await h.db.runAsync('UPDATE command_receipts SET outcome = ? WHERE command_id = ?', [JSON.stringify(saved), commandId]);
    const final = await snapshot(h);
    expect(await importSnapshot(h.deps, input)).toEqual(saved);
    expect(await snapshot(h)).toEqual(final);
  });
});
