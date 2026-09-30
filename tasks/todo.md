# Tasks: Habit System

Spec: `SPEC-habit-system.md`. Plan: `tasks/plan.md`. Status: approved by Rami on 2026-09-08, including the pre-T2 amendments, same-day-only correction and archive-date exclusion. T1 through T18, T20 and Checkpoint B are done. T19 local implementation is complete with actual two-target service acceptance and Checkpoint C still open. T21 is complete: storage/runtime integration, automated gates, the repaired native build and actual iOS simulator acceptance pass with independent review. T22 is complete: the deterministic sample and memory factory pass automated gates, independent review and actual iOS correctness/isolation/disposal checks. T24 reduces measured native sample startup from about 51 seconds to 20 seconds with unchanged generated data. Revised planning documents were pushed; implementation remains authorized through T24. T23 is complete: route/runtime integration, automated gates, independent review and actual iOS sample acceptance pass. T24 local implementation, automated/export gates, unsigned Release packaging and a fresh signed Debug simulator launch pass; signed iPhone installation and exact capability checks also pass. Physical launch, live two-target service acceptance and Checkpoint D remain open.

Definition of done: tests first, `bun run validate` exit 0, every core file at 100 percent, native checks green, simulator evidence for visible changes, independent review by a non-author, one `checkpoints.md` entry per task, and lowercase conventional commits without co-author lines. Bounded substeps may have separate commits, but shared contracts must pass both executors in every commit. Intermediate builds remain development-only until T19/T20 compatibility gates pass.

## Phase 0: fork identity

- [x] **T1: Apply fork identifiers and create the EAS project** (done 2026-09-08, see checkpoints.md)
  - Acceptance: `app.json` name and slug `habit-system`, bundle `studio.orbitlabs.habitsystem`, scheme `habitsystem`, widget name and display name renamed; `CloudKitTransport.swift` zone `habit-system`; podspec URLs point at `rami-maalouf/habit-system`; EAS project and updates URL use the new project; `package.json` name `habit-system`; FORK.md table marked applied.
  - Verify: native configuration checks, doctor, clean iOS prebuild, simulator build with the new bundle id, generated `ios/` untracked.
  - Files: `app.json`, `package.json`, `modules/habit-system-apple/ios/CloudKitTransport.swift`, `modules/habit-system-apple/ios/HabitSystemApple.podspec`, native config test, `FORK.md`.
  - Depends on: none.

### Checkpoint 0

- [x] Simulator runs under the new identifiers; plugin tests and doctor pass; entry in `checkpoints.md`.

## Phase 1: daily habits

- [x] **T2: Schema 6, board/settings fields, and widget kind** (done 2026-09-08; see checkpoints.md)
  - Acceptance: migration 6 adds board columns `kind`, `anchor_relation`, `anchor_kind`, `anchor_board_id`, `anchor_preset`, `anchor_text`, `usual_time_minute`, `required_in_stack`, `earns_coins`, `coin_cap_per_day`; four settings preset minutes defaulting to 420, 720, 1080, 1380; widget projection kind support. Existing boards are Count. Ledger, rewards, and miss-alert tables belong to T15/T18/T21, not migration 6.
  - T2a: atomic migration, fixture, and matching Swift gate/checksum update. Never edit migrations 1 through 5. Compute the appended checksum through `migrationChecksum`; `testNativeSchemaGateMatchesAuthoritativeMigrations` must pass in this commit.
  - T2b: `Board`, `AppSettings`, and widget types plus repository hydration/writes, explicit defaults at every command/import/fixture construction site. Omitted-kind compatibility callers and legacy imports remain Count; the new form explicitly defaults Daily in T4.
  - Verify: every earlier fixture opens, version 5 migration defaults, fresh database, existing checks unchanged, native gate, full validation.
  - Ownership scope: schema/migrations tests, entities, board/settings/widget repositories/projection, command construction sites, reference fixtures, and Swift gate. Keep each substep bounded while committing schema/gate changes atomically.
  - Depends on: T1.

