# Read-only durable account replicas

M08 implements `AccountActors` in `services/mcp/src/accounts/actor.ts` and the owned SQLite lifecycle in `accounts/replica.ts`. Bun bundles the service; the verified runtime is Node 24.22.2 with real `node:sqlite` and Snapback 0.4.49. This increment enables no mutations, delivery worker, journal recovery implementation or recovery-head publication.

## API for read tools

Construct one manager for the service, with a fixed canonical backend and a private, persistent root:

```ts
import { AccountActors } from './accounts/actor';
import { listActiveBoards } from './core';

const accounts = new AccountActors({ root: replicaRoot, backendUrl });
const result = await accounts.withAccount(ctx, {
  timeZone: 'America/Toronto',
  freshness: 'require_sync',
}, async runtime => {
  const boards = await listActiveBoards(runtime);
  if (!boards.ok) throw new Error('Habit projection unavailable.');
  return boards.value;
});
// result is { data, meta }; validate/map data through the tool contract.
await accounts.close();
```

`withAccount<T>(ctx, options, work)` returns `Promise<{ data: T; meta: Metadata }>`. It imports the agreed `AuthContext` from `auth/context.ts`: account ID, client ID, grant ID, principal, scopes, fixed backend URL, exact grant session and asynchronous `assertActive()`. Handlers still enforce tool scopes, input schemas, redaction, response bounds and output contracts. They must not accept an account path, owner or backend from tool input.

`runtime` contains `db`, immutable `clock`, `hashing`, `ids`, `meta`, `recovery` and `signal`. A fresh clock is captured when the request enters its account lane. Its time and validated zone never change; the default zone is UTC for tools without date-sensitive input. Date-sensitive contracts require an explicit zone. `db` supports read queries and snapshot transactions. Write/close/exec capabilities are denied, SQLite is query-only during the callback, and escaped capabilities expire at callback completion or deadline.

Await every callback operation, use a transaction's `tx` inside that transaction, and do not re-enter `withAccount` from its callback. Trusted callbacks must finish and honor `signal`; a request deadline rejects the caller without releasing an occupied lane prematurely. `close()` refuses new admission and drains accepted work before closing handles. It cannot preempt a synchronous SQLite call or an uncooperative callback.

The manager checks MCP authority at admission, lane entry, network boundaries, after pulling and immediately before delivering the callback result. Failed authority never falls back to cached data. The request snapshots its context and session, verifies session/principal agreement, requires an exact configured backend match, and checks both durable bindings. It never discovers another grant, refreshes a session or upgrades a credential. The SDK receives a bare token. Its `readOnly` option is used for read bearers because the SDK deliberately refuses full bearers in that mode. Both scopes use the same pull-only engine and HTTP mutation guard.

## Persistence and ownership

The account directory name is SHA-256 of the opaque internal account ID. It contains:

- `ownership.sqlite`: a dedicated connection holds `BEGIN EXCLUSIVE`, DELETE journal mode and busy timeout zero for the entire open lifetime. A second process is refused. The OS releases ownership on crash. No PID, timestamp or lease grants ownership, and the lock file is never removed.
- `replica.sqlite`: service schema 1, exact schema verification, durable account/backend/principal binding and last healthy pull/revision. Its binding and initial schema commit together with full SQLite durability.
- `product.sqlite`: the production adapter and unchanged core migrations, device ID, HLC, cursor, admission and outbox. Existing product schema/checksum refusal remains in force. Bootstrap uses `initializeProductDatabase`, a local sync-enable flag and `runSync({ mode: 'pull_only' })`.

