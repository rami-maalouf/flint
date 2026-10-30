# Habit System MCP implementation plan

Status: independently reviewed and ready for implementation. Implementation has not started.

Prepared 2026-10-30 against fullstack main `1985795`. This document and `mcp-todo.md` govern MCP work. Preserve the inherited product plan and the completed fullstack plan. Record implementation evidence in `../checkpoints.md` under M-prefixed entries.

## 1. Outcome and authority

Build a remote, account-scoped MCP service at `https://habits.ramimaalouf.com/mcp`. An assistant can inspect the user's habits, stacks, history, coins and rewards, create deliberate check-ins, undo a check-in created through this service, and claim a reward with the existing product confirmation rules. It works while the phone is closed because it runs on Oracle as another local-first client of Snapback.

The user requested a thorough plan followed by a new chat that implements it. They previously selected Snapback as the only active sync provider and this hostname. These are user decisions. App-specific tooling, the service layout, OAuth provider candidate, staged delivery and tool names below are engineering recommendations. They are defaults for implementation, subject to the explicit evidence gates below, rather than claims of already implemented capabilities.

Deliver one reviewed implementation branch and PR, reproducible synthetic verification, an operational runbook, and a staged remote deployment. Production activation follows successful synthetic staging, backup and review. Do not merge the PR automatically. Real account connection requires the user to sign in privately in a browser. Do not block local implementation waiting for that sign-in, and do not substitute a phone session, administrator identity or test identity for the real account.

### Scope

- First usable milestone: OAuth sign-in and consent, a genuinely read-only Snapback session, and habit reads through a real MCP client.
- Complete v1: bounded habit/history/stack/coin/reward reads, sync status, operation lookup, check-in creation, targeted undo, and confirmed reward claims.
- Later: habit/reward CRUD, arbitrary historical stack simulations, general uncheck/delete/edit, reminders, export, subscriptions/resources, stdio convenience launcher, and framework contribution. These are not required to finish v1.
- Never expose generic `uploadRecord`, SQL, arbitrary code, credential minting, backend selection, or development persona headers as public tools.

## 2. Ground truth and reuse boundaries

Snapback 4 is pinned to npm `0.4.49`; its deployed matching source is `2a58bf4b1c60efada322ec3fbc1530d6bd4d8e20`. Research inspected upstream main `68b3e2f82904a2868f15c0734e4bd108cc830ac7`, identifying itself as unpublished 0.4.50. That inspection found no working v4 MCP route or command. The older, separate Snapback engine has a remote MCP implementation. Its transport ideas are reference material, not a drop-in v4 feature. Recheck upstream once at M01 and record the revision; do not make an upgrade or framework fork a dependency without demonstrated need.

The backend stores serialized wire records. The app's TypeScript core owns the product semantics. A tool that inserts a check-in record directly would bypass action evidence, ledger settlement, command receipts and outbox invariants.

| Existing boundary | Reuse or constraint |
| --- | --- |
| `src/core/persistence/database.ts`, `schema.ts` | Database port and checksum-verified product migrations. Product schema is 12. |
| `src/core/domain/command-context.ts` | UUID command IDs, atomic product mutation/HLC/receipt, local receipt replay. Receipts do not sync and do not bind arguments. |
| `src/core/domain/check-in-commands.ts` | `createCheckIn`, `undoCreatedCheckIn`; do not use a toggle for retryable intent. |
| `src/core/domain/{queries,stack-queries,coin-queries,reward-queries,reward-commands}.ts` | Existing projections, balance calculation and reward workflows. |
| `src/core/sync/{engine,local-fact-recovery,records}.ts` | Wire validation, immutable fact admission, reconciliation, pagination and durable queues. |
| `src/platform/backend/transport.ts` | Injectable Snapback transport. Reuse generated operations and canonical payload/digest handling. |
| `src/platform/backend/{index,session}.ts` | Mobile runtime reference only. Do not import Expo SecureStore or mobile session management into the server. |
| `tests/backend/domain-convergence.test.js` | Real temporary Snapback and multiple SQLite clients as an integration-test precedent. |
| `SPEC-habit-system.md:201`, `:233` | Append-only balance, accepted offline overspend, confirmation snapshot and expected reward stamp. |
| `ops/README.md` | Verified Oracle topology, pinned binary, resource bounds and complete-deployment backup procedure. |

The recent phone migration is complete as recorded in checkpoints F6. Its ignored exports, backups and sessions are private and are not fixtures or prerequisites. Do not reopen iCloud migration during MCP work.

## 3. Architecture and invariants

```text
MCP client -- OAuth bearer --> HTTPS /mcp
                                  |
                     protocol + scope enforcement
                                  |
                     account actor / operation journal
                                  |
                     shared TypeScript domain core
                                  |
                      durable account SQLite replica
                                  |
                      validated Snapback transport
                                  |
                        existing Snapback deployment

Browser --> sign-in / consent / connections / reward confirmation
                   |
          maintained OAuth provider + encrypted per-grant session custody
```

Use a separate service in this repository. Do not embed a network listener in the phone app or depend on iOS background execution. Keep protocol, authorization, account runtime and tool contracts separate. Domain handlers receive authenticated context, database, immutable request clock and operation services; they do not inspect HTTP cookies or decrypt tokens.

Required invariants:

1. Every request is mapped to the exact authenticated Snapback `(canonical backend URL, principal)`. Neither email, client input nor a path supplies ownership.
2. One durable replica per account and backend, with one process owner and one serialized lane for recovery, sync, commands and consistent reads. OAuth clients share that account replica, not a process-global current user.
3. Product writes use the existing core. Domain data, facts, HLC and command receipt retain their existing transaction semantics. The phone remains local-first.
4. MCP operation intent survives HTTP loss, cancellation, service restart and token refresh. No successful commit is reported as if nothing happened because a later upload failed.
5. An MCP read grant cannot make a backend mutation. A full Snapback credential is acquired only for explicitly consented write authority.
6. Grant expiry/revocation is checked at admission and immediately before the domain commit. Serialize revocation with that commit so its ordering is defined.
7. A committed operation is an accepted durable intent, but client revocation revokes its delivery credential too. Revocation pauses account uploads when any outbox work remains, including mixed-grant and derived work. Another grant cannot silently drain it. The owner must explicitly authorize resuming that existing queue with an active write grant. Do not remove committed facts or recreate an intent with a new ID.
8. A backend acknowledgement is not proof that every device applied the operation. A completed pull cannot see changes still offline on another device.
9. No local replica loss is repaired by silently creating a new writable replica without its operation journal. Restore or explicitly reconcile uncertain operations first.
10. All human content is returned as untrusted data. No model calls, command execution or instructions are derived from habit titles or notes.

