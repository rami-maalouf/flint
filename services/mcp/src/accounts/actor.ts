import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient } from 'snapback4/client';

import type { SqlDatabase, SqlExecutor } from '../../../../src/core/persistence/database';
import { SyncTransportError, type SyncTransport, type WireSyncRecord } from '../../../../src/core/sync/transport';
import type { AuthContext } from '../auth/context';
import { createCorePorts, createSnapbackTransport, getSyncSummary, initializeProductDatabase, runSync } from '../core';
import { contracts, hasToolScope, timeZone, type Metadata } from '../tools/contracts';
import type { JournalOperation, MutationRequest } from '../operations/journal';
import { RecoveryFenceError } from '../operations/recovery-head';
import { AccountReplica, privateDirectory, type ReplicaLimits } from './replica';
import { DeliveryBarrier, type DeliveryGrantBinding } from './delivery';
import { AccountOperations, authorizeAccountControl, ensureDeliveryHistory, hasOperationAuthority, validateOperationPolicy,
  type OperationEnvironment, type OperationPolicy } from './operations';

export class AccountError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'RECONNECT_REQUIRED' | 'SYNC_ATTENTION' | 'UNAVAILABLE' |
    'RATE_LIMITED' | 'OPERATION_PENDING', message: string, readonly retryable = true) { super(message); }
}

export type RecoveryStatus = Readonly<{ writeFenced: boolean; deliveryPaused: boolean;
  reconnectRequired: boolean; recoveryReason: string | null }>;
type Ports = ReturnType<typeof createCorePorts>;
export type RecoveryContext = Readonly<{ db: SqlDatabase; directory: string; context: AuthContext;
  ports: Ports; signal: AbortSignal; assertActive: () => Promise<void> }>;
export type AccountOptions = Partial<ReplicaLimits> & {
  root: string; backendUrl: string; fetch?: typeof fetch;
  maxOpenReplicas?: number; maxQueuedPerAccount?: number; maxOutstanding?: number;
  requestTimeoutMs?: number; pullTimeoutMs?: number; maxPullPages?: number; maxQueryPages?: number; idleMs?: number;
  // trusted integration point: recover retained journals and compare restore fencing before any core work.
  recover?: (context: RecoveryContext) => Promise<RecoveryStatus>;
  operationPolicy?: OperationPolicy;
};
export type ReadOptions = { timeZone?: string; freshness?: 'require_sync' | 'allow_cached' };
export type AccountRuntime = Readonly<Ports & { db: SqlDatabase; meta: Metadata;
  recovery: RecoveryStatus; signal: AbortSignal }>;
type Entry = { lane: Promise<unknown>; pending: number; idleAt: number; replica?: AccountReplica };
type Limits = Required<Omit<AccountOptions, 'recover' | 'operationPolicy' | 'fetch' | 'root' | 'backendUrl'>>;
type LaneContext = { ctx: AuthContext; replica: AccountReplica; ports: Ports; signal: AbortSignal; authorize: () => Promise<void> };
export type AccountControlRuntime = Readonly<{ accountId: string; directory: string; signal: AbortSignal; assertActive: () => Promise<void> }>;

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function immutablePorts(zone: string): Ports {
  const ports = createCorePorts(zone);
  return Object.freeze({ clock: ports.clock, hashing: Object.freeze(ports.hashing), ids: Object.freeze(ports.ids) });
}

