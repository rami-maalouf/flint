import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { login, signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { api } from '../../snapback/generated/api.ts';

const genesis = '0'.repeat(64);
test('recovery heads enforce owner isolation and conditional monotonic advancement', { timeout: 120_000 }, async () => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const clients = [];
  const connect = session => {
    const client = createClient({ url: host.url, session }); clients.push(client); return client;
  };
  const account = async () => {
    const email = `${randomUUID()}@example.test`, password = randomUUID();
    const result = await signup(host.url, email, password);
    assert.equal(result.ok, true);
    return { client: connect(result.session), email, password };
  };
  const data = async promise => {
    const result = await promise;
    assert.ok(!('denied' in result)); assert.equal(result.complete, true); return result.data;
  };
  const sent = async promise => {
    const result = await promise; assert.equal(result.state, 'sent'); return result.result;
  };
  try {
    const alice = await account(), bob = await account();
    const generation = randomUUID();
    assert.equal(await data(alice.client.query(api.mcpRecoveryHead, {})), null);
    const initial = await sent(alice.client.mutate(api.initializeMcpRecoveryHead, { generation }));
    assert.equal(initial.sequence, 0); assert.equal(initial.headHash, genesis);
    assert.equal(await data(bob.client.query(api.mcpRecoveryHead, {})), null);
    assert.deepEqual(await sent(alice.client.mutate(api.initializeMcpRecoveryHead, { generation })), initial);
    assert.equal((await alice.client.mutate(api.initializeMcpRecoveryHead, { generation: randomUUID() })).state, 'failed');
    const advance = (client, expectedSequence, expectedHash, nextHash) => client.mutate(api.advanceMcpRecoveryHead,
      { generation, expectedSequence, expectedHash, nextHash });
    const head = await sent(advance(alice.client, 0, genesis, 'a'.repeat(64)));
    assert.equal(head.sequence, 1); assert.equal(head.headHash, 'a'.repeat(64));
    assert.equal((await advance(alice.client, 0, genesis, 'b'.repeat(64))).state, 'failed');
    assert.equal((await advance(bob.client, 1, head.headHash, 'c'.repeat(64))).state, 'failed');
    const race = await Promise.all([advance(alice.client, 1, head.headHash, 'b'.repeat(64)),
      advance(alice.client, 1, head.headHash, 'c'.repeat(64))]);
    assert.equal(race.filter(result => result.state === 'sent').length, 1);
    assert.equal(race.filter(result => result.state === 'failed').length, 1);
    const current = await data(alice.client.query(api.mcpRecoveryHead, {}));
    assert.equal(current.sequence, 2);
    assert.equal((await advance(alice.client, 1, head.headHash, current.headHash)).state, 'failed');
    assert.deepEqual(await data(alice.client.query(api.mcpRecoveryHead, {})), current);
    assert.equal((await alice.client.mutate(api.advanceMcpRecoveryHead,
      { generation: randomUUID(), expectedSequence: 2, expectedHash: current.headHash, nextHash: 'd'.repeat(64) })).state, 'failed');
    const read = await login(host.url, alice.email, alice.password, { scope: 'read' });
    assert.equal(read.ok, true);
    const reader = connect(read.session);
    assert.deepEqual(await data(reader.query(api.mcpRecoveryHead, {})), current);
    assert.equal((await advance(reader, 2, current.headHash, 'd'.repeat(64))).state, 'failed');
    assert.deepEqual(await data(alice.client.query(api.mcpRecoveryHead, {})), current);
    assert.deepEqual(await data(alice.client.query(api.changes, { after: 0 })), []);
  } finally {
    await Promise.all(clients.map(client => client.close())); await host.stop();
  }
});
