import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClient, type Client } from 'snapback4/client';

import type { SqlDatabase, SqlExecutor } from '../../../../src/core/persistence/database';
import type { WireSyncRecord } from '../../../../src/core/sync/transport';
import type { AuthContext } from '../auth/context';
import { claimReward, createCheckIn, createCorePorts, createSnapbackTransport, runSync, undoCreatedCheckIn } from '../core';
import { GENESIS_HASH, JournalError, OperationJournal, type CoreCommand, type Failpoint, type FrozenIntent, type JournalHead,
  type JournalOperation, type MutationRequest } from '../operations/journal';
import { createSnapbackRecoveryRemote, RecoveryHeadAdapter, type RestoreLatch } from '../operations/recovery-head';
import { canonicalJson, MAX_OPERATION_BYTES, MAX_OPERATION_TUPLES, wireIdentity } from '../operations/records';
import { contracts, hasToolScope } from '../tools/contracts';
import type { RecoveryStatus } from './actor';
import { DeliveryBarrier, DeliveryBarrierError, type DeliveryGrantBinding, type DeliveryPolicy } from './delivery';
import type { AccountReplica } from './replica';

export class OperationRuntimeError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'OPERATION_PENDING' | 'RATE_LIMITED', message: string) { super(message); }
}
type Action = 'recover' | 'prepare' | 'execute' | 'read' | 'publish' | 'control' | 'deliver' | 'resume';
export type OperationAuthorization = Readonly<{ context: AuthContext; action: Action;
  intent: FrozenIntent | null; originGrantId: string | null; request?: MutationRequest }>;
export type NormalizeContext = Readonly<{ commandId: FrozenIntent['commandId']; nowUtcMs: number;
  context: AuthContext; read: Pick<SqlExecutor, 'getFirstAsync' | 'getAllAsync'>;
  undoTarget: (operationId: string) => Promise<Awaited<ReturnType<OperationJournal['undoTarget']>> & { timeZone: string }> }>;
export type OperationPolicy = {
  latch: RestoreLatch;
  authorize: (request: OperationAuthorization) => Promise<void>;
  normalize: (request: MutationRequest, context: NormalizeContext) => Promise<{ timeZone: string; command: CoreCommand }>;
  maxOperations?: number;
  delivery?: DeliveryPolicy;
  // test-only injection, never request input. actual core execution cannot be replaced.
  failpoint?: (point: Failpoint) => void;
};
export type OperationEnvironment = Readonly<{ db: SqlDatabase; directory: string; context: AuthContext;
  signal: AbortSignal; nowUtcMs: number; assertActive: () => Promise<void>; fetch?: typeof fetch;
  checkDisk: () => void; maxFetches: number;
  history: Pick<AccountReplica, 'operationHistoryState' | 'markOperationHistory'> }>;

const legacySidecarSchema = `CREATE TABLE runtime_meta (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
  backend_url TEXT NOT NULL, principal TEXT NOT NULL, generation TEXT NOT NULL, journal_ready INTEGER NOT NULL);
CREATE TABLE operation_grants (client_id TEXT NOT NULL, operation_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  tool TEXT NOT NULL, PRIMARY KEY (client_id, operation_id));`;
const sidecarSchema = `${legacySidecarSchema}
CREATE TABLE delivery_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL,
  initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)));`;
