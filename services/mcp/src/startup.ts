import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AccountActors } from './accounts/actor';
import { createAuthorizationService } from './auth/provider';
import { CredentialVault } from './auth/vault';
import { assertPrivatePath, loadMcpKeys, McpRuntimeError, validateMcpConfig, type McpConfig } from './config';
import { createHttpService } from './http';
import { CursorCodec } from './tools/cursors';
import { ReadTools } from './tools/reads';

export const runtimeLimits = Object.freeze({ maxHeaderBytes: 16_384, maxHeaders: 64, maxBodyBytes: 65_536,
  headersTimeoutMs: 5000, requestTimeoutMs: 10_000, exchangeTimeoutMs: 20_000, socketTimeoutMs: 20_000,
  connectionsCheckingIntervalMs: 1000, keepAliveTimeoutMs: 5000, maxConnections: 128,
  maxConcurrentRequests: 64, maxRequestsPerSocket: 100, shutdownGraceMs: 20_000 });

// sqlite's posix locks are process-scoped. refuse duplicates before opening any lock inode,
// even when two bundles containing this module are imported into the same process.
const ownershipSymbol = Symbol.for('habit-system/mcp/runtime-owners/v1');
const shared = globalThis as typeof globalThis & { [key: symbol]: Set<string> | undefined };
const owners = shared[ownershipSymbol] ??= new Set<string>();

function existingFile(path: string): boolean {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new McpRuntimeError('UNSAFE_STORAGE');
  }
  assertPrivatePath(path); return true;
}
function databaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) existingFile(path + suffix);
}
function privateFile(path: string): void {
  if (!existingFile(path)) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
    catch { throw new McpRuntimeError('UNSAFE_STORAGE'); }
  }
  assertPrivatePath(path);
}
function acquireOwnership(directory: string): () => void {
  const stat = assertPrivatePath(directory, true);
  const identity = `${stat.dev}:${stat.ino}`;
  if (owners.has(identity)) throw new McpRuntimeError('ALREADY_RUNNING');
  owners.add(identity);
  let lock: DatabaseSync | undefined;
  try {
    const path = join(directory, 'ownership.sqlite');
    databaseFiles(path); privateFile(path);
    lock = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false });
    lock.exec('PRAGMA busy_timeout = 0');
    if (lock.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') throw new Error();
    lock.exec('PRAGMA synchronous = FULL; BEGIN EXCLUSIVE');
    databaseFiles(path);
    return () => {
      lock!.exec('ROLLBACK'); lock!.close(); owners.delete(identity);
    };
  } catch (error) {
    lock?.close(); owners.delete(identity);
    if (error instanceof McpRuntimeError) throw error;
    const code = (error as { errcode?: number }).errcode;
    throw new McpRuntimeError(code === 5 || code === 6 ? 'ALREADY_RUNNING' : 'START_FAILED');
  }
}

function json(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close' });
  response.end(JSON.stringify({ error: status === 413 ? 'request_too_large' : 'temporarily_unavailable' }));
}
export type McpService = Readonly<{ address: Readonly<AddressInfo>; fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void> }>;