### Suggested package layout

```text
services/mcp/
  package.json, bun.lock, tsconfig.json, eslint.config.*
  src/{server,config,protocol,auth,accounts,storage,operations,tools,web}/
  tests/{unit,integration,protocol,fixtures}/
  README.md
ops/mcp/
  systemd units, routing fragment, backup/deploy scripts, runbook
docs/mcp/
  contracts.md, authorization.md, recovery.md, compatibility.md
```

Use a separate service installation boundary with its own authoritative lockfile. Root is currently not a Bun workspace. Avoid pulling OAuth/MCP server dependencies into Expo's mobile graph or disturbing the root AJV 6 requirement. Explicitly exclude server sources from mobile typechecking and server Bun tests from Jest discovery; give the service its own lint, typecheck, coverage and build commands. Keep shared core imports covered by the existing 100 percent core gate. Do not lower coverage to accommodate the new boundary.

Default runtime candidate: pinned Bun, using a production `SqlDatabase` adapter over `bun:sqlite`. The API is synchronous while core transaction callbacks are asynchronous: do not use a synchronous transaction helper around an unawaited callback. The adapter needs serialized async transaction ownership, explicit begin/commit/rollback, foreign keys, bound parameters and deliberate durability settings. Prove it with unchanged core and rollback tests before implementing tools.

Current candidates observed on 2026-10-30: official `@modelcontextprotocol/server` 2.4.0, `@better-auth/mcp` and `@better-auth/cimd` 1.7.14. These are research inputs, not an untested lockfile specification. Pin a coherent tested set in M01; do not mix old `@modelcontextprotocol/sdk` 1.x examples with v2 imports. Install and run scripts with Bun even if the chosen server runtime changes.

Better Auth documents a Node-specific SSRF-safe CIMD transport and requires other runtimes to supply an equivalent. Do not substitute ordinary `fetch` on Bun. First prove a maintained supported transport on the selected runtime. If that proof fails, move the service to a supported Node runtime and a production `node:sqlite` port, retest core compatibility, and record that bounded architecture change. Do not write a DNS/redirect security layer merely to keep Bun as the runtime.

## 4. Authorization and credential lifecycle

### Concrete starting direction

Use the official MCP SDK v2 as resource server and evaluate Better Auth's MCP/CIMD provider as authorization server. The essential unproven seam is establishing its browser subject from a successful Snapback login through a supported extension point. M01 must prove that seam without modifying OAuth protocol internals or creating a second password authority. If it cannot, evaluate maintained `node-oidc-provider` custom interactions and a durable adapter against the same tests. Record its CIMD/client limitations. Do not implement a custom OAuth authorization server as a shortcut.

Use the current MCP authorization profile, PKCE S256, resource-bound tokens and discovery. Prefer CIMD; explicitly configure DCR for tested older clients. Publish one canonical resource URI, issuer and metadata set. Let the selected provider and SDK implement protocol details and compatibility negotiation. Restrict registration/fetch abuse and validate redirects. The authoritative references are in section 11.

Browser flow:

1. Client discovers the protected resource and authorization server. The sign-in page identifies Habit System and the requesting client.
2. User signs into their existing Snapback account over HTTPS. Password is transient request input only. Do not persist it, put it in URLs, logs or analytics, or ask for it in chat. Defer signup in v1 to avoid accidentally creating an empty account instead of connecting existing habits.
3. Verify the returned session through an authenticated backend operation. Bind the internal subject to backend URL and immutable principal, with safe account-switch handling and session fixation/CSRF protection.
4. Show per-client consent. Issue separate MCP credentials mapped to that grant; never pass the Snapback bearer to the MCP client or accept it as an MCP access token.
5. Store only the independent server-held Snapback session encrypted with authenticated encryption, binding ciphertext to account and grant. Signing/encryption keys live outside the database and repository, through private systemd credentials. Provider sessions, tokens and consent state are durable.
6. Provide a browser connections page showing grants, permissions, last use and reconnect status. Revocation invalidates MCP access/refresh authority promptly and attempts upstream logout for the independent session. It must leave the phone and other grants intact. Record best-effort logout uncertainty honestly.

Proposed scopes:

| Scope | Authority |
| --- | --- |
| `habits:read` | Habits, stacks, today, check-in history and sync status. Notes omitted unless separately authorized. |
| `habits:notes:read` | Opt-in check-in note content. Does not imply write access. |
| `coins:read` | Calculated totals, ledger history, rewards and claim preview. |
| `checkins:write` | Create check-ins and undo this service's own check-ins. |
| `rewards:claim` | Confirm and execute reward claims. Requires coin read for the preview flow. |

Tool listing may reflect scopes for usability; invocation must enforce them independently. Operation lookup additionally checks its owning client/grant lineage and required scopes. Token refresh is not a new operation namespace. A new grant must not automatically inherit another client's operation results.

Read-only grants log into Snapback with read scope and retain no full session. Installed 0.4.49 read sessions cannot refresh; seven-day ordinary password-session lifetime is documented. Expiry requires interactive reconnect even if an MCP refresh token remains. Return reconnect-required, revoke usable data authority and present a safe reauthorization route. Do not promise unattended indefinite access.

