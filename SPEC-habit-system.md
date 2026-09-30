# Spec: Habit System

Spec id: habit-system

Prerequisites: SPEC-native-foundation.md, SPEC-ripples-product.md (both inherited from Ripples at tag `ripples-v1-fork-point`)

Capability map: CAPABILITY-MAP.md (amendment proposed in section 12 of this document)

Covered module ids: fork-identity, daily-habits, stacks, coins, rewards, miss-alerts, sample-mode

Status: Approved by Rami on 2026-09-08. Amended after the pre-T2 review: stacks stay within one logical day, bonuses return on re-completion, and offline actions reconcile deterministically with append-only ledger corrections. The review corrections, staged migrations, documentation updates, push, and continued implementation are authorized. No starter stack in code. Plan: `tasks/plan.md`; task list: `tasks/todo.md`.

Date: 2026-09-08

Author: Fable 5.1, from the design interview with Rami on 2026-09-07 and 2026-09-08. Decisions are recorded in `/Users/rami/Documents/life-os/projects/better-habit-system/` (habits-v2.md, rewards-and-coins.md, source-notes.md).

## How to read this document

This is a delta specification. Everything in SPEC-ripples-product.md remains true unless a section below says otherwise. Where this document changes an inherited rule, it names the rule and states the replacement. Nothing inherited is silently dropped.

Three inherited rules are replaced:

1. Ripples out-of-scope: "Goals, scheduled habit frequencies, skipped days, rest days, penalties, scores shared between users, or gamification." Replaced by: coins, rewards, and stack bonuses are in scope. Penalties, rest days, scheduled frequencies, and scores shared between users remain out of scope.
2. Ripples check-in semantics: "Each quick-check-in press creates one new check-in. It is not a daily on/off toggle." Replaced by: this stays true for `count` boards. A new `daily` board kind is a per-day toggle.
3. CAPABILITY-MAP.md: "The project uses exactly two specifications." Replaced by: three. This document owns the modules listed above.

## Assumptions made while writing this spec

Rami: correct any of these now. Each one is a decision I filled in because it was not covered in the interview.

1. **Stacks stay within one day.** Corrected after the pre-T2 review. A stack day contains only check-ins with that exact logical date. There is no overnight run, cross-date offset, or back-to-back-day stack. The first element's usual time is informational; it never moves a check into another date or penalizes one.
2. **Stacks are derived from anchors, not stored as their own records.** A stack is every board connected through board-to-board anchors, ordered by the anchor direction. No `stacks` table. Stack metrics recompute when the stack changes, the same way Ripples analytics recompute when a board is archived.
3. **A built-in or text anchor ends a stack.** "Wake after the alarm" starts a morning stack; the night stack is separate. The earlier proposal to join bedtime to the following morning is superseded. Board anchors describe order within the same day and cannot represent a next-day dependency.
4. **The ledger is append-only.** Coins are rows, never a stored balance. Earned total is the sum of positive rows, spent total the sum of negative rows, balance the difference. Synchronization merges immutable rows and reconciles duplicate entitlements through further rows; plain row union alone is insufficient.
5. **Claw-back applies to the daily stack bonus too.** Unchecking inside the earning day's boundary reverses its eligible coin and any now-incomplete stack bonus. Re-completing that day restores the bonus through a new entry, with at most one effective bonus for the stack and date.
6. **"Next morning" for the never-miss-twice alert means 09:00 local**, adjustable later. The alert is scheduled by the same reconciler that schedules reminders (cold start, foreground, significant time change). It cannot fire from a background that iOS does not give us.
7. **Daily boards do not track amounts or exact time.** Enabling `daily` hides Track Amounts and Track Check-In Time. A daily check-in stores amount null and time null, plus the logical date.
8. **Sample mode runs the real UI on a throwaway in-memory database.** Every screen works inside it. Sync, widgets, notifications, export, import, and intents are disabled inside it. Closing it discards everything.
9. **No starter stack.** Corrected on review. The only habit-related constants in code are the four built-in anchors and their default times. A prepared set of habits reaches a fresh install through the existing import of the app's own export JSON.
10. **Identifiers use the `studio.orbitlabs.habitsystem` family** (open question 2 confirms the exact strings). Ripples' identifiers are never reused.

Reviewed by Rami on 2026-09-08. Assumption 9 was corrected initially; assumptions 1, 3, 4, and 5 were amended after the pre-T2 review. The same-day correction supersedes the earlier overnight recommendation.

## 1. Objective

Turn the Ripples fork into a habit system: a tracker where habits can be stacked onto each other in the Atomic Habits sense ("after X, I do Y"), where checking a habit earns coins, where completing a whole stack earns a bonus, and where coins buy rewards the user defines. Everything Ripples does stays.

### Who it is for

Rami first. He runs the six-habit night-to-morning chain from habits-v2 and the coin ledger from rewards-and-coins.md on paper and in a physical jar today. The app replaces both. A public release comes later, so nothing personal is hardcoded.

### User outcomes