// the public capability expires with the request and cannot mutate the product or close its owner.
function readDatabase(db: SqlDatabase, signal: AbortSignal): { db: SqlDatabase; expire: () => void } {
  let active = true;
  const guard = () => { stopped(signal); if (!active) throw new AccountError('FORBIDDEN', 'Account read has finished.', false); };
  const denied = async (): Promise<never> => { throw new AccountError('FORBIDDEN', 'This account runtime is read-only.', false); };
  const read = (sql: string) => {
    guard();
    if (!/^\s*(?:SELECT|WITH)\b/i.test(sql)) throw new AccountError('FORBIDDEN', 'Only product read queries are allowed.', false);
  };
  const executor = (tx: SqlExecutor): SqlExecutor => Object.freeze({
    runAsync: denied,
    getAllAsync: <T>(sql: string, params?: Parameters<SqlExecutor['getAllAsync']>[1]) => { read(sql); return tx.getAllAsync<T>(sql, params); },
    getFirstAsync: <T>(sql: string, params?: Parameters<SqlExecutor['getFirstAsync']>[1]) => { read(sql); return tx.getFirstAsync<T>(sql, params); },
  });
  return { expire: () => { active = false; }, db: Object.freeze({ ...executor(db), execAsync: denied,
    withExclusiveTransactionAsync: denied, closeAsync: denied,
    withTransactionAsync: <T>(work: (tx: SqlExecutor) => Promise<T>) => {
      guard(); return db.withTransactionAsync(async tx => { guard(); const value = await work(executor(tx)); guard(); return value; });
    },
  }) };
}

const degraded: RecoveryStatus = Object.freeze({ writeFenced: true, deliveryPaused: true,
  reconnectRequired: false, recoveryReason: 'read_only_reconstruction' });

