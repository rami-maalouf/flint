import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { CreateCheckInInput } from '../../../../src/core/domain/check-in-commands';
import type { CheckInId, CommandId } from '../../../../src/core/domain/ids';
import type { ClaimRewardInput } from '../../../../src/core/domain/reward-commands';
import type { DomainResult } from '../../../../src/core/domain/result';
import type { SqlDatabase } from '../../../../src/core/persistence/database';
import { getReceipt } from '../../../../src/core/persistence/repositories/support';
import { contracts, timeZone, type ToolInput } from '../tools/contracts';
import { canonicalJson, captureNewTuples, maxOutboxId, sha256, wireIdentity,
  type CapturedTuple, type UploadAcceptance } from './records';

export type MutationTool = 'create_checkin' | 'undo_checkin' | 'claim_reward';
export type MutationRequest = { [T in MutationTool]: { clientId: string; tool: T; input: ToolInput<T> } }[MutationTool];
export type CoreCommand =
  | { tool: 'create_checkin'; input: CreateCheckInInput }
  | { tool: 'undo_checkin'; input: { commandId: CommandId; checkInId: CheckInId; createdByCommandId: CommandId } }
  | { tool: 'claim_reward'; input: ClaimRewardInput };
export type FrozenIntent = { accountId: string; clientId: string; operationId: string; tool: MutationTool;
  fingerprint: string; commandId: CommandId; nowUtcMs: number; timeZone: string; command: CoreCommand; baselineOutboxId: number };
export type JournalHead = { generation: string; sequence: number; headHash: string; previousHash: string };
export type ChainEntry = JournalHead & { event: string };
export const GENESIS_HASH = '0'.repeat(64);
export const failpoints = ['before_prepare', 'before_prepare_commit', 'after_prepare', 'before_core_commit', 'after_core_commit',
  'before_receipt_capture', 'before_capture_commit', 'after_receipt_capture', 'before_ack', 'before_ack_commit', 'after_ack', 'before_queue_clear', 'after_queue_clear'] as const;
export type Failpoint = typeof failpoints[number];
export type JournalOptions = { location: string; accountId: string; generation: string; product: SqlDatabase;
  nowUtcMs: () => number;
  normalize: (request: MutationRequest, context: { commandId: CommandId; nowUtcMs: number }) => Promise<{ timeZone: string; command: CoreCommand }>;
  execute: (intent: FrozenIntent) => Promise<DomainResult<unknown>>;
  authorize: (intent: FrozenIntent, action: 'execute' | 'read' | 'deliver') => Promise<void>;
  // mandatory: the parent owns remote cas, ancestry verification and the outside-db restore latch.
  publish: (head: JournalHead) => Promise<void>;
  failpoint?: (point: Failpoint) => void };
export type JournalOperation = { intent: FrozenIntent;
  state: 'prepared' | 'rejected' | 'completed_no_mutation' | 'pending_sync' | 'backend_acknowledged';
  delivery: 'unknown' | 'not_required' | 'pending' | 'acknowledged' | 'superseded';
  result: DomainResult<unknown> | null; tuples: CapturedTuple[] };

export class JournalError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'OPERATION_PENDING' | 'CONFLICT' | 'NOT_FOUND', message: string) {
    super(message);
  }
}

const schema = `CREATE TABLE journal_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL, account_id TEXT NOT NULL, generation TEXT NOT NULL);
CREATE TABLE operations (client_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  intent TEXT NOT NULL, result TEXT, state TEXT NOT NULL, delivery TEXT NOT NULL, PRIMARY KEY (client_id, operation_id));
CREATE TABLE tuples (outbox_id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, mutation_stamp TEXT NOT NULL,
  payload_hash TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL, disposition TEXT, remote_stamp TEXT,
  FOREIGN KEY (client_id, operation_id) REFERENCES operations(client_id, operation_id));
CREATE INDEX tuple_identity ON tuples (entity_type, entity_id, mutation_stamp);
CREATE TABLE journal_chain (sequence INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, head_hash TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL);`;
type OperationRow = { intent: string; fingerprint: string; result: string | null;
  state: JournalOperation['state']; delivery: JournalOperation['delivery'] };
