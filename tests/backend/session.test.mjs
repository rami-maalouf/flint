import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BackendSession } from '../../src/platform/backend/session.ts';
import { bindBackendAccount } from '../../src/platform/backend/account-binding.ts';
import { SyncTransportError } from '../../src/core/sync/transport.ts';

const session = { principal: 'account-a', kind: 'password', token: 'synthetic-token', expiresAt: Date.now() + 60_000 };
function port() {
  let saved = null;
  return {
    restore: async () => saved,
    authenticate: async () => ({ ok: true, session }),
    save: async value => { saved = value; },
    forget: async () => { saved = null; },
    revoke: async () => {},
    client: () => ({ close: async () => {} }),
  };
}
test('native session restoration needs no network and sign-out forgets the token', async () => {
  const auth = port();
  const first = new BackendSession(auth);
  let bound = false;
  await first.signIn('login', 'person@example.test', 'password', async () => { bound = true; });
  assert.ok(bound);
  const reopened = new BackendSession(auth);
  await reopened.restore();
  const connection = await reopened.connection();
  assert.equal(connection.session.principal, session.principal);
  auth.revoke = async () => { throw new Error('offline'); };
  await assert.rejects(reopened.signOut(), /signed out on this device/i);
  assert.equal(reopened.getSnapshot().session, null);
  assert.equal(connection.isCurrent(), false);
  assert.equal(await auth.restore(), null);
});
test('failed account binding never persists a new token', async () => {
  const auth = port();
  const manager = new BackendSession(auth);
  await assert.rejects(manager.signIn('signup', 'person@example.test', 'password', async () => {
    throw new SyncTransportError('signed_out', 'different account');
  }), /different account/);
  assert.equal(await auth.restore(), null);
  assert.equal(manager.getSnapshot().session, null);
});
test('expired sessions cannot start a sync', async () => {
  const auth = port();
  await auth.save({ ...session, expiresAt: 1 });
  const manager = new BackendSession(auth);
  await assert.rejects(manager.connection(), error => error.code === 'signed_out');
});
test('local account binding survives sign-out and rejects another principal or server', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE sync_account_bindings (provider TEXT PRIMARY KEY, account_digest TEXT NOT NULL)');
  const tx = {
    getFirstAsync: async (sql, args) => sqlite.prepare(sql).get(...args) ?? null,
    runAsync: async (sql, args) => sqlite.prepare(sql).run(...args),
  };
  const core = {
    db: { withExclusiveTransactionAsync: async callback => callback(tx) },
    hashing: { sha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) },
  };
  try {
    await bindBackendAccount(core, 'https://habits.example.test', session);
    await bindBackendAccount(core, 'https://habits.example.test/', session);
    await assert.rejects(bindBackendAccount(core, 'https://habits.example.test', { ...session, principal: 'account-b' }), /different account/);
    await assert.rejects(bindBackendAccount(core, 'https://other.example.test', session), /different account/);
    const row = sqlite.prepare('SELECT * FROM sync_account_bindings').get();
    assert.equal(row.provider, 'snapback4');
    assert.equal(row.account_digest.length, 64);
    assert.ok(!row.account_digest.includes(session.principal));
  } finally { sqlite.close(); }
});
