# MCP v1 contracts

The executable catalog is `services/mcp/src/tools/contracts.ts`. It defines exactly fifteen tools, strict runtime inputs, structured outputs and invocation-time scope policies. The HTTP resource is `https://habits.ramimaalouf.com/mcp`. Authentication never accepts an account, backend URL, SQL statement, file path or upstream bearer from a tool argument.

| Tool | Required authority | Date and continuation policy |
| --- | --- | --- |
| `list_habits` | `habits:read` | Active by default; active, archived or all; order key then id; opaque continuation. |
| `get_habit` | `habits:read` | Exact habit id; archived state is explicit; deleted/missing is not found. |
| `get_today` | `habits:read` | Required IANA zone; each habit uses its own start of day; fourteen-day strips; maximum 100 habits. |
| `list_stacks` | `habits:read` | Required zone; current derived stacks; root id ordering and continuation. |
| `get_stack` | `habits:read` | Required zone; root's logical date; at most 365 heatmap cells and 100 members. |
| `get_checkin_history` | `habits:read` | Exact habit id; inclusive optional date bounds; effective check-ins descending by logical date, creation instant and id. |
| `get_coin_balance` | `coins:read` | Ledger-derived earned/spent/balance; negative balances are valid. |
| `get_coin_history` | `coins:read` | Ledger date, creation instant and id descending; opaque continuation; reward title snapshots survive deletion. |
| `list_rewards` | `coins:read` | Active by default; lifecycle filter; order key then id and continuation. |
| `get_reward_claim_preview` | `coins:read` | Required zone and intended operation UUID; midnight boundary; no spend or reservation. |
| `get_sync_status` | Either read scope | Account observation, admission, delivery pause and recovery fence; no paths or credentials. |
| `get_operation` | Either read scope plus originating operation authority | Exact operation UUID; account and stable client lineage enforced separately; refresh never creates a new namespace. |
| `create_checkin` | `checkins:write` | Required zone and operation UUID; optional explicit date/instant/amount/note; never toggles. |
| `undo_checkin` | `checkins:write` | New operation UUID and original create operation UUID; only a real `created: true` result grants a target. |
| `claim_reward` | `coins:read` and `rewards:claim` | Operation UUID and browser-approved confirmation token; retained original date on retry. |

`habits:notes:read` adds note content only to an otherwise authorized history read. Without it the `note` property is omitted, including in cached responses. Titles, notes and other human content are untrusted data. They never cause tool execution, model calls or authorization changes.

## Results and bounds

Every success contains `{ data, meta }`; the SDK also receives a concise text summary. Metadata contains epoch-millisecond `observedAtUtc`, nullable `lastCompletedPullAtUtc`, nullable backend revision, sync status, pending local delivery count, incoming pending/blocked/quarantined/deferred counts, and `usedCached`. Observation describes this server's knowledge, including the possibility of other devices being offline.

Reads default to `freshness: "require_sync"`. Failure or incomplete/quarantined admission returns a typed error before exposing an apparently clean snapshot. `allow_cached` explicitly permits a previously bootstrapped snapshot with its stale/attention/reconnect metadata. Expected reconciliation queued by a read-only pull does not itself make the completed pull stale. A read uses only its read-scoped upstream authority even if another connection has write permission.

Pages default to 50 and cannot exceed 100 items. Entire structured results cannot exceed 131072 UTF-8 bytes. Page builders shorten a page to its byte budget and provide a cursor; if even one item or a non-page result cannot fit, return a clear bounded-result `UNAVAILABLE` error. Never truncate JSON or silently omit records. Dates within one history day may span multiple pages; this is a row-based keyset API, separate from the phone's whole-day prefix query.

Successful MCP text summarizes the returned entities, counts, logical dates, coin costs or operation and delivery states. It labels cached observations and queued deliveries. Preview text includes the human confirmation URL when it fits; an oversized URL remains intact in structured data with an explicit reference. Text is capped at 8192 UTF-8 bytes, omits private check-in notes and lists at most five example entries. Structured data remains authoritative for complete pages and continuation.