- [x] **T3: Schema 7 action evidence, Daily rules, and atomic toggle** (done 2026-09-08; see checkpoints.md)
  - Acceptance: Daily forces amount/time tracking false while retaining historical values. Check on an already checked date returns the existing id without another check mutation and records an idempotent receipt. Toggle resolves state inside its mutation transaction. Uncheck removes all live checks on that date, including preserved Count history; single-record history removal stays single-record. Date edits cannot silently create a second logical Daily state.
  - T3a: schema 7 adds immutable `habit_actions` with action ids/stamps, explicit checked/unchecked evidence, and nullable `policy_json` reserved for coin snapshots; repository/types plus Swift gate/checksum land atomically. Use the evidence contract in `docs/ledger-reconciliation.md`; commands/live actions remain UUIDv4, while deterministic legacy baselines use UUIDv5 and nullable command ids.
  - T3b: validation, defaults, shared transaction helpers, create/edit rules, and action evidence on every relevant TS/native write. Date moves emit `move_out`/`move_in`, mapping Daily state to unchecked/checked without representing a new earning action. T3c: toggle/uncheck, Remove Latest, Undo, receipt behavior, and deterministic action folding ready for later sync/ledger integration. Do not resolve a toggle outside `runCommand` or nest transactions. A tombstoned check must not erase evidence needed to resolve an offline uncheck.
  - Verify: both kinds, replay, concurrent actions, count-to-daily history preservation, several checks on one date, date moves, selective history deletion, and Undo ownership.
  - Ownership scope: schema/entities/ids/action repository, domain validation/commands, check-in repository, Swift executor/gate, domain/native tests. Import/sync integration closes at T19/T20 using the same action/state rules.
  - Depends on: T2.

- [x] **T4: Board form Kind control**
  - Acceptance: Create/Edit offers Daily and Count; new forms default Daily. Daily hides Track Amounts, Unit, Quick Amount, and Track Time; preview and saved state reflect kind. Editing an existing Count board preserves its kind.
  - Verify: accessible form tests, save/reopen, both simulator states.
  - Ownership scope: board form/state and feature tests.
  - Depends on: T3.

- [x] **T5: Daily Home card**
  - Acceptance: fourteen binary cells ending today, ISO-week `N/7 this week`, current streak, and filled checked toggle. Labels are "Checked, double tap to uncheck" and "Not checked, double tap to check". Unchecking a date containing notes confirms the affected history; Undo has a precise action target and does not delete another action's check.
  - Verify: projection/feature tests, multi-record note confirmation, rapid presses and retry, simulator check/uncheck/Undo.
  - Ownership scope: domain queries, board card, home, and associated tests.
  - Depends on: T4.

- [x] **T6: Daily heatmap states**
  - Acceptance: Daily cells are checked/unchecked with date labels and non-color cues; inherited Count intensity and unavailable dates remain correct.
  - Verify: feature tests and light/dark simulator evidence.
  - Ownership scope: heatmap/detail and feature tests.
  - Depends on: T5.

- [x] **T7: Widget fallback and shared daily intent integration**
  - Status: T7a and T7b complete with independent review, full validation/native gates, actual simulator widget/action evidence, and exact shared receipt parity. T8 owns actual Shortcuts execution.
  - T7a acceptance: widget projection/props carries kind and checked state; row shows binary state for Daily. A daily quick-action deep link opens a dedicated flow that resolves current state, offers an explicit Check/Uncheck action, toggles through the command, and confirms removal when notes exist. Opening/remounting the route does not itself mutate. New checks retain widget provenance. Count keeps its Add Check-In fallback. Include the route and provider integration; do not pretend the existing Add Check-In link can uncheck. Refresh cached projections before publication and expire at the earliest relevant day boundary, including shifted board days and DST changes, with matching TS/native metadata. Derived refreshes do not create habit actions, HLC changes, receipts, or outbox entries.
  - T7b acceptance: add Check In, Remove Latest, and Get Today's Check-Ins Daily fixture cases together with their TS and Swift implementations. Check is idempotent, Remove Latest unchecks the selected date, and Today reports checked state. Shared receipt results match verbatim. Commit the fixture and both executors together so native checks never knowingly fail between T7 and T8.
  - Verify: widget/feature tests, contracts, native suite, simulator widget appearance and fallback action with fresh state.
  - Ownership scope: widget projection/props/layout, daily action route/flow, provider, TS contract, shared fixture, Swift executor, and focused tests. Keep T7a and the atomic T7b integration as separate bounded substeps.
  - Depends on: T6.

- [x] **T8: Native daily verification**
  - Acceptance: audit Swift-only schema/projection/outbox/idempotency paths against T7's shared cases; add native-specific regressions without changing the public intent inventory. Shortcuts Check In, Remove Latest, and Today work with Daily and Count boards on the simulator.
  - Verify: native suite and real Shortcuts execution; record any signed-device gate separately from simulator results.
  - Ownership scope: Swift executor/tests and checkpoint evidence. Any fixture amendment ships with both implementations.
  - Depends on: T7.

### Checkpoint A

