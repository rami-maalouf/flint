# MCP runtime: versioned read and write composition

This executable composes the implemented authorization service, encrypted credential vault, account actors, tool handlers and HTTP wrapper. It requires real Node **24.22.2** on POSIX; Bun builds the artifact and manages the service's separate installation boundary. Configuration version 1 exposes exactly ten read tools. Explicit version 2 adds check-in creation/undo, operation lookup, reward previews, confirmed claims and owner connection management, for fifteen tools. There is no boolean mutation enable flag, password argument, database reset, key regeneration or automatic repair command.

## Configuration

Set `MCP_CONFIG_PATH` to a physical, absolute path to a private UTF-8 JSON file, at most 16,384 bytes:

```json
{
  "version": 1,
  "publicOrigin": "https://habits.example.test",
  "backendUrl": "https://backend.example.test",
  "dataDirectory": "/var/lib/habit-system-mcp",
  "keyFile": "/etc/habit-system-mcp/keys.json",
  "port": 4413
}
```

Both URLs must be exact HTTPS origins, without a trailing slash, credentials, path, query or fragment. They are fixed for the deployment. The port must be an integer from 1 through 65535. Port 4413 is illustrative and is not a reservation. The bind address is always `127.0.0.1` and cannot be configured.

Version 2 uses exactly those fields plus `operations`:

```json
{
  "version": 2,
  "publicOrigin": "https://habits.example.test",
  "backendUrl": "https://backend.example.test",
  "dataDirectory": "/var/lib/habit-system-mcp",
  "keyFile": "/etc/habit-system-mcp/keys.json",
  "port": 4413,
  "operations": {
    "installationId": "stable-installation-id",
    "latchPath": "/etc/habit-system-mcp/restore-latch",
    "backendDirectory": "/var/lib/habit-system-fullstack"
  }
}
```

Version 1 rejects `operations`. Version 2 requires exactly `installationId`, `latchPath` and `backendDirectory`; unknown or missing members fail validation. The installation ID must be stable, printable, trimmed and 1 through 255 characters. `backendDirectory` is an absolute physical restore root with read/search access, owned by root or the service user, and protected against group/other writes. Use an accessible parent such as `/var/lib/habit-system-fullstack` when the actual backend deployment is private to its own user. Runtime never opens the backend database directly. The latch's parent must be service-owned and private, physically outside the **entire** MCP data directory and backend restore root. This includes the parent itself, not just the latch filename.

Startup constructs `FileRestoreLatch` with `restoredDirectories: [dataDirectory, backendDirectory]`. It never calls `provisionFresh`, marks, clears, replaces or repairs the marker. Missing, corrupt, unsafe or restored marker state keeps writes and owner resume fenced while trusted reads remain available. The external restore controller must stop admission and durably mark the latch **before** replacing either restore root. Initial provisioning is a separate trusted operation for a genuinely new installation. Matching recovery heads or a valid marker alone are not a claim of complete history, and this runtime supplies no automatic completeness decision or fence-clearing API.

The latch adapter preserves `RecoveryFenceError` and its `restore_latched` reason for the actor's restored-read inspection. It adds retryability for the validated public `OPERATION_PENDING` error projection, without changing readiness or admitting an operation.

The separate key file is UTF-8 JSON, at most 65,536 bytes, with this versioned shape. Angle-bracket values below are placeholders, not keys:

```json
{
  "version": 1,
  "providerSecret": "<cryptographically random provider secret, at least 32 characters>",
  "cursorKey": "<32 random bytes in canonical padded base64>",
  "activeVaultKeyVersion": "v1",
  "vaultKeys": {
    "v1": "<32 random bytes in canonical padded base64>"
  }
}
```

`providerSecret` is bounded to 4096 UTF-8 bytes with no control characters. `cursorKey` and each vault key must decode to exactly 32 bytes; noncanonical base64 is rejected. Supply 1 through 32 vault key versions, each named with 1 through 64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit. The active version must be present. Keep historical versions needed by retained ciphertext. Supply independent random material for the provider, cursors and vault. Provisioning and rotation belong to the operator; startup never writes the key file.

