import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { login, signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';

import { createCheckIn, setICloudSyncEnabled } from '@/core/domain/commands';
import { runSync } from '@/core/sync/engine';
import { createSnapbackTransport } from '../../src/platform/backend/transport';
import { api } from '../../snapback/generated/api';
import { createBoardForTest } from '../product/helpers/product-fixtures';
import { createTestHarness } from '../product/helpers/test-db';

test('two local databases converge after offline edits and transport restart without duplicating facts', async () => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const source = await createTestHarness();
  const destination = await createTestHarness();
  const clients = [];
  try {
    const account = await signup(host.url, `${randomUUID()}@example.test`, randomUUID());
    if (!account.ok) throw new Error('signup failed');
    let offline = false;
    const connect = () => {
      const client = createClient({ url: host.url, session: account.session, fetch: (...args) => {
        if (offline) throw new TypeError('offline');
        return fetch(...args);
      } });
      clients.push(client);
      return createSnapbackTransport({
        connection: async () => ({ client, session: account.session, isCurrent: () => true }),
        bind: async () => {}, hash: async value => createHash('sha256').update(value).digest('hex'),
      });
    };
    for (const harness of [source, destination]) {
      harness.ids.uuid = randomUUID;
      await harness.db.runAsync('UPDATE app_settings SET device_id = ? WHERE id = 1', [randomUUID()]);
      expect((await setICloudSyncEnabled(harness.deps, { commandId: harness.ids.nextCommandId(), enabled: true })).ok).toBe(true);
    }
    const boardId = await createBoardForTest(source, { title: 'Offline reading', earnsCoins: true });
    expect((await createCheckIn(source.deps, { commandId: source.ids.nextCommandId(), boardId,
      source: 'app', note: 'written offline' })).ok).toBe(true);
    let transport = connect();
    const sync = (harness, value = transport) => runSync({ ...harness.deps, transport: value, random: () => 0.5 });
    offline = true;
    expect(await sync(source)).toMatchObject({ ok: true, value: { status: 'offline' } });
    expect((await source.db.getAllAsync('SELECT * FROM mutation_outbox')).length).toBeGreaterThan(0);
    await clients[0].close();
    transport = connect();
    offline = false;
    source.clock.advanceMinutes(5);
    expect(await sync(source)).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(await sync(destination, connect())).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    for (const table of ['boards', 'habit_actions', 'coin_ledger']) {
      expect(await destination.db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`))
        .toEqual(await source.db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`));
    }
    const before = await destination.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    expect(await sync(destination)).toMatchObject({ ok: true, value: { uploaded: 0, applied: 0 } });
    expect(await destination.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(before);
    expect(await source.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await source.db.closeAsync(); await destination.db.closeAsync(); await host.stop();
  }
}, 120_000);

test('read-scoped bootstrap retains reconciliation without any transport mutation', async () => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const source = await createTestHarness();
  const destination = await createTestHarness();
  const clients = [];
  try {
    const email = `${randomUUID()}@example.test`, password = randomUUID();
    const full = await signup(host.url, email, password);
    if (!full.ok) throw new Error('synthetic signup failed');
    const sourceClient = createClient({ url: host.url, session: full.session });
    clients.push(sourceClient);
    const transportFor = (client, session) => createSnapbackTransport({
      connection: async () => ({ client, session, isCurrent: () => true }),
      bind: async () => {}, hash: async value => createHash('sha256').update(value).digest('hex'),
    });
    for (const h of [source, destination]) {
      h.ids.uuid = randomUUID;
      expect((await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true })).ok).toBe(true);
    }
    const boardId = await createBoardForTest(source, { title: 'Synthetic read-only bootstrap', kind: 'count' });
    expect(await runSync({ ...source.deps, transport: transportFor(sourceClient, full.session), random: () => 0.5 }))
      .toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    const checkId = randomUUID(), stamp = '01787760000000-00001-legacy';
    const legacy = { schemaVersion: 1, entityType: 'check_in', entityId: checkId, mutationStamp: stamp, deleted: false,
      fields: { id: checkId, board_id: boardId, logical_date: '2026-08-20', occurred_at_utc: null,
        time_zone_id: null, offset_minutes: null, amount: null, note: 'synthetic legacy note', source: 'app',
        idempotency_key: checkId, created_at: Date.UTC(2026, 7, 20), updated_at: Date.UTC(2026, 7, 20), deleted_at: null } };
    const payload = JSON.stringify(legacy);
    expect(await sourceClient.mutate(api.uploadRecord, { entityType: 'check_in', entityId: checkId, schemaVersion: 1,
      mutationStamp: stamp, deleted: false, payload, body: null, digest: createHash('sha256').update(payload).digest('hex') }))
      .toMatchObject({ state: 'sent' });
    const read = await login(host.url, email, password, { scope: 'read' });
    if (!read.ok) throw new Error('synthetic read login failed');
    const readClient = createClient({ url: host.url, session: read.session, readOnly: true });
    clients.push(readClient);
    expect(await readClient.mutate(api.ensureAccount, {})).toMatchObject({ state: 'failed' });
    const actual = transportFor(readClient, read.session);
    let mutations = 0;
    const readTransport = { fetchChanges: actual.fetchChanges,
      ensureZone: async () => { mutations++; throw new Error('read attempted account mutation'); },
      upload: async () => { mutations++; throw new Error('read attempted record mutation'); } };
    const sync = () => runSync({ ...destination.deps, transport: readTransport, mode: 'pull_only', random: () => 0.5 });
    expect(await sync()).toMatchObject({ ok: true, value: { status: 'up_to_date', uploaded: 0 } });
    expect(await destination.db.getAllAsync('SELECT id FROM check_ins WHERE id = ?', [checkId])).toEqual([{ id: checkId }]);
    const generated = await destination.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id');
    expect(generated.length).toBeGreaterThan(0);
    const queued = await destination.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id');
    expect(queued.length).toBeGreaterThan(0);
    expect(await sync()).toMatchObject({ ok: true, value: { status: 'up_to_date', uploaded: 0 } });
    expect(await destination.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id')).toEqual(queued);
    expect(mutations).toBe(0);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await source.db.closeAsync(); await destination.db.closeAsync(); await host.stop();
  }
}, 120_000);