// no listener or account state is opened on import. the caller owns the returned service lifetime.
export async function startMcpService(input: McpConfig, options: { allowTestPort?: boolean } = {}): Promise<McpService> {
  if (process.versions.node !== '24.22.2' || 'bun' in process.versions || process.platform === 'win32' || !process.getuid) {
    throw new McpRuntimeError('RUNTIME_UNSUPPORTED');
  }
  const config = validateMcpConfig(input, options);
  const keys = loadMcpKeys(config);
  const dispose: (() => void | Promise<void>)[] = [];
  let release: (() => void) | undefined;
  let shuttingDown = false, closing: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: runtimeLimits.maxHeaderBytes,
    headersTimeout: runtimeLimits.headersTimeoutMs, requestTimeout: runtimeLimits.requestTimeoutMs,
    connectionsCheckingInterval: runtimeLimits.connectionsCheckingIntervalMs,
    keepAliveTimeout: runtimeLimits.keepAliveTimeoutMs, highWaterMark: 16_384 });
  server.maxConnections = runtimeLimits.maxConnections;
  server.maxHeadersCount = runtimeLimits.maxHeaders + 1;
  server.maxRequestsPerSocket = runtimeLimits.maxRequestsPerSocket;
  server.setTimeout(runtimeLimits.socketTimeoutMs, socket => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('clientError', (error, socket) => {
    const code = (error as NodeJS.ErrnoException).code;
    const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' :
      code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  async function closeResources() {
    let failed = false;
    for (const close of dispose) { try { await close(); } catch { failed = true; } }
    // retain ownership if a component could not close. the process must exit before another owner starts.
    if (failed) throw new McpRuntimeError('SHUTDOWN_FAILED');
    try { release?.(); release = undefined; }
    catch { throw new McpRuntimeError('SHUTDOWN_FAILED'); }
  }
  function clearKeys() { keys.cursorKey.fill(0); for (const key of keys.vaultKeys.values()) key.fill(0); }
  try {
    release = acquireOwnership(config.dataDirectory);
    for (const name of ['provider.sqlite', 'vault.sqlite']) databaseFiles(join(config.dataDirectory, name));
    const accountRoot = join(config.dataDirectory, 'accounts');
    try { mkdirSync(accountRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new McpRuntimeError('UNSAFE_STORAGE'); }
    assertPrivatePath(accountRoot, true);
    const vault = new CredentialVault({ location: join(config.dataDirectory, 'vault.sqlite'),
      activeKeyVersion: keys.activeVaultKeyVersion, keys: keys.vaultKeys });
    dispose.unshift(() => vault.close());
    const authorization = await createAuthorizationService({ publicOrigin: config.publicOrigin, backendUrl: config.backendUrl,
      databasePath: join(config.dataDirectory, 'provider.sqlite'), secret: keys.providerSecret, vault });
    dispose.unshift(() => authorization.close());
    const accounts = new AccountActors({ root: accountRoot, backendUrl: config.backendUrl });
    dispose.unshift(() => accounts.close());
    const reads = new ReadTools({ accounts, cursors: new CursorCodec(keys.cursorKey) });
    const http = createHttpService({ authorization, reads });
    dispose.unshift(() => http.close()); clearKeys();
    const fetch = async (request: Request): Promise<Response> => {
      if (shuttingDown) return Response.json({ error: 'temporarily_unavailable' }, { status: 503,
        headers: { 'cache-control': 'no-store', connection: 'close' } });
      const url = new URL(request.url);
      if (url.host !== new URL(config.publicOrigin).host ||
        (request.headers.has('host') && request.headers.get('host') !== url.host) ||
        (request.headers.has('origin') && request.headers.get('origin') !== config.publicOrigin)) {
        return Response.json({ error: 'access_denied' }, { status: 403 });
      }
      if (url.pathname === '/mcp/health' || url.pathname === '/mcp/ready') {
        return Response.json({ status: url.pathname === '/mcp/health' ? 'ok' : 'ready' }, {
          status: request.method === 'GET' || request.method === 'HEAD' ? 200 : 405,
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      return http.fetch(request);
    };
    const dispatch = toNodeHandler({ fetch }, { maxRequestBodySize: runtimeLimits.maxBodyBytes });
    server.on('request', (request, response) => {
      if (shuttingDown || active.size >= runtimeLimits.maxConcurrentRequests) { json(response, 503); return; }
      if (request.rawHeaders.length / 2 > runtimeLimits.maxHeaders) { json(response, 431); return; }
      if ((request.method === 'GET' || request.method === 'HEAD') &&
        (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length']) > 0)) {
        json(response, 400); return;
      }
      if (Number(request.headers['content-length']) > runtimeLimits.maxBodyBytes) { json(response, 413); return; }
      // socket inactivity is insufficient against slow trickles or a blocked response consumer.
      const deadline = setTimeout(() => response.destroy(), runtimeLimits.exchangeTimeoutMs);
      response.once('finish', () => clearTimeout(deadline));
      response.once('close', () => clearTimeout(deadline));
      const work = dispatch(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) json(response, 503);
        else response.destroy();
      });
      active.add(work);
      void work.finally(() => { active.delete(work); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: config.port, exclusive: true }, () => {
        server.removeListener('error', reject); resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error();
    return Object.freeze({ address: Object.freeze({ ...address }), fetch,
      close() {
        if (!closing) {
          shuttingDown = true;
          closing = (async () => {
            const deadline = setTimeout(() => server.closeAllConnections(), runtimeLimits.shutdownGraceMs);
            try {
              await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
              await Promise.allSettled([...active]);
              await closeResources();
            } catch { throw new McpRuntimeError('SHUTDOWN_FAILED'); }
            finally { clearTimeout(deadline); }
          })();
        }
        return closing;
      },
    });
  } catch (error) {
    shuttingDown = true;
    if (server.listening) {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections(); await stopped;
    }
    await closeResources();
    throw error instanceof McpRuntimeError ? error : new McpRuntimeError('START_FAILED');
  } finally { clearKeys(); }
}
