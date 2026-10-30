# Bounded operation journal and recovery proof

M04 supplies a real service SQLite journal and a bounded local crash proof. It is not authorization middleware, an account actor, an advertised mutation tool, or a successful M04R restore-completeness gate. M12 must integrate it with those boundaries. Mutation tools remain disabled until the parent recovery-head protocol and external restore latch pass their complete matrix.

## Ownership and ordering

`OperationJournal` opens a dedicated SQLite file using real Node 24.22.2. It refuses Bun's SQLite emulation, unknown schema markers, a product database, mismatched account/generation bindings and corrupt chain ancestry. Product schema 12 and its checksums remain unchanged. The journal uses foreign keys, WAL, `synchronous = FULL`, bound values and a 5000 ms busy timeout.

The caller must enforce one owner and one externally serialized account lane covering recovery, normalization, commands, sync, reconciliation and consistent reads. Run `recover()` before **all** account work, including reads and local fact recovery. Never run a later command or sync between prepared intent and receipt/tuple capture. The journal blocks a new operation, delivery and queue deletion while an uncaptured prepared intent exists; it cannot stop an independent caller from using the product database directly. Detectable interference, including a changed stamp or missing emitted row, fails closed. An unrelated later command can produce apparently valid extra outbox rows, so the lane contract is mandatory.

The configured `normalize(request, { commandId, nowUtcMs })` resolves board/quote/default inputs under that lane. It must return the complete core command, an explicit IANA zone and every derived default, including logical date, amount and occurrence instant when applicable. Create commands require a resolved logical date and `source: 'app'`. Reward normalization resolves the already approved quote; the journal does not implement or bypass browser confirmation. Undo normalization uses `undoTarget(clientId, originalOperationId)` to resolve only a real `created: true` result from the same client lineage.

`execute(frozenIntent)` is a configured, private adapter for the full `createCheckIn`, `undoCreatedCheckIn` or `claimReward` core command. Use its stored command input and inject its fixed clock and zone into command dependencies. This callback is not a public arbitrary-execution tool. Core owns its transaction. Do not wrap execution in an outer product transaction.

## Durable state

The journal binds uniqueness to its account plus stable OAuth `clientId` and operation UUID v4. Operation UUID casing is normalized. Its SHA-256 fingerprint covers account, client, tool and canonical original explicit arguments, before clock/default normalization. Keys sort recursively; non-JSON values are rejected. Changing tool, omitting/adding an explicit argument or changing an argument rejects reuse with `IDEMPOTENCY_CONFLICT`. Reordering object keys does not change intent. Raw confirmation tokens are not retained in the journal; their original-request fingerprint is retained.

Before execution, preparation durably stores that fingerprint, a new fixed core command UUID, acquired UTC millisecond clock, zone, normalized command and maximum current outbox ID. Prepared intent and its chain event commit in one journal transaction. After publication, recovery checks the core receipt first. If present, it captures the stored result without execution or new mutation authorization. If absent, it revalidates current execution authorization and resumes the same command UUID and frozen input. A missing receipt after execution remains `prepared` with `OPERATION_PENDING`, preserving uncertainty rather than storing a database failure as a terminal rejection.

The receipt and all new outbox IDs are read in one product read transaction. Each new row uses the existing schema-2 serializer, including dependent habit actions, coin settlement facts, reversals and tombstones. Missing rows, changed stamps and exceeded bounds refuse capture. Capture atomically persists the original receipt, full wire records, outbox IDs, full payload hashes, wire digests, state and a chain event in the journal. Capture must finish before the lane allows later work.

States are `prepared`, `rejected`, `completed_no_mutation`, `pending_sync` and `backend_acknowledged`. A rejected core receipt has no delivery requirement. A daily already-checked success is `completed_no_mutation`, `created: false`, no new tuples and no undo entitlement. Acknowledgment requires every captured tuple to have durable accepted or superseded evidence. Aggregate upload counts, empty queues and completed sync passes are never delivery evidence. Public handlers must map the internal receipt to M02's authorized, redacted, bounded result shape.

## Transport acceptance seam

The parent transport's awaited `onUpload` callback wires directly to the journal:

```ts
onUpload: async evidence => {
  await journal.recordUploadAcceptance(evidence);
}
```

`UploadAcceptance` is `{ record: WireSyncRecord, digest, disposition: 'accepted' | 'superseded', remoteMutationStamp }`. The callback must run after verified backend acceptance and before the engine clears the batch. Errors must propagate through the callback so the engine retains its outbox. A crash after backend acceptance but before evidence persistence retries the same record; a crash after evidence persistence but before clearing retains a durable acknowledgment and permits idempotent retry.

The journal retains a full `payloadHash = sha256(JSON.stringify(capturedWireRecord))` and the exact pinned transport `digest`. These differ for multipart records: transport partitions into 8192 Unicode scalar parts and folds `sha256(previousDigest + sha256(part))`. Inline records use their full payload hash. The payload hash prevents matching by entity/stamp/count alone; the wire digest validates the actual transport evidence, including large Unicode notes.

Accepted evidence requires the submitted stamp to equal the verified remote stamp. Superseded evidence requires a strictly greater remote stamp and a mutable entity. Immutable action/ledger facts cannot be marked superseded. A newer verified mutable delivery also marks older tracked versions of that entity as superseded, retaining their original payloads/results. This closes the case where the engine serializes the latest mutable row for several older outbox IDs. It does not claim the original visible effect was accepted or remains visible. Invalid/unknown dispositions, invalid digests and same-stamp payload mismatches throw instead of completing the acknowledgment callback. Valid unrelated background deliveries need no operation acknowledgment.