// sha256 of the released journal schema in operations/journal.ts.
const journalSchemaHash = '0d53fa6c5d306f04963967e3125896afc132e5d77a18ef8db01334d6cb7ed853';
function fence(message: string): never { throw new OperationRuntimeError('OPERATION_PENDING', message); }
function active(env: OperationEnvironment): void { if (env.signal.aborted) throw env.signal.reason; }
export function hasOperationAuthority(ctx: AuthContext): boolean {
  return ctx.session.scope === 'full' && ctx.session.expiresAt > Date.now() &&
    (ctx.scopes.includes('checkins:write') || (ctx.scopes.includes('coins:read') && ctx.scopes.includes('rewards:claim')));
}
function secureFile(path: string, create = false): void {
  if (create && !existsSync(path)) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || (!create && stat.size === 0)) {
    fence('Operation history is missing or unsafe. Preserve the replica for reconciliation.');
  }
}
function schemaRows(schema: string): string[] { return schema.trim().split(';').map(sql => sql.trim()).filter(Boolean).sort(); }
function inspectOrigins(state: DatabaseSync, view: DatabaseSync, limit: number, accountId: string): boolean {
  const count = Number(state.prepare('SELECT count(*) AS n FROM operation_grants').get()!.n);
  const operations = view.prepare('SELECT client_id, operation_id, fingerprint, intent, result, state, delivery FROM operations LIMIT ?').all(limit + 1);
  if (count > limit || operations.length > limit) fence('Operation history exceeds its configured admission bound.');
  let prepared = false;
  const rows = new Map<string, { encoded: string; state: string; result: string | null; delivery: string;
    resultOk: boolean | null; tupleIds: number[] }>();
  const tuples = new Map<number, { payloadHash: string; digest: string;
    record: Pick<WireSyncRecord, 'entityType' | 'mutationStamp'>;
    storedDisposition: unknown; storedStamp: unknown; acceptedDisposition: 'accepted' | 'superseded' | null;
    acceptedStamp: string | null }>();
  for (const operation of operations) {
    let intent: Record<string, unknown>, encoded: string;
    try {
      intent = JSON.parse(String(operation.intent)) as Record<string, unknown>;
      encoded = canonicalJson(intent);
    } catch { fence('Operation intent is corrupt.'); }
    if (intent.accountId !== accountId || intent.clientId !== operation.client_id ||
      intent.operationId !== operation.operation_id || intent.fingerprint !== operation.fingerprint ||
      typeof intent.tool !== 'string' || !['prepared', 'rejected', 'completed_no_mutation', 'pending_sync',
        'backend_acknowledged'].includes(String(operation.state))) fence('Operation intent identity or state is inconsistent.');
    const origin = state.prepare('SELECT grant_id, tool FROM operation_grants WHERE client_id = ? AND operation_id = ?')
      .get(operation.client_id, operation.operation_id);
    if (!origin || origin.tool !== intent.tool || typeof origin.grant_id !== 'string' || !origin.grant_id) {
      fence('Operation grant provenance is missing or inconsistent.');
    }
    rows.set(JSON.stringify([operation.client_id, operation.operation_id]), { encoded,
      state: String(operation.state), result: operation.result === null ? null : String(operation.result),
      delivery: String(operation.delivery), resultOk: null, tupleIds: [] });
  }
  const preparedEvents = new Set<string>();
  const capturedEvents = new Set<string>();
  for (const row of view.prepare('SELECT event FROM journal_chain ORDER BY sequence').iterate()) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(String(row.event)) as Record<string, unknown>; }
    catch { fence('Operation chain event is corrupt.'); }
    if (event.kind === 'prepared') {
      const intent = event.intent as Record<string, unknown> | null;
      if (!intent || typeof intent !== 'object' || typeof intent.clientId !== 'string' ||
        typeof intent.operationId !== 'string' || intent.accountId !== accountId) {
        fence('Prepared chain event has invalid identity.');
      }
      const key = JSON.stringify([intent.clientId, intent.operationId]);
      if (preparedEvents.has(key) || !rows.has(key)) fence('Prepared operation row is missing or duplicated.');
      try { if (rows.get(key)!.encoded !== canonicalJson(intent)) fence('Prepared operation row changed after admission.'); }
      catch { fence('Prepared chain event is corrupt.'); }
      preparedEvents.add(key);
      continue;
    }
    if (event.kind === 'captured') {
      if (typeof event.clientId !== 'string' || typeof event.operationId !== 'string' || !Array.isArray(event.tuples) ||
        event.tuples.length > MAX_OPERATION_TUPLES) fence('Captured chain event has invalid identity or tuples.');
      const key = JSON.stringify([event.clientId, event.operationId]), operation = rows.get(key);
      if (!preparedEvents.has(key) || capturedEvents.has(key) || !operation || operation.result === null) {
        fence('Captured chain event has no matching prepared operation and result.');
      }
      let result: { ok?: unknown };
      try {
        result = JSON.parse(operation.result) as { ok?: unknown };
        if (canonicalJson(result) !== canonicalJson(event.result)) fence('Captured operation result differs from immutable evidence.');
      } catch { fence('Captured operation result is corrupt.'); }
      if (typeof result.ok !== 'boolean') fence('Captured operation result is invalid.');
      const capturedRows = view.prepare('SELECT * FROM tuples WHERE client_id = ? AND operation_id = ? ORDER BY outbox_id LIMIT ?')
        .all(event.clientId, event.operationId, MAX_OPERATION_TUPLES + 1);
      if (capturedRows.length !== event.tuples.length) fence('Captured operation tuple count differs from immutable evidence.');
      let bytes = 0;
      for (const [index, tuple] of capturedRows.entries()) {
        const captured = event.tuples[index] as Record<string, unknown> | null;
        if (!captured || typeof captured !== 'object' || captured.outboxId !== tuple.outbox_id ||
          captured.payloadHash !== tuple.payload_hash || captured.digest !== tuple.digest ||
          typeof tuple.record !== 'string' || !Number.isSafeInteger(tuple.outbox_id) || Number(tuple.outbox_id) < 1 ||
          tuples.has(Number(tuple.outbox_id))) fence('Captured operation tuple differs from immutable evidence.');
        bytes += Buffer.byteLength(tuple.record);
        if (bytes > MAX_OPERATION_BYTES) fence('Captured operation tuple bytes exceed their admission bound.');
        let identity: ReturnType<typeof wireIdentity>;
        try { identity = wireIdentity(JSON.parse(tuple.record) as WireSyncRecord); }
        catch { fence('Captured operation tuple payload is corrupt.'); }
        if (identity.payloadHash !== tuple.payload_hash || identity.digest !== tuple.digest ||
          identity.record.entityType !== tuple.entity_type || identity.record.entityId !== tuple.entity_id ||
          identity.record.mutationStamp !== tuple.mutation_stamp) fence('Captured operation tuple payload or identity changed.');
        const id = Number(tuple.outbox_id);
        operation.tupleIds.push(id);
        tuples.set(id, { payloadHash: identity.payloadHash, digest: identity.digest,
          record: { entityType: identity.record.entityType, mutationStamp: identity.record.mutationStamp },
          storedDisposition: tuple.disposition, storedStamp: tuple.remote_stamp,
          acceptedDisposition: null, acceptedStamp: null });
      }
      operation.resultOk = result.ok;
      capturedEvents.add(key);
      continue;
    }
    if (event.kind === 'acceptance') {
      if (typeof event.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(event.payloadHash) ||
        typeof event.digest !== 'string' || !/^[0-9a-f]{64}$/.test(event.digest) ||
        !['accepted', 'superseded'].includes(String(event.disposition)) ||
        typeof event.remoteMutationStamp !== 'string' ||
        !/^\d{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$/.test(event.remoteMutationStamp) ||
        !Array.isArray(event.tuples) || event.tuples.length < 1) fence('Acceptance chain event is invalid.');
      for (const entry of event.tuples) {
        const accepted = entry as Record<string, unknown> | null;
        if (!accepted || typeof accepted !== 'object' || !Number.isSafeInteger(accepted.outboxId) ||
          !['accepted', 'superseded'].includes(String(accepted.disposition))) fence('Acceptance tuple is invalid.');
        const tuple = tuples.get(Number(accepted.outboxId));
        if (!tuple || tuple.acceptedDisposition !== null) fence('Acceptance has no pending captured tuple.');
        const exact = tuple.payloadHash === event.payloadHash && tuple.digest === event.digest;
        const validAccepted = exact && event.disposition === 'accepted' &&
          event.remoteMutationStamp === tuple.record.mutationStamp;
        const validSuperseded = !['habit_action', 'ledger_entry'].includes(tuple.record.entityType) &&
          event.remoteMutationStamp > tuple.record.mutationStamp && (!exact || event.disposition === 'superseded');
        if (accepted.disposition === 'accepted' ? !validAccepted : !validSuperseded) {
          fence('Acceptance tuple does not match immutable upload evidence.');
        }
        tuple.acceptedDisposition = accepted.disposition as 'accepted' | 'superseded';
        tuple.acceptedStamp = event.remoteMutationStamp;
      }
      continue;
    }
    fence('Operation chain event kind is unsupported.');
  }
  if (preparedEvents.size !== rows.size) fence('Operation row has no prepared chain event.');
  if (Number(view.prepare('SELECT count(*) AS n FROM tuples').get()!.n) !== tuples.size) {
    fence('Operation tuple has no captured chain event.');
  }
  for (const tuple of tuples.values()) {
    if (tuple.storedDisposition !== tuple.acceptedDisposition || tuple.storedStamp !== tuple.acceptedStamp) {
      fence('Stored tuple disposition has no matching acceptance evidence.');
    }
  }
  for (const [key, operation] of rows) {
    if (!capturedEvents.has(key)) {
      const [clientId, operationId] = JSON.parse(key) as [string, string];
      if (operation.state !== 'prepared' || operation.result !== null || operation.delivery !== 'unknown' ||
        view.prepare('SELECT 1 FROM tuples WHERE client_id = ? AND operation_id = ? LIMIT 1').get(clientId, operationId)) {
        fence('Prepared operation has no matching capture evidence.');
      }
      prepared = true;
      continue;
    }
    const dispositions = operation.tupleIds.map(id => tuples.get(id)!.acceptedDisposition);
    let expected: { state: string; delivery: string };
    if (operation.resultOk === false) expected = { state: 'rejected', delivery: 'not_required' };
    else if (dispositions.length === 0) expected = { state: 'completed_no_mutation', delivery: 'not_required' };
    else if (dispositions.some(value => value === null)) expected = { state: 'pending_sync', delivery: 'pending' };
    else expected = { state: 'backend_acknowledged', delivery: dispositions.includes('superseded') ? 'superseded' : 'acknowledged' };
    if ((operation.resultOk === false && dispositions.length > 0) ||
      operation.state !== expected.state || operation.delivery !== expected.delivery) {
      fence('Operation row state does not match immutable capture evidence.');
    }
  }
  return prepared;
}

