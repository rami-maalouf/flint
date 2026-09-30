import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckIn, archiveBoard, deleteBoard } from '@/core/domain/commands';
import { reconcileMissAlerts, getPendingMissAlertCount } from '@/core/domain/miss-alert-reconciliation';
import { missAlertIdentifier } from '@/core/domain/miss-alerts';
import type { Clock, MissAlertPair, MissAlertScheduler, PendingMissAlertRequest, ReminderAuthorization } from '@/core/domain/ports';
import type { LogicalDate } from '@/core/domain/ids';
import { readMissAlertRows, replaceMissAlertRow, type MissAlertRow } from '@/core/persistence/repositories/miss-alerts';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

let h: TestHarness;
let pair: MissAlertPair;
let scheduler: jest.Mocked<MissAlertScheduler>;
let current: boolean;
let foreground: boolean;
const run = () => reconcileMissAlerts({ db: h.db, clock: h.clock, scheduler }, {
  isCurrent: () => current, isForeground: () => foreground,
});
const rows = () => readMissAlertRows(h.db, [pair]);
const inventory = (): PendingMissAlertRequest[] => {
  const request = scheduler.schedule.mock.calls[0][0];
  return [{ identifier: request.identifier, content: request, nextFireAtUtcMs: h.clock.utcMs + 3_600_000, acceptance: 'confirmed' }];
};
async function productRows() {
  return Promise.all(['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'app_settings', 'mutation_outbox',
    'command_receipts', 'board_activity_periods', 'widget_board_rows'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}
beforeEach(async () => {
  h = await createTestHarness(); h.clock.utcMs = Date.parse('2026-09-01T16:00:00Z');
  pair = { boardId: await createBoardForTest(h, { kind: 'daily', title: 'Reading' }), secondMissedDate: '2026-09-08' as LogicalDate };
  h.clock.utcMs = Date.parse('2026-09-09T12:00:00Z'); current = true; foreground = true;
  scheduler = { authorization: jest.fn().mockResolvedValue('granted'), pendingRequests: jest.fn().mockResolvedValue([]),
    presentedIdentifiers: jest.fn().mockResolvedValue([]), schedule: jest.fn().mockResolvedValue({ kind: 'accepted' }),
    refreshPending: jest.fn().mockResolvedValue({ kind: 'unchanged' }), cancel: jest.fn().mockResolvedValue({ kind: 'cancelled' }) };
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

it('commits the actual reservation before scheduling and deduplicates a successful pair', async () => {
  const before = await productRows();
  scheduler.schedule.mockImplementationOnce(async (request, context) => {
    expect(context.isCurrent()).toBe(true);
    expect(await h.db.withTransactionAsync(tx => readMissAlertRows(tx, [pair]))).toEqual([
      { ...pair, nativeIdentifier: request.identifier, status: 'pending' },
    ]);
    return { kind: 'accepted' };
  });
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: true, error: null });
  expect(scheduler.schedule.mock.calls[0][0]).toEqual({ ...pair, identifier: missAlertIdentifier(pair), title: 'Reading',
    body: 'Reading was missed twice. Fix the environment before anything else today.',
    trigger: { kind: 'local09', date: '2026-09-09' }, timeZoneId: 'America/New_York' });
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
  scheduler.pendingRequests.mockResolvedValue(inventory());
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  expect(await productRows()).toEqual(before);
});
it.each<ReminderAuthorization>(['denied', 'undetermined'])('records %s without scheduling or asking permission', async authorization => {
  scheduler.authorization.mockResolvedValue(authorization);
  expect(await run()).toMatchObject({ localChanged: true, error: null });
  expect(await rows()).toEqual([{ ...pair, nativeIdentifier: null, status: authorization === 'denied' ? 'denied' : 'pending' }]);
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.schedule).not.toHaveBeenCalled();
  scheduler.authorization.mockResolvedValue('granted');
  await run();
  expect(scheduler.schedule).toHaveBeenCalledTimes(authorization === 'denied' ? 0 : 1);
});
it('counts native inventory joined to the exact consumed pair identifier', async () => {
  await run(); scheduler.pendingRequests.mockResolvedValue([...inventory(), ...inventory(),
    { identifier: 'ordinary', content: null, nextFireAtUtcMs: null, acceptance: 'unconfirmed' }]);
  expect(await getPendingMissAlertCount({ db: h.db, scheduler })).toEqual({ ok: true, value: 1 });
  scheduler.pendingRequests.mockResolvedValue([]);
  expect(await getPendingMissAlertCount({ db: h.db, scheduler })).toEqual({ ok: true, value: 0 });
});
it('does not dispatch from a competing pass while the actual reservation awaits the native result', async () => {
  let release!: (value: { kind: 'accepted' }) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  scheduler.schedule.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const first = run(); await waiting;
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  release({ kind: 'accepted' }); await first;
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
});
it.each(['unknown', 'throw'] as const)('retains consumption after %s and never guesses acceptance from absent inventory', async kind => {
  if (kind === 'unknown') scheduler.schedule.mockResolvedValue({ kind: 'unknown' });
  else scheduler.schedule.mockRejectedValue(new Error('private native diagnostic'));
  const first = await run();
  expect(first).toMatchObject({ localChanged: true, refreshPendingCount: true, error: { code: 'platform', retryable: false } });
  expect(JSON.stringify(first)).not.toContain('private');
  expect(await rows()).toEqual([{ ...pair, status: 'error', nativeIdentifier: missAlertIdentifier(pair) }]);
  await run(); expect(scheduler.schedule).toHaveBeenCalledTimes(1);
});
it('retries only proven non-acceptance and supplies a future bounded retry deadline', async () => {
  scheduler.schedule.mockResolvedValueOnce({ kind: 'not_accepted', code: 'capacity' });
  expect(await run()).toMatchObject({ localChanged: true, nextRunAtUtcMs: h.clock.utcMs + 30_000, error: { code: 'capacity', retryable: true } });
  expect(await rows()).toEqual([{ ...pair, status: 'error', nativeIdentifier: null }]);
  h.clock.utcMs += 30_000;
  expect(await run()).toMatchObject({ localChanged: true, error: null });
  expect(scheduler.schedule).toHaveBeenCalledTimes(2);
});
it('conditionally releases a retired no-dispatch reservation and persists a factual result after retirement', async () => {
  scheduler.schedule.mockImplementationOnce(async () => { current = false; return { kind: 'retired' }; });
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: false, error: null });
  expect(await rows()).toEqual([{ ...pair, status: 'pending', nativeIdentifier: null }]);
  current = true;
  scheduler.schedule.mockImplementationOnce(async () => { current = false; return { kind: 'accepted' }; });
  await run();
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
});
it('cancels a scheduled assertion after an actual backfill and preserves its consumed row', async () => {
  await run(); scheduler.pendingRequests.mockResolvedValue(inventory());
  expect((await createCheckIn(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: pair.secondMissedDate })).ok).toBe(true);
  const before = await productRows();
  expect(await run()).toMatchObject({ localChanged: false, refreshPendingCount: true, error: null });
  expect(scheduler.cancel).toHaveBeenCalledWith(missAlertIdentifier(pair), expect.anything());
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
  expect(await productRows()).toEqual(before);
});
const persist = (status: MissAlertRow['status'], hasId: boolean) => h.db.withExclusiveTransactionAsync(tx =>
  replaceMissAlertRow(tx, null, { ...pair, status, nativeIdentifier: hasId ? missAlertIdentifier(pair) : null } as MissAlertRow));