type TupleRow = { outbox_id: number; client_id: string; operation_id: string; record: string; payload_hash: string;
  digest: string; disposition: CapturedTuple['disposition']; remote_stamp: string | null };

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function identifier(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 255 || value.includes('\0')) throw new Error('Invalid journal identity.');
}

// this is not an account actor. one owner must externally serialize all account work.
export class OperationJournal {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(private readonly options: JournalOptions) {
    if (process.release.name !== 'node' || 'bun' in process.versions) throw new Error('The operation journal requires real Node SQLite.');
    identifier(options.accountId);
    identifier(options.generation);
    if (typeof options.publish !== 'function' || typeof options.authorize !== 'function') throw new Error('Journal authorization and recovery publication are required.');
    this.db = new DatabaseSync(options.location);
    try {
      if (this.db.prepare('SELECT ? AS value').get('before\0after')?.value !== 'before\0after') throw new Error('Use the verified Node 24.22.2 runtime.');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const meta = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'journal_meta'").get();
      if (meta) {
        const stored = this.db.prepare('SELECT * FROM journal_meta WHERE id = 1').get();
        if (version !== 1 || stored?.version !== 1 || stored.schema_hash !== sha256(schema) ||
            stored.account_id !== options.accountId || stored.generation !== options.generation) throw new Error('Journal schema or account/generation binding mismatch.');
      } else if (version !== 0 || this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error('Refusing an unknown journal schema or product database.');
      }
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
      if (!meta) this.transaction(() => {
        this.db.exec(schema);
        this.db.prepare('INSERT INTO journal_meta VALUES (1, 1, ?, ?, ?)').run(sha256(schema), options.accountId, options.generation);
        this.db.exec('PRAGMA user_version = 1');
      });
      this.verifyChain();
    } catch (cause) { this.db.close(); throw cause; }
  }

  head(): JournalHead {
    const row = this.db.prepare('SELECT sequence, previous_hash, head_hash FROM journal_chain ORDER BY sequence DESC LIMIT 1').get();
    return { generation: this.options.generation, sequence: row ? Number(row.sequence) : 0,
      headHash: row ? String(row.head_hash) : GENESIS_HASH, previousHash: row ? String(row.previous_hash) : GENESIS_HASH };
  }

  entryAt(sequence: number): ChainEntry | null {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid journal sequence.');
    if (sequence === 0) return { generation: this.options.generation, sequence: 0, headHash: GENESIS_HASH, previousHash: GENESIS_HASH, event: '' };
    const row = this.db.prepare('SELECT * FROM journal_chain WHERE sequence = ?').get(sequence);
    return row ? { generation: this.options.generation, sequence, headHash: String(row.head_hash),
      previousHash: String(row.previous_hash), event: String(row.event) } : null;
  }

  private verifyChain(): void {
    let sequence = 0, previous = GENESIS_HASH;
    for (const row of this.db.prepare('SELECT * FROM journal_chain ORDER BY sequence').iterate()) {
      sequence++;
      if (row.sequence !== sequence || row.previous_hash !== previous || row.head_hash !== this.eventHash(sequence, previous, String(row.event))) {
        throw new Error('Journal ancestry is incomplete or corrupt; recovery required.');
      }
      previous = String(row.head_hash);
    }
  }

  private eventHash(sequence: number, previousHash: string, event: string): string {
    return sha256(canonicalJson({ generation: this.options.generation, sequence, previousHash, event }));
  }

