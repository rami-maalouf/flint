import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { forgetSession, keepSession, login, logout, memorySessionStore, restoreSession, signup, type Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';

import { api } from '../../../snapback/generated/api';
import { getProductCore, type ProductCore } from '../database/product-core';
import { bindBackendAccount } from './account-binding';
import { BackendSession } from './session';
import { createSnapbackTransport } from './transport';
import { observeRevisions } from './observation';

export const backendUrl = (process.env.EXPO_PUBLIC_SNAPBACK_URL ??
  'https://habits.ramimaalouf.com').replace(/\/+$/, '');
const address = new URL(backendUrl);
if (address.protocol !== 'https:' && !(address.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(address.hostname))) {
  throw new Error('Snapback requires an HTTPS URL outside local development.');
}
export const hashText = (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
const keyFor = async (key: string) => `snapback.${await hashText(key)}`;
const secureOptions = { keychainService: 'habit-system-fullstack', keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const sessionStore = Platform.OS === 'web' ? memorySessionStore() : {
  get: async (key: string) => SecureStore.getItemAsync(await keyFor(key), secureOptions),
  set: async (key: string, value: string) => SecureStore.setItemAsync(await keyFor(key), value, secureOptions),
  delete: async (key: string) => SecureStore.deleteItemAsync(await keyFor(key), secureOptions),
};

export const backendSession = new BackendSession({
  restore: () => restoreSession(backendUrl, sessionStore),
  authenticate: (mode, email, password) => mode === 'signup'
    ? signup(backendUrl, email, password) : login(backendUrl, email, password),
  save: session => keepSession(backendUrl, session, sessionStore),
  forget: () => forgetSession(backendUrl, sessionStore),
  revoke: session => logout(backendUrl, session.token),
  // this manager owns token persistence and expiry; prevent unpersisted sdk rotation.
  client: session => createClient({ url: backendUrl, token: session.token }),
});

export const bindSession = (core: ProductCore, session: Session) => bindBackendAccount(core, backendUrl, session);
export const backendTransport = createSnapbackTransport({
  connection: backendSession.connection,
  hash: hashText,
  bind: async session => {
    const opened = await getProductCore();
    if (!opened.ok) throw new Error('The local database is unavailable.');
    await bindSession(opened.value, session);
  },
});

export async function observeBackendChanges(changed: () => void): Promise<() => void> {
  const connection = await backendSession.connection();
  const observed = connection.client.observe(api.profile, {});
  return observeRevisions(observed, connection.isCurrent, changed);
}