- [x] Daily creation and toggling work through Home, widget fallback, and Shortcuts, including inherited multi-check days; Count behavior and all gates pass. Development-only pending serialization completion.

## Phase 2: same-day stacks

- [x] **T9: Preset anchor minutes**
  - Acceptance: Settings > Anchors edits Waking up, Lunch, Dinner, Sleeping in 15-minute steps across 0 through 1439. Defaults remain 420, 720, 1080, 1380. These times are informational and never assign checks to runs. Commands persist values; synced representation arrives at T19.
  - Verify: domain validation, feature tests, native picker evidence.
  - Ownership scope: command/query, anchor settings screen/route, settings navigation, tests.
  - Depends on: T8.

- [x] **T10: Anchor fields and validation**
  - Acceptance: create/update accepts consistent anchor fields, usual time, and required-member flag; rejects self/cycles/invalid links; deletion clears dependents in the same transaction and reports their count. Archiving preserves links. Stable stack identity will use the terminal structural anchor-root board even when a Before member displays first.
  - Verify: chains, siblings, mixed directions, cycles, archived targets, delete cleanup/outbox effects.
  - Ownership scope: validation/commands/queries, board repository as needed, anchor domain tests.
  - Depends on: T9.

- [x] **T11: Anchor form controls**
  - Acceptance: Anchor sheet has Habits in home order, four Built-in anchors with informational times, and text input; After/Before selection; sentence summary; optional Usual Time picker; Required in Stack control. Editing times does not imply a run window or deadline.
  - Verify: accessible feature tests and simulator evidence for each anchor kind and direction.
  - Ownership scope: anchor picker, board form/state, feature tests.
  - Depends on: T10.

- [x] **T12: Pure same-day stack derivation**
  - T12a complete: pure topology, stable roots, explicit sibling precedence, archived structural links and active filtering, and informational first-active time hints. Forty-five focused tests and independent generated-forest comparison pass; see checkpoints.md.
  - T12b complete: exact stored-date runs and stack-specific eligibility, with 13 calendar vectors, four real-command archive/restore/history cases, independent 3,200-date oracle, full validation and native gates. No derivation writes or non-stack eligibility changes.
  - Approved archive boundary: stack eligibility includes the stored period start and excludes a closed end date. Archiving removes the habit from requirements on that date; same-day restore reopens the period and requires it again. Preserve inherited non-stack analytics and avoid inferred intraday/current-day-only filtering.
  - Acceptance: `deriveStacks` produces deterministic before/after order, sibling home order, stable structural root ids, and informational times. `assignRuns` uses exact stored logical dates: `<rootId>|<logicalDate>`. No occurrence instant, usual time, preset time, or adjacent calendar date moves a check between runs. Completeness uses required members eligible under inherited date-based activity periods; zero required eligible members means incomplete and no bonus.
  - Verify: mixed directions, preset/text roots, isolated/unanchored boards, root archive, optional members, same-day archive/restore, defensive cycle error, midnight/shifted-day/DST/time-zone fixtures proving stored dates stay fixed, leap day. Explicitly prove evening Tuesday plus morning Wednesday cannot complete one run.
  - Ownership scope: `src/core/domain/stacks.ts`, domain tests, queries/repository inputs needed for activity periods.
  - Depends on: T11.

- [x] **T13: Stack analytics**
  - Acceptance: complete runs by ISO week, current and longest consecutive-date streaks, per-member weekly checks, rolling 365-date heatmap with none/some/most/all and text alternatives. Unavailable/empty-required dates do not become free completions.
  - Verify: domain coverage including unfinished today, historical changes, archived gaps, and informational time edits leaving date membership unchanged.
  - Ownership scope: stack analytics, domain queries, tests.
  - Depends on: T12.

- [x] **T14: Stack screens**
  - Acceptance: header Stacks action, list with ordered members/current date state/informational time/weekly count/current streak, detail heatmap and member counts, and empty state linking to Create Board. Route identity uses the structural root id and remains stable when display order changes.
  - Verify: feature tests and light/dark simulator evidence; no overnight-run language in product UI.
  - Ownership scope: stack routes/screens, home header integration, feature tests.
  - Depends on: T13.

### Checkpoint B

- [x] User-entered habits derive the expected topology and same-date runs; checks on consecutive dates never combine. Time edits are informational, archived eligibility is date-based, and every gate/review is recorded.

## Phase 3: coins and rewards