- Create a habit as a `daily` toggle or keep it as a `count` board.
- Anchor a habit to another habit, to a built-in anchor (waking up, lunch, dinner, sleeping), or to typed text, as "after" or "before".
- See the stacks that form from those anchors and whether each day's stack was complete, without combining consecutive dates.
- Earn one coin per checked habit that is set to earn coins, capped per day, plus one bonus coin per complete stack run.
- Write a reward list with coin prices and claim rewards with the balance.
- Get one alert when the same habit is missed two runs in a row, and nothing else new.
- See the home screen show, per daily habit, the fourteen-day strip, checks this week, and the streak.
- Open a sample of the app as if used for three years, then close it without a trace.

### Success looks like

Rami stops using the paper block and the jar within the first week of installing the app on his phone, and the Friday count happens inside the app.

### Out of scope for this spec

- Dice, wheel, or any chance-based reward (kept for a later spec)
- Deadlines on habits or any "late" state
- Penalties of any kind
- Full dependency graphs between habits (a habit has at most one anchor)
- Exporting into the Obsidian daily note
- macOS-specific UI (the iPhone/iPad build runs on Apple Silicon Macs as "Designed for iPad")
- Android UI
- Everything Ripples already lists as out of scope, except the gamification line replaced above

## 2. Tech stack

Unchanged from the inherited specs: Expo SDK 57 with Continuous Native Generation, Expo Router, React Native 0.86, React 19, TypeScript 6, `@expo/ui`, `expo-sqlite` in an App Group, `expo-widgets`, `expo-notifications`, `react-native-svg`, Reanimated 4, Bun. One local native module `modules/habit-system-apple` (renamed from `modules/ripples-apple` on 2026-09-30). No new runtime dependency is approved by this document.

## 3. Commands

```bash
bun install --frozen-lockfile
bun run start                      # metro with expo mcp
bunx expo run:ios                  # local build to the simulator
bun run lint
bun run typecheck
bun run test                       # all jest suites
bun run test:domain
bun run test:migrations
bun run test:contracts
bun run test:features
bun run test:sync
bun run test:native                # plugin config checks + swift package tests
bun run validate                   # lint + typecheck + coverage; must exit 0 before every commit
bunx expo-doctor
```

## 4. Domain rules

### 4.1 Board kind

Board gains `kind: 'count' | 'daily'`. Default for new boards is `daily`. Existing boards migrate as `count`.

`count` boards keep every Ripples rule.

`daily` boards:

- At most one effective daily completion per logical date. New local daily checks create at most one non-deleted record per date. `createCheckIn` on an already checked date returns the existing check-in id with `ok: true` without inserting. The receipt records that no mutation happened. History retained by a Count-to-Daily conversion and concurrent offline checks are explicit exceptions to physical row uniqueness. Preserve every active record's notes, amount, and time; projections and coin settlement resolve one effective Daily completion instead of deleting extra active history.
- The quick action toggles. On an unchecked day it creates the check-in. On a checked day it removes it (a tombstone, as in Ripples). Both paths run through named commands.
- `tracksAmount` and `tracksTime` are forced false and their controls are hidden. Existing amounts and times on a board switched to `daily` are retained, not deleted.
- Heatmap cells have two states, unchecked and checked. The accessibility label says "checked" or "not checked" with the date.
- Analytics are unchanged: a completed day is one with a check-in. Streak, consistency, weekday, timeline, and year comparison all work without change.
- Switching kind is an edit with optimistic concurrency. Switching `count` to `daily` keeps all history; days with several check-ins show as checked.
- Unchecking a daily date tombstones all live checks for that date in one transaction, with confirmation when any has a note. Deleting one selected history entry remains a single-record operation. Toggle reads and writes in the same command transaction. Edits, Undo, import, sync, and native intents obey the same daily-state rules.
- Concurrent offline actions replay by the existing total hybrid-clock order, with stable id tie-breaking. A Daily uncheck clears the whole date; Count removals, individual history deletion, Undo, and move-out remove only their referenced check. The date is checked when any completion remains. A whole-day uncheck supersedes earlier checks and a later check restores completion. Sync must reconcile duplicate daily completions and their coin consequences. A local unique index alone is not the conflict policy.
- Effective checks are current non-deleted payloads whose ids survive the accepted action replay for that exact board/date. A local suppression flag records this derived visibility without rewriting synchronized payload fields or their mutation stamps. A later note edit cannot revive an earlier cleared token; a current payload at another date is absent from the old date's display. History, counts, stacks, widgets, intents and export use effective checks.

### 4.2 Anchors

Board gains:

| Field | Contract |
| --- | --- |
| anchorRelation | `'after'`, `'before'`, or null |
| anchorKind | `'board'`, `'preset'`, `'text'`, or null |
| anchorBoardId | BoardId when anchorKind is `board`; must be an active or archived board; never self |
| anchorPreset | `'wake'`, `'lunch'`, `'dinner'`, `'sleep'` when anchorKind is `preset` |
| anchorText | trimmed, 1 through 80 code points when anchorKind is `text` |
| usualTimeMinute | nullable, 0 through 1439 in 15-minute increments |
| requiredInStack | boolean, default true |

Rules:

- A board has at most one anchor. The five anchor fields are all null, or relation and kind are set with exactly the matching target field. Other target fields remain null.
- "A after B" and "B before A" describe the same order. The UI offers both directions so the user can write the sentence naturally. Storage keeps what the user chose.
- Anchor cycles are rejected by validation: following board anchors from any board must terminate. `deleteBoard` on an anchored-to board clears all five anchor fields on its direct undeleted dependents, including archived boards, in the same transaction. The confirmation reports how many links will be removed. Dependent boards and their history remain; indirect links keep their immediate parent.
- Archiving an anchored-to board keeps the link. Stack computations treat an archived member as absent.
- Text anchors are plain text. They are not entities and are not shared between boards.

