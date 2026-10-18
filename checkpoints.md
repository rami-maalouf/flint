# Checkpoints

## Habit System (SPEC-habit-system.md) - task checkpoints

### Native module and internal identifier rename (2026-09-30)

1. Renamed the local native module from `modules/ripples-apple` to
   `modules/habit-system-apple`: native module name `HabitSystemApple`,
   podspec `HabitSystemApple.podspec`, Swift package targets
   `HabitSystemIntentCore` / `HabitSystemCloudKit`, `HabitSystem`-prefixed
   intent, entity, runtime, and shortcut provider types, Info.plist keys
   `HabitSystemAppGroupIdentifier` / `HabitSystemCloudKitContainerIdentifier`,
   the EAS env var `HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT`, and the `app.config.js`
   development key `extra.habitSystemSharedIdentifier` (added as
   `ripplesSharedIdentifier` by pull request 3 and renamed while rebasing onto
   the merged main). The widget source
   is `src/platform/widgets/boards-widget.tsx` with `BoardsWidgetProps`.
2. Renamed the internal identifiers that still said ripples: the database
   file is `habit-system.db` (the opener moves a legacy `ripples.db` with its
   wal and shm files to the new name inside the shared container, or from the
   pre-app-group documents folder), the miss-alert notification prefix is
   `habit-system.miss.v1:` on both the JavaScript and Swift sides and in the
   shared contract fixture, and backups are written as `habit-system.export`
   while import accepts both `habit-system.export` and `ripples.export`.
   The import-from-Ripples CSV feature, the fork history documents, the
   inherited specifications, and earlier ledger entries keep the Ripples name
   because they refer to the Ripples app.
3. Gates: `bun run validate` passes 210 suites / 3,083 tests with all 105 core
   files at 100 percent (the four new database relocation tests and two
   legacy-format import tests included); `bun run test:native` passes 14
   plugin and 195 Swift tests. A first full run exited 1 because the new
   database test replaced the whole `react-native` module, which made an Expo
   logger warn after teardown; the mock was removed and the rerun exits 0.
   After pull request 3 merged, the commit was replayed onto main: six
   conflicts resolved, `bun run validate` passes 210 suites / 3,090 tests with
   all core files at 100 percent, and `bun run test:native` passes again.
4. Native regeneration: `--no-clean` prebuild kept the stale generated
   `RipplesApplicationIntents.swift`, the old `AppDelegate` call, and the old
   plist keys, so the project was regenerated with `--clean` (UTF-8 locale)
   and rebuilt. The installed app's `habitsystem.debug.dylib` contains
   `HabitSystemAppleModule` and no `RipplesAppleModule` or `RipplesCheckInIntent`
   strings; `Metadata.appintents` names `HabitSystemApplicationShortcuts`.
5. Device evidence: on `Habit Layout QA` (`1FEA4F08`) the in-place install
   and first launch against Metro 8082 renamed `ripples.db`, `-wal`, and
   `-shm` to `habit-system.db*` and Home shows the same 7 boards (81 check-ins
   before). On `Habit System QA` (`62014A57`) the 135,168-byte `ripples.db`
   became a byte-identical `habit-system.db` (md5 `fa7b9698...`); that device
   then showed its pre-existing "Migration 7 does not match its recorded
   checksum" state, which predates this change. Evidence:
   `.artifacts/rename-habit-system-apple/`.
6. Known follow-ups: a pending miss alert scheduled by an older build keeps
   the `ripples.miss.v1:` identifier and is now treated as foreign, so it may
   fire once; an App Intent that runs before the app's first launch after
   this upgrade finds no `habit-system.db` until the app has moved it.
   Independent verification by a non-author is still open.

### Layout Done button spacing (2026-09-29)

1. Added the existing 16-point horizontal spacing token to the layout Done
   button so its glass capsule has balanced space around the label.
2. Argent reproduced the tight spacing and verified normal and maximum Dynamic
   Type after the change. Done dismisses the picker; it remains open in Device
   Hub for inspection. The overlapping Expo developer gear was disabled for
   this QA launch only with `-EXDevMenuShowFloatingActionButton NO`.
3. `bun run validate` passes 209 suites / 3,077 tests with all 105 core files at
   100 percent; native tests pass 14 plugin and 195 Swift tests. Independent
   verification found no issues. Evidence: `.artifacts/board-layouts/done-*`.

### Four board layouts and native glass correction (2026-09-29)

1. Restored the original compact pill proportions and all 14 history bars.
   Restored the taller 14-day summary card as a fourth explicit layout, including
   Daily weekly/streak details and a Count total. Every layout applies to both
   kinds and all title lengths. Existing saved choices remain valid; the new
   summary choice persists through restart and stays isolated in sample sessions.
2. The iOS layout selector now uses a native SwiftUI segmented Picker inside an
   interactive capsule-shaped Liquid Glass effect, with four icon choices.
   Other platforms retain the shared four-option control. Done and close retain
   the choice; the fixed-height header keeps Done readable at maximum Dynamic Type.
3. Updated integration tests first failed on the missing 14 bars and fourth
   option, then passed with real Daily/Count history, check-in/Undo and summary
   persistence. Full validation passes 209 suites / 3,077 tests, with all 105
   core files at 100 percent. Native tests pass 14 plugin and 195 Swift tests.
   Logs and native screenshots are `.artifacts/board-layouts/four-*`.
4. Argent validated all four choices, summary check-in/Undo with the picker open,
   cold-start restoration, light/dark material appearance and maximum Dynamic Type.
   The app remains running in Device Hub on Habit Layout QA, served by Metro 8082.
5. Independent review found no remaining actionable issues after strengthening
   the Count test to assert totals of 2, 3, 4 and 3 after Undo. Receipt:
   `.artifacts/board-layouts/four-review.json`, run
   `2026-09-30T00-06-24-105Z-four-layouts`. The final header styling change also
   passes lint, typecheck and 13 focused tests. Spoken VoiceOver and Android
   device behavior were not manually validated.

### Board layout preferences (2026-09-29)

1. Removed the Boards title and added a third top-left Layout action. Compact
   rows, two-column history cards and full-width history cards apply uniformly
   to Daily and Count habits. A floating glass selector previews the choice;
   Done and the separate close control dismiss it. Long titles truncate without
   choosing a different card shape. Accessibility text sizes use one readable
   grid column while preserving the selected preference.
2. Layout persists in device-local SQLite key-value storage, outside the product
   schema and sync records. Sample sessions keep an isolated in-memory choice.
   Failed saves roll back visibly and support retry. Existing check-in, Daily
   toggle, reorder and Undo behavior is retained, including opening Layout during
   the Undo window. Expanded cards use real dated check-in history.
3. Argent validated all three layouts on a fresh iPhone 17 Pro / iOS 26.5
   simulator with seven synthetic boards: close/Done, check-in/Undo, cold-start
   persistence, long titles, the odd final grid card, scrolling, light/dark and
   maximum Dynamic Type. Screenshots and command logs are under
   `.artifacts/board-layouts/`. The earlier QA database with a migration checksum
   mismatch was preserved. No Android device validation was performed.
4. Independent review found and verified the fix for opening Layout clearing an
   active Undo action. Regression tests cover real history cells, uniform card
   shapes, persistence, sample isolation, failed writes, suspended sessions,
   accessibility sizing and Undo preservation. No actionable findings remain.
5. Final `bun run validate` exits 0: 209 suites / 3,077 tests, with all 105 core
   files at 100 percent. Native validation passes 14 plugin and 195 Swift tests.
   Final logs are `validate-shipping.log`, `native.log` and `simulator-final.log`
   in the evidence directory. The independent review receipt is `review.json`,
   run `20260929-board-layouts-7162ecc8`. Owned QA simulators and the port-8082
   Metro server are stopped; simulator data is retained.

### T16 - same-day bonus settlement and restoration (2026-09-08)

1. Pure TS and Swift replay award one net bonus for an exact structural-root/date
   scope. A genuine incomplete-to-complete transition earns; timely removal of
   the last check on an original required board reverses; fresh completion
   restores through another immutable row. Adjacent dates never combine.
   Policy changes, baselines and date moves do not mint rewards. Held bonuses
   retain their original required set and close, including consumed-token
   witnesses across delayed, repeated and late removals.
2. Existing bonus rows are validated against their own source and candidate
   root policy before final-union entitlement is evaluated. Missing causes defer;
   known disabled, mismatched or malformed causes fail. Each correction proof
   carries its own complete evidence. A narrow reconciliation core now serves
   check and bonus wrappers without changing existing check identities.
   Literal shared fixtures pin one encoding, 38 replay, 12 reconciliation and
   28 failure cases; independent probes cover 164 valid prefixes and fixed points.
3. Both persistence readers discover historical scopes from exact stored dates,
   root observers and reverse membership, including former and rootless members.
   They expand immutable dependencies in bounded visited batches and retain
   missing-policy source evidence. The 4,096-fact limit applies per scope,
   including pending legacy baselines; multiple small scopes are not rejected
   by an aggregate command limit. Private check notes and amounts never enter
   economic query parameters or baseline payloads.
4. Schema 9 adds the exact-date/kind action index, checksum `421ece28`, with the
   matching Swift gate. Migrations 1-8 remain unchanged. Real schema-8 fixtures
   and three injected failures prove complete preservation, rollback and retry.
   Exact Expo SQLite 3.50.3 host measurements reduce a stress query from 321,842
   scanned actions to 292 date matches, median 37.730 ms to 0.197 ms. These are
   host query measurements, not claimed device latency. Rewards and alerts are
   now planned as schemas 10 and 11.
5. All live app and native writers settle check and affected bonus scopes in
   their acquired transaction after source facts and before receipts/widgets.
   Shared legacy tokens seed once without earning. Baseline source time remains
   zero while local outbox time uses the acquired command time in both runtimes.
   App scope reads remain bounded at 12 for both two-member/one-date and
   33-member/20-date policy mutations. Receipt/no-op paths bypass settlement;
   source, ledger, outbox and receipt failures roll back together.
6. Non-author reviews approve migration, readers, pure logic and all writer
   changes. Review found and fixed known-invalid cause classification, repeated
   candidate hashing and private structural-typing metadata transport, with
   reproduced regression tests. Candidate caches are confined to each evidence
   set, including proof subsets. A 300-award native host probe improves from
   8.360 s to 0.145 s without changing canonical output.
7. Final `bun run validate` exits 0: 103 suites / 1,619 tests, global coverage
   97.68/96.43/95.78/97.95 and all 70 core files at 100 percent. Native gates pass
   9 plugin and 131 Swift tests. `git diff --check` passes. Evidence lives under
   `.artifacts/t16/`, including main gate logs and independent review reports.
8. UTF-8 CocoaPods regeneration includes all three new native sources. The
   generic simulator build succeeds; inherited Expo dev-launcher dependency
   and duplicate `-lc++` warnings remain recorded for final closure. A separate
   development-signed copy preserves executable sections, entitlements and
   App Intents metadata and passes deep-strict/team verification.

9. Non-author actual Migration QA proves schema 8-to-9 in-place preservation,
   normal-form linked Daily creation, app-first/native-final completion,
   actual Shortcuts removal and recheck, read-only Today, and app off/on with
   note confirmation. Cancel preserves the entire database; confirming removal
   reverses the individual coin and bonus, and genuine recheck restores both.
   Public controlled-date commands prove Sep 6 plus Sep 7 earns no bonus, while
   completing Sep 7 earns exactly one. Native receipt replay through the app
   returns the identical result without changing the database hash.
10. Final QA retains every original 27 boards / 65 checks / 85 actions / 10
   ledger rows exactly. Four synthetic boards and their acceptance actions
   leave 31 boards / 72 checks / 98 actions / 22 ledger rows / 308 receipts /
   314 outbox rows. The cold console has zero entries; all 16 installed native
   executable copies match the signed candidate. Final backup SHA-256 is
   `b69ee761028303937690d5a850e5cf37720e1efbc9c48a6bbacf32ceef2756e2`.
   Relevant screenshots pass visual review. Fork/Shortcuts and scoped Argent
   services are stopped and all owned QA simulators are shut down. Evidence:
   `.artifacts/t16/qa/`. This is simulator/Shortcuts proof; real CloudKit peer
   convergence remains the explicit T19 gate.

### T15 - coin evidence foundations and writer integration (2026-09-08)

1. The first bounded foundation adds schema 8, immutable ledger storage and
   matching Swift schema gate/checksum `14ff0dae`. Released migrations 1-7 stay
   unchanged. Ledger rows retain absent historical parents, explicit role fields,
   exact one-coin awards, safe integers and immutable claim title snapshots.
   Direct SQL update, delete and replacement fail. Equal canonical payloads replay
   without insertion; conflicting payloads, including canonically equivalent but
   byte-distinct Unicode titles, fail without overwriting evidence.
2. Three injected migration failures prove complete table/index/trigger/settings
   rollback and successful retry. A version-7 fixture preserves its boards,
   checks, actions, receipts, outbox, widgets and sync state with an empty ledger.
   Before-LIMIT outbox filtering retains staged action, ledger and reward rows
   until T19 while supported v1 records continue to upload without starvation.
3. Command time and zone are now captured inside the acquired transaction after
   receipt replay. Six public-command tests reproduce queued day/zone changes,
   clock/zone failures with full rollback, and saved success/failure replay with
   unavailable clocks. No second-connection race is claimed for this envelope
   test; it exercises the real SQL connection and held transaction queue.
4. Pure TS/Swift check rules preserve source-bound awards, configured caps for
   both kinds, non-earning baseline/move/policy facts and captured close times.
   Canonical rows, policies, UUIDv5 names, SHA-256 proofs and complete dependency
   validation are pinned by shared literal fixtures. Corrections and strict-subset
   cancellations append immutable rows and settle to a fixed point under duplicate
   and reordered evidence. Claims remain outside earning reconciliation.
5. The transaction-scoped economic-close resolver selects the first actual
   crossing of the following date's shift, including gaps, folds, second-level
   historical offsets and proleptic years 0-9999. It is distinct from widget/UI
   refresh deadlines and Date + Time gap-component preservation. Actual Hermes
   public commands reproduced wrong year-0, year-1 and 1582 dates from Apple's
   civil formatter. The TS helper now uses cached exact-offset readers and UTC
   arithmetic, preserving Date TimeClip and explicit invalid/range failures.
   Public tests also reproduce historical offset-second loss. Independent
   native comparison caught a new gap-start regression; the corrected resolver
   eliminates all 60 introduced differences across 2,016 comparisons.
6. Independent review approves the calendar, command timing, storage and coin
   source. Separate oracles cover 176 replay cases, 53 reconciliation runs,
   seven rejected proofs, 16 real plus 210 synthetic economic boundaries, and
   the native compatibility sweep. Durable protocol details and the action-date
   eligibility horizon are recorded in `docs/ledger-reconciliation.md`.
7. Final `bun run validate` exits 0: 85 suites / 1,219 tests, global coverage
   97.36/96.04/95.52/97.71 and all 57 core files at 100 percent. Native gates pass
   9 plugin and 87 Swift tests. `git diff --check` passes. Jest uses direct
   filesystem discovery and explicitly excludes preserved `.artifacts` worktrees
   from module/test discovery, avoiding shared Watchman warnings and old copied
   suites without changing product assertions or coverage. Evidence:
   `.artifacts/t15/validate-verified.log`, `native-final.log` and
   `independent-foundations-acceptance.md`.
8. A generic simulator build initially exposed a stale generated Pods source
   list; `pod install` adds the new local Swift files through the existing
   podspec glob. No generated source was edited. The final build succeeds and
   its signing-only copy passes 20-target/team and deep-strict verification,
   retaining code, entitlements and App Intents metadata. Final artifact:
   `.artifacts/t15/signed-sim-final/habitsystem.app`. The existing Expo dev-launcher
   build-phase warning remains recorded; the first full build also reported a
   duplicate `-lc++` link warning. Neither is claimed fixed here.
9. Non-author Migration QA verifies an in-place schema-8 upgrade with an empty
   ledger and every original board/check/action/period/outbox/widget row intact.
   Actual Hermes passes four civil controls, three exact offsets and all 16
   economic-close vectors. The otherwise unreachable resolver is compiled from
   the exact frozen source with loaded production dependencies and recorded
   hashes, explicitly identified as source evaluation. Fresh public commands
   persist the three corrected historical dates and exact instants. Actual
   Today in Shortcuts returns the preserved original Count's two checks and 12
   total; the installed executable matches the final signed artifact. Runtime
   proof and detailed preservation comparisons are under `.artifacts/t15/qa/`.
   Final 17 boards / 48 checks / 57 actions contain only one added synthetic
   calendar board and six red/green historical checks; all original 16/42/51
   rows remain exact. Additional QA and startup/foreground receipts are recorded,
   and the ledger stays empty. Final Home is clean, console has zero entries,
   and the dedicated simulator is shut down with identical before/after backups.
10. T15b1 adds prepared TS/Swift policy capture and transaction-local settlement.
   Capture snapshots structural topology and scoped activity periods, uses each
   action's exact stored date, and resolves separate member/root close instants.
   Fifteen shared literal cases include shifted roots, archived roots, optional
   members and exact JavaScript text trimming. Malformed date endpoints fail;
   valid reversed intervals remain empty under inherited eligibility semantics.
   Native WAL tests preserve the captured snapshot across a second connection's
   concurrent board/period edit. An independent oracle checks 256 snapshots and
   768 policies.
11. Canonical live policies now round-trip through both action stores. Legacy
   null policies and null-policy baselines retain their existing meaning. Invalid
   or oversized evidence fails before insertion. Settlement reads only the exact
   check scope, appends immutable derived rows, and enqueues newly inserted rows
   using causal stamps and the supplied local enqueue time. Repeated settlement
   allocates no clock, id, HLC or receipt. Real SQL fault tests prove transaction
   rollback and one successful retry.
12. T15b1 passes independent non-author review and the full gates: 88 suites /
   1,294 tests, global coverage 97.4/96.1/95.59/97.75, all 60 core files at
   100 percent, plus 9 plugin and 100 Swift tests. Evidence is under
   `.artifacts/t15b1/`, including `validate.log`, `native-final.log`,
   `green-settlement-final.log` and `independent-acceptance.md`. UTF-8
   `pod install` refreshes both new Swift sources, and the generic simulator
   build succeeds at `.artifacts/t15b1/qa-build/habitsystem.app`. Its inherited
   Expo dev-launcher script and duplicate `-lc++` warnings are recorded. No device runtime
   claim is made for helpers that no live writer calls yet.
13. T15b2 connects TS creation, Daily toggle, targeted deletion, Remove Latest
   and precise Undo, plus native Check In and Remove Latest. Live actions capture
   canonical policy before the first write; settlement precedes widgets and
   receipts in the same transaction. Daily no-op and receipt replay bypass
   policy, hashing and id allocation. Targeted deletion/Undo still work when a
   board tombstone arrives first: null-policy removal uses the original earning
   action's close, without inventing current settings.
14. Forty-seven app cases and the shared two-scenario/eight-step writer fixture
   pin exact public receipts, cumulative actions/policies, ledger identities,
   HLC state, id consumption and replay. Native tests cover confirmed prior-date
   removal across a close, current configuration changes, archived structural
   roots, cap behavior and rollback/retry for missing proofs and ledger/outbox
   failures. Seven independent real-SQL public-command probes additionally prove
   acquired-transaction time/configuration, corrupt-evidence rollback, scope
   isolation, missing-dependency recovery and guard/no-op precedence.
15. T15b2 full gates pass: 89 suites / 1,341 tests, global coverage
   97.41/96.12/95.59/97.76, all 60 core files at 100 percent, and 9 plugin /
   107 Swift tests. Source and the shared literal fixture have independent
   non-author approval. Generic build and signing-only copy succeed at
   `.artifacts/t15b2/signed-sim-build/habitsystem.app`: 20 team-verified targets,
   deep-strict verification, eight unchanged executable/entitlement comparisons,
   unchanged App Intents metadata and 28 frozen Swift source hashes. Only the
   inherited Expo dev-launcher build-script warning appears in this build.
16. Independent actual Migration QA passes app Check and precise Undo, native
   Daily no-op, Count cap1 across two checks, removal of the blocked Count token,
   Today counts and saved-note Cancel/Confirm. Cancel leaves the full snapshot
   hash identical; confirmation reverses only the original source award. The
   authorized setup public-creates two synthetic boards and changes only their
   earning/cap configuration; all tested mutations use public app/native paths.
   All prior 17 boards / 48 checks / 57 actions and retained periods, receipts,
   outbox and sync rows remain exact. Final totals are 19 boards / 52 checks /
   64 actions / 5 ledger rows, 237 receipts and 200 outbox rows. Cold Home is
   visually clean with zero connected console entries. The installed executable
   matches the signed candidate and deep-strict signature verification passes.
   Before/after app termination backups share SHA256
   `8647add1dd7caa5bf1731c1b64b3068fdf48fd95343d54614c7cce9a7c80114f`.
   Evidence is packaged under `.artifacts/t15b2/qa/`; the dedicated simulator
   stays booted with both apps terminated for the next bounded verification.
17. T15b3 captures both stored dates before a check move, writes ordered
   `move_out`/`move_in` evidence and settles both scopes atomically. Only a timely
   source move-out reverses its original coin; the destination and moving back
   never mint another award. Same-date note, amount and time edits preserve
   actions and ledger rows. Board deletion snapshots old policies before link
   detachment/tombstones, removes exact live tokens, settles each date once and
   retains immutable closed history. Every live action call supplies an explicit
   target and policy. Normal imports and direct reference seeding explicitly use
   `preserve-history`; missing/other import modes fail before any writes.
18. Fourteen real-SQL public tests cover move boundaries, moving back, informational
   edits, Daily conflicts, root deletion, preflight topology errors, ledger failure
   rollback/retry, non-earning imports and direct seeding. Independent source/test
   review approves the slice. Integrated `bun run validate` passes 90 suites /
   1,355 tests, global coverage 97.43/96.13/95.6/97.77 and all 60 core files at
   100 percent. Native gates remain 9 plugin / 107 Swift tests; diff hygiene
   passes. Evidence: `.artifacts/t15b3/acceptance.md`, `validate-integrated.log`
   and `native-integrated.log`.
19. Independent actual B3 verification uses the existing signed binary with
   frozen B3 JavaScript. Native date-picker Save moves a check to yesterday and
   back, preserving its id/note and producing only the original-scope reversal.
   The normal board-delete confirmation tombstones a fresh closed-day fixture
   while preserving its source action and award byte-for-byte. A public explicit
   `preserve-history` import adds one restored check and one null-policy baseline
   with no ledger change; same-command replay preserves every table exactly.
   All B2 baseline rows remain exact. Final totals are 21 boards / 55 checks /
   72 actions / 8 ledger rows, 249 receipts and 223 outbox rows, with zero
   connected runtime-console entries. Evidence: `.artifacts/t15b3/qa/`.
20. Public archive/export/import reproduction exposed an inherited period bug:
   a backward time-zone change can store a reversed closed interval, but restore
   replaced that valid stored evidence with invented eligible dates. Restore now
   preserves well-formed endpoints, reversed empty ranges, overlaps and multiple
   open ranges exactly; malformed input retains the existing lifetime fallback.
   Each imported period writes both endpoints atomically. Individual analytics
   count the union of clipped eligible ranges, fixing double-counted overlaps
   while retaining inclusive closed ends; stack ends remain exclusive.
21. Nine public regressions and independent review cover round-trip preservation,
   unsorted and overlapping ranges, empty/reversed ranges, fallback controls and
   outbox identities. Integrated validation passes 91 suites / 1,364 tests,
   global coverage 97.42/96.13/95.6/97.76 and all 60 core files at 100 percent;
   native gates remain 9 plugin / 107 Swift tests and diff hygiene is clean.
   Actual Hermes public round-trips preserve reversed `[Sep7, Sep6]` as zero
   eligible days, zero streak and null consistency, and preserve overlapping
   `[Sep5, Sep7]` plus `[Sep6, null]` as four eligible days, longest streak two
   and 50 percent consistency. Exact notes/date-time fields and individual/stack
   date eligibility survive; replay changes no table and ledger rows stay exact.
   Only fresh synthetic restore ids are remapped. Evidence:
   `.artifacts/t15b4/period-restore/`, including `qa/` runtime proof. Final
   25 boards / 63 checks / 80 actions and eight unchanged ledger rows preserve
   all prior B3 data exactly. Before/after shutdown backups match SHA256
   `44295aa67f66ffdbf88cb50a872ecab6b07dee2fa04fd049f01500655bc23cee`;
   console remains empty and all four fork QA simulators are shut down.
22. The final T15b4 slice validates and persists earning opt-in and integer caps
   1-10 for both board kinds. Defaults remain disabled/cap 1; omitted updates
   preserve stored values. A pure before/after policy planner emits ordered
   retired-root, surviving-root and own-setting observations on sparse affected
   dates. Configuration never creates a check or retroactive award. Exact period
   identities make same-date reopening agree with captured eligibility. Bulk
   evidence reads retain historical dependencies, validate canonical hashes and
   reject missing, unsafe or cross-scope evidence atomically.
23. Native earning controls preserve drafts through Options, kind changes,
   disabling, discard and failed Save/retry. Queued callbacks cannot change
   values during Save. iOS exposes native labels, values and numeric choices;
   Android uses a native TextField label and controlled dropdown. Actual B3 QA
   found singular deletion copy, now corrected for one check-in/note/reminder.
   Independent non-author reviews approve the planner, evidence reader,
   command integration and both platform controls. Shared planner fixtures,
   public SQL commands, adversarial evidence and pending-save tests pass.
24. Final integrated `bun run validate` passes 96 suites / 1,475 tests, global
   coverage 97.53/96.23/95.59/97.84 and all 63 core files at 100 percent.
   Native gates pass 9 plugin / 107 Swift tests; diff hygiene is clean.
   Evidence: `.artifacts/t15b4/validate-main.log`, `native-main.log`,
   `planner-independent-acceptance.md`, domain and controls acceptance reports.
25. Actual signed iOS verification creates Daily cap 3 and Count cap 4 through
   normal forms and reopens the saved values. A note-bearing app check earns
   with cap 3; off/on retains the cap and original award exactly. Adding an
   After/Waking up anchor records its policy without a retroactive bonus.
   Native Shortcuts Check earns with the saved Count cap 4. The singular Delete
   dialog reports one check-in and one note; Cancel preserves the full database.
   Light, dark and large-text cap rows pass visual inspection. All 25 baseline
   boards, 63 checks, 80 actions and eight ledger rows remain byte-exact.
   Final totals are 27 boards / 65 checks / 85 actions / 10 ledger rows,
   283 receipts and 271 outbox rows, with zero runtime-console entries. Backup
   SHA256 is `8f81f0108e3adbf78e03c29b8c5ebca00965586ed0b50a6c8a7c15f306887ae0`.
   Evidence: `.artifacts/t15b4/qa/`. The signed executable remains the verified
   B2 binary; both apps are terminated and all four owned QA simulators shut
   down. Android component/native-label review does not claim device TalkBack
   verification. T16 owns stack-bonus production integration; intermediate
   builds remain development-only until T19/T20 compatibility.

### T14 - stack screens and calendar refresh (2026-09-08)

1. The Boards header opens `/stacks`. A virtualized stack list shows the ordered
   active members, their exact-root-date checked/eligible state, optional labels,
   informational time, weekly completed days and current streak. Empty state
   explains anchors and opens the existing Create Board form.
2. `/stacks/[rootId]` uses the structural root identity independently of display
   order and shows the current run, 365-date history, longest streak and per-member
   weekly counts. Missing/non-root/all-archived routes have explicit recovery.
   An absent time hint remains distinct from configured midnight. An empty
   required set is unavailable, without suggesting zero-of-zero completion.
3. A shared presentation-only CalendarHeatmap preserves the board grid's measured
   weekday sizing and initial scroll adjustment. Stack cells distinguish none,
   some, most, all and unavailable through text alternatives and non-color cues.
   Count and Daily board adapters retain their existing semantics and scroll.
4. The stack-local snapshot hook reuses the existing query cancellation envelope
   and retains ready data during refresh. Captured deadlines drive cancellable
   local refresh; request/root guards reject late results and stale route data.
   An expired result gets one immediate reread, then a bounded 30-second recovery
   after repeated expiry. This does not publish widgets or reset history scroll.
5. Fourteen new routed/refresh cases cover empty creation, ordered list/detail,
   all history states, malformed/missing roots, midnight versus absent hints,
   optional checked-but-ineligible history, archived-root week rollover, route/
   time-zone late-result cancellation, unmount and bounded expiry recovery.
   Fourteen inherited heatmap/UI regressions pass after extraction.
6. Independent plan_review approved final source and focused tests. The first
   aggregate gate found a React refs-during-render lint error; request identity
   now installs and clears in the committed effect lifecycle, with the same
   generation protection and no lint suppression. The independent review also
   requested the two added optional-gap and repeated-expiry acceptance cases.
7. Final `bun run validate` exits 0: 75 suites / 988 tests, global coverage
   97.15/95.63/95.32/97.57, all 49 core files at 100 percent. Lint/typecheck and
   `git diff --check` pass. Unchanged native source passes 9 plugin / 74 Swift
   tests. Evidence: `.artifacts/t14/validate-final.log`, `native.log`,
   `green-lifecycle.log`, `lint-final.log` and `independent-acceptance.md`.
8. Non-author simulator acceptance passes on two dedicated devices. Fresh Empty
   QA verifies actual Home -> Stacks -> empty state -> Create/Cancel with zero
   boards, then anchored Daily creation, Save, detail and reopen with no invented
   history. The device is shut down with its one board and database preserved.
9. Migration QA adds six synthetic boards and 24 checks through fixed-id public
   commands. Actual cells show none 0/4, some 1/4, most 3/4 and all 4/4 on separate
   stored dates. Counts, midnight versus absent hint and weekly/current/longest
   streaks match. Archiving the structural root changes 3/4 to 3/3 and streak 1
   to 2; restoration returns both. Before-to-After editing reorders members while
   preserving the root URL, its 240-minute shift and exact dated history.
10. Light, dark and large-text visuals pass. A scrolled June 1 cell retains its
    exact frame across actual background/foreground refresh. Original Count
    detail still shows two live checks. Final Migration QA contains 16 boards,
    42 checks and 51 actions; every pre-T14 board/check/action is byte-equivalent
    at the row level. Scoped debugger logs have zero entries. Main QA returns to
    Home/light/normal text. Evidence is under `.artifacts/t14/qa/`.
11. T14 and Checkpoint B are complete: native screens and automated rules prove
    same-date stacks, independent adjacent dates, stable topology, informational
    times and date-based archived eligibility. T15 begins after full QA database
    backups and termination of our live development clients, preserving the
    separate earlier schema rehearsal. No T14 native or schema change was needed.

### T13 - stack analytics and consistent query snapshots (2026-09-08)

1. Pure stack analytics compute the current run, complete runs in the root's ISO
   week, current/longest consecutive streaks, exactly 365 stored-date heatmap cells
   and per-member weekly totals. Empty required sets are unavailable. Daily totals
   are binary by date; Count totals use live counts. Historical evaluation uses
   checked-date candidates, not every empty day since an old activity period.
2. Leaf `stack-queries.ts` exports compact list and detailed root snapshots through
   the existing read-transaction envelope. Captured now/zone are shared by every
   read and root horizon. Active members carry raw checked state and eligibility
   separately, and a nullable time-hint union distinguishes missing configuration
   from midnight. Archived structural roots retain their shift. Missing/non-root
   or all-archived detail is unavailable, without silently aliasing its identity.
3. Relevant components' periods and grouped counts use two scoped bulk reads with
   one parameterized JSON id array. Empty lists and missing details skip history.
   A 41-member query still makes four reads, and a 40,001-id parameter case avoids
   SQLite variable limits. Queries preserve recoverable database failures versus
   domain validation and make no product writes. UI refresh metadata includes the
   actual stack root shifts separately from unchanged widget/native deadlines.
4. The first 16 tests and independent review pass. A separate ordinal-day oracle
   matches 240 histories, 87,600 heatmap cells and 2,400 member-week comparisons.
   Tests include a real two-connection WAL snapshot, transaction-queued clock,
   exact component scope, unavailable-but-checked history, Daily duplicates,
   multiple root shifts, query recovery and absent-versus-midnight hints.
5. Actual signed Migration QA confirms SQLite 3.50.3 and `json_each(?)` with 1,600
   synthetic ids bound as one string. This was a read-only capability probe using
   the already-ready database: no habit data, startup, commands or app/device
   changes. Scoped debugger logs are empty. Evidence:
   `.artifacts/t13/qa/sqlite-json-proof.md` and `sqlite-json-proof.json`.
6. Initial full validation passed: 73 suites / 969 tests, all 49 core files at
   100 percent, native 9 plugin / 74 Swift tests. Before commit, the author found
   an inherited early-year arithmetic defect: valid years 0000 through 0099 are
   remapped by Date.UTC, corrupting historical streaks. Independent review also
   reproduced an invalid UTC offset through an accepted AD-year-1 timed input.
   Five public-path/calendar regressions reproduced these failures before the fix.
7. One private UTC constructor now uses full-year setters in both day arithmetic
   and offset calculation. It preserves the existing accepted date range and Intl
   formatting. Import -> anchor -> stack-detail cases for early AD years now retain
   consecutive streaks, and a public timed check retains offset zero in UTC.
   Independent integer-Gregorian verification passes 24,846 arithmetic pairs,
   5,116 weekday dates and 15 offset comparisons, including leap year zero and
   year 99 to 100. The existing analytics oracle also stays green.
8. Final non-author data_contract_review approval covers source, tests, scoped SQL,
   native JSON capability and the calendar correction. Final `bun run validate`
   exits 0: 73 suites / 974 tests, global coverage 97.15/95.64/95.45/97.60, all
   49 core files at 100 percent. Lint/typecheck pass. The unchanged native gate
   passes 9 plugin and 74 Swift tests. T13 is complete. Evidence:
   `.artifacts/t13/validate-final.log`, `native.log`, `red-early-year.log`,
   `early-year.log` and `independent-acceptance.md`. Screen acceptance follows in T14.

### T12 - same-day stack derivation (2026-09-08)

1. T12a adds pure `deriveStacks` with stable structural roots and root shifts,
   before/after ordering, same-parent/same-relation sibling precedence, binary
   home-order/id tie breaking and deterministic component ordering. Iterative
   root caching, sparse adjacent sibling edges and a local ready-node heap avoid
   recursive depth limits and repeated sorting of wide ready sets.
2. Archived undeleted members preserve links, identity and full ordering before
   active display filtering. Structural required flags remain separate from date
   eligibility. Preset/text singletons are stacks; isolated unanchored boards are
   excluded and equal preset/text values do not join unrelated roots. Invalid
   flat anchors, missing/deleted targets, duplicate ids and cycles fail explicitly.