- [x] **T15: Schema 8, ledger rules, all-writer earnings, and controls**
  - Status: complete with full gates, independent review and actual simulator proof. Coverage includes migration/calendar, app/native earnings and removal, Undo, caps, date moves, deletion, non-earning import/replay, exact period/history preservation, prospective policy changes and normal-form earning controls. Final integrated validation passes 96 suites / 1,475 tests with all 63 core files at 100 percent; native gates pass 9 plugin / 107 Swift tests.
  - T15a acceptance: prove the immutable action-replay/adjustment protocol in `docs/ledger-reconciliation.md` at small scale, then add schema 8 with ledger fields/indexes, claim title snapshots, and `adjustment` rows carrying `scopeKey`, `sourceActionId`, `reconciliationKey`, `adjustsId`, and `provenanceJson`. Generated ledger ids use UUIDv5; command/live-action ids stay UUIDv4, with T3's synthetic baseline exception. Branded types and append-only repository exist. Update Swift schema gate/checksum with the migration. Historical references survive parent deletion/export omission.
  - T15b acceptance: pure rules replay immutable action/policy evidence for opted-in Daily and Count earnings, cap 1 through 10, logical-day claw-back, raw positive/negative totals, and deterministic adjustment. Check-award identity includes earning scope and source check action. Check coins close at their own board's next logical day; bonuses close at the structural root's next logical day. Shared helpers cover create, remove, toggle, Remove Latest, Undo, date/time edit, and board deletion. Edits never mint fresh rewards: timely move-out may revoke the original; late move-out preserves it; move-in earns nothing. Root changes use separate old/new policy actions and never mint retroactively. Check/action, receipt, stamp, outbox, projection, and ledger effects commit together, including replay of eligible earlier actions delivered after closure.
  - T15c acceptance: Swift executor performs the same earning/reversal behavior; shared native/TS cases land together. Define explicit import/restore mode that preserves history without creating earnings from restored checks; T19/T20 close external data integration.
  - T15d acceptance: board form exposes Earn Coins and Daily Coin Cap for both kinds, with validation, save/reopen, defaults, and accessible labels.
  - Verify: cap/races/replay/atomic rollback, all mutation paths, historical edits, current/closed date boundaries, count multi-checks, native fixtures, and form simulator evidence.
  - Ownership scope: schema/ids/entities, ledger repository, pure coin rules, command helpers/queries, Swift executor, board form, and focused tests. Use bounded substeps; no schema or shared contract commit may leave native checks red.
  - Depends on: T14.

- [x] **T16: Same-day bonus restoration and reconciliation**
  - Status: done. Migration 9 indexes exact-date action discovery and updates the native gate while preserving migrations 1-8. Pure TS/Swift, historical evidence readers and all live writers pass independent review; 1,619 tests and 131 Swift tests pass, with all 70 core files at 100 percent. Actual in-place migration, app/Shortcuts bonus reversal/restoration, receipt replay and adjacent-date isolation pass on Migration QA. See `checkpoints.md` and `.artifacts/t16/qa/`. Later rewards/admission/alerts use schemas 10/11/12.
  - Acceptance: each complete same-day run has one net bonus entitlement keyed by structural root and logical date. Unchecking a required member inside the approved boundary reverses it; re-completing restores it through new immutable compensation rows. Zero required eligible members earn no bonus. Reconciliation handles duplicate awards/reversals and a run completed only by merged checks, with deterministic identities and no duplicate compensation under retry or delivery reordering.
  - T16a: pure entitlement/compensation model and local command integration. T16b: matching Swift fixtures and reconciliation entry point used by T19. Topology/required/archive changes use exact stored-date eligibility and captured close boundaries. Ordered root-carried policy controls supersede stale member observations, while earlier valid awards retain their original source policies. Surviving stacks receive updated requirements; only disappearing root/date scopes retire.
  - Verify: check/uncheck/recheck, date edits, deletions, replay, two replicas, split-member completion, informational time edits, and logical-day close boundaries in both executors.
  - Ownership scope: coin/stack rules, command/reconciliation helpers, Swift implementation, shared fixtures, tests.
  - Depends on: T15.

- [x] **T17: Coins screens and balance pill**
  - Status: done. Accessible balance, raw totals and indexed virtualized history pass 1,670 tests with all 72 core files at 100 percent, 9 plugin and 131 Swift checks, independent review and actual light/dark simulator QA. Four reproduced native layout issues are fixed, including signed maximum balances and large text. Prior rows remain exact; see `checkpoints.md` and `.artifacts/t17/qa/`.
  - Acceptance: accessible balance pill, `/coins` balance/earned/spent with rewards placeholder, `/coins/history` virtualized newest-first ledger grouped by logical date. Show negative balance and meaningful restoration/compensation entries. Historical missing board/reward references have stable readable fallbacks.
  - Verify: queries/features, negative balance and deleted-reference history, light/dark simulator evidence.
  - Ownership scope: routes, coin screens/history, home header, feature tests.
  - Depends on: T16.

