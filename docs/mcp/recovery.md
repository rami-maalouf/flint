# MCP recovery head and restore fence

M04R pairs the durable operation journal with owner-scoped Snapback recovery metadata. This is a bounded restore-fencing proof, not automatic recovery from arbitrary data loss. Product schema 12, native checksum gates and pinned Snapback 0.4.49 are unchanged. Recovery heads are service metadata, not phone sync records or a journal backup.

## Integration and ordering

`services/mcp/src/operations/recovery-head.ts` exports `RecoveryHeadAdapter`, `createSnapbackRecoveryRemote`, `FileRestoreLatch` and `RecoveryFenceError`. The adapter accepts the verified Snapback `owner`, an injected journal reader with `head()` and `entryAt(sequence)`, a remote port, a mandatory restore latch and an asynchronous `authorize()` callback. Bind the remote to the currently admitted connection's credential. The adapter never discovers another connection or upgrades a read session.

Open the product database and journal under the single account/process ownership lane. The journal verifies its cryptographic chain on open. Construct the adapter using that journal, and supply `head => adapter.publish(head)` as the journal's mandatory publisher. Await `journal.recover()` before admitting account commands, sync, queue deletion or local fact recovery. Recovery starts with publication/comparison, so it checks the latch even with no prepared operation. On reconnect, repeat the check. `adapter.compare()` is a non-mutating readiness check returning `current` or `unpublished`; `unpublished` does not authorize writes.

The publisher runs before admitting new intent, after durable preparation and before core execution, after durable receipt/tuple capture and before result release, before delivery, and after durable acceptance recording before queue deletion. A publication failure retains prepared intent or the captured result; it must not trigger a new command ID. Reuse the original operation ID after an uncertain response.

Every publication:

1. Checks the external latch, including when both heads match.
2. Reads the actual local head and every ancestry entry from genesis. Validates sequence continuity, generation, previous hashes and `sha256(canonicalJson({ generation, sequence, previousHash, event }))`. Genesis is sequence 0 with both hashes equal to 64 zeroes and an empty event. The supplied publication head must equal the journal's current head.
3. Reads owner-scoped remote metadata with a complete SDK query. Remote owner, generation, sequence, current hash and previous hash must match an exact surviving local entry. Ahead, forked, unknown, corrupt, missing or unavailable ancestry fences the call with `OPERATION_PENDING`. Missing remote metadata can initialize only an empty genesis journal, never a nonempty surviving journal.
4. Publishes missing known events individually using exact sequence/hash CAS. It awaits current authorization and rechecks the latch before each initialization or advancement. It never jumps directly to a tail hash.
5. Rechecks the latch before releasing the barrier. If CAS settlement is ambiguous, it reads again without repeating the CAS. Only the exact intended successor, including owner, generation and previous hash, establishes acceptance. An unchanged predecessor, different successor, unknown head or failed read remains fenced. Normal later retries must re-enter the complete comparison and authorization path.

`compare()` and a matching-head `publish()` need no write credential. A read session can query metadata; actual Snapback authorization refuses its mutations even if a faulty caller allows the local authorization callback. Grant revocation and the account delivery barrier still belong to the account actor. This adapter does not implement multi-process ownership or distributed leader election.

## Durable external restore latch

Provision `FileRestoreLatch` exactly once for a genuinely new installation using `provisionFresh({ path, installationId, restoredDirectories })`. The directories must include the service replica/journal restore root and the complete Snapback deployment restore root. The file's resolved parent must be outside every listed restore root. Provisioning uses exclusive creation, mode 0600, file fsync and parent-directory fsync. A preexisting latch is never overwritten. The installation ID comes from independently retained deployment control state, not either restored database.

The file is required at startup and every publication. Missing, malformed, truncated, symlinked, wrong-installation or appended state fails closed. `markRestored()` durably appends `restored <fresh UUID>\n` and fsyncs before database replacement. Each supported restore uses a new UUID, including a second restore while already write-fenced. A torn append also fences. New adapter instances and process restarts retain the fence. There is no clear, consent, resume or force API. Re-running provisioning against the file fails, including after restore.

The provider's mandatory authorization epoch uses the same external marker through `FileAuthorizationEpoch`. A bounded, service-owned, single-link private regular file supplies a SHA256 epoch. A ready marker permits normal authorization; a valid nonce-bearing restore marker permits only fresh read authorization. Restoring provider, vault or browser-session rows cannot restore their issuing epoch. Existing access tokens, refresh tokens, authorization codes, browser sessions and full-grant admission must match the current epoch. A normal grant cutoff does not change the epoch and does not invalidate independent connections.

Missing, unsafe, corrupt or legacy nonce-free restored markers supply only a new process-bound degraded read epoch. The source never provisions or repairs custody. Fresh verified read sign-in can work in that process; a subsequent process must sign in again. Legacy authorization rows have no automatically adopted epoch. The independent controller must retain a unique restore intent outside the restored roots and publish its nonce while admission is stopped, before replacing any authority store. This does not detect a privileged rollback of the external marker itself outside the mandatory controller.

The trustworthy recovery signal is the independent deployment controller's durable restore marker, written before changing either database, plus its retained installation binding. A valid fresh-install marker means that controller has not restored this installation. Database hashes, a person claiming that a backup is complete, ordinary OAuth consent and the journal itself cannot supply this signal. Treat missing or inaccessible control state as fenced. Filesystem permissions and the controller's exclusive lifecycle ownership are part of this trust boundary; this file cannot defend against a privileged actor replacing it with an old ready marker.

