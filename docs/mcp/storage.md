# Server product SQLite adapter

`services/mcp/src/storage/sqlite.ts` exports `NodeSqlDatabase`, a production implementation of the shared `SqlDatabase` port over `node:sqlite`. Its constructor accepts a product database path, defaulting to `:memory:` for tests. Call `initializeProductDatabase` with the server's ID and hashing ports after opening it; the adapter does not duplicate migrations or bootstrap logic.

The service runtime is pinned to official Node **24.22.2**. Bun builds the TypeScript bundle, but Node executes it. Bun's SQLite emulation is explicitly refused. Installed Node 24.13.0 silently truncates embedded-NUL TEXT on reads; an open-time round-trip probe refuses that implementation before product access. The proof ran on the checksum-verified Darwin ARM64 binary `/tmp/node-v24.22.2-darwin-arm64/bin/node`. Linux deployment compatibility still needs verification on the selected deployment artifact.

## Ownership and transactions

Every public operation, including direct reads, writes, static `execAsync`, both transaction forms and close, uses the same FIFO lane. Query parameters are copied at admission and passed as bound values. A rejected operation does not prevent later work from running.

Exclusive callbacks use `BEGIN EXCLUSIVE`; snapshot callbacks use `BEGIN DEFERRED`. The adapter awaits the callback before `COMMIT`, and rolls back callback or commit failures. Callbacks must await all their work and use the provided `tx` executor. Calling and awaiting the outer database from inside a callback would wait for that callback's own lane. The scoped executor bypasses the public queue and refuses calls after the callback ends.

`closeAsync` immediately stops accepting new work, waits for already accepted work, and closes once. Repeated close calls share the same promise.

Each connection enables foreign keys, WAL for file databases, `synchronous = FULL`, and a 5000 ms busy timeout. In-memory SQLite uses its memory journal. SQLite calls execute synchronously; the asynchronous port controls ownership across awaited core callbacks, without moving SQLite work onto a worker thread.

This adapter serializes one connection. The account runtime must still enforce one process owner per replica, bounded account admission and handles, and recovery before serving requests. It must not open another adapter instance as an independent account writer.

## Schema refusal

Before changing database pragmas, open checks `user_version` and the recorded product migration checksums against the unchanged core migrations. Only an empty database or a contiguous released schema prefix with a matching version marker is accepted. Unknown versions, missing ledger entries, checksum mismatches, missing ledgers on existing databases, and inconsistent markers are refused. The adapter closes the rejected handle and never deletes, resets or replaces the database. Known older prefixes can then migrate through the core bootstrap to schema 12.

## Reproduce the proof

Run from the repository root, without installing packages:

```sh
bun build services/mcp/tests/storage.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/storage.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/storage.test.mjs
bunx --no-install eslint services/mcp/src/storage/sqlite.ts services/mcp/tests/storage.test.ts
bunx --no-install tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module preserve --moduleResolution bundler --types node services/mcp/src/storage/sqlite.ts services/mcp/tests/storage.test.ts
bun run typecheck
```

All 18 tests pass on real Node 24.22.2. The shared core is bundled into the artifact; built-in Node modules remain external. Fixtures are synthetic temporary directories and are removed after testing. Tests cover:

- All 12 real migrations and their checksums, plus upgrade of a released prefix.
- SQLite connection settings and enforced foreign keys.
- Bound text containing NUL, Unicode and SQL-looking content, numeric values and null.
- Awaited rollback in both transaction forms, excluding all direct query methods and another transaction while the first callback is paused.
- A deferred read snapshot across an awaited write from a separate real SQLite connection.
- Commit-time deferred-constraint failure, rollback and subsequent successful work.
- Real `createBoard` and `createCheckIn` commands, retained device/HLC/receipts/outbox after close/reopen, and receipt replay without an extra check-in or outbox entry.
- Scoped executor expiration, draining close, and refusal of six invalid schema states without changing database bytes.

Before implementing the production adapter, the initial tests ran against the existing `tests/product/helpers/test-db.ts` adapter as a real SQLite baseline. The red command was:

```sh
bun build services/mcp/tests/storage.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/storage-red.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/storage-red.test.mjs
```

At that point the test import selected the existing adapter. That run failed both transaction isolation cases: direct `getFirstAsync`, `getAllAsync`, `runAsync` and `execAsync` executed while the transaction callback awaited. It also failed draining-close and schema-refusal assertions. The final tests import the production adapter; the ignored red bundle preserves the historical baseline. Initial baseline assertions also exposed Node rows' null prototypes; final value comparisons explicitly account for those prototypes.

To confirm that the installed old runtime fails closed, run:

```sh
node --test --test-name-pattern='bound values' services/mcp/.artifacts/storage.test.mjs
```

On installed Node 24.13.0 this intentionally exits 1 with `node:sqlite truncates embedded NUL text. Use the verified Node 24.22.2 runtime.` Do not treat that runtime as supported or replace the proof with `bun test`.