- [x] **T18: Schema 10 and rewards**
  - Status: done. Storage, atomic claims and routed forms/list/confirmation pass 1,769 tests with all 77 core files at 100 percent, 9 plugin and 131 Swift tests, independent review and preserved signed-simulator evidence. Actual create/claim/refuse/edit/archive/restore/delete and post-delete receipt replay preserve history. Final QA balance is 5 after one -3 claim; reward sync/export remains T19/T20. Four framework animation-listener diagnostics remain an explicit T24 follow-up; no actionable T18 source defect was identified.
  - T18a acceptance: schema 10 adds rewards with branded ids, approved constraints/indexes, and matching Swift gate/checksum. Repository and commands create/update/reorder/archive/delete; ledger rows remain untouched by reward deletion.
  - T18b acceptance: `claimReward` checks balance inside its exclusive transaction, fails below cost, writes immutable debit plus title snapshot, and replays safely. Editing/deleting a reward preserves prior claim cost/title. Distinct offline claims remain accepted after merge even if their combined balance is negative.
  - T18c acceptance: native-style new/edit forms, reward list, empty state, and Claim confirmation showing cost and resulting balance.
  - Verify: domain/native schema/feature checks plus simulator create/claim/refuse/edit/delete with history intact.
  - Ownership scope: schema/ids/entities, reward repository/commands, coin routes/forms/list, tests, Swift gate.
  - Depends on: T17.