const pendingForPair = (acceptance: 'confirmed' | 'unconfirmed' = 'confirmed', nextFireAtUtcMs: number | null = h.clock.utcMs + 60_000): PendingMissAlertRequest => ({
  identifier: missAlertIdentifier(pair), acceptance, nextFireAtUtcMs,
  content: { ...pair, identifier: missAlertIdentifier(pair), title: 'Old title', body: 'Old title was missed twice. Fix the environment before anything else today.' },
});
it.each(['confirmed', 'unconfirmed'] as const)('recovers %s pending evidence without a fresh add', async acceptance => {
  await persist('error', true);
  scheduler.pendingRequests.mockResolvedValue([pendingForPair(acceptance)]);
  scheduler.refreshPending.mockResolvedValue({ kind: 'accepted' });
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: true, error: null });
  expect(scheduler.schedule).not.toHaveBeenCalled();
  expect(scheduler.refreshPending).toHaveBeenCalledWith(expect.objectContaining({ retainedAcceptance: acceptance === 'confirmed' ? 'confirmed' : 'unresolved',
    replacement: expect.objectContaining({ title: 'Reading' }) }), expect.anything());
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
});
it.each([null, 0])('does not reissue a consumed native request with no future occurrence (%s)', async next => {
  await persist('pending', true);
  scheduler.pendingRequests.mockResolvedValue([pendingForPair('unconfirmed', next)]);
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.refreshPending).not.toHaveBeenCalled(); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['not_accepted', 'unknown', 'throw', 'retired', 'cancelled'] as const)('retains the consumed ID after a same-ID refresh returns %s', async kind => {
  await persist('error', true); scheduler.pendingRequests.mockResolvedValue([pendingForPair('unconfirmed')]);
  if (kind === 'throw') scheduler.refreshPending.mockRejectedValue(new Error('private platform path'));
  else scheduler.refreshPending.mockResolvedValue(kind === 'not_accepted' ? { kind, code: 'schedule_failed' } : { kind });
  const result = await run();
  expect(JSON.stringify(result)).not.toContain('private');
  expect((await rows())[0].nativeIdentifier).toBe(missAlertIdentifier(pair));
  expect(scheduler.schedule).not.toHaveBeenCalled();
  expect(result.refreshPendingCount).toBe(kind !== 'retired');
});
it('recovers a genuinely presented consumed pair and leaves absent reservations consumed', async () => {
  await persist('pending', true);
  scheduler.presentedIdentifiers.mockResolvedValue([missAlertIdentifier(pair), 'unrelated']);
  expect(await run()).toMatchObject({ localChanged: true, error: null });
  expect(await rows()).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['archive', 'delete'] as const)('cancels after public %s without clearing the dedupe record', async operation => {
  await run(); scheduler.pendingRequests.mockResolvedValue(inventory());
  const command = operation === 'archive' ? archiveBoard : deleteBoard;
  expect((await command(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  await run(); expect(scheduler.cancel).toHaveBeenCalledTimes(1);
  expect((await rows())[0].nativeIdentifier).toBe(missAlertIdentifier(pair));
});
it('retains an older truthful pair even when the current pair is checked', async () => {
  pair = { ...pair, secondMissedDate: '2026-09-05' as LogicalDate };
  await persist('scheduled', true); scheduler.pendingRequests.mockResolvedValue([pendingForPair()]);
  await createCheckIn(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: '2026-09-08' as LogicalDate });
  await run(); expect(scheduler.cancel).not.toHaveBeenCalled(); expect(scheduler.schedule).not.toHaveBeenCalled();
  expect(scheduler.refreshPending).toHaveBeenCalledTimes(1);
});
it('cancels owned malformed/orphan requests only, and does not reschedule behind an unknown cancellation', async () => {
  scheduler.pendingRequests.mockResolvedValue([pendingForPair(), { identifier: 'habit-system.miss.v1:bad', content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' },
    { identifier: 'ordinary', content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' }]);
  scheduler.cancel.mockResolvedValue({ kind: 'unknown' });
  expect(await run()).toMatchObject({ localChanged: false, refreshPendingCount: true, error: { retryable: true } });
  expect(scheduler.cancel.mock.calls.map(call => call[0])).toEqual([missAlertIdentifier(pair), 'habit-system.miss.v1:bad']);
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['retired', 'throw'] as const)('does not mistake a %s orphan cancellation for success', async kind => {
  scheduler.pendingRequests.mockResolvedValue([pendingForPair()]);
  if (kind === 'throw') scheduler.cancel.mockRejectedValue(new Error('private cancel diagnostic'));
  else scheduler.cancel.mockResolvedValue({ kind });
  const result = await run();
  expect(result.refreshPendingCount).toBe(kind !== 'retired');
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('rechecks after native acceptance and cancels a backfill committed during the await', async () => {
  scheduler.schedule.mockImplementationOnce(async () => {
    expect((await createCheckIn(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: pair.secondMissedDate })).ok).toBe(true);
    return { kind: 'accepted' };
  });
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: true, error: null });
  expect(scheduler.cancel).toHaveBeenCalledWith(missAlertIdentifier(pair), expect.anything());
  expect((await rows())[0].status).toBe('scheduled');
});
it('does no work for an already retired invocation', async () => {
  current = false;
  expect(await run()).toEqual({ localChanged: false, refreshPendingCount: false, nextRunAtUtcMs: null, error: null });
  expect(scheduler.authorization).not.toHaveBeenCalled();
});
it('exposes no past deadline for empty stores or dormant absent consumed requests', async () => {
  await archiveBoard(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId() });
  expect(await run()).toMatchObject({ localChanged: false, nextRunAtUtcMs: null, error: null });
  await persist('error', true);
  const result = await run();
  expect(result.nextRunAtUtcMs).toBeGreaterThan(h.clock.utcMs);
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['permission', 'inventory', 'presented', 'database'] as const)('returns a safe %s failure without fabricated count or effect', async stage => {
  if (stage === 'permission') scheduler.authorization.mockRejectedValue(new Error('private authorization path'));
  if (stage === 'inventory') scheduler.pendingRequests.mockRejectedValue(new Error('private inventory path'));
  if (stage === 'presented') { await persist('error', true); scheduler.presentedIdentifiers.mockRejectedValue(new Error('private presented path')); }
  if (stage === 'database') await h.db.execAsync('DROP TABLE miss_alerts');
  const result = await run();
  expect(result.error).toMatchObject({ code: stage === 'database' ? 'database' : 'platform' });
  expect(result.nextRunAtUtcMs).toBe(h.clock.utcMs + 30_000);
  expect(JSON.stringify(result)).not.toContain('private'); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('preserves committed reservation progress when the outcome write actually fails, then recovers without another add', async () => {
  await h.db.execAsync("CREATE TRIGGER refuse_scheduled BEFORE UPDATE ON miss_alerts WHEN NEW.status = 'scheduled' BEGIN SELECT RAISE(ABORT,'private db path'); END");
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: true, error: { code: 'database' } });
  expect((await rows())[0].status).toBe('pending');
  await h.db.execAsync('DROP TRIGGER refuse_scheduled');
  scheduler.pendingRequests.mockResolvedValue(inventory());
  expect(await run()).toMatchObject({ localChanged: true, error: null });
  expect(scheduler.schedule).toHaveBeenCalledTimes(1);
});
it('rolls back a failed reservation and does not call native scheduling', async () => {
  await h.db.execAsync("CREATE TRIGGER refuse_miss BEFORE INSERT ON miss_alerts BEGIN SELECT RAISE(ABORT,'private SQL'); END");
  expect(await run()).toMatchObject({ localChanged: false, refreshPendingCount: false, error: { code: 'database' } });
  expect(await rows()).toEqual([]); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('count excludes null-ID rows even when orphan IDs match and keeps malformed tracked content visible', async () => {
  await persist('denied', false); scheduler.pendingRequests.mockResolvedValue([pendingForPair()]);
  expect(await getPendingMissAlertCount({ db: h.db, scheduler })).toEqual({ ok: true, value: 0 });
  await h.db.runAsync('UPDATE miss_alerts SET status = ?, native_identifier = ?', ['error', missAlertIdentifier(pair)]);
  scheduler.pendingRequests.mockResolvedValue([{ ...pendingForPair(), content: null }, { ...pendingForPair(), content: null }]);
  expect(await getPendingMissAlertCount({ db: h.db, scheduler })).toEqual({ ok: true, value: 1 });
});
it.each(['native', 'storage'] as const)('count exposes safe %s failure rather than an invented zero', async stage => {
  if (stage === 'native') scheduler.pendingRequests.mockRejectedValue(new Error('private native'));
  else { await h.db.execAsync('DROP TABLE miss_alerts'); scheduler.pendingRequests.mockResolvedValue([pendingForPair()]); }
  const result = await getPendingMissAlertCount({ db: h.db, scheduler });
  expect(result).toMatchObject({ ok: false, error: { code: stage === 'native' ? 'platform' : 'database', retryable: true } });
  expect(JSON.stringify(result)).not.toContain('private');
});
it('uses the actual post-schedule next fire time and retains progress if the final inventory read fails', async () => {
  scheduler.pendingRequests.mockImplementation(async () => scheduler.schedule.mock.calls.length ? inventory() : []);
  expect(await run()).toMatchObject({ nextRunAtUtcMs: h.clock.utcMs + 3_600_000, error: null });
  scheduler.pendingRequests.mockResolvedValueOnce(inventory()).mockRejectedValueOnce(new Error('private final inventory'));
  scheduler.refreshPending.mockResolvedValueOnce({ kind: 'accepted' });
  expect(await run()).toMatchObject({ refreshPendingCount: true, error: { code: 'platform' } });
  expect(scheduler.schedule).toHaveBeenCalledTimes(1);
});
it('ignores ordinary, null and past native deadlines in the final effect refresh', async () => {
  scheduler.pendingRequests.mockResolvedValueOnce([]).mockResolvedValueOnce([
    { ...pendingForPair(), nextFireAtUtcMs: null }, { ...pendingForPair(), nextFireAtUtcMs: h.clock.utcMs - 1 },
    { ...pendingForPair(), identifier: 'ordinary', nextFireAtUtcMs: h.clock.utcMs + 1 },
    { ...pendingForPair(), nextFireAtUtcMs: h.clock.utcMs + 60_000 },
    { ...pendingForPair(), nextFireAtUtcMs: h.clock.utcMs + 120_000 },
  ]);
  expect(await run()).toMatchObject({ nextRunAtUtcMs: h.clock.utcMs + 60_000, error: null });
});
it('keeps exact two-date effective queries and ignores suppressed raw payload', async () => {
  const checked = await createCheckIn(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: pair.secondMissedDate, note: 'private note' });
  if (!checked.ok) throw new Error(checked.error.message);
  await h.db.runAsync('UPDATE check_ins SET state_suppressed = 1 WHERE id = ?', [checked.value.checkInId]);
  const reads = jest.spyOn(h.db, 'getAllAsync');
  await run(); expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  const queries = reads.mock.calls.filter(([sql]) => sql.includes('FROM check_ins'));
  expect(queries.length).toBeGreaterThan(0);
  for (const [sql, parameters] of queries) {
    expect(sql).toContain('state_suppressed = 0'); expect(sql).not.toContain('note');
    expect(JSON.parse(parameters![0] as string)).toEqual([
      { boardId: pair.boardId, logicalDate: '2026-09-07' }, { boardId: pair.boardId, logicalDate: '2026-09-08' },
    ]);
  }
});
it('deduplicates observed identities before a same-ID refresh', async () => {
  await persist('scheduled', true);
  scheduler.pendingRequests.mockResolvedValue([pendingForPair(), pendingForPair()]);
  await run(); expect(scheduler.refreshPending).toHaveBeenCalledTimes(1);
});
it('does not invent eligible labels before year zero', async () => {
  h.clock.zone = 'UTC'; h.clock.utcMs = -62167219200000;
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['retire', 'archive', 'date', 'missing'] as const)('requalifies after queued %s before acquiring the reservation', async change => {
  const acquire = h.db.withExclusiveTransactionAsync.bind(h.db);
  jest.spyOn(h.db, 'withExclusiveTransactionAsync').mockImplementationOnce(async work => {
    if (change === 'retire') current = false;
    if (change === 'archive') await archiveBoard(h.deps, { boardId: pair.boardId, commandId: h.ids.nextCommandId() });
    if (change === 'date') h.clock.advanceDays(1);
    if (change === 'missing') {
      await h.db.execAsync('PRAGMA foreign_keys = OFF');
      await h.db.runAsync('DELETE FROM boards WHERE id = ?', [pair.boardId]);
      await h.db.execAsync('PRAGMA foreign_keys = ON');
    }
    return acquire(work);
  });
  expect(await run()).toMatchObject({ localChanged: false, error: null });
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
it.each(['zone', 'date'] as const)('invalidates its synchronous dispatch guard after a %s change', async change => {
  const acquire = h.db.withExclusiveTransactionAsync.bind(h.db);
  jest.spyOn(h.db, 'withExclusiveTransactionAsync').mockImplementationOnce(async work => {
    const value = await acquire(work);
    if (change === 'zone') h.clock.zone = 'UTC'; else h.clock.advanceDays(1);
    return value;
  });
  expect(await run()).toMatchObject({ localChanged: true, refreshPendingCount: false, error: null });
  expect(scheduler.schedule).not.toHaveBeenCalled();
  expect((await rows())[0]).toMatchObject({ status: 'pending', nativeIdentifier: null });
});
it('stops later pending work after retirement and never enters a cancellation with an expired qualification', async () => {
  await persist('scheduled', true);
  scheduler.pendingRequests.mockResolvedValue([pendingForPair(), { ...pendingForPair(), identifier: 'habit-system.miss.v1:bad' }]);
  scheduler.refreshPending.mockImplementationOnce(async () => { current = false; return { kind: 'retired' }; });
  await run(); expect(scheduler.cancel).not.toHaveBeenCalled(); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('does not dispatch cancellation when the zone changes after acquired inspection', async () => {
  scheduler.pendingRequests.mockResolvedValue([pendingForPair()]);
  const read = h.db.withTransactionAsync.bind(h.db); let calls = 0;
  jest.spyOn(h.db, 'withTransactionAsync').mockImplementation(async work => {
    const value = await read(work);
    calls += 1; if (calls === 2) h.clock.zone = 'UTC';
    return value;
  });
  await run(); expect(scheduler.cancel).not.toHaveBeenCalled(); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('restores an existing proven-failure row on retirement before a fresh dispatch', async () => {
  await persist('error', false); scheduler.schedule.mockResolvedValue({ kind: 'retired' });
  await run(); expect((await rows())[0]).toEqual({ ...pair, status: 'error', nativeIdentifier: null });
});
it('preserves a concurrent confirmed outcome against an older failed native result', async () => {
  scheduler.schedule.mockImplementationOnce(async () => {
    const [prior] = await rows();
    await h.db.withExclusiveTransactionAsync(tx => replaceMissAlertRow(tx, prior, { ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }));
    return { kind: 'unknown' };
  });
  await run(); expect((await rows())[0].status).toBe('scheduled');
});
it('captures call receivers and original dependencies before its first native await', async () => {
  const deps: { db: typeof h.db; clock: Clock; scheduler: MissAlertScheduler } = { db: h.db, clock: h.clock, scheduler };
  const originalSchedule = scheduler.schedule;
  let release!: (value: ReminderAuthorization) => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  scheduler.authorization.mockImplementationOnce(function (this: MissAlertScheduler) {
    expect(this).toBe(scheduler); entered(); return new Promise(resolve => { release = resolve; });
  });
  const operation = reconcileMissAlerts(deps, { isCurrent: () => current, isForeground: () => foreground });
  await waiting;
  deps.clock = { nowUtcMs: () => { throw new Error('poisoned'); }, timeZoneId: () => 'UTC' };
  scheduler.schedule = jest.fn().mockRejectedValue(new Error('poisoned replacement'));
  release('granted');
  expect(await operation).toMatchObject({ localChanged: true, error: null });
  expect(originalSchedule).toHaveBeenCalledTimes(1); expect(scheduler.schedule).not.toHaveBeenCalled();
});
it('withholds an orphan identity for the whole pass even after confirmed cleanup', async () => {
  scheduler.pendingRequests.mockResolvedValueOnce([pendingForPair()]).mockResolvedValue([]);
  expect(await run()).toMatchObject({ localChanged: false, refreshPendingCount: true, nextRunAtUtcMs: h.clock.utcMs + 30_000, error: null });
  expect(scheduler.cancel).toHaveBeenCalledTimes(1); expect(scheduler.schedule).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  h.clock.utcMs += 30_000;
  expect(await run()).toMatchObject({ localChanged: true, error: null });
  expect(scheduler.schedule).toHaveBeenCalledTimes(1);
});
it('cancels malformed content on a truthful retained pair and an exact missing-board orphan', async () => {
  await persist('scheduled', true);
  const absent = { ...pair, boardId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as typeof pair.boardId };
  scheduler.pendingRequests.mockResolvedValue([{ ...pendingForPair(), content: null },
    { identifier: missAlertIdentifier(absent), content: null, nextFireAtUtcMs: null, acceptance: 'confirmed' }]);
  await run();
  expect(scheduler.cancel.mock.calls.map(call => call[0])).toEqual([missAlertIdentifier(pair), missAlertIdentifier(absent)]);
  expect(scheduler.schedule).not.toHaveBeenCalled(); expect((await rows())[0].status).toBe('scheduled');
});

it('never returns a deadline that elapsed during a held effect and safely reports an unreadable clock', async () => {
  scheduler.schedule.mockImplementationOnce(async () => { h.clock.advanceDays(2); return { kind: 'accepted' }; });
  const result = await run();
  expect(result.nextRunAtUtcMs === null || result.nextRunAtUtcMs > h.clock.utcMs).toBe(true);
  const badClock = { nowUtcMs: () => { throw new Error('private clock'); }, timeZoneId: () => 'UTC' };
  const failed = await reconcileMissAlerts({ db: h.db, clock: badClock, scheduler }, { isCurrent: () => true, isForeground: () => true });
  expect(failed).toMatchObject({ error: { retryable: true }, nextRunAtUtcMs: null });
  expect(JSON.stringify(failed)).not.toContain('private');
});
it('safely rejects an unavailable clock boundary and a nonfinite final clock without a timer spin', async () => {
  const missing = await reconcileMissAlerts({ db: h.db, clock: null, scheduler } as never, { isCurrent: () => true, isForeground: () => true });
  expect(missing).toMatchObject({ error: { code: 'platform' }, nextRunAtUtcMs: null });
  scheduler.authorization.mockImplementationOnce(async () => { h.clock.utcMs = Number.NaN; throw new Error('native private'); });
  expect(await run()).toMatchObject({ error: { code: 'platform' }, nextRunAtUtcMs: null });
});

it('arbitrates a fresh pair across two real WAL connections while the first native effect is held', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'miss-alert-wal-')); const file = join(folder, 'store.sqlite');
  await h.db.runAsync('VACUUM INTO ?', [file]);
  const firstDb = new NodeSqlDatabase(file); const secondDb = new NodeSqlDatabase(file);
  try {
    await firstDb.execAsync('PRAGMA journal_mode = WAL');
    await secondDb.execAsync('PRAGMA journal_mode = WAL');
    let release!: (value: { kind: 'accepted' }) => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    scheduler.schedule.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const callbacks = { isCurrent: () => true, isForeground: () => true };
    const first = reconcileMissAlerts({ db: firstDb, clock: h.clock, scheduler }, callbacks);
    await waiting;
    expect(await reconcileMissAlerts({ db: secondDb, clock: h.clock, scheduler }, callbacks)).toMatchObject({ localChanged: false, error: null });
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    release({ kind: 'accepted' }); await first;
    expect(await readMissAlertRows(secondDb, [pair])).toEqual([{ ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) }]);
  } finally { await firstDb.closeAsync(); await secondDb.closeAsync(); rmSync(folder, { recursive: true, force: true }); }
});
it.each(['schedule', 'refresh', 'cancel'] as const)('treats an unexpected synchronous %s throw as an uncertain effect', async operation => {
  if (operation === 'refresh') { await persist('pending', true); scheduler.pendingRequests.mockResolvedValue([pendingForPair('unconfirmed')]); }
  if (operation === 'cancel') scheduler.pendingRequests.mockResolvedValue([pendingForPair()]);
  const method = operation === 'refresh' ? 'refreshPending' : operation;
  scheduler[method].mockImplementation(() => { throw new Error('private synchronous native detail'); });
  const result = await run();
  expect(result).toMatchObject({ refreshPendingCount: true, error: { code: 'platform', retryable: operation === 'cancel' } });
  expect(JSON.stringify(result)).not.toContain('private');
  if (operation !== 'cancel') expect(await rows()).toEqual([{ ...pair, status: 'error', nativeIdentifier: missAlertIdentifier(pair) }]);
});
it('does not consume a pair when its acquired future trigger cannot be represented', async () => {
  h.clock.zone = 'UTC'; h.clock.utcMs = Date.parse('9999-12-31T12:00:00Z'); foreground = false;
  const result = await run();
  expect(result.localChanged).toBe(false); expect(result.refreshPendingCount).toBe(false);
  expect(result.error).not.toBeNull();
  expect(await h.db.getAllAsync('SELECT * FROM miss_alerts')).toEqual([]);
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