Write grants can hold an independent full session. For v1, expiry can also require reconnect. Automatic Snapback rotation is optional and must not be enabled until serialized durable rotation, concurrent refresh and consumed-token/lost-response failures pass. The current mobile app deliberately avoids SDK-owned automatic rotation. On ambiguous rotation, fail closed and reconnect; never store passwords for automatic login.

Reconnecting the same account can resume its replica. Reconnecting a different account creates a separate mapping and replica; it cannot retarget existing operation IDs or confirmations. Keep authentication failures distinct from a healthy but empty account.

## 5. Replica, sync and freshness contract

### Bootstrap and lifecycle

Use an opaque account directory identifier, never an email or raw client path. Store a durable device ID, product database, service journal, local service schema/checksums and synchronization binding. Product migration checksums must match; refuse an unknown schema instead of deleting or resetting the database. Service-only tables belong to the server replica and must not change mobile schema 12 by accident.

The first account bootstrap downloads existing Snapback records through the existing validation/admission path, checks bindings, and publishes the replica only after a bounded consistent read is available. Gate writes on completed recovery and healthy admission. Handle expired credentials, empty accounts, malformed facts and partial bootstrap explicitly.

Core `runSync` uploads before fetching and inbound reconciliation may generate more outbox work. Two consequences need early proofs:

- A read-scoped credential cannot run an unrestricted bidirectional sync pass. Add or extract a narrow pull-only mode in the existing engine with default behavior unchanged for mobile. It must retain locally generated reconciliation facts without uploading them. Do not bypass validation with a second raw-record importer. A read-only connection may have queued derived facts; distinguish that expected state from a failed download or quarantined input.
- For a write-capable account, synchronize to bounded quiescence: recover, upload/fetch, inspect queues and admission, and repeat if incoming settlement generated new work. Bound time/pages/passes and return a precise incomplete status when it cannot settle. One `up_to_date` result is insufficient evidence of an empty outbox.

Only a currently authorized write connection may supply a full credential for account delivery. Normal write consent explicitly covers delivery of the account's accepted operations from active grants and their reconciliation effects. Associate accepted operations, outbox evidence and delivery attempts with their authorizing grant; derived work records its cause where known and is otherwise marked unattributed. No read request may silently upgrade to a full credential merely because one exists for another connection.

Revocation policy is deliberately conservative because the core has one shared outbox. Serialize revocation with the account lane, persist a delivery barrier, revoke the OAuth grant, destroy/logout its upstream session, and check the barrier before each outbound record, not just at batch start. A request already accepted upstream may finish; capture that uncertainty and its eventual evidence without issuing another command. If anything remains queued, pause all account uploads and new mutations, while permitting authorized pull-only reads and status. This prevents a second grant from accidentally carrying revoked or unattributed work. The authenticated owner's connections page must show the pending intent summary and offer explicit POST consent to resume the existing queue under a chosen active write grant. Re-consent covers the mixed queue and derived facts; it never changes original command IDs, fingerprints or ledger entries. Account disconnect also pauses all delivery. Resume requires the same verified account, and tests must cover revocation before commit, after commit, during upload, two grants and read-generated settlement. Do not add a separate broadly privileged background credential to avoid this policy.

Serialize the account lane across every in-process session. Hold a process/file ownership lock so a second service process cannot open the same replica as an independent writer. Deployment runs one process; horizontal scaling is explicitly unsupported until durable distributed fencing is designed. Idle eviction closes handles, never deletes pending operations or replica files. Bound concurrently open replicas, queue length, query work and per-account disk usage.

### Reads

Inputs accept an IANA `timeZone` when a date-sensitive projection is needed, plus `freshness: "require_sync" | "allow_cached"`, default `require_sync`. Never infer the user's zone from Oracle. Validate it and inject an immutable clock per request; two requests cannot mutate a shared clock.

Return a common metadata envelope with `observedAtUtc`, `lastCompletedPullAtUtc`, known backend revision if available, `syncStatus`, pending local deliveries, admission counts, and whether cached data was used. Label server observation rather than global freshness. Required sync failing before a read returns a retryable unavailable/reconnect/sync-attention error; cached mode is explicit and labels stale data. A read-only pull's expected derived outbox does not by itself deny a fresh server observation. Partial or quarantined facts must not be presented as a complete clean account snapshot.

Today uses each board's start-of-day; stack snapshots use the root's start-of-day. Reward claims use midnight in the chosen zone. Current stack APIs do not support arbitrary historical as-of snapshots. A note, title or timezone is never accepted as a filesystem path or backend URL.

### Delivery evidence

Instrument successful transport uploads to persist per-operation evidence before the engine deletes acknowledged rows. Do not infer acknowledgement from aggregate upload counts, a profile revision, an empty queue, or one completed pass. Include settlement work necessary to represent the operation, not only the visible check-in row.

At M04/M12 prove the exact association between a command receipt and its emitted outbox tuples. A viable design is durable prepared intent plus an outbox baseline under the single account lane; capture its resulting tuples before any sync or later command and persist receipt linkage. Recovery must run before all other account work. If this cannot close every crash window without changing core, add a narrowly scoped command envelope hook with tests rather than guessing ownership. Do not nest an outer transaction around `runCommand`.

The transport must distinguish accepted delivery from a mutable upload being superseded by a newer remote version. If actual effect cannot be established, report delivered/superseded or pending-unknown accurately. Do not promise that an acknowledged check-in remains visible forever after another device edits or removes it.

## 6. Public tool contract

Use stable snake_case names, explicit descriptions, runtime input/output schemas, bounded payloads, structured results and a concise human-readable summary. Validate unknown fields, UUIDs, finite numeric ranges, dates and scope before opening account work. Tool annotations are client hints, not authorization or idempotency enforcement. Reads are read-only; claims and undo have appropriate destructive annotations. Do not label a count check-in inherently idempotent when its operation ID is omitted.

The proposed contracts are finalized in M02, using branded core IDs internally. All listing limits are at most 100 and responses have an overall byte budget; exceeding it returns a continuation or clear bounded-result error rather than truncating JSON. Cursors are opaque, authenticated and bound to account, tool, filters and ordering. No title lookup silently chooses one of two matching habits.