Under its grant/revocation barrier, the actor calls `beforeDelivery()` before uploading. This revalidates delivery permission for pending operations and publishes the current head. `beforeQueueClear(ids)` and `afterQueueClear()` expose queue-clear proof boundaries; the former refuses tracked tuples without evidence. The shared engine's awaited transport callback is the required persistence ordering even when the additional queue-clear hooks are not installed. The account actor must prevent any delivery path that bypasses the callback.

## Recovery-head integration

`publish(head)` and `authorize(intent, action)` are mandatory constructor callbacks, without permissive production defaults. Actions are `execute`, `read` and `deliver`. A completed replay rechecks result-read permission and does not require permission to cause a new effect. Receipt recovery can finish durable bookkeeping after execution permission is revoked. No result is released unless current read permission and head publication succeed.

`head()` returns `{ generation, sequence, headHash, previousHash }`. `entryAt(sequence)` returns that head plus its canonical event JSON, or null if absent. Sequence zero is the generation's genesis with two 64-zero hashes and an empty event. Every prepared intent, result capture and tuple-acceptance batch appends an event in the **same SQLite transaction** as the corresponding state/evidence update. Hashes are:

```ts
sha256(canonicalJson({ generation, sequence, previousHash, event }))
```

`event` in this expression is the stored canonical JSON string, not its parsed object. Prepared events contain frozen intent. Capture events bind the stored core result and each outbox ID/payload hash/wire digest. Acceptance events bind evidence and affected tuple dispositions. Ancestry is checked on open with bounded-memory iteration. Entries and operation evidence are never pruned.

Publication is awaited before admission, after durable preparation before core execution, after durable result capture before release, and after durable acceptance before the callback returns to the engine. Replays and recovery republish the current head so a lost publication response can be reconciled. The publisher must verify ancestry, publish every missing sequence through conditional advancement, and honor the external restore latch. Publication failure retains local intent/result/evidence and fails the current request; it must not be translated into a fresh validation rejection after commit.

The parent owns the real Snapback metadata CAS adapter, generation policy, stale-owner behavior, local/remote restore matrix, independent completeness evidence and latch outside the restored databases. This journal's tests deliberately use an explicit synthetic publisher. They do not establish that restoring one or both databases is safe, that matching heads prove complete history, or that a whole-VPS rollback can be detected without an independent anchor. Never enable writes merely because this local suite passes.

## Bounds and retention

Capture allows at most 4096 emitted tuples and 16 MiB of serialized wire payload per command, in addition to the existing per-record wire bound. Exceeding either leaves intent prepared for explicit recovery; nothing is truncated or silently dropped. Journal lifetime storage is append-only and grows with usage. The account owner must monitor private storage and apply account/request admission limits. File/directory access and owner locks belong to the account runtime.

Retain fingerprints, original results, captured wire records including tombstones, acceptance evidence and chain ancestry for the lifetime of the v1 replica. Session idling, reconnecting, delivering records and deleting outbox rows do not prune operation history. There is no archival/reset API. Unrecoverable journal loss requires write-fenced reconciliation, not a new empty writable journal.

## Reproduce the local proof

From the repository root, build with Bun and execute on the verified Node binary:

```sh
bun build services/mcp/tests/operations.test.ts --target=node --outfile=/tmp/m04-operations.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test /tmp/m04-operations.test.mjs
bunx --no-install eslint --no-ignore services/mcp/src/operations/journal.ts services/mcp/src/operations/records.ts services/mcp/tests/operations.test.ts
bunx --no-install tsc --ignoreConfig --noEmit --strict --skipLibCheck --target es2023 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node services/mcp/src/operations/journal.ts services/mcp/src/operations/records.ts services/mcp/tests/operations.test.ts
bun run typecheck
```

The focused suite passes 38 tests. Fixtures use real temporary SQLite product/journal files and real core commands, removing temporary files after each test. It proves count/claim one-effect recovery across prepare, commit and capture failures; atomic state/chain rollback; an actual SIGKILL after core commit without graceful SQLite close; HTTP-result-loss simulation by discarding the response then reopening both databases; partial acceptance/restart; acceptance-before-clear failpoints; authorization revalidation; canonical conflicts; durable no-op/rejection; original undo/reversal/tombstone retention; mutable supersession; immutable delivery requirements; multipart digests; ancestry corruption refusal; missing publication refusal; and a real SQLite receipt-insertion failure that rolls back core writes.

The first red run used the same real count/restart assertion against a direct execution scaffold without durable preparation. The build succeeded, and the Node test failed with `actual: 2`, `expected: 1` at the `check_ins` count assertion. After journal implementation, the same test returns one effect and the original result. A later red assertion rejected a same-stamp/different-payload supersession callback; it initially failed with `Missing expected rejection`. Payload identity is now checked before mutable supersession, and the assertion passes. Later claim fixture failures exposed an unsupported product symbol and were corrected to the supported `star.fill`; they were fixture errors, not claimed recovery failures.

Acceptance objects in the local journal tests are synthetic transport observations. The parent owns real Snapback transport/CAS integration evidence. No OAuth, public HTTP endpoint, browser reward confirmation, cross-process account ownership, restore-completeness gate, Linux runtime or production activation is claimed here.