- [ ] **T19: Schema 11, sync schema 2 and offline convergence**
  - Completed foundations: schema 11, explicit legacy baselines, matching TS/Swift effective visibility, bounded private-safe inbox/status UI, immutable identity validation, exact-scope loading/planning and atomic admission/settlement. The historical increments and their independent tests are recorded in the single T19 checkpoint entry.
  - Clock behavior: complete. App/native counter rollover, atomic exhaustion and accepted-stamp observation preserve ordering, receipts and rollback. Signed Home/Shortcuts evidence and independent real SQLite checks pass.
  - Local recovery: complete and pushed in `5ffa1bc`. Retained facts settle with iCloud Off, either toggle direction resumes the coordinator, and committed changes refresh the UI even when transport and retry-state persistence both fail. Validation passes 2,169 tests with all 93 core files at 100 percent; independent review and signed clone retry/cold-preservation evidence pass.
  - Paired wire prerequisite: complete and pushed in `ce28b27`. Eight schema-2 mappings, semantic v1/v2 validation, bounded diagnostic capture, immutable native equality and the additive iOS adapter pass 2,316 tests with all 95 core files at 100 percent, 9 plugin/166 Swift checks and independent review. Fresh signed generic compilation includes the actual Expo bridge and codec on both simulator architectures.
  - Self-anchor validation: complete. The v2 reader rejects existing/new self-targets before dependency deferral, and native upload/refetch/conflict paths refuse to acknowledge a newer self-linked server row. Public SQLite and native behavioral red/green checks pass; combined validation passes 2,319 tests with all 95 core files at 100 percent, 9 plugin/169 Swift checks and independent cross-review. Fresh signed compilation on both simulator architectures passes 76 artifact checks. This enforces the existing self-link prohibition without selecting a multi-board cycle policy.
  - Engine integration: the production engine and default iOS adapter now use schema 2. Current-row upload stamps, selected-ID acknowledgments, atomic page admission/settlement/token updates and failure/retry behavior pass actual SQLite probes. Main integration passes 2,399 tests with all 99 core files at 100 percent; unchanged native sources pass 9 plugin/169 Swift checks. Independent review and signed simulator checks exercise actual Settings, Home and Stacks against a deterministic local transport; live CloudKit acceptance remains separate.
  - Scope decision: Rami declined [stable-period/backup compatibility](../docs/period-sync-compatibility-proposal.md) and the [automatic offline anchor-cycle policy](../docs/offline-anchor-cycles-proposal.md) to avoid additional complexity. Retain existing period identities, backup shapes and strict anchor validation; migration 12 remains T21. Neither proposal is pending approval or an implementation task. The inherited same-start/legacy-identity limits are not silently treated as solved.
  - Retained-contract safeguards: ambiguous board/start-date period aliases fail before an affected upload batch or received page chooses a row. Contextually invalid anchor links and target deletions use the existing deferred-record/Needs Attention path, retaining the accepted acyclic graph until an actual resolving edit arrives. No permanent period IDs, automatic cycle interpretation or unstamped link repair was added. Ordinary same-day archive/restore remains one interval; backward logical-date travel and imported duplicate-start history can still require attention.
  - Local integration and runtime checks: complete. Informational Settings rows and the iCloud toggle remain readable at maximum accessibility text sizes. Availability advice follows the actual availability result, so retained invalid records do not falsely claim iCloud is unavailable. Actual controls, cold persistence and independent review pass. Supported two-target service acceptance remains open; no automatic resolution of unsupported graph conflicts or period-lineage preservation is claimed.
  - Live service acceptance: incomplete. Updated September 9 read-only inventory finds the iPhone paired and reachable but locked; the fork's installed build could not be inspected. The iPad remains unavailable, and no two sessions on the same approved test account are verified. Simulator binaries contain fork CloudKit entitlement declarations, but runtime container authorization and actual two-target convergence remain unverified. Local replicas, fixture tests and signing alone do not close this gate.
  - Commit sequence: first land schema 11, explicit legacy migration/import/v1 compatibility and matching TS/Swift effective visibility as one working foundation. Then land source-neutral immutable admission, coordinated TS/Swift schema-2 wire support, local recovery and convergence validation. Each increment retains full validation/native review gates; the foundation alone does not complete T19 or enable new multi-device data.
  - Storage acceptance: migration 11 adds a bounded immutable inbox and local effective-check suppression, with a named checksummed data step and matching native gate. Establish deterministic true-legacy baselines and settle existing ledger scopes inside the migration before schema markers commit. Preserve old row bytes, append only justified corrections, and prove rollback including hashing/outbox failures. Released schemas 1-10 stay unchanged.
  - Shared admission acceptance: `docs/remote-fact-admission.md` governs sync/import normalization, canonical immutable equality, retained conflicting variants, missing dependencies, 32,768-variant/64-MiB inbox limits, deferred import upload intent, and zero-input recovery with iCloud disabled. Admit evidence, settle economics, derive visibility and update projections atomically. No persistent scope-work queue. A v2 payload without its action stays suppressed; remove generic raw-row legacy inference from TS/native writers and settlement. Explicit validated v1/CSV boundaries remain non-earning baseline authorities.
  - T19a acceptance: add habit-action/ledger/reward types, board/settings fields, defaults for valid v1 records, inbound semantic validation, outbox/ordering support, and immutable action/ledger merge handling. Validate policy/provenance JSON and deterministic UUIDv5 ledger/baseline identities without changing UUIDv4 command/live-action rules. Update TS and Swift mapping together. Supported compatibility is v2 reading v1; v1 peers must upgrade before accessing v2 data. Do not use a fake v1 peer that ignores types contrary to shipped code.
  - T19b acceptance: scope-aware action replay in valid stamp/id order determines conflicting Daily state, preserving targeted removals versus whole-day clears; compensation resolves superseded/duplicate earnings, cap races, duplicate bonuses/reversals, and runs complete only after merge. Transactional remote application/reconciliation updates projections and outbox once, and retries settle without oscillation. Distinct reward claims remain unchanged.
  - T19c acceptance: two signed devices/simulators converge after offline mutation, reordered/duplicated pages, interruption, and reconnection. Minimum-version behavior is documented truthfully and does not corrupt records.
  - Verify: sync/native contracts and real convergence for duplicate checks, check/uncheck, cap race, bonus/reversal duplicates, split-member completion, double claim, parent delivery order, and invalid record quarantine.
  - Ownership scope: sync records/transport/validation/engine, repositories/coin reconciler, Swift mapping, shared fixtures/tests, platform integration as needed. Do not add new columns to outgoing record allowlists before matching native support lands.
  - Depends on: T18.