  private append(event: unknown): void {
    const head = this.head();
    const sequence = head.sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Journal sequence exhausted.');
    const encoded = canonicalJson(event);
    this.db.prepare('INSERT INTO journal_chain VALUES (?, ?, ?, ?)').run(sequence, head.headHash,
      this.eventHash(sequence, head.headHash, encoded), encoded);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  private point(point: Failpoint): void { this.options.failpoint?.(point); }

  private read(clientId: string, operationId: string): JournalOperation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE client_id = ? AND operation_id = ?').get(clientId, operationId) as OperationRow | undefined;
    if (!row) return null;
    const tuples = this.db.prepare('SELECT * FROM tuples WHERE client_id = ? AND operation_id = ? ORDER BY outbox_id').all(clientId, operationId) as TupleRow[];
    return { intent: frozen(JSON.parse(row.intent)), result: row.result === null ? null : JSON.parse(row.result), state: row.state,
      delivery: row.delivery, tuples: tuples.map(tuple => ({ outboxId: tuple.outbox_id, record: JSON.parse(tuple.record),
        payloadHash: tuple.payload_hash, digest: tuple.digest, disposition: tuple.disposition, remoteMutationStamp: tuple.remote_stamp })) };
  }

  async get(clientId: string, operationId: string): Promise<JournalOperation | null> {
    const operation = this.read(clientId, operationId.toLowerCase());
    if (!operation) return null;
    await this.options.authorize(operation.intent, 'read');
    await this.options.publish(this.head());
    return operation;
  }

  async run(request: MutationRequest): Promise<JournalOperation> {
    identifier(request.clientId);
    if (!['create_checkin', 'undo_checkin', 'claim_reward'].includes(request.tool)) throw new Error('Invalid mutation tool.');
    contracts[request.tool].input.parse(request.input);
    const original = frozen(JSON.parse(canonicalJson(request)) as MutationRequest);
    const operationId = original.input.operationId.toLowerCase();
    const fingerprint = sha256(canonicalJson({ accountId: this.options.accountId, clientId: original.clientId,
      tool: original.tool, input: { ...original.input, operationId } }));
    let operation = this.read(original.clientId, operationId);
    if (operation && operation.intent.fingerprint !== fingerprint) throw new JournalError('IDEMPOTENCY_CONFLICT', 'This operation id belongs to different arguments or a different tool.');
    if (!operation) {
      if (this.db.prepare("SELECT 1 FROM operations WHERE state = 'prepared' LIMIT 1").get()) {
        throw new JournalError('OPERATION_PENDING', 'Recover prepared intent before any other account work.');
      }
      await this.options.publish(this.head());
      const context = { commandId: randomUUID() as CommandId, nowUtcMs: this.options.nowUtcMs() };
      if (!Number.isSafeInteger(context.nowUtcMs)) throw new Error('Invalid frozen clock.');
      const normalized = await this.options.normalize(original, context);
      timeZone.parse(normalized.timeZone);
      if (normalized.command.tool !== original.tool || normalized.command.input.commandId !== context.commandId) throw new Error('Normalized command does not match admitted intent.');
      if (normalized.command.tool === 'create_checkin' && (normalized.command.input.source !== 'app' ||
          normalized.command.input.logicalDate === undefined)) throw new Error('Freeze the resolved logical date and app source before admission.');
      const intent: FrozenIntent = frozen(JSON.parse(JSON.stringify({ accountId: this.options.accountId, clientId: original.clientId,
        operationId, tool: original.tool, fingerprint, ...context, timeZone: normalized.timeZone, command: normalized.command,
        baselineOutboxId: await maxOutboxId(this.options.product) })));
      this.point('before_prepare');
      this.transaction(() => {
        this.db.prepare("INSERT INTO operations VALUES (?, ?, ?, ?, NULL, 'prepared', 'unknown')")
          .run(intent.clientId, operationId, fingerprint, JSON.stringify(intent));
        this.append({ kind: 'prepared', intent });
        this.point('before_prepare_commit');
      });
      this.point('after_prepare');
      operation = this.read(intent.clientId, operationId)!;
    }
    if (operation.state === 'prepared') operation = await this.finish(operation.intent);
    await this.options.authorize(operation.intent, 'read');
    await this.options.publish(this.head());
    return operation;
  }

