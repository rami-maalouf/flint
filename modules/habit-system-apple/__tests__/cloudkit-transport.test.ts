import { requireOptionalNativeModule } from 'expo';

import { toSyncRecord } from '../../../src/core/sync/records';
import { canonicalCoinPolicy } from '../../../src/core/domain/coin-policy';
import { canonicalHabitAction, validateHabitAction, type HabitAction } from '../../../src/core/domain/habit-actions';
import type { SyncRecord } from '../../../src/core/sync/transport';
import fixtures from '../tests/CloudKit/sync-records.json';
import schema2Fixtures from '../tests/CloudKit/sync-records-v2.json';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));

type Adapter = typeof import('../../../src/platform/sync/index.ios');
const records = fixtures as unknown as SyncRecord[];

function loadAdapter(native: object | null): Adapter {
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  let adapter: Adapter;
  jest.isolateModules(() => {
    adapter = jest.requireActual<Adapter>('../../../src/platform/sync/index.ios');
  });
  return adapter!;
}

function native() {
  return {
    cloudKitAvailable: jest.fn().mockResolvedValue(true),
    cloudKitEnsureZone: jest.fn().mockResolvedValue(undefined),
    cloudKitUpload: jest.fn().mockResolvedValue(undefined),
    cloudKitFetchChanges: jest.fn().mockResolvedValue(JSON.stringify({ records, nextToken: 'opaque', more: false })),
  };
}

describe('cloudkit transport bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shares fixtures that match the typescript record mapping, including all tombstones', () => {
    expect(records).toHaveLength(9);
    for (const record of records) {
      expect(toSyncRecord(record.entityType, record.entityId, record.mutationStamp, record.fields)).toEqual(record);
    }
  });

  it.each([null, {}, { cloudKitAvailable: jest.fn().mockResolvedValue(true) }])(
    'keeps older binaries unavailable: %p', async (module) => {
      const adapter = loadAdapter(module);
      await expect(adapter.cloudKitAvailable()).resolves.toBe(false);
      await expect(adapter.cloudKitTransport.ensureZone()).rejects.toMatchObject({ code: 'unavailable' });
      await expect(adapter.cloudKitTransport.upload(records)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(adapter.cloudKitTransport.fetchChanges(null)).rejects.toMatchObject({ code: 'unavailable' });
    },
  );

  it('checks runtime availability without caching account state', async () => {
    const module = native();
    const adapter = loadAdapter(module);
    await expect(adapter.cloudKitAvailable()).resolves.toBe(true);
    module.cloudKitAvailable.mockResolvedValue(false);
    await expect(adapter.cloudKitAvailable()).resolves.toBe(false);
    module.cloudKitAvailable.mockRejectedValue(new Error('private account details'));
    await expect(adapter.cloudKitAvailable()).resolves.toBe(false);
  });

  it('forwards uploads and opaque page tokens through the unchanged port', async () => {
    const module = native();
    const { cloudKitTransport } = loadAdapter(module);
    await cloudKitTransport.ensureZone();
    await cloudKitTransport.upload(records);
    expect(JSON.parse(module.cloudKitUpload.mock.calls[0][0])).toEqual(records);
    await expect(cloudKitTransport.fetchChanges('previous')).resolves.toEqual({ records, nextToken: 'opaque', more: false });
    expect(module.cloudKitFetchChanges).toHaveBeenCalledWith('previous');
  });

  it.each(['offline', 'signed_out', 'unavailable', 'failure', 'unknown']) (
    'sanitizes the native failure %s', async (code) => {
      const module = native();
      module.cloudKitEnsureZone.mockRejectedValue({ code, message: 'private cloudkit record and account data' });
      const adapter = loadAdapter(module);
      const error = await adapter.cloudKitTransport.ensureZone().catch((cause) => cause);
      expect(error).toMatchObject({ code: code === 'unknown' ? 'failure' : code });
      expect(error.message).not.toMatch(/private|record and account/);
    },
  );

  it.each([
    'not-json', 'null', '{}',
    JSON.stringify({ records: [], nextToken: null, more: true }),
    JSON.stringify({ records: [], nextToken: 'previous', more: true }),
    JSON.stringify({ records: [{ ...records[0], fields: { note: {} } }], nextToken: 'next', more: false }),
  ])('rejects malformed pages without returning a token: %s', async (response) => {
    const module = native();
    module.cloudKitFetchChanges.mockResolvedValue(response);
    await expect(loadAdapter(module).cloudKitTransport.fetchChanges('previous')).rejects.toMatchObject({ code: 'failure' });
  });
});