Built-in anchor times live in AppSettings:

| Preset | Default minute | Label |
| --- | --- | --- |
| wake | 420 (7:00) | Waking up |
| lunch | 720 (12:00) | Lunch |
| dinner | 1080 (18:00) | Dinner |
| sleep | 1380 (23:00) | Sleeping |

All four are editable in Settings in 15-minute increments. They sync as part of the settings record.

### 4.3 Stacks

A stack is derived. It is the set of boards reachable from one another through `board` anchors, ordered so that every "after" edge points forward and every "before" edge points backward. Siblings anchored to the same board on the same side (Before or After) keep home order, with board id breaking ties. This sibling precedence must survive a sibling's own dependencies; ready-node priority alone is insufficient.

- Stable identity: `rootId` is the component's structural root board, found by following stored board anchors to a board without a board anchor. Display order is a stable topological ordering of before/after relations, with home order and board id as tie-breakers. The structural root need not be the first displayed member. Archived members retain structural links and identity but are absent from the active display and completion requirement.
- Usual start minute: use the first active displayed board's own usual time, otherwise its directly attached After-preset's configured time, otherwise 0. A Before-preset or a preset attached to a later displayed board does not supply a leading time. Text anchors use their anchoring board's own usual time. This is a display hint only, not a run boundary. Presentation distinguishes an absent hint from an explicitly configured midnight.
- A run means one stack day, keyed by `<rootId>|<logicalDate>`. Only check-ins whose stored logical date equals that date participate, for both timed and untimed boards. Never reassign by occurrence instant, creation time, usual time, or the next day's checks. Each following date has its own independent run.
- The structural root's inherited `startOfDayMinute` determines the current stack date and when a stack day closes in the device's current time zone. It does not change any member's stored logical date. A member's own board day still governs its individual daily toggle and check-coin boundary.
- Completion uses stored date-based activity periods and current anchor membership. For stacks, a period includes its start date and excludes its closed end date: archiving removes the habit from requirements on the stored archive logical date. Restoring on that same date reopens the period and makes the habit required again. Earlier dates retain historical eligibility, archived gaps remain unavailable, and inherited non-stack analytics keep their inclusive end-date rule. A run is complete only when at least one required eligible member exists and every required eligible member has a check with that exact date. There is no inferred intraday activity history. Root/membership edits recompute stack analytics; they do not create a cross-date stack or mint retroactive historical bonuses.
- A stack with one member is still a stack. A board with no anchors and nothing anchored to it is not in any stack.

Stack metrics (all derived, none stored):

- complete runs per ISO week
- longest consecutive complete-run streak
- per-member checks per ISO week: Daily contributes one per eligible checked date; Count contributes every live eligible check-in, using the stack's current ISO week and logical-date horizon
- stack heatmap: one cell per stored logical date for the rolling 365 dates ending on the current stack date, shaded by the fraction of required eligible members checked. The four steps are none (zero), some (positive through one half), most (more than one half but incomplete), and all (every required eligible member checked). Dates without required eligible members are unavailable, never complete. Every cell has a text alternative.

### 4.4 Coins

Board gains `earnsCoins: boolean` (default false) and `coinCapPerDay: integer 1 through 10` (default 1).

New table `coin_ledger`:

| Field | Contract |
| --- | --- |
| id | branded LedgerEntryId; UUIDv4 for user claim rows, deterministic UUIDv5 for rows derived from immutable evidence |
| kind | `'check'`, `'run_bonus'`, `'claim'`, `'reversal'`, `'adjustment'` |
| delta | nonzero safe integer; exactly +1 for `check` and `run_bonus`, negative for `claim` and `reversal`; either sign for deterministic reconciliation adjustments |
| boardId | BoardId for `check`; null otherwise |
| checkInId | CheckInId for `check`; null otherwise |
| runKey | `<rootId>|<runDate>` for `run_bonus`; null otherwise |
| rewardId | RewardId for `claim`; null otherwise |
| rewardTitleSnapshot | trimmed reward title, at most 80 code points, for `claim`; null otherwise |
| reversesId | LedgerEntryId for `reversal`; null otherwise |
| scopeKey | `check:<boardId>:<logicalDate>` or `bonus:<rootId>:<logicalDate>` for earning/correction rows; null for claims |
| sourceActionId | nullable immutable habit action id responsible for the economic event |
| reconciliationKey | nullable canonical evidence-set digest for an adjustment |
| adjustsId | nullable ledger entry id whose obsolete correction is canceled |
| provenanceJson | nullable canonical sorted immutable evidence fingerprints for a correction |
| logicalDate | board logical date for `check`, stack date for `run_bonus`, current logical date for `claim`, earning scope's date for reversals and adjustments |
| createdAt | UTC epoch milliseconds |
| mutationStamp | hybrid logical clock stamp |
| deletedAt | always null; ledger rows are never tombstoned |

Rules:

- Earned total is the sum of positive deltas. Spent total is the absolute sum of negative deltas. Balance is their difference. All three are queries, never columns.
- A `check` row is written in the same exclusive transaction as its check-in when the immutable policy enables coins and scope replay has fewer outstanding canonical awards than `coinCapPerDay`. Raw corrected rows do not consume a cap slot. Its deterministic identity uses the earning scope and source check action; retries of that event cannot earn again.
- A `run_bonus` of +1 is written when a stack day becomes complete. Its net entitlement is one coin per `runKey`. Re-completing after a reversal restores the bonus through a new immutable row. Idempotency applies to each causally identified completion or correction, not a permanent unique constraint on `runKey`.
- Claw-back: removing or unchecking an earned check writes a reversal while its board logical day is still open. A stack bonus reverses while the structural root's logical day is still open and the day becomes incomplete. After each boundary its legitimate historical earnings stay. Concurrent duplicate/cap corrections remain required after day close; they correct conflicting awards rather than penalizing late edits.
- Capture the economic close at the first actual crossing of the following date's start-of-day threshold in the action's time zone. A missing threshold closes at the first real instant after a clock gap; a repeated threshold uses its first occurrence and never reopens an already closed award. Equality is closed. Stored dates, informational times and conservative display-refresh deadlines remain separate from this captured boundary.
- A `claim` row of -cost is written when a reward is claimed. The command fails with `validation` when balance is below cost. Balance is read inside the same exclusive transaction.
- Ledger rows sync as first-class immutable records. Equal ids require equal payloads. Deterministic reconciliation preserves one effective daily completion, the board/day cap, one effective stack bonus, and one effective reversal per award. It also awards a stack completed only by merging separate offline member checks. App commands, Swift intents, and sync use the same contract; corrections append rows and converge under duplicate and out-of-order delivery.
- A claim made offline on both devices that together overspend is accepted; the balance can go negative and the UI shows it. The next earnings pay it back. Claims are never discarded to repair overspending.
- Earn Coins and Daily Coin Cap are editable board-form controls for both Count and Daily. All mutation paths apply consequences atomically: create, remove, daily toggle, Remove Latest, Undo, date/time edits, and board deletion. Import preserves historical ledger identity and does not mint fresh earnings from restored checks.
- Editing a check's date or time never mints fresh check coins or bonuses. A date move records leaving the old date and entering the new one; leaving may revoke the old date's entitlement while its captured day remains open. Closed-day earnings stay and the edit earns nothing new. Changing anchors, required members, or coin settings applies prospectively and does not retroactively award a historical completion.
- Moving a habit between surviving stacks updates both stacks' requirements. Retire an old root/date only when that stack disappears; a stale offline observation cannot restore its old requirements. Policy changes preserve earlier valid awards and their captured boundaries. Each policy and completion still belongs to one exact stored logical date.
- Export includes the ledger. Version 1 and CSV imports never earn fresh coins from restored checks. They may append deterministic corrections to existing coin entitlements when the restored legacy history changes accepted replay. Original ledger rows remain immutable, and the import commits its corrections atomically. This clarification was approved by Rami on 2026-09-08.
- `docs/ledger-reconciliation.md` defines the shared TS/Swift settlement protocol, immutable action evidence, deterministic identities, provenance validation, and obsolete-correction cancellation. It is part of this specification. Raw positive/negative totals remain as defined above; technical corrections do not silently change their formulas.

### 4.5 Rewards

New table `rewards`:

| Field | Contract |
| --- | --- |
| id | branded RewardId, UUIDv4 |
| title | trimmed, 1 through 80 code points |
| costCoins | integer 1 through 100000 |
| symbol | allowlisted SF Symbol, same list and fallback as boards |
| accentHex | uppercase #RRGGBB |
| orderKey | sortable text key with RewardId tie-breaker |
| archivedAt | nullable |
| createdAt, updatedAt, mutationStamp, deletedAt | as boards |

Rules:

- Rewards are user-defined. Nothing is seeded. The empty state explains in one sentence and offers Create Reward.
- Claiming requires a confirmation that states the cost and the balance after. Successful claim writes the ledger row and shows the claim in Coin History.
- Confirmation uses one snapshot of the active reward and current balance. The claim rechecks the reward's mutation stamp and balance inside its exclusive transaction; a changed reward requires fresh confirmation, while intervening balance changes are allowed if the cost is still affordable. An uncertain retry uses the original command receipt, including after later reward edits or deletion.
- Claims use the acquired current local date with a midnight boundary, since rewards have no habit-specific start of day. A successful receipt retains that original date on replay.
- Archived rewards remain readable and can be restored to the end of the active list. Editing and claiming require an active reward; archive, restore, reorder and deletion never alter earlier ledger rows.
- Editing a reward's cost does not change past claims.
- Deleting a reward tombstones it. Its past claims remain in the ledger with the reward's title copied into the confirmation history at claim time (`claim` rows store `rewardTitleSnapshot`, trimmed, 80 code points, so history survives deletion).
- Rewards sync and export like boards.

### 4.6 Never miss twice