| Tool | Important inputs | Output / implementation boundary |
| --- | --- | --- |
| `list_habits` | lifecycle filter, bounded page | IDs, titles, kind, relevant tracking/start-of-day fields; `listActiveBoards`/`listArchivedBoards`. |
| `get_habit` | `habitId` | One habit; distinguish not found, archived and access failure. |
| `get_today` | `timeZone` | Current home projection and explicit per-board logical dates. |
| `list_stacks` | `timeZone`, bounded page | Current stack summaries via `getStackListSnapshot`. |
| `get_stack` | root habit ID, `timeZone` | Detail snapshot via `getStackDetailSnapshot`; bound heatmap output. |
| `get_checkin_history` | habit ID, bounded page, optional date range | Canonical IDs/date/amount/time; notes only with notes scope. |
| `get_coin_balance` | freshness | Earned, spent and balance from ledger; permit negative balance. |
| `get_coin_history` | limit, opaque cursor | `getCoinHistoryPage`; stable date/createdAt/ID ordering. |
| `list_rewards` | archive filter, bounded page | Reward ID/title/cost/version and current lifecycle. |
| `get_reward_claim_preview` | reward ID, `timeZone`, intended operation UUID | Cost, observed balance/after, expected stamp, expiry and confirmation URL/token. |
| `get_sync_status` | no owner input | Observation/admission/delivery state without credential or internal path disclosure. |
| `get_operation` | operation UUID | Authorized durable result, commit/delivery states and original entity IDs. |
| `create_checkin` | operation UUID, habit ID, `timeZone`, optional logical date/instant/amount/note | `createCheckIn`, resulting ID/date, `created` and delivery state. |
| `undo_checkin` | new operation UUID, original create operation UUID | Target only an actual `created:true` result, resolving original core command and check-in internally. |
| `claim_reward` | operation UUID, approved confirmation token | `claimReward` with confirmed reward stamp; ledger ID/title/cost/date/transaction balance and delivery state. |

Existing grouped check-in history is a prefix API that preserves entire days, not cursor pagination. Do not wrap it in a misleading offset cursor. M10 introduces a bounded deterministic query using the established repository patterns, or explicitly documents a bounded first-page contract until cursor support exists. Full v1 should include usable continuation for larger histories. Test rows inserted/deleted between pages and define snapshot/restart behavior rather than claiming stable snapshots across independent reads.

### Check-in semantics

- `create_checkin` expresses add/check, never toggle. Daily already-checked returns `created:false`, with no new check or undo entitlement.
- Reject future dates, invalid amount combinations, an instant on a daily habit, and inconsistent explicit date/instant pairs. Distinguish current timezone from an originally recorded occurrence offset. Match board boundaries around DST.
- The source enum has no `mcp`. Use existing `source: "app"` for v1 as an app-owned client; store MCP provenance in the service audit/journal. This avoids a schema/Swift/wire migration. If explicit product-level MCP provenance becomes required, design that migration separately.
- Undo is not general deletion or reversal of every concurrent daily check. Only its original created row is targeted, with existing core ownership validation. A remote edit/removal may change the result; return the domain outcome and later reconciliation honestly.

### Reward confirmation and concurrency

The approved product spec explicitly accepts double offline claims and a negative converged balance. Preserve that rule; do not add global reservations, discard claims, or claim service-side serialization solves all-device overspending.

Before a claim, obtain a preview with reward stamp, cost, balance and balance-after. Provide a browser confirmation route using the signed-in account and CSRF-protected POST, bound to the OAuth client, exact operation UUID, reward/stamp/cost, zone and expiry. GET only displays the quote. Approval is single-use for that operation but retries of the same admitted operation remain safe. A bare model-supplied `confirmed: true` is not evidence that the product confirmation occurred. Use URL elicitation only where client support is verified; ordinary browser completion is the compatibility fallback.

The confirmation screen states cost and the quoted balance-after, and explains that other device activity may change the final balance. Recheck the reward stamp and sufficient local balance inside the core transaction after fresh synchronization. A changed reward needs a new preview/approval; ordinary balance movement is allowed if still affordable, as specified. A completed claim receipt replays after reward edit/deletion. No global nonnegative-balance promise is made.

## 7. Durable operations and failure semantics

Require a client-generated UUID v4 operation ID on every mutation. Persist uniqueness by account plus stable OAuth client identity plus operation ID, preserving grant lineage across legitimate reconnects. Input fingerprint includes tool name, canonical explicitly supplied fields and identity context. Persist derived command UUID, acquired time, zone, resolved logical date, normalized domain inputs and result before allowing other account work. Derive defaults only on first admission so a midnight retry cannot change intent. Fingerprint comparison uses the original request, not a newly evaluated default clock.

Core receipts alone are insufficient: they are local, keyed only by command ID and excluded from sync. The journal must reject a repeated operation ID with different arguments or a different tool before replaying the core command. A client receiving no response must reuse its operation ID or call `get_operation`; it must not automatically generate a new ID.

Suggested durable state machine:

```text
prepared -> rejected
prepared -> local_committed -> pending_sync -> backend_acknowledged
                          \-> sync_attention / reconnect_required
prepared -> completed_no_mutation
```

An interrupted prepared operation is reconciled against the core receipt before any new command or sync. If the core receipt exists, recover that result and its outbox evidence, never rerun with a new command ID. If it does not exist, resume the same prepared command only after authorization is revalidated. A replay of a completed operation is still subject to current result-read permission; it does not authorize a new effect.

Persist delivery acknowledgements durably. Crash after backend acceptance but before local acknowledgement causes safe record retry; crash after core commit but before journal result requires receipt recovery. Cancellation after commit stops waiting, not the committed operation. Never return a generic validation failure after a commit merely because the response deadline expired.

### Restore completeness fence

