import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail, privateFile } from './common.mjs';

const schemas = {
  operations: [
    `CREATE TABLE runtime_meta (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
      backend_url TEXT NOT NULL, principal TEXT NOT NULL, generation TEXT NOT NULL, journal_ready INTEGER NOT NULL)`,
    `CREATE TABLE operation_grants (client_id TEXT NOT NULL, operation_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      tool TEXT NOT NULL, PRIMARY KEY (client_id, operation_id))`,
    `CREATE TABLE delivery_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL,
      initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)))`,
  ],
  delivery: [
    `CREATE TABLE delivery_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
      account_id TEXT NOT NULL, backend_url TEXT NOT NULL, principal TEXT NOT NULL)`,
    'CREATE TABLE revoked_grants (grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL)',
    'CREATE TABLE owner_resumes (outbox_id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL)',
    'CREATE TABLE account_pause (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL CHECK (paused IN (0, 1)))',
  ],
  replica: [
    `CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
      backend_url TEXT NOT NULL, principal TEXT NOT NULL, healthy_pull_at INTEGER, healthy_revision TEXT)`,
    `CREATE TABLE operation_provenance (id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('never', 'initialized', 'unknown')))`,
  ],
};
const normalized = value => value.replace(/\s+/g, ' ').trim();
function exactSchema(db, expected, version) {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== version) fail('unknown delivery-only schema');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type != 'table' LIMIT 1").get()) {
    fail('unknown delivery-only schema');
  }
  const actual = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => normalized(String(row.sql))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.map(normalized).sort())) fail('unknown delivery-only schema');
}
function single(db, table) {
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT 2`).all();
  if (rows.length !== 1 || rows[0].id !== 1) fail('incomplete delivery-only metadata');
  return rows[0];
}
function empty(db, table) {
  if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) fail('operation history is not empty');
}
function withDatabase(path, check) {
  privateFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try { return check(db); } finally { db.close(); }
}
export function verifyEmptyDeliveryOnly(account) {
  const names = readdirSync(account);
  if (names.some(name => name === 'journal.sqlite' || name.startsWith('journal.sqlite-'))) {
    fail('incomplete operation history');
  }
  for (const name of ['operations.sqlite', 'delivery.sqlite', 'replica.sqlite', 'product.sqlite']) {
    if (!existsSync(join(account, name))) fail('incomplete delivery-only metadata');
  }
  const meta = withDatabase(join(account, 'operations.sqlite'), db => {
    exactSchema(db, schemas.operations, 1);
    const row = single(db, 'runtime_meta');
    if ([row.account_id, row.backend_url, row.principal].some(value =>
      typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) ||
      typeof row.generation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.generation) ||
      row.journal_ready !== 0) fail('incomplete delivery-only metadata');
    empty(db, 'operation_grants');
    const anchor = single(db, 'delivery_anchor');
    if (anchor.generation !== row.generation || anchor.initialized !== 1) fail('incomplete delivery-only metadata');
    return row;
  });
  withDatabase(join(account, 'replica.sqlite'), db => {
    exactSchema(db, schemas.replica, 2);
    const binding = single(db, 'binding'), provenance = single(db, 'operation_provenance');
    if (binding.account_id !== meta.account_id || binding.backend_url !== meta.backend_url ||
      binding.principal !== meta.principal || provenance.state !== 'initialized') fail('incomplete delivery-only metadata');
  });
  withDatabase(join(account, 'delivery.sqlite'), db => {
    exactSchema(db, schemas.delivery, 1);
    const delivery = single(db, 'delivery_meta'), pause = single(db, 'account_pause');
    if (delivery.version !== 1 || delivery.account_id !== meta.account_id ||
      delivery.backend_url !== meta.backend_url || delivery.principal !== meta.principal ||
      ![0, 1].includes(pause.paused)) fail('incomplete delivery-only metadata');
    empty(db, 'owner_resumes');
  });
  withDatabase(join(account, 'product.sqlite'), db => {
    for (const table of ['command_receipts', 'mutation_outbox']) {
      const type = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(table)?.type;
      if (type && type !== 'table') fail('unknown product operation evidence');
      if (type && table === 'command_receipts') empty(db, table);
    }
  });
}
