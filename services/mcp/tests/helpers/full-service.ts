import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe } from 'snapback4/proof';
import { AccountActors } from '../../src/accounts/actor';
import { createAuthorizationService } from '../../src/auth/provider';
import { CredentialVault } from '../../src/auth/vault';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../../src/core';
import { createHttpService } from '../../src/http';
import type { ServiceLimits } from '../../src/limits';
import type { DiagnosticEvent } from '../../src/diagnostics';
import { FileRestoreLatch } from '../../src/operations/recovery-head';
import { RewardQuoteStore } from '../../src/rewards/quotes';
import { approvedClaimNormalizer, RewardPreviewTools } from '../../src/rewards/tools';
import { CursorCodec } from '../../src/tools/cursors';
import { MutationTools } from '../../src/tools/mutations';
import { createMutationNormalizer } from '../../src/tools/normalize';
import { ReadTools } from '../../src/tools/reads';
import { createRewardConfirmationHandler } from '../../src/web/reward-confirmation';
import { syntheticAuthorizationEpoch } from './authorization-epoch';
import { syntheticOAuthClient } from './oauth';
import { authorizeSyntheticWrite } from './write-oauth';

const scope = 'habits:read coins:read checkins:write rewards:claim offline_access';
type Session = Extract<Awaited<ReturnType<typeof signup>>, { ok: true }>['session'];
type Provider = ReturnType<typeof syntheticOAuthClient>;

