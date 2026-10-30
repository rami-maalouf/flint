import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type VaultScope = 'read' | 'full';
export type VaultBinding = Readonly<{ backend: string; principal: string; accountId: string; grantId: string; scope: VaultScope }>;
// explicit scope is required, including for legacy snapback sessions that omit it.
export type VaultSession = Readonly<{ principal: string; kind: string; token: string; expiresAt: number;
  scope: VaultScope; capExpiresAt?: number }>;
export type VaultConfig = Readonly<{ location: string; activeKeyVersion: string;
  keys: ReadonlyMap<string, Uint8Array>; nowUtcMs?: () => number }>;
export type VaultErrorCode = 'INVALID_CONFIG' | 'INVALID_INPUT' | 'BINDING_MISMATCH' | 'SESSION_NOT_INDEPENDENT'
  | 'RECONNECT_REQUIRED' | 'SCHEMA_MISMATCH' | 'UNSAFE_STORAGE' | 'STORAGE_UNAVAILABLE' | 'CLOSED';

const messages: Record<VaultErrorCode, string> = {
  INVALID_CONFIG: 'Credential vault configuration is invalid.',
  INVALID_INPUT: 'Credential vault input is invalid.',
  BINDING_MISMATCH: 'Credential grant binding does not match.',
  SESSION_NOT_INDEPENDENT: 'An independent session is required for this grant.',
  RECONNECT_REQUIRED: 'Reconnect this connection to continue.',
  SCHEMA_MISMATCH: 'Credential vault schema is unsupported.',
  UNSAFE_STORAGE: 'Credential vault storage must be private.',
  STORAGE_UNAVAILABLE: 'Credential vault storage is unavailable.',
  CLOSED: 'Credential vault is closed.',
};

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(messages[code]);
    this.name = 'VaultError';
  }
}
export class ReconnectRequired extends VaultError {
  constructor() { super('RECONNECT_REQUIRED'); this.name = 'ReconnectRequired'; }
}

const version = 1;
const applicationId = 0x4d435056;
const schema = [
  `CREATE TABLE vault_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE vault_credentials (grant_id TEXT PRIMARY KEY, backend TEXT NOT NULL, principal TEXT NOT NULL,
    account_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('read', 'full')), key_version TEXT NOT NULL,
    nonce BLOB NOT NULL CHECK (length(nonce) = 12), ciphertext BLOB NOT NULL, tag BLOB NOT NULL CHECK (length(tag) = 16),
    token_hash TEXT UNIQUE) STRICT`,
];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const checksum = digest(schema.join(';\n'));
type Row = { grant_id: string; backend: string; principal: string; account_id: string; scope: VaultScope;
  key_version: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array; token_hash: string | null };

function text(value: unknown, maximum = 255): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function exactKeys(value: object, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function canonicalBinding(input: VaultBinding): VaultBinding {
  try {
    if (!input || !exactKeys(input, ['backend', 'principal', 'accountId', 'grantId', 'scope']) ||
      !text(input.backend, 2048) || input.backend.trim() !== input.backend || input.backend.includes('\\') ||
      !text(input.principal) || !text(input.accountId) || !text(input.grantId) || !['read', 'full'].includes(input.scope)) {
      throw new VaultError('INVALID_INPUT');
    }
    const backend = new URL(input.backend);
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' ||
      backend.search || backend.hash) throw new VaultError('INVALID_INPUT');
    return { backend: backend.origin, principal: input.principal, accountId: input.accountId, grantId: input.grantId, scope: input.scope };
  } catch { throw new VaultError('INVALID_INPUT'); }
}
function checkedSession(input: VaultSession, binding: VaultBinding): VaultSession {
  if (!input || !exactKeys(input, ['principal', 'kind', 'token', 'expiresAt', 'scope', 'capExpiresAt']) ||
    input.principal !== binding.principal || input.scope !== binding.scope || !text(input.kind) ||
    !text(input.token, 16384) || !timestamp(input.expiresAt) ||
    (input.capExpiresAt !== undefined && !timestamp(input.capExpiresAt))) throw new VaultError('INVALID_INPUT');
  return { principal: input.principal, kind: input.kind, token: input.token, expiresAt: input.expiresAt, scope: input.scope,
    ...(input.capExpiresAt !== undefined ? { capExpiresAt: input.capExpiresAt } : {}) };
}
function aad(binding: VaultBinding, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify(['habit-system/mcp-credential-vault', version, binding.backend, binding.principal,
    binding.accountId, binding.grantId, binding.scope, keyVersion]));
}
function matches(row: Row, binding: VaultBinding) {
  if (row.backend !== binding.backend || row.principal !== binding.principal || row.account_id !== binding.accountId ||
    row.grant_id !== binding.grantId || row.scope !== binding.scope) throw new VaultError('BINDING_MISMATCH');
}