// a provider cutoff can precede the first operation, but still needs an independent durable barrier marker.
export async function ensureDeliveryHistory(directory: string, binding: DeliveryGrantBinding, product: SqlDatabase,
  history: Pick<AccountReplica, 'operationHistoryState' | 'markOperationHistory'>): Promise<void> {
  const statePath = join(directory, 'operations.sqlite');
  if (existsSync(statePath)) {
    if (history.operationHistoryState !== 'initialized') fence('Operation provenance marker and sidecar disagree.');
    secureFile(statePath); return;
  }
  if (history.operationHistoryState !== 'never') fence('Operation history cannot be reinitialized.');
  if (existsSync(join(directory, 'journal.sqlite')) ||
    await product.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipts'") &&
    await product.getFirstAsync('SELECT command_id FROM command_receipts LIMIT 1')) {
    fence('Operation provenance is missing before delivery cutoff.');
  }
  history.markOperationHistory();
  secureFile(statePath, true);
  const state = new DatabaseSync(statePath);
  try {
    state.exec(`PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; ${sidecarSchema} PRAGMA user_version = 1;`);
    const generation = randomUUID();
    state.prepare('INSERT INTO runtime_meta VALUES (1, ?, ?, ?, ?, 0)')
      .run(binding.accountId, binding.backendUrl, binding.principal, generation);
    state.prepare('INSERT INTO delivery_anchor VALUES (1, ?, 0)').run(generation);
    state.exec('COMMIT');
    const fd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (cause) { try { state.exec('ROLLBACK'); } catch { /* no active transaction remains after commit. */ } throw cause; }
  finally { state.close(); }
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw signal.reason; }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function validateOperationPolicy(policy: OperationPolicy): void {
  if (!policy?.latch || typeof policy.latch.assertReady !== 'function' || typeof policy.authorize !== 'function' ||
    typeof policy.normalize !== 'function' || (policy.maxOperations !== undefined &&
      (!Number.isSafeInteger(policy.maxOperations) || policy.maxOperations < 1)) ||
    (policy.delivery !== undefined && typeof policy.delivery?.grantStatus !== 'function')) {
    throw new Error('Operation policy requires a restore latch, current-grant authorization and normalization.');
  }
}

export async function authorizeAccountControl(policy: OperationPolicy, env: OperationEnvironment): Promise<void> {
  active(env); await env.assertActive();
  await policy.authorize({ context: env.context, action: 'control', intent: null, originGrantId: null });
  active(env); await env.assertActive();
}

// one instance belongs to one actor turn. no session or mutable current-user state survives it.
export class AccountOperations {
  private adapter!: RecoveryHeadAdapter;
  private journal!: OperationJournal;
  private barrier?: DeliveryBarrier;
  lastDeliveryStatus: 'up_to_date' | 'offline' | 'signed_out' | 'needs_attention' | 'idle' | 'syncing' | null = null;
  private constructor(private readonly env: OperationEnvironment, private readonly policy: OperationPolicy,
    private readonly state: DatabaseSync, private readonly client: Client, private readonly journalPath: string) {}

  static async open(env: OperationEnvironment, policy: OperationPolicy, create: boolean): Promise<AccountOperations | null> {
    const statePath = join(env.directory, 'operations.sqlite'), journalPath = join(env.directory, 'journal.sqlite');
    const stateExists = existsSync(statePath), journalExists = existsSync(journalPath);
    const table = await env.db.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipts'");
    const receipts = table && await env.db.getFirstAsync('SELECT command_id FROM command_receipts LIMIT 1');
    if (!stateExists && (journalExists || receipts)) fence('Operation provenance and generation are missing.');
    if (stateExists ? env.history.operationHistoryState !== 'initialized' : env.history.operationHistoryState !== 'never') {
      fence('Operation provenance marker and sidecar disagree.');
    }
    if (!stateExists && !create) return null;
    active(env); await env.assertActive(); await policy.latch.assertReady();
    if (!stateExists && !hasOperationAuthority(env.context)) fence('Read authority cannot initialize operation history.');
    let fetches = 0;
    const client = createClient({ url: env.context.backendUrl, token: env.context.session.token,
      readOnly: env.context.session.scope === 'read', fetch: async (input, init) => {
        active(env); await env.assertActive(); env.checkDisk();
        if (++fetches > env.maxFetches) fence('Operation recovery fetch budget exceeded.');
        const request = new Request(input, init), path = new URL(request.url).pathname;
        const read = request.method === 'GET' || (request.method === 'POST' && path.startsWith('/q/'));
        const metadata = request.method === 'POST' && ['/m/initializeMcpRecoveryHead', '/m/advanceMcpRecoveryHead'].includes(path);
        if (!read && (!metadata || !hasOperationAuthority(env.context))) {
          throw new OperationRuntimeError('FORBIDDEN', 'Only authorized recovery metadata can be published.');
        }
        const result = await bounded((env.fetch ?? fetch)(request, { signal: AbortSignal.any([env.signal, request.signal]) }), env.signal);
        active(env); return result;
      } });
    let state: DatabaseSync | undefined, runtime: AccountOperations | undefined;
    try {
      const remote = createSnapbackRecoveryRemote(client);
      if (!stateExists) {
        await policy.authorize({ context: env.context, action: 'recover', intent: null, originGrantId: null });
        active(env);
        if (await remote.read() !== null) fence('Existing remote operation history has no local generation.');
        env.history.markOperationHistory();
        secureFile(statePath, true);
      } else secureFile(statePath);
      state = new DatabaseSync(statePath);
      state.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL');
      if (!stateExists) {
        state.exec(`BEGIN IMMEDIATE; ${sidecarSchema} PRAGMA user_version = 1;`);
        state.prepare('INSERT INTO runtime_meta VALUES (1, ?, ?, ?, ?, 0)')
          .run(env.context.accountId, env.context.backendUrl, env.context.principal, randomUUID());
        state.prepare('INSERT INTO delivery_anchor VALUES (1, (SELECT generation FROM runtime_meta WHERE id = 1), 0)').run();
        state.exec('COMMIT');
        const fd = openSync(env.directory, constants.O_RDONLY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      const meta = state.prepare('SELECT * FROM runtime_meta WHERE id = 1').get();
      if (state.prepare('PRAGMA user_version').get()?.user_version !== 1 || !meta ||
        meta.account_id !== env.context.accountId || meta.backend_url !== env.context.backendUrl || meta.principal !== env.context.principal ||
        typeof meta.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(meta.generation) || ![0, 1].includes(Number(meta.journal_ready))) {
        fence('Operation runtime schema or identity binding is unknown.');
      }
      const actual = state.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.sql);
      const actualSchema = JSON.stringify(actual.map(sql => String(sql).trim()).sort());
      const expected = JSON.stringify(schemaRows(sidecarSchema));
      const legacy = JSON.stringify(schemaRows(legacySidecarSchema));
      if (actualSchema !== expected && !(actualSchema === legacy && !policy.delivery)) fence('Operation runtime schema does not match its release.');
      if (!journalExists && (meta.journal_ready === 1 || !hasOperationAuthority(env.context))) fence('Retained operation journal is missing.');
      if (!journalExists && await remote.read() !== null) fence('Remote operation history cannot reconstruct a missing local journal.');
      if (journalExists) secureFile(journalPath); else secureFile(journalPath, true);
      runtime = new AccountOperations(env, policy, state, client, journalPath);
      try {
        runtime.journal = new OperationJournal({ location: journalPath, accountId: env.context.accountId,
          generation: meta.generation, product: env.db, nowUtcMs: () => env.nowUtcMs,
          normalize: (request, frozen) => runtime!.normalize(request, frozen),
          execute: intent => runtime!.execute(intent), authorize: (intent, action) => runtime!.authorizeIntent(intent, action),
          publish: head => runtime!.publish(head), failpoint: policy.failpoint });
      } catch { fence('Operation journal schema, generation or ancestry requires reconciliation.'); }
      runtime.adapter = new RecoveryHeadAdapter({ owner: env.context.principal, journal: runtime.journal, remote,
        latch: policy.latch, authorize: () => runtime!.authorizePublication() });
      if (policy.delivery) runtime.barrier = new DeliveryBarrier(env.directory, env.context, policy.delivery);
      if (meta.journal_ready === 0) {
        if (!hasOperationAuthority(env.context)) fence('Operation initialization is incomplete.');
        state.exec('UPDATE runtime_meta SET journal_ready = 1 WHERE id = 1');
      }
      runtime.inspect();
      return runtime;
    } catch (cause) {
      runtime?.barrier?.close(); runtime?.journal?.close(); state?.close(); await client.close();
      if (typeof cause === 'object' && cause !== null && 'code' in cause && String(cause.code).startsWith('ERR_SQLITE')) {
        fence('Operation runtime storage or schema requires reconciliation.');
      }
      throw cause;
    }
  }

  // a latched restore may still serve product reads after a read-only, exact-session history comparison.
  // this path never constructs a journal writer or initializes operation provenance.
  static async inspectFencedRead(env: OperationEnvironment, policy: OperationPolicy): Promise<RecoveryStatus> {
    active(env); await env.assertActive();
    const statePath = join(env.directory, 'operations.sqlite'), journalPath = join(env.directory, 'journal.sqlite');
    const stateExists = existsSync(statePath), journalExists = existsSync(journalPath);
    const table = await env.db.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipts'");
    const receipts = table && await env.db.getFirstAsync('SELECT command_id FROM command_receipts LIMIT 1');
    if (!stateExists && (journalExists || receipts)) fence('Operation provenance and generation are missing.');
    if (stateExists ? env.history.operationHistoryState !== 'initialized' : env.history.operationHistoryState !== 'never') {
      fence('Operation provenance marker and sidecar disagree.');
    }
    let fetches = 0;
    const client = createClient({ url: env.context.backendUrl, token: env.context.session.token,
      readOnly: env.context.session.scope === 'read', fetch: async (input, init) => {
        active(env); await env.assertActive(); env.checkDisk();
        if (++fetches > env.maxFetches) fence('Operation recovery fetch budget exceeded.');
        const request = new Request(input, init), path = new URL(request.url).pathname;
        if (request.method !== 'GET' && !(request.method === 'POST' && path.startsWith('/q/'))) {
          throw new OperationRuntimeError('FORBIDDEN', 'Restored reads permit recovery queries only.');
        }
        const result = await bounded((env.fetch ?? fetch)(request, { signal: AbortSignal.any([env.signal, request.signal]) }), env.signal);
        active(env); return result;
      } });
    let state: DatabaseSync | undefined, view: DatabaseSync | undefined;
    try {
      const remote = createSnapbackRecoveryRemote(client);
      const remoteHead = async () => {
        try { return await remote.read(); }
        catch { fence('Restored read cannot verify the remote operation head.'); }
      };
      if (!stateExists) {
        if (existsSync(join(env.directory, 'delivery.sqlite')) || await remoteHead() !== null) {
          fence('Remote operation or delivery history has no local generation.');
        }
      } else {
        secureFile(statePath);
        state = new DatabaseSync(statePath, { readOnly: true });
        const meta = state.prepare('SELECT * FROM runtime_meta WHERE id = 1').get();
        if (state.prepare('PRAGMA user_version').get()?.user_version !== 1 || !meta ||
          meta.account_id !== env.context.accountId || meta.backend_url !== env.context.backendUrl ||
          meta.principal !== env.context.principal || typeof meta.generation !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(meta.generation) || ![0, 1].includes(Number(meta.journal_ready))) {
          fence('Operation runtime schema or identity binding is unknown.');
        }
        const actual = state.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
          .map(row => String(row.sql).trim()).sort();
        const expected = schemaRows(sidecarSchema), legacy = schemaRows(legacySidecarSchema);
        if (JSON.stringify(actual) !== JSON.stringify(expected) &&
          !(JSON.stringify(actual) === JSON.stringify(legacy) && !policy.delivery)) {
          fence('Operation runtime schema does not match its release.');
        }
        if (policy.delivery) {
          const anchor = state.prepare('SELECT generation, initialized FROM delivery_anchor WHERE id = 1').get();
          const exists = existsSync(join(env.directory, 'delivery.sqlite'));
          if (!anchor || anchor.generation !== meta.generation || ![0, 1].includes(Number(anchor.initialized)) ||
            (anchor.initialized === 1 && !exists) || (anchor.initialized === 0 && exists)) {
            fence('Delivery provenance marker requires reconciliation.');
          }
        }
        if (!journalExists) fence('Retained operation journal is missing or incomplete.');
        else {
          if (meta.journal_ready !== 1) fence('Operation initialization is incomplete.');
          secureFile(journalPath);
          view = new DatabaseSync(journalPath, { readOnly: true });
          const journalMeta = view.prepare('SELECT * FROM journal_meta WHERE id = 1').get();
          const releasedSchema = view.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid").all()
            .map(row => String(row.sql)).join(';\n') + ';';
          const actualHash = createHash('sha256').update(releasedSchema).digest('hex');
          if (view.prepare('PRAGMA user_version').get()?.user_version !== 1 || !journalMeta ||
            journalMeta.version !== 1 || journalMeta.schema_hash !== journalSchemaHash ||
            actualHash !== journalSchemaHash || journalMeta.account_id !== env.context.accountId ||
            journalMeta.generation !== meta.generation) fence('Operation journal schema, generation or ancestry requires reconciliation.');
          if (inspectOrigins(state, view, policy.maxOperations ?? 10_000, env.context.accountId)) {
            fence('Prepared operation must be recovered before account reads.');
          }
          const reader = {
            head: (): JournalHead => {
              const row = view!.prepare('SELECT sequence, previous_hash, head_hash FROM journal_chain ORDER BY sequence DESC LIMIT 1').get();
              return { generation: String(meta.generation), sequence: row ? Number(row.sequence) : 0,
                headHash: row ? String(row.head_hash) : GENESIS_HASH,
                previousHash: row ? String(row.previous_hash) : GENESIS_HASH };
            },
            entryAt: (sequence: number) => {
              if (sequence === 0) return { generation: String(meta.generation), sequence, headHash: GENESIS_HASH,
                previousHash: GENESIS_HASH, event: '' };
              const row = view!.prepare('SELECT * FROM journal_chain WHERE sequence = ?').get(sequence);
              return row ? { generation: String(meta.generation), sequence, headHash: String(row.head_hash),
                previousHash: String(row.previous_hash), event: String(row.event) } : null;
            },
          };
          const adapter = new RecoveryHeadAdapter({ owner: env.context.principal, journal: reader, remote,
            latch: { assertReady: () => undefined }, authorize: async () => { fence('Restored reads cannot publish operation heads.'); } });
          if (await adapter.compare() !== 'current') fence('Operation recovery head is incomplete.');
        }
      }
      active(env); await env.assertActive();
      return Object.freeze({ writeFenced: true, deliveryPaused: true,
        reconnectRequired: false, recoveryReason: 'restore_latched' });
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && String(cause.code).startsWith('ERR_SQLITE')) {
        fence('Operation runtime storage or schema requires reconciliation.');
      }
      throw cause;
    } finally { view?.close(); state?.close(); await client.close(); }
  }

  private inspect(): boolean {
    const view = new DatabaseSync(this.journalPath, { readOnly: true });
    try {
      return inspectOrigins(this.state, view, this.policy.maxOperations ?? 10_000, this.env.context.accountId);
    } finally { view.close(); }
  }

  private async authorizePublication(): Promise<void> {
    active(this.env); await this.env.assertActive();
    if (!hasOperationAuthority(this.env.context)) throw new OperationRuntimeError('FORBIDDEN', 'A current full write grant is required.');
    await this.policy.authorize({ context: this.env.context, action: 'publish', intent: null, originGrantId: null });
    active(this.env); await this.env.assertActive();
  }

  private async publish(head: JournalHead): Promise<void> {
    active(this.env); await this.env.assertActive();
    if (hasOperationAuthority(this.env.context)) await this.adapter.publish(head);
    else if (await this.adapter.compare() !== 'current') fence('Read authority cannot publish incomplete operation recovery.');
    active(this.env); this.env.checkDisk();
  }

  async recover(): Promise<RecoveryStatus> {
    active(this.env); await this.env.assertActive();
    if (hasOperationAuthority(this.env.context)) {
      await this.policy.authorize({ context: this.env.context, action: 'recover', intent: null, originGrantId: null });
      await this.journal.recover();
    } else if (await this.adapter.compare() !== 'current' || this.inspect()) {
      fence('Read authority cannot recover or execute prepared operation intent.');
    }
    this.inspect(); active(this.env);
    return Object.freeze({ writeFenced: !hasOperationAuthority(this.env.context), deliveryPaused: true,
      reconnectRequired: false, recoveryReason: this.barrier ? 'delivery_barrier' : 'delivery_pending_m13' });
  }

  private async authorizeIntent(intent: FrozenIntent, action: 'execute' | 'read' | 'deliver'): Promise<void> {
    active(this.env); await this.env.assertActive();
    await this.policy.latch.assertReady();
    const origin = this.state.prepare('SELECT grant_id, tool FROM operation_grants WHERE client_id = ? AND operation_id = ?')
      .get(intent.clientId, intent.operationId);
    if (!origin || origin.tool !== intent.tool || intent.accountId !== this.env.context.accountId) fence('Operation origin is unknown.');
    if (!hasToolScope(contracts[intent.tool], this.env.context.scopes)) {
      throw new OperationRuntimeError('FORBIDDEN', 'Original operation permissions are required.');
    }
    if (action === 'deliver' && !this.barrier) fence('Operation delivery is parked until M13.');
    if (action === 'execute') this.barrier?.assertMutationAllowed();
    if (action === 'execute' && (!hasOperationAuthority(this.env.context) || intent.clientId !== this.env.context.clientId ||
      origin.grant_id !== this.env.context.grantId)) {
      throw new OperationRuntimeError('FORBIDDEN', 'Prepared execution requires its original active client and grant.');
    }
    if (action === 'read' && intent.clientId !== this.env.context.clientId) throw new OperationRuntimeError('FORBIDDEN', 'Operation client lineage does not match.');
    await this.policy.authorize({ context: this.env.context, action, intent, originGrantId: String(origin.grant_id) });
    active(this.env); await this.env.assertActive(); await this.policy.latch.assertReady();
  }

  private async normalize(request: MutationRequest, frozen: Pick<NormalizeContext, 'commandId' | 'nowUtcMs'>) {
    let activeRead = true;
    const guard = (sql: string) => {
      active(this.env);
      if (!activeRead || !/^\s*(?:SELECT|WITH)\b/i.test(sql)) throw new OperationRuntimeError('FORBIDDEN', 'Normalization permits scoped read queries only.');
    };
    await this.env.db.execAsync('PRAGMA query_only = ON');
    try {
      const read: NormalizeContext['read'] = Object.freeze({
        getFirstAsync: <T>(sql: string, params?: Parameters<SqlExecutor['getFirstAsync']>[1]) => { guard(sql); return this.env.db.getFirstAsync<T>(sql, params); },
        getAllAsync: <T>(sql: string, params?: Parameters<SqlExecutor['getAllAsync']>[1]) => { guard(sql); return this.env.db.getAllAsync<T>(sql, params); },
      });
      return await this.policy.normalize(request, Object.freeze({ ...frozen, context: this.env.context, read,
        undoTarget: async (operationId: string) => {
          guard('SELECT');
          const original = await this.journal.get(this.env.context.clientId, operationId);
          const target = await this.journal.undoTarget(this.env.context.clientId, operationId);
          guard('SELECT');
          if (!original) fence('Original create intent disappeared during undo normalization.');
          return { ...target, timeZone: original.intent.timeZone };
        } }));
    } finally { activeRead = false; await this.env.db.execAsync('PRAGMA query_only = OFF'); }
  }

  private async execute(intent: FrozenIntent) {
    await this.authorizeIntent(intent, 'execute');
    const product = this.env.db;
    // the core still opens its own transaction; wrap its callback to check the grant before commit.
    const db: SqlDatabase = {
      runAsync: product.runAsync.bind(product), getAllAsync: product.getAllAsync.bind(product), getFirstAsync: product.getFirstAsync.bind(product),
      execAsync: product.execAsync.bind(product), closeAsync: async () => { fence('Command cannot close its account owner.'); },
      withTransactionAsync: product.withTransactionAsync.bind(product),
      withExclusiveTransactionAsync: work => product.withExclusiveTransactionAsync(async tx => {
        await this.authorizeIntent(intent, 'execute');
        const value = await work(tx);
        await this.authorizeIntent(intent, 'execute');
        return value;
      }),
    };
    const ports = createCorePorts(intent.timeZone, intent.nowUtcMs);
    Object.freeze(ports.clock); Object.freeze(ports.hashing); Object.freeze(ports.ids); Object.freeze(ports);
    switch (intent.command.tool) {
      case 'create_checkin': return createCheckIn({ db, ...ports }, intent.command.input);
      case 'undo_checkin': return undoCreatedCheckIn({ db, ...ports }, intent.command.input);
      case 'claim_reward': return claimReward({ db, ...ports }, intent.command.input);
    }
  }

  async run(request: MutationRequest): Promise<JournalOperation> {
    active(this.env); await this.env.assertActive();
    if (this.barrier) {
      await this.barrier.assertCurrent(this.env.context);
      await this.barrier.refreshRevokedOrigins(this.env.context, this.env.db);
      this.barrier.assertMutationAllowed();
    }
    if (!hasOperationAuthority(this.env.context) || request.clientId !== this.env.context.clientId) {
      throw new OperationRuntimeError('FORBIDDEN', 'A matching current full write grant is required.');
    }
    const operationId = request.input.operationId.toLowerCase();
    const origin = this.state.prepare('SELECT grant_id, tool FROM operation_grants WHERE client_id = ? AND operation_id = ?').get(request.clientId, operationId);
    if (origin && origin.tool !== request.tool) throw new JournalError('IDEMPOTENCY_CONFLICT', 'Operation id is already bound to another tool.');
    await this.policy.authorize({ context: this.env.context, action: 'prepare', intent: null,
      originGrantId: origin ? String(origin.grant_id) : this.env.context.grantId, request });
    active(this.env); await this.env.assertActive();
    if (!origin) {
      if (Number(this.state.prepare('SELECT count(*) AS n FROM operation_grants').get()!.n) >= (this.policy.maxOperations ?? 10_000)) {
        throw new OperationRuntimeError('RATE_LIMITED', 'Durable operation admission is full.');
      }
      this.state.prepare('INSERT INTO operation_grants VALUES (?, ?, ?, ?)').run(request.clientId, operationId, this.env.context.grantId, request.tool);
    }
    const result = await this.journal.run(request);
    await this.authorizeIntent(result.intent, 'read'); this.env.checkDisk(); return result;
  }

  lookup(operationId: string): Promise<JournalOperation | null> { return this.journal.get(this.env.context.clientId, operationId); }

  private async authorizeDelivery(): Promise<void> {
    if (!this.barrier) fence('Operation delivery is not configured.');
    active(this.env); await this.env.assertActive(); await this.policy.latch.assertReady();
    await this.barrier.assertCurrent(this.env.context);
    await this.policy.authorize({ context: this.env.context, action: 'deliver', intent: null, originGrantId: null });
    active(this.env); await this.env.assertActive(); await this.policy.latch.assertReady();
  }

  async deliveryPaused(): Promise<boolean> {
    if (!this.barrier || !hasOperationAuthority(this.env.context)) return true;
    try {
      await this.authorizeDelivery();
      await this.barrier.authorizeQueue(this.env.context, this.env.db);
      await this.journal.beforeDelivery();
      return this.barrier.exceedsWindow(this.env.db);
    } catch (cause) {
      if (cause instanceof DeliveryBarrierError || cause instanceof OperationRuntimeError || cause instanceof JournalError) return true;
      throw cause;
    }
  }

  async resumeDelivery(confirmOwnerDecision: () => Promise<void>): Promise<number> {
    if (!this.barrier) fence('Operation delivery is not configured.');
    await this.authorizeDelivery();
    await this.policy.authorize({ context: this.env.context, action: 'resume', intent: null, originGrantId: null });
    await confirmOwnerDecision();
    await this.authorizeDelivery();
    await this.barrier.refreshRevokedOrigins(this.env.context, this.env.db, true);
    if (this.inspect()) fence('Prepared operation must be reconciled by its original grant before owner resume.');
    await this.adapter.publish(this.journal.head());
    await this.authorizeDelivery();
    return this.barrier.resume(this.env.context, this.env.db);
  }

  async deliver(): Promise<void> {
    if (!this.barrier || !hasOperationAuthority(this.env.context)) return;
    try {
      await this.authorizeDelivery();
      await this.barrier.authorizeQueue(this.env.context, this.env.db);
      await this.journal.beforeDelivery();
      await this.authorizeDelivery();
    } catch (cause) {
      if (cause instanceof DeliveryBarrierError || cause instanceof OperationRuntimeError || cause instanceof JournalError) {
        this.lastDeliveryStatus = 'needs_attention'; return;
      }
      throw cause;
    }
    let fetches = 0, bytes = 0;
    const client = createClient({ url: this.env.context.backendUrl, token: this.env.context.session.token,
      fetch: async (input, init) => {
        await this.authorizeDelivery(); this.env.checkDisk();
        if (++fetches > this.env.maxFetches) fence('Delivery network request budget exceeded.');
        const request = new Request(input, init), path = new URL(request.url).pathname;
        if (request.method !== 'POST' || !(/^\/q\//.test(path) ||
          ['/m/ensureAccount', '/m/beginUpload', '/m/uploadPart', '/m/finishUpload', '/m/uploadRecord'].includes(path))) {
          throw new OperationRuntimeError('FORBIDDEN', 'Delivery transport route is not authorized.');
        }
        bytes += (await request.clone().arrayBuffer()).byteLength;
        if (bytes > 16 * 1024 * 1024) fence('Delivery byte budget exceeded.');
        const response = await bounded((this.env.fetch ?? fetch)(request, {
          signal: AbortSignal.any([this.env.signal, request.signal]) }), this.env.signal);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > 16 * 1024 * 1024 - bytes) fence('Delivery byte budget exceeded.');
        bytes += (await response.clone().arrayBuffer()).byteLength;
        if (bytes > 16 * 1024 * 1024) fence('Delivery byte budget exceeded.');
        // upload-record acceptance is recorded by onUpload before checking a changed grant.
        if (path !== '/m/uploadRecord') await this.authorizeDelivery();
        return response;
      } });
    try {
      const source = createSnapbackTransport({ connection: async () => ({ client, session: this.env.context.session,
        isCurrent: () => !this.env.signal.aborted && this.env.context.session.expiresAt > Date.now() }),
        bind: async () => { await this.authorizeDelivery(); },
        hash: async text => createHash('sha256').update(text).digest('hex'),
        onUpload: async evidence => {
          await this.journal.recordUploadAcceptance(evidence);
          await this.authorizeDelivery();
        } });
      const transport = { ensureZone: source.ensureZone,
        upload: (records: WireSyncRecord[]) => source.upload(records, () => !this.env.signal.aborted),
        fetchChanges: (token: string | null) => source.fetchChanges(token, () => !this.env.signal.aborted) };
      for (let pass = 0; pass < 3; pass++) {
        const passMaxId = await this.barrier.authorizeQueue(this.env.context, this.env.db);
        const outcome = await runSync({ db: this.env.db, ...createCorePorts('UTC', this.env.nowUtcMs), transport, random: () => 0.5,
          delivery: { authorize: async () => {
            await this.authorizeDelivery();
            await this.barrier!.authorizeQueue(this.env.context, this.env.db, passMaxId);
            await this.journal.beforeDelivery();
          }, beforeQueueClear: async ids => {
            await this.authorizeDelivery();
            if (ids.some(id => id > passMaxId)) fence('Delivery batch exceeded its frozen queue boundary.');
            await this.barrier!.authorizeQueue(this.env.context, this.env.db, passMaxId);
            await this.journal.beforeQueueClear(ids);
            await this.authorizeDelivery();
          } }, shouldContinue: () => !this.env.signal.aborted });
        this.journal.afterQueueClear();
        const pending = await this.env.db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM mutation_outbox');
        this.lastDeliveryStatus = outcome.ok ? outcome.value.status : 'needs_attention';
        if (this.lastDeliveryStatus !== 'up_to_date' || pending?.count === 0) break;
        if (pass === 2) this.lastDeliveryStatus = 'needs_attention';
      }
    } finally { await client.close(); }
  }

  async operationAfterDelivery(operationId: string): Promise<JournalOperation | null> {
    return this.journal.get(this.env.context.clientId, operationId);
  }
  async close(): Promise<void> {
    try { this.barrier?.close(); this.journal.close(); } finally { try { this.state.close(); } finally { await this.client.close(); } }
  }
}