Cursors are authenticated opaque tokens, bound to account, tool, filters and ordering. Keys survive restart. They are not portable between clients/accounts or filters. Continuation is a sequence of consistent individual reads, not a frozen historical snapshot: insertions before the cursor are seen on refresh, while later deletions disappear. Changing a row's ordering fields may move it across a cursor. Refresh from the first page to see concurrent changes. A cursor never weakens current scope or lifecycle checks.

## Dates and mutation intent

Time zones must be recognized IANA names, including UTC, rather than fixed numeric offsets or the server's local zone. Dates are real `YYYY-MM-DD` values. Each request captures one immutable UTC instant and zone. Reject future logical dates/instants, daily instants, unsupported amounts, and inconsistent explicit date/instant pairs using the habit's boundary and existing core validation. Occurrence offsets remain distinct from the request's current zone. Core source is `app`; MCP provenance belongs to the service journal, preserving schema 12 and native contracts.

Mutation operation ids are client-generated UUID v4 values, required on every request. The namespace is exact account plus stable OAuth client identity plus operation id. The fingerprint binds the tool and canonical original explicitly supplied input, before evaluating time-dependent defaults. First admission freezes the request clock, zone, normalized core arguments, resolved date and command UUID. A repeated id with a different tool or arguments returns `IDEMPOTENCY_CONFLICT`; an uncertain caller retries the same id or reads it with `get_operation`.

Daily already-checked creation returns `created: false` with no new check, earnings or undo entitlement. Undo resolves the service's recorded original command and created row; it never provides general deletion or a whole-day uncheck. Changed/removed remote targets return the actual domain outcome.

The operation result distinguishes prepared, rejected, no mutation, local committed, pending delivery, acknowledged, attention and reconnect states. Delivery separately distinguishes pending, exact acknowledgement, superseded mutable data, no required delivery and unknown. An empty queue, completed pull or revision cannot establish acknowledgement. A commit remains a durable accepted intent if upload or the HTTP response later fails. Results are subject to current originating scopes and client lineage; reconnecting another account cannot retarget them. Fingerprints and tombstones are retained for the v1 replica lifetime.

## Reward approval

A preview binds account, client, operation id, reward/version/cost, zone and expiry. It returns a browser URL and opaque token. An authenticated, same-account, CSRF-protected POST approves exactly that quote. GET and model-supplied boolean confirmation have no effect. The page states the exact cost and quoted balance after, and explains that other devices may change the final balance. URL elicitation is advertised only for clients actually verified to support it.

Claim admission synchronizes first, validates approval and scope again, then calls the existing core claim with the expected reward stamp. A changed reward needs a new preview/approval. Balance may move between quote and claim if the core transaction can still afford the cost. Receipt replay survives later reward edits/deletion. Approval cannot authorize a second operation id. Concurrent offline claims remain accepted and may converge to a negative balance; no global reservation or nonnegative promise is added.

## Errors and recovery

Tool errors set MCP `isError` and return a bounded `{ error: { code, message, retryable } }`. Codes are `INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, `RECONNECT_REQUIRED`, `SYNC_ATTENTION`, `UNAVAILABLE`, `RATE_LIMITED` and `OPERATION_PENDING`. Authentication uses SDK/HTTP OAuth errors and discovery challenges. No raw SQL, stack, credential or other-account detail is returned.

Revocation is serialized with commit and pauses mixed/unattributed pending delivery until explicit same-owner consent under an active write connection. That delivery consent never clears a restore-completeness fence. Unknown/forked journal heads, missing receipt history and restored deployments remain write-fenced. Matching old snapshots do not prove that acknowledged operations are absent. Read-only degraded recovery is explicitly labeled; mutation safety is not promised after unrecoverable journal loss.

## Compatibility evidence

Official SDK v2 over Streamable HTTP is the automated target. ChatGPT and Claude desktop/web are intended manual targets, with exact tested versions and flows recorded in `compatibility.md` once exercised. A target's presence here is not connection evidence. No v1 resource, subscription, generic SQL/upload, habit/reward CRUD or arbitrary historical stack simulation is exposed.
