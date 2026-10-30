import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { startDev } from 'snapback4/proof';
import { api } from '../../snapback/generated/api.ts';

test('Expo native with window.location can send persisted outbox writes while browsers retain admission guards', async () => {
  const host = await startDev({ args: ['--memory', '--no-watch', '--unsafe-dev-doors'] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let client;
  try {
    const account = await signup(host.url, `${randomUUID()}@example.test`, randomUUID());
    assert.ok(account.ok);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'habitsystemfullstack://' } } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { product: 'ReactNative' } });
    client = createClient({ url: host.url, token: account.session.token });
    assert.equal((await client.mutate(api.ensureAccount, {})).state, 'sent');
    await client.close();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { product: 'Gecko' } });
    client = createClient({ url: host.url, token: account.session.token });
    const refused = await client.mutate(api.ensureAccount, {});
    assert.equal(refused.state, 'failed');
    assert.equal(refused.why.code, 'E_ADMISSION');
  } finally {
    await client?.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    await host.stop();
  }
});
