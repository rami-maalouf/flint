import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { logoutAll } from 'snapback4/auth';

import { derivedUuid } from '../src/tools/schemas.ts';
import { Credentials } from '../src/snapback.ts';
import { NodeSqlDatabase } from '../src/sqlite.ts';
import { createAccount, startBackend } from './helpers.ts';

test('transactions commit together, roll back together, and keep nul text intact', async () => {
  const db = new NodeSqlDatabase();
  await db.execAsync('CREATE TABLE notes (body TEXT NOT NULL)');
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('INSERT INTO notes VALUES (?)', ['before\0after']);
  });
  await assert.rejects(db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('INSERT INTO notes VALUES (?)', ['lost']);
    throw new Error('abort');
  }), /abort/);
  assert.deepEqual((await db.getAllAsync<{ body: string }>('SELECT body FROM notes')).map(row => row.body), ['before\0after']);
  // a failed transaction leaves the lane usable.
  assert.equal((await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM notes'))?.count, 1);
  await db.closeAsync();
  await assert.rejects(db.getAllAsync('SELECT 1'), /closed/);
});

test('derived ids are stable uuid v4 values scoped by every part', () => {
  const id = derivedUuid('claim_reward', 'op', 'ledger');
  assert.equal(id, derivedUuid('claim_reward', 'op', 'ledger'));
  assert.notEqual(id, derivedUuid('claim_reward', 'op'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('stored sessions are sealed, refresh near expiry, and are dropped when refused', async t => {
  const backendUrl = await startBackend(t);
  const account = await createAccount(backendUrl);
  const db = new DatabaseSync(':memory:');
  let now = Date.now();
  const credentials = new Credentials(db, 'x'.repeat(32), backendUrl, fetch, () => now);
  credentials.save('account', account.session);
  const stored = db.prepare('SELECT sealed FROM flint_accounts').get() as { sealed: Uint8Array };
  assert.ok(!Buffer.from(stored.sealed).toString('utf8').includes(account.session.token));
  assert.equal((await credentials.current('account'))?.token, account.session.token);
  // another key cannot open the session.
  assert.equal(new Credentials(db, 'y'.repeat(32), backendUrl).load('account'), null);

  now = account.session.expiresAt - 60 * 60 * 1000;
  const refreshed = await credentials.current('account');
  assert.ok(refreshed && refreshed.token !== account.session.token);
  now = Date.now();
  assert.equal((await credentials.current('account'))?.token, refreshed.token);

  await logoutAll(backendUrl, refreshed.token);
  now = refreshed.expiresAt - 60 * 60 * 1000;
  assert.equal(await credentials.current('account'), null);
  assert.equal(credentials.load('account'), null);
});

test('an outage during refresh keeps the session; only a refused credential is dropped', async t => {
  const backendUrl = await startBackend(t);
  const account = await createAccount(backendUrl);
  const outage: typeof fetch = async () => new Response('bad gateway', { status: 502 });
  const now = account.session.expiresAt - 60 * 60 * 1000;
  const credentials = new Credentials(new DatabaseSync(':memory:'), 'x'.repeat(32), backendUrl, outage, () => now);
  credentials.save('account', account.session);
  assert.equal((await credentials.current('account'))?.token, account.session.token);
  assert.equal(credentials.load('account')?.token, account.session.token);
  // a rate-limited refresh is retried later instead of signing the account out.
  const limited = new Credentials(new DatabaseSync(':memory:'), 'x'.repeat(32), backendUrl,
    async () => Response.json({ denied: { code: 'E_RATE_LIMIT', family: 'auth', retryable: true, message: 'slow down' } },
      { status: 429 }), () => now);
  limited.save('account', account.session);
  assert.equal((await limited.current('account'))?.token, account.session.token);
  // a newer sign-in is never removed by the failure of an older token.
  assert.equal(await credentials.deleteIfCurrent('account', 'older-token'), false);
  assert.ok(credentials.load('account'));
});