- Applies to `daily` boards only.
- New alerts require a currently active, undeleted board. Use that board's own start-of-day shift and exactly the two preceding logical-date labels; do not skip an ineligible gap to find older misses. Optional membership, usual times and coin settings do not change this rule.
- A miss is an eligible logical date with no check-in on that date. Stacked boards use the same exact-date rule as stack completion. Eligibility uses the inherited date-based activity periods, not an assertion about every intraday instant. Creation dates and closed periods follow the inherited analytics convention; tests explicitly cover same-day archive/restore.
- When a board's two most recent closed windows are both misses and no alert has been recorded for that pair, the reconciler schedules one local notification for the next 09:00 local time, or immediately if that has passed and the app is in the foreground. Body: "[title] was missed twice. Fix the environment before anything else today." The tap deep-links to the board.
- New device-local table `miss_alerts` stores boardId, the second missed date key, nullable native identifier, and schedule status (`pending`, `scheduled`, `denied`, `error`). It never syncs and is excluded from export.
- The alert uses the existing notification permission. If permission is denied, the alert is recorded as `denied` and nothing prompts. Settings > Notifications shows the count of pending miss alerts.
- A denied pair is terminal and does not become a backlog after permission is granted. Undetermined permission waits without prompting while the pair remains current and eligible. The pending count comes from the platform's pending-request inventory matched to local records; historical scheduled rows are not counted. An unavailable inventory is reported as unavailable, never as zero.
- Reserve a pair before the native scheduling call. Proven non-acceptance may retry; a lost or unknown result retains its identifier and is not reissued merely because it is absent from pending/delivered inspection. A positively observed future request may be updated under the same identifier. Keep deduplication after cancellation or board deletion. Database and native effects are not one transaction, so this prevents ordinary duplicate reconciliation without claiming crash-proof exactly-once delivery. Platform delivery precision and suspended-app time-zone handling remain native constraints.
- The existing Check In and Remove Latest Shortcuts also reconcile the affected board after a successful command or receipt replay. A dated check can cancel an incorrect pending alert; removing a check can create the current missed pair while JavaScript is suspended. This private post-commit work uses the same local rows and rules, does not change a successful command result if alert processing fails, and adds no background service or public automation parameter.
- Ripples' per-board reminders are unchanged and remain the way to be reminded before a habit.

### 4.7 Home screen

For `count` boards, unchanged.

For `daily` boards the card shows: symbol, title, fourteen checked-or-unchecked cells ending today, "N/7 this week" using ISO Monday weeks and the board's logical day, the current streak as a small label, and the toggle. A checked toggle is visually filled and its accessibility label is "Checked, double tap to uncheck". Color is not the only indicator.

A coin balance pill sits in the Boards header trailing area, before edit and plus. Tapping it opens Coins. It shows the integer balance with a text label for VoiceOver.

### 4.8 Stacks screen

New root-level route `/stacks`, reached from a Boards header icon. It lists derived stacks. Each stack shows its members in order with today's state, the usual start time, complete days this week, and the current complete-day streak. Selecting a stack opens `/stacks/[rootId]` with the stack heatmap and per-member counts. There is no create or edit on this screen; stacks change by editing anchors on boards. The empty state explains anchors in one sentence and links to Create Board.

### 4.9 Coins and rewards screens

`/coins` shows balance, earned total, spent total, and the reward list with Claim actions. `/coins/history` is a virtualized ledger, newest first, grouped by logical date, with kind, delta, and the board, run, or reward it refers to. `/coins/rewards/new` and `/coins/rewards/[rewardId]` are native form sheets with the same structure as board forms.

### 4.10 Sample mode

- Settings > Utilities gains "Try a sample". It opens `/sample` as a full-screen modal.
- The modal runs the complete app stack against a separate in-memory SQLite database created from the same migrations, seeded by a deterministic generator with a fixed seed: eight habits, one four-habit stack with a preset root, one count board, three years of check-ins with realistic weekly rhythms and gaps, coins earned and reversed, four rewards with claims.
- A persistent top banner reads "Sample data. Nothing here is saved." with a Close button in the trailing corner. Close discards the database.
- Inside sample mode: sync, widgets, notifications, export, import, App Intents, iCloud settings, and App Icon are disabled with a one-line explanation. Every other command works so the user can feel the app.
- Sample mode never reads or writes the real App Group database. A test asserts the real database file's checksum is unchanged across a sample session.
- Database, clock, and platform adapters are injected at the sample host. All nested routes retain sample context. Real-store background coordination is suspended during the sample session; widget publication, native listeners, and every disabled adapter are verified separately from the file checksum. Closing disposes the sample database and resumes the real app.

### 4.11 Starter stack

Removed on review, 2026-09-08. No template constant, no Settings action. The four built-in anchors in 4.2 are the only habit-related constants in code. Import of the app's own export JSON is the path for a prepared set of habits.

### 4.12 Widgets, intents, sync, export

