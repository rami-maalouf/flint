import type { Session } from 'snapback4/auth';
import type { Client } from 'snapback4/client';
import type { Mutation, SettledRead } from 'snapback4/contract';

import { api } from '../../../snapback/generated/api.ts';
import { captureSyncPage, SYNC_RECORD_BYTES } from '../../core/sync/sync-page.ts';
import { SyncTransportError, type SyncTransport, type WireSyncRecord } from '../../core/sync/transport.ts';

export type BackendConnection = { client: Client; session: Session; isCurrent: () => boolean };
type Options = {
  connection: () => Promise<BackendConnection>;
  bind: (session: Session) => Promise<void>;
  hash: (text: string) => Promise<string>;
};

function failure(): never { throw new SyncTransportError('failure', 'Sync could not finish. Your changes are still saved on this device.'); }
function read<T>(result: SettledRead<T>): { data: T; complete: boolean } {
  if ('denied' in result) throw result.denied;
  if (!('data' in result) || result.data === null || result.data === undefined) failure();
  return { data: result.data, complete: result.complete };
}
async function sent<A, R>(client: Client, operation: Mutation<A, R>, args: A, guard: () => void): Promise<R | undefined> {
  guard();
  const result = await client.mutate(operation, args);
  guard();
  if (result.state === 'failed') throw result.why;
  if (result.state !== 'sent') throw new SyncTransportError('offline', 'Your changes will sync when the connection returns.');
  return result.result;
}

function partsOf(text: string): string[] {
  const parts: string[] = [];
  let part: string[] = [];
  // quarry counts unicode scalars; never split a surrogate pair between parts.
  for (const scalar of text) {
    part.push(scalar);
    if (part.length === 8192) { parts.push(part.join('')); part = []; }
  }
  if (part.length) parts.push(part.join(''));
  return parts;
}

export function createSnapbackTransport(options: Options): SyncTransport<WireSyncRecord> {
  const connected = async <T>(work: (connection: BackendConnection, guard: () => void) => Promise<T>, shouldContinue?: () => boolean): Promise<T> => {
    try {
      const connection = await options.connection();
      const guard = () => {
        if (shouldContinue?.() === false) throw new SyncTransportError('unavailable', 'Sync was paused.');
        if (!connection.isCurrent()) throw new SyncTransportError('signed_out', 'Sign in again to resume sync.');
      };
      guard();
      await options.bind(connection.session);
      guard();
      const value = await work(connection, guard);
      guard();
      return value;
    } catch (cause) {
      if (cause instanceof SyncTransportError) throw cause;
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;
      if (cause instanceof TypeError || code === 'E_OFFLINE' || code === 'E_NETWORK') {
        throw new SyncTransportError('offline', 'Your changes will sync when the connection returns.');
      }
      if (code === 'E_AUTH' || code === 'E_SESSION_EXPIRED' || code === 'E_ACTION_AUTHORITY') {
        throw new SyncTransportError('signed_out', 'Sign in again to resume sync.');
      }
      return failure();
    }
  };
  const bodyOf = async (client: Client, body: string, expectedDigest: string, guard: () => void): Promise<string> => {
    let after = 0, digest = '', bytes = 0;
    const pieces: string[] = [];
    for (;;) {
      guard();
      const result = read(await client.query(api.bodyParts, { upload: body, after }));
      guard();
      const page = result.data;
      if (page.length === 0) {
        if (!result.complete || after === 0) failure();
        break;
      }
      for (const part of page) {
        if (part.position !== after || after >= 640 || await options.hash(part.payload) !== part.digest) failure();
        bytes += new TextEncoder().encode(part.payload).length;
        if (bytes > SYNC_RECORD_BYTES) failure();
        digest = await options.hash(digest + part.digest);
        pieces.push(part.payload);
        after++;
      }
      if (result.complete && page.length < 16) break;
    }
    if (digest !== expectedDigest) failure();
    return pieces.join('');
  };
  return {
    ensureZone: () => connected(async ({ client }, guard) => { await sent(client, api.ensureAccount, {}, guard); }),
    upload: (records, shouldContinue) => connected(async ({ client }, guard) => {
      const captured = captureSyncPage({ records, nextToken: null, more: false }, null).records;
      for (const record of captured) {
        const encoded = JSON.stringify(record);
        const parts = partsOf(encoded);
        let payload = encoded, body: string | null = null, digest = '';
        if (parts.length === 1) digest = await options.hash(encoded);
        else {
          if (parts.length > 640) failure();
          for (const part of parts) digest = await options.hash(digest + await options.hash(part));
          const upload = await sent(client, api.beginUpload, { key: digest, partCount: parts.length }, guard);
          if (!upload) failure();
          body = upload.id;
          if (!upload.verified) {
            for (let offset = 0; offset < parts.length; offset += 4) {
              await Promise.all(parts.slice(offset, offset + 4).map((part, index) =>
                sent(client, api.uploadPart, { upload: upload.id, position: offset + index, payload: part }, guard)));
            }
            await sent(client, api.finishUpload, { upload: upload.id }, guard);
          }
          payload = '';
        }
        await sent(client, api.uploadRecord, {
          entityType: record.entityType, entityId: record.entityId, schemaVersion: record.schemaVersion,
          mutationStamp: record.mutationStamp, deleted: record.deleted, payload, body, digest,
        }, guard);
      }
    }, shouldContinue),
    fetchChanges: (token, shouldContinue) => connected(async ({ client }, guard) => {
      if (token !== null && !/^(0|[1-9][0-9]{0,15})$/.test(token)) failure();
      const after = Number(token ?? 0);
      if (!Number.isSafeInteger(after)) failure();
      guard();
      const result = read(await client.query(api.changes, { after }));
      guard();
      const rows = result.data;
      let cursor = after;
      const records: WireSyncRecord[] = [];
      for (const row of rows) {
        if (!Number.isSafeInteger(row.revision) || row.revision <= cursor) failure();
        const encoded = row.body ? await bodyOf(client, row.body, row.digest, guard) : row.payload;
        if (!row.body && await options.hash(encoded) !== row.digest) failure();
        const record: unknown = JSON.parse(encoded);
        const captured = captureSyncPage({ records: [record], nextToken: null, more: false }, null).records[0];
        if (captured.entityType !== row.entityType || captured.entityId !== row.entityId ||
          captured.schemaVersion !== row.schemaVersion || captured.mutationStamp !== row.mutationStamp ||
          captured.deleted !== row.deleted) failure();
        records.push(captured);
        cursor = row.revision;
      }
      if (!result.complete && records.length === 0) failure();
      return { records, nextToken: String(cursor), more: !result.complete || rows.length === 200 };
    }, shouldContinue),
  };
}
