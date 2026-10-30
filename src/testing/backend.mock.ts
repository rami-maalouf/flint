import type { Client } from 'snapback4/client';
import { bindBackendAccount } from '../platform/backend/account-binding';
import { BackendSession, type AuthPort } from '../platform/backend/session';
import type { ProductCore } from '../platform/database/product-core';

export const backendUrl = 'https://habits.example.test';
const session = { principal: 'test-account', token: 'synthetic-token', kind: 'password', expiresAt: Date.now() + 3_600_000 };
export const authenticate = jest.fn(async () => ({ ok: true as const, session }));
export const restoreAccount = jest.fn(async () => null);
export const revokeAccount = jest.fn(async () => {});
const auth: AuthPort = {
  restore: restoreAccount, authenticate,
  save: async () => {}, forget: async () => {}, revoke: revokeAccount,
  client: () => ({ close: async () => {} }) as Client,
};
export let backendSession = new BackendSession(auth);
export const resetBackendMock = () => {
  authenticate.mockClear(); restoreAccount.mockClear(); revokeAccount.mockClear();
  observeBackendChanges.mockClear();
  backendSession = new BackendSession(auth);
};
export const bindSession = (core: ProductCore, value: typeof session) => bindBackendAccount(core, backendUrl, value);
export const backendTransport = {
  ensureZone: async () => { await backendSession.connection(); },
  upload: async () => { await backendSession.connection(); },
  fetchChanges: async () => { await backendSession.connection(); return { records: [], nextToken: '0', more: false }; },
};
export const observeBackendChanges = jest.fn(async (_changed: () => void) => () => {});