The supported restore procedure is:

1. Stop admission, uploads and the MCP process. Stop Snapback before copying its complete deployment directory. Preserve the original files and uncertainty for diagnosis.
2. Have the independently retained deployment controller append and fsync the latch before replacing the product database, journal, Snapback deployment or any coordinated combination. If marking fails, do not proceed with restoration or startup readiness.
3. Restore into isolated locations with correct permissions and the pinned runtime. Start the service with the same external installation binding and latch. Startup remains write-fenced even for two matching old heads. Pull-only authorized observations may be provided by the separately defined degraded read path; they must not deliver queued records, execute prepared intent or claim history completeness.
4. Retain the fence. V1 implements no automatic or manual runtime clearing. Future recovery requires independently verified complete operation history, such as an unrestored monotonic anchor accompanied by its complete journal, or reconstruction of every missing operation and result. That proof and its recovery tooling are not implemented here.

Restoring just the backend can roll back accepted product records and acknowledgements even when the entire newer journal survives. Its restore marker therefore prevents publication from treating that rollback as an ordinary unpublished tail. Restoring an old local journal against an advanced backend is independently detected by the remote head before same-ID retry. A complete known local tail from an interrupted publication can advance under the ordinary, unrestored installation signal; head ancestry alone cannot distinguish that case from an unreported backend restore.

## Coordinated and whole-VPS rollback limits

Two matching old snapshots are indistinguishable from an old healthy installation if the restore signal is also rolled back or bypassed. The automatic head comparison cannot detect that event. The tests demonstrate refusal with an independently retained latch, not independent detection of arbitrary coordinated rollback.

A file outside the two database directories but on the same VPS is not independent of a whole-VPS snapshot. Whole-VPS restore must be controlled from outside that snapshot and start with a durably marked latch before exposing mutation readiness. An off-host controller/anchor is not provisioned by these three files. If the external signal's integrity or the absence of coordinated rollback cannot be established, keep mutation tools disabled. Matching hashes never clear that requirement.

M24 still owns production restore scripts, separate key/provider backups, encrypted off-host storage, retention, key-loss rehearsal and deployment-controller integration. This adapter does not retrofit those guarantees onto the existing mobile backend backup script. Gate D must not be marked passed solely from matching heads, this runbook or a subset of the tests.

## Reproduce the synthetic proof

Run from the repository root. Bun only bundles; verified Node 24.22.2 executes actual `node:sqlite` and the installed Snapback SDK. No Bun SQLite, production credentials, private fixtures or live backend are used.

```sh
bun build services/mcp/tests/recovery-head.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/recovery-head.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/recovery-head.test.mjs
bunx --no-install eslint --no-config-lookup --ext .ts --parser @typescript-eslint/parser --plugin @typescript-eslint --rule '@typescript-eslint/no-unused-vars:error' --rule 'eqeqeq:error' services/mcp/src/operations/recovery-head.ts services/mcp/tests/recovery-head.test.ts
bunx --no-install tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module preserve --moduleResolution bundler --types node --allowImportingTsExtensions services/mcp/src/operations/recovery-head.ts services/mcp/tests/recovery-head.test.ts
bun run lint
bun run typecheck
```

The 19-case matrix passed on Node 24.22.2. The strengthened backend-only rollback and physical missing/corrupt ancestry cases also passed their targeted rerun. Focused checks above, root lint/typecheck, and the service's `bun run lint` / `bun run typecheck` passed. Commits, independent review and the final gate decision belong to the parent task.

Each test creates a small temporary deployment using the pinned `deploy` and `startServe` proof APIs. Backend rollback copies stopped complete deployment directories, including identity and metadata; it never edits backend SQLite tables. Product/journal snapshots are closed before directory copies. Cleanup closes SQLite, SDK clients and native servers and removes temporary directories in `finally`. The journal corruption test intentionally edits a synthetic local chain and verifies refusal on reopen.

The critical matrix includes successful count check-in and reward-claim delivery followed by older-local restore and same-ID refusal; exact receipt replay after lost result; lost genesis/CAS response reconciliation; matching old snapshots plus an external latch; backend-only rollback; publication/core/capture crashes; stale service owners and distinct account isolation; read-scope comparison and refused publication; actual SDK network unavailability; missing or wrong-installation signals; restore during publication; corrupt and missing ancestry; unchanged/forked ambiguous CAS replies; generation/metadata mismatch; sequential tail publication with authorization for every CAS; and refusal to put a latch inside either restored directory. The multi-event catch-up fixture intentionally withholds publication during setup to exercise the adapter algorithm; ordinary operation execution never uses that setup publisher.

The meaningful red baseline retained the pre-adapter no-op publisher/latch. After a successful actual backend upload and restoration of the older local SQLite directory, the stale-local test failed with `Missing expected rejection` at startup recovery:

```sh
bun build services/mcp/tests/recovery-head.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/recovery-head-red.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test --test-name-pattern='count: old local backup' services/mcp/.artifacts/recovery-head-red.test.mjs
```

The ignored red bundle preserves that baseline. Building that output again from the final source replaces it with the implemented adapter. This proof covers local process-restart/crash injection and stopped filesystem snapshots on Darwin ARM64. It does not establish power-loss behavior on Linux storage, a production recovery controller, off-host history completeness or safety after an unreported whole-VPS rollback.