A valid SQLite backup can still be too old for command idempotency. Example: backup, successful count check-in, restore backup, retry the same operation ID. The restored journal has no receipt, although the backend already has the effect. Merely downloading that effect does not reconstruct every command result. V1 must detect this condition and refuse mutations rather than replay it as a new intent.

Default design to prove in M04R: an account-scoped, monotonic recovery head in Snapback, separate from product wire records, paired with a hash-chained local journal. Publish durable journal advancement before executing admitted intent and before releasing its result or delivering its records. The server enforces conditional advancement so the head cannot be silently reset or forked. On startup, reconnect and restore, compare the remote head with the local chain before enabling writes. A remote head absent from the surviving local chain, a fork, an unavailable comparison or an unknown generation means write-fenced recovery. A local unpublished tail may resume only when its durable receipts/evidence and ancestry prove it safe; never blindly overwrite the remote head.

This likely needs a small owner-scoped Snapback metadata table and operations. It does not add product entities, sync command receipts to phones, upgrade Snapback itself, or change mobile schema 12. Test compatibility with the existing phone client before backend deployment. The exact CAS/hash-chain protocol and crash ordering are a proof obligation, not asserted correctness: test every transition, including lost publication responses, independent restoration of either database, a backup taken before an acknowledged operation, and two stale service owners. If the proof fails, mutation tools stay disabled; read-only degraded recovery remains available.

Matching heads are necessary, not sufficient: restoring both databases to matching older snapshots can erase an acknowledged operation from both. V1's supported recovery procedure therefore starts every restored deployment with mutations disabled, including a matching pair. The restore tool and startup readiness must enforce a recovery latch outside the restored database pair; normal consent, matching hashes or a `--force` flag cannot clear it. If coordinated rollback cannot be ruled out, writes remain fenced. Clearing the latch needs independently retained evidence of the latest operation history, such as an unrestored monotonic anchor with an associated complete journal, or independently verified reconstruction of all missing operations. A stale backup, claimed complete backup or two matching heads is not that evidence. A whole-VPS rollback also requires this recovery procedure; an anchor included in that same rollback provides no independent proof. M04R must specify the trustworthy recovery signal and demonstrate refusal when it is missing. If unattended write recovery is desired later, an independently retained monotonic anchor must be designed and provisioned; do not imply the two-database head supplies that guarantee.

Restoration never automatically enables writes. Recovery needs independently verified complete journal history or reconstruction of missing operations; a human clicking 'resume' or choosing a new device ID is insufficient. Remote fencing metadata detects some missing-history cases but is not itself a full journal backup or a coordinated-rollback detector. If completeness cannot be established, report the mutation service as blocked for reconciliation and permit only the documented read-only degraded mode. Preserve operation IDs and uncertainty instead of promising seamless recovery from arbitrary data loss.