Version 2 derives a separate 32-byte quote key using HKDF-SHA256, the persistent cursor key as input, empty salt and UTF-8 info `mcp/reward-quotes/v1`. `RewardQuoteStore` copies this key; startup immediately zeroes the temporary derived bytes. Its persistent `quotes.sqlite` verifies both public origin and key on reopen. Changing the origin or cursor key without an explicit state migration fails startup; it does not reset quotes or invalidate approval state silently.

Unknown, missing and duplicate object members, unsupported format versions and malformed JSON fail closed. No config field may contain a password or credential; unknown secret fields are rejected with the same fixed error as other invalid configuration.

The data directory must already exist, owned by the service user, with private permissions such as `0700`. The config and key files must be service-owned regular files with one link and private permissions such as `0600` or `0400`. Their immediate parent directories must also be service-owned and private. The key file must be **outside** the data directory. Every path component must be a real directory, not a symlink; use physical paths on macOS rather than `/tmp` or `/var` aliases. Ancestors must be owned by root or the service user and not writable by group/others, except root-owned sticky temporary directories. Final files cannot be executable, symlinks, hardlinks, devices or FIFOs. Symlinked ancestors, dangling symlinks, unsafe ownership and unsafe permissions are refused. Startup does not loosen or repair operator-provisioned permissions.

Use a dedicated unprivileged service user and private local POSIX storage. These checks do not establish safety against another process running as the same user or root, filesystem replacement during execution, or network filesystems with unreliable SQLite locking. No real account or existing secret is needed for the synthetic tests.

## Build and launch

From `services/mcp`, after its frozen dependency installation:

```sh
bun build src/core.ts src/main.ts src/startup.ts --target=node --packages=external --outdir=dist --metafile=dist/metafile.json
MCP_CONFIG_PATH=/etc/habit-system-mcp/config.json /path/to/node-24.22.2 dist/main.js
```

The build script includes **`src/main.ts` and `src/startup.ts`**, retaining `src/core.ts`. `config.ts` is bundled through these entries and needs no separate executable entry. External packages must remain installed under the service boundary.

`startMcpService(config, options?)` from `startup.ts` is the testable factory. It returns `{ address, fetch(request), close() }`; `close()` is asynchronous and idempotent. `address` reports the actual loopback bind. Importing `startup.ts` or the separately built `main.js` does not start a service or install signal handlers. The executable checks its runtime entry path because Bun folds `import.meta.main` at build time.

Tests may pass `{ allowTestPort: true }` with `port: 0` only under Node's test runner (`NODE_TEST_CONTEXT`). The file loader and production executable always reject port zero. There is no HTTP-origin or proxy-trust test escape hatch in this runtime.

## Ownership and durable state

Validation and key decoding finish before binding. Startup then acquires `dataDirectory/ownership.sqlite` through a dedicated `node:sqlite` connection using `PRAGMA busy_timeout = 0`, verified `journal_mode = DELETE` and a retained `BEGIN EXCLUSIVE`. This happens before opening the provider, vault or account actors. A process-global directory-inode registry refuses same-process duplicates before opening or closing the lock inode, including across separately bundled copies of the factory. This is required because closing another descriptor for an inode can release POSIX process locks.

Only the ownership database uses the retained exclusive rollback-journal transaction. Provider, vault, quote and replica databases retain their existing storage behavior. The service creates private files and the `accounts/` directory; existing provider/vault/quote files and SQLite sidecars are checked before opening. The process lock remains held until HTTP exchanges and component closure complete. A failed component close retains ownership until process exit. Startup failure closes constructed components; it never deletes state. SIGKILL releases the OS lock without requiring deletion of the retained ownership file.

Version 2 account actors use the restore latch, `createMutationNormalizer(approvedClaimNormalizer(quotes))`, fresh `context.assertActive()` authorization and the provider's direct `deliveryGrantStatus` metadata query. No grant cache, credential fallback or stronger-session lookup is added. Provider revocation goes through `accounts.revokeDeliveryGrant` before committing the provider cutoff. The quote normalizer requires the exact browser-approved quote and current reward stamp for first admission; durable operation replay retains the accepted receipt. The provider refuses version 1 startup against a database with active write grants, preserving coordinated revocation rather than silently downgrading the runtime.

Retain and back up the entire data directory, including provider signing material, encrypted vault, quotes, account replicas and SQLite sidecars. Back up external keys separately and consistently; the external latch remains outside both restored roots. Never delete the lock file while a process may be alive, replace an unknown database, remove historical keys to bypass an error, or substitute newly generated keys after a restart failure. Operational backup, restore and off-host completeness control belong to the parent-owned M24 workflow.