  // startup must complete this before reads, commands, sync or local fact recovery.
  async recover(): Promise<void> {
    await this.options.publish(this.head());
    const prepared = this.db.prepare("SELECT client_id, operation_id FROM operations WHERE state = 'prepared' LIMIT 2").all();
    if (prepared.length > 1) throw new JournalError('OPERATION_PENDING', 'Multiple uncaptured intents require reconciliation.');
    for (const row of prepared) await this.finish(this.read(String(row.client_id), String(row.operation_id))!.intent);
  }

  private async finish(intent: FrozenIntent): Promise<JournalOperation> {
    await this.options.publish(this.head());
    if (await getReceipt(this.options.product, intent.commandId) === null) {
      await this.options.authorize(intent, 'execute');
      this.point('before_core_commit');
      // the full core command owns its transaction. never wrap it in another transaction.
      await this.options.execute(intent);
      this.point('after_core_commit');
    }
    this.point('before_receipt_capture');
    const captured = await this.options.product.withTransactionAsync(async tx => {
      const receipt = await getReceipt(tx, intent.commandId);
      if (receipt === null) throw new JournalError('OPERATION_PENDING', 'No durable core receipt; retain prepared intent for recovery.');
      const result = JSON.parse(receipt) as DomainResult<unknown>;
      if (typeof result.ok !== 'boolean') throw new Error('Invalid core receipt; recovery required.');
      const tuples = await captureNewTuples(tx, intent.baselineOutboxId);
      if (!result.ok && tuples.length) throw new Error('Rejected receipt has mutation evidence; recovery required.');
      return { receipt, result, tuples };
    });
    const state = !captured.result.ok ? 'rejected' : captured.tuples.length ? 'pending_sync' : 'completed_no_mutation';
    const delivery = captured.tuples.length ? 'pending' : 'not_required';
    this.transaction(() => {
      this.db.prepare('UPDATE operations SET result = ?, state = ?, delivery = ? WHERE client_id = ? AND operation_id = ?')
        .run(captured.receipt, state, delivery, intent.clientId, intent.operationId);
      for (const tuple of captured.tuples) this.db.prepare('INSERT INTO tuples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
        .run(tuple.outboxId, intent.clientId, intent.operationId, tuple.record.entityType, tuple.record.entityId,
          tuple.record.mutationStamp, tuple.payloadHash, tuple.digest, JSON.stringify(tuple.record));
      this.append({ kind: 'captured', clientId: intent.clientId, operationId: intent.operationId, result: captured.result,
        tuples: captured.tuples.map(({ outboxId, payloadHash, digest }) => ({ outboxId, payloadHash, digest })) });
      this.point('before_capture_commit');
    });
    this.point('after_receipt_capture');
    await this.options.publish(this.head());
    return this.read(intent.clientId, intent.operationId)!;
  }

  async undoTarget(clientId: string, operationId: string): Promise<{ checkInId: CheckInId; createdByCommandId: CommandId }> {
    const operation = await this.get(clientId, operationId);
    if (!operation) throw new JournalError('NOT_FOUND', 'Original operation not found.');
    const value = operation.result?.ok ? operation.result.value as { created?: boolean; checkInId?: CheckInId } : null;
    if (operation.intent.tool !== 'create_checkin' || value?.created !== true || !value.checkInId) {
      throw new JournalError('CONFLICT', 'Only an actual check-in created by this operation can be undone.');
    }
    return { checkInId: value.checkInId, createdByCommandId: operation.intent.commandId };
  }

  // the actor calls this before network delivery, under its grant/revocation barrier.
  async beforeDelivery(): Promise<void> {
    if (this.db.prepare("SELECT 1 FROM operations WHERE state = 'prepared' LIMIT 1").get()) throw new JournalError('OPERATION_PENDING', 'Capture prepared operations before delivery.');
    for (const row of this.db.prepare("SELECT intent FROM operations WHERE state = 'pending_sync'").iterate()) {
      await this.options.authorize(frozen(JSON.parse(String(row.intent))), 'deliver');
    }
    await this.options.publish(this.head());
  }

  // await this from onUpload before the engine is allowed to clear any outbox rows.
  async recordUploadAcceptance(evidence: UploadAcceptance): Promise<number> {
    this.requireCaptured();
    const identity = wireIdentity(evidence.record);
    const mutable = !['habit_action', 'ledger_entry'].includes(identity.record.entityType);
    if (identity.record.schemaVersion !== 2 || evidence.digest !== identity.digest ||
        !/^\d{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$/.test(evidence.remoteMutationStamp) ||
        (evidence.disposition !== 'accepted' && evidence.disposition !== 'superseded') ||
        (evidence.disposition === 'accepted' && evidence.remoteMutationStamp !== identity.record.mutationStamp) ||
        (evidence.disposition === 'superseded' && (!mutable || evidence.remoteMutationStamp <= identity.record.mutationStamp))) throw new JournalError('OPERATION_PENDING', 'Upload acceptance is unknown or does not match the emitted tuple.');
    const candidates = this.db.prepare('SELECT * FROM tuples WHERE entity_type = ? AND entity_id = ?')
      .all(identity.record.entityType, identity.record.entityId) as TupleRow[];
    const changed: { tuple: TupleRow; disposition: UploadAcceptance['disposition'] }[] = [];
    for (const tuple of candidates) {
      if (tuple.disposition !== null) continue;
      const record = JSON.parse(tuple.record) as UploadAcceptance['record'];
      if (tuple.payload_hash === identity.payloadHash && tuple.digest === identity.digest) changed.push({ tuple, disposition: evidence.disposition });
      else if (record.mutationStamp === identity.record.mutationStamp) throw new JournalError('OPERATION_PENDING', 'Upload payload does not match captured evidence.');
      else if (mutable && record.mutationStamp < evidence.remoteMutationStamp) changed.push({ tuple, disposition: 'superseded' });
    }
    this.point('before_ack');
    if (changed.length) this.transaction(() => {
      for (const { tuple, disposition } of changed) {
        this.db.prepare('UPDATE tuples SET disposition = ?, remote_stamp = ? WHERE outbox_id = ?')
          .run(disposition, evidence.remoteMutationStamp, tuple.outbox_id);
        const pending = this.db.prepare('SELECT 1 FROM tuples WHERE client_id = ? AND operation_id = ? AND disposition IS NULL LIMIT 1')
          .get(tuple.client_id, tuple.operation_id);
        if (!pending) {
          const superseded = this.db.prepare("SELECT 1 FROM tuples WHERE client_id = ? AND operation_id = ? AND disposition = 'superseded' LIMIT 1")
            .get(tuple.client_id, tuple.operation_id);
          this.db.prepare("UPDATE operations SET state = 'backend_acknowledged', delivery = ? WHERE client_id = ? AND operation_id = ?")
            .run(superseded ? 'superseded' : 'acknowledged', tuple.client_id, tuple.operation_id);
        }
      }
      this.append({ kind: 'acceptance', payloadHash: identity.payloadHash, digest: evidence.digest,
        disposition: evidence.disposition, remoteMutationStamp: evidence.remoteMutationStamp,
        tuples: changed.map(({ tuple, disposition }) => ({ outboxId: tuple.outbox_id, disposition })) });
      this.point('before_ack_commit');
    });
    this.point('after_ack');
    await this.options.publish(this.head());
    return changed.length;
  }

  async beforeQueueClear(outboxIds: readonly number[]): Promise<void> {
    this.requireCaptured();
    for (const id of outboxIds) {
      const tuple = this.db.prepare('SELECT disposition FROM tuples WHERE outbox_id = ?').get(id);
      if (tuple && tuple.disposition === null) throw new JournalError('OPERATION_PENDING', 'Outbox delivery has no durable acceptance evidence.');
    }
    await this.options.publish(this.head());
    this.point('before_queue_clear');
  }

  private requireCaptured(): void {
    if (this.db.prepare("SELECT 1 FROM operations WHERE state = 'prepared' LIMIT 1").get()) {
      throw new JournalError('OPERATION_PENDING', 'Capture prepared operations before delivery or queue deletion.');
    }
  }

  afterQueueClear(): void { this.point('after_queue_clear'); }
  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
