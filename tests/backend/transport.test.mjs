import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { createSnapbackTransport } from '../../src/platform/backend/transport.ts';

test('the app transport survives retries and round-trips large Unicode records', { timeout: 120_000 }, async () => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  let client;
  try {
    const account = await signup(host.url, `${randomUUID()}@example.test`, randomUUID());
    assert.ok(account.ok);
    let offline = false;
    client = createClient({ url: host.url, session: account.session, fetch: (...args) => {
      if (offline) throw new TypeError('network unavailable');
      return fetch(...args);
    } });
    let current = true;
    const transport = createSnapbackTransport({
      connection: async () => ({ client, session: account.session, isCurrent: () => current }),
      bind: async () => {},
      hash: async value => createHash('sha256').update(value).digest('hex'),
    });
    await transport.ensureZone();
    const make = fields => ({
      entityType: 'board', entityId: randomUUID(), schemaVersion: 2,
      mutationStamp: '01790000000000-00001-device-a', deleted: false, fields,
    });
    const small = make({ title: 'Read' });
    const large = make({ note: 'a😀é'.repeat(180_000) });
    await transport.upload([small, large]);
    const first = await transport.fetchChanges(null);
    assert.deepEqual(first.records, [small, large]);
    assert.equal(first.more, false);
    await transport.upload([small, large]);
    const replay = await transport.fetchChanges(first.nextToken);
    assert.deepEqual(replay.records, []);
    offline = true;
    await assert.rejects(transport.upload([make({ title: 'Offline' })]), error => error.code === 'offline');
    offline = false;
    current = false;
    await assert.rejects(transport.fetchChanges(first.nextToken), error => error.code === 'signed_out');
  } finally {
    await client?.close();
    await host.stop();
  }
});
