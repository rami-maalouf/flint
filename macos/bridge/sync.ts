import { runSync } from '../../src/core/sync/engine';
import { captureSyncPage, SYNC_RECORD_BYTES, SYNC_RECORD_COUNT, SYNC_TOKEN_BYTES } from '../../src/core/sync/sync-page';
import { SyncTransportError, type SyncFailureCode, type SyncTransport, type WireSyncRecord } from '../../src/core/sync/transport';
import { deps, native, nativeAsync, type Operations } from './runtime';

async function service<Value>(name: string, payload: Record<string, unknown> = {}): Promise<Value> {
  try { return await nativeAsync<Value>(`sync.${name}`, payload); }
  catch (cause) {
    const code = (cause as { code?: string })?.code;
    const failure: SyncFailureCode = code === 'offline' || code === 'signed_out' || code === 'unavailable' ? code : 'failure';
    throw new SyncTransportError(failure, 'iCloud sync could not finish.');
  }
}

const transport: SyncTransport<WireSyncRecord> = {
  async ensureZone() { await service('ensureZone'); },
  async upload(records) { await service('upload', { records: JSON.stringify(records) }); },
  async fetchChanges(token) {
    const json = await service<string>('fetchChanges', { token });
    // the native wire codec enforces utf-8/field bounds before this response reaches javascript.
    const maximum = SYNC_RECORD_COUNT * SYNC_RECORD_BYTES + 6 * SYNC_TOKEN_BYTES + 8192;
    if (typeof json !== 'string' || json.length > maximum) throw new SyncTransportError('failure', 'Invalid sync page.');
    return captureSyncPage(JSON.parse(json), token);
  },
};

export function installSyncOperations(operations: Operations): void {
  operations.sync = () => {
    const generation = native<number>({ kind: 'syncGeneration' });
    return runSync({ ...deps, transport, random: Math.random,
      shouldContinue: () => native<number>({ kind: 'syncGeneration' }) === generation });
  };
  operations.cloudKitAvailable = async () => {
    try { return { ok: true, value: await service<boolean>('available') }; }
    catch { return { ok: true, value: false }; }
  };
}