## HTTP and shutdown

The TLS proxy must preserve the configured public Host, Authorization and valid Origin while forwarding to loopback. The parent-owned HTTP wrapper checks the exact URL host, Host header and Origin, then reconstructs only the configured HTTPS origin before the provider receives the request. `X-Forwarded-Host` and `X-Forwarded-Proto` never select authority. Health requests use the same host/origin checks.

Version 1 `GET /mcp/health` returns only `{"status":"ok"}` and `GET /mcp/ready` only `{"status":"ready"}` after local components initialize. Version 2 adds `restoreFenced: true` or `false`, computed from the external marker on each health request. This is a global restore gate status, with no account, database path, SQL, credential or upstream state. A false restore fence is not a claim that every account may write or that its operation history is complete. Readiness means local startup completed; it is not an upstream connectivity or synchronized-account claim. Responses disable caching. During drain, accepted requests and the factory fetch handler return 503; the listener stops admitting new connections.

Version 2 mounts the accepted confirmation handler on `/mcp/reward-confirmation` and the connections handler on `/mcp/connections`; unhandled paths continue to the provider, including standalone owner sign-in. The HTTP wrapper performs fixed-origin checks and normalization before invoking either browser handler. Owner revocation and explicit resume use their authenticated, CSRF-protected POST flows. Runtime does not parse, recreate or bypass those contracts.

Fixed listener limits:

| Boundary | Limit |
| --- | --- |
| HTTP headers | 16,384 bytes and 64 header fields |
| Request body | 65,536 bytes, including chunked POST bodies, enforced by the official Node adapter; GET/HEAD reject transfer encoding or positive content length before dispatch |
| Complete request headers | 5 seconds, checked every second |
| Complete incoming request | 10 seconds, checked every second |
| Socket inactivity / entire exchange | 20 seconds each |
| Keepalive idle time | 5 seconds plus Node's native keepalive buffer |
| OS connections | 128; excess connections close |
| Concurrent adapter exchanges | 64; excess requests receive 503 |
| Requests per socket | 100 |
| Shutdown HTTP grace | 20 seconds, then force-close remaining HTTP connections |
| Executable shutdown deadline | 30 seconds, then exit 1 |

The Node APIs were checked against the pinned runtime's built-in `_http_server` and `net` sources and the official [HTTP server documentation](https://nodejs.org/docs/latest-v24.x/api/http.html#class-httpserver). The [maxConnections API](https://nodejs.org/docs/latest-v24.x/api/net.html#servermaxconnections) is configured on the same server. Parser timeouts have up to one check interval of scheduling delay. Exchange timeouts close the socket; they do not imply cancellation of an upstream operation or a database reset. The account actor independently bounds read/sync work and drains its outstanding work before closing.

`createHttpService` also uses its default `ServiceLimits`: 16 active protected handlers, 120 MCP calls per grant/minute and 600 globally/minute, 30 login POSTs/minute, 30 registrations/hour, 300 other auth admissions/minute and at most 4096 grant windows. Limit state is process-local under the service's single process owner. Its existing response/error behavior is preserved; runtime adds no configurable bypass or arbitrary key bucket.

SIGTERM and SIGINT mark shutdown, stop the listener, drain accepted exchanges, close HTTP/browser handling and account work, then close authorization, quotes and the vault and release ownership. Account drain retains access to provider metadata, the quote store and credentials until it finishes. Shutdown never resets any data. The executable retains fixed ready/stopped/error messages, and the HTTP layer emits validated redacted diagnostic JSON containing only its allowed request/operation IDs, tool, duration, failure code and delivery state. It cannot emit arbitrary event fields or alter the operation result when the sink fails. Startup errors use `McpRuntimeError` codes `CONFIG_INVALID`, `KEY_FILE_INVALID`, `UNSAFE_STORAGE`, `ALREADY_RUNNING`, `RUNTIME_UNSUPPORTED`, `START_FAILED` and `SHUTDOWN_FAILED`; underlying exception messages and config values are not printed.

This composition adds no deployment, phone, schema, native or production changes. Remote client certification and external restore/completeness operations remain separate verification work.

## Synthetic evidence

From the repository root:

```sh
bun build services/mcp/tests/startup.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/startup.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/startup.test.mjs
bun build services/mcp/tests/runtime-writes.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/runtime-writes.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/runtime-writes.test.mjs
```

The startup suite exercises strict private configuration and key formats; unknown/duplicate fields; bounded files; symlinks, hardlinks and unsafe permissions; no bind on configuration/key/storage failure; fixed public Host and HTTPS SDK metadata discovery; anonymous MCP denial through the official client; excessive headers and declared/chunked bodies; slow headers and excess connections; same-process refusal without releasing the OS lock; graceful drain and shutdown 503; and actual built Node child processes across duplicate startup, SIGKILL, restart, SIGTERM and SIGINT. An encrypted synthetic session and the external key file survive restart, and subprocess output is checked for secret, path and SQL leakage. A separate import of the built executable proves that import does not auto-run.

`runtime-writes.test.ts` uses real Node HTTP, the official SDK, durable Snapback, SQLite and a scoped synthetic HTTPS proxy. It verifies the version 2 fifteen-tool catalog, read-grant write denial, check-in creation/undo, persistent quote approval and claim after restart, origin/key mismatch refusal, active-write downgrade refusal, owner revocation, version 1's ten-tool catalog, and missing/corrupt/restored latch fences without marker repair or application effects. A restored runtime must still serve trusted reads, and owner resume cannot override the latch. The test bridge uses `node:http` to preserve the public Host because Node's native fetch rewrites Host to the target URL. No production fetch injection, credential lookup or stronger-session fallback is introduced.

These suites do not substitute a fake authorization provider or exercise real account credentials. Parent-owned auth, confirmation, connections, limits and recovery tests provide the deeper boundary cases. Targeted checks must pass; concurrent owners' unfinished files may temporarily prevent a full service lint/typecheck and must be reported separately.

### Socket probe isolation on Linux ARM64

The 2026-10-31 run of committed `8bde297` exposed a test ordering race. The combined capacity/header test destroyed 128 client sockets and immediately opened its slow-header connection. Client-side destruction does not wait for the server to process the peer closes. An isolated Oracle reproduction with pinned Node 24.22.2 traced two server capacity drops, both with 128 accepted connections, zero observed closes and 128 active connections. The second drop was the slow-header probe, which closed in roughly 0.26 seconds without reaching the HTTP parser. This was correct capacity enforcement, not a failed parser timeout.

Capacity and slow-header checks now use separate fresh service instances. The capacity case still requires the excess connection to close while all admitted sockets remain open. The parser case still requires an actual `HTTP/1.1 408 Request Timeout`, retains its eight-second client timeout, and additionally rejects a response before the configured five-second header deadline. No production listener behavior changed. The unsafe-file fixture also applies `chmod(0644)` explicitly, since a secure `umask 077` otherwise masks its requested create mode to `0600` and tests corrupted SQLite instead of unsafe permissions.

All 13 startup tests passed on macOS and Oracle Linux ARM64 under `umask 077`, using Node 24.22.2. The Oracle run included `--experimental-test-coverage` and emitted a scoped coverage report without warnings. Remote evidence is private under `/home/ubuntu/habit-mcp-release-20261031-8bde297/source/services/mcp/.artifacts/startup-linux-probe.W5SfFO/`: the original bundle, socket trace, original failure with coverage, secure-umask failure, corrected bundle and `full-startup-green-coverage.log`. The corrected test overlay was bundled against the unchanged committed service graph. Every service used dynamic loopback ports.

The earlier 293-test run reported an empty Node coverage file and did **not** generate a complete service coverage report. That warning was not reproduced by the isolated original socket failure with coverage or by a separate inherited-coverage/SIGKILL probe. Its original temporary file had already been removed by Node cleanup, so its cause is unconfirmed. The successful scoped startup run does not replace a new full service coverage run or justify ignoring that warning.

### Coverage of crash-only dependency processes