// custody only: the caller verifies upstream identity, independent issuance and explicit consent before put.
export class CredentialVault {
  #db: DatabaseSync;
  #location: string;
  #directory: string;
  #activeKeyVersion: string;
  #keys = new Map<string, KeyObject>();
  #now: () => number;
  #closed = false;

  constructor(config: VaultConfig) {
    if (process.release.name !== 'node' || 'bun' in process.versions || process.platform === 'win32' ||
      !config || !text(config.location, 4096) || !isAbsolute(config.location) || !text(config.activeKeyVersion) ||
      !config.keys || typeof config.keys.entries !== 'function' ||
      (config.nowUtcMs !== undefined && typeof config.nowUtcMs !== 'function')) throw new VaultError('INVALID_CONFIG');
    try {
      for (const [keyVersion, key] of config.keys) {
        if (!text(keyVersion) || !(key instanceof Uint8Array) || key.byteLength !== 32) throw new VaultError('INVALID_CONFIG');
        this.#keys.set(keyVersion, createSecretKey(key));
      }
      if (!this.#keys.has(config.activeKeyVersion)) throw new VaultError('INVALID_CONFIG');
    } catch { throw new VaultError('INVALID_CONFIG'); }
    this.#activeKeyVersion = config.activeKeyVersion;
    this.#now = config.nowUtcMs ?? Date.now;
    const directory = dirname(config.location);
    try {
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      this.#privatePath(directory, true);
      // resolve ancestor aliases (such as macos /tmp) once; never follow the final directory or database symlink.
      this.#directory = realpathSync(directory);
      this.#location = join(this.#directory, basename(config.location));
      if (!existsSync(this.#location)) {
        const fd = openSync(this.#location, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try { if (!fstatSync(fd).isFile()) throw new VaultError('UNSAFE_STORAGE'); } finally { closeSync(fd); }
      }
      this.#checkFiles();
    } catch (error) { throw error instanceof VaultError ? error : new VaultError('UNSAFE_STORAGE'); }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.#location, { enableDoubleQuotedStringLiterals: false });
      this.#db = database;
      this.#initialize();
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF');
      this.#checkFiles();
    } catch (error) {
      try { database?.close(); } catch { /* startup still returns only a safe vault error. */ }
      this.#keys.clear();
      throw error instanceof VaultError ? error : new VaultError('SCHEMA_MISMATCH');
    }
  }

  #privatePath(location: string, directory = false) {
    const stat = lstatSync(location);
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0) throw new VaultError('UNSAFE_STORAGE');
  }
  #checkFiles() {
    this.#privatePath(this.#directory, true);
    this.#privatePath(this.#location);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      // lstat catches dangling symlinks as well as live ones.
      try { lstatSync(this.#location + suffix); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      this.#privatePath(this.#location + suffix);
    }
  }
  #initialize() {
    const db = this.#db;
    const storedVersion = db.prepare('PRAGMA user_version').get()?.user_version;
    const storedApplication = db.prepare('PRAGMA application_id').get()?.application_id;
    const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
    if (storedVersion === 0 && storedApplication === 0 && objects.length === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const sql of schema) db.exec(sql);
        db.prepare('INSERT INTO vault_meta VALUES (1, ?, ?)').run(version, checksum);
        db.exec(`PRAGMA user_version = ${version}; PRAGMA application_id = ${applicationId}; COMMIT`);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return;
    }
    if (storedVersion !== version || storedApplication !== applicationId ||
      JSON.stringify(objects.map(object => object.sql).sort()) !== JSON.stringify([...schema].sort())) throw new VaultError('SCHEMA_MISMATCH');
    const rows = db.prepare('SELECT * FROM vault_meta').all();
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== version || rows[0].checksum !== checksum) {
      throw new VaultError('SCHEMA_MISMATCH');
    }
  }
  #guard<T>(work: () => T): T {
    if (this.#closed) throw new VaultError('CLOSED');
    try {
      this.#checkFiles();
      const result = work();
      this.#checkFiles();
      return result;
    } catch (error) { throw error instanceof VaultError ? error : new VaultError('STORAGE_UNAVAILABLE'); }
  }
  #transaction(work: () => void) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { work(); this.#db.exec('COMMIT'); }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #row(binding: VaultBinding): Row | undefined {
    const row = this.#db.prepare('SELECT * FROM vault_credentials WHERE grant_id = ?').get(binding.grantId) as Row | undefined;
    if (row) matches(row, binding);
    return row;
  }
  #open(row: Row, binding: VaultBinding): VaultSession | null {
    try {
      const key = this.#keys.get(row.key_version);
      if (!key || row.nonce.byteLength !== 12 || row.tag.byteLength !== 16 || row.ciphertext.byteLength > 100_000) throw new ReconnectRequired();
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, { authTagLength: 16 });
      decipher.setAAD(aad(binding, row.key_version));
      decipher.setAuthTag(row.tag);
      const plaintext = decipher.update(row.ciphertext);
      try {
        const tail = decipher.final();
        const complete = Buffer.concat([plaintext, tail]);
        try {
          const payload = JSON.parse(complete.toString('utf8')) as { version: number; session: VaultSession | null };
          if (!payload || payload.version !== version || !exactKeys(payload, ['version', 'session'])) throw new ReconnectRequired();
          if (payload.session === null) {
            if (row.token_hash !== null) throw new ReconnectRequired();
            return null;
          }
          const session = checkedSession(payload.session, binding);
          if (digest(session.token) !== row.token_hash) throw new ReconnectRequired();
          return session;
        } finally { complete.fill(0); tail.fill(0); }
      } finally { plaintext.fill(0); }
    } catch { throw new ReconnectRequired(); }
  }
  #store(binding: VaultBinding, session: VaultSession | null) {
    const keyVersion = this.#activeKeyVersion;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#keys.get(keyVersion)!, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(binding, keyVersion));
    const plaintext = Buffer.from(JSON.stringify({ version, session }));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      this.#db.prepare(`INSERT INTO vault_credentials
        (grant_id, backend, principal, account_id, scope, key_version, nonce, ciphertext, tag, token_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(grant_id) DO UPDATE SET key_version = excluded.key_version, nonce = excluded.nonce,
          ciphertext = excluded.ciphertext, tag = excluded.tag, token_hash = excluded.token_hash`)
        .run(binding.grantId, binding.backend, binding.principal, binding.accountId, binding.scope, keyVersion,
          nonce, ciphertext, cipher.getAuthTag(), session === null ? null : digest(session.token));
    } finally { plaintext.fill(0); }
  }
  #unexpired(session: VaultSession) {
    const now = this.#now();
    if (!timestamp(now)) throw new VaultError('INVALID_CONFIG');
    if (Math.min(session.expiresAt, session.capExpiresAt ?? session.expiresAt) <= now) throw new ReconnectRequired();
  }

  // the caller must have fresh explicit consent for every insertion or replacement, especially full sessions.
  put(input: VaultBinding, value: VaultSession): void {
    this.#guard(() => {
      const binding = canonicalBinding(input);
      const session = checkedSession(value, binding);
      this.#unexpired(session);
      this.#transaction(() => {
        const existing = this.#row(binding);
        if (existing) this.#open(existing, binding);
        if (this.#db.prepare('SELECT 1 FROM vault_credentials WHERE token_hash = ? AND grant_id <> ?')
          .get(digest(session.token), binding.grantId)) throw new VaultError('SESSION_NOT_INDEPENDENT');
        this.#store(binding, session);
      });
    });
  }
  get(input: VaultBinding): VaultSession {
    return this.#guard(() => {
      const binding = canonicalBinding(input);
      const row = this.#row(binding);
      if (!row) throw new ReconnectRequired();
      const session = this.#open(row, binding);
      if (!session) throw new ReconnectRequired();
      this.#unexpired(session);
      return session;
    });
  }
  // local custody revocation only. upstream logout and oauth/delivery barriers belong to the caller.
  revoke(input: VaultBinding): void {
    this.#guard(() => {
      const binding = canonicalBinding(input);
      this.#transaction(() => {
        const existing = this.#row(binding);
        if (existing) this.#open(existing, binding);
        this.#store(binding, null);
      });
    });
  }
  delete(input: VaultBinding): void { this.revoke(input); }
  close(): void {
    if (this.#closed) return;
    try { this.#db.close(); this.#closed = true; this.#keys.clear(); }
    catch { throw new VaultError('STORAGE_UNAVAILABLE'); }
  }
}