describe('paired schema-2 transport boundary', () => {
  const rowBytes = 6 * 786432 + 8192;
  const tokenBytes = 1048576;
  const page = (records: unknown[], nextToken: string | null = 'next', more = false) => JSON.stringify({ records, nextToken, more });
  beforeEach(() => jest.clearAllMocks());

  it('roundtrips all eight v2 types through the active default adapter and preserves v1 inputs', async () => {
    const module = native(); module.cloudKitFetchChanges.mockResolvedValue(page(schema2Fixtures));
    const adapter = loadAdapter(module);
    await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).resolves.toEqual({ records: schema2Fixtures, nextToken: 'next', more: false });
    await adapter.schema2CloudKitTransport.upload(schema2Fixtures as never);
    expect(JSON.parse(module.cloudKitUpload.mock.calls[0][0])).toEqual(schema2Fixtures);
    await expect(adapter.cloudKitTransport.fetchChanges(null)).resolves.toEqual({ records: schema2Fixtures, nextToken: 'next', more: false });
    module.cloudKitUpload.mockClear();
    await adapter.cloudKitTransport.upload(schema2Fixtures as never);
    expect(JSON.parse(module.cloudKitUpload.mock.calls[0][0])).toEqual(schema2Fixtures);
    module.cloudKitFetchChanges.mockResolvedValue(page(records));
    await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).resolves.toMatchObject({ records });
  });

  it('retains immutable diagnostic bodies without repairing stamp, IDs, deletion or missing fields', async () => {
    const value = structuredClone(schema2Fixtures.find(row => row.entityType === 'habit_action')!);
    value.mutationStamp = ''; value.deleted = true;
    value.fields = { id: 'different inner id', extra: 'Cafe\u0301', created_at: -0 } as never;
    const json = page([value]).replace('"created_at":0', '"created_at":-0');
    const module = native(); module.cloudKitFetchChanges.mockResolvedValue(json);
    const result = await loadAdapter(module).schema2CloudKitTransport.fetchChanges('old');
    expect(result.records[0]).toEqual(value);
    expect(Object.is(result.records[0].fields.created_at, -0)).toBe(true);
  });

  it.each([
    { schemaVersion: 3 }, { schemaVersion: 1, entityType: 'habit_action' }, { entityType: 'receipt' },
    { entityId: '' }, { entityId: 'x'.repeat(256) }, { entityId: 'not-a-uuid', entityType: 'ledger_entry' },
    { mutationStamp: null }, { deleted: 1 }, { fields: [] }, { fields: null }, { fields: { nested: {} } },
    { fields: { flag: true } }, { extra: 'must not disappear' },
  ])('rejects unretainable v2 envelope/scalar defects %j without returning the token', async change => {
    const module = native(); module.cloudKitFetchChanges.mockResolvedValue(page([{ ...schema2Fixtures[0], ...change }]));
    await expect(loadAdapter(module).schema2CloudKitTransport.fetchChanges('old')).rejects.toMatchObject({ code: 'failure' });
  });

  it('requires exact page shape, finite scalar values and token progress', async () => {
    const module = native(); const adapter = loadAdapter(module);
    for (const response of [null, {}, '[]', JSON.stringify({ records: [], nextToken: null, more: false, extra: 1 }),
      page([], null, true), page([], 'old', true), page([{ ...schema2Fixtures[0], fields: { x: 0 } }]).replace('"x":0', '"x":1e400')]) {
      module.cloudKitFetchChanges.mockResolvedValue(response);
      await expect(adapter.schema2CloudKitTransport.fetchChanges('old')).rejects.toMatchObject({ code: 'failure' });
    }
  });

  it('bounds upload/page counts independently and permits exactly 200 records', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const values = Array.from({ length: 200 }, () => schema2Fixtures[0]);
    await adapter.schema2CloudKitTransport.upload(values as never);
    module.cloudKitFetchChanges.mockResolvedValue(page(values));
    expect((await adapter.schema2CloudKitTransport.fetchChanges(null)).records).toHaveLength(200);
    module.cloudKitUpload.mockClear(); values.push(schema2Fixtures[0]);
    await expect(adapter.schema2CloudKitTransport.upload(values as never)).rejects.toMatchObject({ code: 'failure' });
    expect(module.cloudKitUpload).not.toHaveBeenCalled();
    module.cloudKitFetchChanges.mockResolvedValue(page(values));
    await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).rejects.toMatchObject({ code: 'failure' });
  });

  it('measures actual encoded row UTF-8 bytes including escapes at equality and plus one', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const value = { ...schema2Fixtures[0], fields: { diagnostic: '\u0001é水🧭\ud800a\udc00' } };
    const remaining = rowBytes - Buffer.byteLength(JSON.stringify(value));
    value.fields.diagnostic += 'a'.repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(rowBytes);
    module.cloudKitFetchChanges.mockResolvedValue(page([value]));
    expect((await adapter.schema2CloudKitTransport.fetchChanges(null)).records[0]).toEqual(value);
    value.fields.diagnostic += 'a';
    module.cloudKitFetchChanges.mockResolvedValue(page([value]));
    await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).rejects.toMatchObject({ code: 'failure' });
    await expect(adapter.schema2CloudKitTransport.upload([value] as never)).rejects.toMatchObject({ code: 'failure' });
    expect(module.cloudKitUpload).not.toHaveBeenCalled();
  });

  it('preserves the one MiB token allowance on empty pages and rejects overlong caller tokens before native work', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const token = 'é'.repeat(tokenBytes / 2);
    module.cloudKitFetchChanges.mockResolvedValue(page([], token));
    expect((await adapter.schema2CloudKitTransport.fetchChanges(null)).nextToken).toBe(token);
    await adapter.schema2CloudKitTransport.fetchChanges(token);
    expect(module.cloudKitFetchChanges).toHaveBeenLastCalledWith(token);
    module.cloudKitFetchChanges.mockClear();
    await expect(adapter.schema2CloudKitTransport.fetchChanges(token + 'a')).rejects.toMatchObject({ code: 'failure' });
    expect(module.cloudKitFetchChanges).not.toHaveBeenCalled();
    module.cloudKitFetchChanges.mockResolvedValue(page([], token + 'a'));
    await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).rejects.toMatchObject({ code: 'failure' });
  });

  it('rejects oversized raw stamp and field strings before creating encoded row copies', async () => {
    const module = native(); const adapter = loadAdapter(module);
    for (const value of [
      { ...schema2Fixtures[0], mutationStamp: 'a'.repeat(rowBytes + 1) },
      { ...schema2Fixtures[0], fields: { value: 'a'.repeat(rowBytes + 1) } },
    ]) {
      await expect(adapter.schema2CloudKitTransport.upload([value] as never)).rejects.toMatchObject({ code: 'failure' });
      module.cloudKitFetchChanges.mockResolvedValue(page([value]));
      await expect(adapter.schema2CloudKitTransport.fetchChanges(null)).rejects.toMatchObject({ code: 'failure' });
    }
    expect(module.cloudKitUpload).not.toHaveBeenCalled();
  });

  it('captures each input field once before awaiting native and never serializes caller toJSON hooks', async () => {
    const module = native(); const adapter = loadAdapter(module);
    let release!: () => void;
    module.cloudKitUpload.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const value = structuredClone(schema2Fixtures[0]);
    const expected = structuredClone(value);
    const fields = jest.fn(() => value.fields);
    const input = { ...value }; Object.defineProperty(input, 'fields', { enumerable: true, get: fields });
    const pending = adapter.schema2CloudKitTransport.upload([input] as never);
    value.fields.title = 'changed'; input.mutationStamp = 'changed';
    release(); await pending;
    expect(fields).toHaveBeenCalledTimes(1);
    expect(JSON.parse(module.cloudKitUpload.mock.calls[0][0])).toEqual([expected]);
    module.cloudKitUpload.mockClear();
    const toJSON = jest.fn(() => expected);
    await expect(adapter.schema2CloudKitTransport.upload([{ ...expected, toJSON }] as never)).rejects.toMatchObject({ code: 'failure' });
    expect(toJSON).not.toHaveBeenCalled(); expect(module.cloudKitUpload).not.toHaveBeenCalled();
  });

  it('rejects immutable negative zero before JSON can silently turn it into an accepted zero', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const value = structuredClone(schema2Fixtures.find(row => row.entityType === 'habit_action')!);
    value.fields.created_at = -0;
    await expect(adapter.schema2CloudKitTransport.upload([value] as never)).rejects.toMatchObject({ code: 'failure' });
    expect(module.cloudKitUpload).not.toHaveBeenCalled();
  });

  it('retains a production-valid canonical maximum action with a near-limit escaped policy', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const value = structuredClone(schema2Fixtures.find(row => row.entityType === 'habit_action')!);
    const ids = Array.from({ length: 5035 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    const policyJson = canonicalCoinPolicy({ version: 1, boardKind: 'count', earnsCoins: true, coinCapPerDay: 1,
      checkClosesAtUtc: 1788926400000, rootId: ids[0], requiredBoardIds: ids, bonusClosesAtUtc: 1788926400000, bonusEnabled: true });
    expect(Buffer.byteLength(policyJson)).toBe(196589);
    value.fields.policy_json = policyJson;
    const action = { id: value.fields.id, commandId: value.fields.command_id, boardId: value.fields.board_id,
      logicalDate: value.fields.logical_date, checkInId: value.fields.check_in_id, kind: value.fields.kind,
      createdAt: value.fields.created_at, mutationStamp: value.mutationStamp, policyJson } as HabitAction;
    action.mutationStamp += 'a'.repeat(786432 - Buffer.byteLength(canonicalHabitAction(action)));
    expect(Buffer.byteLength(canonicalHabitAction(action))).toBe(786432);
    expect(validateHabitAction(action).ok).toBe(true);
    value.mutationStamp = action.mutationStamp;
    await adapter.schema2CloudKitTransport.upload([value] as never);
    const sent = module.cloudKitUpload.mock.calls[0][0];
    expect(JSON.parse(sent)).toEqual([value]);
    expect(sent).toContain('\\"requiredBoardIds\\"');
    module.cloudKitFetchChanges.mockResolvedValue(page([value]));
    expect((await adapter.schema2CloudKitTransport.fetchChanges(null)).records).toEqual([value]);
  });

  it('sanitizes thrown accessor and native error-code getter details', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const input = { ...schema2Fixtures[0] };
    Object.defineProperty(input, 'fields', { enumerable: true, get(): never { throw Error('private getter data'); } });
    const first = await adapter.schema2CloudKitTransport.upload([input] as never).catch(error => error);
    expect(first).toMatchObject({ code: 'failure' }); expect(first.message).not.toContain('private');
    module.cloudKitFetchChanges.mockRejectedValue({ get code(): never { throw Error('private account data'); } });
    const second = await adapter.schema2CloudKitTransport.fetchChanges(null).catch(error => error);
    expect(second).toMatchObject({ code: 'failure' }); expect(second.message).not.toContain('private');
  });

  it('captures indexed array entries without executing caller iterators or exceeding captured length', async () => {
    const module = native(); const adapter = loadAdapter(module);
    const values = [structuredClone(schema2Fixtures[0])];
    const iterator = jest.fn(function* () { yield* Array.from({ length: 201 }, () => schema2Fixtures[1]); });
    Object.defineProperty(values, Symbol.iterator, { value: iterator });
    await adapter.schema2CloudKitTransport.upload(values as never);
    expect(iterator).not.toHaveBeenCalled();
    expect(JSON.parse(module.cloudKitUpload.mock.calls[0][0])).toEqual([schema2Fixtures[0]]);
  });

  it('rejects malformed upload containers and preserves special scalar keys without prototype mutation', async () => {
    const module = native(); const adapter = loadAdapter(module);
    for (const value of [null, {}, [null], Array(1), [{ ...schema2Fixtures[0], fields: { value: undefined } }],
      [{ ...schema2Fixtures[0], fields: { value: Infinity } }]]) {
      await expect(adapter.schema2CloudKitTransport.upload(value as never)).rejects.toMatchObject({ code: 'failure' });
    }
    const value = structuredClone(schema2Fixtures.find(row => row.entityType === 'habit_action')!);
    Object.defineProperty(value.fields, '__proto__', { enumerable: true, value: 'retain diagnostic' });
    Object.defineProperty(value.fields, 'toJSON', { enumerable: true, value: 'plain scalar' });
    module.cloudKitFetchChanges.mockResolvedValue(page([value]));
    const result = (await adapter.schema2CloudKitTransport.fetchChanges(null)).records[0];
    expect(Object.hasOwn(result.fields, '__proto__')).toBe(true);
    expect(result.fields.__proto__).toBe('retain diagnostic');
    expect(Object.getPrototypeOf(result.fields)).toBe(Object.prototype);
    expect(result.fields.toJSON).toBe('plain scalar');
  });
});
