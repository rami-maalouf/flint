import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { login, signup } from 'snapback4/auth';
import { createClient } from 'snapback4/client';
import { deploy, startServe } from 'snapback4/proof';
import { api } from '../../../snapback/generated/api.ts';
import { createBoard } from '../../../src/core/domain/commands';
import type { CommandId } from '../../../src/core/domain/ids';
import type { WireSyncRecord } from '../../../src/core/sync/transport';
import { AccountActors } from '../src/accounts/actor';
import { accountDirectory } from '../src/accounts/replica';
import { createAuthorizationService } from '../src/auth/provider';
import { CredentialVault } from '../src/auth/vault';
import { createCorePorts, createSnapbackTransport, initializeProductDatabase, NodeSqlDatabase, runSync } from '../src/core';
import { createHttpService } from '../src/http';
import { FileRestoreLatch } from '../src/operations/recovery-head';
import { wireIdentity } from '../src/operations/records';
import { CursorCodec } from '../src/tools/cursors';
import { MutationTools, mutationToolNames } from '../src/tools/mutations';
import { createMutationNormalizer } from '../src/tools/normalize';
import { ReadTools, readToolNames } from '../src/tools/reads';
import { authorizeSynthetic, syntheticOAuthClient } from './helpers/oauth';
import { authorizeSyntheticWrite } from './helpers/write-oauth';