The subsequent Linux ARM64 `982edfe` run passed all 297 assertions but failed coverage aggregation on a 131,072-byte truncated V8 JSON file. That temporary file was also already removed. A fresh, bounded reproduction invoked `snapback4/proof`'s real `command('/usr/bin/true', [])` 100 times, without MCP services or listeners. Every command succeeded; Node coverage failed with the same truncation and parser error. Retained file `coverage-1530399-1793412254010-0.json` belonged to the exact installed `snapback4/dist/proof-command.js` process, PID 1530399, which the process trace recorded exiting through SIGKILL. A bounded one-MiB URL extraction read its entire 131,072 bytes: only built-in Node URLs preceded the truncation, so identification came from the matching spawn PID rather than an application URL. This proves the fresh failure's writer; it cannot recover either deleted historical file's writer.

The dependency wrapper ends its guard's input during its exit handler. The guard responds to EOF by killing its process group, including the wrapper. That kill can interrupt the wrapper's coverage-file write. Node's [pinned profiler source](https://github.com/nodejs/node/blob/v24.22.2/src/inspector_profiler.cc) writes the JSON during exit; its [process-kill implementation](https://github.com/nodejs/node/blob/v24.22.2/src/node_process_methods.cc) also runs exit hooks before a process kills its own group. The resulting race belongs to the disposable dependency harness, not the MCP listener or SQLite ownership contract.

For `test:coverage` only, `scripts/test.mjs` preloads its `?coverage-child-environment` mode. It sets `NODE_V8_COVERAGE=''` only when `spawn` uses the current Node executable and its first argument is the exact resolved installed `snapback4/proof` sibling `proof-command.js`. That wrapper and its guard are intentionally killed and contain no MCP service implementation. All other spawn arguments and environment fields are preserved. An explicit empty property is necessary because [Node 24.22.2 propagates coverage even through a whitelisted child environment](https://github.com/nodejs/node/blob/v24.22.2/lib/child_process.js). Test workers, direct MCP executable children, and other Node children retain instrumentation. Normal test runs do not install the preload. [Report exclusions apply after JSON parsing](https://github.com/nodejs/node/blob/v24.22.2/lib/internal/test_runner/coverage.js), so excluding dependency paths from the report cannot repair an interrupted file. No dependency, generated bundle, production code, Node version, assertion or root-core coverage gate is changed.

Private Linux evidence is under `/home/ubuntu/habit-mcp-final-tests-982edfe/services/mcp/.artifacts/coverage-probe.4yUm6n/`. `group-coverage.log`, `root-cause.json`, `children.jsonl` and `retained-group/` preserve the red reproduction. `group-green.log` preserves the same 100-command run with the preload and a complete report, exit 0. `async-contract.log` additionally verifies that asynchronous direct Node children retain nonempty coverage, emit valid coverage JSON, and that a different file named `proof-command.js` remains instrumented. It also verifies the dependency wrapper's child receives the explicit empty value. `corrupt-exact-control.log` reinserts the captured truncated bytes into a fresh coverage run: its assertion passes, but Node still reports the parse failure and exits 1. Collection does not filter malformed JSON or suppress warnings.

The final Linux run used `umask 077`, the pinned Node 24.22.2 on `PATH`, the documented native Snapback/age prerequisites, `MCP_PROOF_PUBLIC_CIMD=1`, and `bun run test:coverage` from `services/mcp`. `MCP_NODE` selected `/home/ubuntu/habit-mcp-proof-20261030/node-v24.22.2-linux-arm64/bin/node`; `NODE_V8_COVERAGE` retained raw results in the evidence directory's `retained-full-public/`. `full-public-coverage.log` records **297 passed, zero failures/skips**, a complete coverage report with no coverage warning, and exit 0 in 454.10 seconds. All 96 retained JSON files parsed successfully. Their URLs include all 26 bundled test entries (30 reports across processes), the auth proof, and six direct MCP executable reports, with no proof-wrapper/guard reports. `full-public-instrumentation-audit.json` records that check. An earlier runner-fix run also emitted coverage and exited 0, but omitted the public CIMD flag and skipped two checks; it is retained separately as `full-coverage.log` and is not the zero-skip gate.

Mac Node 24.22.2 passed all 13 startup cases plus the two scoped harness checks, with coverage and exit 0; a separate asynchronous-spawn contract also passed. The Mac raw-file audit found the startup test worker and five direct MCP executable reports. For the verified snapshot, service lint, service typecheck and a separate `tsc --allowJs --checkJs` check of `scripts/test.mjs` passed on both platforms. These are MCP service checks, not a new measurement of the unchanged root-core 100-percent gate; later parallel authorization changes require their own integration gates.
