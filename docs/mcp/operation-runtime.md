# Protected account operations

M12 integrates the existing `OperationJournal` and `RecoveryHeadAdapter` with the M08 account owner and FIFO lane. It adds internal operation and account-control methods. No mutation tool is advertised, no HTTP mutation route is added, and product delivery remains parked for M13. The service's existing read-only configuration remains functional without an operation policy.

## Interfaces

`AccountActors` accepts an optional `operationPolicy: OperationPolicy`. Providing it requires all three trusted dependencies:

```ts
type OperationPolicy = {
  latch: RestoreLatch;
  authorize: (admission: OperationAuthorization) => Promise<void>;
  normalize: (request: MutationRequest, frozen: NormalizeContext) => Promise<{
    timeZone: string;
    command: CoreCommand;
  }>;
  maxOperations?: number;
  failpoint?: (point: Failpoint) => void; // test-only injection
};
```

There is no default publisher, permissive authorization, session lookup or execution callback. The policy cannot be combined with M08's legacy `recover` callback. Production composition must supply a real independently provisioned restore latch, current-grant/account-barrier authorization and tool-specific normalization. Startup is not automatically wired to this capability by M12.

The public TypeScript methods are:

```ts
runOperation(ctx: AuthContext, request: MutationRequest):
  Promise<{ data: JournalOperation; meta: Metadata }>;

lookupOperation(ctx: AuthContext, operationId: string):
  Promise<{ data: JournalOperation | null; meta: Metadata }>;

withAccountControl<T>(ctx: AuthContext,
  work: (control: AccountControlRuntime) => Promise<T>): Promise<T>;
```

`request.clientId` must exactly equal `ctx.clientId`, the actual OAuth client lineage. Tool input schemas, operation ID, matching client, required scopes and a current full upstream session are checked before account acquisition. The request is captured before queueing. `grantId` is deliberately absent from the journal fingerprint, while original grant provenance remains durable across reconnects.

Operation lookup requires the `get_operation` read permission before validating the ID or entering the account lane. Known and unknown IDs receive the same scope refusal. A found operation additionally requires its original tool permissions and client lineage.

`JournalOperation` is an internal result including frozen intent, receipt/result, exact wire tuples and delivery state. Public handlers must map it to the existing public operation contract, enforce response bounds and avoid exposing internal intent/tuple data. A completed local mutation normally returns `state: 'pending_sync'` and `delivery: 'pending'`. Metadata is reread after the command so pending counts include its actual outbox. A completed pull is an observation of the backend and does not acknowledge delivery of the new operation.

## Trusted policy contracts

`OperationAuthorization` contains `{ context, action, intent, originGrantId, request? }`. Actions are `recover`, `prepare`, `execute`, `read`, `publish` and `control`. The current request context is always supplied; no different grant or stronger credential is loaded. `prepare` includes the validated request before journal preparation. Intent-specific actions include the immutable intent and its original grant ID. Lifecycle actions have null intent/origin.

The actor checks `ctx.assertActive()` around authorization and before returning protected data. Execution additionally requires the original client and grant, original tool permissions, a full live upstream session and a ready restore latch. The real core command opens its own transaction. Its transaction callback is wrapped with authorization/latch checks before work and immediately before commit; there is no enclosing product transaction or caller-supplied core executor. The account lane gives M13 a place to serialize control changes with that commit.

`NormalizeContext` supplies `{ commandId, nowUtcMs, context, read, undoTarget }`. `read` contains only scoped `getFirstAsync` and `getAllAsync` SELECT/WITH queries, protected by SQLite query-only mode during normalization. The capability expires when normalization ends. `undoTarget(operationId)` uses the current client's actual original create result and existing journal ownership checks. Normalization must resolve logical dates, command arguments and confirmation semantics without changing product data. M14/M19 own those tool-specific rules.

The journal freezes the normalized intent. Execution creates immutable ports using `intent.timeZone` and `intent.nowUtcMs`, then dispatches only `createCheckIn`, `undoCreatedCheckIn` or `claimReward` from the production core entry point. A normalizer cannot substitute an execution function. The existing core persists product data, HLC, receipt and outbox atomically.

