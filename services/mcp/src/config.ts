import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';

export type McpConfig = Readonly<{ version: 1; publicOrigin: string; backendUrl: string;
  dataDirectory: string; keyFile: string; port: number }>;
export type McpKeys = Readonly<{ providerSecret: string; cursorKey: Uint8Array;
  activeVaultKeyVersion: string; vaultKeys: ReadonlyMap<string, Uint8Array> }>;
type ErrorCode = 'CONFIG_INVALID' | 'KEY_FILE_INVALID' | 'UNSAFE_STORAGE' | 'ALREADY_RUNNING'
  | 'RUNTIME_UNSUPPORTED' | 'START_FAILED' | 'SHUTDOWN_FAILED';
const messages: Record<ErrorCode, string> = {
  CONFIG_INVALID: 'MCP configuration is invalid.', KEY_FILE_INVALID: 'MCP key file is invalid.',
  UNSAFE_STORAGE: 'MCP storage must be private.', ALREADY_RUNNING: 'MCP data directory is already in use.',
  RUNTIME_UNSUPPORTED: 'MCP requires Node 24.22.2 on a supported POSIX host.',
  START_FAILED: 'MCP service could not start.', SHUTDOWN_FAILED: 'MCP service could not shut down cleanly.',
};
export class McpRuntimeError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'McpRuntimeError'; }
}

function printable(value: string): boolean {
  return [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && isAbsolute(value) &&
    normalize(value) === value && printable(value) && !value.endsWith(sep);
}
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && value === url.origin && !url.username && !url.password; }
  catch { return false; }
}
function object(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function privateStat(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (!directory && (stat.mode & 0o111) !== 0)) {
    throw new McpRuntimeError('UNSAFE_STORAGE');
  }
}

// require physical absolute paths. only root-owned sticky temporary ancestors may be writable by others.
export function assertPrivatePath(path: string, directory = false): Stats {
  try {
    if (!absolute(path)) throw new Error();
    const result = lstatSync(path);
    privateStat(result, directory);
    let parent = dirname(path);
    if (!directory) privateStat(lstatSync(parent), true);
    for (;;) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || ![0, process.getuid?.()].includes(stat.uid) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) throw new Error();
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return result;
  } catch { throw new McpRuntimeError('UNSAFE_STORAGE'); }
}

function readJson(path: string, maximum: number, invalid: 'CONFIG_INVALID' | 'KEY_FILE_INVALID'): unknown {
  const before = assertPrivatePath(path);
  let fd: number | undefined;
  const bytes = Buffer.alloc(maximum + 1);
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); privateStat(stat, false);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new McpRuntimeError('UNSAFE_STORAGE');
    if (stat.size > maximum) throw new McpRuntimeError(invalid);
    let count = 0, size: number;
    while ((size = readSync(fd, bytes, count, bytes.length - count, null)) > 0) {
      count += size;
      if (count > maximum) throw new McpRuntimeError(invalid);
    }
    privateStat(fstatSync(fd), false);
    const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    const result: unknown = JSON.parse(input);
    // JSON.parse accepts duplicate object members. reject them, including escaped spellings.
    const stack: (Set<string> | null)[] = [];
    for (const token of input.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
      if (token[0] === '{') stack.push(new Set());
      else if (token[0] === '[') stack.push(null);
      else if (token[0] === '}' || token[0] === ']') stack.pop();
      else if (input.slice(token.index! + token[0].length).trimStart().startsWith(':')) {
        const key = JSON.parse(token[0]) as string, keys = stack.at(-1)!;
        if (keys.has(key)) throw new Error();
        keys.add(key);
      }
    }
    return result;
  } catch (error) { throw error instanceof McpRuntimeError ? error : new McpRuntimeError(invalid); }
  finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
}

export function validateMcpConfig(input: unknown, options: { allowTestPort?: boolean } = {}): McpConfig {
  if (!object(input, ['version', 'publicOrigin', 'backendUrl', 'dataDirectory', 'keyFile', 'port']) || input.version !== 1 ||
    !origin(input.publicOrigin) || !origin(input.backendUrl) || !absolute(input.dataDirectory) || !absolute(input.keyFile) ||
    !Number.isSafeInteger(input.port) || (input.port as number) > 65535 ||
    (input.port as number) < (options.allowTestPort && process.env.NODE_TEST_CONTEXT ? 0 : 1)) {
    throw new McpRuntimeError('CONFIG_INVALID');
  }
  const child = relative(input.dataDirectory, input.keyFile);
  if (!child || (!child.startsWith('..' + sep) && child !== '..' && !isAbsolute(child))) {
    throw new McpRuntimeError('CONFIG_INVALID');
  }
  assertPrivatePath(input.dataDirectory, true);
  return Object.freeze({ ...input }) as McpConfig;
}

export function loadMcpConfig(path = process.env.MCP_CONFIG_PATH): McpConfig {
  if (!absolute(path)) throw new McpRuntimeError('CONFIG_INVALID');
  return validateMcpConfig(readJson(path, 16_384, 'CONFIG_INVALID'));
}

export function loadMcpKeys(config: McpConfig): McpKeys {
  const value = readJson(config.keyFile, 65_536, 'KEY_FILE_INVALID');
  try {
    if (!object(value, ['version', 'providerSecret', 'cursorKey', 'activeVaultKeyVersion', 'vaultKeys']) || value.version !== 1 ||
      typeof value.providerSecret !== 'string' || value.providerSecret.length < 32 ||
      Buffer.byteLength(value.providerSecret) > 4096 || !printable(value.providerSecret) ||
      typeof value.activeVaultKeyVersion !== 'string' || !value.vaultKeys || typeof value.vaultKeys !== 'object' ||
      Array.isArray(value.vaultKeys)) throw new Error();
    const decode = (key: unknown) => {
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error();
      const bytes = Buffer.from(key, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== key) throw new Error();
      return bytes;
    };
    const entries = Object.entries(value.vaultKeys);
    if (entries.length < 1 || entries.length > 32) throw new Error();
    const vaultKeys = new Map(entries.map(([version, key]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error();
      return [version, decode(key)] as const;
    }));
    if (!vaultKeys.has(value.activeVaultKeyVersion)) throw new Error();
    return Object.freeze({ providerSecret: value.providerSecret, cursorKey: decode(value.cursorKey),
      activeVaultKeyVersion: value.activeVaultKeyVersion, vaultKeys });
  } catch { throw new McpRuntimeError('KEY_FILE_INVALID'); }
}