- Widget rows persist the board kind and derive checked state from their strip. The quick action deep-links to a daily toggle flow that displays fresh state, offers an explicit Check/Uncheck action, and asks before removing notes. Opening or remounting the flow never mutates by itself; new checks retain widget provenance. Count boards retain Add Check-In. No in-extension mutation is claimed.
- Widget publication refreshes derived rows before describing them as current. TypeScript and Swift publish matching generation/expiry metadata, accounting for midnight, active boards' shifted day boundaries, and DST gaps or repeated hours. Expiry is a conservative display-refresh deadline, not a coin claw-back boundary. Refreshing this cache creates no habit action, receipt, mutation stamp, or outbox item.
- App Intents: Check In on a `daily` board checks it (idempotent for the day). Remove Latest Check-In un-checks it. Get Today's Check-Ins reports checked or not. The shared fixture suite gains cases for all three.
- Sync: `habit_actions`, `coin_ledger`, and `rewards` add `habit_action`, `ledger_entry`, and `reward` entity types. Board and settings records carry the new fields. The active writer uses sync schema 2; the explicit version-1 compatibility codec retains its own version constant. Version 2 reads valid version 1 data with compatibility defaults. Existing version 1 clients reject unknown versions/types; they must be upgraded before participating in the version 2 data set. TS serialization, inbound validation, engine merge, outbox handling, and Swift mapping change together.
- Remote immutable facts use a bounded device-local inbox for missing dependencies, capacity blocks and quarantined invalid/conflicting variants. Unequal bytes under one immutable id never use last-writer-wins. Accepted evidence, deterministic economic settlement, effective visibility and projections commit together before a page token or successful import receipt advances. Zero-input recovery works independently of enabled iCloud sync. `docs/remote-fact-admission.md` defines this shared sync/import contract.
- Export: `exportVersion` becomes 2 and includes new board/settings fields, `habitActions`, `rewards`, and `coinLedger`. Import accepts versions 1 and 2 and Ripples CSV. Restore anchors in two passes, validate the resulting graph, and retain immutable action/ledger ids. Ledger references to deleted checks/rewards may remain unresolved in the live exported objects; action evidence, history, and title snapshots must round-trip regardless. Action evidence never contains note text.
- Cosmetic naming: new backups use `habit-system-export-YYYY-MM-DDTHH-mm-ssZ.json`, overriding the inherited filename prefix. Cache cleanup recognizes both this prefix and legacy `ripples-export-` files. The payload format is `habit-system.export` since 2026-09-30 (it was `ripples.export`); import accepts both format names, and version compatibility is unchanged.
- Export includes only effective-live check payloads, plus all accepted immutable actions and ledger rows independently of live parents. Cleared notes remain excluded even if a raw payload survives synchronization. Local visibility and inbox metadata never sync or export.
- Version-2 mutable records omit internal stamps and deletion state. Accepted immutable action and ledger records retain the exact canonical evidence fields from `docs/ledger-reconciliation.md`, including action command ids, creation times, mutation stamps, policy/provenance strings, claim title snapshots, and ledger `deletedAt: null`. This is a scoped exception to the inherited forbidden-key scan; receipts, outbox, device/HLC state and unrelated internal fields remain excluded. Immutable input reaches the shared admission boundary without stripping unknown fields into validity.
- Version-2 restores preserve valid stored check dates, occurrence/amount/time/source history and date-only activity-period arrays, even after a Count habit becomes Daily or the device changes logical dates. Well-formed period order, multiplicity, empty arrays, overlaps and reversed intervals are preserved; malformed endpoints reject that board. This makes explicit the period-preservation correction established in T15. Genuine version-1 files keep their existing malformed/empty-list fallback. No period identity or additional backup metadata is introduced.
- Version-2 shared settings restore only into an empty, unconfigured destination, determined inside the acquired import transaction before new records are inserted. Existing or previously configured shared settings are kept. A fresh restore copies only valid education-dismissal ids and the four preset minutes, using one ordinary local settings stamp/outbox entry when values change. Missing or invalid settings are reported and never silently replaced with defaults. Version-1 and CSV settings behavior stays unchanged.
- Migration: version 6 adds board/settings fields and widget kind; version 7 adds immutable habit actions with daily semantics; version 8 adds the ledger; version 9 indexes exact-date action discovery; version 10 adds rewards; version 11 adds the immutable remote-fact inbox and effective check visibility; version 12 adds device-local miss alerts. Every migration is exclusive and checksum-tested against all earlier fixtures, and updates the Swift schema/checksum gate in the same commit. Released migrations never change. Migration 11 includes a named, versioned, checksummed data step that establishes true legacy baseline evidence and settles existing economic scopes before publishing schema markers.
- Intermediate task builds are development checkpoints, not release candidates. New data must not be used across real devices or exported as a complete backup until the native, sync, and export integration gates pass. No unsupported version 1 compatibility or completed product behavior may be claimed by a partial slice.
- T19 scope decision: Rami declined the additional stable activity-period IDs/backup metadata and automatic offline anchor-cycle interpretation proposed in `docs/period-sync-compatibility-proposal.md` and `docs/offline-anchor-cycles-proposal.md`, favoring lower complexity and mostly sequential device use. Keep existing period identity and backup shapes; migration 12 remains local miss alerts. Self-links and cyclic anchor graphs remain invalid. Do not add either declined design under a different name or claim its guarantees; ordinary validation, atomic writes, supported sync/import behavior and their verification remain required.

### 4.13 Immutable habit action evidence

`habit_actions` records the minimum immutable evidence needed for latest-action daily state and deterministic coin settlement. It lives in the same SQLite store; it is neither a second store nor a stored balance, stack, or run. Fields: `id` (UUIDv4 for live actions, deterministic UUIDv5 for synthetic baselines), nullable `commandId` (UUIDv4 for live commands, null for baselines), `boardId`, `logicalDate`, nullable `checkInId`, action `kind`, `createdAt`, `mutationStamp`, and nullable canonical `policyJson`. The policy snapshot contains only the coin rules, relevant member ids, and day-close instants for that action; it contains no notes or habit titles. Exact action kinds, canonical encoding, compatibility baselines, and settlement rules are in `docs/ledger-reconciliation.md`.

