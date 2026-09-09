# Implementation Plan: Habit System

Spec: `SPEC-habit-system.md` (approved 2026-09-08, amended by Rami's pre-T2 decisions). Inherited specs: `SPEC-native-foundation.md`, `SPEC-ripples-product.md`.

Status: approved for implementation. T1 through T18 and Checkpoint B are complete; T19 sync and visibility is next. Rami approved excluding the stored archive date from stack requirements, with same-day restore requiring the habit again. Rami authorized updating and pushing the planning documents, then completing T2 through T24. Stacks combine checks on one stored logical date only; consecutive dates never combine into one stack run.

The original plan was authored by Fable 5.1. Ripples planning artifacts remain archived under `tasks/ripples/`; the incorporated review is `tasks/plan-review.md`.

## Overview

Implement daily habits, same-day stacks, coins and rewards, then alerts and sample mode. Preserve inherited Count board behavior except where the approved spec explicitly changes it. Each completed task leaves automated and native gates green. Intermediate builds are development checkpoints, not release-ready versions: new data is not safe for real multi-device use or backup until the native, sync, and export gates through T20 pass.

Work through task numbers in order. Bounded substeps keep large tasks reviewable without leaving shared contracts broken between commits. Delegate independent inspection, testing, and review; implementation ownership must remain explicit.

## Repository baseline (2026-09-08)

- Schema version 5 with immutable statement lists and migration checksum tests.
- TypeScript commands use exclusive transactions, mutation stamps, outbox writes, and idempotency receipts. Create, edit, remove, Remove Latest, Undo, board deletion, import, sync, and Swift intents are separate mutation paths that need consistent behavior.
- Home uses fourteen days; widgets use seven. Widget quick actions currently deep-link into the app because extension interaction events do not safely reach the app writer.
- Sync records and native CloudKit mapping use schema version 1 and reject unsupported types/versions. Existing version 1 peers do not silently ignore version 2.
- Export version 1 has explicit parsers and omits tombstones and sync metadata. Restore retains stable ids and does not revive tombstoned records.
- The TS and Swift App Intents executors share `src/core/automations/fixtures/intent-contract.json`.
- Pre-T2 gates: 570 Jest tests with core at 100 percent, 51 Swift tests, 9 plugin checks; T1 recorded doctor 21/21 and a simulator build under Habit System identifiers.
- Metro 8081 belongs to Ripples. Use a separate fork port, normally 8082, and never stop 8081.

## Architecture decisions

- **Migrate with the feature.** T2 adds board/settings fields and widget kind support in schema 6. T3 adds immutable `habit_actions` evidence in schema 7, including a nullable policy snapshot reserved for later coin rules. T15 adds the ledger in schema 8; T16 adds the exact-date action index in schema 9; T18 adds rewards in schema 10; T19 adds immutable remote admission and effective check visibility in schema 11; T21 adds local miss alerts in schema 12. Each migration updates the Swift schema gate/checksum map in the same commit. Released migrations never change. Future tables are not frozen in T2.
- **Stacks group one stored date.** `deriveStacks` orders anchor-connected boards. The stable stack id is the structural anchor-root board id, independent of whichever member displays first. `assignRuns` groups by exact stored `logicalDate`; `rootId|logicalDate` identifies a run. Occurrence instants and usual times never move a check to an adjacent date. Usual times and preset times are informational.
- **Eligibility uses date-based activity periods.** Stack requirements include the stored start date and exclude a closed end date, as approved in spec section 10, item 6. Archiving removes the habit from requirements on its archive logical date; same-day restore reopens the period and requires it again. A run is complete only when at least one required eligible member exists and every such member is checked for that date. There is no inferred intraday activity history or current-day-only archive filter; inherited non-stack analytics retain inclusive closed ends.
- **Daily mutation state is atomic and has durable evidence.** The toggle resolves current state and writes inside one command transaction. Check is idempotent for a checked date. Uncheck clears all live checks for that selected date, including preserved Count history, with UI confirmation when notes would be removed. Individual history deletion remains a single-record operation. Immutable `habit_actions` retain checked and unchecked action evidence so offline daily state follows the greatest valid mutation stamp with a deterministic tie-break. Evidence is written by all TS/native mutation paths and later syncs/exports as its own record type.
- **All writers obey the coin rules.** Check earnings apply to opted-in Daily and Count boards. Pure entitlement rules and shared transaction helpers cover create, edit, remove, Remove Latest, Undo, board deletion, native intents, import, and sync. Date/time edits never mint a fresh reward; a date move emits `move_out`/`move_in`, with only a timely move-out revoking the original entitlement. Explicit restore/import paths preserve history without minting earnings. Membership changes update surviving roots and retire disappearing old root/date scopes. Ordered root-carried policies prevent stale member observations from restoring superseded requirements; they preserve prior entitlement and never create retroactive rewards.
- **The ledger stays append-only and is reconciled.** Ordinary local effects commit with the triggering action. The event replay and adjustment protocol in `docs/ledger-reconciliation.md` deterministically compensates duplicate or superseded offline earnings, cap races, and reversals; it also handles runs completed only by merged checks. Re-completing an eligible same-day run restores its net bonus without deleting earlier rows. Generated ledger and synthetic baseline-action identities use UUIDv5; commands/live actions remain UUIDv4. Adjustment rows carry scope, source action, reconciliation identity, adjusted-row reference, and provenance. Claims remain distinct immutable debits; approved offline overspending can produce a negative balance. Earned/spent totals retain the approved raw positive/negative sums.
- **Claw-back follows logical-day boundaries.** A check coin uses its own board's logical-day close. A run bonus uses the structural root board's inherited start-of-day boundary. Usual time never controls either. Old earnings remain after their approved boundary. Explicitly test closed-date edits and replay valid earlier actions received after closure without changing that policy.
- **Sync compatibility is directional.** Version 2 reads valid version 1 records with defaults. Running version 1 peers against version 2 data is unsupported and requires upgrading peers. TS record definitions, validation/merge logic, and Swift mapping change together. No fake peer test may claim old binaries support unknown types.
- **Sample mode isolates effects and navigation.** Reuse product components and commands against a separate in-memory database with injectable no-op adapters. Every nested screen/form stays under the sample provider. Real widget publication, notification listeners, sync, import/export, App Intents, iCloud settings, and icon changes are disabled there. Close tears down sample navigation, listeners, and database.

## Dependency order and commit boundaries

```text
T1 identity (done)
  -> T2 schema 6 + board/settings/widget defaults
  -> T3 schema 7 + action evidence + daily commands
  -> T4 form -> T5 home -> T6 heatmap
  -> T7 widget action flow + atomic TS/Swift fixture integration
  -> T8 native daily device verification
  -> checkpoint A: daily development build
  -> T9 preset times -> T10 anchor rules -> T11 anchor form
  -> T12 same-date stacks -> T13 analytics -> T14 screens
  -> checkpoint B: same-day stacks development build
  -> T15 schema 8 + ledger + all-writer earnings + controls
  -> T16 schema 9 exact-date index + bonus restoration and reconciliation
  -> T17 coins screens
  -> T18 schema 10 + rewards domain + screens
  -> T19 schema 11 + sync 2 integration and offline conflict convergence
  -> T20 export 2 and complete import compatibility
  -> checkpoint C: complete data/native compatibility
  -> T21 schema 12 + miss alerts
  -> T22 sample generator -> T23 isolated sample UI
  -> T24 cosmetics and final closure
  -> checkpoint D: every current success criterion
```

T7 and T8 remain separately recorded tasks, but new shared fixture cases and both executor implementations land together in T7's contract substep. T8 owns the remaining native-specific regression and device evidence. No intermediate commit deliberately fails native fixtures. The same rule applies when T15/T16 extend native coin behavior.

T19 first establishes schema 11 and explicit legacy evidence with matching app/native visibility, including v1 sync/import compatibility. Its following increments add source-neutral immutable admission, coordinated schema-2 mapping, local recovery and convergence proof. The foundation remains development-only and does not substitute for T19/T20 or Checkpoint C.

## Phases and checkpoints

### Phase 0: fork identity

T1 applied the identifiers and created the EAS project. Checkpoint 0 already records plugin checks, doctor, generated-native hygiene, and a running simulator build under the new bundle id.

### Phase 1: daily habits

- T2: schema 6, repository hydration, explicit Count compatibility defaults, board/settings/widget entity types, and Swift gate.
- T3: schema 7 action evidence, Daily validation, atomic toggle, preserved history handling, manual edit rules, idempotency, and reusable TS/native transaction helpers.
- T4-T6: native Kind control, fourteen-state Home card with weekly count/streak, accessible toggle/confirmation/Undo, and binary heatmap.
- T7-T8: daily widget fallback route, checked-state rendering, matching TS/Swift intent contracts, and native verification.

Checkpoint A: create and toggle a Daily board through Home, widget fallback, and Shortcuts; preserved multi-check history unchecks correctly; Count behavior remains covered. All task gates and independent review pass. This is a development checkpoint pending T19/T20 compatibility.

### Phase 2: same-day stacks

- T9-T11: preset settings, anchor validation and deletion cleanup, anchor picker, informational usual time, and required-member control.
- T12: pure derivation with stable structural identity, before/after ordering, exact stored-date membership, and date-based eligibility.
- T13-T14: current/longest streaks, complete runs per ISO week, member counts, four-state heatmap, stack list/detail, and meaningful empty states.

Checkpoint B: user-entered habits derive the expected topology, while evening checks on one date and morning checks on the next never complete one run together. Informational time edits do not reassign history. Before/after order, archived members, and zero-required-member behavior pass automated and simulator checks.

### Phase 3: coins and rewards

- T15: deterministic action-replay/adjustment contract, schema 8, append-only repository, cap/claw-back rules, all TS/Swift mutation paths, and Earn Coins/Daily Coin Cap form controls for both kinds.
- T16: schema 9 exact-date action index, one net bonus per complete same-day run, reversal/restoration, and deterministic reconciliation for merged-only completion and conflicts.
- T17: balance pill, totals, Coins, and virtualized history, including negative balances and compensation explanations.
- T18: schema 10, reward commands, confirmed claims with title snapshots, forms, and history surviving reward deletion.
- T19: schema 11 for bounded immutable admission and effective visibility, explicit legacy baseline initialization, coordinated sync schema 2 across TS/native, old-record defaults, minimum peer policy, deterministic daily conflict resolution, immutable ledger union, and compensation convergence. The shared boundary is `docs/remote-fact-admission.md`; a separate persistent scope-work queue is unnecessary when admission and settlement are atomic.
- T20: export 2 including effective-live payloads and complete note-free action/ledger evidence, version 1/2 and CSV import, two-pass anchor restore, repeated restore safety, historical ledger references to omitted deleted parents, and complete round-trip coverage. Legacy imports never create fresh earnings but may atomically correct existing entitlements, as approved by Rami on 2026-09-08.

Checkpoint C: two signed devices/simulators converge after duplicate checks, check/uncheck races, cap races, duplicate bonuses/reversals, a run completed only by merged checks, and offline double claims. Repeated/out-of-order delivery remains stable. Export/import round-trips, native fixtures, all automated gates, and independent review pass before real multi-device use.

### Phase 4: alerts, sample mode, and closure

- T21: schema 12, local miss-alert status and identifiers, date-based reconciler, existing notification permission, deduplication, deep links, and pending count.
- T22: deterministic three-year sample and in-memory factory using all current migrations.
- T23: modal navigation, injectable disabled adapters, persistent banner, working internal commands, teardown, and real-database/effect isolation.
- T24: user-visible rename completion, final regression, exports, doctor, and evidence ledger.

Checkpoint D: every current success criterion in spec section 9 is supported by evidence. The removed starter-stack criterion remains removed. Record unavailable external checks honestly; simulator or mock results do not substitute for required signed-device behavior.

## Verification and delivery

1. Tests first, implementation, then refactor. Use accessible role/name queries and meaningful domain/contract cases.
2. `bun run validate` exits 0 before every commit, with every `src/core` file at 100 percent on all four metrics. `bun run test:native` stays green.
3. Capture simulator evidence for visible changes, including full-resolution screenshots for pixel review. Delegate repeated device inspection to a bounded non-author agent.
4. Independently verify each completed task/substep. Record decisions, tests, native evidence, and commits in `checkpoints.md`.
5. Use lowercase conventional commits without signatures/co-authors. Rami authorized pushing the revised planning documents and completing the implementation; finish required checks before each push.
6. Final gates include doctor, iOS/Android production exports, `git diff --check`, signed-device requirements, and multi-device sync evidence.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Adjacent dates accidentally combine | Exact stored-date membership tests; usual/occurrence time changes never shift stack assignment |
| Stable root changes with display order | Key stacks by the terminal structural anchor-root board, with deterministic ordering tested separately |
| Daily history has multiple old records | Atomic all-record uncheck, note confirmation, single-record history deletion, and restore/edit tests |
| Offline duplicate entitlement inflates balance | Deterministic compensation identity, full-mesh/out-of-order fixtures, and two-device convergence |
| Bonus stays lost after rechecking | Append-only restoration cases across app, Swift, sync, replay, and close boundaries |
| A writer bypasses ledger effects | All-writer transaction inventory and shared TS/Swift fixtures |
| Schema bump disables Shortcuts | Gate/checksum map changes with every migration; native schema test before commit |
| Partial sync/export loses new fields | Development-only checkpoints until T19/T20; coordinated TS/native schemas |
| Old peer is treated as compatible | Explicit upgrade requirement; test v2 reads v1 without claiming reverse compatibility |
| Deleted ledger parents break restore | Loose historical references, title snapshots, immutable ids, and repeated-import tests |
| Sample escapes into the real app | Adapter call assertions, navigation/provider coverage, checksum, and teardown tests |
| Miss alerts repeat or count archived gaps | Date-based periods, persistent pair key/status, denied-permission and clock fixtures |
| Fork loads Ripples JavaScript | Separate Metro port and verified deep link/bundle identity |

## Parallel work

Task dependencies stay sequential. Agents may independently inspect, test, or review bounded work without sharing file ownership. T21 and T22 preparation can be explored independently, but T22's final factory tests must include schema 12. Keep code commits and checkpoint entries in task order. T24 follows completion of both tails.

## Resolved review decisions

Rami approved the review amendments and continued implementation on 2026-09-08. His latest correction replaces overnight grouping entirely: stacks are same-day only. Re-completion restores the net bonus; offline daily state uses latest-action resolution with append-only ledger compensation. There are no pending product questions from the pre-T2 review.