export class AccountActors {
  private readonly root: string;
  private readonly limits: Limits;
  private readonly entries = new Map<string, Entry>();
  private admission: Promise<unknown> = Promise.resolve();
  private outstanding = 0;
  private readonly operations = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: AccountOptions) {
    this.options = Object.freeze({ ...options });
    if (options.operationPolicy) {
      validateOperationPolicy(options.operationPolicy);
      if (options.recover) throw new Error('Choose the operation recovery policy or the legacy recovery hook.');
      this.options = Object.freeze({ ...options, operationPolicy: Object.freeze({ ...options.operationPolicy }) });
    }
    const url = new URL(options.backendUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      options.backendUrl !== url.href.replace(/\/+$/, '')) throw new Error('A canonical fixed backend URL is required.');
    this.root = resolve(options.root);
    privateDirectory(this.root);
    this.limits = { maxOpenReplicas: 16, maxQueuedPerAccount: 32, maxOutstanding: 128,
      requestTimeoutMs: 15_000, pullTimeoutMs: 10_000, maxPullPages: 64, maxQueryPages: 512, idleMs: 60_000,
      maxAccountBytes: 256 * 1024 * 1024, minFreeBytes: 64 * 1024 * 1024 };
    for (const key of Object.keys(this.limits) as (keyof Limits)[]) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid account limit: ${key}`);
        this.limits[key] = value;
      }
    }
    this.timer = setInterval(() => { void this.evictIdle().catch(() => undefined); }, Math.min(this.limits.idleMs, 30_000));
    this.timer.unref();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.admission.then(work);
    this.admission = result.catch(() => undefined);
    return result;
  }

  private async removeIdle(all = false): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && (all || Date.now() - entry.idleAt >= this.limits.idleMs)) {
        await entry.replica?.close();
        this.entries.delete(key);
      }
    }
  }

  evictIdle(): Promise<void> { return this.serialize(() => this.removeIdle()); }

  private async acquire(ctx: Pick<AuthContext, 'accountId'>, signal: AbortSignal): Promise<Entry> {
    return this.serialize(async () => {
      stopped(signal);
      if (this.closing) throw new AccountError('UNAVAILABLE', 'Account service is closing.');
      let entry = this.entries.get(ctx.accountId);
      if (!entry) {
        await this.removeIdle();
        if (this.entries.size >= this.limits.maxOpenReplicas) {
          // close the least recently used idle handle under capacity pressure, retaining all files.
          const candidate = [...this.entries].filter(([, value]) => value.pending === 0).sort((a, b) => a[1].idleAt - b[1].idleAt)[0];
          if (candidate) { await candidate[1].replica?.close(); this.entries.delete(candidate[0]); }
        }
        stopped(signal);
        if (this.entries.size >= this.limits.maxOpenReplicas) throw new AccountError('RATE_LIMITED', 'All account replica slots are busy.');
        entry = { lane: Promise.resolve(), pending: 0, idleAt: Date.now() };
        this.entries.set(ctx.accountId, entry);
      }
      if (entry.pending >= this.limits.maxQueuedPerAccount) throw new AccountError('RATE_LIMITED', 'The account queue is full.');
      entry.pending++;
      return entry;
    });
  }

  withAccount<T>(context: AuthContext, options: ReadOptions, work: (runtime: AccountRuntime) => Promise<T>): Promise<{ data: T; meta: Metadata }> {
    return this.serve(context, options, false, async (lane, meta, recovery) => {
      const capability = readDatabase(lane.replica.db, lane.signal);
      await lane.replica.db.execAsync('PRAGMA query_only = ON');
      try { return await work(Object.freeze({ ...lane.ports, db: capability.db, meta, recovery, signal: lane.signal })); }
      finally { capability.expire(); await lane.replica.db.execAsync('PRAGMA query_only = OFF'); }
    });
  }

  async runOperation(context: AuthContext, request: MutationRequest): Promise<{ data: JournalOperation; meta: Metadata }> {
    if (!this.options.operationPolicy || !hasOperationAuthority(context) || request.clientId !== context.clientId ||
      !['create_checkin', 'undo_checkin', 'claim_reward'].includes(request.tool) || !hasToolScope(contracts[request.tool], context.scopes)) {
      throw new AccountError('FORBIDDEN', 'A matching current full operation grant is required.', false);
    }
    const parsed = contracts[request.tool].input.safeParse(request.input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(request)) > 131_072) throw new AccountError('INVALID_INPUT', 'Invalid protected operation.', false);
    const captured = Object.freeze(JSON.parse(JSON.stringify({ clientId: request.clientId, tool: request.tool, input: parsed.data })) as MutationRequest);
    return this.serve(context, {}, true, async (_lane, _meta, _recovery, operations) => {
      if (!operations) throw new AccountError('OPERATION_PENDING', 'Operation runtime is unavailable.');
      const result = await operations.run(captured);
      await operations.deliver();
      return await operations.operationAfterDelivery(result.intent.operationId) ?? result;
    });
  }

  // provider-only lifecycle hook. the verified binding is not model or tool input.
  revokeDeliveryGrant(binding: DeliveryGrantBinding, commitRevocation: () => Promise<void>): Promise<void> {
    if (!this.options.operationPolicy?.delivery || typeof commitRevocation !== 'function' ||
      binding.backendUrl !== this.options.backendUrl || !binding.accountId || !binding.principal ||
      !binding.clientId || !binding.grantId) {
      return Promise.reject(new AccountError('FORBIDDEN', 'A trusted delivery grant binding is required.', false));
    }
    if (this.closing || this.outstanding >= this.limits.maxOutstanding) {
      return Promise.reject(new AccountError('RATE_LIMITED', 'Account control is unavailable.'));
    }
    this.outstanding++;
    const controller = new AbortController();
    let admitted = false;
    const timer = setTimeout(() => { if (!admitted) controller.abort(new AccountError('UNAVAILABLE', 'Account control deadline exceeded.')); },
      this.limits.requestTimeoutMs);
    const operation = (async () => {
      const entry = await this.acquire(binding, controller.signal);
      const result = entry.lane.then(async () => {
        stopped(controller.signal);
        entry.replica ??= new AccountReplica(this.root, this.options.backendUrl, binding, this.limits);
        stopped(controller.signal);
        entry.replica.assertBinding(binding, this.options.backendUrl);
        if (entry.replica.operationHistoryState !== 'never' &&
          !existsSync(join(entry.replica.directory, 'operations.sqlite'))) {
          // the independent marker already fences every protected account turn.
          admitted = true;
          clearTimeout(timer);
          await commitRevocation();
          return;
        }
        await ensureDeliveryHistory(entry.replica.directory, binding, entry.replica.db, entry.replica);
        stopped(controller.signal);
        const barrier = new DeliveryBarrier(entry.replica.directory, binding, this.options.operationPolicy!.delivery!);
        try {
          await barrier.revoke(binding, entry.replica.db, controller.signal);
          admitted = true;
          clearTimeout(timer);
          await commitRevocation();
        } finally { barrier.close(); }
      });
      entry.lane = result.catch(() => undefined).finally(() => { entry.pending--; entry.idleAt = Date.now(); });
      return result;
    })();
    this.operations.add(operation);
    void operation.finally(() => { clearTimeout(timer); this.outstanding--; this.operations.delete(operation); }).catch(() => undefined);
    return bounded(operation, controller.signal);
  }

  resumeDelivery(context: AuthContext, confirmOwnerDecision: () => Promise<void>): Promise<void> {
    if (!this.options.operationPolicy?.delivery || !hasOperationAuthority(context) || typeof confirmOwnerDecision !== 'function') {
      return Promise.reject(new AccountError('FORBIDDEN', 'A current full delivery grant is required.', false));
    }
    return this.inLane(context, 'UTC', async lane => {
      const operations = await AccountOperations.open(this.operationEnvironment(lane), this.options.operationPolicy!, true);
      if (!operations) throw new AccountError('OPERATION_PENDING', 'Operation runtime is unavailable.');
      try {
        const queued = await operations.resumeDelivery(confirmOwnerDecision);
        if (queued > 0) await operations.deliver();
      }
      finally { await operations.close(); }
    });
  }

  async lookupOperation(context: AuthContext, operationId: string): Promise<{ data: JournalOperation | null; meta: Metadata }> {
    if (!hasToolScope(contracts.get_operation, context.scopes)) {
      throw new AccountError('FORBIDDEN', 'Operation lookup requires account read permission.', false);
    }
    const parsed = contracts.get_operation.input.safeParse({ operationId });
    if (!parsed.success) throw new AccountError('INVALID_INPUT', 'Invalid operation id.', false);
    return this.serve(context, {}, false, async (_lane, _meta, recovery, operations) => {
      if (recovery.recoveryReason === 'restore_latched') {
        throw new AccountError('OPERATION_PENDING', 'Operation lookup requires restored history reconciliation.');
      }
      return operations ? operations.lookup(parsed.data.operationId) : null;
    });
  }

  withAccountControl<T>(context: AuthContext, work: (runtime: AccountControlRuntime) => Promise<T>): Promise<T> {
    return this.inLane(context, 'UTC', async lane => {
      if (!this.options.operationPolicy) throw new AccountError('FORBIDDEN', 'Trusted account control policy is required.', false);
      await authorizeAccountControl(this.options.operationPolicy, this.operationEnvironment(lane));
      const result = await work(Object.freeze({ accountId: lane.ctx.accountId, directory: lane.replica.directory,
        signal: lane.signal, assertActive: lane.authorize }));
      await lane.authorize(); return result;
    });
  }

  private operationEnvironment(lane: LaneContext): OperationEnvironment {
    return Object.freeze({ db: lane.replica.db, directory: lane.replica.directory, context: lane.ctx,
      signal: lane.signal, nowUtcMs: lane.ports.clock.nowUtcMs(), assertActive: lane.authorize,
      fetch: this.options.fetch, checkDisk: () => lane.replica.checkDisk(), maxFetches: this.limits.maxQueryPages,
      history: lane.replica });
  }

  private async serve<T>(context: AuthContext, options: ReadOptions, createOperations: boolean,
    work: (lane: LaneContext, meta: Metadata, recovery: RecoveryStatus, operations: AccountOperations | null) => Promise<T>): Promise<{ data: T; meta: Metadata }> {
    const zone = timeZone.safeParse(options.timeZone ?? 'UTC');
    if (!zone.success || (options.freshness !== undefined && !['require_sync', 'allow_cached'].includes(options.freshness))) {
      throw new AccountError('INVALID_INPUT', 'Invalid account read options.', false);
    }
    return this.inLane(context, zone.data, async lane => {
      const { replica, ctx, ports, signal, authorize } = lane;
      const policy = this.options.operationPolicy;
      let operations: AccountOperations | null = null;
      let fencedRead = false;
      if (policy) {
        if (!createOperations) {
          try { await policy.latch.assertReady(); }
          catch (cause) {
            if (!(cause instanceof RecoveryFenceError) || cause.reason !== 'restore_latched') throw cause;
            fencedRead = true;
          }
        }
        if (!fencedRead) {
          try { operations = await AccountOperations.open(this.operationEnvironment(lane), policy, createOperations); }
          catch (cause) {
            if (createOperations || !(cause instanceof RecoveryFenceError) || cause.reason !== 'restore_latched') throw cause;
            fencedRead = true;
          }
        }
      }
      try {
        const recovered = fencedRead && policy ? await AccountOperations.inspectFencedRead(this.operationEnvironment(lane), policy)
          : operations ? await operations.recover() : await this.recover(replica, ctx, ports, signal, authorize);
        stopped(signal);
        await replica.boundProduct();
        const initialized = await initializeProductDatabase(replica.db, ports.ids, ports.hashing);
        if (!initialized.ok) throw new AccountError('UNAVAILABLE', 'Product replica initialization failed.');
        await replica.db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1 WHERE id = 1');
        await this.bindProduct(replica, ctx, !fencedRead);
        if (fencedRead && existsSync(join(replica.directory, 'operations.sqlite')) &&
          !await replica.db.getFirstAsync("SELECT account_digest FROM sync_account_bindings WHERE provider = 'snapback4'")) {
          throw new AccountError('OPERATION_PENDING', 'Restored product binding is missing.');
        }
        const status = await this.pull(replica, ctx, ports, signal, authorize);
        await authorize(); replica.checkDisk();
        const meta = await this.observe(replica, ports, status, options);
        const deliveryPaused = operations ? await operations.deliveryPaused() : true;
        const recovery = Object.freeze({ ...recovered, deliveryPaused,
          recoveryReason: deliveryPaused ? recovered.recoveryReason : null,
          reconnectRequired: recovered.reconnectRequired || meta.syncStatus === 'reconnect_required' });
        const data = await work(lane, meta, recovery, operations);
        await authorize();
        const observed = createOperations ? await this.observe(replica, ports, status, { freshness: 'allow_cached' }, false) : meta;
        const deliveryStatus = operations?.lastDeliveryStatus;
        const finalMeta: Metadata = deliveryStatus && deliveryStatus !== 'up_to_date'
          ? Object.freeze({ ...observed, syncStatus: deliveryStatus === 'signed_out' ? 'reconnect_required'
            : deliveryStatus === 'offline' ? 'offline' : 'sync_attention' }) : observed;
        return { data, meta: finalMeta };
      } finally { await operations?.close(); }
    });
  }

  private async observe(replica: AccountReplica, ports: Ports, status: string, options: ReadOptions, completedPull = true): Promise<Metadata> {
    const summary = await getSyncSummary({ db: replica.db, clock: ports.clock });
    if (!summary.ok) throw new AccountError('UNAVAILABLE', 'Replica admission could not be inspected.');
    const deferred = (await replica.db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_deferred'))!.count;
    const state = (await replica.db.getFirstAsync<{ change_token: string | null }>('SELECT change_token FROM sync_state WHERE id = 1'))!;
    const admission = { ...summary.value.incoming, deferred };
    const clean = status === 'up_to_date' && Object.values(admission).every(value => value === 0);
    let syncStatus: Metadata['syncStatus'] = 'sync_attention';
    if (clean) syncStatus = 'up_to_date';
    else if (status === 'offline') syncStatus = 'offline';
    else if (status === 'signed_out') syncStatus = 'reconnect_required';
    else if (status === 'idle') syncStatus = 'incomplete';
    if (clean && completedPull) replica.markHealthy(Date.now(), state.change_token);
    if (!clean && (options.freshness !== 'allow_cached' || replica.lastHealthyPullAtUtc === null)) {
      throw new AccountError(syncStatus === 'reconnect_required' ? 'RECONNECT_REQUIRED' : syncStatus === 'sync_attention'
        ? 'SYNC_ATTENTION' : 'UNAVAILABLE', 'A complete account pull is required before this read.');
    }
    return Object.freeze({ observedAtUtc: Date.now(), lastCompletedPullAtUtc: replica.lastHealthyPullAtUtc,
      backendRevision: state.change_token, syncStatus, pendingLocalDeliveries: summary.value.pendingChanges,
      admission: Object.freeze(admission), usedCached: !clean });
  }

  private inLane<T>(context: AuthContext, zone: string, work: (lane: LaneContext) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AccountError('UNAVAILABLE', 'Account service is closing.'));
    if (this.outstanding >= this.limits.maxOutstanding) return Promise.reject(new AccountError('RATE_LIMITED', 'Account request budget exceeded.'));
    this.outstanding++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AccountError('UNAVAILABLE', 'Account request deadline exceeded.')), this.limits.requestTimeoutMs);
    const ctx: AuthContext = Object.freeze({ ...context, scopes: Object.freeze([...context.scopes]), session: Object.freeze({ ...context.session }) });
    const operation = (async () => {
      if (ctx.backendUrl !== this.options.backendUrl || ctx.principal !== ctx.session.principal || !ctx.accountId || ctx.accountId.length > 200 ||
        !ctx.principal || ctx.principal.length > 500 || !ctx.clientId || !ctx.grantId) {
        throw new AccountError('FORBIDDEN', 'Account authority does not match this service.', false);
      }
      const authorize = async () => {
        stopped(controller.signal);
        await bounded(ctx.assertActive(), controller.signal);
        stopped(controller.signal);
      };
      await authorize();
      const entry = await this.acquire(ctx, controller.signal);
      const result = entry.lane.then(async () => {
        await authorize();
        entry.replica ??= new AccountReplica(this.root, this.options.backendUrl, ctx, this.limits);
        const replica = entry.replica;
        replica.assertBinding(ctx, this.options.backendUrl);
        replica.checkDisk();
        const ports = immutablePorts(zone);
        await this.bindProduct(replica, ctx, false);
        return work({ ctx, replica, ports, signal: controller.signal, authorize });
      });
      entry.lane = result.catch(() => undefined).finally(() => { entry.pending--; entry.idleAt = Date.now(); });
      return result;
    })();
    this.operations.add(operation);
    void operation.finally(() => { clearTimeout(timer); this.outstanding--; this.operations.delete(operation); }).catch(() => undefined);
    return bounded(operation, controller.signal);
  }

  private async recover(replica: AccountReplica, context: AuthContext, ports: Ports, signal: AbortSignal,
    assertActive: () => Promise<void>): Promise<RecoveryStatus> {
    if (replica.operationHistoryState !== 'never') {
      throw new AccountError('OPERATION_PENDING', 'Retained operation provenance requires protected recovery before account work.');
    }
    if (this.options.recover) {
      const status = await this.options.recover(Object.freeze({ db: replica.db, directory: replica.directory,
        context, ports, signal, assertActive }));
      if (!status || typeof status.writeFenced !== 'boolean' || typeof status.deliveryPaused !== 'boolean' ||
        typeof status.reconnectRequired !== 'boolean' || (status.recoveryReason !== null &&
          (typeof status.recoveryReason !== 'string' || status.recoveryReason.length > 200))) {
        throw new AccountError('OPERATION_PENDING', 'Recovery did not provide a valid fenced status.');
      }
      return Object.freeze({ ...status, writeFenced: true, deliveryPaused: true });
    }
    const receipts = await replica.db.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipts'");
    if (existsSync(join(replica.directory, 'journal.sqlite')) ||
      (receipts && await replica.db.getFirstAsync('SELECT command_id FROM command_receipts LIMIT 1'))) {
      throw new AccountError('OPERATION_PENDING', 'A write replica requires journal and restore-fence recovery before account work.');
    }
    return degraded;
  }

  private async bindProduct(replica: AccountReplica, ctx: AuthContext, insert = true): Promise<void> {
    const digest = createHash('sha256').update(JSON.stringify([this.options.backendUrl, ctx.principal])).digest('hex');
    if (!insert && !await replica.db.getFirstAsync("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sync_account_bindings'")) return;
    await replica.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ account_digest: string }>('SELECT account_digest FROM sync_account_bindings WHERE provider = ?', ['snapback4']);
      if (row && row.account_digest !== digest) throw new AccountError('FORBIDDEN', 'Product account binding does not match.', false);
      if (!row && insert) await tx.runAsync('INSERT INTO sync_account_bindings (provider, account_digest) VALUES (?, ?)', ['snapback4', digest]);
    });
  }

  private async pull(replica: AccountReplica, ctx: AuthContext, ports: Ports, requestSignal: AbortSignal,
    authorize: () => Promise<void>) {
    if (ctx.session.expiresAt <= Date.now()) return 'signed_out' as const;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new AccountError('UNAVAILABLE', 'Account pull deadline exceeded.')), this.limits.pullTimeoutMs);
    const signal = AbortSignal.any([requestSignal, deadline.signal]);
    let queries = 0, pages = 0, budgetExceeded = false;
    // the sdk's read-only option verifies a read bearer and deliberately refuses full bearers.
    // both credential types remain pull-only behind our transport and http guards.
    const client = createClient({ url: this.options.backendUrl, token: ctx.session.token, readOnly: ctx.session.scope === 'read',
      fetch: async (input, init) => {
        stopped(signal);
        if (++queries > this.limits.maxQueryPages) {
          budgetExceeded = true; throw new SyncTransportError('unavailable', 'Pull query budget exceeded.');
        }
        await authorize();
        const request = new Request(input, init);
        // sdk reads use post /q; forbid every mutation/action route even under a full credential.
        const path = new URL(request.url).pathname;
        if (request.method !== 'GET' && !path.startsWith('/q/')) throw new AccountError('FORBIDDEN', 'Provider mutations are disabled.', false);
        return (this.options.fetch ?? fetch)(request, { signal: AbortSignal.any([signal, request.signal]) });
      } });
    try {
      const source = createSnapbackTransport({ connection: async () => ({ client, session: ctx.session,
        isCurrent: () => !signal.aborted && ctx.session.expiresAt > Date.now() }),
        bind: async () => { replica.assertBinding(ctx, this.options.backendUrl); await authorize(); },
        hash: async text => createHash('sha256').update(text).digest('hex') });
      const transport: SyncTransport<WireSyncRecord> = {
        ensureZone: async () => { throw new AccountError('FORBIDDEN', 'Provider writes are disabled.', false); },
        upload: async () => { throw new AccountError('FORBIDDEN', 'Provider writes are disabled.', false); },
        fetchChanges: async token => {
          stopped(signal); replica.checkDisk();
          if (++pages > this.limits.maxPullPages) {
            budgetExceeded = true; throw new SyncTransportError('unavailable', 'Pull page budget exceeded.');
          }
          return bounded(source.fetchChanges(token, () => !signal.aborted), signal);
        },
      };
      const result = await runSync({ db: replica.db, ...ports, transport, random: () => 0.5, mode: 'pull_only',
        shouldContinue: () => !signal.aborted });
      stopped(requestSignal);
      return deadline.signal.aborted || budgetExceeded ? 'idle' as const : result.ok ? result.value.status : 'needs_attention' as const;
    } finally { clearTimeout(timer); await client.close(); }
  }

  close(): Promise<void> {
    if (!this.closing) {
      clearInterval(this.timer);
      this.closing = (async () => {
        await Promise.allSettled([...this.operations]);
        await this.serialize(() => this.removeIdle(true));
      })();
    }
    return this.closing;
  }
}