## Durable generation and grant origin

`operations.sqlite` is a separate service sidecar inside the already owned account directory. It has exact schema/version checks, account/backend/principal bindings, a durable random generation, journal initialization marker and an `operation_grants` table keyed by `(client_id, operation_id)`. New files are private mode 0600. Generation commits with full SQLite durability and the parent directory is fsynced before the journal is opened. The journal receives that generation; reconnecting never invents another one.

The independent private `replica.sqlite` metadata now has a v2 operation provenance marker. A newly created account starts at `never`; the actor durably changes it to `initialized` before creating `operations.sqlite`, including a provider revocation that creates the delivery barrier before any command. The marker commit and parent directory sync precede sidecar creation. If both operation files later disappear, the surviving marker blocks reads and writes even if product receipts and the remote head are also absent. A missing `replica.sqlite` beside an existing product or operation file also refuses reconstruction. A v1 replica migrates to `initialized` only when operation files remain. With neither file, its history is unknowable, so migration records `unknown` and protected account work stays fenced. This private metadata migration does not change the product schema.

The actor applies that marker fence even when no operation policy is configured. Its legacy read-only recovery path, including an optional trusted legacy recovery callback, refuses `initialized` and `unknown` before product pull. A proven `never` marker still permits the existing read-only reconstruction path. Removing operation files and product receipts cannot make retained write history appear fresh by disabling the policy.

If a grant is revoked after the sidecar has already gone missing, the durable `initialized` or `unknown` marker is an account-wide fence. The provider cutoff can commit under the lane without creating replacement history; protected reads, writes and delivery remain refused pending reconciliation.

An operation's original grant/tool is persisted before `journal.run()` can prepare or execute it. Replays do not overwrite that origin. A same-client reconnect can look up completed intent under its current permissions and policy; it cannot execute a prepared operation belonging to another grant. Same operation IDs under different actual OAuth clients remain independent namespaces. Cross-client lookup returns null and never reveals the other client's intent.

Opening retained history uses a bounded read-only view of the released journal schema to inspect prepared state and verify every operation has matching grant provenance. This adds no journal API or writer. Missing sidecar, journal, origin, generation, schema or ancestry is not reconstructed permissively. A surviving journal or product command receipt without this sidecar fences the account. A preexisting remote owner head without local generation also fences new operation initialization. Neither fresh OAuth consent nor a new device ID repairs lost history.

Inspection also matches each immutable `prepared` chain event to exactly one operation row and the row's frozen intent. A missing or changed row fences before recovery, pull, lookup or retry. This check runs on normal protected opens as well as the read-only restored-latch path, so a deleted operation row cannot turn its original operation ID into a new command.

Inspection also requires each row that has left `prepared` to have a later immutable `captured` event with the same result and captured tuple identities. Each captured tuple's stored wire record, identity, payload hash and digest must still agree. Acceptance events must follow capture, name pending captured tuple IDs once, and justify each stored disposition and remote stamp. The operation state and delivery label are then derived from the capture result and all tuple dispositions: rejected or no-op captures need no delivery, any unaccepted tuple keeps the operation pending, and only acceptance evidence for every tuple permits `backend_acknowledged` with the matching acknowledged or superseded label. A row without capture evidence must still be `prepared`, have no result or tuples, and remain unknown for delivery. Unsupported event kinds and promotions fence the account. The check runs before normal recovery and before a restored read pulls product changes, so a changed row cannot skip original tool-specific delivery authorization.

An origin row left by a crash before journal prepare is retained, counts toward admission and never changes its originating grant. There is no pruning/reset API. Current operation history and provenance are lifetime records under the v1 retention contract.

## Ordering and recovery

All read, operation and control methods use the same bounded M08 queue and process ownership. For a normal account turn:

1. Check active request authority and existing account/product bindings.
2. Open/verify the operation sidecar and journal under that owner, when applicable.
3. Check the independent restore latch and owner-scoped Snapback recovery head using the exact request session.
4. Recover prepared journal intent before product initialization, local fact processing, pulling or any new command. A surviving receipt is captured first; the core command is not executed again. Without a receipt, only the original active client/grant may execute the frozen command.
5. Publish required journal heads before execution, result delivery or any future delivery attempt. Then perform the bounded pull and read/operation work.

