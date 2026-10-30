import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { CredentialVault, ReconnectRequired, VaultError, type VaultBinding, type VaultSession } from '../src/auth/vault.ts';

const now = 1_800_000_000_000;
const binding: VaultBinding = { backend: 'https://habits.example.test', principal: 'immutable-alice',
  accountId: 'opaque-alice', grantId: 'server-grant-one', scope: 'read' };
const second = { ...binding, grantId: 'server-grant-two' };
const bob = { ...binding, principal: 'immutable-bob', accountId: 'opaque-bob', grantId: 'server-grant-bob' };
const session = (owner = binding, token = 'synthetic-token-one'): VaultSession => ({
  principal: owner.principal, kind: 'user', scope: owner.scope, token, expiresAt: now + 60_000,
});

function fixture(t: TestContext) {
  assert.equal(process.versions.node, '24.22.2');
  assert.equal('bun' in process.versions, false);
  const directory = mkdtempSync(join(tmpdir(), 'mcp-vault-'));
  const location = join(directory, 'credentials.sqlite');
  const key = randomBytes(32);
  const config = { location, activeKeyVersion: 'key-1', keys: new Map([['key-1', key]]), nowUtcMs: () => now };
  const handles: CredentialVault[] = [];
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, location, key, config, open: (options = config) => {
    const vault = new CredentialVault(options); handles.push(vault); return vault;
  } };
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, expected);
    assert.equal(error.cause, undefined);
    return true;
  };
}

function mutate(location: string, sql: string, values: (string | number | Uint8Array)[] = []) {
  const db = new DatabaseSync(location);
  try { db.prepare(sql).run(...values); } finally { db.close(); }
}

test('two independent grants and two accounts survive restart, replacement and targeted revoke', t => {
  const f = fixture(t);
  let vault = f.open();
  vault.put(binding, session());
  vault.put(second, session(second, 'synthetic-token-two'));
  vault.put(bob, session(bob, 'synthetic-token-bob'));
  vault.close();
  vault = f.open();
  assert.deepEqual(vault.get(binding), session());
  assert.deepEqual(vault.get(second), session(second, 'synthetic-token-two'));
  assert.deepEqual(vault.get(bob), session(bob, 'synthetic-token-bob'));
  vault.put(binding, session(binding, 'synthetic-reconnected'));
  vault.delete(second);
  vault.close();
  vault = f.open();
  assert.equal(vault.get(binding).token, 'synthetic-reconnected');
  assert.throws(() => vault.get(second), ReconnectRequired);
  assert.equal(vault.get(bob).token, 'synthetic-token-bob');
  vault.revoke(second);
  assert.throws(() => vault.put({ ...second, accountId: 'retargeted' }, session()), code('BINDING_MISMATCH'));
  vault.put(second, session(second, 'synthetic-new-consent'));
  assert.equal(vault.get(second).token, 'synthetic-new-consent');
});

test('exact binding checks protect get, replacement and revoke including after deletion', t => {
  const f = fixture(t);
  const vault = f.open();
  vault.put(binding, session());
  for (const wrong of [
    { ...binding, backend: 'https://other.example.test' }, { ...binding, principal: 'impostor' },
    { ...binding, accountId: 'other-account' }, { ...binding, scope: 'full' as const },
  ]) {
    assert.throws(() => vault.get(wrong), code('BINDING_MISMATCH'));
    assert.throws(() => vault.put(wrong, session(wrong)), code('BINDING_MISMATCH'));
    assert.throws(() => vault.revoke(wrong), code('BINDING_MISMATCH'));
  }
  assert.throws(() => vault.get({ ...binding, grantId: 'missing' }), ReconnectRequired);
  assert.equal(vault.get(binding).token, session().token);
});

test('session principal and scope must explicitly match and no password or extra input is accepted', t => {
  const f = fixture(t);
  const vault = f.open();
  for (const invalid of [
    { ...session(), principal: 'bob' }, { ...session(), scope: 'full' }, { ...session(), scope: undefined },
    { ...session(), password: 'synthetic-password-never-store' }, { ...session(), expiresAt: Infinity },
    { ...session(), token: '' }, { ...session(), refreshToken: 'unexpected' },
  ]) assert.throws(() => vault.put(binding, invalid as VaultSession), code('INVALID_INPUT'));
  const full = { ...binding, scope: 'full' as const };
  vault.put(full, session(full));
  assert.equal(vault.get(full).scope, 'full');
});

test('canonical HTTPS backend is bound without accepting credentials, paths or ambiguous input', t => {
  const f = fixture(t);
  const vault = f.open();
  vault.put({ ...binding, backend: 'https://HABITS.example.test:443/' }, session());
  assert.deepEqual(vault.get(binding), session());
  for (const backend of ['http://habits.example.test', 'https://user:pass@habits.example.test',
    'https://habits.example.test/path', 'https://habits.example.test?secret=bad', 'https://habits.example.test#fragment']) {
    assert.throws(() => vault.get({ ...binding, backend }), code('INVALID_INPUT'));
  }
});

