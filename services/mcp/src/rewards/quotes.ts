import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertPrivatePath } from '../config';
import { canonicalJson } from '../operations/records';
import { contracts, type ToolInput } from '../tools/contracts';
import { ToolError } from '../tools/errors';

const publicSchema = contracts.get_reward_claim_preview.output.shape.data;
const rewardSchema = publicSchema.shape.reward;
const identifier = z.string().min(1).max(255);
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const payloadSchema = z.strictObject({ id: z.uuidv4(), accountId: identifier, clientId: identifier, originGrantId: identifier,
  operationId: z.uuidv4(), reward: rewardSchema, timeZone: contracts.get_reward_claim_preview.input.shape.timeZone,
  balance: integer, balanceAfterClaim: integer.nullable(), expiresAtUtc: integer });
const approvalSchema = z.strictObject({ approvedAtUtc: integer, providerSessionId: identifier });
type Payload = z.infer<typeof payloadSchema>;
type Approval = z.infer<typeof approvalSchema>;
export type QuotePreview = { reward: z.infer<typeof rewardSchema>; balance: number; balanceAfterClaim: number | null };
export type QuoteIdentity = Readonly<{ accountId: string; clientId: string; grantId: string }>;
export type OwnerApproval = Readonly<{ accountId: string; providerSessionId: string }>;
export type ClaimIdentity = Readonly<{ accountId: string; clientId: string; operationId: string }>;
type Row = { id: string; account_id: string; client_id: string; operation_id: string;
  payload: string; payload_mac: string; approval: string | null; approval_mac: string | null };
type Loaded = { payload: Payload; approval: Approval | null; row: Row };
const schema = `CREATE TABLE quote_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, schema_hash TEXT NOT NULL,
  public_origin TEXT NOT NULL, key_check TEXT NOT NULL);
CREATE TABLE reward_quotes (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  payload TEXT NOT NULL, payload_mac TEXT NOT NULL, approval TEXT, approval_mac TEXT,
  UNIQUE(account_id, client_id, operation_id));`;
const ttlMs = 300_000;
function unavailable(): never { throw new ToolError('UNAVAILABLE', 'Reward confirmation state requires recovery.', true); }
function missing(): never { throw new ToolError('CONFIRMATION_EXPIRED', 'Request a new reward preview before approving.'); }
function required(): never { throw new ToolError('CONFIRMATION_REQUIRED', 'Approve this exact reward quote in your browser first.'); }

// this is service metadata only. no product writer, credential or coin reservation is owned here.
export class RewardQuoteStore {
  private readonly db: DatabaseSync;
  private readonly key: Uint8Array;
  private readonly maximum: number;
  private readonly origin: string;
  private closed = false;

  constructor(private readonly options: { location: string; key: Uint8Array; publicOrigin: string;
    nowUtcMs?: () => number; maxQuotes?: number }) {
    const url = new URL(options.publicOrigin);
    const test = !!process.env.NODE_TEST_CONTEXT && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port;
    this.maximum = options.maxQuotes ?? 10_000;
    if (process.versions.node !== '24.22.2' || 'bun' in process.versions || !(options.key instanceof Uint8Array) || options.key.length !== 32 ||
      options.publicOrigin !== url.origin || (url.protocol !== 'https:' && !test) || !Number.isSafeInteger(this.maximum) || this.maximum < 1) {
      throw new Error('Reward quote configuration is invalid.');
    }
    this.origin = url.origin; this.key = new Uint8Array(options.key);
    assertPrivatePath(dirname(options.location), true);
    const existed = existsSync(options.location);
    if (!existed) closeSync(openSync(options.location, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(options.location + suffix)) assertPrivatePath(options.location + suffix);
    this.db = new DatabaseSync(options.location);
    try {
      if (this.db.prepare('SELECT ? AS value').get('a\0z')?.value !== 'a\0z') unavailable();
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0');
      const hash = createHash('sha256').update(schema).digest('hex');
      const keyCheck = this.mac('database', { schemaHash: hash, publicOrigin: this.origin });
      if (!existed) {
        this.db.exec(`BEGIN IMMEDIATE; ${schema} PRAGMA user_version = 1;`);
        this.db.prepare('INSERT INTO quote_meta VALUES (1, 1, ?, ?, ?)').run(hash, this.origin, keyCheck); this.db.exec('COMMIT');
      }
      const meta = this.db.prepare('SELECT * FROM quote_meta WHERE id = 1').get();
      const actual = this.db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
        .all().map(row => String(row.sql).trim()).sort();
      const expected = schema.trim().split(';').map(sql => sql.trim()).filter(Boolean).sort();
      if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1 || meta?.version !== 1 || meta.schema_hash !== hash ||
        meta.public_origin !== this.origin || !this.sameMac(meta.key_check, keyCheck) ||
        canonicalJson(actual) !== canonicalJson(expected)) unavailable();
    } catch { this.db.close(); this.key.fill(0); unavailable(); }
  }