Suggested error codes: `INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, `RECONNECT_REQUIRED`, `SYNC_ATTENTION`, `UNAVAILABLE`, `RATE_LIMITED`, `OPERATION_PENDING`. Map domain failures without leaking SQL, stack traces, token material or other accounts. Authentication uses HTTP/SDK authorization semantics; ordinary tool errors use the MCP tool-result contract rather than pretending to be protocol parse failures.

Journal and receipt retention is part of the API. Keep mutation tombstones/fingerprints for the lifetime of the v1 account replica; do not prune them with idle sessions. Publish limits and an explicit future archival policy before any retention change. Duplicate prevention is not guaranteed after unrecoverable replica/journal loss. On such loss, fail closed for mutations and reconcile from backups instead of resetting IDs. Read-only reconstruction is allowed only with an explicit degraded-state marker.

## 8. Ordered implementation tasks

Every task starts with a meaningful failing test/proof, finishes its focused tests, updates its todo/checkpoint and receives a lowercase conventional commit. File scopes are estimates; split a task before it grows materially beyond five implementation/test files. Generated files are regenerated through their tools. Proposed commands below do not exist until M05 creates the service scripts. Shared ownership changes stay sequential; independent review uses a fresh non-author agent.

### Feasibility and contracts

**M01 - Prove authorization/runtime compatibility.** Dependencies: none. Scope M, up to five spike/report files. Files: `services/mcp/proofs/auth.*`, proof test, dependency lock, `docs/mcp/authorization.md`. With synthetic accounts, prove supported Snapback-to-provider identity, SDK discovery/PKCE/resource validation, read-session refusal of writes, supported SSRF-safe CIMD transport, DCR and provider persistence. Pin versions and test intended client profiles. If the preferred provider/runtime fails, exercise the bounded alternatives in section 4 and record limitations. Verification: reproducible proof command, synthetic two-account isolation, no custom OAuth internals. Gate A: select the demonstrated provider/runtime before production auth code.

**M02 - Freeze tool/security contracts.** Dependencies: M01. Scope S/M, `docs/mcp/contracts.md`, `authorization.md`, schema fixtures and contract tests. Finalize scopes, tool inputs/results, error/status envelopes, operation namespace, notes policy, quote confirmation and compatibility targets. Verification: schema examples validate; every proposed tool has a scope, bounded result and date/idempotency policy. No owner/backend URL input.

**M03 - Prove server SQLite and read-only bootstrap.** Dependencies: M01. Scope M, adapter, adapter tests, pull-only core change/test if needed, proof report. Run unchanged migrations/core commands against production adapter; prove awaited rollback, transaction isolation, persistent device/HLC and read-scoped initial download including generated settlement. Mobile default sync behavior stays identical. Verification: real temporary Snapback plus restart; read-mode transport has zero mutation calls. Gate B: read-only service does not depend on full credentials.

**M04 - Prove operation recovery and acknowledgement.** Dependencies: M02/M03. Scope M, operation proof, crash tests, minimal receipt/outbox instrumentation if required, recovery decision record. Prove prepared-to-receipt linkage, exact emitted tuple association, partial-upload replay and superseded-row semantics. Use failpoints before/after every persistence boundary. Verification: one count effect after lost response/restart and no false backend acknowledgement. Gate C: do not enable mutation tools until the crash matrix passes.

**M04R - Prove restore-completeness fencing.** Dependencies: M04. Scope M, owner-scoped Snapback recovery metadata/schema tests, journal-head adapter/test and recovery protocol record; split implementation from proof if over five files. Demonstrate the section 7 protocol before choosing a production journal design. Verification: backup before successful count/claim, advanced backend, restore and same-ID retry must refuse a new effect; stale owner, lost head response and local/remote restore permutations remain fenced. Restore both databases to matching snapshots from before the success: a same-ID retry must still be refused without independent completeness proof. Specify the recovery latch, trusted signal and whole-VPS restoration limits. Gate D: mutation tools remain disabled without a demonstrated fence; no automatic write recovery from matching snapshots. All later backend releases include metadata in backup/compatibility testing.

### First usable read-only slice

**M05 - Establish service build boundary.** Dependencies: M01/M03. Scope M, service package/lock/tsconfig/lint plus root exclusion changes; split config changes if necessary. Add deterministic install/build/lint/typecheck/test scripts and dependency-boundary test. Bundle shared core and injectable transport without Expo/React imports; reproduce on Linux ARM64. Verification: frozen install in a clean worktree, service build and root lint/typecheck, generated API reproducible from pinned schema. Preserve SDK patch and AJV behavior.

**M06 - Persist browser identity and encrypted custody.** Dependencies: M02/M05. Scope M, identity adapter, credential vault, storage migration, focused tests. Implement the demonstrated identity bridge and independent read-scoped Snapback session. Store verified principal binding and encrypted credential only. Verification: account switch, wrong password, fixation, ciphertext/AAD tamper, restart and no password/token logs.

**M07 - Complete OAuth discovery and consent.** Dependencies: M06. Scope M, provider config, route mount, consent page, protocol tests. Implement supported discovery paths, resource/audience checks, per-client scopes, PKCE, CIMD/DCR controls and durable provider state. Verification: real SDK client end-to-end authorization, denied consent, replayed code, wrong resource, expired token, invalid redirect and private-address metadata fetch rejection. Stable keys survive restart.

**M08 - Open account replicas safely.** Dependencies: M03/M06. Scope M, account actor, replica lifecycle, pull coordinator, isolation tests. Persistent per-account binding, single-owner lock, bounded queues/handles, recovery before serving and no credential upgrades during reads. Verification: two accounts/two clients, simultaneous opens, duplicate process, failed bootstrap and unknown schema all behave safely.

**M09 - Deliver habits through MCP.** Dependencies: M07/M08. Scope M, server registration, habit handlers/schemas and protocol integration tests. Implement list/get/today and sync status. Verification: connect, sign in, list synthetic habits through actual HTTP MCP; missing scope and notes leakage denied; cached/required-sync outcomes differ correctly. Checkpoint R: a working read-only vertical slice is demonstrable before adding writes.

**M10 - Deliver bounded history and stacks.** Dependencies: M09. Scope M, history query/test, history tools/test, stack tools/test; split if over five files. Implement usable bounded history continuation, current stack list/detail and explicit zone behavior. Verification: >100 records, whole-day boundaries, repeated/switching cursors, concurrent changes, DST and root start-of-day; response byte budget enforced.

**M11 - Deliver coin and reward reads.** Dependencies: M09. Scope M, coin/reward handlers, schemas and tests. Ledger totals/history and rewards list, without executable claim yet. Verification: negative balance, deleted reward title snapshots, archived filtering, cursor tampering and scope isolation. Checkpoint S: all read tools pass real Snapback/HTTP MCP integration with read-only upstream credentials.

### Durable writes

**M12 - Build operation journal and recovery.** Dependencies: M04/M04R/M08. Scope M, journal migration, operation repository, recovery worker and failpoint tests. Implement tested state machine, stable namespace/fingerprint/default freezing, receipt linkage, recovery head and delivery evidence. Verification: M04/M04R crash/restore matrices as automated integration tests; retention and write-fenced recovery covered. No mutation tool is yet advertised.

**M13 - Add scoped write connections.** Dependencies: M07/M12. Scope M, write-consent/custody extension, revocation coordinator and lifecycle tests. Acquire independent full session only with write consent; serialize revoke/commit, implement the account delivery barrier and explicit owner re-consent for mixed pending queues. Verification: read credentials never write; revoking one connection leaves other sessions valid but cannot drain revoked work through them; before/after-commit and mid-upload revocation, derived facts and same-owner explicit resume are tested.

**M14 - Deliver check-in creation.** Dependencies: M09/M12/M13. Scope M, check-in tool/schema, handler tests and protocol integration test. Call `createCheckIn` with frozen zone/date/instant, stable core command and existing source `app`. Verification: count/daily/amount/time habits, duplicate daily no-op, same-key retry/conflicting payload, future/DST inputs and native-like second replica convergence.

**M15 - Deliver targeted undo.** Dependencies: M14. Scope M, undo handler and tests. Resolve original authorized create operation, require `created:true`, use `undoCreatedCheckIn`. Verification: same-key replay, no-op create, wrong client/account, already removed, remote edit and concurrent independent daily check; no general delete capability appears.

**M16 - Expose durable operation lookup.** Dependencies: M12/M14/M15. Scope S/M, lookup handler, result redaction and tests. Return accurate local/no-op/rejected/pending/acknowledged/superseded states after restart and HTTP loss. Verification: grant lineage, changed scopes, token refresh/reconnect and unauthorized operation enumeration. Checkpoint W: check-in/undo survive every recorded crash window with one durable intent.

**M17 - Create reward quotes.** Dependencies: M11/M12/M13. Scope M, quote store, preview tool, tests. Bind quote to account/client/operation/reward stamp/cost/zone/expiry. Preview never spends or reserves coins. Verification: changed reward, insufficient funds, expired quote, account/client swaps and quote replay.

**M18 - Render reward confirmation.** Dependencies: M07/M17. Scope M, confirmation page/POST, CSRF/approval tests and browser flow. Show exact cost/balance-after, grant identity and confirmation state; approve only via authenticated POST. Verification: actual rendered narrow/desktop light/dark, denied/expired/success states, GET no effect, CSRF and cross-account attempts rejected. Record browser evidence; no phone UI change is required.

**M19 - Deliver confirmed reward claims.** Dependencies: M16/M18. Scope M, claim handler/schema and integration tests. Execute approved operation with expected reward stamp through `claimReward`. Verification: changed reward requires reconfirmation, intervening affordable balance movement, retry after edit/delete, no double use under another operation ID, offline concurrent claims converge to the specified negative balance. Checkpoint C: complete v1 tool catalog works with synthetic accounts.

### Recovery, compatibility and operations

**M20 - Finish connection management.** Dependencies: M13/M19. Scope M, connections page/routes, expiry recovery and tests. User can inspect/revoke grants, reconnect same owner and explicitly authorize a paused mixed queue under an active write connection. This consent never overrides a restore-completeness fence. Verify full-session rotation only if implementing it; otherwise show honest expiry. Verification: refresh/revocation/restart matrix, cross-client pending-work resume and browser evidence. Never require a phone password/session export.

**M21 - Bound service resources and diagnostics.** Dependencies: M09/M16. Scope M, limits, metrics/redaction, health/readiness and tests. Cap registration/login/call rates, payloads, pages, pending operations, replicas and concurrency. Log opaque request/operation IDs, tool, latency, failure class and delivery state; no titles, notes, balances, passwords, tokens or SQL payloads. Verification: malicious/oversized input, stalled client, dropped SSE, low disk, busy DB and upstream timeout; graceful shutdown finishes or durably parks operations.

**M22 - Verify real client interoperability.** Dependencies: M19/M20/M21. Scope M, compatibility report, replayable synthetic protocol/client cases. Verify official SDK plus intended remote ChatGPT and Claude connection flows where available; document exact app/version/registration/transport and permission handling. Test current protocol and older actually supported client revisions through SDK negotiation. Verification: discovery, tool listing, read, denied scope, reconnect and URL-confirmed claim. If a client cannot be accessed or a plan feature is gated, record it as unverified; do not advertise universal compatibility.

**M23 - Prepare ARM64 staging.** Dependencies: M05/M21. Scope M, service unit, deploy script, routing fragment and staging smoke test. Verify port collisions; proposed loopback 4413/bridge 4414 are not reservations. Run as separate unprivileged user with private state, key credentials and initial 512 MB/one CPU limits. Route `/mcp`, auth/browser paths and well-known metadata deliberately ahead of existing Snapback routes. Verification: clean ARM64 artifact, resource measurements, anonymous auth challenge, TLS/Origin/Authorization handling, long response/cancellation and unchanged existing routes. No public bind or SDK/schema upgrade.

**M24 - Rehearse backups and restoration.** Dependencies: M04R/M12/M20/M23. Scope M, MCP backup/restore scripts, runbook and synthetic restore test. Back up provider state, keys/recovery material separately, journals and replicas consistently. Drain/stop MCP for backup; coordinate with the existing complete Snapback backup as needed. Test matching/advanced backend snapshots and coordinated restore of both databases from before a successful operation. Verification: all restored deployments start write-fenced; matching heads alone cannot enable retry; only independently proven complete history permits safe replay. Encrypted off-host restore, key loss and pending queues work as documented. Retention and destination must be explicit; unresolved off-host credentials do not justify pretending backup exists.

**M25 - Perform final independent verification.** Dependencies: M10/M11/M15/M19/M20/M22/M24. Scope S/M, evidence report and narrow fixes in separate tasks. Run service gates, inherited validate/native/backend, dependency boundary and real two-client convergence. Non-author reviews auth, crash recovery, claims, routing and restore. Verification: findings fixed and reviewed, evidence lists actual commands/versions/results, CI repeats required gates. No synthetic record or credential appears in tracked evidence.

**M26 - Activate and hand over.** Dependencies: M25. Scope M, production routing/runbook, release record and PR. Back up before activation; deploy versioned artifact with rollback target, verify health/auth and synthetic account end-to-end through public TLS. User privately connects their account for a read-only smoke check when available; production write testing remains on synthetic accounts. Open/link the PR and provide endpoint, connection steps, supported clients, scopes, expiry and recovery limits. Verify rollback independently leaves mobile/Snapback usable. Do not merge automatically or claim the user's connection is complete before they authorize it.

Dependency spine: M01 -> M02/M03 -> M04 -> M04R; M01/M03 -> M05 -> M06 -> M07/M08 -> M09 -> M10/M11; M04R/M08 -> M12 -> M13 -> M14 -> M15 -> M16; M11/M12/M13 -> M17 -> M18 -> M19. M20-M24 converge at M25 -> M26. Read slices and operations preparations may proceed in parallel only after their shared contracts are fixed. Use one task owner for shared core/sync/schema changes.

## 9. Verification strategy and done criteria

Create service scripts with documented cwd: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:integration`, `bun run test:protocol`, `bun run build`. Tests must exercise actual SDK/server/SQLite boundaries rather than mirror handler implementation. Add CI jobs for those scripts with synthetic disposable infrastructure and pinned dependencies. Keep root `bun run validate`, `bun run test:native` and `bun run test:backend` green. Existing core files retain 100 percent coverage; any new core branch requires meaningful tests. A service-only change does not require reinstalling the user's phone.