test('real OAuth and HTTP MCP create a delivered check-in with exact journal evidence', { timeout: 120_000 }, async t => {
  assert.equal(process.version, 'v24.22.2');
  assert.equal('bun' in process.versions, false);
  const directory = mkdtempSync(join(tmpdir(), 'habit-mcp-http-mutations-'));
  const clients: Client[] = [];
  let stopHost = async () => {}, stopServer = async () => {}, closeVault = async () => {};
  let closeAccounts = async () => {}, closeAuthorization = async () => {}, closeHttp = async () => {};
  t.after(async () => {
    const errors: unknown[] = [];
    const closeClients = async () => {
      const results = await Promise.allSettled(clients.map(client => client.close()));
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    };
    for (const close of [closeClients, () => stopServer(), () => closeHttp(), () => closeAccounts(),
      () => closeAuthorization(), () => closeVault(), () => stopHost(), () => rmSync(directory, { recursive: true, force: true })]) {
      try { await close(); } catch (cause) { errors.push(cause); }
    }
    if (errors.length) throw new AggregateError(errors, 'Synthetic HTTP fixture cleanup failed.');
  });
  const backendDirectory = join(directory, 'backend'), replicas = join(directory, 'replicas'), external = join(directory, 'external');
  for (const path of [backendDirectory, replicas, external]) mkdirSync(path, { mode: 0o700 });
  const logsDir = join(directory, 'logs');
  assert.equal((await deploy(backendDirectory, resolve('snapback/schema.q'), { logsDir })).code, 0);
  const host = await startServe(backendDirectory, { logsDir });
  stopHost = () => host.stop();
  const server = createServer((request, response) => dispatch(request, response));
  stopServer = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  let dispatch: ReturnType<typeof toNodeHandler> = async (_request, response) => { response.writeHead(503); response.end(); };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const publicOrigin = `http://127.0.0.1:${address.port}`;
  const backendUrl = 'https://snapback.synthetic.test';
  const traffic: string[] = [];
  let pauseUploads = false;
  const backendFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, backendUrl); traffic.push(`${request.method} ${url.pathname}`);
    if (pauseUploads && url.pathname === '/m/uploadRecord') return Promise.reject(new Error('synthetic upload interruption'));
    return fetch(host.url + url.pathname + url.search, request);
  };
  const vault = new CredentialVault({ location: join(directory, 'vault.sqlite'), activeKeyVersion: 'v1',
    keys: new Map([['v1', randomBytes(32)]]) });
  closeVault = async () => { vault.close(); };
  const latchOptions = { path: join(external, 'restore-latch'), installationId: randomUUID(),
    restoredDirectories: [replicas, backendDirectory] as const };
  FileRestoreLatch.provisionFresh(latchOptions);
  let authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  const accounts = new AccountActors({ root: replicas, backendUrl, fetch: backendFetch, minFreeBytes: 1024 * 1024,
    operationPolicy: { latch: new FileRestoreLatch(latchOptions), normalize: createMutationNormalizer(),
      authorize: async ({ context }) => { await context.assertActive(); },
      delivery: { grantStatus: grantId => authorization.deliveryGrantStatus(grantId) } } });
  closeAccounts = () => accounts.close();
  authorization = await createAuthorizationService({ publicOrigin, backendUrl, databasePath: join(directory, 'provider.sqlite'),
    secret: randomBytes(48).toString('hex'), vault, identityOptions: { fetch: backendFetch }, allowTestLoopback: true,
    writeConnections: { revoke: (grant, commit) => accounts.revokeDeliveryGrant(grant, commit) } });
  closeAuthorization = () => authorization.close();
  const reads = new ReadTools({ accounts, cursors: new CursorCodec(randomBytes(32)) });
  const mutations = new MutationTools({ accounts });
  const http = createHttpService({ authorization, reads, mutations });
  closeHttp = () => http.close();
  dispatch = toNodeHandler(http);

  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() };
  const signed = await signup(host.url, credentials.email, credentials.password); assert.ok(signed.ok);
  const seed = new NodeSqlDatabase(join(directory, 'seed.sqlite')), ports = createCorePorts('UTC');
  try {
    assert.ok((await initializeProductDatabase(seed, ports.ids, ports.hashing)).ok);
    const board = await createBoard({ db: seed, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic count', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(board.ok);
    const daily = await createBoard({ db: seed, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic daily', symbol: 'sun.max.fill', accentHex: '#70A7FF', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      kind: 'daily', earnsCoins: true, coinCapPerDay: 10 });
    assert.ok(daily.ok);
    const measured = await createBoard({ db: seed, ...ports }, { commandId: randomUUID() as CommandId,
      title: 'synthetic measured', symbol: 'timer', accentHex: '#70A7FF', usesTintedBackground: false,
      tracksAmount: true, amountUnit: 'repetitions', quickAmount: 7.5, tracksTime: true,
      startOfDayMinute: 0, metricsEnabled: true, kind: 'count' });
    assert.ok(measured.ok);
    await seed.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
    const upstream = createClient({ url: host.url, token: signed.session.token });
    try {
      const transport = createSnapbackTransport({ connection: async () => ({ client: upstream, session: signed.session, isCurrent: () => true }),
        bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
      const seeded = await runSync({ db: seed, ...ports, transport, random: () => 0.5 });
      assert.ok(seeded.ok && seeded.value.status === 'up_to_date', JSON.stringify(seeded));
    } finally { await upstream.close(); }
    const provider = syntheticOAuthClient('synthetic write acceptance');
    await authorizeSyntheticWrite(authorization.resource, provider, credentials);
    const token = provider.tokens()!.access_token;
    const context = await authorization.authenticate(new Request(authorization.resource,
      { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(context.session.scope, 'full');
    const client = new Client({ name: 'http-mutations-acceptance', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(authorization.resource),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...readToolNames, ...mutationToolNames].sort());
    assert.equal(tools.tools.find(tool => tool.name === 'create_checkin')?.inputSchema.additionalProperties, false);
    assert.equal(tools.tools.find(tool => tool.name === 'undo_checkin')?.inputSchema.additionalProperties, false);
    assert.equal(tools.tools.find(tool => tool.name === 'get_operation')?.inputSchema.additionalProperties, false);
    const invalid = await client.callTool({ name: 'create_checkin', arguments: {
      operationId: randomUUID(), habitId: board.value.boardId, timeZone: 'UTC', owner: 'private SQL token' } });
    assert.equal(invalid.isError, true);
    assert.equal((invalid.structuredContent as { error: { code: string } }).error.code, 'INVALID_INPUT');
    assert.ok(!JSON.stringify(invalid).includes('private SQL token'));
    const operationId = randomUUID();
    const uncertain = new Client({ name: 'http-mutations-lost-response', version: '1' }); clients.push(uncertain);
    await uncertain.connect(new StreamableHTTPClientTransport(new URL(authorization.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const request = new Request(input, init), body = request.method === 'POST' ? await request.clone().text() : '';
        const response = await fetch(request);
        if (body.includes(operationId)) { await response.arrayBuffer(); throw new Error('synthetic lost HTTP response'); }
        return response;
      },
    }));
    await assert.rejects(uncertain.callTool({ name: 'create_checkin', arguments: {
      operationId, habitId: board.value.boardId, timeZone: 'UTC', note: 'synthetic private note' } }),
    /synthetic lost HTTP response/);
    const response = await client.callTool({ name: 'create_checkin', arguments: {
      operationId, habitId: board.value.boardId, timeZone: 'UTC', note: 'synthetic private note' } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const operation = (response.structuredContent as { data: { result: { checkinId: string }; state: string; delivery: string } }).data;
    assert.equal(operation.state, 'backend_acknowledged'); assert.equal(operation.delivery, 'acknowledged');
    assert.ok(!JSON.stringify(response).includes('synthetic private note'));
    const history = await client.callTool({ name: 'get_checkin_history', arguments: { habitId: board.value.boardId } });
    assert.equal(history.isError, undefined, JSON.stringify(history));
    const historyRows = (history.structuredContent as { data: { items: { id: string; note?: string }[] } }).data.items;
    assert.ok(historyRows.some(row => row.id === operation.result.checkinId));
    assert.ok(historyRows.every(row => !Object.hasOwn(row, 'note')));
    const path = accountDirectory(replicas, context.accountId);
    const journal = new DatabaseSync(join(path, 'journal.sqlite'), { readOnly: true });
    try {
      const tuples = journal.prepare('SELECT record, payload_hash, digest, disposition, remote_stamp FROM tuples WHERE operation_id = ?').all(operationId);
      assert.ok(tuples.length > 0);
      for (const tuple of tuples) {
        const identity = wireIdentity(JSON.parse(String(tuple.record)) as WireSyncRecord);
        assert.equal(tuple.payload_hash, identity.payloadHash);
        assert.equal(tuple.digest, identity.digest);
        assert.equal(tuple.disposition, 'accepted');
        assert.equal(tuple.remote_stamp, identity.record.mutationStamp);
      }
    } finally { journal.close(); }
    const headClient = createClient({ url: host.url, token: signed.session.token });
    try {
      const head = await headClient.query(api.mcpRecoveryHead, {});
      assert.ok('data' in head && head.complete && head.data);
      assert.equal(head.data.owner, context.principal);
      assert.ok(head.data.sequence > 0);
    } finally { await headClient.close(); }
    assert.ok(traffic.some(path => path === 'POST /m/uploadRecord'), traffic.join(', '));
    const readOperation = async (id: string, from = client) => from.callTool({ name: 'get_operation', arguments: { operationId: id } });
    const looked = await readOperation(operationId);
    assert.equal((looked.structuredContent as { data: { result: { checkinId: string } } }).data.result.checkinId,
      operation.result.checkinId);
    const otherProvider = syntheticOAuthClient('different synthetic write client');
    await authorizeSyntheticWrite(authorization.resource, otherProvider, credentials);
    const otherClient = new Client({ name: 'http-mutations-other-client', version: '1' },
      { versionNegotiation: { mode: 'legacy' } }); clients.push(otherClient);
    await otherClient.connect(new StreamableHTTPClientTransport(new URL(authorization.resource),
      { requestInit: { headers: { authorization: `Bearer ${otherProvider.tokens()!.access_token}` } } }));
    const foreignLookup = await readOperation(operationId, otherClient);
    assert.equal(foreignLookup.isError, true);
    assert.equal((foreignLookup.structuredContent as { error: { code: string } }).error.code, 'NOT_FOUND');
    const foreignUndo = await otherClient.callTool({ name: 'undo_checkin', arguments: {
      operationId: randomUUID(), originalOperationId: operationId } });
    assert.equal(foreignUndo.isError, true);
    assert.equal((foreignUndo.structuredContent as { error: { code: string } }).error.code, 'NOT_FOUND');
    const changed = await client.callTool({ name: 'create_checkin', arguments: {
      operationId, habitId: board.value.boardId, timeZone: 'UTC', note: 'changed private note' } });
    assert.equal((changed.structuredContent as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(changed.isError, true);
    const refresh = await fetch(`${authorization.issuer}/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: provider.tokens()!.refresh_token!,
        client_id: provider.clientInformation()!.client_id, resource: authorization.resource,
      }) });
    assert.equal(refresh.status, 200, await refresh.clone().text());
    provider.saveTokens({ ...provider.tokens()!, ...await refresh.json() });
    const reconnected = new Client({ name: 'http-mutations-retry', version: '1' }); clients.push(reconnected);
    await reconnected.connect(new StreamableHTTPClientTransport(new URL(authorization.resource),
      { requestInit: { headers: { authorization: `Bearer ${provider.tokens()!.access_token}` } } }));
    const retry = await reconnected.callTool({ name: 'create_checkin', arguments: {
      operationId, habitId: board.value.boardId, timeZone: 'UTC', note: 'synthetic private note' } });
    assert.equal(retry.isError, undefined, JSON.stringify(retry));
    assert.deepEqual((retry.structuredContent as { data: unknown }).data, operation);
    const measuredId = randomUUID();
    const measuredResult = await client.callTool({ name: 'create_checkin', arguments: {
      operationId: measuredId, habitId: measured.value.boardId, timeZone: 'UTC', note: 'measured private note' } });
    assert.equal(measuredResult.isError, undefined, JSON.stringify(measuredResult));
    const product = new DatabaseSync(join(path, 'product.sqlite'), { readOnly: true });
    try {
      assert.equal(product.prepare('SELECT count(*) AS n FROM check_ins WHERE id = ?').get(operation.result.checkinId)?.n, 1);
      const row = product.prepare('SELECT amount, occurred_at_utc, note FROM check_ins WHERE id = ?').get(
        (measuredResult.structuredContent as { data: { result: { checkinId: string } } }).data.result.checkinId);
      assert.equal(row?.amount, 7.5); assert.equal(typeof row?.occurred_at_utc, 'number');
      assert.equal(row?.note, 'measured private note');
    } finally { product.close(); }
    assert.ok(!JSON.stringify(measuredResult).includes('measured private note'));
    const dailyFirstId = randomUUID(), dailyNoopId = randomUUID();
    const dailyFirst = await client.callTool({ name: 'create_checkin', arguments: {
      operationId: dailyFirstId, habitId: daily.value.boardId, timeZone: 'UTC' } });
    const dailyNoop = await client.callTool({ name: 'create_checkin', arguments: {
      operationId: dailyNoopId, habitId: daily.value.boardId, timeZone: 'UTC' } });
    assert.equal((dailyFirst.structuredContent as { data: { result: { created: boolean } } }).data.result.created, true);
    assert.equal((dailyNoop.structuredContent as { data: { result: { created: boolean }; state: string } }).data.result.created, false);
    assert.equal((dailyNoop.structuredContent as { data: { state: string } }).data.state, 'completed_no_mutation');
    const refusedNoop = await client.callTool({ name: 'undo_checkin', arguments: {
      operationId: randomUUID(), originalOperationId: dailyNoopId } });
    assert.equal(refusedNoop.isError, true);
    assert.equal((refusedNoop.structuredContent as { error: { code: string } }).error.code, 'CONFLICT');
    const undoId = randomUUID();
    const undo = await client.callTool({ name: 'undo_checkin', arguments: { operationId: undoId, originalOperationId: dailyFirstId } });
    assert.equal(undo.isError, undefined, JSON.stringify(undo));
    assert.equal((undo.structuredContent as { data: { state: string } }).data.state, 'backend_acknowledged');
    const undoRetry = await reconnected.callTool({ name: 'undo_checkin', arguments: { operationId: undoId, originalOperationId: dailyFirstId } });
    assert.deepEqual((undoRetry.structuredContent as { data: unknown }).data, (undo.structuredContent as { data: unknown }).data);
    const read = await login(host.url, credentials.email, credentials.password, { scope: 'read' }); assert.ok(read.ok);
    const second = new NodeSqlDatabase(join(directory, 'second-replica.sqlite'));
    try {
      assert.ok((await initializeProductDatabase(second, ports.ids, ports.hashing)).ok);
      await second.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      const upstream = createClient({ url: host.url, token: read.session.token, readOnly: true });
      try {
        const source = createSnapbackTransport({ connection: async () => ({ client: upstream, session: read.session, isCurrent: () => true }),
          bind: async () => undefined, hash: async text => createHash('sha256').update(text).digest('hex') });
        const pulled = await runSync({ db: second, ...ports, transport: {
          ensureZone: async () => { throw new Error('pull-only replica attempted zone creation'); },
          upload: async () => { throw new Error('pull-only replica attempted upload'); },
          fetchChanges: token => source.fetchChanges(token),
        }, random: () => 0.5, mode: 'pull_only' });
        assert.ok(pulled.ok, JSON.stringify(pulled));
      } finally { await upstream.close(); }
      const rows = await second.getAllAsync<{ id: string; deleted_at: number | null }>(
        'SELECT id, deleted_at FROM check_ins WHERE id IN (?, ?)', [operation.result.checkinId,
          (dailyFirst.structuredContent as { data: { result: { checkinId: string } } }).data.result.checkinId]);
      assert.equal(rows.length, 2);
      assert.equal(rows.find(row => row.id === operation.result.checkinId)?.deleted_at, null);
      assert.equal(typeof rows.find(row => row.id !== operation.result.checkinId)?.deleted_at, 'number');
      const ledger = await second.getAllAsync<{ kind: string; delta: number }>(
        "SELECT kind, delta FROM coin_ledger WHERE kind IN ('check', 'reversal') ORDER BY kind, id");
      assert.ok(ledger.some(row => row.kind === 'check' && row.delta === 1));
      assert.ok(ledger.some(row => row.kind === 'reversal' && row.delta === -1));
    } finally { await second.closeAsync(); }
    pauseUploads = true;
    const pausedId = randomUUID();
    const pending = await reconnected.callTool({ name: 'create_checkin', arguments: {
      operationId: pausedId, habitId: board.value.boardId, timeZone: 'UTC' } });
    assert.equal(pending.isError, undefined, JSON.stringify(pending));
    assert.equal((pending.structuredContent as { data: { state: string; delivery: string } }).data.state, 'pending_sync');
    assert.equal((pending.structuredContent as { data: { delivery: string } }).data.delivery, 'pending');
    pauseUploads = false;
    await authorization.revokeGrant({ accountId: context.accountId, grantId: context.grantId });
    await assert.rejects(context.assertActive());
    const replacement = syntheticOAuthClient('same synthetic write client reconnected');
    replacement.saveClientInformation(provider.clientInformation()!);
    const previousDiscovery = provider.discoveryState();
    if (previousDiscovery) replacement.saveDiscoveryState(previousDiscovery);
    await authorizeSyntheticWrite(authorization.resource, replacement, credentials);
    const replacementContext = await authorization.authenticate(new Request(authorization.resource,
      { headers: { authorization: `Bearer ${replacement.tokens()!.access_token}` } }));
    assert.equal(replacementContext.accountId, context.accountId);
    assert.equal(replacementContext.clientId, context.clientId);
    assert.notEqual(replacementContext.grantId, context.grantId);
    assert.equal(replacementContext.session.scope, 'full');
    const resumedClient = new Client({ name: 'http-mutations-owner-resume', version: '1' }); clients.push(resumedClient);
    await resumedClient.connect(new StreamableHTTPClientTransport(new URL(authorization.resource),
      { requestInit: { headers: { authorization: `Bearer ${replacement.tokens()!.access_token}` } } }));
    const pausedStatus = await resumedClient.callTool({ name: 'get_sync_status', arguments: {} });
    assert.equal((pausedStatus.structuredContent as { data: { deliveryPaused: boolean } }).data.deliveryPaused, true);
    let ownerConfirmed = false;
    await accounts.resumeDelivery(replacementContext, async () => {
      assert.equal(replacementContext.accountId, context.accountId);
      assert.equal(replacementContext.session.scope, 'full');
      ownerConfirmed = true;
    });
    assert.equal(ownerConfirmed, true);
    const resumed = await resumedClient.callTool({ name: 'create_checkin', arguments: {
      operationId: pausedId, habitId: board.value.boardId, timeZone: 'UTC' } });
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed));
    assert.equal((resumed.structuredContent as { data: { state: string; delivery: string } }).data.state, 'backend_acknowledged');
    assert.equal((resumed.structuredContent as { data: { delivery: string } }).data.delivery, 'acknowledged');
    const narrowProvider = syntheticOAuthClient('same client read only');
    narrowProvider.saveClientInformation(replacement.clientInformation()!);
    const narrowDiscovery = replacement.discoveryState();
    if (narrowDiscovery) narrowProvider.saveDiscoveryState(narrowDiscovery);
    await authorizeSynthetic(authorization.resource, narrowProvider, credentials, 'habits:read offline_access');
    const narrowClient = new Client({ name: 'http-mutations-narrow-read', version: '1' }); clients.push(narrowClient);
    await narrowClient.connect(new StreamableHTTPClientTransport(new URL(authorization.resource),
      { requestInit: { headers: { authorization: `Bearer ${narrowProvider.tokens()!.access_token}` } } }));
    const narrowLookup = await readOperation(operationId, narrowClient);
    assert.equal(narrowLookup.isError, true);
    assert.equal((narrowLookup.structuredContent as { error: { code: string } }).error.code, 'FORBIDDEN');
  } finally { await seed.closeAsync(); }
});