  private now(): number {
    if (this.closed) unavailable();
    const now = this.options.nowUtcMs?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + ttlMs)) unavailable();
    return now;
  }
  private mac(kind: string, value: unknown): string {
    return createHmac('sha256', this.key).update(canonicalJson([`mcp/reward-quotes/${kind}/v1`, value])).digest('hex');
  }
  private sameMac(a: unknown, b: string): boolean {
    return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
  private load(row: Row): Loaded {
    try {
      const payload = payloadSchema.parse(JSON.parse(row.payload));
      if (row.id !== payload.id || row.account_id !== payload.accountId || row.client_id !== payload.clientId ||
        row.operation_id !== payload.operationId || !this.sameMac(row.payload_mac, this.mac('payload', payload))) unavailable();
      const approval = row.approval === null ? null : approvalSchema.parse(JSON.parse(row.approval));
      if (approval === null ? row.approval_mac !== null : !this.sameMac(row.approval_mac,
        this.mac('approval', { payloadMac: row.payload_mac, approval }))) unavailable();
      return { payload, approval, row };
    } catch { unavailable(); }
  }
  private token(payload: Payload): string { return `rq1.${payload.id}.${this.mac('token', payload)}`; }
  private resolve(token: string): Loaded {
    this.now();
    if (typeof token !== 'string' || !/^rq1\.[0-9a-f-]{36}\.[a-f0-9]{64}$/.test(token)) required();
    const row = this.db.prepare('SELECT * FROM reward_quotes WHERE id = ?').get(token.split('.')[1]) as Row | undefined;
    if (!row) missing();
    const loaded = this.load(row);
    if (!this.sameMac(token.split('.')[2], this.mac('token', loaded.payload))) required();
    return loaded;
  }
  private fresh(loaded: Loaded): void { if (loaded.payload.expiresAtUtc <= this.now()) missing(); }
  private output(payload: Payload) {
    const token = this.token(payload);
    return publicSchema.parse({ operationId: payload.operationId, reward: payload.reward, balance: payload.balance,
      balanceAfterClaim: payload.balanceAfterClaim, expiresAtUtc: payload.expiresAtUtc, confirmationToken: token,
      confirmationUrl: this.origin + '/mcp/reward-confirmation?token=' + encodeURIComponent(token) });
  }

  issue(identity: QuoteIdentity, raw: ToolInput<'get_reward_claim_preview'>, preview: QuotePreview) {
    const now = this.now(), parsed = contracts.get_reward_claim_preview.input.safeParse(raw), reward = rewardSchema.safeParse(preview.reward);
    if (!parsed.success || !reward.success || ![identity.accountId, identity.clientId, identity.grantId].every(value => identifier.safeParse(value).success) ||
      !integer.safeParse(preview.balance).success || reward.data.id !== parsed.data.rewardId || reward.data.archivedAt !== null ||
      preview.balanceAfterClaim !== (preview.balance < reward.data.costCoins ? null : preview.balance - reward.data.costCoins)) {
      throw new ToolError('INVALID_INPUT', 'This reward cannot be quoted safely.');
    }
    const input = parsed.data, operationId = input.operationId.toLowerCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM reward_quotes WHERE account_id = ? AND client_id = ? AND operation_id = ?')
        .get(identity.accountId, identity.clientId, operationId) as Row | undefined;
      if (row) {
        const old = this.load(row);
        if (old.payload.reward.id !== input.rewardId || old.payload.timeZone !== input.timeZone) {
          throw new ToolError('IDEMPOTENCY_CONFLICT', 'This operation id already quotes another reward or time zone.');
        }
        if (old.payload.reward.mutationStamp === reward.data.mutationStamp) {
          if (canonicalJson(old.payload.reward) !== canonicalJson(reward.data)) unavailable();
          if (old.payload.expiresAtUtc > now) {
            const output = this.output(old.payload);
            this.db.exec('COMMIT');
            return output;
          }
        }
      } else if (Number(this.db.prepare('SELECT count(*) AS n FROM reward_quotes').get()!.n) >= this.maximum) {
        throw new ToolError('RATE_LIMITED', 'Reward confirmation history has reached its configured limit.');
      }
      const payload = payloadSchema.parse({ id: randomUUID(), accountId: identity.accountId, clientId: identity.clientId,
        originGrantId: identity.grantId, operationId, reward: reward.data, timeZone: input.timeZone,
        balance: preview.balance, balanceAfterClaim: preview.balanceAfterClaim, expiresAtUtc: now + ttlMs });
      const output = this.output(payload);
      if (row) this.db.prepare('DELETE FROM reward_quotes WHERE id = ?').run(row.id);
      this.db.prepare('INSERT INTO reward_quotes VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
        .run(payload.id, payload.accountId, payload.clientId, payload.operationId, canonicalJson(payload), this.mac('payload', payload));
      this.db.exec('COMMIT');
      return output;
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  view(token: string, accountId: string) {
    const loaded = this.resolve(token);
    if (loaded.payload.accountId !== accountId) throw new ToolError('FORBIDDEN', 'This reward quote belongs to another account.');
    this.fresh(loaded);
    return Object.freeze({ ...loaded.payload, reward: Object.freeze({ ...loaded.payload.reward }), approved: loaded.approval !== null });
  }
  private saveApproval(loaded: Loaded, approval: Approval): void {
    this.db.prepare('UPDATE reward_quotes SET approval = ?, approval_mac = ? WHERE id = ?')
      .run(canonicalJson(approval), this.mac('approval', { payloadMac: loaded.row.payload_mac, approval }), loaded.payload.id);
  }
  approve(token: string, owner: OwnerApproval) {
    const loaded = this.resolve(token);
    if (loaded.payload.accountId !== owner.accountId) throw new ToolError('FORBIDDEN', 'This reward quote belongs to another account.');
    this.fresh(loaded);
    if (!identifier.safeParse(owner.providerSessionId).success || loaded.payload.balanceAfterClaim === null) required();
    if (!loaded.approval) this.saveApproval(loaded, { approvedAtUtc: this.now(), providerSessionId: owner.providerSessionId });
    return this.view(token, owner.accountId);
  }
  admit(token: string, claim: ClaimIdentity) {
    const loaded = this.resolve(token);
    if (loaded.payload.accountId !== claim.accountId || loaded.payload.clientId !== claim.clientId ||
      loaded.payload.operationId !== claim.operationId.toLowerCase()) throw new ToolError('FORBIDDEN', 'This approval belongs to another account, app or operation.');
    this.fresh(loaded);
    if (!loaded.approval) required();
    return Object.freeze({ ...loaded.payload, reward: Object.freeze({ ...loaded.payload.reward }) });
  }
  close(): void { if (!this.closed) { this.db.close(); this.key.fill(0); this.closed = true; } }
}