| Risk | Required end-to-end evidence |
| --- | --- |
| Cross-account data leak | Two synthetic users, concurrent grants and guessed IDs/cursors/operations see only their authorized data. |
| Read grant accidentally writes | Actual read Snapback bearer, mutation attempts refused, observed transport has zero backend mutation calls even during bootstrap/settlement. |
| Duplicate intent | Count check/claim lost response, repeated MCP connection, process restart and matching backup restore return original effect/result. |
| Crash between databases | Prepared journal, core receipt, outbox capture and ack failpoints; recovery precedes sync/new work. |
| False success | Partial upload, superseded mutable record, expired session, quarantine and offline backend do not become a false acknowledged/completed result. |
| Wrong date | Two zones, custom start-of-day, DST gaps/folds, explicit history, future rejection and retry across midnight. |
| Broken product economics | Check/undo/reward round-trip to a fresh native-like SQLite client; immutable hashes/IDs and ledger sums converge, including negative offline claims. |
| OAuth bypass | Wrong audience/issuer/resource, code replay, redirect tamper, no PKCE, expired/revoked scope, metadata SSRF and account-switch attempts. |
| Framework pollution | Clean root install/typecheck/native/backend stays green; built service graph has no mobile runtime dependency. |
| Operational failure | ARM64 bounded-load/low-disk/shutdown test, private backup and isolated restore, route rollback with existing services intact. |