Commands write their action evidence in the same transaction as the check-in, receipt, widget projection, and outbox. Existing Count history and its established action evidence survive conversion. Explicit legacy admission establishes deterministic daily-state baselines without inventing historical coins. Immutable actions sync and export with the ledger so losing offline actions and closed-day entitlement facts remain available. A repeated id with unequal content is rejected and never overwrites accepted evidence.

From schema 11 onward, baseline creation is authorized only by the legacy migration and explicit validated version-1/CSV admission. Ordinary app/native commands and settlement never infer legacy status merely because a raw payload lacks action evidence. A version-2 payload arriving before its action stays suppressed until accepted evidence makes it visible. A supported version-2 export already includes the true legacy baselines established by migration.

## 5. Project structure

Additions only. Everything else is as in SPEC-ripples-product.md.

```text
src/
  app/
    stacks/                index.tsx, [rootId].tsx
    coins/                 index.tsx, history.tsx, rewards/new.tsx, rewards/[rewardId].tsx
    sample.tsx             full-screen modal host
  core/
    domain/
      stacks.ts            derive stacks, runs, completeness (pure)
      coins.ts             ledger rules, cap, claw-back window (pure)
    analytics/
      stacks.ts            complete runs per week, run streak, stack heatmap
    persistence/
      repositories/        ledger.ts, rewards.ts, miss-alerts.ts
    sample/
      generator.ts         deterministic sample data
  features/
    stacks/
    coins/
    sample-mode/
    anchors/               anchor picker bottom sheet
  platform/
    database/              in-memory database factory for sample mode
tests/
  product/
    domain/                stacks.test.ts, coins.test.ts
    features/              stacks-slice.test.tsx, coins-slice.test.tsx, sample-mode.test.tsx, anchors.test.tsx
    migrations/            v5-to-v6 fixture
    sync/                  ledger and rewards records
    contracts/             daily-board intent cases
```

## 6. Code style

Inherited. One illustration of how the new pure domain code should read: small, typed, no I/O, lowercase comments, no clever abstractions.

```ts
// a stack day requires at least one eligible required member and checks on that date
export function isRunComplete(run: StackRun): boolean {
  const required = run.members.filter((member) => member.requiredInStack && member.eligible);
  return required.length > 0 && required.every((member) => member.checkInIds.length > 0);
}

// user claw-back is allowed only before the relevant logical day closes
export function canReverseCoin(input: {
  nowUtcMs: number;
  dayClosesAtUtcMs: number;
}): boolean {
  return input.nowUtcMs < input.dayClosesAtUtcMs;
}
```

Conventions that matter most here: branded ids for every new entity, `DomainResult` for every command, named commands for every mutation, pure functions in `src/core/domain` with the database touched only in repositories.

## 7. Testing strategy

Inherited process: red, green, refactor; Jest with React Native Testing Library; queries by accessible role and name; 90 percent global coverage; 100 percent branches on domain, calendar, analytics, migrations, export, sync; simulator evidence and an independent verification pass before every commit; a `checkpoints.md` entry per task.

New coverage that this spec requires:

- Domain: stack derivation for chains, siblings, before/after mixes, cycles (rejected), archived members, preset and text roots; exact-date assignment with consecutive dates never combined, DST and time-zone changes at day close; optional and empty required sets; cap enforcement; claw-back inside and outside the day; bonus restoration and idempotency; claims and ledger totals.
- Migrations: version 5 fixture migrates to 6 with defaults; every earlier fixture still opens.
- Sync: ledger/rewards round-trip; version 2 reads version 1; conflicting daily actions, cap races, duplicate awards/reversals, merged stack completion, and out-of-order adjustments converge. Offline double claims remain in the negative balance.
- Contracts: daily-board cases in `intent-contract.json`, executed by both the TypeScript and Swift executors.
- Features: toggle behavior and accessibility labels; anchor picker with all three kinds and both directions; stacks screen states; coins screens; sample mode isolation (real database checksum unchanged).
- Device: Argent evidence for toggle, anchor picker, stacks screen, claim, sample mode open and close, and the miss alert firing on a simulator with the clock advanced.

## 8. Boundaries

**Always**

- Run `bun run validate` before every commit; keep every `src/core` file at 100 percent.
- Route every mutation through a named command with an idempotency key.
- Keep the ledger append-only.
- Keep the SQLite database the only source of truth. Derived values (balance, stacks, runs) are queries.
- Preserve every Ripples behavior for `count` boards.
- Change the identifiers in FORK.md before the first build.

**Ask first**

- Any new column, table, sync entity type, or export field beyond section 4.
- Any new runtime dependency.
- Storing a balance, a stack, or a run as a row.
- Adding chance mechanics, deadlines, or penalties.
- Changing the four preset anchors or their 15-minute step.
- Changing the claw-back window or the cap range.
- Any change to the Swift module's public surface.

**Never**