export async function fullService(t: TestContext, controls: { limits?: ServiceLimits; diagnostics?: (event: DiagnosticEvent) => void } = {}) {
  assert.equal(process.version, 'v24.22.2');
  assert.equal(process.versions.bun, undefined);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'habit-mcp-reward-http-')));
  const closers: Array<() => Promise<void> | void> = [() => rmSync(directory, { recursive: true, force: true })];
  const clients: Client[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const result of await Promise.allSettled(clients.map(client => client.close()))) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    for (const close of closers) try { await close(); } catch (cause) { errors.push(cause); }
    if (errors.length) throw new AggregateError(errors, 'Synthetic full-service cleanup failed.');
  });
  const backendDirectory = join(directory, 'backend'), replicas = join(directory, 'replicas'), external = join(directory, 'external');
  for (const path of [backendDirectory, replicas, external]) mkdirSync(path, { mode: 0o700 });
  const logsDir = join(directory, 'logs');
  assert.equal((await deploy(backendDirectory, resolve('snapback/schema.q'), { logsDir })).code, 0);
  const host = await startServe(backendDirectory, { logsDir });
  closers.unshift(() => host.stop());
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  const server = createServer((request, response) => dispatch(request, response));
  closers.unshift(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const publicOrigin = `http://127.0.0.1:${address.port}`, backendUrl = 'https://snapback.synthetic.test';
  const backendFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, backendUrl);
    return fetch(host.url + url.pathname + url.search, request);
  };
  const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1',
    keys: new Map([['v1', randomBytes(32)]]) });
  closers.splice(1, 0, () => vault.close());
  let quoteNow = Date.now();
  const quotes = new RewardQuoteStore({ location: join(directory, 'quotes.sqlite'), key: randomBytes(32), publicOrigin,
    nowUtcMs: () => quoteNow });
  closers.splice(1, 0, () => quotes.close());
  const latchOptions = { path: join(external, 'restore-latch'), installationId: randomUUID(),
    restoredDirectories: [replicas, backendDirectory] as const };
  FileRestoreLatch.provisionFresh(latchOptions);
  let authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  const accounts = new AccountActors({ root: replicas, backendUrl, fetch: backendFetch, minFreeBytes: 1024 * 1024,
    operationPolicy: { latch: new FileRestoreLatch(latchOptions), normalize: createMutationNormalizer(approvedClaimNormalizer(quotes)),
      authorize: async ({ context }) => { await context.assertActive(); },
      delivery: { grantStatus: grantId => authorization.deliveryGrantStatus(grantId) } } });
  closers.splice(1, 0, () => accounts.close());
  authorization = await createAuthorizationService({ publicOrigin, backendUrl, databasePath: join(directory, 'provider.sqlite'),
    secret: randomBytes(48).toString('hex'), vault, authorizationEpoch: syntheticAuthorizationEpoch(),
    identityOptions: { fetch: backendFetch }, allowTestLoopback: true,
    writeConnections: { revoke: (grant, commit) => accounts.revokeDeliveryGrant(grant, commit) } });
  closers.splice(1, 0, () => authorization.close());
  const reads = new ReadTools({ accounts, cursors: new CursorCodec(randomBytes(32)) });
  const mutations = new MutationTools({ accounts, rewardClaims: true });
  const rewardPreview = new RewardPreviewTools({ accounts, quotes });
  const confirmation = createRewardConfirmationHandler({ authorization, quotes, publicOrigin,
    secret: randomBytes(48).toString('hex') });
  let ownerBrowser: { fetch(request: Request): Promise<Response | null> } | null = null;
  const browser = { fetch: async (request: Request) => await ownerBrowser?.fetch(request) ?? confirmation.fetch(request) };
  const http = createHttpService({ authorization, reads, mutations, rewardPreview, browser, ...controls });
  closers.unshift(() => http.close());
  dispatch = toNodeHandler(http);

  const ports = createCorePorts('UTC');
  const newReplica = async () => {
    const db = new NodeSqlDatabase(join(directory, `replica-${randomUUID()}.sqlite`));
    closers.splice(1, 0, () => db.closeAsync());
    assert.ok((await initializeProductDatabase(db, ports.ids, ports.hashing)).ok);
    await db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    return db;
  };
  const account = async () => {
    const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
    const signed = await signup(host.url, credentials.email, credentials.password); assert.ok(signed.ok);
    const seed = new NodeSqlDatabase(join(directory, `seed-${randomUUID()}.sqlite`));
    closers.splice(1, 0, () => seed.closeAsync());
    assert.ok((await initializeProductDatabase(seed, ports.ids, ports.hashing)).ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const provider = syntheticOAuthClient(`synthetic reward client ${randomUUID()}`);
    const authorize = async (other = provider, requestedScope = scope) => {
      const browserSession = await authorizeSyntheticWrite(authorization.resource, other, credentials, requestedScope);
      const context = await authorization.authenticate(new Request(authorization.resource,
        { headers: { authorization: `Bearer ${other.tokens()!.access_token}` } }));
      return { provider: other, browserSession, context };
    };
    const sync = async (db = seed, session: Session = signed.session, mode?: 'pull_only') => {
      const upstream = createClient({ url: host.url, token: session.token, readOnly: session.scope === 'read' });
      try {
        const source = createSnapbackTransport({ connection: async () => ({ client: upstream, session, isCurrent: () => true }),
          bind: async () => undefined, hash: async value => createHash('sha256').update(value).digest('hex') });
        const transport = mode === 'pull_only' ? { ensureZone: async () => { throw new Error('pull-only zone creation'); },
          upload: async () => { throw new Error('pull-only upload'); }, fetchChanges: source.fetchChanges } : source;
        const result = await runSync({ db, ...ports, transport, random: () => 0.5, ...(mode ? { mode } : {}) });
        assert.ok(result.ok && result.value.status === 'up_to_date', JSON.stringify(result));
      } finally { await upstream.close(); }
    };
    const connect = async (oauth: Provider = provider, fetchOverride?: typeof fetch) => {
      const client = new Client({ name: 'reward-acceptance', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(authorization.resource), {
        requestInit: { headers: { authorization: `Bearer ${oauth.tokens()!.access_token}` } },
        ...(fetchOverride ? { fetch: fetchOverride } : {}),
      }));
      return client;
    };
    return { credentials, signed, seed, provider, authorize, sync, connect };
  };
  return { directory, replicas, host, publicOrigin, authorization, accounts, quotes, mutations, account, newReplica, ports, clients,
    setQuoteTime: (value: number) => { quoteNow = value; },
    mountOwnerBrowser: (handler: { fetch(request: Request): Promise<Response | null> }) => { ownerBrowser = handler; } };
}