3. The informational hint uses the first active displayed member's own usual time,
   then its own directly attached After-preset time, otherwise zero. Explicit
   midnight takes precedence. The spec now spells out this rule and the sibling
   precedence that ready-node priority alone cannot guarantee. T13/T14 must preserve
   hint presence for display rather than treat every zero as configured midnight.
4. Tests began with a missing-module failure, then 45 focused cases passed. They
   include mirrored sibling counterexamples, root/display separation, archived
   interiors, immutable input, invalid scalar/anchor shapes, 3,000-node deep/wide
   cases and 80 seeded branching forests. Missing required/time fields received a
   separate failing/passing correction because command-input omission defaults
   must not silently validate malformed hydrated topology data.
5. `bun run validate` exits 0: 69 suites / 930 tests, global coverage
   97.08/95.54/95.30/97.55, all 45 core files at 100 percent across every metric.
   Lint/typecheck pass. Native checks pass: 9 plugin tests and 74 Swift tests.
   Evidence is under `.artifacts/t12/`, including `red-topology.log`,
   `validate.log` and `native.log`. This slice has no visible UI or native change;
   simulator screen acceptance belongs to T14.
6. Non-author data_contract_review approved the frozen source, tests and spec.
   A separate dense-constraint oracle matched production for 500 forests and
   1,000 shuffled/frozen-input calls. An initial oracle setup used invalid inherited
   day shifts; its corrected 30-minute shifts through noon pass. Root reviewed the
   public contract and aggregate evidence. The independent acceptance record is
   `.artifacts/t12/independent-topology-acceptance.md`.
7. T12a was committed separately while the archive-date requirement conflict
   awaited Rami's answer. Rami then approved removing the habit from that stored
   date's stack requirements, with same-day restore requiring it again. The spec
   and plan now record the resolved rule; no product decision remains pending.
8. T12b adds `stack-runs.ts` with `assignRuns` and the reusable
   `isStackDateEligible`: start <= date < closed end, date <= root today, and an
   open end has no period upper bound. Required ids are sorted once from full
   structural membership. Only positive live counts at the exact stored board/date
   count, once per member. Optional-only, missing-period and future dates cannot
   complete a run. The inherited inclusive period helper and archive/restore
   persistence commands remain unchanged.
9. Twenty-three new cases include 13 reusable calendar vectors and four real-SQL
   public-command cases. They prove durable archive exclusion, actual same-day
   period reopening, member/root shift differences, opposite wall-date instants
   with matching stored dates, and retained Count-to-Daily duplicates. Eight-table
   before/after snapshots show derivation has no writes. Calendar vectors cover
   midnight, shifted days, DST gap/fold/recross, time zones and leap days.
10. Non-author data_contract_review approved the final source/tests/spec and an
    independent numeric-day-set oracle passing 400 cases / 3,200 run dates. Final
    `bun run validate` exits 0: 71 suites / 953 tests, global coverage
    97.09/95.56/95.33/97.55, all 46 core files at 100 percent. Native checks pass:
    9 plugin tests and 74 Swift tests. Lint/typecheck and diff checks pass. Evidence:
    `.artifacts/t12/validate-runs.log`, `native-runs.log`, `domain-runs.log`, and
    `independent-runs-acceptance.md`.
11. T12 is complete. T13/T14 preparation records compact query snapshots, the
    surfaced heatmap/weekly-count interpretations now in the spec, and refresh at
    archived structural roots' day boundaries without changing widget timing.

### T11 - anchor selection and optional habit timing (2026-09-08)

1. The board form now has an Anchor sheet with habits in home order, archived
   labels, self exclusion, the four current preset times, text and Before/After.
   Selection markers and a sentence summary show the chosen relation. The sheet
   keeps its draft until Done; the board's Save remains the persistence boundary.
   Domain validation rejects cycles and deleted targets without substituting a link.
2. Usual Time reuses the quarter-hour wheel moved from Settings into the anchors
   feature. Its local draft has Use time, Cancel and Clear, so an unchanged centered
   midnight can be explicitly accepted without dirtying the form on open. A native
   Required in stack toggle works for both kinds. Draft hydration/save preserves
   null, false, nested Options navigation and the existing outer discard guard.
3. `getAnchorPickerOptions` reads undeleted choices and saved preset minutes from
   one read transaction. Three real-SQL tests cover ordering, archived/deleted data,
   missing settings, no writes and a two-connection WAL snapshot during concurrent
   preset/archive commands. It does not invent defaults on read failure. The sheet
   and saved-target summary expose recovery; confirmed selection refreshes the label.
4. Query author plan_review and UI author simulator_readiness received independent
   review from data_contract_review; plan_review also reviewed final UI and root
   reviewed integration. Ten new routed cases and inherited Settings/kind tests
   cover all target kinds/directions, text bounds, cycles, save/reopen, time clearing,
   false membership, draft cancellation and query recovery. Midnight acceptance
   and summary-retry corrections have recorded failing/passing tests.
5. Native larger-text QA reproduced an inherited Tinted Background switch clipping
   beyond its row and a new Required switch failing to use the row width. A flexible
   label and vertical-only native Host measurement fix both. Settled cold-launch
   screenshots verify wrapping and visible controls. No style-mirroring tests or
   native source changes were introduced; relevant existing feature tests still pass.
6. Final post-layout `bun run validate`: exit 0, 68 suites / 885 tests, global
   coverage 96.99/95.42/95.22/97.48, all 44 core files at 100 percent across all
   metrics. Native gate: 9 plugin checks and 74 Swift tests pass. Lint/typecheck pass.
   Logs: `.artifacts/t11/validate.log`, `native.log`, `ui-layout.log` and
   `typecheck-layout.log`.
7. Independent native QA passed on signed Migration QA with Metro 8082: preset
   After, archived-habit Before and text Before save/reopen, midnight/false
   persistence, keyboard access, local cancellation, explicit clear and outer
   discard. A final cold reopen confirms null anchor/time and Required off. All
   existing board rows, 18 checks and 27 actions remain exact, including the original
   Count board and its three stored checks/two live checks. Root also visually
   reviewed the final cold normal/large captures. Evidence and exact device scope:
   `.artifacts/t11/qa/qa-proof.md`, `verification.json`, `final-cold-reopen.png`
   and `required-large-cold-after.png`; `verify.py` reproduces the data assertions.
   The scoped connected console reports zero entries. Intermediate premature
   snapshots and stale HMR measurements remain labeled as superseded evidence.
8. T11 is complete. T12's separate archive-date conflict is recorded in spec
   section 10, item 6, and awaits Rami's answer. Independent topology/date-grouping
   preparation proceeds; no unapproved eligibility rule is silently implemented.

### T10 - validated habit anchors and transactional link cleanup (2026-09-08)

1. Create/update accepts a discriminated anchor, optional usual time and required
   membership. Normalization writes the five consistent stored anchor columns;
   omitted update inputs retain their values and explicit null clears only the
   anchor. Text uses trimmed Unicode code-point limits; times use quarter-hours;
   false membership persists. The spec now names all five columns and direct-link
   cleanup explicitly. No migration, native schema or serialization change occurred.
2. Both creation paths validate the complete undeleted graph inside the command
   transaction before allocating ids, stamps or rows. Archived targets remain
   valid; self-links, cycles and missing/deleted targets fail. The shared reminder
   creation path propagates validation errors before scheduling, including a target
   deleted while permission is pending. Receipt replay precedes retry validation.
   Updates validate the effective edge before legacy Count-to-Daily evidence writes.
3. Deletion captures direct undeleted dependents, including archived boards, clears
   their anchor columns with one batch stamp and matching outbox rows, and rebuilds
   the widget projection once. Their history, usual time, required flag and indirect
   links remain. Both active-edit and archived-detail confirmations describe the
   affected count and retained history, with honest query-failure wording.
4. Core author plan_review and UI author simulator_readiness received independent
   source/test/spec review from data_contract_review, with additional root review.
   The reviewer found a defensive deleted-node gap in the pure graph helper;
   a failing test preceded the guard and re-review approved it. Domain tests cover
   queued reciprocal edits, malformed chains, replay, unchanged legacy history,
   and real-SQL rollback/retry at dependent update, outbox and receipt boundaries.
   Seven new routed cases cover both confirmations, zero/singular/plural, Cancel
   and retained history. Final review has no unresolved source finding.
5. Full `bun run validate`: exit 0, 66 suites / 872 tests, global coverage
   96.99/95.52/95.28/97.47, all 44 core files at 100 percent on all metrics.
   Native gate: 9 plugin checks and 74 Swift tests pass. Lint/typecheck pass.
   Logs: `.artifacts/t10/validate.log`, `native.log`, `domain-coverage.log`,
   `ui.log`; independent disposition: `independent-acceptance.md`.
6. Simulator acceptance passed on the development-signed Migration QA app with
   Metro 8082. Six synthetic Count boards and four note histories were created
   through normal commands. Cancel preserved all six captured tables exactly.
   Confirming active and archived deletions tombstoned both roots and cleared only
   three direct links, with exactly five matching board outbox rows. All 18 check
   rows and action evidence remained; the indirect board and original Count's
   complete board/three stored checks, including two live checks, remained exact.
   data_contract_review independently approved these comparisons plus light/plural
   and dark/singular native dialogs. Evidence: `.artifacts/t10/qa/qa-proof.md`,
   `active-committed.json`, `final-committed.json` and `verification.json`.
7. The settled connected runtime capture contains zero entries. Intermediate
   evidence retains an animation-time missed tap and a debugger async transport
   response issue; neither is claimed as success or a product defect. Fixed command
   ids and stored receipt replay prevented duplicate setup. No source correction,
   user device, Metro 8081 or iCloud operation was needed. T10 is complete.

### T9 - editable informational anchor times (2026-09-08)

1. Added the shared `setAnchorPresetMinute` command with runtime preset and
   quarter-hour validation, transactional current-settings reads, idempotent
   receipts, and one matching settings stamp/outbox mutation. Unchanged values
   retain their stamp and outbox. Migration 6 defaults remain 420/720/1080/1380;
   outgoing serialization remains T19 work. No schema or native changes occurred.
2. Settings > Anchors shows four stored times and an explicit Save/Cancel editor.
   A labeled native SwiftUI wheel supplies exactly 96 choices, 00:00 through 23:45.
   The installed SDK 57 DateTimePicker has no quarter-hour interval API, so the
   existing native Picker is used. Times remain informational reference points.
   Pending writes lock controls synchronously; load/save failures allow retry.
   Reopening the active row preserves its unsaved draft.
3. Tests preceded implementation: 28 command cases cover validation, all presets,
   boundaries, replay, concurrent different-field edits and real transaction
   rollback at settings/outbox/receipt boundaries. Seven routed feature cases
   cover editing, Cancel, duplicates, failures and draft preservation. Core author
   plan_review and UI author simulator_readiness received non-author review:
   root and data_contract_review approved core; plan_review approved final UI.
4. Final `bun run validate`: exit 0, 63 suites / 812 tests, global coverage
   96.93/95.38/95.25/97.42, all 43 core files at 100 percent across all metrics.
   `bun run test:native`: 9 plugin checks and 74 Swift tests pass. Typecheck,
   lint and diff whitespace checks pass. Logs: `.artifacts/t9/validate.log`
   and `.artifacts/t9/native.log`.
5. Independent real simulator QA passed on Migration QA / iOS 26.5 using the
   development-signed T7b native app with current Metro 8082 JavaScript. The wheel
   exposes its label and quarter-hour choices; Save changed only wake to 435,
   reopening and cold launch retained 07:15, and Cancel preserved settings and
   stamp byte-for-byte. Light/dark and accessibility-extra-large layouts were
   visually reviewed. Every board, check, action, reminder and activity-period
   row remained identical, including the original two-check Count fixture.
6. Evidence: `.artifacts/t9/qa/qa-proof.md`, `persistence-proof.json`,
   `original-count-unchanged.json` and the named screenshots. The final connected
   debugger capture has zero entries; the earlier restart/reset notice is retained,
   so this is a bounded final-capture claim. No user device, iCloud session or
   Metro 8081 was touched. T9 is complete; T10 proceeds with anchor validation.

### T8 - native Daily verification and actual Shortcuts execution (2026-09-08)

1. Read-only audit confirms the three-action inventory, schema-7/checksum gate,
   atomic check/action/receipt/HLC/outbox writes, Daily no-op behavior, guarded removal,
   and fresh widget publication. T7b closed the explicit removal-date validation mismatch.
2. A focused regression captures a note-bearing Daily removal at 03:59 before its 04:00
   boundary, then creates the new-day check through another real SQLite connection.
   Confirming the captured date removes only the prior check and records the proper
   whole-date clear. The new row/action remain exact; Today reports one. Next-day replay
   from the second connection leaves checks, actions, settings, outbox, receipts, and
   cache unchanged. Existing production passes without modification. Independent review
   approves this native-only test and its distinction from real Shortcuts execution.
3. Local gates: `bun run validate` exit 0, 61 suites and 777 tests, global coverage
   97.01/95.26/95.48/97.5, all 42 core files at 100 percent on all four metrics. Native:
   9 plugin and 74 Swift tests pass with no failures/compiler warnings. Evidence:
   `.artifacts/t8/validate.log`, `native.log`, and `native-shifted-confirmation.log`.
4. Actual Shortcuts on Migration QA discovers exactly the three Habit System actions and
   resolves all synthetic boards in its picker. A composed Daily Check In / Check In /
   Today shortcut was prepared and run using the final T7b binary. Two bounded iOS 26.5
   attempts report `LNContextErrorDomain` 2004 / `LNPerformActionErrorCodeUnsupportedValueType`
   without creating a check. Trace also reports that linkd cannot obtain the process team id;
   the baseline simulator executable has an ad hoc signature and no TeamIdentifier.
5. A new isolated iPhone 17 Pro / iOS 27.0 simulator, `Habit System Shortcuts QA 27`,
   udid `408FBC15-1A3F-4A0C-945F-04AE63759C66`, opened the same build and a synthetic
   Daily board. Its Shortcuts catalog was empty even for stock actions, so it supplied
   no meaningful invocation comparison. Its isolated data and evidence are retained.
6. A development-signed copy resolved real Shortcuts execution on the original iOS 26.5
   device. The same composed Daily shortcut creates one `shortcut` row, returns the same
   check id with `created:false` for the second command, and reports correct Today totals.
   Scoped native trace shows both intent types invoking/finishing without the prior team-id
   or unsupported-value errors. A note-bearing Daily removal warns about saved notes;
   Cancel preserves the full row and Confirm tombstones exactly that row. After converting
   only that fixture to Count, the same composed shortcut creates two distinct checks,
   Today reports two, and Remove Latest deletes only the newer one while retaining the older.
7. Xcode's simulator signing context rejected the attempted development-signing override.
   The successful isolated experiment instead signs the copied artifact inside-out with
   Apple's codesign tool and the existing Apple Development identity. All twenty code targets
   report team `3V2UU7RRK9`; deep/strict verification passes. Info.plist, compiled intent
   metadata, executable text, and embedded entitlements remain unchanged. The recipe and
   evidence live in `.artifacts/t8/simulator-signing.md` and `signed-sim-build/`.
   AGENTS.md records the working workflow. This is simulator invocation evidence, not
   physical-device provisioning or signed CloudKit acceptance.
8. Actual invocation artifacts are retained under `.artifacts/t8/qa/`, including the three
   action catalog, entity picker, composed shortcut, unsigned failure traces, signed result
   dialogs, and database/receipt snapshots. The original Count board's complete rows match
   the T7 final snapshot byte-for-byte. Final synthetic state is original Count 2, QA T4
   Daily 1, and the separate notes fixture Count 1. The unused new iOS 27 simulator is
   shut down with its data retained. Checkpoint A is complete; serialization and actual
   multi-device CloudKit acceptance remain the later T19/T20 gates.

### T7 - fresh widget fallback and shared Daily receipts (2026-09-08)

1. T7a adds binary Daily widget rows and checked state, with Count intensity preserved.
   Daily links open a dedicated explicit Check/Uncheck screen. Opening, remounting, or
   redelivering the route writes nothing. The screen resolves current board kind/date/state,
   confirms note-bearing removals against captured ids/stamps, and retains widget provenance.
   Creation Undo owns the exact check and command; stale state refreshes before another action.
2. A derived-only transaction captures clock/zone once, rebuilds active widget rows, and
   returns matching generation/expiry metadata. TS and Swift share twelve calendar vectors
   and four props vectors, including shifted days, spring gaps, and repeated-hour rollback.
   Cache refresh does not mutate checks, actions, HLC settings, receipts, or outbox evidence.
   Failures roll back the cache. Expiry is conservative and is not an economic day-close rule.
3. The provider publishes the prepared snapshot and arms its timer from the same expiry.
   Generation/cleanup guards reject late results; an independent review finding added a
   bounded 30-second retry after transient cache failure. Donated Daily events reuse the
   explicit route. Count retains Add Check-In; new links carry widget source and resolve
   current kind. Old unmarked Count links cannot be distinguished from ordinary app links.
4. Tests exercise the installed Expo widget compiler and serialized runtime, route races,
   delayed note confirmation across midnight, unmount cancellation, provider recovery,
   stale generations, and exact publication deadlines. Independent non-author reviews of
   the core, native implementation, UI, provider, adapters, and tests are approved.
5. T7a gates: `bun run validate` exit 0, 60 suites and 772 tests, global coverage
   97.01/95.26/95.48/97.5, all 42 core files at 100 percent on all four metrics. Native:
   9 plugin and 71 Swift tests pass without compiler warnings. A test import-order cleanup
   then passed its focused suite. The fork-only Watchman watch was reset; the final full
   validation has no recrawl warning. Lint, typecheck, and diff hygiene are clean.
6. The simulator native build succeeded at `.artifacts/t7/qa-build/habitsystem.app`.
   The inherited Expo Dev Launcher script-phase warning remains; no generated Xcode file
   was edited. The current widget JSX is registered by the final Metro runtime at launch.
   Actual medium-widget light/dark captures show binary checked/unchecked Daily states,
   correct accessibility actions, and retained Count intensity. Real widget opening and
   repeated delivery preserve state. Uncheck, Check with widget source, exact Undo,
   current-kind recovery, note cancellation, and confirmed note removal pass. The initial
   post-confirm read preceded the async commit; the settled read proves the exact removal.
   The original Count board's complete historical rows remain byte-for-byte unchanged,
   including its two original live checks. Final scoped runtime logs contain zero entries.
   Evidence is retained under `.artifacts/t7/qa/`.
7. Existing T3 Daily intent semantics are retained. T8 owns actual Shortcuts invocation
   and the remaining native-specific audit.
   The SDK uses one timeline per widget kind, so an offscreen active board may conservatively
   expire a smaller family early; the opened action always resolves authoritative state.
8. T7a was committed and pushed as `bde78df`. Its detailed device proof is
   `.artifacts/t7/qa/qa-proof.md`; named images include `widget-light.png`,
   `widget-dark.png`, `daily-open-dark.png`, and `notes-confirmation.png`.
   The empty final debugger registry is bounded capture evidence, not a claim that
   every earlier interaction was logged. The original Count fallback was verified
   using the separate converted notes fixture, leaving the baseline Count rows intact.
9. T7b preserves the thirteen inherited fixture cases and adds four scenarios with
   twenty-six ordered steps. Both executors compare complete successful returned values
   and stored receipts against literal fixture UUIDs. Strict per-step UUID queues reject
   unexpected allocation. No-op/replay checks preserve complete checks, actions, settings,
   boards, and outbox snapshots; Today preserves receipts and returns only names/counts.
   Coverage includes retained multi-check Daily history, ordered group removal, Count
   single removal, explicit past dates, and changed-input replay after midnight.
10. Native red tests reproduced malformed/future removal dates returning `not_found`.
    Both the real removal candidate path and command now validate before selecting rows.
    Command receipt replay still precedes validation of new input. Full successful receipts
    match across runtimes; inherited failure cases compare codes, while localized error
    messages remain platform-specific. No schema or action inventory changed.
11. T7b final gates: `bun run validate` exit 0, 61 suites and 777 tests, global coverage
    97.01/95.26/95.48/97.5, all 42 core files at 100 percent on all four metrics. Native:
    9 plugin and 73 Swift tests pass with zero failures/compiler warnings. Independent
    non-author reviews approve both consumers, fixture semantics, and the native fix.
    The simulator build succeeds at `.artifacts/t7b/qa-build/habitsystem.app` and retains
    the inherited build-script warning. Lint, typecheck, and diff hygiene are clean.
12. T7b evidence is under `.artifacts/t7b/`: `validate.log`, `native.log`,
    `red-canonical-native.log`, `red-ts-scenarios.log`, `green-ts-scenarios.log`,
    and `qa-native-build.log`. T8 has discovered the three real Shortcuts actions and
    prepared a composed Daily check/check/Today shortcut; execution is recorded separately.

### T6 - binary Daily heatmaps and aligned accessible sizing (2026-09-08)

1. Detail passes explicit board kind into the heatmap. Eligible Daily cells use a binary
   fill/checkmark and date plus checked/not-checked accessibility labels. Eligible Count
   cells retain intensity and dot/ring markers. Future and unavailable labels remain distinct.
2. Routed tests first reproduced retained checks incorrectly lighting archived gaps for both
   kinds. Availability now takes rendering precedence while raw counts, notes, amounts,
   times, and activity periods remain unchanged. Count-to-Daily conversion and boundary
   tests prove binary rendering does not rewrite the underlying history.
3. Simulator inspection reproduced an inherited large-text defect: weekday labels grew
   beyond the fixed grid and aligned with incorrect dates. Shared row/cell sizing now
   follows natural native text measurement and the current font scale; markers scale too.
   Returning to normal text shrinks correctly. Initial scrolling waits for matching grid
   dimensions, ignores queued old-size events, then preserves position on later updates.
4. Six new tests cover routed gaps/conversion, future/padding/today, scroll stability,
   measured growth/reset, and event ordering. Red/green evidence is retained. Independent
   review approved initial rendering and the measured sizing/scroll corrections.
5. Final gates: `bun run validate` exit 0, 55 suites and 692 tests, global coverage
   97.46/95.81/95.6/97.55, all 40 core files at 100 percent on all four metrics. Native:
   9 plugin and 64 Swift tests pass. Lint, typecheck, and diff hygiene are clean.
6. Independent simulator QA verifies checked/unchecked Daily cells in light/dark appearance,
   all seven enlarged weekday rows aligned, readable glyphs, normal-size restoration,
   and a cold launch opening the latest week. The original Count board still shows two
   checks; both complete historical rows remain byte-for-byte unchanged. No QA data was
   mutated in this task. Settled final navigation logs contain zero entries.
7. Evidence under `.artifacts/t6/`: `qa-proof.md`, `validate.log`, `native.log`,
   `large-text-axis-before.png`, `large-text-axis-after.png`,
   `daily-checked-light-final.png`, `daily-checked-dark.png`,
   `daily-unchecked-dark.png`, and `count-light-final.png`.
8. T7 preparation identified stale cached widget dates, fixed-24-hour DST expiry, and
   missed shifted-day refreshes. T7 acceptance now records fresh projections and matching
   TS/native deadlines. The explicit widget fallback action avoids mutation on repeated
   route opening. Shortcuts is installed on QA; its actual execution remains T8 evidence.

### T5 - Daily Home cards and guarded toggles (2026-09-08)

1. Daily cards show fourteen binary cells, an ISO-week completion count, optional current
   streak, and a checked/unchecked native accessibility state. Count cards retain their
   numeric strip and quick check-in behavior. Daily previews reuse the focused strip.
   The strip reflects stored history; week/streak summaries apply inherited activity-period
   eligibility. A single grouped query handles distinct dates and streaks beyond the strip.
2. A transactional read captures the selected date, all check ids/stamps, and note counts.
   Home compares fresh date/state with the displayed card before acting. A synchronous
   per-board guard covers that read, confirmation, and mutation. The command verifies the
   captured records atomically; a prompt crossing midnight still targets its original date.
3. Note-bearing unchecks confirm affected date/check/note counts. Cancellation writes nothing.
   Undo is offered only for a newly created check, retains its exact id and creating command,
   and has a synchronous duplicate-press guard. An uncertain committed result followed by
   another press refreshes stale state without toggling the completion back off.
4. Eleven domain tests cover binary projection, ISO/year boundaries, shifted dates, long
   streaks, archive gaps, metrics, grouped reads, and confirmation snapshots. Seven feature
   tests and eight independently authored race tests cover the visible flows, competing
   actions, midnight, storage failure/retry, stale projections, and exact Undo ownership.
5. Final gates: `bun run validate` exit 0, 54 suites and 686 tests, global coverage
   97.47/95.93/95.58/97.53, all 40 core files at 100 percent on all four metrics. Native:
   9 plugin and 64 Swift tests pass. Lint, typecheck, and diff hygiene are clean. Coordinating
   review approved core; independent non-author review approved UI and both feature suites.
6. Simulator QA proves Daily check/uncheck/Undo, two-note cancellation and atomic removal,
   exact checkbox labels/states, and readable wrapping at accessibility-extra-large text.
   Count quick check plus Undo preserves both original complete records byte-for-byte.
   Light/dark captures are settled and final scoped logs contain zero entries.
7. Evidence in `.artifacts/t5/`: `validate.log`, `native.log`, `qa-proof.md`,
   `home-light-final.png`, `home-dark-baseline.png`,
   `home-light-accessibility-extra-large.png`, `home-light-checked-undo.png`,
   `notes-confirmation-dark.png`, and `final-log-registry.json`. QA data is synthetic and
   remains on the dedicated Migration QA simulator. T6 owns the Daily detail heatmap and
   its inherited unavailable-date rendering correction.

### T4 - Daily and Count board forms (2026-09-08)

1. New forms default to Daily; edit forms retain the stored kind. Daily hides amount,
   unit, quick-amount, and time controls. Switching kinds before saving retains unsaved
   Count settings. Hidden invalid values cannot block a Daily save. Preview reflects kind.
2. The iOS form uses the installed SDK 57 SwiftUI picker with its native Kind label.
   Simulator accessibility reports "Kind, Daily". The generic picker remains compatible
   with other platform exports; iOS is the product acceptance platform for this task.
3. Four routed feature tests cover defaults, both saved kinds, conversion with preserved
   history, and reversible draft changes through Options. Existing amount/time tests now
   explicitly select Count. A prior receipt test now uses a note beyond the actual
   10,000-character limit, so it proves replay precedes invalid retry input validation.
4. Final gates: `bun run validate` exit 0, 51 suites and 660 tests, global coverage
   97.59/95.8/95.61/97.67, all 40 core files at 100 percent on all four metrics. Native:
   9 plugin and 64 Swift tests pass. Lint, typecheck, and diff hygiene are clean.
   Independent source/test review approved; its mock import warning was corrected.
5. Simulator QA independently created and reopened a Daily board, verified hidden controls,
   converted the original two-check Count board to Daily and back, and compared both
   complete historical records byte-for-byte after each save. Conversion created the two
   deterministic baseline actions. Light/dark forms and native picker menu are clean.
6. Evidence under `.artifacts/t4/`: `validate.log`, `native.log`, `daily-form-light.png`,
   `daily-form-dark.png`, `daily-options-light.png`, `kind-menu-dark.png`,
   `converted-history-dark.png`, `cold-history-dark.png`, and `final-db.jsonl`.
   Three transient native animation cleanup warnings did not recur on a cold repeat;
   `cold-history-log.json` contains zero entries. Logs were not suppressed. Resetting only
   this fork's Watchman watch cleared a stale recrawl warning; the focused form suite then
   passed without it. Ripples Metro and user devices remained untouched.

### T3 - immutable action evidence and atomic Daily commands (2026-09-08)

1. Migration 7 adds immutable `habit_actions`, scope indexing, and guards against update,
   delete, and replacement. Checksum `a901fb95` matches the Swift schema gate. Earlier
   migrations remain unchanged. Actions remain pending in the outbox until T19, without
   blocking supported uploads. No complete sync or export compatibility is claimed yet.
2. Shared TypeScript/Swift fixtures prove deterministic UUIDv5 baselines and scoped replay.
   Baselines use only check id, board id, and logical date, with fixed synthetic metadata.
   Whole-date Daily unchecks clear earlier completions; targeted history removal, Undo,
   and move-out affect only their check. Active concurrent/converted history retains its
   notes, amounts, and times while Daily projections expose one effective completion.
3. Daily commands force tracking off, check idempotently, toggle inside one transaction,
   remove all retained checks when unchecking a date, and reject occupied-date moves.
   Conversion and legacy import establish non-earning baselines. Every relevant writer
   records action evidence atomically. Confirmation guards reject changed check sets,
   notes/stamps, or native board kind. Legacy receipts decode without rewriting storage;
   acknowledged actions replay even after archive and cannot authorize another check's Undo.
4. Red/green evidence includes action identity/storage, Daily commands, confirmation races,
   archived automation replay, and shared TS/Swift behavior. Storage-failure tests preserve
   checks, notes, actions, settings/HLC, receipts, widget rows, and outbox together. Real
   separate SQLite connections prove simultaneous native checks create one completion.
5. Final gates: `bun run validate` exit 0, 50 suites and 656 tests, global coverage
   97.62/95.77/95.71/97.7, all 40 core files at 100 percent on all four metrics. Native gate:
   9 plugin and 64 Swift tests pass. Simulator build succeeds with the correct fork bundle.
   An observed feature import cycle and unused native C-return warnings were fixed.
6. Independent review: coordinating agent reviewed TS/native commands, schema, helpers,
   and secondary changes; data-contract reviewer approved foundations and final commands;
   TS author independently reviewed the coordinator's rollback/retry tests. All findings
   were resolved before the final gates. `git diff --check` is clean.
7. Migration QA `DF054717-410A-4F91-996B-2BCBC29296B1` ran committed T2 JavaScript/native
   code, then upgraded in place with two UI-created Count checks. Complete board/check
   rows match the schema-6 backup byte-for-byte after schema 7. Final detail shows two
   checks and no development banner; both scoped cold-log captures contain zero entries.
   Evidence: `.artifacts/t3/migration-proof.md`, `schema7-detail.png`, `schema7-detail.json`,
   `cold-log-final.json`, `validate.log`, `native.log`, and `qa-native-build.log`.
8. The first synthetic QA device had loaded an uncommitted migration through Metro; its
   database was preserved rather than rewriting its checksum. The clean rehearsal used a
   separate simulator and committed T2 checkout on temporary port 8083, now stopped.
   Port 8081 and user devices/data remained untouched. T4 provides the Daily/Count form;
   widget interaction and remaining native device flows still belong to T7/T8.

### T2 - schema 6 and habit field persistence (2026-09-08)

1. Migration 6 adds the ten board fields, four preset minutes, and widget kind, with Count
   compatibility defaults and scalar constraints. Versions 1 through 5 are unchanged.
   Checksum `0191110b` and the Swift schema gate landed together. Future tables remain in
   their planned migrations. Existing command/import/reference paths retain Count semantics.
2. Board and settings repositories round-trip the new fields. Ordinary edits retain them.
   TypeScript and Swift widget rebuilds/timelines preserve kind. The new form and Daily
   command semantics are later tasks; no new product UI is exposed by this task.
3. Red evidence covers missing migration fields, persistence, widget props, and Swift kind
   loss. The populated v5 fixture preserves active/archived/deleted boards, repeated checks,
   notes/amounts/times, settings/HLC, receipts, outbox, sync cursors/deferred data, and account
   binding. Tests cover versions 1 through 5, fresh/repeated migration, rollback, fractional
   scalar rejection, nullable fields, both boolean updates, and deferred-table absence.
4. Final automated gates: `bun run validate` exit 0, 47 suites and 604 tests, global coverage
   97.5/95.51/95.58/97.6 and every one of 33 core files at 100 percent on all four metrics.
   `bun run test:native` exit 0, 9 plugin checks and 52 Swift tests. `git diff --check` clean.
5. Independent review: coordinating agent reviewed production persistence/migration changes
   and tests; plan-review agent approved native changes; data-contract agent approved the
   migration preservation fixture and performed independent simulator verification.
6. Simulator proof: a synthetic Count board and two checks were created through the UI under
   schema 5 on dedicated QA simulator `62014A57-2B4A-4083-8A4D-452D4E5F764B`. After migration
   and an in-place native simulator rebuild/install, original board/check ids and timestamps
   remained byte-for-byte equal, schema was 6, and the detail screen still showed two checks.
   Evidence and red/green logs are in `.artifacts/t2/` (ignored). Port 8081 and user data on
   other simulators were untouched. The supported SDK 57 build flags are recorded in AGENTS.md.
7. Settled cold-launch evidence: `schema6-detail.png`, `schema6-detail.json`,
   `cold-runtime-final.json`, and `qa-native-build.log` in that directory. A transient Fast
   Refresh warning is preserved separately and did not recur on the cold launch, whose
   captured console was empty. The independent simulator verifier approved this checkpoint.

### Approved pre-T2 amendments and continuation (2026-09-08)

1. Rami clarified: "Stacks are only within the day" and rejected stacks across back-to-back
   days. Stack membership now uses exact saved logical dates; usual times never reassign dates.
   The earlier overnight run and wake-after-bed recommendation is superseded.
2. Rami answered yes to the review recommendations and instructed updating the spec files,
   incorporating the review fixes, pushing them, and continuing the entire plan without stopping.
   Bonus restoration and offline latest-action resolution with append-only ledger corrections
   are approved. Routine implementation and verification choices remain delegated.
3. The revised spec and plan split migrations by feature, preserve count history, require coin
   controls and all TS/Swift mutation paths, correct sync version compatibility, specify the
   widget toggle destination, and require complete sample adapter/navigation isolation.
   Intermediate builds are development checkpoints until native and serialization gates pass.
4. Date-based activity eligibility uses the inherited periods; no precise intraday history is
   invented. The structural root identifies a stack independently of its display order.
   An empty set of eligible required members never earns a bonus.
5. The settlement contract is recorded in `docs/ledger-reconciliation.md`: immutable action
   evidence, deterministic generated ids, bounded correction proofs, and cancellation of
   obsolete corrections. Date/time edits never mint new rewards; live rechecks can restore
   eligible bonuses. Baseline actions and generated ledger rows use UUIDv5, live commands use
   UUIDv4. Migrations 6 through 10 are staged at T2, T3, T15, T18, and T21 respectively.
6. Validation before the documentation commit: `bun run validate` and `bun run test:native`
   both exit 0 (570 Jest, 51 Swift, 9 plugin checks). Logs are under `.artifacts/readiness/`.
   The coordinating agent reviewed task amendments and the protocol; the data-contract
   reviewer independently checked spec amendments, and corrections were incorporated.
   Product implementation remains unchanged in this documentation commit.

