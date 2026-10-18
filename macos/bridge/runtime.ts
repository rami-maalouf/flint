import type { CommandDeps } from '../../src/core/domain/command-context';
import type { SqlDatabase, SqlExecutor, SqlParams } from '../../src/core/persistence/database';

export type Operation = (...args: unknown[]) => unknown;
export type Operations = Record<string, Operation>;

type HostGlobals = typeof globalThis & {
  __habitNative(request: string): string;
  __habitComplete(identifier: string, response: string): void;
  __habitService(identifier: string, name: string, payload: string): void;
  HabitEngine?: { dispatch(identifier: string, request: string): void; settleService(identifier: string, response: string): void };
};
export const host = globalThis as HostGlobals;
const pendingServices = new Map<string, { resolve(value: unknown): void; reject(cause: unknown): void }>();
let serviceSequence = 0;

export function nativeAsync<Value>(name: string, payload: Record<string, unknown> = {}): Promise<Value> {
  return new Promise((resolve, reject) => {
    const identifier = String(++serviceSequence);
    pendingServices.set(identifier, { resolve: value => resolve(value as Value), reject });
    host.__habitService(identifier, name, JSON.stringify(payload));
  });
}

// bare javascriptcore has no browser textencoder; preserve usvstring utf-8 semantics.
class UTF8Encoder {
  encode(input = ''): Uint8Array {
    const bytes: number[] = [];
    for (const character of String(input)) {
      let code = character.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
      else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
      else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    }
    return new Uint8Array(bytes);
  }
}
Object.defineProperty(globalThis, 'TextEncoder', { value: UTF8Encoder, configurable: true });

export function native<Value>(request: Record<string, unknown>): Value {
  const result = JSON.parse(host.__habitNative(JSON.stringify(request))) as { ok: boolean; value: Value; error: string };
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const executor: SqlExecutor = {
  async runAsync(sql: string, params: SqlParams = []) { return native({ kind: 'run', sql, params }); },
  async getAllAsync<Row>(sql: string, params: SqlParams = []) { return native<Row[]>({ kind: 'query', sql, params }); },
  async getFirstAsync<Row>(sql: string, params: SqlParams = []) { return native<Row[]>({ kind: 'query', sql, params })[0] ?? null; },
};
async function transaction<Value>(mode: string, work: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
  native({ kind: 'exec', sql: `BEGIN ${mode}` });
  try {
    const result = await work(executor);
    native({ kind: 'exec', sql: 'COMMIT' });
    return result;
  } catch (error) {
    native({ kind: 'exec', sql: 'ROLLBACK' });
    throw error;
  }
}
export const db: SqlDatabase = {
  ...executor,
  async execAsync(sql) { native({ kind: 'exec', sql }); },
  withExclusiveTransactionAsync: work => transaction('EXCLUSIVE', work),
  withTransactionAsync: work => transaction('DEFERRED', work),
  async closeAsync() {},
};
export const deps: CommandDeps = {
  db,
  clock: { nowUtcMs: () => Date.now(), timeZoneId: () => native<string>({ kind: 'timeZone' }) },
  ids: { uuid: () => native<string>({ kind: 'uuid' }) },
  hashing: {
    sha1: async bytes => new Uint8Array(native<number[]>({ kind: 'hash', algorithm: 'sha1', bytes: [...bytes] })),
    sha256: async bytes => new Uint8Array(native<number[]>({ kind: 'hash', algorithm: 'sha256', bytes: [...bytes] })),
  },
};

export function bind(operations: Operations, module: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    const method = module[name] as (...args: unknown[]) => unknown;
    if (typeof method !== 'function') throw new Error(`Missing shared operation: ${name}`);
    operations[name] = (...args) => method(deps, ...args);
  }
}

export function install(operations: Operations): void {
  let queue: Promise<unknown> = Promise.resolve();
  host.HabitEngine = {
    settleService(identifier, response) {
      const waiting = pendingServices.get(identifier);
      if (!waiting) return;
      pendingServices.delete(identifier);
      try {
        const result = JSON.parse(response);
        if (result.ok) waiting.resolve(result.value);
        else waiting.reject(Object.assign(new Error(result.error.message), result.error));
      } catch (cause) { waiting.reject(cause); }
    },
    dispatch(identifier, json) {
      const run = async () => {
        try {
          const request = JSON.parse(json) as { method: string; arguments: unknown[] };
          if (!Object.hasOwn(operations, request.method)) throw new Error('Unknown habit operation.');
          const result = await operations[request.method](...request.arguments);
          host.__habitComplete(identifier, JSON.stringify(result));
        } catch (cause) {
          host.__habitComplete(identifier, JSON.stringify({ ok: false, error: {
            code: 'runtime', message: cause instanceof Error ? cause.message : String(cause), retryable: false,
          } }));
        }
      };
      queue = queue.then(run, run);
    },
  };
}
