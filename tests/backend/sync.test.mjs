import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { api } from '../../snapback/generated/api.ts';

test('private sync preserves changes and immutable variants', { timeout: 120_000 }, async t => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const clients = [];
  const account = async () => {
    const result = await signup(host.url, `${randomUUID()}@example.test`, randomUUID());
    assert.equal(result.ok, true);
    const client = createClient({ url: host.url, session: result.session });
    clients.push(client);
    return client;
  };
  const sent = async promise => {
    const result = await promise;
    assert.equal(result.state, 'sent', JSON.stringify(result.why));
    return result.result;
  };
  const read = async (client, after = 0) => {
    const result = await client.query(api.changes, { after });
    assert.ok(!('denied' in result), result.denied?.code);
    assert.equal(result.complete, true);
    return result.data;
  };
  const record = (overrides = {}) => ({
    entityType: 'board', entityId: randomUUID(), schemaVersion: 2,
    mutationStamp: '01790000000000-00001-device-a', deleted: false,
    payload: JSON.stringify({ title: 'Read' }), body: null, ...overrides,
    digest: createHash('sha256').update(overrides.payload ?? JSON.stringify({ title: 'Read' })).digest('hex'),
  });
  try {
    const alice = await account(), bob = await account();
    await t.test('accounts are isolated and uploads require initialization', async () => {
      const before = await alice.mutate(api.uploadRecord, record());
      assert.equal(before.state, 'failed');
      await sent(alice.mutate(api.ensureAccount, {}));
      await sent(bob.mutate(api.ensureAccount, {}));
      assert.deepEqual(await read(alice), []);
      const row = await sent(alice.mutate(api.uploadRecord, record()));
      assert.equal((await read(alice)).length, 1);
      assert.deepEqual(await read(bob), []);
      assert.equal(row.revision, 1);
    });
    await t.test('replays do not advance the cursor and old writes cannot win', async () => {
      const first = record();
      const saved = await sent(alice.mutate(api.uploadRecord, first));
      const replay = await sent(alice.mutate(api.uploadRecord, first));
      assert.equal(replay.revision, saved.revision);
      const newer = record({ ...first, mutationStamp: '01790000000001-00000-device-b', payload: '{"title":"Write"}' });
      const updated = await sent(alice.mutate(api.uploadRecord, newer));
      assert.ok(updated.revision > saved.revision);
      const stale = await sent(alice.mutate(api.uploadRecord, first));
      assert.equal(stale.payload, newer.payload);
      assert.equal(stale.revision, updated.revision);
      const invalid = await alice.mutate(api.uploadRecord, record({ ...newer, payload: '{"title":"Ambiguous"}' }));
      assert.equal(invalid.state, 'failed');
      assert.equal(invalid.why.code, 'STAMP_CONFLICT');
      const changed = await read(alice, saved.revision);
      assert.equal(changed.length, 1);
      assert.equal(changed[0].payload, newer.payload);
    });
    await t.test('conflicting immutable evidence is retained for local admission', async () => {
      const fact = record({ entityType: 'habit_action', payload: '{"kind":"complete"}' });
      const first = await sent(alice.mutate(api.uploadRecord, fact));
      const second = await sent(alice.mutate(api.uploadRecord, record({ ...fact, payload: '{"kind":"undo"}' })));
      assert.notEqual(second.id, first.id);
      assert.equal((await read(alice, first.revision - 1)).length, 2);
      const replay = await sent(alice.mutate(api.uploadRecord, fact));
      assert.equal(replay.id, first.id);
      const deleted = await alice.mutate(api.uploadRecord, { ...fact, deleted: true });
      assert.equal(deleted.state, 'failed');
    });
    await t.test('large records verify every part before accepting a content identity', async () => {
      const payload = JSON.stringify({ provenance: 'a'.repeat(1_100_000) });
      const parts = payload.match(/.{1,8192}/gs);
      const hash = value => createHash('sha256').update(value).digest('hex');
      const digest = parts.reduce((root, part) => hash(root + hash(part)), '');
      const upload = await sent(alice.mutate(api.beginUpload, { key: digest, partCount: parts.length }));
      const unfinished = await alice.mutate(api.uploadRecord, { ...record({ payload: '' }), body: upload.id, digest });
      assert.equal(unfinished.state, 'failed');
      for (let offset = 0; offset < parts.length; offset += 4) {
        await Promise.all(parts.slice(offset, offset + 4).map((part, index) => sent(alice.mutate(api.uploadPart, {
          upload: upload.id, position: offset + index, payload: part,
        }))));
      }
      await sent(alice.mutate(api.finishUpload, { upload: upload.id }));
      const row = await sent(alice.mutate(api.uploadRecord, {
        ...record({ payload: '' }), body: upload.id, digest,
      }));
      assert.equal(row.body, upload.id);
      assert.equal(row.payload, '');
      const forged = await alice.mutate(api.uploadRecord, { ...record({ payload: '' }), body: upload.id, digest: '0'.repeat(64) });
      assert.equal(forged.state, 'failed');
      const forbidden = await bob.query(api.bodyParts, { upload: upload.id, after: 0 });
      assert.equal(forbidden.data?.length ?? 0, 0);
      const replay = await sent(alice.mutate(api.beginUpload, { key: digest, partCount: parts.length }));
      assert.equal(replay.id, upload.id);
      const replaced = await alice.mutate(api.uploadPart, { upload: upload.id, position: 0, payload: 'wrong' });
      assert.equal(replaced.state, 'failed');
      const wrong = await sent(alice.mutate(api.beginUpload, { key: '0'.repeat(64), partCount: 2 }));
      await sent(alice.mutate(api.uploadPart, { upload: wrong.id, position: 0, payload: 'a'.repeat(8192) }));
      await sent(alice.mutate(api.uploadPart, { upload: wrong.id, position: 1, payload: 'wrong' }));
      const finish = await alice.mutate(api.finishUpload, { upload: wrong.id });
      assert.equal(finish.state, 'failed');
    });
    await t.test('payload representation and part boundaries are canonical', async () => {
      const one = await alice.mutate(api.beginUpload, { key: '1'.repeat(64), partCount: 1 });
      assert.equal(one.state, 'failed');
      const upload = await sent(alice.mutate(api.beginUpload, { key: '2'.repeat(64), partCount: 2 }));
      const short = await alice.mutate(api.uploadPart, { upload: upload.id, position: 0, payload: 'ab' });
      assert.equal(short.state, 'failed');
      assert.equal(short.why.code, 'NON_CANONICAL_PART');
      const empty = await alice.mutate(api.uploadPart, { upload: upload.id, position: 1, payload: '' });
      assert.equal(empty.state, 'failed');
      const long = await alice.mutate(api.uploadRecord, record({ payload: 'a'.repeat(8193) }));
      assert.equal(long.state, 'failed');
    });
    await t.test('malformed clock stamps cannot poison newer edits', async () => {
      for (const mutationStamp of ['z'.repeat(22), '01790000000000-zzzz!-device', '01790000000000-00001-device.']) {
        const result = await alice.mutate(api.uploadRecord, record({ mutationStamp }));
        assert.equal(result.state, 'failed');
        assert.equal(result.why.code, 'INVALID_STAMP');
      }
    });
    await t.test('profile edits cannot reset the change sequence', async () => {
      const before = await sent(alice.mutate(api.uploadRecord, record()));
      await sent(alice.mutate(api.saveProfile, { name: 'Alice' }));
      const after = await sent(alice.mutate(api.uploadRecord, record()));
      assert.ok(after.revision > before.revision);
    });
    await t.test('pagination cannot skip tied or concurrent changes', async () => {
      for (let offset = 0; offset < 205; offset += 5) {
        await Promise.all(Array.from({ length: 5 }, () => sent(bob.mutate(api.uploadRecord, record()))));
      }
      const page = await read(bob);
      assert.equal(page.length, 200);
      await sent(bob.mutate(api.uploadRecord, record()));
      const next = await read(bob, page.at(-1).revision);
      assert.equal(next.length, 6);
      const all = [...page, ...next];
      assert.equal(new Set(all.map(row => row.revision)).size, 206);
      assert.deepEqual(await read(bob, all.at(-1).revision), []);
    });
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await host.stop();
  }
});
