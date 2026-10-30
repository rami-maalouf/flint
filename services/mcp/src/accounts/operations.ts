import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClient, type Client } from 'snapback4/client';

import type { SqlDatabase, SqlExecutor } from '../../../../src/core/persistence/database';
import type { WireSyncRecord } from '../../../../src/core/sync/transport';
import type { AuthContext } from '../auth/context';
import { claimReward, createCheckIn, createCorePorts, createSnapbackTransport, runSync, undoCreatedCheckIn } from '../core';
import { JournalError, OperationJournal, type CoreCommand, type Failpoint, type FrozenIntent, type JournalHead,
  type JournalOperation, type MutationRequest } from '../operations/journal';
import { createSnapbackRecoveryRemote, RecoveryHeadAdapter, type RestoreLatch } from '../operations/recovery-head';
import { contracts, hasToolScope } from '../tools/contracts';
import type { RecoveryStatus } from './actor';
import { DeliveryBarrier, DeliveryBarrierError, type DeliveryGrantBinding, type DeliveryPolicy } from './delivery';

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
  checkDisk: () => void; maxFetches: number }>;

const legacySidecarSchema = `CREATE TABLE runtime_meta (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
  backend_url TEXT NOT NULL, principal TEXT NOT NULL, generation TEXT NOT NULL, journal_ready INTEGER NOT NULL);
CREATE TABLE operation_grants (client_id TEXT NOT NULL, operation_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  tool TEXT NOT NULL, PRIMARY KEY (client_id, operation_id));`;
const sidecarSchema = `${legacySidecarSchema}
CREATE TABLE delivery_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL,
  initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)));`;
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

// a provider cutoff can precede the first operation, but still needs an independent durable barrier marker.
export async function ensureDeliveryHistory(directory: string, binding: DeliveryGrantBinding, product: SqlDatabase): Promise<void> {
  const statePath = join(directory, 'operations.sqlite');
  if (existsSync(statePath)) { secureFile(statePath); return; }
  if (existsSync(join(directory, 'journal.sqlite')) ||
    await product.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipts'") &&
    await product.getFirstAsync('SELECT command_id FROM command_receipts LIMIT 1')) {
    fence('Operation provenance is missing before delivery cutoff.');
  }
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

  private inspect(): boolean {
    const view = new DatabaseSync(this.journalPath, { readOnly: true });
    try {
      const limit = this.policy.maxOperations ?? 10_000;
      const count = Number(this.state.prepare('SELECT count(*) AS n FROM operation_grants').get()!.n);
      const operations = view.prepare('SELECT client_id, operation_id, state, json_extract(intent, \'$.tool\') AS tool FROM operations LIMIT ?').all(limit + 1);
      if (count > limit || operations.length > limit) fence('Operation history exceeds its configured admission bound.');
      let prepared = false;
      for (const operation of operations) {
        const origin = this.state.prepare('SELECT grant_id, tool FROM operation_grants WHERE client_id = ? AND operation_id = ?')
          .get(operation.client_id, operation.operation_id);
        if (!origin || origin.tool !== operation.tool || typeof origin.grant_id !== 'string' || !origin.grant_id) {
          fence('Operation grant provenance is missing or inconsistent.');
        }
        prepared ||= operation.state === 'prepared';
      }
      return prepared;
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
