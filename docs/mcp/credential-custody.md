# M06a credential custody

This bounded slice provides `CredentialVault` in `services/mcp/src/auth/vault.ts` on the selected Node 24.22.2 runtime, using real `node:sqlite`. It does not complete M06 browser identity or the OAuth, consent, revocation coordinator, account actor, delivery barrier, or reconnect browser routes.

## Caller contract

Construct with `{ location, activeKeyVersion, keys, nowUtcMs? }`. `location` is an absolute path to a dedicated vault SQLite file, separate from provider, product and operation databases. `keys` is a `ReadonlyMap<string, Uint8Array>` of opaque versions to exactly 32 externally provisioned random bytes; the active version must exist. Supply private systemd credential material through deployment configuration. The vault never generates a fallback key, writes a key, accepts a password, or logs input. It copies keys into private `KeyObject`s; the caller owns cleanup of its original key buffers.

The synchronous API is:

```ts
type VaultBinding = Readonly<{
  backend: string;
  principal: string;
  accountId: string;
  grantId: string;
  scope: 'read' | 'full';
}>;

vault.put(binding, session);
const session = vault.get(binding);
vault.revoke(binding);
vault.delete(binding); // identical local custody semantics to revoke
vault.close(); // idempotent
```

Bindings use the canonical HTTPS backend origin, the verified immutable Snapback principal, an opaque internal account ID, and a globally unique server-issued grant ID. Backend origins normalize hostname case, default ports and a trailing slash. HTTP, credentials in URLs, paths, queries, fragments and control characters are refused. The scope here is the **upstream Snapback session scope**, not the MCP OAuth scope set. The provider must separately enforce the exact MCP scopes on every invocation.

`VaultSession` accepts only `{ principal, kind, token, expiresAt, scope, capExpiresAt? }`, with explicit `read` or `full` scope and UTC millisecond timestamps. Unknown properties, including a password, are refused. Session principal and scope must exactly match the binding. The vault cannot verify a bearer with Snapback or prove independent session issuance. The caller must verify authenticated upstream identity and obtain a separate session for each grant. Reuse of an identical bearer by two active stored grants is additionally refused using a unique SHA-256 token fingerprint.

Every `put`, including replacement, requires the caller's explicit current consent. Full sessions require explicit write consent at that boundary. Storing a full session does not authorize a read caller to use it, and the vault never looks up another grant as fallback. A session cannot be attached to a different backend, principal, account or scope by reusing its grant ID. Scope changes need a new grant.

## Encryption and durable state

Each write uses AES-256-GCM, a fresh random 12-byte nonce and a 16-byte authentication tag. Versioned, unambiguous JSON tuple AAD binds the canonical backend, principal, account ID, grant ID, upstream scope and encryption key version. The encrypted payload contains the complete allowlisted session, including expiry, or an authenticated null-session revocation tombstone. Plaintext is returned only after authentication succeeds. Temporary plaintext buffers are cleared; immutable JavaScript strings and caller-held session objects cannot be reliably erased by this module.

The database exposes binding metadata, key version, nonce, tag, ciphertext and a token fingerprint. These are not plaintext bearer credentials. Metadata and fingerprints still need private custody. Active bearer equality is observable from its fingerprint; only high-entropy upstream tokens belong here. Keys remain outside the database and repository. No SQL statement receives plaintext session data or key bytes.

Schema 1 has an application ID, durable version marker and SHA-256 schema checksum. Opening verifies the metadata and exact stored SQL schema. A foreign database, unknown version, changed checksum, missing object or additional object is refused without resetting it. Empty dedicated storage is initialized atomically. Mutations use `BEGIN IMMEDIATE`, WAL and `synchronous=FULL`; successful calls commit before returning.

Use an owner-only directory, normally mode 0700. New database files are mode 0600, and SQLite inherits their private mode for WAL/SHM. Existing directory, database and sidecars must be owned by the process user with no group/other permissions; files must be regular and singly linked. Final directory/database/sidecar symlinks are refused, including dangling ones. The vault does not loosen or silently repair unsafe permissions. Ancestor paths and the service OS user must be trusted. This is POSIX-only and assumes the deployment's single trusted service process; it is not a replica ownership lock or distributed fence.

## Expiry, replacement and revocation

Missing, revoked, expired, unauthenticatable or unavailable-key credentials throw `ReconnectRequired` with code `RECONNECT_REQUIRED`. Expiry is the earlier of `expiresAt` and optional `capExpiresAt`, including equality with the current clock. MCP refresh authority never extends that lifetime. The vault performs no upstream refresh, password login or automatic rotation.

After new explicit consent, `put` may durably replace an expired session under its unchanged binding. It authenticates the previous row before replacement. Revocation also authenticates the row and commits an encrypted null-session tombstone, preserving its immutable grant binding and every other grant. Repeated revocation is safe. A tombstone may receive a new independent session after fresh consent under the identical binding. Deleting a never-stored grant reserves its supplied binding with a tombstone.

Rotate keys by adding a new externally supplied version and selecting it as active while retaining prior keys. Existing rows remain readable under their recorded version; replacement or revoke writes under the active version. There is no automatic bulk re-encryption. Do not retire an old key while any active row or tombstone still needs it. Missing or incorrect keys fail closed. Without the original key, the vault cannot authenticate a binding for replacement or tombstone creation: recover that key, or reconnect with a new grant ID after the external provider has invalidated the old grant. Do not rewrite stored metadata or delete a row to bypass this refusal.

Local revocation does not invalidate OAuth access/refresh tokens, log out Snapback, pause queued delivery, cancel an in-flight request, or erase a session object already returned to a caller. Those operations require the caller's account lane and lifecycle coordinator. Old encrypted pages may remain in WAL, snapshots and backups. This module provides authenticated custody, not physical erasure, database rollback detection or protection against a compromised process that can access keys. Provider revocation and restoration fencing must remain authoritative even if an older vault backup is restored.

Errors use fixed `VaultError` codes/messages and omit underlying causes, SQL, filesystem paths, principal details, tokens and keys. Malformed input and binding mismatches have distinct safe codes. No logger hook exists. Callers must avoid logging sessions or constructor configuration and must map these internal errors to safe protocol responses.

## Verification

From the repository root:

```sh
bun build services/mcp/tests/vault.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/vault.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/vault.test.mjs
```

The machine-local Node path is a launcher, not a deployment requirement. Tests assert the exact Node version and absence of Bun's runtime. Initial red: 27 failures against the unimplemented stub. A second behavioral red caught unauthenticated revoke accepting tampered envelopes; enforcing authentication made it green. Final focused result: 28 passed, zero failed/skipped, including a fresh Node subprocess restart. Fixtures use synthetic sessions and random disposable keys, bounded temporary SQLite files, and cleanup.

Coverage includes two grants on one account plus a second account, durable replacement, targeted revoke, immutable bindings, all AAD fields, ciphertext/nonce/tag/key tampering, copied envelopes, missing keys, expiry/cap expiry, scope/principal mismatch, unknown schema, private files, and plaintext token/key exclusion in database/WAL/SHM. Console calls are intercepted during custody and rejection paths to assert no credential logs. This is vault integration evidence, not upstream credential verification, browser identity or end-to-end MCP lifecycle evidence. Parent-owned canonical checks and independent review remain separate.

Implementation references: [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), including AAD-before-update, explicit tag length and authentication-before-return; [Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) for `DatabaseSync` and parameter binding.