Directories are private mode 0700 and files mode 0600, owned by the service user. Unsafe files, final symlinks, hard links and unknown schemas are refused. Ancestor directories and the service OS user must be trusted. Keep the root on a filesystem supporting SQLite locking; distributed ownership and horizontal scaling are unsupported. SQLite rollback locking follows the [SQLite locking contract](https://www.sqlite.org/lockingv3.html).

One FIFO lane includes open/retry, binding verification, recovery, bootstrap, pulls and reads. Requests from different clients of the same account share that lane and device; different accounts can proceed independently. Open failures do not poison retries. Idle or capacity eviction closes handles without deleting files, queues, device identity or HLC. A missing or empty previously healthy product file is refused, never automatically recreated as a replacement cache.

## Freshness and metadata

Every read attempts a bounded pull. Transport `ensureZone` and `upload` are disabled. A second HTTP guard allows SDK reads and refuses provider mutation/action routes even with a full credential. Local validation and reconciliation may retain derived facts and outbox rows; those pending deliveries alone do not invalidate a completed read-only observation.

`require_sync` is the default. Offline, reconnect, interrupted pagination, deadline, deferred records or unresolved admission prevent a fresh result. Errors use `AccountError.code`, with `INVALID_INPUT`, `FORBIDDEN`, `RECONNECT_REQUIRED`, `SYNC_ATTENTION`, `UNAVAILABLE`, `RATE_LIMITED` or `OPERATION_PENDING`; errors also carry `retryable`. Filesystem/ownership failures use `ReplicaError` with `UNAVAILABLE` and `retryable: true`.

`allow_cached` permits a result only after this durable replica previously completed a healthy pull. A failed first pull, partial initial bootstrap or first quarantine cannot become a healthy empty account. A separate durable marker records that distinction because the core can record a completed pass with unresolved admission. Expired upstream authority can return an explicitly requested healthy cache while valid MCP authority remains required.

The common `Metadata` contains observation time, last healthy completed pull time, current persisted change token as backend revision when available, status, pending deliveries, repository-derived pending/blocked/quarantined counts, deferred count and `usedCached`. Failure statuses remain explicit: `offline`, `reconnect_required`, `sync_attention` or `incomplete`, with `usedCached: true`. They never become `up_to_date`. Cached mode reads the retained product database, which can include admitted pages from a later interrupted pull; it is not rollback to a historical snapshot. Its last healthy pull time remains unchanged. Observation describes the backend, not changes still offline on phones.

## Recovery boundary for M12/M13

The default recovery status is always:

```json
{"writeFenced":true,"deliveryPaused":true,"reconnectRequired":false,"recoveryReason":"read_only_reconstruction"}
```

This explicitly permits only the M08 read-only reconstruction path. If a local journal or any product command receipt exists, the default refuses account work with `OPERATION_PENDING`. It does not fabricate successful journal recovery. Expected read-generated reconciliation facts have no command receipt and remain queued.

`AccountOptions.recover` is the required integration point for an existing write replica. It runs on every admitted account turn, under the same process owner and lane, after existing identity bindings are checked and before core initialization, local fact recovery, pulling or reads. It receives `{ db, directory, context, ports, signal, assertActive }` and must return a validated `RecoveryStatus` or throw. Its raw database and directory are trusted lifecycle capabilities, never public tool capabilities. M08 still forces `writeFenced` and `deliveryPaused` true on its read runtime regardless of the callback's response.

M12/M13 must integrate retained journal-chain/receipt recovery, the independently retained restore latch, recovery-head comparison, grant delivery barriers and commit authorization into this lane before adding a protected mutator. Read admission must continue to use the exact request grant. A read session may compare a matching head, but cannot publish an unpublished tail or run pending write intent. If recovery cannot establish a safe state with that authority, it must refuse before core reconciliation, or use a separately proven read-only degraded reconstruction. Matching restored heads alone cannot clear a restore fence. Preserve the [M04R restore protocol](recovery.md) and [operation retention contract](operations.md).

There is no public raw-database mutator in M08. Adding the shared-lane protected mutator and explicit journal/delivery ownership belongs to the separate M12/M13 increment. Do not use the read callback or its recovery hook as a mutation tool.

## Bounds

Defaults are 16 open replicas, 32 accepted running/queued turns per account, 128 outstanding service turns, a 15-second request deadline, 10-second pull deadline, 64 core pull pages, 512 SDK fetches including multipart bodies, 60-second idle eviction, 256 MiB per-account storage and 64 MiB minimum free disk. Constructor overrides must be positive safe integers. Admission reserves opening accounts too. Busy accounts are never evicted. Pressure closes the oldest idle handle before refusing a new account.

Pull pages and SDK fetches share deadline/continuation guards. SDK fetches receive an abort signal; timeout stops the core before another page commit. Pull timeout leaves time for explicit cached fallback within the request deadline. Storage is checked before work, at page admission and after a pull, with a SQLite product page-count cap and bounded WAL checkpoint settings. File and sidecar checks are admission limits, not a filesystem quota; a page transaction can temporarily grow sidecars. Future service hardening still owns external quotas, rates and deployment resource measurements.

## Verification

From the repository root:

```sh
bun build services/mcp/tests/accounts.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/accounts.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/accounts.test.mjs
```

From `services/mcp`:

```sh
bun run lint
bun run typecheck
```

The focused suite passes **19/19** on Node 24.22.2, about six seconds locally. It deploys the actual schema to one temporary Snapback server and uses real SDK sessions, production SQLite and core bootstrap/sync. Immutable synthetic backend fixtures are reused to stay below identity throttles; every local replica root is isolated, and backend-mutating cases have dedicated synthetic accounts. Sign-in fixtures have explicit two-second deadlines. Temporary state and child bundles are removed.

The suite proves account/client isolation, simultaneous opens, serialized reads with independent zones, exact read credentials and zero provider mutations with retained legacy-derived facts, failed bootstrap/retry, cached/required outcomes, revocation checks, durable binding refusal, idle/capacity eviction, read-capability expiration, unknown schema retention, mandatory write-replica recovery, a separate actor process refusing a competing owner until actual SIGKILL, queue/handle limits, aborted SDK fetch deadlines, disk admission refusal, emptied-file refusal, actual multi-page retry and quarantined immutable input. Expired upstream authority is distinguished from revoked MCP authority.

Recorded red baselines: the initial isolation test failed with `Account replica bootstrap has not been implemented`; a stalled SDK fetch exceeded the required sub-second pull bound before the separate pull deadline; an emptied previously healthy file initially produced `Missing expected rejection`. The final suite passes all three. No production backend, private account, Expo/root quality gate or git index was used by this increment. Darwin process-crash evidence does not establish Linux power-loss durability or complete M12/M13 recovery.