### Pre-T2 plan review (2026-09-08)

1. Rami authorized reviewing the whole plan and continuing T2 through the remaining tasks,
   with sub-agents for implementation and validation. The review found unresolved product
   contracts; T2 has not started. Recommendations are recorded in `tasks/plan-review.md`.
2. Three decisions were presented to Rami: untimed overnight run attribution, restoring a
   reversed bonus on re-completion, and concurrent offline daily actions with ledger
   reconciliation. These recommendations remain pending, not approved product changes.
3. The review also identifies missing coin controls and native mutation coverage, sync/export
   sequencing and compatibility gaps, widget toggle routing, and migration scope corrections.
   The approved spec, implementation plan, task completion states, and product code are unchanged.
4. Baseline validation: `bun run validate` exit 0, 45 suites and 570 tests, all 33 `src/core`
   files at 100 percent on all four metrics. `bun run test:native` exit 0, 9 plugin tests and
   51 Swift tests. Logs: `.artifacts/readiness/validate.log` and `native.log` (ignored).
5. Argent CLI is available. The existing T1 simulator has the correct fork bundle installed.
   Port 8082 is free for the fork; port 8081 belongs to Ripples. No simulator data, installed
   apps, or Metro processes were changed during this review.
6. Review authors: coordinating agent and separate plan-review agent. Independent data-contract
   reviewer approved both documentation files without corrections. This checkpoint and the
   review document form the documentation-only pre-T2 review commit.

### T1 - fork identity and EAS project (2026-09-08)

1. Task id: T1. Acceptance: `app.json` name and slug `habit-system`, bundle `studio.orbitlabs.habitsystem`,
   scheme `habitsystem`, widget kind and display name renamed; CloudKit zone `habit-system`; podspec URLs
   at `rami-maalouf/habit-system`; new EAS project id in `extra.eas.projectId` and `updates.url`;
   `package.json` name `habit-system`; FORK.md table marked applied.
2. Author: Fable 5.1. Independent verifier: Sonnet (two passes, separate instances).
3. Red first: a new plugin test `app configuration carries the fork identity and never the ripples identity`
   in `modules/ripples-apple/tests/plugin/config.test.cjs` and a Swift test `testZoneNameIsTheForkZone`
   in `CloudKitMappingTests.swift` both failed against the Ripples identity before any change.
4. Files changed: `app.json` (name, slug, scheme, bundle id, `CFBundleDisplayName`, widget group, widget
   kind `HabitSystemBoards`, widget display name `Habit System`, new EAS project id and updates url;
   `owner` and `extra.eas.build.experimental.ios.appExtensions` written by `eas init` and prebuild),
   `package.json`, `modules/ripples-apple/ios/CloudKitTransport.swift` (zone `habit-system`),
   `modules/ripples-apple/ios/Intents/RipplesAppIntents.swift` (widget kind in UserDefaults keys and
   `reloadTimelines(ofKind:)`), `modules/ripples-apple/ios/RipplesApple.podspec`,
   `src/platform/database/index.ts` (`appGroupId`), `src/platform/widgets/ripples-boards-widget.tsx`
   (`createWidget('HabitSystemBoards')`, `habitsystem://` deep links), Swift and migration test literals,
   `.agents/prompts/fix-prompt.md`, `.eas/workflows/agent-fix.yml`, `.argent/flows/*`, `e2e/argent/**`,
   `SPEC-native-foundation.md` (identifier strings only), `SIMULATOR-DEMO-RUNBOOK.md` (only the two
   current-source lines; the pinned historical dry-run keeps `com.ramimaalouf.habittracker`), `MEMORY.md`,
   `FORK.md` (table marked applied, `ExpoWidgetsTarget` explained, scope additions recorded).
5. EAS: `eas init` created `@ramimaalouf/habit-system`, id `07481ea0-9f44-4f24-ad3c-fd889569cade`.
   The Ripples project `1e477943-...` is no longer referenced anywhere functional.
6. Gates: plugin config test 9/9; Swift 51/51 (`swift test --package-path modules/ripples-apple`);
   `bun run validate` exit 0, 45 suites, 570 tests, coverage 97.5/95.5/95.58/97.6, every `src/core` file at
   100 percent; `bunx expo-doctor` 21/21; lint and typecheck clean.
7. Build evidence: `bunx expo prebuild --platform ios --clean` then `bunx expo run:ios --device "iPhone 17 Pro"
   --no-bundler` succeeded on simulator `B47A3DF3-056A-4531-B9FA-8327C7C8A485`. `xcrun simctl listapps` shows
   `CFBundleIdentifier = studio.orbitlabs.habitsystem`, `CFBundleDisplayName = Habit System`,
   `CFBundleName = habitsystem`, with Ripples (`studio.orbitlabs.habittracker`, `Ripples`) still installed
   separately. Generated `ios/ExpoWidgetsTarget/HabitSystemBoards.swift` exists and contains no
   `RipplesBoards`. Private evidence: `.artifacts/t1/installed-app.txt`, `.artifacts/t1/build.log`,
   `.artifacts/t1/simulator-after-install.png` (ignored).
8. First CocoaPods run failed with `Unicode Normalization not appropriate for ASCII-8BIT`: the background
   shell had `LANG=""`. Re-running with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` fixed it. Not a project defect.
9. Independent review, pass 1: FAIL. Blocker: the widget kind `RipplesBoards` was not renamed and the
   author had narrowed the FORK.md acceptance row to match. Majors: test too weak to catch it; the widget
   description copy was changed out of scope. Minors: `CFBundleDisplayName` still `Ripples`; `owner` and
   `appExtensions` undocumented; `ExpoWidgetsTarget` not explained. All six remediated: kind renamed in
   app.json, TypeScript, and Swift; FORK.md row restored and `ExpoWidgetsTarget` documented as an
   expo-widgets plugin constant that cannot be renamed without patching the dependency; test now pins the
   widget kind in all three places, the app-group constant, the zone constant, the podspec URLs, the exact
   EAS id, both display names, and the exact original widget description; copy reverted; display name set
   to `Habit System` as a recorded T1 scope addition (two apps labeled Ripples on one phone would make
   device testing ambiguous).
10. Independent review, pass 2: PASS WITH NOTES. Verified all six fixes at file:line and confirmed from
    `node_modules/expo-widgets` that the WidgetKit kind and UserDefaults keys derive from the app.json
    widget name, so Swift and app.json agree. Notes remediated: the runbook's pinned historical bundle id
    was restored from HEAD; the test pins the exact EAS id and podspec URLs; a vacuous regex alternative
    was removed; the MEMORY.md link fix is recorded in FORK.md.
11. Operational finding: the fork's dev client connected to the user's Metro on 8081, which serves Ripples,
    and loaded Ripples' JavaScript (dev menu banner read `habit-tracker`). The native shell was correct.
    Rule recorded in `MEMORY.md`: run the fork's Metro on another port; never point the fork at 8081;
    never stop 8081.
12. Checkpoint 0 (fork identity) is met. Next: T2, migration version 6 and entity types.

## Pre-fork work - 2026-09-07

### Pre-fork closure - 2026-09-07 (final)

Rami declared the pre-fork work complete on 2026-09-07. This entry is the
single record of what Ripples proved before it was forked into habit-system.
Everything below it in this section is the working history that led here.

**Fork point.** Tag `ripples-v1-fork-point` marks the commit that contains
this entry. The fork copies the tree at that tag. Later Ripples commits do not
move it.

**Landed and pushed to `origin/main`.**

| item | what landed | commits |
| --- | --- | --- |
| 3.1 CloudKit transport | direct CloudKit operations behind the unchanged `SyncTransport` port, conditional saves, account digest binding, error-code mapping; 31 Swift tests | `eb2189f`, `734f9e7`, `589cc4f` |
| 3.2 App Intents | Swift executor passing the shared `intent-contract.json` verbatim; exactly three discoverable intents; 19 Swift tests | `eb2189f`, `b04bb87`, `a9f1ca1`, `589cc4f` |
| 3.3 alternate icons | native adapter with confirmed-only persistence and rollback; Default, Midnight, Paper artwork registered for iPhone and iPad | `dd3b512`, `eb2189f` |
| 3.4 reference fixture | `src/testing/fixtures/reference-august-2026.ts`, development-only, empty-database guard tested | `9a93a02` |
| 3.5 reminder review | independent review closed with APPROVE after five findings were fixed | `8d85a43` |
| 3.6 focused scripts | `tests/product/contracts/` and `tests/product/sync/` created; `test:contracts` and `test:sync` run | `993eeb0` |
| 3.7 spec corrections | product spec now documents import, Timeline, `release-links.ts`, the `studio.orbitlabs.*` namespace, zone `habit-tracker`, and the fixture rules | `2481feb`, `eb2189f`, `1f7fb51` |
| 3.8 privacy audit | no screenshots, artifacts, exports, credentials, or generated native folders tracked; `.easignore` mirrors `.gitignore` | `9339720`, `51cf494`, `eb2189f` |

**Final gates at `f55732d` (the commit before this entry).**

- `bun run validate`: exit 0; 45 suites, 570 tests; global coverage above 90
  percent; every `src/core` file at 100 percent on all four metrics.
- Swift module: 50 tests, 0 failures. Plugin configuration: 8 checks pass.
- `bunx expo-doctor`: 21/21.
- Working tree clean; `main` equal to `origin/main`.

**Identifiers the fork must not reuse.** Bundle `studio.orbitlabs.habittracker`,
App Group `group.studio.orbitlabs.habittracker`, CloudKit container
`iCloud.studio.orbitlabs.habittracker`, zone `habit-tracker`, team `3V2UU7RRK9`.
The fork gets its own bundle id, group, and container so the two apps never
share a CloudKit zone or an app-group database.

**Physical acceptance: what was observed, what was accepted, what was not run.**

- Observed on signed physical devices (iPhone 16 Pro, iPad Air 4, both on the
  Development CloudKit environment): two-target online convergence; one iPad
  offline write that queued and converged after reconnection; one edit/edit
  conflict where the older offline iPad edit lost to the newer online phone edit;
  all three Shortcuts actions on the iPad including Cancel and confirmed Remove
  Latest; Siri "today" and Siri "check in" on the iPhone.
- Accepted without a run, by Rami ("we're good, we're done"): a separate iPhone
  Shortcuts pass. The shared executor, the iPad Shortcuts passes, and the iPhone
  Siri passes are the supporting evidence. This is accepted coverage, not an
  observed pass.
- Not run: the physical Home Screen widget check (the phone locked before the
  widget-gallery test started; widget behavior has simulator evidence only);
  reverse-order edit conflict; simultaneous offline targets; edit/delete
  convergence; the iPhone full radio-off trial. None of these is claimed.
- Simulator only: alternate icon switching and relaunch persistence.

**Deferred by Rami, not blockers.**

- Release destination URLs (feedback, App Store review, more products, privacy
  policy, terms of use). Settings keeps honest unavailable-link states.
- Cleanup of the synthetic acceptance board titled
  `Sync acceptance iPhone conflict2` (29 check-ins) that remains on both
  physical devices. Delete it from the app when convenient.
- `.env` stays tracked; it holds only `ARGENT_SCREENSHOT_SCALE=0.2`.

**Permanently out of scope for Ripples.** Widget in-place quick check-in.
Proven on device to be impossible with `expo-widgets` in SDK 57: the widget
button's intent performs in the extension process and never reaches the app.
The widget deep-links to Add Check-In, which is the spec's rule for an action
that cannot safely run.

**What the fork inherits.** A working CloudKit transport, the single approved
native module with intents and icons, a populated development fixture, a
product spec that matches the code, and a reviewed, tagged history.


### Approval update - continuation authorized

- The user instructed: "you already know what’s best. so go ahead and do everything."
  This approves the recommended direct CloudKit operations with conditional saves,
  the shared-fixture Swift App Intents executor, and the import/Timeline/release-links
  specification corrections. Remaining routine implementation choices are delegated.
- The user explicitly requested the `studio.orbitlabs.*` namespace. Use
  `studio.orbitlabs.habittracker`, `group.studio.orbitlabs.habittracker`,
  `iCloud.studio.orbitlabs.habittracker`, and the matching widget extension suffix.
  Discover the signing team from the local machine as requested. Zone remains `habit-tracker`.
- Replace the artwork with a more visual, cartoony, glossy plastic style and integrate
  the selected result. The user delegated the design choices; no further artwork
  confirmation is required for this direction.
- Release destinations are explicitly deferred by "6. dw bout it". Keep the existing
  honest unavailable-link states; do not invent external destinations or legal text.
- Reference fixture names may use readable minimal demo labels for the four truncated
  source names. Do not claim their missing text has been recovered. Seeding remains
  development-only, explicit, and restricted to an empty product database.

- Independent review identified an iCloud account-switch privacy gap. Add a local-only
  account digest binding in the same SQLite database, checked before native sync work;
  refuse a different account instead of uploading the existing account's data to it.
  This preserves the existing private-account boundary and unchanged transport port.
  Switching back to the originally bound iCloud account is the supported recovery.

### 3.4 - deterministic development fixture

1. Added seven approved demo boards and 75 deterministic August 2026 check-ins.
   The explicit `/reference-august-2026` development route refuses a nonempty
   database, including tombstones, and never changes the clock. The release
   guard runs before database access. Normal app startup does not insert data.
2. Extracted the existing import mapping into a reusable transaction function.
   The empty-store check, validation, receipts, stamps, widget projection, and
   outbox writes now commit together; infrastructure failure rolls everything back.
3. Author: GPT-5.6 Sol. Independent root review approved validation, repeat-command
   idempotency, concurrent insert protection, and the release-build guard.
   Regression tests cover fixture shape, empty-store refusal, rollback, and guards.
4. Argent executed the seed exactly once against the empty new-namespace app.
   All seven titles and August 17/30 heatmap cells were verified. The current
   September strips remain empty because there is no fake clock. Evidence:
   `.artifacts/pre-fork/native-acceptance/reference-home.png` and `august-heatmap.png`.
   `.argent/flows/prefork-reference-seed.yaml` is a recorded one-time seed flow,
   not a repeated regression against an already populated database.
5. Combined validation after integration: 569 Jest tests in 45 suites, lint,
   typecheck, and 100 percent coverage across all four core metrics passed.

### 3.1 - native CloudKit transport and sync integration

1. Implemented direct private-zone operations in the existing RipplesApple module:
   typed sanitized errors, exact provider-neutral record mapping, batches and
   per-record failure handling, change-token paging, and runtime availability.
   Conditional saves preserve the greater mutation stamp and retry server races.
   The `SyncTransport` port is unchanged. Tombstones clear previous user fields.
2. Migration 5 adds one local-only account-digest binding table in the existing
   SQLite database. Native operations check that binding before account-sensitive
   work and before accepting results. Tokens are scoped to container, zone, and
   account. Account changes cannot silently move the local data to another account.
3. Independent review exposed malformed inbound records, stale deferred payloads,
   duplicate idempotency keys, and Settings-owned sync lifecycle gaps. Added
   semantic validation/quarantine, keyed deferred lookup, newer-record recovery,
   one app-lifetime coordinator, retry outside Settings, and cancellation fences
   around network results and local transaction commits. Provider construction
   and disposal are safe under React StrictMode. Review reproductions became
   regression tests; all six inbound adversarial cases passed on re-review.
4. Native CloudKit author: native_time_listener. Independent review: root and
   reminder_core_fixes. Inbound engine author: GPT-5.6 Sol, independently reviewed
   by native_time_listener. Coordinator and integration author: root, reviewed by
   native_time_listener and GPT-5.6 Sol. No author is counted as their own verifier.
5. Validation: 31 Swift CloudKit tests, 17 native-adapter Jest tests, full core
   coverage, and real iOS 18.6 SDK compilation. Native signed-out acceptance
   retained all 89 pending changes and presented no raw CloudKit error. Evidence:
   `.artifacts/pre-fork/native-acceptance/icloud-consent.png` and `icloud-signed-out.png`.
   The recorded manual walkthrough passed. Full data-flow replay is unproven:
   Argent could not target the native consent button reliably after 25 passing
   executable steps; two bounded correction attempts stopped. No product failure
   was established by that replay. Sync was turned off and local data retained.
6. Signed two-target create/edit/archive/delete, offline mutations, and conflict
   convergence remain required acceptance. Simulator Signed Out is not sync proof.

### 3.2 - shared-contract Swift App Intents

1. Implemented active ordered Board entities and exactly three public intents:
   Check In, Remove Latest Check-In with confirmation, and Get Today's Check-Ins.
   The executor opens the same app-group SQLite database, verifies migration 5,
   and uses one exclusive transaction for validation, receipts, mutation stamps,
   widget projection, and outbox. It neither creates nor migrates a second store.
2. Remove confirmation is guarded against the selected latest record changing.
   Receipt replay precedes entity resolution, including retry after archive/delete.
   Read results exclude notes. The committed projection is published using SDK 57's
   widget timeline representation; widget quick actions remain app deep links.
3. Author: reminder_core_fixes. Root independently reviewed executor, schema,
   receipt replay, confirmation guards, and the generated application shim.
   Tests load the existing 13 JSON contract cases verbatim, plus native regressions:
   17 Swift intent tests pass. The public wrappers typecheck against iOS 18.6.
4. The built application metadata contains exactly three discoverable Ripples
   intents and three shortcut phrases. SDK widget actions remain nondiscoverable.
   The application shim is generated by the one module's config plugin.
5. iOS 18.6 does not distinguish Siri from Shortcuts in this public wrapper; both
   use source `shortcut`, while the shared executor accepts the fixture's `siri`.
   Each explicit invocation owns a UUID; no durable OS invocation token across
   process death is claimed. Running each Shortcut and the Siri phrase against a
   signed physical build remains required acceptance.

### 3.3 - final cartoon artwork and native icon registration

1. Replaced Default, Midnight, and Paper with the user's delegated cartoon glossy
   plastic direction: one smiling droplet character with chunky ripple rings.
   Source provenance is in `assets/images/alternate-icons/README.md`. The plugin
   generates opaque 1024-pixel universal icon sets and registers iPhone/iPad
   alternates. Compiled Info.plist and Assets.car contain all three icons.
2. Settings now uses the actual artwork previews. A delayed settings refresh
   exposed a rollback race after successful Midnight then failed Paper selection;
   the last confirmed choice is now retained synchronously. The new regression
   and independent delayed-query reproduction pass.
3. Root authored artwork/plugin/UI integration; reminder_core_fixes independently
   verified native configuration, selection, rollback, and the race regression.
   Simulator build succeeded with zero errors and two upstream build-phase warnings.
4. Argent replay `.argent/flows/prefork-native-icons.yaml` passed 33 executable
   steps (40 including echoes): all three icons produced iOS confirmation dialogs.
   Paper persistence after relaunch was verified separately by native selected
   trait and screenshot; the flow's option-visible assertions alone do not prove
   selection. Default was restored. Evidence:
   `.artifacts/pre-fork/native-acceptance/midnight-selected.png`,
   `paper-after-relaunch.png`, and `icon-native-selection.json`.
5. Device: iPhone 17 Pro simulator, `93EEF062-B4DC-4989-AF77-CF47EE2A9816`,
   new namespace `studio.orbitlabs.habittracker`, actual Metro port 8081.
   The old app and other simulator were preserved. Only the assigned simulator's
   Argent servers were stopped; the user's Metro remains running. Physical-device
   relaunch/widget/Shortcut evidence is still a separate final checkpoint.

### 3.7 - approved specification corrections

1. The product specification now describes the implemented JSON/CSV import,
   tombstone-aware ids, coherent activity periods, fail-soft record parsing,
   explicit-key parser construction, and the recursive export forbidden-key scan.
2. Retained and documented Import and Timeline routes and the existing
   `src/features/settings/release-links.ts` boundary. Required release destinations
   remain explicitly deferred by the user, with honest unavailable states.
3. Recorded the authorized namespace, zone, native transport/account boundary,
   and explicit development-only fixture rules. Preserved the other session's
   approved UI amendments. Sol authored the drift amendments; root inspected them
   against the existing implementation and the user's authorization.

### Signing preparation and validation - 2026-09-07

1. Discovered and verified team `3V2UU7RRK9` from the local certificate's team
   field and existing profiles. Initial local automatic signing failed because
   Xcode had no account session. EAS recovered the existing Apple login through
   the local Keychain, resolving profile creation without another user login.
2. Registered the authorized app/widget identifiers, app group, and CloudKit
   container. Reused the existing distribution certificate and registered iPhone;
   created the two required ad hoc profiles. No credential, profile, raw account
   data, generated project, or private screenshot is committed.
3. Read-only profile inspection confirmed both CloudKit environments are allowed.
   The plugin explicitly selects Development for local/internal acceptance builds;
   `eas.json` selects Production for the production profile. This avoids the
   distribution export default silently selecting the wrong CloudKit environment.
   The configuration regression failed before the fix and passes after it.
4. Final combined `bun run validate`: exit 0, 45 suites, 569 tests, global coverage
   above 90 percent and every core metric at 100 percent. Native tests: 48 Swift
   tests plus 3 plugin checks. Expo Doctor: 21/21. iOS and Android exports: exit 0.
   `git diff --check` passes. Logs are in `.artifacts/pre-fork/`.
5. Project-local Watchman ignores now exclude generated native/Swift build output
   and private artifacts. Only this project's watch was refreshed; the final
   validation has no Watchman recrawl warnings. Export output includes the host's
   NO_COLOR/FORCE_COLOR environment warning, without a bundle failure.
6. Physical iPhone was still unavailable at the last device check. A signed
   installation artifact and actual two-target acceptance are not replaced by
   the simulator or compiled metadata evidence above.
7. Independent Sol archive audit requested an explicit `.easignore` so build
   uploads omit agent context and project notes as well as private evidence.
   Actual EAS archive inspection confirms all excluded contents are absent and
   the native module, generated-source template, and icon assets remain present.
   EAS may retain empty directory entries; they contain no source or private data.

### Pre-fork closure status - signed acceptance pending

- Landed and pushed: 3.6 scripts, 3.5 independent reminder review, 3.4 guarded
  fixture (`9a93a02`), 3.7 approved spec corrections, and the implementation for
  3.1 CloudKit, 3.2 App Intents, and 3.3 final icons (`eb2189f`).
- Independent final GPT-5.6 Sol integration verdict: PASS. Provider lifecycle tests
  passed 10/10; plugin tests passed 3/3; Development and Production introspection
  matched the approved identities/environments; archive privacy and required build
  inputs passed. The review did not count signed acceptance as completed.
- Final source gates and simulator evidence are recorded above. Private references,
  exports, credentials, generated native folders, and Swift build output are not
  tracked. Only source flow definitions are committed, with their replay limits.
- EAS accepted signed development build `6d550951-0fe7-4e16-9aee-9e68024b9ec5`
  from `eb2189f0270e819193079f286bf79a5dd1f9d423`; status at this checkpoint:
  Finished on 2026-09-07 at 22:30 UTC. Version 1.0.0, build 1. Build page:
  https://expo.dev/accounts/ramimaalouf/projects/habit-tracker/builds/6d550951-0fe7-4e16-9aee-9e68024b9ec5
- Downloaded the 44,303,155-byte IPA to ignored local evidence. Deep strict
  `codesign` verification passed. The actual signed app contains the approved
  bundle/team, minimum iOS 18.6, CloudKit Development/container entitlement, shared
  app group, Midnight/Paper registrations for iPhone/iPad, and matching widget id.
  Its profile includes the registered physical iPhone. The archive metadata has
  exactly three discoverable Ripples intents; widget-only actions are hidden.
  Filtered proof: `.artifacts/pre-fork/signed-ipa-entitlements.json` and
  `signed-ipa-verification.log`. Ad hoc signing does not enable native debugger
  attachment (`get-task-allow` is false); this is an installable development client.
- Independent GPT-5.6 Sol artifact verdict: PASS. The reviewer separately verified
  IPA integrity, deep strict signature, identities/environment/minimum OS, compiled
  Assets.car entries, both alternate-icon registrations, three discoverable intents,
  and three matching shortcut entries. No physical execution was inferred.
- Remaining acceptance: signed physical iPhone plus second-target CloudKit
  convergence, actual three Shortcuts and Siri execution, and physical widget/icon
  checks. `tasks/pre-fork-device-acceptance.md` records the concrete acceptance path.
  The paired physical iPhone was unavailable at that checkpoint; the device
  continuation below supersedes this prerequisite status.
- Deferred by the user: release destination URLs. Native implementation is not
  deferred to the fork, and signed acceptance has not been waived. Item 3.8 is
  therefore still open. No `ripples-v1-fork-point` tag or habit-system fork was created.
- The session-owned Metro 8082 was stopped after verification. User-owned Metro
  8081 remains running. Scoped Argent simulator cleanup is recorded above.

### Signed-device continuation - SQLite integration correction

1. The user connected the iPhone 16 Pro and iPad Air 4, and enabled iCloud Sync
   on the iPhone. Both devices are registered in the app and widget ad hoc profiles.
   Existing certificates were reused. The iPhone installed the first Development
   build and reported native CloudKit availability, a successful sync, zero pending
   uploads, and a passing database integrity check. Its existing personal records
   were not changed by the diagnostic checks.
2. A physical UI check exposed `EXC_BAD_ACCESS`/`SIGBUS` in Expo SQLite's WAL-index
   write. The concurrent thread was inside system SQLite performing the native
   account-binding check on the same database. The fault address was in a 32 KB
   mapped-file region, consistent with the WAL index. A bounded synthetic host
   reproduction did not crash. SQLite documents why linking separate SQLite copies
   against one database in a process is unsafe:
   https://sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application
3. Both native database consumers now import ExpoSQLite and call its `exsqlite3_*`
   functions on iOS. The pod depends on ExpoSQLite and no longer directly links
   system SQLite. macOS-only aliases retain the existing SwiftPM test targets.
   Transaction boundaries, full-mutex opens, and the busy timeout are unchanged.
4. Independent GPT-5.6 Sol review: PASS. The actual simulator arm64 pod archive
   contains 28 Expo-prefixed SQLite references and zero system SQLite references.
   `bun run test:native:linkage` checks the pod dependency and compiled symbols;
   a synthetic mixed-symbol object proves the guard rejects the old failure class.
   The initial guard path error was corrected before approval. Validation passed:
   569 Jest tests, lint/typecheck, 48 Swift tests, three plugin tests, and Doctor
   21/21. Global coverage is 97.5/95.57/95.58/97.59; core gates remain enforced.
5. Physical UI control uses an ignored, external XCTest runner because this Argent
   version does not support physical iOS control. The running phone's React Native
   runtime was inspected through Argent. The runner uses an existing local wildcard
   development profile and no product target. Automatic UI attachments are discarded;
   explicit evidence contains only allowlisted status/counts or the iCloud screen.
   Private diagnostic evidence is in `.artifacts/pre-fork/physical-ui-runner/`.
6. EAS re-sign job `3835b2da-dac0-4809-a1d9-2f4dc32908a9` added iPad provisioning
   but changed the app entitlement from CloudKit Development to Production. That
   artifact is rejected for acceptance. Its attempted iPad installation failed
   before installation because the device was locked. The iPad is now unlocked.
7. Replacement full Development build `cd2e117b-d048-4367-87f0-4c1931c2c486`
   was submitted with frozen credentials. It includes the working-tree native
   SQLite correction above base `f02c8e9`; its reported Git revision is that base.
   Independent GPT-5.6 Sol signed-artifact verification passed: safe ZIP/deep strict
   signatures, Development, approved identities/container/group, both devices in
   both profiles, minimum iOS, icons and three intents. SHA-256:
   `f6652598fb0e3ae1ad51355f2f0b38f53c4d001702561d66dfa7d31fb55a4138`.
   The replacement installed over the existing phone app and onto the iPad without
   uninstalling or resetting either store. iOS then rejected both app launches
   because the devices were locked. Unlocking was requested. The prepared synthetic
   WAL and cross-device helpers passed independent review but have not run.
   Corrected-build physical acceptance and fork readiness remain open.
8. The user subsequently instructed not to download/install on the iPad. Its
   installation had already completed before that message. Stopped all iPad work,
   informed the phone worker, and left the installation untouched. iPhone work
   remains authorized; two-target convergence needs another authorized signed
   target and is not waived by this change.
9. The user clarified: "I meant download it on my iPad." This supersedes item 8's
   stop instruction. Resumed iPad acceptance using the existing verified install;
   the subsequent normal app launch succeeded. No reinstall or reset was needed.
10. Corrected-build iPad WAL acceptance: PASS. The independently reviewed runtime
    harness completed 24 check-in commands, 12 concurrent native CloudKit account
    checks, six reads, and six receipt replays in 2,739 ms. It verified exact
    check-in/receipt counts, unique idempotency keys, the widget projection, intact
    pre-existing rows, no synthetic notes, and database integrity. The normal sync
    coordinator subsequently drained the upload queue to zero. The iPad also
    received the existing phone board through CloudKit. This establishes the
    corrected database integration and basic cross-device delivery, not the full
    offline/conflict matrix. Evidence: `.artifacts/pre-fork/ipad-wal-acceptance.json`.
11. The phone was foregrounding a personal call, so its UI checks stopped without
    mutation. The user then prioritized both booted simulators and authorized
    parallel agents. Simulator Shortcuts/widget and icon/accessibility checks run
    separately from the physical iPad sync checks; neither simulator is reset.

### Settings status accessibility correction

1. Physical iCloud acceptance exposed that read-only Settings rows were disabled
   pressables whose explicit accessibility label hid their displayed value.
   Status, queue size, last sync, and version now expose grouped static text with
   a label and value. Actionable rows retain their button behavior and include
   detail in their accessible name. Existing layout and minimum height remain.
2. The new regression failed before the correction and passed afterward. Full
   validation passes: 570 tests across 45 suites, lint/typecheck, global coverage
   97.5/95.5/95.58/97.6, and unchanged 100 percent core gates. Logs:
   `.artifacts/pre-fork/settings-accessibility-red.log` and
   `.artifacts/pre-fork/ipad-final-validate.log`.
3. Independent GPT-5.6 Luna source review: PASS, including 22 Settings tests and
   lint/typecheck. A separate device verifier inspected the actual Pro Max native
   accessibility tree: Status/Off, Waiting to upload/0, Last sync/Never, and
   Version/1.0.0 (1) expose only static-text traits. Evidence:
   `.artifacts/pre-fork/icons-accessibility-acceptance/native-readonly-status.json`.
   This UI check does not claim signed CloudKit account acceptance.

### Pre-fork closure audit corrections

1. The independent closure audit found an obsolete out-of-scope import bullet
   despite the already-approved import section. Removed that bullet and included
   import in the scope inventory under the existing item 3.7 approval. No import
   behavior or schema changed.
2. The acceptance runbook now includes both Siri scenarios required by the
   governing product spec: Check In and Get Today's Check-Ins. The pre-fork draft
   mentioned only Check In; this correction restores the existing requirement.
3. The SQLite integration correction is committed and pushed as `734f9e7`;
   Settings accessibility is committed and pushed as `a5db12b`. The independent
   audit confirmed clean main matching origin, passing recorded gates, no tracked
   private/generated/signing artifacts, and effective ignore rules. Final closure
   remains pending device acceptance; no fork-point tag has been created.

### Native plugin lint gate

1. Targeted lint reproduced two `no-undef` failures for CommonJS `__dirname` in
   the plugin and plugin tests, which Expo's normal lint command omitted.
   The lint script now checks those folders. Only their ESLint scope declares
   `__dirname` readonly; no lint rule was disabled and no dependency was added.
2. Independent GPT-5.6 Sol review: PASS. Targeted lint passed; an in-memory probe
   still rejected an unknown global, and calculated config confirmed the new
   global does not extend to app source or unrelated configuration files.
3. Combined validation, including the in-progress registration correction, passed
   570 tests across 45 suites, lint/typecheck, global coverage
   97.5/95.5/95.58/97.6, and all existing core gates. Evidence:
   `.artifacts/pre-fork/native-plugin-lint-red.log` and
   `.artifacts/pre-fork/registration-validate.log`.
   Native UI evidence from the same source is recorded by the icon and widget
   acceptance agents; this lint-only change does not alter runtime behavior.

### App Intents discovery correction

1. iOS 27's simulator Shortcuts catalog was empty even for built-in actions.
   A separate iOS 26.5 simulator had a healthy catalog, but Ripples was absent
   after installation, app initialization, and Shortcuts restart despite having
   three discoverable definitions and three shortcuts in the compiled metadata.
2. The sole module's config plugin now registers its app-level shortcut provider
   during app startup. The actual AppDelegate mod is idempotent, preserves linking
   handlers, and rejects unsupported or ambiguous launch hooks. Independent
   review found a duplicate/misplaced-call gap; regression tests and the guard
   were corrected before approval. This startup call alone did not restore discovery.
3. The app additionally declared an AppIntentsPackage dependency for RipplesApple,
   even though the CocoaPod is statically linked and its definitions already merge
   into the app metadata. Removed that app-level package dependency while retaining
   exactly three public intents and their provider. Apple's static-library guidance:
   https://developer.apple.com/videos/play/wwdc2025/244/
4. The generated-source regression reproduced the package mismatch before the fix.
   Eight plugin tests, lint/typecheck, and the arm64 simulator build pass. The new
   app has no package-dependency metadata and still includes the three intents.
   Actual iOS 26.5 Shortcuts discovery now shows exactly Check In, Remove Latest
   Check-In, and Today's Check-Ins. Evidence:
   `.artifacts/pre-fork/intents-widget-acceptance/static-intents-build-evidence.json`
   and `.artifacts/pre-fork/ios265-shortcuts/`.
5. Independent GPT-5.6 Sol review: PASS after aligning the intent test README with
   the static-link architecture. The minimum iOS remains 18.6; source availability
   and builds pass, without claiming runtime QA on an uninstalled 18.6 simulator.
6. Discovery is fixed; full execution acceptance is still open. The first
   auto-shortcut attempts reported Apple's generic inability-to-run result before
   parameters or results and created no check-in. A composed Today's Check-Ins
   shortcut subsequently succeeded with all seven demo board names and zero counts.
   Its native result overlay was visible even though Argent initially described
   the underlying editor. Remaining actions and automatic tiles are being tested;
   no signed-physical or Siri pass is claimed.

### App Intents entity and error contracts

1. Actual iOS 26.5 Check In testing reaches the board picker, then returns a
   generic internal error after selecting the synthetic morning pages board with
   optional parameters omitted. No check-in row or failure receipt was committed.
   A build with the debug dylib disabled reproduced the same failure; that build
   setting was restored. A native-core run against an isolated backup of the demo
   database passed and left the live store untouched.
2. Independent review found that `entities(for:)` incorrectly threw when any
   identifier was unavailable. Apple requires omission of unavailable identifiers.
   The query now filters active boards in their existing order, omitting missing,
   archived, and deleted entities. Mutation commands retain their own validation.
   Reference: https://developer.apple.com/documentation/appintents/entityquery/entities%28for%3A%29
3. Existing sanitized failures now conform to
   `CustomLocalizedStringResourceConvertible`, as required for actionable App
   Intents error wording. No raw platform errors or user contents were added.
   Reference: https://developer.apple.com/videos/play/wwdc2022/10032/
4. Both regressions reproduced before the fixes. All 50 Swift tests and eight
   native config tests pass, as do lint/typecheck, the simulator build, and diff
   checks. The build retains minimum iOS 18.6. Independent GPT-5.6 Sol source and
   test review: PASS. Evidence: `.artifacts/pre-fork/intent-contract-native-tests.log`
   and `.artifacts/pre-fork/intents-widget-acceptance/intent-contract-build-evidence.json`.
5. The rebuilt app still reproduced the generic Check In failure without a
   debugger. These are verified API contract fixes, not a completed execution
   checkpoint. A separately reviewed, ignored LLDB trace uses static entry markers
   only, with no argument or database inspection, to locate the remaining failure.
   Its first run was inconclusive: the debugger stalled while resuming, so zero
   breakpoint hits do not establish where execution stopped. It was detached
   successfully and the original app process remained alive.

### App Intents execution diagnostics and static-package cleanup

1. Removed the unused module-level `AppIntentsPackage` declaration. RipplesApple
   is statically linked, and its definitions already merge into the application.
   This completes the earlier package cleanup; it did not fix the execution error.
   The three public intents, optional Today board, parameters, and invocation UUID
   behavior are unchanged. Temporary summary, required-board, and initializer
   controls were restored before preparing the next signed candidate.
2. A corrected asynchronous LLDB trace verified the app was running throughout
   an actual Remove Latest attempt. The error occurred before identifier-query
   and `perform` entry. A successful no-board Today action hit its `perform`
   breakpoint once, validating the tracer. Only fixed entry markers were recorded;
   no arguments, notes, accounts, or database values were inspected. LLDB detached
   successfully and left the app alive. Evidence:
   `.artifacts/pre-fork/ios265-shortcuts/intent-async-trace-result.json`.
3. Guarded hosted iOS tests used the real compiled wrappers and ExpoSQLite driver,
   without a second implementation or SQLite library. Selected-board Today and
   Check In passed, including same-instance receipt replay without duplication.
   The public `callAsFunction(donate: false)` path also passed with selected Board.
   These tests created exactly two synthetic current-day morning-pages records in
   the seven-board simulator fixture. They are diagnostic tests of in-app execution,
   not evidence that the out-of-process Shortcuts handoff works. The normal app
   was restored afterward. Evidence:
   `.artifacts/pre-fork/intents-widget-acceptance/hosted-intents-tests/`.
4. Continuous UI tests kept Play, Board selection, and response observation in
   one XCTest session. Check In and Remove Latest still failed before success or
   confirmation; ending an inspection session between steps is not the sole cause.
   Temporarily requiring Board on the otherwise working read-only Today intent
   also failed after selection. This reproduces the issue without Date parameters,
   mutation UUIDs, confirmation, or `@MainActor`. These controls made no check-ins.
   The optional-board product contract is restored.
5. The bounded simulator Siri probe submitted the exact read-only Today phrase but
   observed no result within 20 seconds. Invocation alone is not a Siri pass.
   Physical-device Siri and the remaining two-target iCloud acceptance stay open.
6. Independent user reports reproduce simulator failures with Apple's sample:
   https://developer.apple.com/forums/thread/836585 and
   https://developer.apple.com/forums/thread/835888. Neither thread has an Apple
   staff confirmation. A local sample comparison is being used to distinguish an
   environment failure from a Ripples defect; the reports alone do not establish
   Ripples' cause. Private UI evidence is in
   `.artifacts/pre-fork/ios265-shortcuts/`.
7. Final cleanup gates pass: 570 Jest tests in 45 suites, lint/typecheck, unchanged
   full core coverage, 50 Swift tests, eight native config tests, and Expo Doctor
   21/21. Logs are `.artifacts/pre-fork/static-package-final-{validate,native,doctor}.log`.
   Independent GPT-5.6 Sol review approved the two-line source cleanup and the
   diagnostic boundaries; its wording correction is included. This checkpoint
   does not close signed-device acceptance or authorize a fork-point tag.
8. The restored normal app built and installed successfully with Today Board
   optional, the original summary, and exactly three provider shortcuts. Argent
   then ran no-board Today successfully: seven synthetic board names, morning
   pages 2, all others 0, Total 2. Evidence:
   `.artifacts/pre-fork/ios265-shortcuts/restored-today-success.png`.
9. Apple's official sample was built in a separate ignored directory and installed
   in a separate bundle on the same iOS 26.5 simulator. Independent verification
   found all 40 Swift files byte-identical to Apple's download. The copied project
   excludes only the unavailable Watch target's dependency and embed phase; the
   iOS source is unchanged. Its Open Favorites automatic shortcut reproduced the
   exact `Unable to run App Shortcut` error. This establishes an environment issue
   for automatic launch, not the cause of Ripples' separate selected-Board failure.
   The sample's composed entity action was not run. Further exploratory simulator
   tests stopped after the user's instruction to hurry; signed acceptance remains
   required. Evidence: `.artifacts/pre-fork/apple-appintents-sample/`.

### Signed acceptance candidate and current stop point

1. EAS Development build `38d0eac8-e9e1-408d-ac10-80522f35632c` finished from
   clean source `589cc4fbf2060b04937db30d75f1b1113ee5e925`. Existing signing
   credentials were frozen and reused. Independent GPT-5.6 Sol verification
   passed archive integrity, deep strict signatures, exact approved team and
   identifiers, exact two-device profile inventory, Development CloudKit, all
   three icons, minimum iOS 18.6 on both targets, and exact public intent metadata.
   Today Board remains optional; no static-package dependency or marker remains.
2. The verified 44,302,125-byte IPA SHA-256 is
   `8797b076d9ab3fa7c98438032fa25ad0a4ca3378fefbab530dbe4230ddadf38c`.
   It was installed successfully as an update on the registered iPad. No uninstall,
   reset, account change, or network change was performed. A post-install check
   still reports a passcode lock, so no new launch or runtime pass is claimed.
   The iPhone retains the prior shared-SQLite build until available for updating.
3. Simulator exploration is stopped. Scoped Argent cleanup covered only this
   task's simulators and debugger sessions; simulators remain booted and the user's
   Metro 8081 remains running. No active UI test, native build, or debugger remains
   from the completed simulator probes. Physical-device availability was requested.
4. Remaining work is the signed Shortcuts/Siri and widget checkpoint, two-target
   offline/reconnect/conflict/delete convergence, synthetic-data cleanup, and final
   fork closure. These gates are not waived by the instruction to hurry. No fork
   or `ripples-v1-fork-point` tag has been created. Resume directly from
   `tasks/pre-fork-device-acceptance.md` and the current verified candidate;
   do not repeat the completed simulator experiments.
5. Private evidence: `.artifacts/pre-fork/final-intents-ipa/`,
   `.artifacts/pre-fork/final-intents-ipad-install.json`, and
   `.artifacts/pre-fork/ipad-current-lock.json`. This is a handoff checkpoint,
   not the pre-fork closure entry.

### Signed physical convergence and offline write

1. The user unlocked the devices and authorized immediate continuation. Both the
   physical iPhone 16 Pro (iOS 26.5.2) and iPad Air 4 (iPadOS 26.4.1) now run
   verified Development candidate `38d0eac8-e9e1-408d-ac10-80522f35632c`.
   The iPhone update succeeded on retry after an interrupted installer connection;
   public CallKit assertions confirmed no active call before its device checks.
2. Both targets initially matched at 25 synthetic check-ins. A normal domain
   title edit and check-in on the iPhone reached the iPad; both then had 26
   check-ins, identical mutation stamps, enabled sync, no pending changes, and
   passing database integrity. Only the identified `Sync acceptance ` board was
   mutated; existing personal boards were preserved.
3. A physical iPad Wi-Fi OFF/ON test passed and restored the original enabled
   state. Its first JS harness waited for an `offline` status before writing,
   timed out after 35 seconds, and made no mutation. CloudKit can remain
   `syncing` through this interval, so this attempt was not counted as a write
   acceptance pass and no product change was made to force an earlier result.
4. The independently reviewed second harness made one normal `createCheckIn`
   command while the separate XCTest proved Wi-Fi was off. The write took 33 ms,
   entirely within the measured radio-off interval. The count increased 26 to 27,
   one change remained queued, and integrity passed. The UI test passed in
   44.706 seconds and restored both Wi-Fi and Ripples foreground state. After
   reconnection and a separate phone write, both targets converged to 28 check-ins,
   identical board stamps, empty queues, and passing integrity. GPT-5.6 Sol
   independently verified the UI timestamps, runtime result, and convergence:
   PASS. The short trial did not observe the `offline` status label.
5. Private evidence is in `.artifacts/pre-fork/sync-acceptance/`: the final online
   convergence, offline-v2 runtime, UI outcome, and convergence artifacts. No
   product source changed. Full two-target offline/conflict trials, actual signed
   Shortcuts/Siri and widget acceptance, synthetic cleanup, and fork closure
   remain open. The phone currently uses a wireless Xcode connection; a USB
   connection was requested before its full radio-off trial. No fork tag exists.

### Physical Siri Today result

1. On the same verified physical iPhone build, the first Siri invocation showed
   the per-app first-use consent and all three approved phrases. A subsequent
   invocation of "Show today's check-ins in Ripples" returned the current
   synthetic board's 28 check-ins and an aggregate total of 29, with board names
   and counts only. Consent was enabled by that point; the evidence does not
   establish who dismissed the initial prompt.
2. The test assertion still expected the synthetic board's previous title and
   failed. The retained screenshot visibly contains the correct current title
   and counts, so this is an observed Siri execution pass, not a passing XCTest
   assertion. Root and independent GPT-5.6 Sol visually reviewed the result:
   PASS. No mutation occurred during the Today check.
3. Private screenshot:
   `.artifacts/pre-fork/physical-ui-runner/phone-siri-today-consent-activation-attachments/CD78C53A-D51D-4785-ABE1-91B3697FE016.png`.
   The subsequent Check In and Shortcuts results are recorded below; this Today
   observation alone does not cover those actions or the widget.

### Physical Siri mutation and all three Shortcuts actions

1. On the iPhone, "Check in with Ripples" presented the board picker. The single
   synthetic selection was followed 262 ms later by a committed native check-in:
   count 28 to 29, logical date `2026-09-07`, one receipt, and widget projection
   `[0,0,0,0,0,0,29]`. The board remained active and integrity passed. The shared
   executor records source `shortcut`; the separate Siri invocation/selection
   timeline establishes voice provenance. The transient success dialog was not
   captured and the later accessibility query failed after the overlay closed.
   No retry or duplicate mutation occurred. Independent GPT-5.6 Sol review: PASS.
2. On the iPad, a continuous signed Shortcuts test passed in 28.838 seconds:
   all three expected automatic actions were present, Today returned counts and
   board names, Check In with defaults returned the exact logical date, and
   Remove Latest displayed its confirmation and accepted Cancel. The native
   check-in increased the count to 30; cancellation preserved that count.
3. A separate confirmed-removal test passed in 10.308 seconds, selecting only
   the synthetic board, confirming once, and displaying the exact success result.
   The independently observed count returned to 29, with an active board, an
   empty outbox, and passing integrity. Optional-parameter and empty-date cases
   remain covered by shared fixtures, not by these physical runs. Exact-three
   inventory is independently supported by signed metadata; the UI test checked
   the three expected actions rather than counting every visible element.
4. Private evidence: `.artifacts/pre-fork/physical-ui-runner/phone-siri-check-in-runtime.json`,
   `phone-siri-check-in-selection-timeline.json`, and
   `.artifacts/pre-fork/ipad-ui-runner/shortcuts-acceptance-summary.json`,
   `after-shortcuts-cancel-runtime.json`, and `after-confirmed-removal-runtime.json`.
   The final iPhone Shortcuts and physical widget checkpoints remain open.

### Physical edit/edit conflict convergence

1. The reviewed one-shot harness edited only the synthetic board while iPad Wi-Fi
   was off. The 36 ms write finished before the independent online phone edit,
   which received the greater hybrid-clock stamp 668 ms later. The phone's queue
   drained while iPad Wi-Fi remained off, 17.268 seconds before restoration.
2. After reconnecting, the iPad retained 29 check-ins and converged to the phone's
   exact greater stamp and title, with no pending changes and passing integrity.
   The physical UI test passed in 44.693 seconds and restored Wi-Fi and Ripples
   foreground state. Independent GPT-5.6 Sol verification: PASS for this ordering.
3. The first attempted conflict trial made its phone edit after Wi-Fi restoration
   because the phone debugger was unavailable; it is not counted as a conflict
   pass. Reverse ordering, simultaneous offline targets, and edit/delete remain
   open. Evidence: `.artifacts/pre-fork/sync-acceptance/ipad-offline-edit-conflict2-summary.json`.

### Current physical stop point after signed execution

1. The physical iPhone locked again before the widget-gallery test could start.
   The waiting XCTest was stopped. No widget was added, no Home Screen edit was
   performed, and no widget cleanup is required. Prior read-only navigation
   established Home Screen and retained private evidence; it is not widget
   acceptance. The iPhone's latest Xcode transport remains `localNetwork`.
2. Resume requires the iPhone connected directly by USB and unlocked. Both
   devices already have the verified candidate; do not reinstall the app or
   repeat completed Siri, iPad Shortcuts, offline-write, or edit/edit trials.
   Prepared ignored runners exist in `.artifacts/pre-fork/phone-widget-runner/`,
   `phone-shortcuts-runner/`, and `phone-offline-runner/`. The full phone radio-off
   runner refuses wireless transport and retains only sanitized test evidence.
3. The synthetic board remains active with 29 check-ins and title
   `Sync acceptance iPhone conflict2`. Retain it for the pending iPhone Shortcuts
   and widget checks, then complete edit/delete and normal-command cleanup.
   Check the board's current logical date before any date-specific resumed test.
4. Fresh lint and typecheck passed. Product source remains the verified `589cc4f`
   candidate, and full validation/coverage, native tests, and Doctor results above
   remain applicable. Documentation of the completed native and conflict checks
   was independently reviewed and pushed in `8cde68e`.
5. Remaining gates are the final iPhone Shortcuts/widget evidence, full two-target
   offline/reconnect ordering, edit/delete convergence, synthetic cleanup, and
   final fork closure. The USB/unlock request is a device availability prerequisite,
   not a new approval request. No fork or fork-point tag has been created.

### Rami's acceptance and end of testing

1. Rami asked whether the working iPad shortcuts were sufficient evidence for
   iPhone shortcuts and concluded, "we're good, we're done." The shared native
   implementation, three passing iPad Shortcuts actions, and both passing iPhone
   Siri actions provide strong supporting evidence. This is accepted coverage,
   not an observed separate iPhone Shortcuts test pass.
2. Item 3.2 is accepted on that basis, and further testing is stopped. The pending
   device unlock/USB request is no longer an active request. Remaining physical
   widget, offline/deletion, and synthetic cleanup work was not completed; no
   pass or completed fork closure is claimed for those items.
3. No further device mutations, installations, or tests were performed. The
   previously documented synthetic board remains for later user-directed cleanup.
   No fork or `ripples-v1-fork-point` tag has been created.

### 3.6 - focused contract and sync scripts

1. Both focused scripts reproduced exit 1 with no tests found before the move.
2. Moved automation and Android readiness contracts to `tests/product/contracts/`;
   moved the engine/records/fake-transport suite and extracted the unchanged HLC
   tests to `tests/product/sync/`. Updated the live documentation paths.
3. Independent GPT-5.6 Luna inspection confirmed byte-identical moved suites,
   unchanged HLC assertions, working relative imports, and unchanged coverage gates.
4. Focused checks: 31 contract tests and 37 sync tests passed. Full isolated
   pre-fork validation: 484 tests across 35 suites, lint/typecheck clean, core
   coverage 100 percent on all metrics. Concurrent board/analytics/icon-picker
   changes were excluded from this validation checkout rather than incorporated.
5. Argent smoke: rebuilt iPhone 17 Pro simulator client opened Boards and the
   Create Board/reminder sheets. Device `93EEF062-B4DC-4989-AF77-CF47EE2A9816`,
   Metro 8082. Evidence stays under `.artifacts/pre-fork/`.

### SDK 57 validation repair

1. Expo Doctor initially failed its SDK patch alignment check. Expo Install
   aligned eleven Expo packages to the SDK 57 recommendations; a frozen-lockfile
   reinstall removed duplicate native package copies. No SDK major upgrade.
2. Independent GPT-5.6 Luna changelog inspection found no new product API migration
   requirement. Full isolated validation passed (484 tests and all coverage gates).
3. Generated `ios/` was regenerated through Expo prebuild and remains untracked.
   The development client built successfully and ran on the iPhone simulator;
   final `bunx expo-doctor` passed 21/21. Build and doctor logs are under
   `.artifacts/pre-fork/`. The build emitted two upstream build-phase warnings,
   with zero errors.

### 3.5 - independent reminder review closure

1. Independent GPT-5.6 Sol review found five issues: missing native requests were
   not repaired; permission/native failures escaped the domain envelope; new-board
   reminders were not fully validated or committed atomically; request payloads
   stayed stale after edits; significant-time events had no native listener.
2. Added pending-request payload reconciliation and typed, sanitized errors for
   every scheduler operation. Disabling does not require notification permission.
   Board and reminder creation now shares one exclusive transaction, receipt,
   projection/outbox envelope, and compensation for scheduled native requests
   when the database rolls back. All drafts validate before prompting or writing.
3. Scaffolded and reviewed the single allowed module, `modules/ripples-apple`,
   retaining only the iOS module and its license. The significant-time listener
   invalidates the provider, reconciles once, and rearms the day-boundary timer.
   Old binaries and non-iOS platforms have a safe no-op adapter.
4. Red evidence: the user-flow test initially accepted a 181-character draft;
   native adapter regressions initially leaked injected native error details.
   On-device reproduction was attempted before the fix but interrupted by a
   stale development client. The native acceptance check after rebuilding passed:
   181 characters showed the 180-character error and retained the editor;
   correction to 180 returned the reminder draft row; discard retained existing
   boards. Screenshot: `.artifacts/pre-fork/reminders/invalid-draft.png`.
5. Independent final GPT-5.6 Sol verdict: APPROVE, no required findings. Reviewer
   ran six suites (115 tests), typechecked, inspected the isolated full validation
   (484 tests across 35 suites, core 100 percent on all metrics), and reviewed
   listener lifecycle and transaction compensation. The verifier was not an author.
6. Native build passed on iPhone 17 Pro, iOS 27, device
   `93EEF062-B4DC-4989-AF77-CF47EE2A9816`, Metro 8082. Argent read-only evaluation
   confirmed the RipplesApple module is loaded and has one significant-time
   listener. Actual OS significant-time delivery has not been stimulated;
   that path has source, native-build, JS contract, and provider-test evidence.
   The final debugger registry was empty after an external teardown, so it is
   not claimed as an uninterrupted session-wide clean-log result.
7. Concurrent board, analytics, navigation, and icon-picker changes appeared
   during this work. They were preserved and excluded from the scoped reminder
   commit and isolated gate. The other session subsequently committed them;
   combined validation passed 490 tests. Their later spec amendment is recorded below.

### 3.8 - repository privacy audit (partial)

1. Removed three private screenshot artifacts under `.agents/evidence/` from the
   Git index, preserving all originals locally. Added scoped ignore rules for that
   evidence directory, exported bundles, and an explicit root export directory.
2. Existing rules cover `.artifacts/`, `design/ripples-screenshots/`, generated
   `ios/` and `android/`, and `.env.secrets.local`. `git check-ignore` verifies
   representative paths; `git ls-files` contains none of these private/generated
   paths after removal. Independent GPT-5.6 Sol hygiene review passed.
3. This is only the privacy portion of fork readiness. Product/native approvals,
   signed-device acceptance, and combined working-tree validation remain pending;
   `ripples-v1-fork-point` has not been created.

### 3.3 - artwork drafts and current gate

1. Created `assets/images/alternate-icons/midnight.png` and `paper.png`, with a
   provenance/status README. They are opaque 1254-pixel source images and remain
   unregistered pending human approval and native asset-catalog integration.
2. The other session committed its concurrent UI work as `d95f53b`, `5347144`, and
   `6f41870`. Combined `bun run validate` now passes: 490 tests across 36 suites,
   all required coverage gates, lint, and typecheck. The pre-fork changes have
   independent review; this entry does not claim independent review of that other
   session's UI work. Combined log: `.artifacts/pre-fork/combined-validate.log`.
3. This is a progress checkpoint, not pre-fork closure. Items 3.1, 3.2, 3.3 native
   integration, 3.4, 3.7, and the remaining 3.8 acceptance still need completion.
4. The other session subsequently recorded its user-authorized UI amendments in
   `SPEC-ripples-product.md` and `tasks/ui-polish-checkpoint.md` (`2481feb`), including
   fourteen-day home strips and the expanded symbol allowlist.

### 3.3 - alternate-icon infrastructure (partial)

1. Added native and platform adapters inside the existing RipplesApple module,
   safe fallbacks for older binaries and non-iOS platforms, and guarded selection
   in Settings. The persisted choice changes only after native confirmation.
   Platform failure keeps the previous choice; a settings-write failure attempts
   native rollback and provides a retry, including when rollback itself fails.
2. The adapter requires both expected icon registrations before enabling the
   three-choice UI. Independent GPT-5.6 Sol review caught and verified the fix for
   a partial-registration case that had incorrectly enabled a missing choice.
3. Validation: 506 tests across 38 suites, all required coverage gates, lint and
   typecheck passed; seven compiled Swift configuration checks passed. Sol's
   focused review passed 37 JS/UI tests plus the Swift checks, with no remaining
   selection or configuration findings. Native build passed on the simulator.
4. Argent confirmed the native methods exist and support returns false with no
   artwork registered. The real settings screen shows unavailable choices;
   screenshot `.artifacts/pre-fork/icons/unavailable.png`. Direct native selection
   of an unregistered name was rejected. Real switching and relaunch persistence
   remain unproven until approved artwork is registered in the generated catalog.
5. Generated artwork remains a draft. No plugin asset registration, alternate
   icon entitlement/signing changes, or human visual approval is claimed here.
6. Live native rejection exposed an SDK 57 two-string Promise rejection that
   lost its reason. Typed exceptions now provide explicit codes, reasons, and
   sanitized debug messages. Independent Sol review approved the correction;
   final rebuild passed, and Argent verified `supported: false`,
   `ERR_ALTERNATE_ICON_UNSUPPORTED`, and the exact intended safe message.
   Final Expo Doctor passed 21/21; generated native files remain untracked.

### Decisions recorded from the current request

- Apple developer membership exists; the signing team id, container provisioning,
  physical iPhone, and second signed target have not been supplied.
- CloudKit zone name: `habit-tracker`.
- Creating Midnight and Paper artwork is authorized. Drafts have been generated;
  visual approval is pending before native integration.
- Direct CloudKit operations, the Swift intent executor, and the three product
  spec amendments remain awaiting explicit approval.
- A correctness correction to the draft transport scope also needs approval:
  `.allKeys` can overwrite a newer server mutation before the JS engine fetches it.
  The deterministic fake preserves the greater mutation stamp. Real transport
  needs a server-stamp comparison plus `ifServerRecordUnchanged` conditional save
  to preserve that invariant under concurrent writes, without changing the port.
- Four reference board names are truncated in the supplied reference; full names
  and the five release link destinations have been requested.
- No native milestone deferral or fork-point tag is approved or recorded yet.

## Ripples product (SPEC-ripples-product.md) - stage checkpoints

### P1 - tracking core

1. Task id: P1 (tracking-core). Acceptance: shared SQLite source of truth with migrations, commands, queries, projections, HLC, receipts, outbox; approved dependencies installed via Expo Install; core coverage at 100 percent on all four metrics; real-engine tests.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/core/**` (domain, calendar, analytics, persistence, sync), `src/platform/database/**` (expo-sqlite adapter, app group path selection, composition root), `tests/product/**` (132-test suite over `node:sqlite`), `jest.config.js` (core 100 percent thresholds, reviewed type-only and adapter exclusions), `package.json` (focused scripts, product dependencies), `tasks/plan-product.md`.
4. Tests and static checks: 132/132; global coverage 99.67/99.55/98.72/100; `./src/core/` at 100/100/100/100; lint, typecheck, `bunx expo-doctor` 21/21, `git diff --check` all pass. Migration suite runs against a real SQL engine (`node:sqlite`) implementing the same port as `expo-sqlite`.
5. GPT-5.6 Sol review: fail on first pass with a deep findings list (DST wall-clock rule, amount-config retention, descendant outbox tombstones, gap-bridged streaks, seven-day thresholds, heatmap window edges, archived-board edit guards, void receipt replay, user_version placement, per-connection foreign keys, read-transaction snapshots, branded command ids, lint boundary). All items remediated with dedicated regression tests (142 tests, core back at 100 on all four metrics); focused re-reviews passed, including the dedicated-write-connection foreign-key design and per-period outbox rows.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), tests type: relaunch, root route visible (await 40 ms), log registry 0 entries. Product UI lands in P2; the core has no visible surface yet.
7. Notable in-spec decisions: `node:sqlite` (built into Node, no new dependency) provides the real-engine test database; the app group directory resolves through `Paths.appleSharedContainers` and falls back to the default location until the widget entitlement lands (P7); board-summary consistency uses a rolling 30-day window (the spec fixes the formula but not the summary-card window); `dismissMetricsEducation` added as a companion command for the settings-owned dismissal list.
8. Commit and push: `825d2cc`, pushed to `origin/main`.