- [x] **T20: Export 2 and complete import compatibility**
  - Import request/receipt recovery: integrated. A submitted import retains its captured request and command id across retryable or thrown responses and route remounts; stale or queued callbacks cannot create another import. An intentional new import still requires choosing Import another file. Main passes 2,413 tests with all 99 core files at 100 percent, current native sources retain their green gate, and independent current-composition review passes. The preserved signed simulator recovery/new-file/cold evidence has 98 artifact checks and covers sync-Off behavior; it is not a claim that its historical native binary is the current one. Parsers, export version, schema and economic rules are unchanged by this correction. This is the earlier recovery increment; paired format-2 completion is recorded below.
  - Status: done. Paired v2 export/restore, legacy compatibility, exact immutable history, acquired settings restoration and complete nested request/receipt capture pass 2,490 tests with all 101 core files at 100 percent, 9 plugin/169 Swift checks and independent review. Two fresh signed simulator stores pass actual export/native share, exact-byte import through a disclosed picker-return substitute, interrupted-response retry, repeat import preserving an edited anchor, and cold Home/Coins/Stacks/history. Source and destination retain six actions, eight ledger rows and balance 2; no fresh import earnings. Evidence: `.artifacts/t20/v2-integration/`. Live CloudKit and Checkpoint C remain open.
  - T20a acceptance: explicit export 2 fields include all new board/settings values, effective-live checks, habit actions with required policy/provenance evidence, rewards, and coin ledger. Export all accepted immutable evidence independently of live parents; suppress cleared private note payloads even when raw sync rows survive. Allow only the spec's narrowly approved evidence fields in the export scan; unrelated receipts/outbox/device metadata remain forbidden. Export omits local miss alerts, suppression and inbox metadata. Ledger snapshots survive omitted deleted parents.
  - T20b acceptance: import v1/v2 and Ripples CSV, preserve old defaults, restore anchors in two passes with complete-graph validation and existing-parent handling, preserve immutable ledger identity/snapshots, and report invalid records. Repeat import is safe; tombstoned product records stay deleted. Restoring checks never mints fresh earnings. As approved by Rami on 2026-09-08, legacy imports may atomically append deterministic corrections to existing entitlements; test the mixed Daily import that requires -1 while preserving its earlier +1 row. Use the shared T19 admission boundary, retain deferred upload intent and exact import receipt identity, and never synthesize baselines for incomplete v2 payloads.
  - Verify: round-trip, repeated restore, forward anchors/cycles, missing/deleted parent references, partial invalid data, legacy history, real device import/export, and forbidden-key scans.
  - Ownership scope: export serializer/parsers, import transaction helpers, summary/confirmation UI as needed, domain/feature tests.
  - Depends on: T19.

### Checkpoint C

- [ ] Two devices converge on Daily state and balance after every offline conflict scenario, including merged-only completion and negative double-claim balance. Native integration and export/import round-trip pass. New data is eligible for real multi-device use only after this checkpoint.

## Phase 4: alerts, sample mode, and closure

- [x] **T21: Schema 12 and never-miss-twice alerts**
  - Completed foundation: schema 12 and paired Swift gate, pure exact-date rules/identifiers, narrow local repository and additive effect types. Foundation validation passes 2,565 tests with all 103 core files at 100 percent; 9 plugin/169 Swift checks pass.
  - Runtime status: reconciliation, native adapters, provider lifecycle, Settings count and tap routing are implemented and independently reviewed. Final aggregate verification passes 2,737 tests with all 104 core files at 100 percent, plus 10 plugin/195 Swift tests. Actual iOS permission, registration, delivery, warm/cold tap, Settings and cleanup acceptance pass; the retained offline verifier passes 645 checks.
  - Native mutation acceptance: the existing Check In and Remove Latest App Intents support dated history while JavaScript may be suspended. Their private post-commit integration handles both invalidating an already pending pair and creating a newly missed current pair. Shared fixtures and actual TS/Swift writers on one SQLite file pass; actual background Shortcuts registration and cancellation acceptance pass.
  - T21a acceptance: schema 12 adds local `miss_alerts` with board/date-pair key, native identifier, status including denied, and indexes; update Swift schema gate/checksum atomically. Table never syncs or exports.
  - T21b acceptance: reconciler runs at cold start/foreground/significant time change and relevant mutation, using two most recent closed logical dates with date-based activity-period eligibility. Stacked and unstacked Daily boards use same-day checks, without usual-time windows or intraday activity-history claims. Schedule once at the next 09:00 local or immediately in foreground when applicable; denied permission records denied without prompting. Deep link opens the board; Settings shows pending count.
  - Verify: controlled clock, archived gaps/same-day restore, duplicate reconcile, permission denial, native scheduling failure/retry, notification delivery/deep link, pending count.
  - Ownership scope: schema/Swift gate, miss-alert repository/domain, notification adapter/provider/settings, tests and simulator evidence.
  - Depends on: T20.

- [x] **T22: Deterministic sample and in-memory factory**
  - Status: done. The public-command recipe and single-connection memory factory pass independent review, 2,766 aggregate tests with all 105 core files at 100 percent, and 10 plugin/195 Swift checks. Actual iOS factories match all 19 table hashes, isolate edits and close once; the relocated evidence verifier passes 306 checks. Initial startup took 51.361/50.221 seconds; the T24 sample database change reduces the fresh native measurement to 20.115 seconds.
  - Acceptance: fixed-seed generator supplies the spec's habits, a four-habit same-day stack with preset root, Count history, three years of rhythms/gaps, immutable action evidence, append-only earnings/reversals/restorations, four rewards and claims. The in-memory factory applies all migrations through schema 12. Data is seeded only into the sample database.
  - Verify: determinism, counts, calendar ranges, valid graph/ledger relationships, final schema, and no real database opens.
  - Ownership scope: sample generator, platform in-memory factory, domain/platform tests.
  - Depends on: T21.