test('an active bearer cannot be shared across grants', t => {
  const f = fixture(t);
  const vault = f.open();
  vault.put(binding, session());
  assert.throws(() => vault.put(second, session()), code('SESSION_NOT_INDEPENDENT'));
  assert.throws(() => vault.get(second), ReconnectRequired);
  assert.deepEqual(vault.get(binding), session());
});

test('expiry and cap expiry require reconnect regardless of living MCP refresh authority', t => {
  const f = fixture(t);
  let vault = f.open();
  vault.put(binding, session());
  vault.put(second, { ...session(second, 'synthetic-capped'), capExpiresAt: now + 100 });
  vault.close();
  vault = f.open({ ...f.config, nowUtcMs: () => now + 100 });
  assert.throws(() => vault.get(second), ReconnectRequired);
  vault.close();
  vault = f.open({ ...f.config, nowUtcMs: () => now + 60_000 });
  assert.throws(() => vault.get(binding), ReconnectRequired);
  assert.throws(() => vault.put(binding, session()), ReconnectRequired);
  vault.put(binding, { ...session(), expiresAt: now + 120_000 });
  assert.equal(vault.get(binding).expiresAt, now + 120_000);
});

for (const column of ['ciphertext', 'nonce', 'tag'] as const) {
  test(`${column} tampering fails authenticated decryption without returning a credential`, t => {
    const f = fixture(t);
    const vault = f.open();
    vault.put(binding, session());
    const db = new DatabaseSync(f.location);
    const row = db.prepare(`SELECT ${column} AS value FROM vault_credentials`).get()!;
    const bytes = Buffer.from(row.value as Uint8Array);
    bytes[0] ^= 1;
    db.prepare(`UPDATE vault_credentials SET ${column} = ?`).run(bytes);
    db.close();
    assert.throws(() => vault.get(binding), ReconnectRequired);
    assert.throws(() => vault.put(binding, session()), ReconnectRequired);
    assert.throws(() => vault.revoke(binding), ReconnectRequired);
  });
}

for (const [column, value, changed] of [
  ['backend', 'https://other.example.test', { backend: 'https://other.example.test' }],
  ['principal', 'other-principal', { principal: 'other-principal' }],
  ['account_id', 'other-account', { accountId: 'other-account' }],
  ['grant_id', 'other-grant', { grantId: 'other-grant' }],
  ['scope', 'full', { scope: 'full' as const }],
  ['key_version', 'key-2', {}],
] as const) {
  test(`AAD rejects tampered ${column} even when the caller matches altered metadata`, t => {
    const f = fixture(t);
    const vault = f.open({ ...f.config, keys: new Map([['key-1', f.key], ['key-2', f.key]]) });
    vault.put(binding, session());
    mutate(f.location, `UPDATE vault_credentials SET ${column} = ?`, [value]);
    assert.throws(() => vault.get({ ...binding, ...changed }), ReconnectRequired);
    assert.throws(() => vault.revoke({ ...binding, ...changed }), ReconnectRequired);
  });
}

test('swapping encrypted envelopes between grants cannot transfer authority', t => {
  const f = fixture(t);
  const vault = f.open();
  vault.put(binding, session());
  vault.put(second, session(second, 'synthetic-other'));
  mutate(f.location, `UPDATE vault_credentials SET
    ciphertext = (SELECT ciphertext FROM vault_credentials WHERE grant_id = ?),
    nonce = (SELECT nonce FROM vault_credentials WHERE grant_id = ?),
    tag = (SELECT tag FROM vault_credentials WHERE grant_id = ?) WHERE grant_id = ?`,
  [binding.grantId, binding.grantId, binding.grantId, second.grantId]);
  assert.throws(() => vault.get(second), ReconnectRequired);
  assert.deepEqual(vault.get(binding), session());
});

test('external key rotation reads old rows, replaces under active key, and key loss fails closed', t => {
  const f = fixture(t);
  let vault = f.open();
  vault.put(binding, session());
  vault.put(second, session(second, 'synthetic-second'));
  vault.close();
  const key2 = randomBytes(32);
  const rotated = { ...f.config, activeKeyVersion: 'key-2', keys: new Map([['key-1', f.key], ['key-2', key2]]) };
  vault = f.open(rotated);
  assert.deepEqual(vault.get(binding), session());
  vault.put(binding, session(binding, 'synthetic-replacement'));
  vault.close();
  vault = f.open({ ...rotated, keys: new Map([['key-2', key2]]) });
  assert.equal(vault.get(binding).token, 'synthetic-replacement');
  assert.throws(() => vault.get(second), ReconnectRequired);
  assert.throws(() => vault.revoke(second), ReconnectRequired);
  assert.throws(() => vault.get(second), ReconnectRequired);
  vault.close();
  vault = f.open({ ...rotated, keys: new Map([['key-2', randomBytes(32)]]) });
  assert.throws(() => vault.get(binding), ReconnectRequired);
});