The actual Snapback SDK performs metadata queries and compare-and-swap mutations. HTTP guards permit only reads and the two recovery-head mutation routes; they cannot upload product records. Every metadata mutation requires a current full operation grant, trusted publication authorization and the restore latch. Lost replies and remote ancestry mismatches retain the existing adapter's fencing behavior.

Read authority, including a full upstream token with only read OAuth scopes, may compare a current head. It never initializes/advances metadata or runs/captures prepared work. A missing/unpublished head, prepared intent, unavailable head or damaged history refuses the turn before any pull or local fact recovery. A safe current read returns `deliveryPaused: true`; operation-capable infrastructure reports `writeFenced` according to current full operation authority. Read database capabilities remain read-only regardless of that status. Accounts without operation history retain M08's explicit `read_only_reconstruction` fence.

When the independently stored restore latch is marked, a trusted product read can continue under the same account lane. The actor opens the retained operation sidecar and journal with read-only SQLite handles, checks the released schemas, account identity, generation, grant provenance and absence of prepared intents, and compares the complete local chain with the owner-scoped remote head using the request's exact credential. It does not construct an `OperationJournal`, publish a head, execute or capture an intent, initialize operation provenance, or create a product account binding. An incomplete journal, missing provenance, stale local head or unavailable remote head still refuses the read. The returned recovery status is `writeFenced: true`, `deliveryPaused: true`, `recoveryReason: 'restore_latched'`; operation lookup also refuses until reconciliation. Protected writes and owner resume continue to require a ready restore latch. The read may run the normal bounded pull and return cached product data, but it does not clear the restore latch or claim delivery acknowledgement.

A marked `never` provenance state with no operation sidecar is eligible for this safe read path if the remote head is absent. A restore-latched account with `initialized` provenance and no journal still refuses before product pull, including when `journal_ready` is zero. The sidecar cannot be treated as a fresh account generation while the latch is marked.

An ordinary read with a ready restore latch has one narrower continuity case: a provider may revoke a grant before the first protected mutation, durably creating delivery history without an operation journal. Non-mutating validation requires `replica.sqlite` provenance `initialized`; an intact, secure `operations.sqlite` with the released v1 `runtime_meta`, `operation_grants` and `delivery_anchor` tables; exactly one runtime row bound to the request's account, backend and principal with a valid generation and `journal_ready=0`; zero operation origin rows; and exactly one delivery anchor with the same generation and `initialized=1`. `delivery.sqlite` must exist, be secure, and pass its released v1 schema, version, identity and account-pause validation; `owner_resumes` must be empty. `journal.sqlite` must be absent, product command receipts must be empty, and the exact request credential must read a null owner-scoped remote operation head. A read-derived, unattributed product outbox may remain queued, including through isolated restore; this path never uploads or clears it.

The product must also retain its Snapback `sync_account_bindings` row if its schema was initialized. A genuinely new product file can create its first binding only with no application schema, SQLite `user_version=0`, and no recorded healthy pull. A missing binding from an initialized or previously healthy product fences before pull rather than silently creating a replacement. Only after these checks can the actor perform a normal bounded pull and product read. It neither creates a journal nor initializes or executes an operation. Recovery reports `writeFenced: true`, `deliveryPaused: true`, `recoveryReason: 'delivery_only'`. A missing or unknown provenance marker, nonempty origins or receipts, `journal_ready=1` without its journal, incomplete delivery anchor, mismatched delivery schema or identity, or nonnull/unavailable remote head still fences before pull. A later authorized full writer uses the normal protected initialization and restore-latch checks; this read does not clear fences or grant delivery consent.

## M13 control and delivery boundary

`AccountControlRuntime` contains `{ accountId, directory, signal, assertActive }`. `withAccountControl` requires trusted `control` authorization and runs under the exact account lane. It deliberately exposes neither the product database nor a generic journal executor. It performs no core work and can coordinate revocation while ordinary recovery is fenced. Its callback is trusted service code, never client/model input. It must use the directory only for its durable service barriers; it must not replace history, clear restore fences or open an independent product writer.