Visible browser pages need actual screenshots and narrow/desktop/light/dark checks, with loading, denial, expiry and success states. Use the available browser workflow and record missing client access honestly. If product UI/native/schema changes become necessary, read matching SDK 57 docs, follow current device tooling, update native checksum gates for any product migration and obtain real rendered device evidence. Keep original Metro 8081 untouched; fullstack owns 8090.

Done means: all 15 scoped tools meet their contracts; synthetic read/write/convergence/recovery tests pass; authenticated remote client connection is demonstrated for every advertised client; Oracle deployment has a tested rollback and recoverable state; independent review has no unresolved blocking issue; task ledger and PR accurately distinguish shipped, unverified and deferred capabilities. A working development `tools/list` alone is not completion.

## 10. Hosting and release details

Oracle has four ARM cores and 24 GB RAM. Existing Snapback uses a 512 MB/one CPU service limit and has been observed at low idle memory; this is not a combined workload benchmark. A bounded MCP service is plausible here, subject to M23 measurements. Avoid holding an unbounded replica, cache or live subscription per connection. Begin with explicit open-replica and request limits and tune from measurements.

Proposed MCP OS user/state: `habitmcp`, `/var/lib/habit-system-mcp` mode 0700. Deploy immutable artifacts under a separate `/opt/habit-system-mcp` release directory. Harden the service with restricted writable paths, no-new-privileges and systemd resource controls. Keep keys outside the application backup and document encrypted key recovery. Configuration has a fixed canonical backend URL and public issuer/resource URLs; reject arbitrary request-derived hosts for redirects or upstream requests.

The existing backend remains loopback 4410 behind bridge 4411. Read actual Traefik network/config before editing. Route auth-provider endpoints, browser pages and required well-known metadata explicitly, keeping other applications and Snapback `/q`, `/m`, observation, schema and API routes intact. Do not replace the entire shared provider YAML. Preserve Authorization/Origin and sanitize untrusted forwarding headers. Verify proxy behavior for the SDK's Streamable HTTP and cancellation; do not assume old SSE-only transport recipes apply.

Readiness checks detect failed schema/key/ownership initialization without leaking account details; global liveness is separate from a particular grant requiring reconnect. Rollback disables only MCP routes/service and returns to a compatible previous service artifact/state schema. Do not roll back a service database with an older operation journal and replay uncertain accepted writes. If backwards migration is unsafe, leave state intact and disable writes while recovering. Document disk retention, archive encryption, off-host destination and restore objectives with measured evidence rather than invented RPO/RTO numbers.

## 11. Sources and evidence boundaries

Checked 2026-10-30. Revalidate version-specific APIs at implementation time and pin the tested versions. These references support protocol/library behavior; the product architecture and task breakdown are this plan's engineering design.

- [MCP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): resource-server discovery, OAuth, PKCE and client registration profile.
- [MCP transports, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports): current HTTP protocol behavior; rely on SDK compatibility rather than handwritten version logic.
- [Official TypeScript SDK authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md): resource-server verification and operation authorization; legacy authorization-server helpers are not the maintained provider path.
- [Better Auth MCP](https://better-auth.com/docs/plugins/mcp) and [CIMD](https://better-auth.com/docs/plugins/cimd): provider composition and runtime-specific fetch security boundary. Snapback custom identity integration remains a proof gate.
- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider): grant/provider lifecycle.
- [node-oidc-provider](https://github.com/panva/node-oidc-provider): maintained fallback subject to the same proof, not a second implementation to build concurrently.
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite): synchronous API and transaction constraints relevant to the async core adapter.
- [Snapback source at researched revision](https://github.com/expo/snapback/tree/68b3e2f82904a2868f15c0734e4bd108cc830ac7/snapback4): v4 operation/authorization surfaces. Installed `node_modules/snapback4/reference/CLIENT-AND-OPERATIONS.md` and `dist/auth.d.ts` are authoritative for deployed 0.4.49 session behavior.

Machine-local optional research is in `.artifacts/mcp-plan-research/` and `.artifacts/mcp-research/upstream`. Those ignored paths are not copied into worktrees. The committed plan, cited source revisions and existing tests are sufficient to restart. Do not read `.artifacts/phone-migration/` for MCP development.

## 12. Implementation handoff

The new implementation chat must be bound to the fullstack repository in its own worktree based on the plan commit. Read this plan, `mcp-todo.md`, current `AGENTS.md`, `FORK.md`, `tasks/fullstack-plan.md`, `ops/README.md` and relevant product spec before implementation. Start at M01, preserve the user's original repositories/data, and carry the plan through the verified v1 outcome. Do not stop after a scaffold or a plan refresh. Use explicit proof gates to select supported implementations, record deviations with evidence, and ask only for genuinely missing user actions such as private sign-in or inaccessible external client setup.

Planning review receipt: three fresh-context read-only review rounds on 2026-10-30. Initial findings required explicit mixed-grant revocation handling and stale-backup fencing. Follow-up identified coordinated rollback of both databases. The final round found no remaining concrete contradiction in scope after the delivery barrier, independent completeness requirement, write-fenced restore procedure and M16 dependency correction. This approves the plan's stated requirements, not the feasibility or correctness of an unbuilt implementation. M01/M03/M04/M04R remain mandatory evidence gates.