test('a fresh Node process restores both independent account sessions without inheriting memory', t => {
  const f = fixture(t);
  const vault = f.open();
  vault.put(binding, session());
  vault.put(bob, session(bob, 'synthetic-bob-restart'));
  vault.close();
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { CredentialVault } from ${JSON.stringify(new URL('../src/auth/vault.ts', import.meta.url).href)};
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const vault = new CredentialVault({ location: input.location, activeKeyVersion: 'key-1',
      keys: new Map([['key-1', Buffer.from(input.key, 'base64')]]), nowUtcMs: () => input.now });
    try {
      for (const [binding, expected] of input.sessions) assert.deepEqual(vault.get(binding), expected);
      process.stdout.write('restored');
    } finally { vault.close(); }
  `], { encoding: 'utf8', timeout: 10_000, input: JSON.stringify({ location: f.location, key: f.key.toString('base64'), now,
    sessions: [[binding, session()], [bob, session(bob, 'synthetic-bob-restart')]] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'restored');
});

test('nonce is fresh for every replacement, private files contain no plaintext credential or key, and vault never logs', t => {
  const f = fixture(t);
  const vault = f.open();
  const messages: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { messages.push(args); });
  vault.put(binding, session());
  const db = new DatabaseSync(f.location);
  const first = db.prepare('SELECT nonce, tag FROM vault_credentials').get()!;
  vault.put(binding, session());
  const last = db.prepare('SELECT nonce, tag FROM vault_credentials').get()!;
  db.close();
  assert.equal((first.nonce as Uint8Array).length, 12);
  assert.equal((first.tag as Uint8Array).length, 16);
  assert.notDeepEqual(first.nonce, last.nonce);
  assert.ok(existsSync(`${f.location}-wal`));
  for (const file of [f.location, `${f.location}-wal`, `${f.location}-shm`]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const bytes = readFileSync(file);
    for (const secret of [Buffer.from(session().token), f.key, Buffer.from(f.key.toString('hex')), Buffer.from(f.key.toString('base64'))]) {
      assert.equal(bytes.includes(secret), false);
    }
  }
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.throws(() => vault.put(binding, { ...session(), password: 'synthetic-password' } as VaultSession), code('INVALID_INPUT'));
  assert.throws(() => vault.get({ ...binding, principal: 'SELECT synthetic-token-one' }), code('BINDING_MISMATCH'));
  assert.deepEqual(messages, []);
});

for (const [name, sql] of [
  ['future version', 'PRAGMA user_version = 2'],
  ['application identity', 'PRAGMA application_id = 1'],
  ['checksum', "UPDATE vault_meta SET checksum = 'wrong'"],
  ['missing metadata', 'DROP TABLE vault_meta'],
  ['altered schema', 'ALTER TABLE vault_credentials ADD COLUMN surprise TEXT'],
  ['unknown table', 'CREATE TABLE unknown (value TEXT)'],
  ['missing schema', 'DROP TABLE vault_credentials'],
] as const) {
  test(`opening refuses ${name} without resetting or rewriting stored state`, t => {
    const f = fixture(t);
    const vault = f.open();
    vault.put(binding, session());
    vault.close();
    mutate(f.location, sql);
    const before = readFileSync(f.location);
    assert.throws(() => f.open(), code('SCHEMA_MISMATCH'));
    assert.deepEqual(readFileSync(f.location), before);
  });
}

test('a product or foreign database is refused without modifying it', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.location);
  db.exec('CREATE TABLE check_ins (id TEXT); PRAGMA user_version = 12');
  db.close();
  chmodSync(f.location, 0o600);
  const before = readFileSync(f.location);
  assert.throws(() => f.open(), code('SCHEMA_MISMATCH'));
  assert.deepEqual(readFileSync(f.location), before);
});

test('unsafe filesystem locations and key configuration fail with safe errors', t => {
  const f = fixture(t);
  assert.throws(() => f.open({ ...f.config, keys: new Map() }), code('INVALID_CONFIG'));
  assert.throws(() => f.open({ ...f.config, keys: new Map([['key-1', randomBytes(31)]]) }), code('INVALID_CONFIG'));
  assert.throws(() => f.open({ ...f.config, location: ':memory:' }), code('INVALID_CONFIG'));
  chmodSync(f.directory, 0o755);
  assert.throws(() => f.open(), code('UNSAFE_STORAGE'));
  chmodSync(f.directory, 0o700);
  const vault = f.open(); vault.close();
  chmodSync(f.location, 0o644);
  assert.throws(() => f.open(), code('UNSAFE_STORAGE'));
  chmodSync(f.location, 0o600);
  const link = join(f.directory, 'link.sqlite');
  symlinkSync(f.location, link);
  assert.throws(() => f.open({ ...f.config, location: link }), code('UNSAFE_STORAGE'));
  assert.throws(() => vault.get(binding), code('CLOSED'));
});