### P2+P3 - boards, configuration, and history vertical slice

1. Task id: P2+P3 (one vertical slice). Acceptance: Boards home (cards, seven-day strips, quick check-in with 5s undo, accessible reorder), Board Detail (heatmap, summary metrics, education card, archived read-only state with restore/delete), create/edit sheets with live preview and shared draft, options screen, grouped check-in history, add/edit check-in sheets, settings sheet with archived boards, recovery states for invalid and missing ids.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/features/{boards,board-configuration,check-in-history,product-store,settings,ui}/**`, routes under `src/app/` (`index`, `boards/*`, `settings/*`, `_layout` form-sheet registration with detents), `src/platform/database/product-core.ts` (failed opens no longer cached), `src/testing/**` (render helpers, product-core mock over `node:sqlite`, `@expo/ui` datetime mock), `tests/product/features/**` (six suites), `jest.config.js`.
4. Tests and static checks: 234/234 tests at closure; the feature bucket clears the 90 gate on all four metrics after the core carve-out; `./src/core/` still 100/100/100/100; lint, typecheck, `git diff --check` pass; `bun run validate` exit 0 before every push.
5. GPT-5.6 Sol review: six escalating rounds, each fail remediated with regression tests before the next.
   - Round 1 (2 blockers, 8 majors, 2 minors): draft sessions owner-keyed (react `useId`) with route-id authority on save; check-in time stored as wall-clock time-of-day recombined with the selected date (historical default noon); board/check-in url mismatch rejected; archived boards reachable and history rows read-only when archived; form-sheet registration with detents plus `usePreventRemove` dirty guards; quick-pending as a set with surfaced undo failures; 44x44 pressables; heatmap dot/ring non-color markers; platform core stops caching failed opens; education gated on `metricsEnabled`; barrel imports; assertions strengthened (history, widget projection, outbox asserted after ui actions).
   - Round 2 (1 blocker, 4 majors, 2 minors): options routes validate their board segment against the live session; `endDraft` owner-scoped; picker's exact instant preserved for same-date saves (repeated dst hour); archived boards locked out of edit and check-in forms; failed opens close their connections; remaining barrel gaps; min-target enforcement made un-shrinkable.
   - Round 3 (1 major, 2 minors): archived boards never seed a draft session; the dst test uses the real november fall-back; barrel import in tests.
   - Round 4 (2 majors): a live edit that archives mid-session releases its session and converges to the lockout; shifted-day instants accepted by logical date, recombining onto the next calendar day inside the shift window.
   - Round 5 (2 majors): a spring-forward gap falls back to the logical day's start-of-day wall clock; note-only edits omit the occurrence so the stored instant, zone, and offset survive device zone changes.
   - Round 6 (1 blocker, 10 majors, 1 minor; scope widened to full stage conformance): amounts-off edits omit rather than overwrite amount configuration (retention regression the round-one fix had introduced); failed record loads surface instead of loading forever; date picker capped at the logical today; blank amounts rejected explicitly; detail quick action gains the five-second undo; failed detail queries render a retryable error and never misrender education; start-of-day gains a real draggable slider (`@expo/ui/community/slider` after the universal `Host matchContents` slider collapsed to a zero-length track on device); `/settings/archived` exists as its own route with retryable errors; check-in history pages by limit with whole-day trimming and true month totals for the 100,000-record requirement. Two reviewed deferrals: older heatmap-year navigation belongs to the analytics stage (the reference hosts year tabs in analytics), and the form preview reuses the shared symbol/strip/color renderers rather than the full board card (the reference preview shows no heatmap).
   - Rounds 7-9 (bounded confirmations of the round-six remediation): round 7 found the pagination boundary cases (a complete boundary day was discarded, an oversized day undercounted, no exhaustion guard); round 8 found the trimmed-boundary page stopping pagination prematurely and a weak exhaustion assertion; both remediated (overflow-row day comparison, oversized days completed via a per-day query, `hasMore` computed against true totals inside the snapshot, call-count exhaustion proof). Round 9: PASS with no findings. Stage 3 closed.
   - Independent self-review sweep (three parallel reviewers plus a device dark-mode sweep) fixed nine further defects: missing navigation dark theme (invisible sheet titles and light header pills in dark mode), palette row clipping at 44-point widths, heatmap scroll snapping on every re-render, silent reorder failures, unguarded detail quick double-tap, swallowed dismiss failures, heatmap window end-bound (core), future-year masking in year comparison (core), create-sheet reseed race, check-in conflict dead-end (keyed remount with parent-level notice), misleading untimed time picker, deep-link dead ends, and double submits during in-flight saves.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), interactive type:
   - dev build rebuilt (`expo run:ios`) because `expo-crypto`/`@expo/ui`/`react-native-svg` postdated the T7 binary; the stale binary's `ExpoCrypto` errors disappeared after rebuild.
   - walkthrough against `design/ripples-screenshots/`: home empty state -> Create Board sheet (live preview, palette, tint toggle, amounts section, reminder placeholder, options row) -> Options sheet (track time, start-of-day stepper stepping 12:00 AM -> 12:30 AM, metrics toggle, added Back control) -> save -> home card (tinted capsule, symbol, strip, quick circle) -> quick check-in (today bar filled, undo bar) -> detail (Mon-Sun heatmap with today cell, education card, Analytics/Check-Ins/Journal bar, quick button) -> Check-Ins sheet (`August` / `Aug 30` labels matching the reference after the month/day formatting fix) -> Add Check-in sheet (board pill, date row, note) -> settings sheet (Archived Boards section).
   - three same-day check-ins render the high-intensity ring marker on today's heatmap cell (non-color signal verified on device).
   - two real bugs found on device and fixed with tests: month header formatted a UTC instant in the host zone (showed `July 2026` for `2026-08`; now formatted in UTC with reference-matching labels), and the options sheet had no back affordance (added a header Back control).
   - `debugger-log-registry` after rebuild and walkthrough: 0 entries.
   - dark-mode sweep across home, detail, history, create sheet, options, and settings after the navigation-theme fix; the dirty-sheet discard guard and the draggable start-of-day slider verified live on device; blank sheet bodies observed twice reproduced only on hot-refreshed module state and never on a clean bundle (dev-only fast-refresh artifact, retested clean each time).
7. Notable in-spec decisions: reorder uses accessible Up/Down controls behind an Edit mode (drag handles land with a later polish pass); heatmap cells before board creation stay transparent per the eligibility rule; `defaultIncludeHiddenElements` stays on in Jest because the mocked screen stack leaves background sheets aria-hidden (on-device visibility is Argent's evidence, and visibility-critical assertions run directly after navigation).
8. Commits and pushes (incremental, one per unit, per direction): slice landed as 11 commits (`2fa5cb5`..`1a1e48c` plus `7770186`, `cdb95de`), followed by single-fix commits from the review rounds and self-review sweep (`f9734ca`, `d352713`, `50c5ce8`, `0ef01a2`, `cbf1a5d`, `8e56ce7`, `d8d5007`, `26abd95`, `67a3649`, `eda0590`, `9e36570`, `edebc02`, `2b8c4b1`, `c9a25c4`, `485e0dc`, `691fa67`, `58e7593`, `e8eb0ca`, `c8a03ce`, `b7c545b`), all pushed to `origin/main`.

# Checkpoints: native-foundation

Active module: `native-foundation`. Spec: `SPEC-native-foundation.md`. Plan: `tasks/plan.md`.

Evidence images live under `.artifacts/` or system temp paths and stay out of Git.

### P4 - analytics and journal

1. Task id: P4. Acceptance: analytics sheet (timeline chart, weekday distribution, year comparison, consistency, streak rows), journal timeline, svg chart primitives, honest empty/error/unavailable states, logical-year bounds.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/features/analytics/**`, `src/features/journal/**`, svg chart primitives, `src/core` queries (`earliestCheckInDate`, consistency band classification, streak window anchoring), routes `boards/[boardId]/{analytics,journal}`, `src/testing/react-native-svg.mock.tsx`, analytics and journal test suites.
4. Tests and static checks: full suite green at every push; core stayed 100/100/100/100; feature bucket over the 90 gate; lint, typecheck, `git diff --check` pass.
5. GPT-5.6 Sol review: fail on first pass with 11 findings; all remediated with regression tests (raw-percent consistency bands per spec line 130 (`765546f`), streak rows anchored to the window end (`2cb672c`), logical-year bounds and future-month masking with honest unavailable/empty/prior-year cards (`fd7cbba`, `b265f4d`), journal row accessibility label carrying the note (`458a2eb`), foreground query refresh (`b5a638a`)). The bounded confirmation rerun hung in the sandbox at 70 minutes, was killed, and its tighter rerun completed with the remediation standing.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`): analytics sheet walkthrough against the reference screenshots (timeline, weekdays, comparison, consistency, streaks), journal timeline with notes, log registry clean.
7. Notable in-spec decisions: rounding is presentation-only across analytics; months before the first check-in render as unavailable rather than zero.
8. Commits and pushes: `1d3b2a2`..`b5a638a` plus the remediation fixes above, one commit per unit, all pushed to `origin/main`.

### P5 partial - settings, export, and two-source import

1. Task id: P5-partial (settings + data transfer, user-directed). Acceptance: reference-matching settings sheet groups; export to a shareable versioned json file; import from this app's own export and from a real Ripples csv; notifications permission screen; explicit interim screens for icloud/app-icon/timeline; archived boards route retained.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/core/export/{serialize,import-parsers}.ts`, `importSnapshot` in `src/core/domain/commands.ts`, `src/platform/data-transfer/**` (File/Paths/Sharing/pickFileAsync, stale export cleanup), `src/features/settings/**` (settings screen groups, import screen states, notifications, release links), `tests/product/domain/import-export.test.ts`, `tests/product/features/settings-flows.test.tsx`, mocks for data transfer and notifications.
4. Tests and static checks: 290/290 at closure; core 100/100/100/100; lint and typecheck clean; `bun run validate` exit 0 before every push.
5. GPT-5.6 Sol review: fail on first pass with 14 findings. Remediated 13 with regression tests (`a8b4dca`, `42357b5`): raw tombstone-aware id existence checks so restores never abort on deleted records; restored periods sanitized (shape, order, overlap, open-last) with fallback to a derived lifetime period; per-record fail-soft own-export parsing; imported amounts through `validateAmount`; same-day future instants clamped to now; strict rfc-4180 quoting errors; full required csv column set; explicit error for unreadable non-empty archive dates; preserved order keys folded into the order-key high-water mark; forbidden-key leak scan over the serialized json; tombstone/amount/clamp regression tests; missing-link notice moved above the scroll; singular/plural import counts. One accepted deferral: production release links stay null validated behind `releaseLink()` because the real urls are missing release inputs (recorded). Bounded confirmation rerun: 10 findings FIXED, 4 PARTIAL, 3 NEW minors; every partial and new item remediated with regression tests in `8d576f2` (malformed period entries survive as invalid sentinels so the whole list is distrusted, preserved order keys outside the base-36 alphabet regenerate instead of poisoning the generator, a clamped future instant recomputes its offset in the record's own zone, a tombstoned check-in id on a live board skips through the raw existence check, and the notice-placement test asserts render order).
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`): full device round trip - export shared to Files, then imported back ("Added 0 ... Skipped 2 boards and 9 check-ins"); the real user-provided Ripples csv parsed in tests to 8 boards and 27 check-ins with unit and eligibility spot-checks (personal file kept out of the repo; a synthesized fixture is committed).
7. Notable in-spec decisions: `File.pickFileAsync` replaced `expo-document-picker` (no native rebuild); export excludes tombstones, receipts, outbox, and device identifiers by construction and by test.
8. Commits and pushes: `a7845b0`, `4522e56`, `530e9c7`, `b3b5969`, `7edb9ff`, `6cb5d4d`, `a8b4dca`, `42357b5`, all pushed to `origin/main`.

### P5 - reminders and notifications

1. Task id: P5 (reminders). Acceptance: reminder entity commands with just-in-time permission, weekday/time/message editor per screenshot 6, board form integration (saved boards and unsaved drafts), replace-before-cancel native scheduling with capacity validation, reconciler on cold start/foreground/archive/restore/permission change, notification tap deep links, Settings > Notifications with authorization/count/errors, reminders in export and import.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/core/domain/reminder-commands.ts` (create/update/setEnabled/delete/reconcile), `src/core/domain/ports.ts` (ReminderScheduler port), `src/core/persistence/repositories/reminders.ts`, reminder queries and notification overview in `queries.ts`, export/import extension (`serialize.ts`, `import-parsers.ts`, `importSnapshot`), `src/platform/notifications/` (expo-notifications weekly triggers, tap plumbing), `src/features/reminders/` (editor sheet, weekday helpers), board form reminder rows and draft commits, notifications settings screen, provider reconcile and deep-link wiring, notifications platform mock, reminders test suites.
4. Tests and static checks: 341/341; core 100/100/100/100; feature bucket over the 90 gate; lint, typecheck clean; `bun run validate` exit 0 before every push.
5. Notable findings and decisions: P1's archive/delete paths deleted `reminder_schedule` rows before anything could cancel the native requests they identified - both now keep the rows so the reconciler cancels through stored identifiers (orphan cleanup covers board deletes). A denied first save preserves the validated reminder disabled with scheduleState `denied` per the spec and never re-prompts. Permission prompts run before the exclusive transaction. Reconcile state changes never enter the outbox (device-local). The `ui` barrel's require cycle (index -> recovery -> index) was split into `primitives.tsx`.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), interactive type: edit board -> Add reminder opens the native half sheet (weekday chips M-S, time pill 9:00 AM, message placeholder "Check in to morning pages", repeat footnote); deselected Sat/Sun; save triggered the real iOS notification permission dialog (just-in-time), Allow scheduled the reminder; the edit sheet shows the row "9:00 AM / Mon, Tue, Wed, Thu, Fri" with an enabled switch (row layout stacked after a cramped first render); Settings > Notifications reports "Allowed" and "Enabled reminders: 1" with no schedule errors. Log registry: two stale fast-refresh reference errors from mid-session edits (absent after the clean reload) and upstream RNS/AnimatedValue warnings; the authored require-cycle warning was fixed.
7. Deferred within stage: significant-time-change reconcile trigger relies on cold-start/foreground reruns until a native listener lands with the widgets stage; DST repeated-hour behavior is delegated to the platform per spec.
8. Commits and pushes: `a699560`, `4aa8308`, `8d576f2`, `2eb81b6`, `4313d04`, all pushed to `origin/main`. GPT-5.6 Sol review completed 2026-09-07: APPROVE after remediation; see pre-fork item 3.5 above.

### P7 - iOS Home Screen widgets

1. Task id: P7 (widgets). Acceptance: expo-widgets extension over the App Group database, all four home screen families with per-family row budgets, symbol + truncated title + full accessibility title + seven-day strip + quick action per row, title deep-link to Board Detail, timeline entries covering the next logical-day boundary with a stale accessibility hint, empty state deep-linking to Create Board, widget reads only `widget_board_rows`.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `app.json` (expo-widgets plugin with the App Group, four supported families, App Group entitlement), `src/features/widgets/widget-props.ts` (projection mapping, per-family limits, next-boundary calculation), `src/platform/widgets/ripples-boards-widget.tsx` (the widget layout), `src/platform/widgets/index.ts` (timeline refresh, interaction listener), `src/platform/database/index.ts` (legacy database relocation into the shared container, busy timeout), provider wiring (refresh on every store change, day-boundary timer), `src/testing/widgets-platform.mock.ts`, `tests/product/features/widgets-slice.test.tsx`.
4. Tests and static checks: full suite green at every push; core 100 on all four metrics; lint and typecheck clean; iOS and Android exports succeed.
5. Notable findings and decisions, all found on device:
   - `createWidget` crashed with `ReferenceError: Can't find variable WIDGET_ROW_LIMITS`: the `'widget'` function runs inside the extension's own sandbox, so every constant and helper it uses must live in the function body. The layout is now self-contained (`617c793`).
   - The interactive-button quick check-in is **not** achievable through expo-widgets in this SDK: its App Intent performs inside the extension process (`openAppWhenRun: NO`, verified in the device log) and posts its interaction event to that process's own `NotificationCenter`, so the app never observes the press. Per the spec's rule for an action that cannot safely execute, the quick action deep-links to Add Check-In instead of silently doing nothing; writing in place needs the native executor. The app-side listener remains as the contract half (`5512a11`).
   - A row-level `accessibilityLabel` collapsed the whole row into one ambiguous element (`describe` showed the title link and quick action both reading "morning pages"). Each control now carries its own label and the strip reports "N of the last 7 days checked in".
   - Migration 2 hit `database is locked` when two app instances contended for the shared database; both connections now set `busy_timeout` (`5abb396`).
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`): widget added from the gallery in both small (1 row) and medium (2 rows) families; the home screen widget renders real App Group data (pink `morning pages`, green `Pray`) with correct strips; `describe` confirms three distinct labels per row; the quick action deep-links to Add Check-In for the right board and its save landed on the new logical date; the title link opens Board Detail; the App Group container holds `ripples.db` and the projection refreshed across the midnight boundary (`strip_end_date` advanced to 2026-08-31).
7. Deferred within stage: the in-place widget write awaits the local native executor (same native module as App Intents); recorded above with the device evidence for why.
8. Commits and pushes: `3217da2`, `617c793`, `5512a11`, `5abb396`, `0d81260`, all pushed to `origin/main`.

### P8 - private sync, automations, and android readiness

1. Task id: P8. Acceptance: provider-neutral sync records and transport port; one sync pass (zone, outbox upload, paged fetch, reconcile); HLC observation and lexicographic conflict resolution; tombstones that strip user content; change tokens persisted only with their records; idempotent upload; bounded jittered retry; the six status values with no raw provider detail; Settings > iCloud Sync with the pre-enable explanation; the three automation intents over one shared JSON fixture suite; android-safe stubs and an architecture note.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/core/sync/{transport,records,engine}.ts`, sync helpers in `src/core/persistence/repositories/support.ts`, migration 2 (`settings_mutation_stamp`), `getSyncSummary` in `queries.ts`, `src/core/automations/contract.ts` and `fixtures/intent-contract.json`, `src/platform/sync/index.ts`, `src/platform/android/adapters.ts`, `src/features/settings/icloud-screen.tsx`, `docs/android-readiness.md`, `tests/product/domain/{sync,automations,android-readiness}.test.ts`, `tests/product/helpers/fake-transport.ts`.
4. Tests and static checks: 413/413; core 100/100/100/100; feature bucket over the 90 gate; lint and typecheck clean; iOS and Android production exports both succeed.
5. Notable decisions: reminders ship their rule and enabled state but never `scheduleState`/`lastScheduleError` (device-local); activity periods travel as `boardId|startDate` because their local integer ids never leave the device; the settings singleton syncs only `metricsEducationDismissed` under the stable id `app-settings` and gained its own mutation stamp in migration 2; a tombstone's stripped value is whatever its column accepts (empty string for the `NOT NULL` board columns, null elsewhere) so a replica inserting a tombstone it never saw still satisfies the local constraints; the fixture's board ids are stable handles resolved per executor, not literal row ids.
6. Argent evidence: Settings > iCloud Sync verified on device - toggle off with Status `Off`, real queue depth (24 waiting), `Last sync Never`, the pre-enable alert naming the user's own private iCloud account, and after Turn On the honest `Needs Attention` status with the queue intact and a manual Sync Now.
7. Explicitly not in this release, with reasons: the CloudKit transport itself (`src/platform/sync` throws a typed `unavailable`) needs a local native module and a container entitlement on a signed Apple Developer build, so the spec's two-device sandbox convergence check is a missing release input; the native AppIntents executor (and with it the widget's in-place write) needs that same local Swift module; order-key compaction and the 90-day local tombstone purge are the spec's optional ("may") clauses and are not implemented; Android ships no Kotlin by design.
8. Commits and pushes: `8311e61`, `3845164`, `5abb396`, `77ddbbb`, `8ea45df`, `97fbebd`, `fb9304c`, plus the migration-ordering fix, all pushed to `origin/main`.
9. GPT-5.6 Sol review: fail on first pass with 3 blockers, 12 majors, 1 minor. The three blockers are the native gaps this environment cannot close (no CloudKit transport module, no signed Apple team, no AppIntents executor); the declarative half of the entitlements blocker was fixed by adding the iCloud container, CloudKit service, and ubiquity-kvstore entitlements to `app.json`. Every major and the minor were remediated with regression tests:
   - tombstones now strip user preferences as well as content (amounts, tracking flags, times, day shift, metrics, reminder rules), keeping only structural linkage and timestamps, with each column's stripped value chosen to satisfy its local NOT NULL constraint.
   - `SyncRecord.deleted` is authoritative when applying: a stripped tombstone whose timestamp was lost still dies (dated by the applying device), and a live record can never inherit a stale `deleted_at`.
   - the iCloud screen honors `retryAfterMs` with its own timer, and turning sync off bumps a generation token so an in-flight pass's result is dropped and no retry is armed.
   - the automation intents moved their resolution inside the command envelope: `createCheckIn` now reports the logical date it recorded, and a new `removeLatestCheckIn` command resolves its target inside the receipt, so a retry that crosses midnight replays the original outcome instead of picking a different record.
   - preflight read failures return an actionable `DomainResult` instead of rejecting, and Get Today's Check-Ins fails `not_found` for an archived, deleted, or unknown board rather than answering with an empty success.
   - the widget and sync platform entry points became `index.ios.ts` with android-safe `index.ts` fallbacks, so no android-resolved file evaluates expo-widgets or SwiftUI; a new test scans every production entry point (not just the stubs) for genuinely ios-only imports.
   - the fake transport now resolves writes the way a converging server must (greater stamp wins) and records refused stale uploads, so a client that uploads stale data is caught instead of masked.
   - migration 4 stamps and enqueues an existing metrics dismissal so upgraded data reaches first sync; the earlier ordering mistake taught its own lesson - renumbering an already-applied migration tripped the checksum guard on the dev device, and the fix was to keep applied history intact and add the new work as a later version.
   The orphan-dependent stall Sol flagged had already been fixed before the review finished (`8ea45df`): unapplicable records wait in `sync_deferred` and drain after each page.
10. Scale budgets: a new `tests/product/domain/scale.test.ts` seeds 100,000 check-ins and 1,000 boards and asserts the spec's shapes - history pages in whole days without materializing every row, analytics compute from aggregates, and the home projection reads one grouped query instead of one per board (an N+1 removed while writing the test).
11. Confirmation rounds and closure. Round 2 (13 items): 11 FIXED, 2 PARTIAL, 3 NEW - remediated by releasing the busy state on a failed disable, widening the readiness scan to `.android` files, adding a genuinely in-flight disable test, and fixing the shared `settle()` helper so timer advancement gets its own awaited act (the act warning appeared in every router test, not just the sync ones; it is now zero across all 440). Round 3 (5 items): 4 FIXED, 1 PARTIAL, 1 NEW - a failed disable cleared `busy` but left the status label reading `Syncing…` beside a live Sync Now; the status now resets too, proven by a test that breaks only the write path so the screen's own reads still work, and the in-flight test now asserts the engine's `retry_state` is unchanged after 900 seconds. Round 4: **PASS**, both items FIXED, no new findings. Stage closed at 440 tests, zero act warnings, core 100 on all four metrics, `expo-doctor` 21/21, and both production exports succeeding.
12. Honest read on where the defects clustered: every Sol finding in this stage landed in the sync and automation layer - the part built without a device to exercise it. The widget and reminder work, which was driven on the simulator throughout, survived review. That is also the argument for leaving the three native blockers explicitly unconnected rather than claiming they work.

### UI corrections - user-reported (2026-08-30)

1. Scope: board detail presents as a pushed screen (user correction of the earlier bottom-sheet request); the add/edit check-in sheet takes half the screen; the date picker no longer clips; check-in history uses a real native swiftui list with swipe-to-delete; glyph buttons centered; the habit-screen plus opens the Add Check-in sheet; heatmap cells colored by count.
2. Author: Fable 5. Device-verified end to end on the simulator.
3. Key findings: the native-stack `formSheet` presentation never paints its react content in this stack at any detent (react tree mounted, pixels and accessibility empty, clean bundle) - replaced by `@expo/ui/community/bottom-sheet` (native swiftui sheet, detents 50/100 percent, pan-to-close with a dirty-guard reopen) hosted in a `transparentModal` route; swiftui list rows use `HStack` + `contentShape` + `onTapGesture` because a swiftui `Button` tints the row and its plain style hit-tests only the label.
4. Tests: history-list fallback suite added (android path), swipe-delete and paging covered through the swift-ui mock; 290/290 with thresholds met.
5. Commits: `8aa5cc3` (superseded by the push correction), `9dd9dd1`, `05dcba8`, `b0a51ab`, `1d582d3`, `81c7559`, `2bbbb72`, `dfe5e3a`, `2ec9f92`, all pushed to `origin/main`.

## Open items at the end of the product build

Everything below is blocked on inputs or capabilities this environment does
not have. Nothing here is a silent omission: each has a visible, honest
state in the app and a test that pins that state.

### One local Swift native module (the spec's approved single module)

Four features share this dependency. The spec assigns all of them to it, and
none can be built or verified without a signed Apple Developer team:

1. **CloudKit sync transport.** The engine, provider-neutral records,
   conflict resolution, tombstones, deferral, retry, and status are built and
   tested against a deterministic fake (`tests/product/helpers/fake-transport.ts`).
   `src/platform/sync/index.ios.ts` throws a typed `unavailable`, so
   Settings > iCloud Sync reports `Needs Attention` and keeps every change
   queued. The spec's two-device convergence check needs signed builds.
2. **App Intents executor (Shortcuts and Siri).** The TypeScript executor and
   the shared JSON fixture suite are complete
   (`src/core/automations/`); the Swift executor must pass the same fixtures.
3. **Widget in-place quick check-in.** Proven on device to be impossible
   through expo-widgets alone: the button's intent performs in the extension
   process and its event never reaches the app. The widget deep-links to Add
   Check-In, which is the spec's rule for an action that cannot safely run.
4. **Alternate app icons.** `UIApplication.setAlternateIconName` belongs to
   this module. Settings > App Icon shows the three previews and says
   selection arrives with a native update.

### Missing release inputs

- Apple Developer team (blocks the module, the CloudKit container, and every
  signed-build check).
- Product and legal URLs: feedback, App Store review, more products, privacy
  policy, terms of use. `releaseLink()` validates them and the settings sheet
  shows an explicit missing-link notice above the fold.
- Alternate icon assets for Midnight and Paper.

### Deliberate non-implementations

- Order-key compaction after reconciliation and the 90-day local tombstone
  purge: both are the spec's optional ("may") clauses.
- Android ships no Kotlin by design - interfaces, android-safe stubs,
  contract fixtures, and `docs/android-readiness.md` only.

## Approvals log

- 2026-08-30: human approved the spec (recorded in spec).
- 2026-08-30: human ran the privileged Xcode license/first-launch step and said "Let's run it", approving plan execution.
- 2026-08-30: human approved the simulator equivalent for success criterion 3: iPhone 17 Pro on iOS 27.0 replaces iPhone 16 Pro on iOS 26.6. No iOS 26.6 runtime or iPhone 16 Pro device exists on this machine (installed runtimes: iOS 26.5, iOS 27.0).
- 2026-08-30: human approved three T2 dev-dependency deviations: `ajv@^6` (Bun hoisting fix for expo lint), `eslint@^9` plus `eslint-config-expo` (required by the approved lint script; eslint 10 breaks eslint-plugin-react), and `@testing-library/react-native` pinned to the v13 line (v14 async render is incompatible with expo-router 57 testing library).
- 2026-08-30: human approved the seven T7 captures as the visual baselines (light/dark top and bottom, forced fallback, AXXL interaction, increase-contrast plus reduce-motion). Replacement requires new human approval.
- 2026-08-30: human selected "product spec only" governance. `SPEC-ripples-product.md` (authored by a GPT-5.6 Sol session) specifies all modules after `native-foundation`. Thirteen per-module spec drafts produced the same day were discarded before commit. `CAPABILITY-MAP.md` updated to record the two-spec structure.

## T1 - simulator toolchain repair and argent preflight

1. Task id: T1. Acceptance: preflight commands succeed; Argent lists and boots the target; UDID recorded; equivalent approved if iOS 26.6 absent.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `checkpoints.md` (new), `tasks/plan.md` (new), `tasks/todo.md` (new, T1 items updated).
4. Tests and static checks: none applicable (no application code). Toolchain evidence:
   - `xcode-select -p` -> `/Applications/Xcode.app/Contents/Developer`
   - `xcodebuild -version` -> Xcode 26.6 (17F113)
   - root cause of the recorded preflight failure: stale xcrun cache plus an unaccepted license; human accepted the license, Fable 5 ran `xcrun --kill-cache`
   - `xcodebuild -license check` exit 0; `xcodebuild -checkFirstLaunchStatus` exit 0
   - `xcrun --find simctl` -> `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl`, exit 0
5. GPT-5.6 Sol review: fail on first pass (field 6 lacked structural and runtime-log entries; booted-state check blocked by verifier sandbox). Remediated, then pass on re-review (codex sessions 01a05130 and follow-up, 2026-08-30). Unresolved risks: none.
6. Argent evidence:
   - `list-devices` returned 30 iOS simulators plus 2 Android AVDs
   - selected target: iPhone 17 Pro, iOS 27.0, UDID `93EEF062-B4DC-4989-AF77-CF47EE2A9816`
   - `boot-device` -> `booted: true`
   - full-resolution screenshot 1206x2622 px at 3x scale = 402x874 pt, matching the spec viewport exactly
   - interaction performed: device boot and baseline screenshot only
   - structural result: not applicable - the app is not installed in T1; first launch and describe happen in T2
   - runtime-log result: not applicable - no app process ran in T1; the debugger log registry gate starts in T2
   - `xcrun simctl list devices booted` confirms the target is Booted (metadata check outside the verifier sandbox)
7. Deviations: simulator target replaced per Approvals log (human approved 2026-08-30).
8. Commit and push: `34a9874`, pushed to `origin/main`.

## T2 - dependencies, test harness, and repository hygiene

1. Task id: T2. Acceptance: approved dependencies installed via Expo Install; scripts added; jest harness green; lint, typecheck, coverage, doctor, diff-check pass; Argent smoke evidence.
2. Author: Fable 5. Delegated agents: none (spec drafting delegation this session was for the discarded per-module drafts, outside this task).
3. Files changed: `package.json`, `bun.lock`, `jest.config.js`, `tsconfig.json`, `.gitignore`, `eslint.config.js` (generated by `expo lint`), `app.json` (expo-image config plugin added by Expo Install), `src/testing/render.tsx`, `src/testing/expo-router-matchers.d.ts`, `tests/native-foundation/harness.test.tsx`, starter files `app/+not-found.tsx`, `components/EditScreenInfo.tsx`, `components/ExternalLink.tsx`, `components/useClientOnlyValue.web.ts` (minimal lint/type fixes; files are removed in T3).
4. Tests and static checks: TDD red recorded (module-not-found, then assertion failures), then green. `bun run validate` passes with 100 percent coverage on authored code. `bunx expo-doctor` 21/21. `git diff --check` clean.
5. GPT-5.6 Sol review: fail on first pass (ajv approval unrecorded; eslint and eslint-config-expo missing from package.json). Remediated: human approved the dependency deviations, eslint ^9 and eslint-config-expo pinned in package.json. Pass on re-review. Environmental notes from the verifier sandbox (watchman state dir, exp.host network) were confirmed non-issues in the author environment.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`):
   - `bunx expo run:ios` built, installed, and opened `com.ramimaalouf.habittracker` through the dev client (Build Succeeded, 0 errors). CocoaPods needs `LANG=en_US.UTF-8` on this host.
   - interaction performed: dismissed the first-run dev menu (Continue, then Close) with coordinates from `describe` discovery.
   - structural result: `describe` exposes the starter root route (Tab One title, tab bar, screen text) - the JS bundle loads from Metro.
   - runtime-log result: `debugger-log-registry` connected, 0 entries, no warnings or errors.
7. Deviations and notable decisions:
   - `@testing-library/react-native` pinned to the v13 line (13.3.3). v14 makes `render` async, which expo-router 57.0.17's testing library calls synchronously; v14 is therefore not "compatible current" for SDK 57.
   - `ajv@^6` added as a direct dev dependency: Bun hoists `ajv@8` (from expo-mcp's MCP SDK) and resolves ESLint's `ajv@^6` requirement to it, crashing `expo lint`. The direct dependency restores a v6 root resolution; the MCP SDK keeps its nested v8.
   - `tsconfig.json` gains `types: ["jest", "node"]` (TypeScript 6 does not auto-include @types) and `src/testing/expo-router-matchers.d.ts` declares the router matcher types expo-router ships empty.
   - The dev client build (`expo run:ios`) moved earlier than the plan's T7 slot so T2 through T6 can produce Argent evidence; T7 still owns full device validation.
   - Starter files received minimal real fixes (no rule silencing) to keep the commit green; they are deleted in T3.
8. Commit and push: `7bc374d`, pushed to `origin/main`.

## T3 - route migration to src/app and starter removal

1. Task id: T3. Acceptance: `/` renders stack title `Ripples` and selectable `Native foundation ready` with automatic inset adjustment; `+not-found` recovers; starter removed with no dead imports, routes, assets, or dependencies; alias `@/*` -> `./src/*`; `ios.deploymentTarget` 18.6.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/app/{_layout,index,+not-found}.tsx` (new), `tests/native-foundation/routes.test.tsx` (new), `tsconfig.json` (alias), `jest.config.js` (moduleNameMapper, `standard-navigation` transform allowlist), `app.json` (deploymentTarget, removed expo-font/expo-status-bar/expo-web-browser plugins), `package.json` and `bun.lock` (removed expo-font, expo-web-browser, expo-symbols, expo-status-bar); deleted `app/`, `components/`, `constants/`, `assets/fonts/`.
4. Tests and static checks: TDD red recorded, then green (4/4). `bun run validate` passes at 100 percent coverage. `bunx expo-doctor` 21/21. `git diff --check` clean. Typed routes regenerate from `src/app` (Metro restart required; log confirms "Using src/app as the root directory for Expo Router").
5. GPT-5.6 Sol review: fail on first pass (recovery test did not press the link; inset not asserted). Remediated with a behavioral recovery test and inset assertion; pass on re-review.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`):
   - before: `describe` of `/` shows `Ripples` title group and `Native foundation ready` static text.
   - navigation: `open-url habittracker://this-route-does-not-exist` deep-links to `Not found`; `describe` shows the recovery link; tapping it (discovery coordinates) lands on `/` with no stale back entry after the `replace` fix.
   - back behavior: in the pushed variant the header exposed the native `Ripples` back button (`id=BackButton`).
   - runtime-log result: `debugger-log-registry` connected, 0 entries.
   - final screenshot captured after recovery.
7. Deviations from the reference: none. Notable in-spec decisions: `+not-found` recovery uses `replace` so the unmatched route does not stay on the stack; Jest asserts the stack title and inset behavior through props because the native header and scroll insets render natively, with the on-device result covered by the Argent evidence above. The recovery test presses the link and asserts the pathname returns to `/`.
8. Commit and push: `04e3d99`, pushed to `origin/main`.

## T4 - semantic theme tokens

1. Task id: T4. Acceptance: one theme entry point at `src/theme/index.ts`; semantic colors with web-safe fallbacks; brand accent boundary; 4-point spacing; Dynamic Type ramp on the system font; continuous radius tokens; boxShadow-only shadows; motion tokens with reduced-motion policy; token invariants tested.
2. Author: Fable 5. Delegated agents: none (drafting delegation was considered and not needed).
3. Files changed: `src/theme/{colors,spacing,typography,radius,shadows,motion,index}.ts` (new), `tests/native-foundation/theme.test.ts` (new), `eslint.config.js` (no-restricted-imports guard so non-theme code imports `@/theme` only).
4. Tests and static checks: TDD red recorded (unresolved `@/theme`), then green. 16/16 tests, 100 percent coverage on all four metrics, lint and typecheck pass. Contrast invariants asserted in tests: label on background and grouped background, onAccent on accent, and onDestructive on destructive all meet 4.5:1 in both schemes.
5. GPT-5.6 Sol review: fail on first pass (shared hex literals not hoisted; ban-word grep matched comments). Both were prompt-literal findings, remediated cosmetically; pass on re-review.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), tests type: app relaunched, root route visible (`Native foundation ready` await succeeded in 96 ms), `debugger-log-registry` connected with 0 entries.
7. Deviations from the reference: none. Notable in-spec decisions: destructive light fallback uses `#d70015` (system red accessible variant) so onDestructive white meets 4.5:1; brand accent pair (`#2563eb` light, `#7cb3ff` dark) chosen to pass 4.5:1 against its on-accent colors.
8. Commit and push: `8548511`, pushed to `origin/main`.

## T5 - foundation components

1. Task id: T5. Acceptance: AppText, Icon mapping boundary, adaptive-material with platform files and identical geometry across branches, accessibility helpers, component tests by role and name, iOS-only imports isolated, no invisible surface on missing capability.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/components/foundation/{app-text,icon,material-geometry,adaptive-material-opaque,adaptive-material,adaptive-material.ios,adaptive-material.android}.tsx|ts` (new), `src/foundation/accessibility/index.ts` (new), `src/theme/colors.ts` and `index.ts` (normalizeScheme helper), `tests/native-foundation/components.test.tsx` (new).
4. Tests and static checks: TDD red recorded, then green. 31/31 tests; coverage 100/96/100/100 (all four at or above 90). Lint, typecheck, `git diff --check` pass.
5. GPT-5.6 Sol review: fail on first pass (icon queried by label instead of role plus name). Remediated with getByRole('image', { name }); pass on re-review. Recorded risk from review: resolver-level proof that an unsuffixed import resolves android-safely arrives with the Android export in T8.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), tests type: relaunch, root route visible (await 88 ms), log registry connected with 0 entries. Components render on-screen first in T6; their native verification happens there and in T7.
7. Deviations from the reference: none. Notable in-spec decisions: `expo-glass-effect` availability probe wrapped in try/catch degrading to blur; shared `adaptive-material-opaque` base keeps neutral and android boundaries identical; Icon uses `expo-image` `sf:` sources on iOS and accessible glyph text elsewhere; decorative icons are hidden from assistive technology.
8. Commit and push: `279091c`, pushed to `origin/main`.

## T8 - exports, coverage gate, and module closure

1. Task id: T8. Acceptance: iOS and Android exports succeed; final native build with the approved configuration installs and launches; every command gate passes; repository hygiene holds; all 22 success criteria confirmed.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `checkpoints.md`, `tasks/todo.md` (closure records only; no product code).
4. Tests and static checks: `bun run validate` 39/39 with coverage 97.19/93.54/93.18/100; `bunx expo-doctor` 21/21; `git diff --check` clean; `bunx expo export --platform ios` and `--platform android` both succeeded (`dist-validation/`, ignored); the Android bundle resolved with no iOS-only module failure, closing the T5 resolver-level risk; final `bunx expo run:ios --device <approved UDID>` built and installed with `ios.deploymentTarget` 18.6 (Build Succeeded, exit 0).
5. GPT-5.6 Sol review: fail on first pass (closure bookkeeping: missing T6/T7 hashes, unchecked todo items, self-hash paradox). All records remediated; pass on re-review, with the two-commit closure protocol confirmed sound.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), tests type: rebuilt client launched, root route described (`Ripples`, `Native foundation ready`), `debugger-log-registry` connected with 0 entries.
7. Deviations from the reference: none.
8. Commit and push: closure commit `9f54e9d` (`chore: close native-foundation module validation`), recorded here by the follow-up docs commit; both pushed together to `origin/main`.

### Success criteria closure (all 22 true)

1. `CAPABILITY-MAP.md` identifies `native-foundation`; the spec stays scoped to it.
2. `xcrun --find simctl` succeeds; Argent listed and booted the target (T1).
3. Human-approved equivalent simulator: iPhone 17 Pro, iOS 27.0, 402x874 pt verified (T1).
4. App installs and launches through the dev client with `com.ramimaalouf.habittracker` (T2, re-proven T8).
5. Routes load from `src/app`; `/` always resolves; `+not-found` recovers behaviorally (T3).
6. Starter removed with no dead imports, routes, assets, or dependencies (T3).
7. `/` renders stack title `Ripples`, selectable `Native foundation ready`, automatic insets, nothing else (T3).
8. `/foundation-preview` renders the seven ordered sections and every labeled fixture from deterministic data (T6).
9. Production-mode router test redirects `/foundation-preview` to `/` with no fixture rendered (T6).
10. `@expo/ui` controls render in a native Host with contract labels and changing values on iOS; Android-safe Host composition passes under mocks and the Android export resolves cleanly (T6, T8).
11. Glass runtime reports and renders `liquid glass`; `material=fallback` reports and renders `blur` with identical geometry (T6, T7).
12. Light and dark full-resolution captures show every section with no clipping, overlap, missing material, or unsafe insets; custom contrast pairs meet 4.5:1 by token tests (T7).
13. At font scale 3.143 every section stays reachable and operable with no clipping after the line-height refinement (T7).
14. `describe` exposes the title, five labeled controls, enabled/disabled/selected/value states, and the 0 -> 1 action count (T6, T7).
15. Reduce Motion keeps state changes immediate; no authored decorative animation exists; reduced-motion policy unit-tested (T4, T7).
16. `expo run:ios`, the iOS export, and the Android export all succeed (T8).
17. All command gates pass with coverage at or above 90 on all four metrics (T8).
18. Debugger log registry shows no authored warning, error, or unhandled rejection at any checkpoint; no upstream warning needed approval.
19. The screenshot diff contains only explained regions; baseline creation carries recorded human approval (T7).
20. Every task has a Fable 5 checkpoint, an independent GPT-5.6 Sol pass, and Argent evidence.
21. Isolated lowercase conventional commits, no signatures or co-authors, pushed to `origin/main` after gates: `34a9874`, `7bc374d`, `04e3d99`, `8548511`, `279091c`, `41de0c3`, `fa1e443`, plus the T8 closure commit.
22. `git ls-files` contains no private screenshot, `.artifacts/`, `dist-validation/`, or generated `ios/`/`android/` entry (app icon assets are public app resources).

## T7 - development client build and full device validation

1. Task id: T7. Acceptance: full light and dark captures of the preview, forced-fallback comparison, Dynamic Type at an accessibility size, Reduce Motion and Increase Contrast via the Settings app, clean runtime logs, screenshot-diff harness, human-approved baselines.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/components/foundation/app-text.tsx`, `src/theme/typography.ts` (lineHeightFor policy), `src/theme/index.ts`, `tests/native-foundation/theme.test.ts`, `tests/native-foundation/components.test.tsx`, `checkpoints.md`.
4. Tests and static checks: 39/39 tests, coverage 97.2/93.5/93.2/100, lint, typecheck, `git diff --check` pass after the refinement.
5. GPT-5.6 Sol review: pass on first pass (refinement code sound, tests and gates green, checkpoint chain internally consistent, baselines present and gitignored; on-device pixels rest on the recorded evidence).
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`):
   - light and dark full-resolution captures of the top and bottom preview regions; forced fallback capture (`Material: blur`, `Material mode: fallback forced`) with identical surface geometry to the glass capture.
   - visible refinement iteration 1: dark capture exposed text with no semantic color (invisible on black). Fixed AppText to carry `semanticColor('label')`; re-captured both appearances.
   - visible refinement iteration 2: at `accessibility-extra-extra-large`, fixed token line heights clipped glyphs and broke wrapping. Introduced `lineHeightFor` (token rhythm at scale 1, platform line height when scaled); re-validated: all sections reachable by scrolling at font scale 3.143, no clipping or overlap, `Primary action` tapped at AXXL and `Action count` reached 1.
   - Reduce Motion enabled through the Settings app (discovery-driven taps only); preview reports `Reduce motion: on`; state changes stayed immediate; Increase Contrast enabled the same way with a visual checkpoint capture; both settings restored and `Reduce motion: off` re-verified.
   - `debugger-log-registry`: 0 entries at every checkpoint. One reconnect was needed after the host network changed mid-session (dev server IP moved); the dev client reattached through the launcher, which is environmental, not authored-code behavior.
   - screenshot-diff harness: current vs the light-bottom candidate returned 0.46 percent mismatch in two explained regions (header back-button state differs by navigation entry; text antialiasing on one label). No unexplained region.
   - appearance and content size restored (light, large) after the checkpoint.
7. Deviations from the reference: none. Approved baselines (human approval 2026-08-30, see Approvals log): `.artifacts/argent/native-foundation/{light-top,light-bottom,dark-top,dark-bottom,light-fallback,axxl-interaction,increase-contrast-reduce-motion}.png`. Baseline images stay ignored by Git.
8. Commit and push: `fa1e443`, pushed to `origin/main`.

## T6 - foundation preview route

1. Task id: T6. Acceptance: `/foundation-preview` renders the seven ordered contract sections with labeled fixtures from deterministic data; `material=fallback` forces the fallback branch; `Action count` increments through the haptic path; production mode redirects to `/`; coverage stays at or above 90.
2. Author: Fable 5. Delegated agents: none.
3. Files changed: `src/app/(dev)/foundation-preview.tsx`, `src/foundation/validation/*` (fixtures, section wrapper, seven section components, screen), `src/foundation/haptics/index.ts`, `src/foundation/accessibility/use-reduced-motion.ts`, `src/testing/expo-ui.mock.tsx`, `jest.config.js` (mock mapping, testing-infrastructure coverage exclusion), `tests/native-foundation/foundation-preview.test.tsx`, `e2e/argent/native-foundation/foundation-preview-flow.md`.
4. Tests and static checks: TDD red recorded (6 failing), then green. 37/37 tests; coverage 97.1/93.1/93.0/100. Lint, typecheck, `git diff --check` pass.
5. GPT-5.6 Sol review: fail on first pass (tests under-asserted the contract), fail on second and third focused passes (role-name association, unrecorded risk). Remediated each: exhaustive token and role assertions, testID-pinned slider/picker pairing, risks recorded. Final pass on re-review.
6. Argent evidence (target `93EEF062-B4DC-4989-AF77-CF47EE2A9816`), interactive type:
   - `open-url habittracker://foundation-preview` renders the preview; `describe` exposes the title, `Material: liquid glass` (real glass on iOS 27), buttons `Primary action` and `Disabled action`, switch `Habit enabled` value 1 and `Disabled switch` value 0, slider group at 50 percent with `Intensity` label, picker button `Daily` with `Frequency` label, `Note` field, `Action count: 0`, and all four status lines.
   - tapped `Primary action` at discovery coordinates; `await-ui-element` confirmed `Action count: 1` (haptic path exercised on-device).
   - `debugger-log-registry`: 0 entries.
   - screenshots auto-captured with each interaction; full-resolution baselines happen in T7.
7. Deviations from the reference: none. Notable in-spec decisions: `@expo/ui` receives a reviewed behavior-focused Jest mock (`src/testing/expo-ui.mock.tsx`) because jest-expo ships none and the real package needs the native ObservableState runtime; test infrastructure under `src/testing/` is excluded from coverage as a reviewed exclusion; the accessibility section labels the forced-fallback state `Material mode:` so material status text stays unique per section. Accepted risks from review: the universal `@expo/ui` Slider and Picker expose no accessible-name prop, so their name association is the adjacent text label pinned by real testID props in tests and confirmed by the Argent describe evidence; Jest mocks cannot prove native Host rendering or the native accessibility tree, which rest on the Argent evidence in field 6 and the T7 device validation.
8. Commit and push: `41de0c3`, pushed to `origin/main`.

### T17 - coin balance and virtualized history (2026-09-08)

1. The Boards trailing header now opens Coins through an accessible integer
   balance pill before edit and plus. Coins shows available balance, raw earned
   and spent totals, an explanation of reversals/adjustments, Coin History and
   the temporary reward placeholder. Negative balances retain their sign and
   explain that future earnings pay them back. Loading and errors never invent
   zero balances. Existing board check, Undo and navigation remain intact.
2. History uses a native virtualized SectionList, newest stored logical date
   first and then descending timestamp/id. It displays every immutable row,
   distinct reversal/restoration/correction/cancellation explanations and claim
   title snapshots. Archived, deleted, empty-title tombstone and missing parent
   references remain readable. Stored dates format directly, including early
   years, without timezone reassignment or Date.UTC year remapping.
3. SQL totals return one aggregate row and validate exact integer text before
   converting to supported JS numbers; excessive totals report capacity rather
   than rounding. SQLite integer overflow remains a query error. The history
   reader projects only display fields, uses the existing history index and
   tuple keyset pages with one lookahead row, then resolves at most one page of
   metadata in the same snapshot. It never loads notes, actions or proof blobs.
   No schema change or new native binary is needed.
4. Each page request belongs to a committed query generation. Duplicate
   end-reached callbacks share one request, failed pages retain rows and retry
   the same cursor, and old successes/failures/finalizers cannot replace refreshed
   data or release another request's guard. Date groups merge across page edges.
5. Thirty-seven real SQL tests cover raw sign totals, negative claims, precision,
   indexed/deep pages, tuple ties, absent parents, read failures and a two-connection
   WAL snapshot. Fourteen feature tests cover routed navigation, real Home
   check/Undo, seven-row bonus history, signs, labels, loading/error recovery,
   page boundaries and stale-request races. Independent review approves all
   source and passes an additional 180-row oracle across page sizes 1/7/50/100,
   mixed-case v4/v5 ids, binary ties and dates from year 0000 to 9999.
6. Final `bun run validate` exits 0: 107 suites / 1,670 tests, global coverage
   97.70/96.24/95.77/97.97 and all 72 core files at 100 percent. Native gates
   remain green at 9 plugin and 131 Swift tests. `git diff --check` passes.
   Evidence: `.artifacts/t17/validate-main-final.log`, `native-main.log`,
   `core-acceptance.md`, `independent-acceptance.md` and focused/oracle logs.
7. Simulator testing first reproduced maximum-balance toolbar collapse, a
   split Spent amount at accessibility text sizes, a long history delta hiding
   its title, and two nine-digit totals overflowing at moderate text size.
   The pill now reserves room for the native controls and scales the complete
   signed integer; totals and history use vertical layouts when needed and
   constrained columns otherwise. Ordinary balances retain their normal size,
   full accessibility labels remain available and no amount is abbreviated.
   Presentation-only query overrides exercised extreme values without adding
   fabricated ledger entries. Each override was restored by identity before
   a real-state cold launch.
8. Actual signed-native QA preserves every prior T16 row and canonical ledger
   payload. A new ordinary-form Daily habit and Home Check/Undo change the pill
   8 -> 9 -> 8 and totals to earned 16 / spent 8. History shows both immutable
   entries and keeps earlier dates separate. All four reproduced visual issues
   pass their affected native rechecks; Edit/Create/Cancel remain usable. At
   the maximum signed integer the native Boards title shortens, while normal
   balances retain the full title and Coins displays the full amount.
9. Final cold launch has zero captured runtime log entries. All owned QA apps,
   Argent services and four QA simulators are stopped. The final backup has
   32 boards, 73 checks, 100 actions, 24 ledger rows, 34 periods, 325 receipts
   and 322 outbox rows; all T16 rows remain exact. Backup SHA256:
   `d90e0e57f38c9d139a28afc4f08cf935519854b0d3e9bb0b207ab1e8d2884f6b`.
   Fourteen additional receipts are successful no-op reminder reconciliations.
   Evidence: `.artifacts/t17/qa/qa-proof.md`, `verification.json`, `verify.py`,
   `after-shutdown.db`, final screenshots and accessibility captures;
   `.artifacts/t17/independent-layout-final.md` approves the final corrections.

### T18 - reward storage, claims and screens (2026-09-08)

1. T18a/b adds migration 10 (`5d0cab85`) and the matching Swift schema gate.
   Released migrations 1 through 9 remain byte-stable. The reward table stores
   user-defined metadata, bounded integer costs and safe timestamps, with an
   active-order index and no foreign key from immutable historical claims.
   Twelve migration cases prove empty initialization, retained schema-nine
   history, indexed ordering and rollback/retry at each later write boundary.
2. Reward leaf commands implement create, full-field update, reorder, archive,
   restore and tombstone deletion through the existing transaction/receipt
   envelope. Validation preserves code-point title limits, rejects unpaired
   surrogates and malformed runtime scalars, and normalizes approved styles.
   Equal or exhausted ordering keys trigger a deterministic transactional
   rebalance, stamping and queuing only affected active rows. Metadata changes
   never alter earlier claims or habit evidence.
3. Atomic claim preview reads the active reward and totals in one snapshot.
   A nullable projected balance represents insufficient funds without unsafe
   subtraction. Confirmation carries the reward stamp. Claim replays first,
   then checks active status, stamp and current affordable balance inside the
   acquired exclusive transaction. It appends one immutable debit and title
   snapshot with its outbox, HLC and receipt. Claims use acquired local midnight
   dates; replay retains the original date, title, cost and resulting balance.
4. Fifty-eight focused real-SQL tests cover scalar endpoints, query failures,
   a two-connection WAL snapshot, metadata lifecycle, ties, receipt replays,
   competing/queued claims, acquired clock/zone, stale confirmations and later
   write rollback. Independent review also passes 300 model-based ordering
   operations and two independently affordable claims merged to balance -1,
   preserving both rows after reward deletion. A malformed route array was
   reproduced before its parser guard fix and regression test.
5. T18a/b full validation exits 0: 110 suites / 1,740 tests, global coverage
   97.75/96.34/95.88/98.01, every one of 77 core files at 100 percent. Native
   gates pass 9 plugin and 131 Swift tests. The development build succeeds;
   its signing-only copy preserves AppIntent metadata and executable sections,
   with all 20 targets carrying the expected team and deep strict verification
   passing. The inherited ExpoDevLauncher ambiguous-script warning remains
   recorded for T24. Evidence is under `.artifacts/t18/`.
6. T18a/b actual in-place simulator migration preserves every prior T17 row
   and starts with an empty reward table. All 16 installed executables match
   the signed candidate. A fresh Count fixture created through normal forms
   earns through actual Shortcuts Check and reverses through Remove Latest;
   both actions use the intended title, policy and exact immutable source.
   A separately disclosed picker-selection mistake checked the prior synthetic
   T17 board; targeted public Undo reversed only that new check and retained
   its award/reversal pair. Both pairs net to zero and all older rows stay exact.
7. T18a/b final cold Home shows balance 8 with zero captured runtime entries. Owned
   apps/services are stopped and QA is shut down. The final database is schema
   10 with 33 boards, 75 checks, 105 actions, 28 ledger rows, 337 receipts and
   338 outbox rows. Its SHA256 is
   `54620ed44c78e5b08793cf7f1a65196909f929e4bf9715144ba7a8e132994b1e`.
   Evidence: `.artifacts/t18/qa/qa-proof.md`, `verification.json`, `verify.py`,
   `after-shutdown.db`; source, schema and independent core acceptance plus
   aggregate/native/build logs are in `.artifacts/t18/`.
8. T18c replaces the placeholder with one virtualized active/archived reward
   list, accessible separate Edit/Claim targets, ordering controls and native
   new/edit routes. Forms preserve Unicode titles, integer cost drafts and
   custom colors, with dirty-discard and conflict/reload handling. Metadata
   attempts retain their exact command and inputs across uncertain results.
   A transient read failure preserves unsaved fields; a terminal source read
   still permits replay of an already submitted update/delete receipt.
9. Claim state belongs to the product core, so duplicate taps, other rows and
   route changes cannot submit a competing attempt. Blur retires unsubmitted
   previews/confirmations; a submitted or uncertain claim retains its original
   command and reward stamp. Replay does not create a fresh preview or debit,
   including after reward deletion. Settlement invalidates current totals even
   when the originating view has left. Twenty-nine new routed cases exercise
   normal flows, conflicting edits, query freshness, cancellation, actual lost
   committed responses and exact receipt/table equality.
10. Native testing reproduced White row/form contrast, keyboard-covered custom
    color entry and invalid draft colors reaching native glyphs. Bounded fixes
    use semantic Claim text, saved-accent tiles with readable glyphs, validated
    display colors while preserving raw drafts, and documented keyboard insets.
    Each failure is retained beside its regression and native passing evidence.
    Full validation passes 116 suites / 1,769 tests, global coverage
    97.30/95.73/95.85/97.93, all 77 core files at 100 percent, and the separate
    noncore branch gate at 90.06 percent. Native sources remain unchanged from
    the passing 9-plugin/131-Swift gate. Independent reviews cover source,
    failure/retry oracles and actual visual corrections.
11. T18c actual form/claim/archive/restore/delete flows pass on the signed
    simulator. Cancel and invalid draft discard preserve every table. One
    confirmed cost-three claim produces the only new ledger row, -3; Home and
    Coins show earned 18, spent 13, balance 5. A saved cost of 100000 refuses an
    unaffordable claim and remains fully readable with large text/keyboard.
    Deletion preserves the original claim title/cost; exact public replay after
    deletion returns the original receipt without any database change. All
    prior 28 ledger rows and prior boards/checks/actions/periods remain exact.
    Final schema 10 has 33 boards, 75 checks, 105 actions, 29 ledger rows, one
    tombstoned reward, 356 receipts and 345 outbox rows. The stopped backup SHA256
    is `cb0bc70d2833b358ab6d3355719d9373df9c995e074e893333ef8e4fd2b1907b`.
    All 16 source hashes and 20 installed Mach-O hashes match; deep strict signing
    verification passes. Evidence and reproducible verifier are packaged under
    `.artifacts/t18/ui-qa/`; root reran the packaged verifier successfully.
12. The final cold Home/Coins/Home run has zero runtime entries and all owned QA
    devices are shut down. The full interactive log retains four
    `onAnimatedValueUpdate` listener warnings during archived-form navigation.
    Source review finds no app-owned Animated values/listeners and identifies
    a compatible React Native/native-stack listener-removal race, but the logs
    do not prove the exact native producer. No actionable T18 source defect or
    justified suppression was found. T24 retains this specific diagnostic
    investigation and final-runtime follow-up. T18 is complete; sync/export
    integration and release compatibility remain T19/T20 and Checkpoint C.


### T19 - immutable sync evidence and effective visibility (2026-09-08)

Status: local implementation is complete, including immutable admission, schema-2
transport integration and effective visibility, with independent review, automated
gates and signed simulator evidence below. Actual two-target CloudKit service
acceptance remains open; local runtime transport substitutes do not close that gate.

1. Migration 11 (`remote_fact_admission`, checksum `507c9875`) appends the bounded
   inbox and local suppression column. Its versioned `legacy_check_evidence` data
   step is covered by the checksum and runs after DDL, before both schema markers,
   inside the exclusive transaction. Released checksums 1-10 are unchanged. The
   Swift executor uses the same version/checksum and never migrates on its own.
2. Only explicit legacy migration, applied valid v1 sync and legacy imports establish
   zero-time, null-policy baselines. Generic raw-row inference is removed from app
   and native writers and bonus settlement. Complete surviving accepted tokens are
   intersected with current raw ID/board/date, and all effective history, journal,
   analytics, stack, widget and export readers respect the local visibility result.
   Suppressed payloads retain their private history and do not affect earnings.
3. The migration settles newly baselined scopes and every retained ledger scope,
   including bonus roots without live parents or new legacy checks. Mixed Daily
   migration and public export/parse/v1-import tests preserve the original +1 and
   append exactly one justified -1 correction. Replays preserve ledger identity.
   Accepted legacy imports never earn new coins.
4. Ninety-five migration/storage tests cover old fixtures, all old checksums,
   unknown descriptors, second-baseline/outbox and correction/visibility/marker
   failures, hashing failure, acquired enqueue time and two-connection atomic
   visibility. The rootless-history bonus case requires the exact independently
   specified correction. Storage tests exposed SQLite's embedded-null text-length
   behavior; an exact byte-length guard rejects hidden digest suffixes.
5. Full validation passes 121 suites / 1,823 tests, global coverage
   97.32/95.75/95.89/97.95, all 80 core files at 100 percent, and noncore branch
   coverage 90.06 percent. Nine plugin and 141 Swift tests pass. Native tests include
   actual old-schema fixture migration, rollback, both-kind file reopen/later genuine
   earning and exact visibility intersections. Independent review approves the final
   production sources and strengthened correction proof. Evidence is under
   `.artifacts/t19/foundation/`.
6. UTF-8 CocoaPods regeneration includes the new private visibility source. The
   generic build and signing-only copy pass; all 20 code targets carry the expected
   team and deep strict signature verification passes.
7. Actual in-place simulator migration preserves every original board, check payload,
   action, period, ledger row, receipt and outbox row; the original balance remains 5.
   Two isolated raw payloads stay hidden across cold reopen, Home/history/export/widgets
   and actual Shortcuts Today/Check/Remove. Each native check earns +1 and removal
   appends -1 without touching either pending payload or manufacturing a baseline.
   Four native receipt replays through public app commands are exact database fixed
   points. Two subsequent app checks earn correctly and remain visible after restart.
8. Final QA has 35 boards, 81 checks, 111 actions, 35 ledger rows, 37 periods,
   369 receipts and 367 outbox rows. The six synthetic ledger additions give earned
   22, spent 15, balance 7; all original 29 ledger rows remain exact. The stopped
   backup SHA256 is `05c265e8f8ba0f022f8f707caf1464f84b3a7ef3d028d13ee969670db3cc2d3d`.
   All 328 source hashes and 20 installed executable hashes match. Captured native,
   replay and final cold-navigation runtime logs contain zero diagnostics; a debugger
   timeout recovered without a database change. All four owned QA simulators are
   shut down. Evidence and reproducible verifier are in `.artifacts/t19/foundation-qa/`;
   root reran the packaged verifier successfully. This proves the foundation and does
   not establish schema-2 CloudKit or account/device convergence.
9. Immutable preparation and inbox storage are complete as a separate increment.
   Preparation snapshots the envelope and payload before hashing, preserves exact
   canonical bytes, and distinguishes bounded invalid diagnostics from operation
   capacity/hash failures. Inbox updates compare bytes after digest hits, preserve
   first-seen time, combine deferred import upload intent, and report durable state
   changes even without new occupancy. Final-plan limits include removals and all
   retained variants without eviction. Real SQLite tests pin 32,768 variants, exactly
   64 MiB and an additional single byte, rollback and close/reopen persistence.
10. Independent review reproduced and resolved async envelope mutation, oversized
    policy classification and unnecessary selector payload copying. Full main
    validation passes 123 suites / 1,855 tests, global coverage
    97.37/95.88/95.95/97.99, with all 82 core files at 100 percent. The existing
    9 plugin/141 Swift gate and signed foundation proof cover unchanged native
    sources; this uncalled preparation/storage increment adds no device behavior.
    Review and red/green evidence are in `.artifacts/t19/admission-preparation/`.
    Economic admission and sync/import composition remain subsequent work.
11. Shared ordinary-cause and correction validation helpers are extracted without
    changing formulas, UUIDs or TS/Swift fixture bytes. Prepared evidence snapshots
    unique typed facts before hashing. Each correction validates its own declared
    subset; cancellation requires a validated parent and a strict superset of that
    same evidence. Public reconciliation tests reproduce and fix swallowed hashing
    and abort failures. Independent review also reproduced copied-handle authority
    bypasses; exact issued-instance checks now reject copied parents or evidence.
12. The extraction passes 124 suites / 1,871 tests, global coverage
    97.39/95.90/95.96/98.00 and all 82 core files at 100 percent; 9 plugin and 141
    Swift tests also pass. Independent review
    approves the three-file implementation and confirms the caller must establish
    admitted exact-scope evidence before preparing it. Evidence is retained under
    `.artifacts/t19/validator-extraction/`. The reviewed period/backup additions in
    `docs/period-sync-compatibility-proposal.md` remain proposals awaiting user
    approval; no such schema or export change is implemented by this increment.
13. The iCloud screen now distinguishes local waiting, capacity-blocked and
    quarantined records from the upload queue, including while sync is off. One
    read transaction returns only aggregate counts. Failed reads show static,
    privacy-safe error text and Unavailable values, disable the toggle with matching
    accessibility state, and offer Retry. Routed tests reproduce the missing summary
    and database-read failure before the fixes, then prove recovery without exposing
    diagnostic payloads. Independent review approves the four-file increment.
14. Full validation passes 125 suites / 1,874 tests, global coverage
    97.39/95.93/95.96/98.00, all 82 core files at 100 percent, and noncore branches
    1,927/2,137. Native sources retain the passing 9 plugin/141 Swift gate. Actual
    signed-clone QA passes zero and 1/2/3 incoming counts, separate uploads 367,
    light/dark and accessibility-extra-large layout, transaction-local read failure,
    inert disabled toggle, reader restoration before Retry, confirmation Cancel and
    cold restart. All 331 recorded sources and 20 signed executables remain exact.
15. Clone QA preserves every original product/immutable/outbox/settings row and
    prior receipt, with balance 7. Exact additions are six presentation-only inbox
    fixtures and three enumerated reminder no-op receipts; 28 derived widget strips
    advance at the real day rollover. The original Migration QA database/WAL/SHM
    remain byte-identical and both devices are shut down. Root reran the packaged
    verifier in `.artifacts/t19/inbox-ui/qa/` successfully; final clone backup SHA256
    is `1bc8c85b29f9d29b727c904a9193878c3000ffe9fba4d687b5934a87a2387102`.
    Both scoped console captures are empty, but the complete native log retains one
    recurrence of the known animation warning, repeated across native/JS categories.
    It remains an explicit T24 diagnostic investigation; this UI proof does not claim
    a warning-free native process or completed remote admission.
16. Guarded hashing and scoped accepted-evidence reads are complete. The hashing
    adapter captures port methods/receiver, checks digest type/length, owns returned
    bytes and preserves provider causes outside semantic candidate classification.
    The reader returns bounded binary-ordered pages and explicit typed absences,
    including known wrong-role rows and historical evidence without live parents.
    It discovers exact-date root, former-member and proof relationships without
    hydrating unrelated payloads or performing accepted writes. Selected malformed
    storage fails as operation integrity, never candidate quarantine.
17. Independent review reproduced repeated JSON work across requested roots, members
    and retained proofs. Real SQLite regressions now prove unique-date/member-driven
    lookup: 100 same-date roots or reverse scopes require 500 policy/array reads
    instead of 50,000; 100 proofs open their arrays 100 rather than 300 times in the
    directed case. Binary paging, two-date pair isolation, a 1,201-selector indexed
    query, async input mutation and one caller-owned WAL snapshot are also covered.
18. This four-file increment passes 127 suites / 1,905 tests on main, global coverage
    97.43/95.98/96.01/98.03, with all 84 core files at 100 percent and independent
    approval. Native sources and visible behavior are unchanged from the preceding
    passing gates and signed UI proof. Red/green logs and review are retained under
    `.artifacts/t19/evidence-reads/`. These uncalled prerequisites do not yet perform
    economic admission; exact-scope planning and transactional composition are next.
19. Persisted inbox recovery now verifies canonical tuple fieldsets, exact bytes,
    selectors, baseline identities and digests before reconstructing facts. Rejected
    diagnostic JSON remains rejected, including signed zero that serialization
    converts to zero. Stored corruption fails the operation; guarded hashing causes
    escape semantic verdicts. Preparation and recovery share private canonical,
    baseline and digest helpers without changing formats or economic formulas.
20. The test-first recovery increment passes 128 suites / 1,917 tests, global coverage
    97.45/96.02/96.02/98.04 and all 84 core files at 100 percent. Independent review
    approves the two-file implementation, repeats 30 focused tests, and round-trips
    165 existing check/bonus/writer fixture rows exactly. Real file-database restart
    preserves retryable facts, quarantined diagnostics and deferred upload intent
    without accepted writes. Evidence is in `.artifacts/t19/inbox-recovery/`.
    Native sources and user-visible behavior retain the previous passing gates;
    this is a prerequisite for the still-incomplete admission composer.
21. The separate native animation probe attempted one exact-process debugger attach.
    It stalled at `task_for_pid` and was cancelled before logpoints or trigger
    navigation ran. No native trace or permission-denial cause was established.
    Preserved source/executable/original-database checks pass; the clone retains
    all prior data plus one enumerated startup reminder no-op receipt. Devices are
    shut down and debugger processes stopped. The relocatable verifier passes in
    `.artifacts/t24/animation-probe/`; the warning's cause remains unresolved.
22. Two public-command replica regressions reproduce a valid archive range being
    rejected after travel from Auckland to Honolulu moves the logical date backward.
    The receiving replica retained the old open interval and reported needs-attention.
    Removing the inbound endpoint-order restriction preserves the exact empty range,
    stamp and zero eligible days, with or without a prior download of the open range.
    Invalid calendar dates, v1 interval identities and mutable LWW remain unchanged.
23. The three-file period fix passes 128 suites / 1,919 tests, global coverage
    97.45/96.01/96.02/98.04 and all 84 core files at 100 percent. Independent review
    repeats 67 focused tests and approves the fix. Native code is unchanged; actual
    CloudKit convergence remains the later T19 gate. Evidence is retained under
    `.artifacts/t19/period-sync/`. This implements the already approved endpoint
    semantics and does not implement the proposed permanent interval identities.
24. Pure identity collation combines supplied facts, recovered inbox rows and accepted
    bytes while retaining every variant. Digest hits compare payload/encoding/byte
    length/selectors before duplicate cleanup. Restore intent combines only across
    exact matching variants. Accepted rows remain authoritative, diagnostics stay
    invalid, and prior quarantine stays terminal unless an accepted exact duplicate
    permits cleanup. Canonical alternatives without an accepted winner remain for
    intrinsic classification; shape-valid alternatives are not prematurely conflicted.
25. The two-file collation increment passes 129 suites / 1,929 tests, global coverage
    97.47/96.05/96.04/98.06 and all 85 core files at 100 percent. Independent review
    repeats ten focused tests and probes Unicode claim bytes, frozen inputs, owned
    output and forced digest collisions. Evidence is retained in
    `.artifacts/t19/identity-groups/`. This pure step performs no admission, SQL,
    hashing, HLC or upload work; native sources and visible behavior remain unchanged.
26. The pure exact-scope planner captures complete unique action/row knowledge,
    rebuilds actual ordinary generation from final actions, and classifies supplied
    awards, reversals, corrections and cancellations. Legitimate generated awards
    unlock supplied reversals; abandoned speculative awards cannot satisfy proofs.
    Correction proofs use their own complete subsets. The captured bonus validator
    shares source recovery only within one action context, avoiding repeated hashing.
    Actual 4,093-base actions plus two Daily checks and the final award fit 4,096;
    retaining a real additional partial award produces 4,097 and blocks the scope.
27. Independent review reproduced missing-first proof/reversal references hiding
    later known invalid roles, dates or hashes. Complete direct screening now marks
    known defects invalid before missing siblings can defer them. Incomplete proof
    subsets still never run economic validation. Final review passes 134 focused
    tests and 199 plans across 68 existing vectors with exact canonical ledger unions.
28. The five-file scope increment passes combined main validation: 131 suites /
    1,979 tests, global coverage 97.55/96.17/96.16/98.11 and all 87 core files at
    100 percent. Nine plugin and 141 Swift checks pass; shared fixture bytes and
    native formulas are unchanged. Main source hashes match the approved isolated
    candidate. Evidence is in `.artifacts/t19/scope-planning/`. The caller must still
    establish unique admissible identities, complete scope evidence and all mandatory
    cross-scope components before committing; a valid scope plan alone is not admission.

29. Whole-batch preparation captures every envelope, body, signed-zero diagnostic and
    provider method before the first await, then hashes sequentially in original order.
    Later caller mutations cannot change incoming evidence, and any failure returns no
    prepared prefix. Existing single-record and persisted recovery behavior is preserved.
30. Independent review verifies later baseline SHA-1 and SHA-256 failures, exact provider
    cause identity and mutation isolation. Full validation passes 132 suites / 1,983 tests,
    global coverage 97.55/96.17/96.16/98.11 and all 87 core files at 100 percent. Evidence
    is retained in `.artifacts/t19/batch-preparation/`. Native sources and visible behavior
    are unchanged; the prior 9 plugin / 141 Swift gate remains applicable.

31. Intrinsic variant classification is extracted from the scope planner without
    changing formulas or fixture bytes. Award/reversal decisions use unique captured
    source authority; correction proofs retain their declared subsets and cancellation
    accepts only a parent handle issued by that same evidence phase. No identity winner,
    generated row, scope budget or storage decision is made by the intrinsic factory.
32. Independent review reproduced an exactly referenced foreign award producing an
    operation error only when supplied directly. Both reference representations now
    classify that candidate invalid; malformed or mismatched caller-owned targets remain
    integrity failures. The final 149-test focused review and combined main validation
    pass: 133 suites / 1,998 tests, global coverage 97.57/96.19/96.18/98.12, all 88 core
    files at 100 percent. Evidence is in `.artifacts/t19/intrinsic-validation/`. Native
    sources and shared fixtures are unchanged; the 9 plugin / 141 Swift gate still applies.

33. The operation-lived fact loader completes exact identity groups, accepted absence
    and targeted quarantined siblings within one unchanged transaction snapshot. It
    returns only newly completed groups/selectors, pages complete scopes beyond 4,096
    facts, and captures raw bound hash methods before its first read. Repeated evidence
    compares exact bytes/metadata without rehashing; overlapping extensions serialize.
    Any extension failure is sticky until a new transaction and loader are acquired.
34. Independent review uses real SQLite to verify typed/BINARY identities, concurrent
    extension ordering and exact first-error identity. The author covers restart, WAL
    snapshot freshness and 4,097-fact paging in 31 tests. Combined main validation passes
    134 suites / 2,029 tests, global coverage 97.61/96.23/96.26/98.15 and all 89 core files
    at 100 percent. Evidence is in `.artifacts/t19/fact-loader/`. Native sources remain
    unchanged with the prior 9 plugin / 141 Swift gate applicable. The loader neither
    chooses winners nor expands economic dependencies or writes accepted facts.

35. Final immutable writes now execute a complete resolved plan within the caller
    transaction. Planned-new append equality aborts as an integrity contradiction.
    Exact typed ID/stamp queue tuples are deduplicated with one noncorrelated JSON
    membership query; existing queue duplicates stay intact and explicit restore can
    requeue after an earlier upload. Inbox finalization and synchronous cancellation
    checkpoints retain original failures and report only actual durable changes.
36. Nineteen real SQLite tests cover whole-plan snapshots, 1,201 desired tuples, late
    failures at five write stages, receipt/HLC rollback and retry. Independent review
    additionally proves a real late stored-payload collision rolls back earlier facts,
    outbox and HLC, then corrected retry survives reopen. Combined validation passes
    135 suites / 2,048 tests, global coverage 97.62/96.24/96.28/98.16 and all 90 core files
    at 100 percent. Evidence is in `.artifacts/t19/admission-writes/`. Native sources are
    unchanged and the prior 9 plugin / 141 Swift gate remains applicable. This stage
    consumes an already validated complete plan; the full resolver/composer is still
    in progress and this increment does not enable schema-2 transport.


37. A real sync/public-command reproduction found the maximum valid HLC counter
    producing a six-digit successor that sorted before the received stamp. TS and
    Swift now carry to the next wall millisecond; exhausted wall capacity throws
    before clock mutation and rolls back the command without a failed receipt.
    Independent review covers a 54-vector BigInt oracle and real SQLite commands.
38. Combined validation passes 136 suites / 2,052 tests, all 90 core files at
    100 percent and global coverage 97.62/96.24/96.28/98.16. Nine plugin and 146
    Swift checks pass. A freshly built development-signed simulator copy verifies
    all 20 native executables, Home carry, actual Shortcuts Check In / confirmed
    Remove / Today, receipt replay and whole-transaction exhaustion rollback.
39. Simulator evidence under `.artifacts/t19/clock-rollover/qa/` retains two
    harness mistakes explicitly: a stale system-picker selection on the first
    clone and a rolled-back seed followed by one legitimate additional Home check
    on the final clone. Neither is erased or counted as exhaustion proof. Corrected
    separately verified seeds prove rollback; every preexisting row remains exact.
    Supplemental `copy-qa/` proves the final readable Home error text with no
    product-row changes and two enumerated reminder no-op receipts. The artificial
    HLC is restored to the last legitimate value, balance is 9, the final stopped
    database SHA-256 is `8d26bf50445a9e883973393c6e3d8e1f2140a65a24a546c8188273969739d384`,
    and both relocatable verifiers pass. The original device and port 8081 remain
    untouched; owned services stop and all three devices are shut down. Existing
    ExpoDevLauncher build diagnostics and four nil-selection picker warnings are
    recorded for T24; this evidence does not establish CloudKit convergence.

40. Commands expose accepted-stamp observation through the same private HLC
    accumulator used for local allocation and final persistence. This prevents
    a future import observation from being overwritten by stale command state.
    Three real SQLite tests cover receive/write/receive order, observation without
    allocation, late receipt rollback, exact retry and replay before poisoned work.
    Independent review additionally queues a public create behind an observation.
    The exact combined source passes 137 suites / 2,055 tests, all 90 core files
    at 100 percent, global coverage 97.62/96.24/96.28/98.16. Evidence is retained
    in `.artifacts/t19/command-clock/`. Native source is identical to the verified
    9 plugin / 146 Swift clock candidate; no visible flow is changed by this seam.

41. The composed admission boundary now captures complete input before awaiting,
    loads exact identities and relevant scopes, resolves per-role evidence and
    mandatory components, and commits immutable rows plus retained upload intent
    inside the caller transaction. Generated identities are completed before use;
    monotone exclusions replan affected scopes without global graph enumeration.
    The caller retains ownership through visibility, clock, projections and markers.
42. Independent review covers 101 focused tests including six late SQL trigger
    failures, post-receipt failure, cancellation, mutation isolation and exact hash
    error identity. Four reordered real SQLite replica pairs converge after two
    exchanges to three actions / three ledger rows / balance 3; empty retries make
    no writes. This is local replica evidence, not live CloudKit acceptance.
43. Combined main validation passes 140 suites / 2,156 tests, all 92 core files
    at 100 percent, global coverage 97.78/96.42/96.45/98.25. Exact approved hashes
    and reports are retained in `.artifacts/t19/admission-composer/`. Native source
    remains the verified 9 plugin / 146 Swift clock candidate. This increment
    provides the shared sync/import boundary without activating schema-2 transport.

44. Local immutable recovery now runs before the iCloud enablement/account gate.
    One exclusive transaction admits retained evidence, settles coins and updates
    visibility, accepted-stamp observation and widgets without network state or a
    command receipt. Empty retries make no writes; cancellation and late storage
    failures roll back the entire pass and preserve the original hash error.
45. Settings resumes the coordinator after either successful toggle direction,
    so turning iCloud Off no longer permanently pauses local recovery. A routed
    real SQLite regression additionally reproduces recovery committing before
    both transport and retry-metadata persistence fail. The current-generation
    enabled error path now refreshes query state, preserving the saved award and
    displaying the actual incoming count. Disabled, retired and disposed failure
    guards remain covered. Public Retry preserves the original immutable rows.
46. Independent review and combined main validation pass 143 suites / 2,169 tests,
    all 93 core files at 100 percent, global coverage 97.82/96.45/96.51/98.28.
    Native source remains the verified 9 plugin / 146 Swift clock candidate.
    Exact final hashes, behavioral red and green logs, actual SQLite probes and
    independent reviews are retained in `.artifacts/t19/local-recovery/`.

47. Signed clone UI evidence proves actual On-to-Off recovery, Home/check history/
    Coins updates and cold preservation. The original QA verifier passes 89 checks.
    Supplemental actual On confirmation and Sync Now exercise committed recovery
    followed by guarded offline and retry-INSERT failures: incoming count reaches
    zero, balance reaches 8, and repeated retry adds no action, award or outbox
    duplicate. All original native transport methods are fail-closed during that
    interval, then restored by identity before cold launch. The supplemental
    verifier passes 94 checks. A Hermes debugger closure issue initially mislabels
    a per-method counter; preserved evidence distinguishes that interval from the
    corrected ensureZone-only attempt. No native transport execution occurred.
    All original product rows remain exact; the final stopped database SHA-256 is
    `55085f85b4d579cdf49bad71327c67a994d9ad877d9e92c142f3590d12500672`.
    Both QA clones and the original remain shut down, the original raw database
    files are unchanged, and source/native hashes stay exact. Existing framework/
    dev-client diagnostics are retained without suppression; neither QA run proves
    live CloudKit convergence. Supplemental evidence is under `error-qa/`.

48. Paired schema-2 prerequisites now define all eight entity mappings in
    TypeScript and Swift. Mutable semantic validation keeps explicit v1 defaults
    and final-version authority; immutable capture preserves conflicting and
    malformed bounded diagnostics for admission rather than granting economic
    authority. Outgoing tombstones use the reviewed privacy allowlists. The
    original v1 fixture and its strict unsupported-version behavior stay exact.
49. Native immutable upload paths require exact identity/content through grouped
    input, fetch, conflict retry, split batches and save acknowledgment. The new
    codec and iOS adapter bound indexed record capture, encoded rows and tokens;
    custom array iterators cannot bypass the record limit. The additive schema-2
    adapter is present, while the production default remains paired with the
    current v1 engine until the separate engine activation increment.
50. Independent reviews and the exact combined candidate pass 146 suites / 2,316
    tests, all 95 core files at 100 percent, global coverage 97.84/96.54/96.55/98.30,
    plus 9 plugin / 166 Swift checks. Fresh generated-native compilation includes
    both the new codec and Expo bridge for arm64 and x86_64. The development-signed
    copy verifies all 20 executable targets and preserves code and entitlements.
    Full build diagnostics remain recorded, including existing dependency and
    ExpoDevLauncher warnings. This is build/signing evidence, not live CloudKit
    or physical-device acceptance.
51. Wire evidence is retained in `.artifacts/t19/wire-prerequisite/`. The build
    package preserves its historical source manifest; the later JS-only
    coordinator error-refresh change and its routed test are documented as the
    reviewed overlay, with identical native source. Stable activity-period
    identity, anchor-cycle policy and final engine/service acceptance remain
    pending, so T19 and Checkpoint C are still incomplete.
52. Read-only device readiness was refreshed on September 9. Both known physical
    targets are currently unavailable and no two approved same-account sessions
    are verified. Simulator Mach-O entitlement sections declare the fork CloudKit
    container despite empty signature entitlement dictionaries; runtime container
    access remains untested. No account, device or sync operation was performed.
    Evidence is in `.artifacts/t19/cloudkit-readiness-2026-09-09/`.
53. The v2 board reader now rejects exact self-targets before parent dependency
    handling. A real public SQLite sync reproduction previously persisted an
    existing self-link and deferred a new self-linked board. Both now retain
    invalid diagnostics without changing product rows, actions, ledger, HLC or
    outbox; the existing invalid-page token advancement remains intact. Valid
    non-self and tombstone controls pass. This enforces the existing self-link
    rule and does not choose a multi-board cycle policy.
54. The matching native guard rejects live or archived self-links before cloud
    calls and prevents false acknowledgment of newer self-linked server rows on
    initial fetch, server-record-change and unknown-item retries. Bounded inbound
    diagnostics, tombstone normalization and v1 behavior remain intact. Independent
    cross-review, 146 suites / 2,319 tests, all 95 core files at 100 percent, and
    9 plugin / 169 Swift checks pass. Evidence is in `.artifacts/t19/self-anchor/`.
55. Fresh generic compilation includes the changed mapping, actual Expo bridge
    and codec on arm64 and x86_64. The separate development-signed copy verifies
    all 20 targets with code and entitlement sections preserved. Root reran the
    relocatable artifact verifier successfully: 76 checks. All 780 checkout hashes
    stayed exact throughout the build; the previous wire package is preserved.
    The full incremental build log retains 135 warning lines / 37 messages, none
    new against the prior inventory and none at an owned Swift source location.
    The lower count is not a warning fix. Build/signing evidence under
    `self-anchor/build-qa/` does not establish live sync or account access.
56. `docs/offline-anchor-cycles-proposal.md` now makes the pending multi-board
    cycle choice concrete: preserve raw LWW rows, ignore the outgoing link of
    each cycle's smallest binary ID in a shared TS/Swift effective graph, and
    explicitly allow those raw cycles through v2 restore. Self-links remain
    invalid. Independent document review passes, but user approval remains
    pending, as does the separate period/backup compatibility proposal. The task
    list distinguishes completed increments from the prepared engine and import
    recovery candidates; neither candidate is integrated or active in main.
57. Rami declined both additional compatibility proposals to avoid their added
    complexity, explaining that device use will mostly be sequential. The spec,
    plan and task list now exclude permanent period IDs, their migration/backfill,
    the proposed period/deleted-target backup fields, and automatic interpretation
    or restoration of raw anchor cycles. Migration 12 remains T21's local alerts.
    Both proposal documents are marked declined and retained only as historical
    design context. The first proposal concerned distinguishing archive/restore
    records during sync and restore, not primarily future model migrations.
    Existing self-link/cycle validation, atomicity and supported sync/import
    verification remain required; no declined guarantees or external acceptance
    are claimed. This decision supersedes the pending-approval status in item 56.
58. The active engine/default iOS adapter now use schema 2. All eight upload
    types read current rows and stamps; acknowledgments remove only selected
    outbox ids. Each received page captures owned input and commits mutable
    admission, immutable settlement, effective visibility, accepted HLC updates,
    projections and its token atomically. Earlier committed pages remain durable
    after a later failure. The explicit version-1 codec stays available for
    compatibility, with the original fixture unchanged.
59. A small shared repository guard rejects ambiguous board/start-date aliases
    before choosing a local period id, counting live and tombstoned rows. The
    affected upload batch or received page preserves its pending changes and
    token. Initial zone setup and earlier committed batches/pages may precede a
    later failure. Public travel tests reproduce two retained same-start periods;
    ordinary repeated same-zone/same-day archive/restore reopens one interval.
    The guard protects retained data without introducing new period identities
    or resolving the inherited sync ambiguity.
60. Strict graph admission uses the existing deferred-record machinery. Cyclic
    links, deleted/missing targets and a target deletion with a live referrer
    retain their exact candidate while the accepted acyclic graph remains usable.
    An actual greater link clear permits retry; no link is invented or cleared
    without its mutation. A candidate blocked by a newer deferred version gains
    no HLC authority. Independent public SQLite probes verify whole-page rollback
    on period/SQL failures. Two conflicting offline graphs need not converge
    automatically under this retained contract; the declined policy is absent.
61. The combined source candidate passes 153 suites / 2,397 tests, all 99 core
    files at 100 percent, global coverage 97.88/96.63/96.58/98.33, and 9 plugin /
    169 Swift checks. Independent period and graph reviews pass, including 29
    focused graph/period cases and two additional public rollback probes. The
    actual public graph reproduction changed from 21 failed / 20 passed checks
    to 41 passed checks. Evidence is retained under `.artifacts/t19/` in
    `engine-integration/`, `period-alias-guard/` and `strict-graph-guard/`.
62. The fresh signed simulator proves valid v2 ingestion, exact coin evidence,
    Needs Attention with a usable last-good graph, an unrelated earning check,
    explicit anchor-clear recovery, and an unresolved period alias without
    affected upload/fetch calls. All five runtime substitutions were restored
    while sync was Off before cold Home/Coins/history/Stacks checks. The final
    balance is 3. All 792 checkout, 34 native-source and 20 installed executable
    hashes stayed exact. Owned simulator/Metro resources were stopped; original
    migration data stayed unchanged. This uses a deterministic local transport,
    not actual CloudKit account/container access or service convergence. Root
    reran the captured-data verifier after preserving the package under
    `engine-integration/qa/`: all 102 checks pass. The package separately records
    two Settings presentation findings for correction, without treating them as
    functional sync failures or concealing retained framework diagnostics.
63. A later read-only inventory supersedes item 52: the iPhone is paired and
    reachable but locked; the scoped fork-build metadata query failed with the
    device-locked error. Its installed fork version remains unknown. The iPad is
    unavailable, and two approved same-account targets remain unverified. No
    app/account/data operation followed that check. Evidence is retained in
    `declined-scope/`. T19 and Checkpoint C remain incomplete.
64. Actual simulator inspection exposed two presentation defects: large-type
    details squeezed Status/Last sync labels, and semantic Needs Attention showed
    incorrect iCloud-unavailable advice. Informational Settings rows now stack
    label/value above the existing font-scale threshold; navigation/default-size
    behavior and accessibility associations remain intact. Availability advice
    now follows the availability result. Maximum-text inspection additionally
    exposed the separate toggle overflowing its card; its label now wraps beside
    the unchanged switch. Extra-large/maximum dark and default light checks pass,
    including the complete Last sync value and actual On/Off controls. Independent
    source review passes, and final main validation passes 153 suites / 2,399
    tests with all 99 core files at 100 percent. Core/native sources remain exact
    relative to the reviewed engine candidate. UI evidence is preserved separately
    under `engine-integration/ui-correction/` and `toggle-correction/`, retaining
    the original failures. Final cold state preserves all product/HLC/outbox rows,
    three coins and seven queued changes; only enumerated toggle/reminder receipts
    and retry metadata differ. All runtime substitutions were restored while Off,
    owned resources were stopped, and original data remains unchanged.

### T20 - backup compatibility and import recovery (2026-09-09)

Status: done. Request/receipt recovery and the paired export-format-2 restore
path pass automated, native, independent and signed simulator checks. T19's
actual two-target service acceptance and Checkpoint C remain open.

1. A submitted import now belongs to its ProductCore through the existing
   attempt-holder pattern. The controller captures the current complete draft
   before dispatch, immediately blocks duplicate submissions, and retains one
   command id across retryable errors, thrown/lost responses and route remounts.
   Current subscribers refresh even after an uncertain committed response. A
   deliberate new file remains a separate import through the terminal action.
2. Route ownership, preview identity and attempt-id guards ignore abandoned
   picker results, stale confirmations, stale retries and old reset callbacks.
   Public SQLite reproductions show the old response-loss retry created a second
   CSV copy; the corrected retry returns the original receipt and preserves the
   exact imported rows, HLC and outbox. The holder stays private and transient;
   it does not claim persistence across process termination or global CSV dedup.
3. The three exact previously reviewed files compose with the current schema-2
   engine. Six focused suites / 88 tests pass; a non-author independently reran
   all 14 routed recovery cases on that composition. Main validation passes
   154 suites / 2,413 tests with all 99 core files at 100 percent and global
   coverage 97.91/96.58/96.63/98.40. Native sources are unchanged from the green
   9 plugin / 169 Swift gate. Evidence is under
   `.artifacts/t20/import-recovery-candidate/current-integration/`.
4. The earlier signed simulator package remains preserved in the same artifact
   tree's `qa/` directory: 98 verified checks cover preview, remount/retry,
   intentional second-file import, restored runtime identities and cold state.
   Its two intentional copies produced two boards, four checks, four non-earning
   baselines and two receipts while preserving the existing seven-coin balance.
   This is historical sync-Off evidence for the exact three-file correction;
   later native self-anchor validation means the binary is not described as
   identical to the current build. Current composition tests and independent
   review cover integration without claiming format-2 or live-service acceptance.
5. That first increment changed no parser, export schema, import economics or
   database schema. The following paired v2 increment extends complete request
   capture to every new field, settings/reward value and immutable evidence input.
   Both declined period/graph proposals remain excluded; migration 12 remains
   local alerts.
6. Export format 2 is paired with its parser, acquired import transaction and
   confirmation/result screens. One export read snapshot includes effective live
   checks, date-only activity periods, all accepted action/ledger evidence, live
   rewards and shared settings. Immutable history is independent of live parents:
   a deleted reward's claim title survives, while cleared private notes do not.
   The spec records only the exact immutable-evidence metadata exception.
7. V2 restore preserves valid historical check values and exact period lists,
   validates the complete anchor graph, skips existing/tombstoned product ids,
   and uses T19's shared admission boundary in the same transaction. Valid
   shared settings restore only into an acquired empty, unconfigured store;
   existing settings stay unchanged. Genuine v1/CSV fallback remains supported,
   including approved corrections to existing coins without fresh import awards.
8. The shared capture boundary owns every nested input before an asynchronous
   wait. Receipt replay precedes replacement-input validation. Independent real
   SQLite probes exposed raw receipt-read errors; import now maps lookup and
   corrupt-JSON failures safely after rollback while preserving genuine stored
   receipts and ordinary callers. Checked summary arithmetic rejects overflow.
9. Eight new routed cases exercise the actual codec/transaction/screens, including
   exact exported bytes into a fresh provider, lost committed responses, nested
   draft/result mutation, retry/remount, settings restore/preservation and partial
   admission. Remaining history counts explicitly refer to this device. Legacy
   recovery/settings coverage remains green. No process-death attempt persistence,
   new period identity or automatic graph repair is introduced.
10. Final automated gates pass 159 suites / 2,490 tests, with all 101 core files at
    100 percent on all four metrics and global coverage 97.96/96.64/96.77/98.45.
    Lint and typecheck pass. A fresh native gate passes 9 plugin / 169 Swift tests
    without compiler warnings. Native implementation/configuration/dependencies
    are unchanged. Non-author review approves the complete composed source and
    tracked tests, with an exact 20-file pre-QA manifest.
11. Two fresh owned signed simulator stores exercise the actual source Export
    screen, native share sheet and cancellation, then destination Import using a
    disclosed picker-return substitute with the exact 13,347-byte source file.
    Source SHA-256 starts `ac7d999badb49d43`. The real import commits before a
    one-shot response loss; dismiss/remount/Retry retains the original complete
    input, receipt and summary even after nested draft/result mutation. Only two
    explicitly identified reminder no-op receipts differ in that retry snapshot.
12. The destination restores two boards, two checks, one live reward, six actions
    and eight ledger rows with zero generated awards. Earned 5, spent 3 and balance
    2 match the source. An actual Anchors edit changes Wake from 360 to 375;
    intentional repeat import preserves 375 and all immutable history. One
    malformed extra-field action creates exactly one quarantine, with readable
    whole-device status in dark enlarged text and no private sentinel leakage.
    Cold Home, Coins, history, Stacks and the live note pass; the cleared note
    stays absent and the deleted reward's claim title remains visible.
13. All runtime wrappers are restored by identity with persisted sync Off before
    cold checks. Guarded transport/availability counts remain zero. Both owned
    simulators and Metro 8082 are stopped; original Migration QA and protected
    resources remain unchanged. Source, native implementation and all 20 signed
    executables match before/after. The reused binary differs from its historical
    source only by a later TypeScript native-transport test, not native code.
    Stopped source/destination databases and the relocatable proof are retained
    under `.artifacts/t20/v2-integration/qa/`. Its verifier passes 244 assertions,
    including an independent root run from the relocated package.
14. Device logs retain 74 categorized native diagnostics and no animation-listener
    warnings in these captured streams; Metro retains color and tooling notices.
    This is not a zero-warning runtime claim. The inherited `ripples-export`
    filename remains a T24 cosmetic item. Native share presentation is verified;
    external file delivery and live CloudKit convergence are not claimed.

### T21 - local miss alerts (2026-09-09)

Status: complete. Storage/runtime, adapters, provider/Settings, private native
hooks and actual simulator evidence pass independent review. Aggregate
validation and native gates pass. A repaired signed build passes recursive library validation and actual cold
launch. Permission handling, registration, background native mutations, delivery,
warm/cold taps, exclusion and scoped cleanup pass. T19's live service gate and
Checkpoint C remain open.

1. Migration 12, `local_miss_alerts`, adds only board id, second missed date,
   nullable native identifier and the four approved statuses. The board/date
   primary key retains deduplication; status indexing supports local recovery.
   Status/identifier constraints distinguish denied, scheduled and unresolved
   work. Board tombstones preserve rows, and the foreign key has no cascade.
   Checksum `45bc5f98` is paired with the Swift schema-12 gate in this increment.
2. Migration tests start with a nonempty schema-11 store populated through public
   board/check/reward/claim commands. All prior data, evidence, coins, receipts,
   outbox and settings survive; only schema markers and the empty local table
   change. Five failure points roll back the entire new migration and retry.
   The first eleven checksums and schema-11 derived step remain unchanged.
   Existing migration tests now expect the latest final version while retaining
   their exact older-step rollback and evidence assertions.
3. Pure rules use active Daily boards, their own day shift and exactly the two
   preceding closed date labels. Both dates must be eligible and lack an effective
   check; an ineligible gap is never skipped. Inherited inclusive activity-period
   ends remain distinct from stack eligibility. The separate cancellation rule
   allows older truthful pairs but rejects checked, ineligible or reopened dates.
4. Deterministic local identifiers preserve board identity and date bytes. The
   pure notification intent targets civil 09:00 or foreground immediate delivery.
   A future native observation does not promote unconfirmed acceptance. Repository
   reads hydrate only requested pairs/dates and needed board/period fields; stale
   conditional writes cannot overwrite a newer status/id. Integrity failures use
   static errors, and there is no row-deletion helper or economic/sync write path.
5. Final foundation validation passes 162 suites / 2,565 tests, with all 103 core
   files at 100 percent on all four metrics. Global coverage is
   97.99/96.69/96.82/98.47; lint and typecheck pass. Native checks pass 9 plugin /
   169 Swift tests without compiler warnings. The native checksum test first
   failed against schema 12, then passed with the paired gate and strengthened
   maximum-version assertion. Evidence is under `.artifacts/t21/foundation/`.
6. Independent storage/spec review reruns 29 migration tests, including direct
   orphan rejection, no-cascade identity retention and export/wire exclusion.
   The pure/repository owner passes 67 tests with both new core files at full
   coverage; independent composition review is recorded with the final manifest.
   No UI or runtime scheduler is changed in this foundation, so these results
   do not claim notification registration, delivery or tap acceptance.
7. Runtime design preserves existing reminders, distinguishes native pending
   inventory from confirmed acceptance, and avoids awaiting SQL under the shared
   notification scheduling lane. Existing dated App Intents can invalidate or
   create missed pairs while JavaScript is suspended; their private post-commit
   integration is implemented in the runtime increment below.
8. Runtime reconciliation reserves local pairs before dispatch and retains consumed
   identity through cancellation and unknown results. Denied pairs remain terminal;
   proven fresh failures can retry. Future pending observations permit a bounded
   same-identifier refresh. The pending count joins distinct actual native IDs to
   retained local rows and reports unavailable inventory without inventing zero.
   Ordinary reminders and misses share a native effect lane with fresh capacity
   inspection; no SQL is awaited inside that lane.
9. The active provider coalesces mutation, foreground and significant-time work,
   retires stale generations and uses core deadlines. Count-only changes have a
   separate revision. Unknown initial AppState cannot authorize foreground alerts.
   Miss taps open the board; reminder taps retain Add Check-in. The exact two-key
   payload rejects inherited identities and malformed owned notifications without
   falling through to ordinary reminder routing.
10. Four existing native Check In/Remove Latest success and receipt-replay branches
    invoke best-effort affected-board reconciliation after the product transaction.
    Alert failures cannot replace a successful command result. Native and actual
    TypeScript writers share the same local CAS rules; a two-direction test uses
    both runtimes on the same WAL file. The shared literal fixture covers date
    policy, exact payload bytes and retained-row outcomes. Native checks pass
    9 plugin and 195 Swift tests with no compiler diagnostics.
11. Independent reviews approve core, concrete Expo adapter, provider lifecycle,
    native runner/store and actual UserNotifications adapter. Final validation
    passes 168 suites / 2,737 tests with all 104 core files at 100 percent; global
    coverage is 98.04/96.77/96.80/98.52. Lint and typecheck pass. All 31 frozen
    source/test/config paths match after the gate. Generated Pods exposed vendor
    tests/snapshots to Jest discovery; a reviewed exclusion retains all 168
    product suites and removes only generated native projects. A routed Settings
    timeout led to measured cold-load diagnosis and eager actual route imports
    during suite setup, preserving every interaction assertion and deadline.
12. A fresh generic simulator build passes after disk exhaustion was resolved by
    removing verified disposable caches from earlier owned builds. The current
    incremental output and all acceptance evidence were preserved. Development
    signing passes deep/strict for the actual 18 code targets; generated static
    React Native linkage accounts for the difference from earlier 20-target
    builds. The first real launch then aborts before JavaScript: precompiled
    ExpoModulesWorklets requires a dynamic React framework absent from that
    source-built composition. The crash is preserved; coherent native dependency
    rebuilding and actual simulator acceptance remain open. Compile/signing
    success is not treated as runtime acceptance. Build/dependency diagnostics
    remain recorded for final disposition. T19's live service gate, Checkpoint C
    and final closure remain open.
13. The existing local config plugin now records both supported source-build
    properties together, retaining pinned dependency versions. Ordinary CNG with
    all three related environment flags unset produces those properties; the
    generated app and widget Pod graphs select source React and source Expo Core
    and Worklets. The actual plugin regression failed before the mod existed,
    then passed with independent literal-oracle and property-preservation review.
    Full validation passes 2,737 tests with all 104 core files at 100 percent.
    The final native-only test refinement passes 10 plugin / 195 Swift tests and
    focused lint. The replacement generic build and development signing pass:
    eight actual code targets, 16 architecture pairs, unchanged executable code
    sections and zero unresolved required or weak libraries in both recursive
    audits. All 33 final functional source/test/config hashes match. The retained
    verifier passes 154 checks; actual launch/notification acceptance remains
    separate. The replacement cold launch reaches Home after correcting owned
    Metro's IPv6-only binding to serve the client's IPv4 URL. A fresh schema-12
    store and undetermined notification permission are observed; notification
    acceptance is still pending. The config repair is pushed as `50f8e3a`.
    SDK 57 prebuild defaults to clean unless `--no-clean`
    is explicit; only generated ios/Pods were regenerated, with prior apps,
    crashes, logs and DerivedData preserved. Full native compilation retains
    third-party diagnostics with no owned native source diagnostic or compiler
    error. Evidence is in `.artifacts/t21/runtime/coherent-build/`.
14. On the owned fresh simulator, an undetermined foreground pass retains the
    eligible pair as pending/null without prompting. The actual Add Reminder form
    produces the OS permission prompt; choosing Don't Allow stores the reminder
    disabled/denied and the missed pair denied/null, with no native request.
    Granting permission in iOS Settings leaves that denied pair terminal and
    creates no backlog. These observed cases precede the remaining delivery and
    tap acceptance; they do not claim completion of the entire runtime matrix.
15. With the disclosed product clock at September 10, 08:58, iOS stores two
    nonrepeating miss requests for September 10 at 09:00 alongside an ordinary
    Wednesday reminder. Settings reports Allowed, one enabled reminder and two
    pending miss alerts. Repeated foregrounding preserves all three identifiers
    and does not repeat either initial miss scheduling call. Actual OS time is
    unchanged; this proves calendar registration, not natural 09:00 delivery.
16. An actual dated Remove Latest Shortcut removes September 8 from a separate
    board while September 9 remains checked. The native runner creates that
    board's September 8 missed pair and a next-day 09:00 request; the controlled
    JavaScript clock would not qualify its different pair. An actual dated Check
    In then cancels the native request. Inventories are observed with the app in
    the background and no JavaScript schedule/cancel call in either interval.
    Runtime evidence remains under `.artifacts/t21/runtime/qa/`.
17. Notification Center displays the complete miss message and an actual ordinary
    reminder. Opening the miss reaches its board details; opening the reminder
    reaches that board's Add Check-in sheet, cancelled without saving. The
    Notifications labels and count remain readable at large type in dark mode.
    Actual OS time has not been advanced or a natural 09:00 firing claimed.
18. A distinct September 11 missed pair delivers immediately under the disclosed
    product clock. All 13 observed methods and both clock functions are restored
    by identity before terminating the app. The actual Notification Center Open
    action cold-launches the correct board on the real September 9 clock. Actual
    export output and all eight mapped schema-2 collections exclude local alert
    rows and native notification identifiers. Those collections yield 24 records
    across six populated types; reward and ledger collections are empty.
    Returning to Home after the cold tap does not repeat navigation. Final native pending/presented inventories
    are empty; iCloud remains Off and this non-earning fixture's ledger stays empty.
19. The owned simulator, app and scoped services are stopped. All 33 reviewed
    functional source/test/config hashes and eight installed executable hashes
    match. The original Migration QA database hash/mtime and shutdown state are
    unchanged; the protected simulator and Ripples Metro on 8081 are preserved.
    A stopped fixture backup is retained with SHA-256
    `376704d3de661d64ce15f735349247f5743e8612281feaf60d7339494b59e170`.
    Root reruns the relocatable offline verifier: 645 checks pass, comprising
    203 semantic/provenance checks and 442 retained artifact hashes. Independent
    simulator reviews pass 97 checks across permission/native and delivery/tap
    evidence. The final report and verifier are retained in
    `.artifacts/t21/runtime/qa/coherent-final/`. Cold delivery preceded termination;
    the actual Open action then launched the terminated app. The run does not
    claim delivery while terminated or natural next-day 09:00 firing.
20. The lossless native log retains 92 setup Error/Fault events and 21 after the
    first verified Home: eight focus-cache, eight loopback devtools, two nil
    Picker-selection, one UIScene, one sandbox-extension and one NSBundle
    nil-path message. No new coherent-build crash or `onAnimatedValueUpdate`
    event occurred. The invalid initial QA observer trace is separately excluded.
    Framework/build diagnostics remain bounded T24 follow-up; this is not a
    warning-free claim.


### T22 - deterministic sample and in-memory factory (2026-09-09)

Status: complete. Independent source review, full automated/native gates and
actual iOS correctness, memory isolation and disposal acceptance pass.
T23 sample navigation/effect isolation and the external T19/Checkpoint C gates
remain open.

1. One fresh sample runtime supplies a continuing deterministic ID stream and
   a private clock fixed at Toronto noon on September 9, 2026. Seed 22092026
   drives omissions across September 10, 2023 through September 9, 2026.
   Eight active habits include seven Daily and one Count; four required earning
   members form one same-date After-wake chain. Weekday rhythms and three longer
   breaks span all seasons and leap day. Count history records 25/45-minute
   sessions, including four checks against a cap of three.
2. The generator uses existing public board/check/remove/reward/claim commands
   in chronological order, with no raw seed, baseline fabrication, outer nested
   transaction or scheduler. All board policies and four rewards precede checks.
   Date labels resolve independently in Toronto; all recipe events occur after
   overnight DST transitions. Future-of-present checks are omitted and the clock
   returns to fixed noon on success or failure. A failed command stops population.
3. Actual leap-day completion, removal and recheck retain five check awards,
   two bonus awards and two reversals, net five. Twelve funded claims total 540.
   The final sample has 6,040 check payloads, 6,045 actions, 6,570 ledger rows,
   6,065 receipts and 18,676 outbox rows. Public totals are earned 6,556, spent
   542 and balance 6,014; spent includes the two reversal debits.
4. Root independently groups effective checks by stored date and cap, counts
   dates with all four required members, and subtracts actual funded claims.
   Its 6,038 net check coins plus 516 complete days minus 540 claims agrees with
   the ledger and public balance. Every check's intended Toronto date/minute
   passes an independent Intl check across all seasons; foreign keys hold and
   alerts/inbox/deferred state stay empty. Two host replays retain identical
   board/check/ledger digests, taking 5.326 and 5.510 seconds to populate. These
   are host timings, not Expo bridge or sample-screen readiness measurements.
5. The memory adapter opens exact `:memory:` with `useNewConnection: true` and
   no directory. One native handle and one queue own all SQL and both transaction
   methods; callback executors use that same handle directly. Failed BEGIN never
   rolls back; successful rollback permits later work. Failed rollback poisons
   both already queued and new SQL. Close stops new admission immediately,
   drains accepted work and retains one native attempt/promise even after error.
6. The factory allocates a new runtime/handle every call, applies all unchanged
   migrations through schema 12, populates once and returns the same clock/IDs
   for later commands. ProductCore is a type-only import. No real opener, file
   fallback, successful-core cache or effect provider is imported. Failure
   attempts disposal once and preserves the original result/cause; a rejected
   native close is not represented as successful disposal.
7. Tests first fail on absent modules, then on incomplete board/ledger/range/
   claim behavior. Actual SQL failures verify atomic command rollback and seed
   stop; unexpected port failure restores the fixed clock. Platform tests use
   the actual adapter over an intentionally unqueued native SQLite fake and
   forbid Expo's separate-connection transaction helpers. Two simultaneous full
   factories and a fresh reopen match the literal 19-table canonical fixture;
   only inherited migration `applied_at` is excluded. A public edit changes only
   its own store, all twelve checksums match, and each native handle closes once.
8. Independent root reviews approve the adapter, factory, generator and exact
   fixture. Final validation passes 170 suites / 2,766 tests, with all 105 core
   files at 100 percent on all four metrics; global coverage is
   98.06/96.80/96.82/98.53. Lint/typecheck pass. Native checks pass 10 plugin /
   195 Swift tests with no compiler diagnostics. A final one-byte comment-case
   correction changes no executable source and passes focused lint. Exact six-
   file freeze, reviews, first failures, gates and independent oracle are retained
   under `.artifacts/t22/implementation/`. Actual iOS acceptance follows below.
9. Actual Expo SQLite/Hermes acceptance uses the coherent signed T21 app on
   owned simulator 529C7A7D-AF6C-48D7-B719-2E293EED7CB1. The production factory
   loads through a verified module-only bundle without mounting sample UI.
   Both full factories match all 19 literal table hashes. A public board edit
   remains in A while fresh B retains the original recipe. Closing A twice
   closes one native handle and leaves B usable; both reject later work.
   The small rollback/queued-work probe and empty-memory control also pass.
   Four distinct memory handles open and close once each, with zero Expo
   transaction helpers and no real-store access during factory/edit intervals.
10. Native development-runtime startup takes 51.361 seconds for A and 50.221
    seconds for B with A retained. Startup performance remains a measured
    usability limitation for follow-up. Each database has 15,564,800 bytes of
    logical SQLite pages. Whole-app sampled RSS peaks are 691.31 and 747.81 MiB;
    after closing/releasing references, RSS remains 767,776 KiB at 5/15 seconds.
    These include the dev client, real Home, loaded modules and verification
    allocations; no isolated heap, physical footprint or leak claim is made.
11. All 22 QA wrappers restore by identity. Cold Home has the original boards,
    zero coins and no sample data. The final stopped backup is SHA256
    c148aa2da7e84d09859f4ccb1b1a2a66c3403590ddc4e76565eb348766085007.
    Every prior row remains exact; normal and cold startup add only two
    successful updated:0 reminder receipts. All 557 source paths, six frozen
    files, 85 native inputs and eight installed images match; signing and
    protected simulator/database/8081 checks pass. Owned resources stop and
    the source freeze releases. Source-versus-copy SHM hashes are separately
    recorded because making a logical backup updates the copied SHM index.
    No Error/Fault occurs inside either factory interval; retained framework
    and QA-observer diagnostics are disclosed in `.artifacts/t22/qa/REPORT.md`.
    T23 navigation and real-provider suspension are not claimed by this test.
12. Root independently reviews the actual native report and raw restoration,
    disposal and cold-housekeeping evidence, then reruns the relocated
    verifier: 306 checks pass. The measured startup cost is retained as a
    performance follow-up; no faster result or sample-screen acceptance
    is inferred from the host replay.

### T23 - isolated sample navigation and effects (2026-09-10)

Status: route/runtime implementation, automated gates, independent review and
the actual iOS sample matrix pass. Cold entry, accepted-work joining, preserved
real drafts, native sheets, exact suspended-store isolation, disposal and fresh
reopening have retained evidence. T19/Checkpoint C external gates remain open.

1. The first increment separates import-safe context/hooks and introduces
   a stable operation owner. A captured scope never becomes current again
   after suspension/resumption. Whole accepted operations retain their raw
   execution core through completion, while new work is refused. Suspension
   joins every accepted promise, including failures, before resumption.
   The stable UI core preserves per-core stores and cannot close its runtime
   database. Existing provider behavior and both query-hook bodies are
   unchanged; full public-index import isolation remains the next increment.
2. Tests first fail on absent modules. The focused suite passes 43 tests across
   seven suites with context/authority at 100 percent on all four metrics.
   Actual SQLite tests cover stale callbacks, rollback, acquired transactions
   and a public reminder operation held across its system permission prompt.
   The accepted reminder completes its native request, rows and receipt before
   the join resolves. Import traps reject real-effect module evaluation.
   Owned lint and composed typecheck pass. Root independently reviews all six
   files, tests and evidence and verifies their exact manifest. Native and
   domain executors are unchanged in this increment. Evidence is retained
   under `.artifacts/t23/implementation/`.
3. The public provider now defers real-runtime imports until its real branch
   renders. An explicit sample owner mounts ordinary product queries and
   commands without evaluating native notification, widget, sync, transfer,
   icon or real-opener modules. Sample effect controls are unavailable and
   the Notifications screen stops before permission, count or SQL hooks.
   Real foreground notification presentation now has explicit registration
   ownership. Real-provider unmount retires UI authority while accepted raw
   commands finish; actual StrictMode replay resumes only after drainage,
   with a new scope on the same core and no resume after final unmount.
   The focused provider suite passes 54 tests across ten suites with
   provider/context/authority at 100 percent on all four focused metrics;
   27 Notifications/Settings cases and 162 inherited adapter/provider cases
   also pass. Actual reds cover import-time effects, stale unmount authority,
   replay and the disabled body. Owned lint and composed typecheck pass;
   root independently reviewed and verified the exact source manifests.
   Full real-runtime suspension, route activation and native UI acceptance
   remain open in the following increments.
4. Board drafts and their subscribers now belong to each stable product core.
   A mount reserves its draft owner before the first read; old reads, Save
   results, options Back, archive/delete confirmations and unsaved reminder
   callbacks cannot replace or navigate a successor. A routed two-core test
   preserves the covered real form's title, options and reminder and saves
   only to its own SQLite store. Twelve new cases reproduce and prevent
   cross-core loss and stale callbacks; the focused suite passes 93 tests
   across eight suites, with lint and composed typecheck passing. The test
   observer captures the actual facade by its raw IDs-port identity while
   retaining raw SQL oracles. Root reviewed the production and test changes,
   requested the reproduced options Back correction and verified all ten
   final manifest hashes. Production sample routes remain unactivated.
5. The root sample session now joins the registered real host before opening
   memory and owns the sample operation authority before publishing ready.
   Close retires admission synchronously, waits for accepted work and scene
   removal, then disposes memory once before navigation and real resumption.
   Late opens never mount after Close; failed disposal remains retired with
   an observable error. External removal shares cleanup without replaying
   navigation. Independent review reproduced stale cleanup when a handle
   object was reused; per-registration tokens correct it, with paired real
   SQLite controls. Nineteen tests across two suites, owned lint and composed
   typecheck pass. The non-author review approves the four exact files.
   Actual presentation commit acknowledgement and route/runtime integration
   remain subsequent work; the controller alone does not establish those.
6. The sample presentation now renders loading, error and closing states with
   the persistent banner and Close, and mounts product scenes only after
   ready. Its retirement acknowledgement follows scene passive cleanup;
   accepted work still drains before actual memory close and the pinned
   route leave. Actual StrictMode replay opens memory once. A reproduced
   early-Close race no longer reopens the sample. Nine host and nineteen
   controller/context tests pass; one host case executes a public command,
   verifies its SQL, closes real Node SQLite and proves later reads fail.
   Independent review approves all three frozen files and adds passing
   scratch controls for early Close under replay and replacement during
   pending external cleanup. Owned lint and composed typecheck pass. This
   is React cleanup acknowledgement, not native animation completion or
   final route/chrome acceptance. Evidence is retained with the task.
7. Product navigation now scopes absolute destinations, dynamic parameters,
   query parameters and recovery redirects to the current sample navigator.
   Back at its root delegates Close; a cold nested route without inner
   history recovers to sample Home. Every navigation callback checks its
   original operation scope and route focus, preventing a reproduced old
   covered-screen Back from popping a newer screen. Ten actual nested-router
   tests and an independent removed/covered/resumed callback probe pass;
   both source hashes are independently verified, with lint and composed
   typecheck passing. Real destinations remain unchanged. This helper still
   awaits adoption by the production route graph and feature callers.
8. Check-in date/time pickers now use the product clock's zone for civil
   conversion, preserving untouched and selected repeated-hour instants,
   shifted logical days, minute precision and stored-zone note-only edits.
   Actual routed historical noon first reproduces incorrect UTC/Tokyo saves.
   iOS uses explicit-zone native instants; Android separates UTC selected
   dates, host-local bounds and presentation-only clocks when zones differ.
   Independent source review found Android bounds use a different native
   conversion from selected dates: a second routed red proved logical today
   was disabled. A host-noon bound corrects it. Final Toronto 47 tests across
   two suites and UTC/Tokyo 20 each pass, with lint/typecheck clean. Root
   reviewed both full files, installed native contracts and corrected bounds,
   and verified their final hashes. Core/calendar/schema and dependencies
   are unchanged; actual native picker interaction remains the final QA.
9. Real runtime suspension now joins startup, accepted UI work, native
   inspections, sync, widget publication and listener cleanup before sample
   creation. Existing real scenes and their stable core remain mounted;
   queries retain their values while paused and refresh under a new scope
   on resume. A cold sample entry stops before real-runtime module evaluation.
   Failed native cleanup keeps the host retired until remount, including on
   repeated entry attempts. The focused runtime candidate passes 103 tests
   across nineteen suites with lint/typecheck clean. Independent review
   reproduces and fixes a notification request lost at runner finalization;
   the corrected pass and disposal control bring its focused rerun to 23
   tests across three suites. Root reviewed all twelve manifest files and
   verified their hashes. Routes and native acceptance remain subsequent
   increments; the real database is never closed by this host.
10. Reward callers now join accepted preview, claim, retry, form and reorder
    operations through their captured scope. Retained drafts survive pause;
    uncertain results retry the exact command, and successful saves expose
    a fresh Done action without creating duplicates or stale navigation.
    Old prompts and covered-screen callbacks cannot adopt a successor. A
    routed regression also prevents a false discard prompt after a saved
    form resumes. Forty-one tests across seven suites and owned lint pass;
    root independently reviewed all six files, verified their final hashes,
    reran the preceding forty cases and confirmed composed typecheck passes.
    Core commands and the per-core claim store remain unchanged. Native
    presentation and the final route graph are still subsequent gates.
11. Analytics, Journal, Coins, Stacks and product recovery now use scoped
    navigation. Actual command-created notes, coin history and derived
    stacks keep their destinations under sample routes, while retired
    callbacks cannot navigate or change retained analytics year selections.
    Nine regressions reproduce first; sixty tests across eight suites pass
    with lint/typecheck clean. Root reviewed the seven production diffs and
    complete routed test, verified all eight final hashes and approved this
    caller increment. Production routes and native acceptance remain open.
12. Sample Settings now stop before native adapters or queries. Real import,
    export, icon, permission, account and system-settings actions use captured
    effects and join accepted work before sample creation. Focus ownership
    retires stale callbacks and foreground listeners. Exact import receipts
    and icon confirmation/compensation survive suspension; read-only app
    metadata no longer imports file/sharing effects. The focused candidate
    passes 102 tests across fourteen suites, with lint/typecheck clean. Two
    inherited permission fixtures then use the captured scheduler port;
    their broader rerun passes 91 tests across eight suites. Root reviewed
    all nineteen files, requested reproduced stale-scene fixes and verified
    final hashes. The author independently approved root's four-file native
    Settings port seam. Full routes and native acceptance remain open.
13. Board and check-in saves now join their full accepted commands and
    retain exact Retry or completed Done state across suspension. Sample
    board creation omits reminder dispatch. Independent review reproduced
    lost outcomes after resumed query failure/archive and native Back from
    clean pending forms. The corrected locked editor/result lifetime keeps
    those receipts accessible, rejects new edits and preserves definitive
    conflict reloads. Seventy-eight tests across four suites, lint and
    typecheck pass; root reviewed all final files and reran the four original
    scenarios with explicit SQL-state oracles. All final hashes match.
    Archive/delete/reminder callbacks and native route acceptance remain
    subsequent work.
14. Widget action callers stop sample entries before queries and scope
    their real snapshot, toggle, Undo and haptic work. Retirement cancels
    unanswered confirmation waits, suppresses stale callbacks and expires
    Undo ownership/timers. Seven new routed SQLite cases and eighteen
    inherited widget cases pass with lint/typecheck clean. A non-author
    reviewed both complete files and independently reran the seven directed
    cases, verifying final hashes. Native delivery and final sample routes
    remain outside this bounded caller acceptance.
15. Home, detail, history and archived-board callers now retain their scene
    and product scope through accepted operations. Daily reads precede
    cancelable human confirmations; per-board locks, Undo timers, native
    history deletion and reorder reject duplicate or retired callbacks.
    All destinations remain inside the sample navigator. Thirteen actual
    routed SQLite regressions first reproduce; eighty-six tests across nine
    suites pass, with owned lint and composed typecheck clean. Root reviewed
    all five complete files, verified their frozen hashes and independently
    reran the thirteen directed cases. This caller acceptance does not claim
    production route activation or native presentation acceptance.
16. Shared product navigation now captures one immutable focus lifetime.
    Leaving and returning to the same route cannot revive an old push,
    replace, dismiss or Back callback; blur also publishes inactivity so
    dependent effects clean up. Five actual router regressions reproduce
    first, and seventeen focused cases pass under ordinary and StrictMode
    lifecycles. The composed run passes sixty-six cases across seven suites,
    with owned lint/typecheck clean. Root reviewed all four files, verified
    final hashes and independently reran the seventeen cases. An earlier
    concurrent form-composition failure is retained with successful unchanged
    reproductions; its exact cause is unproven. Four form-test act warnings
    are assigned to the pending form slice, not suppressed or called clean.
17. Anchor-time Settings now scope accepted saves and retire old edit,
    picker, Cancel, Save and retry callbacks. An uncertain save retains its
    original receipt and settings snapshot through resumed read failures;
    replay preserves a later public settings change. Independent review
    also reproduced an ID-allocation failure that left Save busy. The
    corrected error boundary releases controls before any command exists.
    Thirteen tests across two suites and lint/typecheck pass. A non-author
    reviewed both complete files, reran the original allocation-failure
    probe successfully and verified both final hashes. No core or native
    contract changes were required.
18. Reminder create/update/delete now use captured effects and join accepted
    native permission and command work. Sample reminder routes stop before
    queries or native inspection. Exact uncertain receipts and completed
    results remain accessible through resumed row changes; unanswered human
    decisions are outside the operation join. Reminder and options callbacks
    also retain their per-focus and draft owners. Independent review first
    reproduced stale confirmations and options changes after same-scope
    return, then verified both original probes pass with the correction.
    Forty-six tests across four suites pass independently; owned lint and
    composed typecheck pass. All four final hashes match. Native sheets and
    the complete route graph remain subsequent integration gates.
19. Board archive/delete and check-in removal now retain exact accepted
    attempts and outcomes across sample suspension, including committed
    responses that were lost. Existing reminder toggles join authorization
    and SQL using the captured scheduler; sample forms explain unavailability
    before mounting reminder controls. Native sheet, icon and color callbacks
    retain their original focus, and the sample banner/Close are embedded
    inside check-in sheet content. Seventy-one tests across four suites pass
    without diagnostics. Root independently reviewed all four files, verified
    final hashes and reran forty-four cases across two suites. Owned lint
    passes; production routes and actual native geometry remain later gates.

20. Settings > Utilities now exposes sample entry. Accepted external links use
    captured effects; sample Settings explains their unavailability. The symbol
    and anchor native-host trees include banner/Close inside their presentation
    and accessibility boundaries. Fourteen directed picker regressions reject
    old local callbacks after same-scope cover/return while preserving drafts
    and fresh saves; the final focused run passes seventy tests across five
    suites. Source and routed reviews are complete; native sheet geometry is a
    separate acceptance requirement.
21. The actual route graph now separates an inert root from the real product
    navigator and a full-screen sample navigator. Cold sample entry does not
    initialize the real runtime. Covered real forms retain their core and drafts;
    nested sample routes, hardware Back, external replacement and accepted work
    use the same Close/disposal contract. Development routes remain real-only.
    Export-cache cleanup moved from the root to one guarded real-runtime mount,
    with no repeat on pause/resume or StrictMode replay and no cold sample call.
    Actual Router/SQLite controls and independent composition review pass.
22. Generated-route typechecking exposed synthetic test URLs that an ungenerated
    worktree had missed. Narrow Href annotations preserve those test literals;
    no production route typing was weakened. The actual current route declaration
    also passes typechecking. A warm unknown sample path initially created a
    duplicate presentation; dismiss-to recovery now retains one sample host and
    closes to the original real Settings route. Twenty-three actual-tree cases
    and the two original independent composition probes pass.
23. Two inherited form assertions now verify the retained exact-attempt editor
    and definitive archived read-only result through real commands and complete
    SQL-row checks. The initial full-run failures remain recorded. Meaningful
    Coins/reward controls then close the non-core coverage gap without changing
    thresholds. The T23 candidate passes 206 suites / 3,066 tests, with all 105
    core files fully covered. That passing run still contained five lint warnings;
    the earlier warning-free summary was incorrect. Their reviewed correction
    and the final composed gate belong to T24.
24. The earlier T23 native acceptance run remained incomplete. The retained older native binary
    reproduced ExpoFabricView's lost-context fatal during the explicit cold
    launch/development-client/sample sequence, including a second run without
    prototype observers. A fresh stable Home > Settings > Try a sample run
    reached the generated sample and returned to Settings without that fatal.
    The controls distinguish those paths but do not prove the underlying native
    context lifetime fixed or complete the sheet, isolation and disposal matrix.
    Root independently reviews the ready screenshot and reruns the relocated
    verifiers: 66 partial checks and 75 discriminator checks pass. Evidence is
    under `.artifacts/t23/native-partial/` and
    `.artifacts/t23/crash-discriminator/`. Final dependency/native composition
    and its acceptance remain required.

25. Final native acceptance combines the preserved fresh SDK 57 runs. The cold
    sample probe observed no real runtime initialization after its retained
    sample URL entered the development launcher and the owned Metro was chosen.
    This is an empirical cold-entry result, not a general launcher deep-link
    guarantee or proof that every earlier native context-lifetime failure is
    fixed. Warm navigation covers sample Home, Stacks, Coins, history, settings,
    disabled effects and unknown-path recovery. Actual Toronto date/time picker
    controls preserve their stored instants while the host process uses Tokyo.
    The accepted Export/native share cancellation joins before the real runtime
    suspends; the actual real core identity and full dirty draft survive entry
    and exit. Evidence is under `.artifacts/t24/native-partial-148/` and
    `.artifacts/t24/native-followup-149/`.
    The final UI run proves large-text dragging, Keep editing and one exact Save,
    sample board editing, a five-coin reward claim, and internal Close inside
    actual symbol and anchor presentations. A second factory restores 6,014
    coins, the original board title, all 18 recipe table counts and ledger kinds.
    Both sessions preserve all five observed App Group file hashes from joined
    suspension before factory execution through disposal before real resume.
    Each memory handle closes once, all 38 observers restore by identity before
    resume, the original real facade returns and observed real/native calls
    remain zero in the suspended intervals. Outside those intervals, normal
    real housekeeping adds three updated:0 receipts and advances two widget
    strips by one day; every other real table and prior receipt stays exact.
    Root views the native presentations and runs the relocated 104-check
    verifier successfully under `.artifacts/t24/native-detent-final/`.
    The final run retains 48.811/51.599-second factories and 14 SwiftUI Picker
    warnings with correct selections, zero animation-listener/fatal/deallocated
    AppContext events, and no suppression. Startup cost and the bounded upstream
    diagnostics remain documented limitations. This runtime evidence uses the
    verified signed native app with the final JS overlay; later Debug packaging,
    physical installation and live CloudKit are separate T24/external gates.

### T24 - cosmetic rename and final closure (in progress)

Status: local implementation, independent review, automated gates, production
exports and native build/package checks pass. The complete sample walkthrough
passes, and the final signed Debug app launches from the correct Metro project.
The final unsigned physical Release contains the latest UI and complete Shortcuts
assets. Requested iPhone signing/installation and actual two-target CloudKit
convergence remain open. T24 and Checkpoints C/D are not complete.

1. README and remaining public Settings/native display names identify Habit
   System while preserving fork attribution and allowed internal identifiers.
   New backup filenames use habit-system-export; cleanup also recognizes the
   legacy prefix. The ripples.export payload marker, v1/v2/CSV compatibility,
   command/storage schemas and service identities remain unchanged. The scoped
   filename override is recorded in section 4.12 of the Habit System spec.
2. An independent clean dependency install exposed a widget test's reliance on
   an old generated bundle. The test now invokes the installed bundle producer
   into temporary output and preserves all eight runtime/render assertions.
   Four scene identity memos retain their original dependencies and callback
   checks; one line-level lint exception preserves the lazy native factory.
   Independent review and directed tests approve these corrections without
   weakening lint configuration or coverage thresholds.
3. Doctor's original dependency mismatch prompted five recommended SDK 57
   patches in the isolated dependency tree. Doctor then passes 21 checks; the
   paired package gate passes 10 plugin and 195 Swift tests, and iOS/Android
   production exports pass. Canonical validation exits 0 with 207 suites /
   3,067 tests, all 105 core files at 100 percent on all four metrics, non-core
   branches at 90.25 percent and no lint/test diagnostics. Root verifies the
   exact 143-path candidate; mapped exports match all 62 current routes and
   contain no foreign checkout context. Evidence is retained under
   `.artifacts/t24/automated-143/`. These package/export checks do not build or
   validate the updated native app. The later two-file build-script correction
   passes 12 plugin tests and independent review. Two real native generations
   preserve its script, order and dependencies while explicitly marking the
   intended main-app phase to run every build. The fresh signed Debug simulator
   build passes 297 artifact checks, including all embedded library contexts;
   its existing development connectivity is retained. The physical Release
   build compiles and its embedded bundle matches 297 authored sources and all
   62 routes, but actual package verification fails: the cleanup phase runs
   before ProcessInfoPlistFile and leaves Expo's default network keys. The
   earlier scheduling-only correction therefore remains insufficient for
   Release packaging; its failure and minimal ordering fix are tracked separately.
   Main-checkout validation also exits 0 with the same 207 suites / 3,067 tests,
   105 fully covered core files, 90.25 percent non-core branches and no diagnostics.
4. Diagnostic evidence remains specific. The native animation-listener producer
   family is identified but its exact emitting node/interleaving is unresolved;
   the observer-free stable Home control records two further warnings. The
   current ordinary Create Board control selects Daily, changes to Count,
   reopens with Count selected and cancels correctly. A later native remount
   trace observes a non-null selection prop while Expo's local SwiftUI state
   is initially nil, followed by the warning pair and a correct daily state.
   Independent review finds no demonstrated app-owned mismatch. The LLDB
   expression interruption restores evaluator state and the same app process
   continues; it is not an observed application crash. No warning suppression
   or SDK picker patch is applied. The dependency patches do not change
   ExpoFabricView's fatal guard, AppContext or DevLauncher code, so no native
   crash cure is claimed. Final runtime results remain required before closure.
5. Exact Apple reads find both fork bundle IDs unregistered and the target
   iPhone registered/enabled. App Group and iCloud capability links remain
   unverified. The existing EAS Admin API key works for its supported reads,
   while the cached Apple user session returns expired-session code 1100.
   A separate read-only Xcode check finds no persisted Apple account and no
   matching team. Signing in to Xcode can enable the supported local provisioning
   path; exact app/widget profiles and capability assignments still require
   proof. The unsigned physical Release compile is not an installable build.
   No iPhone install/launch, live two-target CloudKit convergence or Checkpoint
   C/D completion is asserted.
6. The actual Release failure is corrected in the local config plugin. Its
   finalized mod moves the unchanged DevLauncher cleanup after widget embedding
   and declares the processed app plist as its input. Directed tests reproduce
   both the missing dependency and later widget-plugin ordering before passing
   the correction; actual CNG/Pods composition is repeatable. The corrected
   unsigned build exits 0 and orders widget copy, main plist processing, then
   cleanup. Final default Expo network keys are absent, with no build cycle or
   named script ambiguity warning. Source plist bytes and all six native images
   are unchanged. Evidence is under `.artifacts/t24/release-phase-correction/`
   and `.artifacts/t24/physical-ordering/`. This package predates the latest UI.
   Its three generated Shortcuts training assets are missing despite retained
   action/shortcut definitions; the final package must restore and verify them
   through the supported build. The original unsigned inputs were Development;
   this corrected ordering probe explicitly used Production. The final phone
   build follows the existing preview Development configuration.
   The template-based plugin suite exposed a context-dependent Bun 1.3.14
   subprocess failure. The existing node:test suite now runs with Node through
   `bun run test:native`; two plist assertions normalize only the parsed root
   prototype while retaining complete key/value equality. Canonical main native
   checks pass 14 plugin and 195 Swift tests. No production script, dependency,
   lockfile, assertion or coverage threshold is weakened. The precise Bun cause
   remains unproven. Evidence is under `.artifacts/t24/native-test-runner/`.
7. Actual largest-text dark-mode testing reproduced three check-in form defects:
   an offscreen Save action, overlapping/clipped Date controls, and an unusable
   manually reduced half-height sheet. The form now stacks its header and fields
   at large text sizes, measures native pickers without fixed dimensions, and
   offers a full-height sheet at those sizes. Normal text keeps both existing
   sheet positions. Independent source review approves the bounded correction;
   date/zone conversion, commands and dirty guards are unchanged. Existing Save
   and history-reopen cases now cover normal and largest font scales on both
   platforms. Native full-height scrolling and exact single Save pass; the final
   detent check also preserves a dirty amount through dragging and Keep editing,
   then saves exactly one check/action/award/receipt. The remaining sample matrix
   was tracked separately. Earlier field and half-height failures are preserved
   under `.artifacts/t24/native-followup-149/` and
   `.artifacts/t24/native-fields-150/`.
   Canonical validation on the final detent source exits 0: 207 suites / 3,069
   tests, all 105 core files at 100 percent on all four metrics, 3,151/3,489
   non-core branches (90.31 percent), and clean lint/typechecking. Evidence is
   under `.artifacts/t24/final-detent/`. Both current mapped production exports
   pass with actual Hermes bytecode, exact 62-route contexts and no foreign
   checkout origins. Their source maps match 297 authored src files plus one
   local-module file on iOS, and 296 src files with no local-module entry on
   Android. Android resolves the generic platform adapters. All 1,010 recorded
   export inputs were unchanged throughout both exports and verification. Two color-environment warnings per platform
   remain disclosed; no export/source errors occurred. These exports do not
   establish final native packaging or physical installation. The 78-file
   export evidence package is independently hash-verified under
   `.artifacts/t24/production-exports/`.
8. The final unsigned iPhoneOS Release build exits 0 in 557.571 seconds with
   the reviewed UI and explicit preview Development CloudKit inputs. All 150
   frozen candidate paths matched before and after the physical build. Main plist
   processing precedes cleanup after widget copying; final default network keys
   are absent, with no cycle or named cleanup-phase ambiguity warning. All six
   arm64 iPhoneOS images resolve their packaged dependencies, both widget bundle
   copies match, and the actual production map matches 297 src files, the native
   bridge module and all 62 routes. Main Shortcuts training runs and restores
   the packaged SSU/NLU assets. The three automatic Shortcuts and six action
   definitions retain their semantic values. No targeted clean, additional
   build or manual generated-file repair was needed. The preserved 93-entry
   unsigned app and 31-file evidence manifest pass the relocated verifier under
   `.artifacts/t24/physical-final/`. The build retains 2,201 warning
   occurrences, with zero authored native warnings or compiler errors; it is
   not described as warning-free or installable.
   Actual SDK 57 inspection corrects an earlier preparation assumption:
   prebuild cleans by default. Explicit `--no-clean`, followed by ordinary Pods,
   preserves the generated target IDs and existing native build caches. Evidence
   is under `.artifacts/t24/final-physical-preparation/`. Compiler Release does
   not choose the CloudKit environment, and unsigned entitlement inputs do not
   establish authorized Apple capabilities.
9. The final Debug build exits 0 in 331.506 seconds after explicit non-clean
   generation and ordinary Pods installation. The built plist retains both
   development network keys, with main plist processing before the cleanup
   phase and no cycle or named scheduling warning. All eight images across
   sixteen architecture pairs pass package/linkage checks, and packaged
   Shortcuts training assets are present. A signing-only copy uses the existing
   Apple Development identity; all eight code targets carry the expected team,
   deep-strict signature verification passes, and executable/entitlement
   sections match the new unsigned build. Compared with the previous artifact,
   the widget's arm64 code section differs; the other fifteen pairs match.
   Root archives the package and runs the relocated verifier successfully under
   `.artifacts/t24/debug-final/`.
   The signed copy installs in place on the owned simulator and preserves the
   database triplet byte-for-byte before launch. Its first normal launch shows
   real Home with the original boards and zero coins. Read-only runtime evidence
   reports a server-loaded bundle on port 8082 and the exact Cosmetic project
   root. Installed Debug plist keys and all eight signed images match the
   artifact. No sample factory or prototype observers run. Normal housekeeping
   adds one updated:0 receipt; all other real tables and existing receipts stay
   exact. The App Group preferences plist changes during normal launch; its
   retained final bytes contain widget layout/timeline data, while only the
   prior hash/size was captured. No key-level before/after claim is made.
   The Home-only native log has zero Picker, animation-listener, fatal
   or deallocated-AppContext events. This does not replace the fourteen Picker
   warnings retained from the separate form/picker matrix. Owned services stop
   and protected resources remain unchanged after verification. Root runs the
   relocated 56-check verifier under `.artifacts/t24/debug-connectivity/`.
10. The final safe readiness check at 2026-09-10 06:02:58 UTC still finds no
    persisted Xcode Apple account or matching team and reports the paired iPhone
    disconnected. Current lock state and a live authenticated Apple session are
    not established. No physical signing, provisioning, installation or launch
    has occurred. Existing authorization permits ordinary exact-identity signing
    and an in-place install once the account and phone are accessible. Actual
    two-target CloudKit convergence remains a separate required acceptance gate;
    local tests and simulator signing do not satisfy it. The two declined sync
    proposals remain excluded. T19/Checkpoint C and T24/Checkpoint D stay open.
11. The sample startup follow-up reproduces 51.434 seconds on the owned signed
    simulator. The unchanged recipe executes 6,065 public commands and spends
    44.444 seconds inside 271,098 SQLite convenience/transaction calls. The
    memory-only adapter now uses synchronous short queries behind its existing
    Promise queue; native BEGIN/COMMIT/ROLLBACK remain asynchronous. No schema,
    generator, real database adapter, sync or persistence format changes. The
    complete-recipe scheduling-budget test first fails at 271,118 asynchronous
    calls against a 30,325 limit, then the full 14-test sample suite passes.
    Independent source review approves the exact two-file implementation/test
    delta. Full validation passes 207 suites / 3,069 tests in 122.087 seconds,
    with every metric at 100 percent for all 105 core files and non-core branch
    coverage at 90.31 percent. Both updated production Hermes exports pass:
    298 authored iOS sources, 296 Android sources and all 62 routes match main.
    The 77-file export archive matches its producer. Native sources and build
    dependencies are unchanged; the existing 14 plugin / 195 Swift gate and
    signed Debug artifact remain applicable.
12. Actual candidate factories take 21.842 seconds with detailed profiling and
    20.115 seconds with only whole-factory timing, heartbeat and isolation
    observers. All three runs match the 19 canonical table hashes and 6,014-coin
    recipe. The candidate reduces asynchronous SQLite convenience calls to
    12,162 while preserving the total query count. Timer/rAF callbacks continue
    during generation; the minimal run's largest wholly internal gap is 23.05
    milliseconds. A 216.65-millisecond gap straddles completion and ready UI;
    twenty seconds remains a visible delay, not an instant-start claim or a
    statistical/device benchmark. Actual cap-2 edit, check and five-coin claim
    end at 6,009 coins; reopening restores cap 3, 6,014 coins and the complete
    pristine fixture. Each memory core closes once, all observers restore
    before real resumption, and all five suspended App Group file hashes match.
    Only five normal updated:0 receipts are added to the real QA store across
    baseline and candidate runs; all other tables remain exact. Four inherited
    Picker warnings and the documented QA instrumentation/assertion mistakes
    remain visible in the evidence. Owned services stop; the protected B47
    simulator's external shutdown is recorded without reversing it. Root runs
    the relocated native verifier successfully: 189 checks under
    `.artifacts/t24/sample-performance/native/`. Independent final review checks
    all 298 retained evidence hashes, recomputes timings and the identical SQL
    workload, and separately compares the stopped SQLite stores without finding
    a source or evidence defect. Final stopped backup:
    `bed0381fb82409e939629a7687cfd73989bc3d702ae86a079bf2ff541cf2f5f9`.
13. The requested phone continuation separates two actual failures: the first
    exact-device build stops because the phone is locked, before authentication;
    the generic iOS API-key attempt then reaches provisioning and fails Apple
    authentication. A secure input check confirms correctly formatted P-256
    key material and an HTTP 200 read-only App Store Connect request from those
    same bytes. It does not explain or repair Xcode's separate authentication
    failure. Temporary key files are removed, and no unsupported retry or
    wildcard-profile install is attempted. After Rami reconnects/unlocks the
    phone, supported developer-image mounting succeeds. Direct Xcode UI confirms
    no Apple account and is left at its sign-in dialog for Rami. Current physical
    source includes the reviewed memory change in a 151-path manifest, but no
    installable signed artifact or physical launch is claimed. The remaining
    signing prerequisite is Xcode Apple-account authentication.
14. Two fresh owned iPhone 17 Pro / iOS 26.5 simulators are prepared with the
    reviewed signed Debug app: `7CE21806-6D26-41C1-B2D6-8C33E3EAF964` and
    `98BA5084-9663-44F3-A28B-1BC6F94BAA3C`. Each installed 78-file package and
    deep-strict signature match; neither app has launched or created a product
    database, and both simulators are shut down. Live CloudKit still needs a
    shared test iCloud account, verified explicit fork App ID/container capability
    association, and qualified scoped network loss for the true-offline cases.
    Physical profiles are not required for simulator testing, but declared
    simulator entitlements do not establish working server capabilities.
    Read-only installed simulator CLI discovery exposes no network-condition
    control; no host networking is altered. T19/Checkpoint C and T24/Checkpoint D
    remain open. The two declined sync designs remain excluded.
15. Rami completes Xcode sign-in. Direct UI shows the developer team with Admin
    and Certificates, Identifiers, & Profiles access; normal account-based
    automatic signing succeeds in 91.05 seconds. The exact main/widget profiles
    include this iPhone, cover the actual signer, and authorize team `3V2UU7RRK9`.
    Signed entitlements carry the exact App Group and, for the main app, the
    exact CloudKit container with Development environment and development push.
    Both profiles expire on 2027-09-10. All six arm64 device images pass strict
    signatures and recursive linkage, the app passes deep-strict verification,
    and complete Shortcuts training assets remain present. All 151 frozen paths
    match, including memory adapter `4ff1e95b...`. The new 3,565,828-byte Hermes
    bundle maps to the current 297 source files, native bridge and all 62 routes.
    Widget copying precedes plist processing and Release cleanup; default
    development network keys are absent, with no named phase ambiguity/cycle.
    CoreDevice successfully installs Habit System 1.0.0 (1) on the exact iPhone.
    The fork was absent before installation; no existing fork database upgrade
    or migration is claimed, and no other app is uninstalled. Launch is refused
    with `FBSOpenApplicationErrorDomain` 7 because the phone has relocked. A
    bounded 120-second watcher observes twelve locked states, performs no extra
    launch or reinstall, then stops. Installation and capability proof pass;
    physical launch/visual acceptance remain unconfirmed. Root runs the final
    installation verifier successfully under `.artifacts/t24/phone-installation/`.
    The safe archive covers 24 evidence files; the separately retained signed
    app has 195 verified files. No credentials or raw profile bodies are copied
    into the repository archive. All owned signing/readiness processes and
    temporary credential files are gone. This supersedes the signing blocker
    above; live service acceptance still requires the separate test setup.
16. The SDK 57 widget layout now marks every rendered root with
    `containerBackground(..., 'widget')`, replacing WidgetKit's "Please adopt
    containerBackground API" fallback. Empty, standard and extra-large layouts
    use explicit light/dark container colors. The installed Expo widget compiler
    and runtime test covers all four configured families, the empty state and
    both color schemes (15 focused cases); lint and typecheck pass. Independent
    review found no production defect and its missing color-serialization test
    was added. Full coverage remains blocked on an unrelated existing options
    route test exceeding its five-second timeout on this Linux host. Native gates
    are unavailable here because `/usr/bin/plutil` and Swift are not installed;
    no simulator or physical-widget evidence is claimed for this follow-up.
17. Development builds now resolve to the side-by-side bundle identifier
    `studio.orbitlabs.habitsystem.dev`; their widget extension resolves to
    `studio.orbitlabs.habitsystem.dev.ExpoWidgetsTarget`. Preview and production
    retain `studio.orbitlabs.habitsystem`. The existing App Group and CloudKit
    identifiers remain shared so the hardcoded database container and native
    executor contracts do not drift. A clean SDK 57 development prebuild proves
    both bundle identifiers, both shared-container entitlements, the CloudKit
    entitlement and Info.plist lookup keys. The focused profile/plugin test
    passes and pins EAS profile isolation plus the actual entitlement/Info.plist
    mod wiring. Independent review found no production defect; its two test gaps
    were remediated. ESLint passes. The full plugin gate passes 14 of 15 checks;
    its sole failure is the existing Linux absence of `/usr/bin/plutil`.
    TypeScript did not complete within a bounded five-minute run after the new
    inherited e2e dependencies landed, so no full typecheck claim is made. The
    development variant also uses its own opaque square icon: the familiar
    droplet wears an orange hard hat in a purple-and-blue palette, while preview
    and production retain the original green icon.

### Native Mac U1 - shared engine foundation (2026-10-18)

- Rami selected a proper Mac app and full mobile feature parity. Plan: `docs/plans/2026-10-18-1200-feat-native-mac-app-plan.md`. Independent document review completed with no findings.
- Added a serial JavaScriptCore host over native SQLite, CryptoKit hashing and UUID/time-zone adapters. The Mac bundle imports the existing TypeScript core and exposes an explicit operation allowlist. Domain error fields and command receipt semantics remain intact.
- The first integration test failed against the initial host with `engine not implemented`, then passed with the real engine. Six native tests cover durable daily check/receipt replay/coins, rollback and retry, count/unicode backup round trip without minting coins, exact SQL value mapping, migration mismatch preservation, and existing historical/economic calendar plus UTF-8 parity.
- Non-author review identified field-error preservation and stale bundle risks; both were corrected. SwiftPM generates the engine as a build resource from tracked inputs, including normal Swift builds.
- Baseline mobile validation passed 210 suites/3,090 tests and native checks. The shell lacked Node on PATH; adding the desktop bundled Node runtime corrected the initial Jest/node:test runner mismatch without changing product code.
- Desktop UI and live CloudKit acceptance are subsequent units, not claimed by this foundation.
