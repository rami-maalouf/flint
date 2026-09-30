import fixtures from '../../../modules/habit-system-apple/tests/CloudKit/sync-records-v2.json';
import legacyFixtures from '../../../modules/habit-system-apple/tests/CloudKit/sync-records.json';
import { createCheckIn } from '@/core/domain/check-in-commands';
import type { BoardId } from '@/core/domain/ids';
import { createBoard } from '@/core/domain/commands';
import { validateInboundRecord, validateLegacyRecordForSchema2, validateSchema2MutableRecord } from '@/core/sync/inbound-validation';
import type { Schema2SyncRecord } from '@/core/sync/schema-2-records';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const parentId = fixtures[0].entityId;
const missingId = '00000000-0000-4000-8000-000000009999';
function record(type: string, fields: Record<string, unknown> = {}) {
  const value = structuredClone(fixtures.find(row => row.entityType === type && !row.deleted)!);
  return { ...value, fields: { ...value.fields, ...fields } } as unknown as Schema2SyncRecord;
}

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness();
  const created = await createBoard({ ...h.deps, ids: { uuid: () => parentId } }, {
    commandId: h.ids.nextCommandId(), title: 'parent', symbol: 'star.fill', accentHex: '#70A7FF',
    usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0,
    metricsEnabled: true,
  });
  expect(created.ok).toBe(true);
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
const validate = (value: unknown) => h.db.withExclusiveTransactionAsync(tx => validateSchema2MutableRecord(tx, value));
const legacy = (value: unknown) => h.db.withExclusiveTransactionAsync(tx => validateLegacyRecordForSchema2(tx, value));

describe('schema-2 mutable inbound normalization', () => {
  it.each(fixtures.filter(row => !['habit_action', 'ledger_entry'].includes(row.entityType)))(
    'validates the exact paired $entityType fixture deleted=$deleted with its version and stamp', async fixture => {
      expect(await validate(fixture)).toEqual({ kind: 'valid', record: fixture });
    });

  it('adds explicit compatibility fields only to valid v1 records while preserving the original version marker', async () => {
    for (const original of legacyFixtures.filter(row => row.entityType === 'board')) {
      const fixture = { ...original, fields: { ...original.fields, symbol: original.deleted ? '' : 'book.fill' } };
      if (!original.deleted) expect((await legacy(original)).kind).toBe('invalid');
      const old = await h.db.withExclusiveTransactionAsync(tx => validateInboundRecord(tx, fixture));
      expect(old.kind).toBe('valid');
      if (old.kind !== 'valid') throw new Error('valid fixture required');
      expect(old.record.fields.kind).toBeUndefined();
      expect(await legacy(fixture)).toEqual({ kind: 'valid', record: { ...old.record, fields: {
        ...old.record.fields, kind: 'count', anchor_relation: null, anchor_kind: null,
        anchor_board_id: null, anchor_preset: null, anchor_text: null, usual_time_minute: null,
        required_in_stack: fixture.deleted ? 0 : 1, earns_coins: 0, coin_cap_per_day: 1,
      } } });
    }
    const oldSettings = legacyFixtures.find(row => row.entityType === 'settings')!;
    expect((await legacy(oldSettings)).kind).toBe('invalid');
    const settings = { ...oldSettings, fields: { metrics_education_dismissed: JSON.stringify([parentId]) } };
    expect(await legacy(settings)).toMatchObject({ kind: 'valid', record: { schemaVersion: 1, fields: {
      wake_minute: 420, lunch_minute: 720, dinner_minute: 1080, sleep_minute: 1380,
    } } });
    const oldCheck = legacyFixtures.find(row => row.entityType === 'check_in' && !row.deleted)!;
    expect((await legacy(oldCheck)).kind).toBe('deferred');
    expect((await legacy({ ...oldCheck, fields: { ...oldCheck.fields, board_id: parentId } })).kind).toBe('invalid');
    const current = record('board');
    expect((await h.db.withExclusiveTransactionAsync(tx => validateInboundRecord(tx, current))).kind).toBe('invalid');
    expect((await legacy(current)).kind).toBe('invalid');
  });

  it('requires consistent v2 mutable deletion markers without changing legacy behavior', async () => {
    for (const type of ['board', 'check_in', 'reminder', 'activity_period', 'reward']) {
      const live = record(type);
      expect((await validate({ ...live, deleted: true })).kind).toBe('invalid');
      expect((await validate({ ...live, fields: { ...live.fields, deleted_at: 2 } })).kind).toBe('invalid');
    }
    const old = { ...legacyFixtures[0], deleted: true };
    expect((await legacy(old)).kind).toBe('valid');
  });

  it('refuses missing new fields rather than inventing legacy defaults', async () => {
    for (const [type, key] of [['board', 'kind'], ['board', 'anchor_text'], ['board', 'coin_cap_per_day'],
      ['settings', 'wake_minute'], ['reward', 'cost_coins']]) {
      const value = record(type); delete value.fields[key];
      expect((await validate(value)).kind).toBe('invalid');
    }
  });

  it('preserves raw board anchors, defers missing identities and accepts existing tombstoned targets', async () => {
    const anchor = record('board', { anchor_kind: 'board', anchor_board_id: missingId, anchor_preset: null });
    expect(await validate(anchor)).toEqual({ kind: 'deferred', record: anchor });
    anchor.entityId = missingId;
    anchor.fields.id = missingId;
    anchor.fields.anchor_board_id = parentId;
    await h.db.runAsync('UPDATE boards SET deleted_at = 8 WHERE id = ?', [parentId]);
    expect(await validate(anchor)).toEqual({ kind: 'valid', record: anchor });
  });

  it.each([['existing', parentId], ['new', missingId]])(
    'rejects a %s board self-anchor before parent lookup while retaining the exact invalid record', async (_, ownerId) => {
      const input = record('board', { id: ownerId, anchor_kind: 'board', anchor_board_id: ownerId, anchor_preset: null });
      input.entityId = ownerId;
      const before = await h.db.getAllAsync('SELECT * FROM boards ORDER BY id');
      expect(await validate(input)).toEqual({ kind: 'invalid', record: input });
      expect(await h.db.getAllAsync('SELECT * FROM boards ORDER BY id')).toEqual(before);
    });

  it('does not grant malformed anchor metadata or a mismatched owner identity a valid topology exception', async () => {
    for (const fields of [
      { id: missingId, anchor_board_id: missingId },
      { id: parentId, anchor_board_id: parentId, anchor_relation: 'during' },
      { id: parentId, anchor_board_id: missingId, anchor_text: 'unused target' },
    ]) {
      const input = record('board', { anchor_kind: 'board', anchor_preset: null, ...fields });
      expect(await validate(input)).toEqual({ kind: 'invalid', record: input });
    }
  });
});


