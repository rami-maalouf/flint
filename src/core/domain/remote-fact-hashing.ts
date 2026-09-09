import type { Hashing } from './ports';

// unwrap only at the outer operation boundary, after semantic catches and rollback.
export class RemoteFactHashingError extends Error {
  constructor(readonly cause: unknown) {
    super('Remote fact hashing failed.');
    this.name = 'RemoteFactHashingError';
  }
}

export function guardRemoteFactHashing(source: Hashing): Hashing {
  let sha1: Hashing['sha1'];
  let sha256: Hashing['sha256'];
  try {
    sha1 = source.sha1.bind(source);
    sha256 = source.sha256.bind(source);
  } catch (cause) { throw new RemoteFactHashingError(cause); }

  async function digest(method: Hashing['sha1'], bytes: Uint8Array, length: number) {
    try {
      const value = await method(bytes);
      if (!(value instanceof Uint8Array) || value.length !== length) {
        throw new TypeError('Hashing returned an invalid digest.');
      }
      return new Uint8Array(value);
    } catch (cause) { throw new RemoteFactHashingError(cause); }
  }
  return { sha1: bytes => digest(sha1, bytes, 20), sha256: bytes => digest(sha256, bytes, 32) };
}
