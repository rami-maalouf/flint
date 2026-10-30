import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';

import { createCheckIn, setICloudSyncEnabled } from '@/core/domain/commands';
import { runSync } from '@/core/sync/engine';
import { createSnapbackTransport } from '../../src/platform/backend/transport';
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