describe('schema-2 inherited and extended boundaries', () => {
  it.each([
    { kind: 'weekly' }, { kind: null }, { required_in_stack: 2 }, { required_in_stack: null },
    { earns_coins: 2 }, { earns_coins: null }, { coin_cap_per_day: null }, { coin_cap_per_day: 0 },
    { coin_cap_per_day: 11 }, { coin_cap_per_day: 1.5 }, { coin_cap_per_day: '1' },
    { kind: 'daily', tracks_amount: 1, tracks_time: 0 }, { kind: 'daily', tracks_amount: 0, tracks_time: 1 },
    { usual_time_minute: 1 }, { usual_time_minute: 1440 }, { usual_time_minute: -15 }, { usual_time_minute: '0' },
    { anchor_kind: 'unsupported' }, { anchor_relation: 'during' }, { anchor_preset: 'brunch' },
    { anchor_kind: 'board', anchor_board_id: 'bad', anchor_preset: null },
    { anchor_kind: 'text', anchor_text: '   ', anchor_preset: null },
    { anchor_kind: 'text', anchor_text: ' padded ', anchor_preset: null },
    { anchor_kind: 'text', anchor_text: 'x'.repeat(81), anchor_preset: null },
    { anchor_kind: null }, { anchor_board_id: parentId }, { anchor_text: 'unused target' },
  ])('rejects unsupported or inconsistent board metadata %j', async fields => {
    expect((await validate(record('board', fields))).kind).toBe('invalid');
  });

  it('preserves each supported raw anchor, quarter-hour endpoint and daily/off configuration', async () => {
    const empty = { anchor_kind: null, anchor_relation: null, anchor_board_id: null, anchor_preset: null, anchor_text: null };
    const fields = [empty,
      { ...empty, anchor_kind: 'board', anchor_relation: 'before', anchor_board_id: parentId },
      { ...empty, anchor_kind: 'text', anchor_relation: 'after', anchor_text: '\u0085Café' },
      ...['wake', 'lunch', 'dinner', 'sleep'].map(anchor_preset => ({ ...empty, anchor_kind: 'preset', anchor_relation: 'before', anchor_preset })),
    ];
    for (const anchor of fields) for (const usual_time_minute of [null, 0, 15, 1425]) {
      const value = record('board', { ...anchor, kind: 'daily', tracks_amount: 0, tracks_time: 0,
        earns_coins: 0, required_in_stack: 0, coin_cap_per_day: 10, usual_time_minute });
      value.entityId = missingId;
      value.fields.id = missingId;
      expect(await validate(value)).toEqual({ kind: 'valid', record: value });
    }
  });

  it('validates each preset independently without losing midnight or accepting a null default', async () => {
    for (const key of ['wake_minute', 'lunch_minute', 'dinner_minute', 'sleep_minute']) {
      for (const minute of [0, 15, 1425]) {
        const value = record('settings', { [key]: minute });
        expect(await validate(value)).toEqual({ kind: 'valid', record: value });
      }
      for (const minute of [null, '0', -15, 1, 1440]) expect((await validate(record('settings', { [key]: minute }))).kind).toBe('invalid');
    }
    expect((await validate(record('settings', { metrics_education_dismissed: '["bad"]' }))).kind).toBe('invalid');
    expect((await validate({ ...record('settings'), deleted: true })).kind).toBe('invalid');
  });

  it.each([
    { id: missingId }, { title: ' ' }, { title: '\ud800' }, { title: 'x'.repeat(81) },
    { cost_coins: null }, { cost_coins: '1' }, { cost_coins: 0 }, { cost_coins: 100001 }, { cost_coins: 1.5 },
    { symbol: null }, { symbol: 'book' }, { accent_hex: null }, { accent_hex: 'bad' },
    { order_key: null }, { order_key: 'Upper' }, { created_at: -1 }, { created_at: 0.5 },
    { updated_at: Number.MAX_SAFE_INTEGER + 1 }, { updated_at: null }, { archived_at: -1 }, { archived_at: 0.5 },
  ])('rejects unsupported reward state before persistence %j', async fields => {
    expect((await validate(record('reward', fields))).kind).toBe('invalid');
  });

  it('uses reward normalization and schema-safe timestamp endpoints with independent archive state', async () => {
    const input = record('reward', { title: '  Cafe\u0301  ', accent_hex: '#aabbcc', cost_coins: 100000,
      created_at: 0, updated_at: Number.MAX_SAFE_INTEGER, archived_at: 0 });
    expect(await validate(input)).toEqual({ kind: 'valid', record: { ...input, fields: { ...input.fields,
      title: 'Cafe\u0301', accent_hex: '#AABBCC' } } });
    const tombstone = { ...input, deleted: true, fields: { ...input.fields, deleted_at: 1,
      title: 'secret', cost_coins: -9, symbol: 'secret', accent_hex: 'secret', archived_at: -5 } };
    expect(await validate(tombstone)).toEqual({ kind: 'valid', record: { ...tombstone, fields: {
      ...tombstone.fields, ...{ title: '', cost_coins: 1, symbol: '', accent_hex: '', archived_at: null } } } });
    expect((await validate({ ...tombstone, fields: { ...tombstone.fields, deleted_at: 1.5 } })).kind).toBe('invalid');
  });

  it('preserves reversed period endpoints and inherited fractional timing metadata', async () => {
    const period = record('activity_period', { end_date: '2026-07-31' });
    expect(await validate(period)).toEqual({ kind: 'valid', record: period });
    const check = record('check_in', { occurred_at_utc: -2208988800000.5, time_zone_id: 'Europe/Paris', offset_minutes: 9.35 });
    expect(await validate(check)).toEqual({ kind: 'valid', record: check });
    const board = record('board', { created_at: 1.5, updated_at: -1.5 });
    expect(await validate(board)).toEqual({ kind: 'valid', record: board });
  });

  it('reuses inherited calendar, rule and idempotency validation while preserving a missing child parent', async () => {
    for (const [type, fields] of [['check_in', { logical_date: '2026-02-30' }],
      ['check_in', { idempotency_key: 'bad' }], ['reminder', { minute_of_day: 1440 }],
      ['activity_period', { start_date: '2026-08-02' }]] as const) {
      expect((await validate(record(type, fields))).kind).toBe('invalid');
    }
    const child = record('check_in', { board_id: missingId });
    expect(await validate(child)).toEqual({ kind: 'deferred', record: child });
    await h.db.runAsync('UPDATE boards SET deleted_at = 8 WHERE id = ?', [parentId]);
    expect((await validate(record('check_in'))).kind).toBe('valid');
    expect((await validate(record('reminder'))).kind).toBe('valid');
  });

  it('rejects a real locally owned idempotency key while permitting the same check identity', async () => {
    const commandId = h.ids.nextCommandId();
    const result = await createCheckIn(h.deps, { boardId: parentId as BoardId, commandId, source: 'app' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('local check required');
    const input = record('check_in', { idempotency_key: commandId });
    expect((await validate(input)).kind).toBe('invalid');
    input.entityId = result.value.checkInId; input.fields.id = result.value.checkInId;
    expect(await validate(input)).toEqual({ kind: 'valid', record: input });
  });

  it('strips all v2 tombstone private metadata while keeping exact structural dates and stamps', async () => {
    for (const type of ['board', 'check_in', 'reminder', 'activity_period']) {
      const fixture = fixtures.find(row => row.entityType === type && row.deleted)!;
      const input = { ...fixture, fields: { ...fixture.fields } };
      const secretKeys = type === 'board' ? ['title', 'symbol', 'accent_hex', 'amount_unit', 'anchor_text', 'anchor_kind', 'anchor_relation', 'anchor_preset', 'anchor_board_id']
        : type === 'check_in' ? ['note', 'logical_date', 'time_zone_id', 'source', 'idempotency_key']
          : type === 'reminder' ? ['message'] : ['end_date'];
      for (const key of secretKeys) (input.fields as Record<string, unknown>)[key] = 'private';
      expect(await validate(input)).toEqual({ kind: 'valid', record: fixture });
    }
  });

  it('rejects untrusted identities and exact-fieldset/scalar violations without parent reads', async () => {
    const inputs = [null, [], { ...record('reward'), entityId: 'bad' }, { ...record('settings'), entityId: parentId },
      { ...record('board'), mutationStamp: 'bad' }, { ...record('board'), entityType: 'habit_action' },
      { ...record('activity_period'), entityId: missingId }];
    for (const input of inputs) expect(await validate(input)).toEqual({ kind: 'unidentifiable' });
    const invalid = [
      { ...record('board'), schemaVersion: 1 }, { ...record('board'), schemaVersion: 3 },
      { ...record('board'), deleted: 0 }, { ...record('board'), fields: null },
      { ...record('board'), fields: [] }, { ...record('board'), extra: null },
      ...[undefined, true, {}, NaN, Infinity].map(value => record('board', { kind: value })),
      record('board', { extra: 'retained invalid' }),
    ];
    const reads = jest.spyOn(h.db, 'getFirstAsync');
    for (const input of invalid) expect((await validate(input)).kind).toBe('invalid');
    expect(reads).not.toHaveBeenCalled();
    expect(await legacy(null)).toEqual({ kind: 'unidentifiable' });
  });

  it.each([false, true])('captures caller fields before deferred SQL, legacy=%s', async old => {
    const input = record('check_in'); input.schemaVersion = old ? 1 : 2;
    const expected = structuredClone(input);
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const released = new Promise<void>(done => { release = done; });
    const first = h.db.getFirstAsync.bind(h.db);
    jest.spyOn(h.db, 'getFirstAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM boards')) { enter(); await released; }
      return first(sql, params);
    });
    const writes = jest.spyOn(h.db, 'runAsync');
    const pending = old ? legacy(input) : validate(input);
    await entered;
    input.fields.source = 'corrupt'; input.fields.board_id = missingId; input.fields.note = 'replacement';
    input.mutationStamp = 'changed'; input.schemaVersion = old ? 2 : 1;
    release();
    expect(await pending).toEqual({ kind: 'valid', record: expected });
    expect(writes).not.toHaveBeenCalled();
  });
});