- Tombstone or delete a ledger row.
- Seed data into a real user's database. Data enters only through the user's own actions and import.
- Let sample mode touch the App Group database.
- Reuse a Ripples bundle id, App Group, CloudKit container, EAS project, or scheme.
- Weaken tests, coverage, or accessibility to pass a gate.
- Add agent signatures or co-author lines to commits.

## 9. Success criteria

1. A `daily` board toggles from Home, the widget deep-link flow, and Shortcuts with one effective completion per day, preserved legacy history, and correct accessibility labels.
2. Anchors of all three kinds and both directions save, validate (no self, no cycle), and render as sentences in the board form.
3. Habits entered by hand form ordered stacks within a single logical date. A bedtime check and a following-day wake check never complete the same stack day.
4. Checking a coin-earning habit writes its eligible `check` row; the cap holds; unchecking before its logical day closes reverses it, and later user removal preserves it. Native and app writers agree.
5. Completing a stack day gives one effective bonus; unchecking within that day reverses it and re-completing restores it without duplicate entitlement.
6. A reward can be created, claimed with sufficient balance, refused with insufficient balance, and its claim survives the reward's deletion.
7. Two devices with offline ledger writes converge to the same balance after sync, including a negative balance from double claims.
8. Every staged schema migration opens all earlier fixtures and passes the Swift gate; export version 2 round-trips; import accepts versions 1 and 2 and Ripples CSV, preserving ledger history and anchor references.
9. The never-miss-twice alert schedules exactly once per missed pair, deep-links to the board, and never prompts for permission on its own.
10. Sample mode opens with three years of generated data, every screen works, and the real database checksum is unchanged after closing.
11. Removed on review (starter stack).
12. Home shows fourteen cells, checks this week, and streak for daily boards; the balance pill reads correctly to VoiceOver.
13. All gates pass: `bun run validate`, `bun run test:native`, `bunx expo-doctor`, iOS and Android exports.
14. The app runs under its own identifiers on a signed device and never appears in Ripples' CloudKit container or EAS project.

## 10. Open questions

Items 1 through 6 are resolved. The post-review correction supersedes the original single overnight stack recommendation: stacks only group one logical date, so morning and night routines do not bridge consecutive dates. Bonus restoration and offline latest-action reconciliation are approved. Identifiers, constant 09:00, cap 1 through 10, and cosmetic rename order remain approved. Items 1 through 5 below are historical. Rami also approved excluding the archive date from stack requirements in item 6.

1. **Stack date scope, resolved.** Stacks exist within one day only. The proposed bedtime-to-next-morning run was rejected. Separate night and morning anchors retain the source design without a cross-date dependency.
2. **Exact identifiers.** Proposed: name and slug `habit-system`, bundle `studio.orbitlabs.habitsystem`, App Group `group.studio.orbitlabs.habitsystem`, container `iCloud.studio.orbitlabs.habitsystem`, zone `habit-system`, scheme `habitsystem`, new EAS project via `eas init`. Confirm or change.
3. **Miss alert time.** 09:00 local as a constant, or editable in Settings next to the preset anchors? Recommendation: constant now.
4. **Coin cap range.** 1 through 10 per day. Is 10 enough for a count board like water?
5. **Public name.** The README still says Ripples. The rename of the README, the native module, and the widget display name is cosmetic and can be its own task after the first build. Confirm that order.
6. **Archive-date stack eligibility, resolved.** Rami approved removing an archived habit from that date's stack requirements immediately, with same-day restore requiring it again. Stack eligibility excludes a period's stored closed end date and includes its start date; reopening the period restores eligibility. This remains a stored-date model, without inferred archive instants or a current-day-only filter. Inherited non-stack analytics retain their existing inclusive end-date behavior.

## 11. What happens after approval

Per the spec-driven-development skill: Phase 2 writes `tasks/plan.md` (components, order, risks, checkpoints), Phase 3 writes `tasks/todo.md` (tasks of at most five files each, with acceptance and verification), and Phase 4 implements one task at a time with tests first. The existing Ripples `tasks/plan.md` and `tasks/todo.md` are archived under `tasks/ripples/` first.

## 12. Proposed CAPABILITY-MAP.md amendment

Applied to CAPABILITY-MAP.md on 2026-09-08.

- Rule "The project uses exactly two specifications" becomes three: SPEC-native-foundation.md, SPEC-ripples-product.md, SPEC-habit-system.md.
- New module rows:

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| `fork-identity` | New bundle, group, container, scheme, EAS project, and name; FORK.md table applied | `native-foundation` |
| `daily-habits` | `daily` board kind, toggle semantics, home card, widget and intent behavior | `boards`, `board-configuration`, `widgets`, `automations` |
| `stacks` | anchors, preset anchor settings, derived stacks and runs, stacks screens and analytics | `daily-habits`, `analytics` |
| `coins` | append-only ledger, earning, cap, claw-back, run bonus, balance, history, sync and export of ledger rows | `stacks`, `cloud-sync`, `data-export` |
| `rewards` | reward records, claim flow, reward screens | `coins` |
| `miss-alerts` | never-miss-twice reconciler and notification | `daily-habits`, `reminders` |
| `sample-mode` | in-memory database, deterministic generator, sample modal | `coins`, `rewards`, `stacks` |

- Build order appended: `fork-identity` -> `daily-habits` -> `stacks` -> `coins` -> `rewards` in sequence; then `miss-alerts` and `sample-mode` in parallel.