M13 must persist and enforce grant revocation, mixed/unattributed outbox barriers and explicit queue-resume consent using this ordering seam. External provider revocation must be composed with the lane, rather than assumed serialized merely because `assertActive()` exists. There is no automatic prepared-intent execution under a reconnecting different grant in M12.

Delivery remains paused for every request. The core always pulls with `mode: 'pull_only'`; no `ensureZone`, product upload or outbox clearing is introduced. Read-generated facts and older unattributed queues stay intact. M13 must add bounded quiescent delivery with current explicit policy, await `journal.recordUploadAcceptance` from the real transport's `onUpload`, and enforce `journal.beforeDelivery` plus queue-clear hooks. Do not infer acknowledgement from counts, revisions or an empty queue. M12 does not claim a complete remote write flow.

## Bounds and verification

The M08 request deadline, process/queue/handle bounds, page budgets and disk checks apply. Recovery SDK fetches have the same configured fetch-count limit and request abort signal, including an explicit deadline race around the fetch promise. The default maximum is 10,000 retained origin/operation slots; orphaned origin rows consume slots too. New protected request JSON is limited to 131,072 bytes. Full journal verification remains proportional to bounded retained history. No archival, distributed owner, automatic restore clearing or delivery retry worker is added.

Each retained-history inspection pass reads the bounded grant origins and journal tuples once, then checks each immutable prepare, capture and acceptance event against those rows. Each operation still has the 4,096-tuple and 16 MiB captured-evidence bounds. A tuple must have capture evidence before any acceptance event, even though its row was loaded earlier. Journal ancestry, tuple payloads and dispositions, grant provenance, remote head, restore latch and current authority are checked on every turn. No actor-lifetime validation cache or schema migration was added; a changed sidecar is rejected by the next read before product pull.

The real Node SQLite, Snapback SDK and account-lane benchmark in `tests/history-performance.test.ts` seeds 9,800 synthetically rejected but internally consistent operations and 19,600 immutable chain events, with a matching synthetic backend head. Before batching, cold/repeat/restart read admission measured 757/715/716 ms, of which upstream fetches before pull used 126/133/130 ms; the remaining local admission work was 632/582/586 ms. After batching, the same three phases measured 447/379/381 ms, with 137/115/115 ms of upstream fetch time and 311/264/267 ms of local admission work. These are observed timings, not a latency guarantee. Full chain verification and head comparison still scan bounded history more than once, but repeat admission remains well under the 15-second default request deadline at the retained-operation limit. A future cache would need independent file-replacement and external-commit invalidation proof before it could replace these checks.

From the repository root:

```sh
bun build services/mcp/tests/operations-actor.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/operations-actor.test.mjs
bun build services/mcp/tests/accounts.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/m12-accounts.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test --test-concurrency=2 services/mcp/.artifacts/operations-actor.test.mjs services/mcp/.artifacts/m12-accounts.test.mjs
```

From `services/mcp`, run `bun run lint` and `bun run typecheck`.

The real Node 24.22.2 suite passes 8 M12 cases and all 19 accepted M08 cases together. It deploys an actual temporary Snapback server, uses real full/read sessions, production SQLite and the existing journal/head adapters. Synthetic owners are isolated and all temporary state is removed. Cases cover a post-core/pre-capture restart, actual SIGKILL at that boundary, generation/origin persistence, receipt capture before resumed pull-derived facts, read-grant refusal without credential upgrade, old-backup/advanced-head refusal, missing latch/history and unavailable head, client/grant lineage, shared command/read/control ordering and admission before opening a replica. Delivery remains pending in these proofs.

The initial red command built the same protected crash/restart test successfully, then failed with `crashed.runOperation is not a function`. The implemented path returns the durable original result with one effect after restart and actual process kill. Independent M04/M04R crash and restore matrices remain the foundation; M12 does not broaden their claims to Linux power loss, undisclosed coordinated rollback or complete delivery consent. No auth/core/journal/head/replica schema, public routing, packages, deployment or git index was changed by this increment.