- [x] **T23: Isolated sample navigation and effects**
  - Status: done. Source, route/runtime integration, independent review and automated gates pass. Preserved native evidence covers cold/warm entry, accepted Export joining, retained real draft/core identity, native sheets and Close, exact suspended-store/effect isolation, sample edit/check/claim and pristine reopening. The final relocated verifier passes 104 checks. Initial startup was about 50 seconds; T24 reduces the fresh native measurement to 20.115 seconds. Inherited Picker diagnostics are recorded without suppression.
  - T23a acceptance: inject all product effects, not just the database. Sample sync/widgets/notifications/import/export/intents/iCloud/icon adapters are disabled with explanations; no real native listener or widget publisher is registered by the sample provider.
  - T23b acceptance: Settings > Utilities opens a full-screen sample modal; all routes, nested forms, back actions, and internal navigation retain sample context. Persistent banner and Close remain available. Normal internal commands work; closing disposes sample state/listeners/database.
  - T23c acceptance: real database checksum remains unchanged across open/navigate/edit/claim/close, and spies prove no real prohibited adapter calls. Reopening creates a fresh deterministic sample. Test navigation and real app resumption rather than only a directly rendered sample component.
  - Verify: feature/platform isolation tests and simulator open/navigate/edit/claim/close/reopen evidence.
  - Ownership scope: provider/dependency boundary, sample host/routes/navigation, settings entry and disabled surfaces, platform adapters, tests. Separate injection, navigation, and end-to-end verification substeps.
  - Depends on: T22.

- [ ] **T24: Cosmetic rename and final closure**
  - Status: cosmetic, dependency, clean-install and accessibility corrections are committed and reviewed. Main validation passes 207 suites / 3,069 tests with all 105 core files fully covered; native tests pass 14 plugin / 195 Swift. Both production exports and the final unsigned Release package pass, including complete Shortcuts training assets. Sample runtime acceptance and the final signed Debug launch pass. The sample database scheduling fix passes the same 3,069-test gate, exact native recipe/edit/claim/reopen checks, and both updated production exports. Fresh sample startup measures 20.115 seconds. The signed iPhone installation passes after Xcode account sign-in; first launch is waiting for the phone to be unlocked again. Exact device profiles, App Group and Development CloudKit entitlements pass. Live two-target CloudKit checks still require a usable test account and actual service evidence.
  - Acceptance: README describes Habit System; remaining user-visible native/module/widget strings use the new name; internal `ripples` identifiers are renamed (module, swift types, database file, notification prefix, export format, plist keys, env var) except the import-from-Ripples feature and fork history. No starter stack is introduced. Every current success criterion has honest recorded evidence.
  - Recorded diagnostics: investigate the React Native `onAnimatedValueUpdate` listener warnings seen during T4 history and T18 archived-form navigation using the retained logs/source review; the producer family is identified, while the exact emitting node and interleaving remain unproven. The warning also recurred while opening the initial Import modal during prepared T20 simulator QA; its exact warm log is retained in `.artifacts/t20/import-recovery-candidate/qa/`. T19 engine runtime QA additionally retains eight native animation-listener events and twenty SwiftUI nil-selection/invalid-tag events during ordinary forms; these are recorded diagnostics, not proof of a newly introduced cause. Resolve actionable causes without blanket suppression and record the final runtime result. The ExpoDevLauncher scheduling warning and Release plist ordering defect are corrected and verified in the final unsigned Release package; retain the earlier failures as evidence. The final Debug build also passes scheduling checks, preserves its network discovery keys and launches the current project on the owned Metro.
  - Verify: full validation/native gates, doctor, iOS/Android exports, diff hygiene, signed-device and multi-device requirements, and independent final review. Fix discovered regressions rather than weakening gates.
  - Ownership scope: README, app/module display strings, final regression fixes as independently assigned, checkpoints.
  - Depends on: T23.

### Checkpoint D

- [ ] Every current success criterion in `SPEC-habit-system.md` section 9 is supported by recorded tests/device evidence. The removed starter-stack item stays removed; external checks that could not run are recorded as incomplete rather than asserted true.
