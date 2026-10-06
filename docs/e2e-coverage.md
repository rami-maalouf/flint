# habit system end-to-end coverage

The suite uses the installed tester-army/e2e 0.15.2, mobile 0.9.0 and agent-device 0.21.18. Jest and Swift results are source checks, separate from real UI evidence.

## environment and reproduction

- source base: published main `492592de63f5c36464bce6a31ae46a738cb07a33`
- checkout: `habit-system-e2e-complete`, branch `test/e2e-personal-flows`
- isolated iPhone 17 Pro / iOS 26.5: `E2CB451D-AC1F-42BB-96A3-ED4FF08E01D0`
- Metro: port 8085; the local wrapper requires the explicit URL and forces a project-local agent-device daemon
- native app: exact main source, clean development CNG, arm64 simulator build, simulated entitlements, Apple Development signing copy with team `3V2UU7RRK9`
- signing proof preserves executable text, embedded entitlement sections, Info.plist and AppIntent metadata; simulator signing does not prove physical-device or CloudKit acceptance
- suite never clears, uninstalls or writes personal data; read-only SQLite checks require a matching explicitly opted-in synthetic UDID
- each test creates unique `QA ` names; quick actions resolve the matching active board's stable order instead of tapping an unrelated retained board

```sh
E2E_DEVICE=E2CB451D-AC1F-42BB-96A3-ED4FF08E01D0 \
E2E_SYNTHETIC_DEVICE=E2CB451D-AC1F-42BB-96A3-ED4FF08E01D0 \
E2E_METRO_URL=http://127.0.0.1:8085 \
E2E_NATIVE_RECEIPT=.artifacts/native-receipt.json \
bun scripts/e2e/run-local.ts
```

The wrapper archives command, timestamps, exit code, device, Metro URL, JS commit/diff, native receipt and reports under `.artifacts/e2e-evidence/`. A failed or interrupted command is never success. Bootstrap is opt-in with `E2E_BOOTSTRAP=1`; launch arguments independently pin the Metro URL and hide development tools that cover product controls.

## coverage matrix

| flow | runnable test | observed status | limitation |
| --- | --- | --- | --- |
| dev-client bootstrap | bootstrap.e2e.ts | exact main bootstrap passed, run 01a10ec1-e7e7-7c14-b3c6-8697747b690b | bootstrap only |
| home and original semantic canaries | boards.e2e.ts, settings.e2e.ts, layouts.e2e.ts | rerun pending | original agent canaries remain |
| daily create, complete, undo, persisted coin ledger | lifecycle.e2e.ts | passed run 01a10ee0-d5a8-7f15-bbd4-b8779213b0d8 | full lifecycle and balances verified |
| count amount/note, check-in edit/delete | count-history.e2e.ts | pending | actual UI suite |
| board validation/edit/archive/restore/delete | board-management.e2e.ts | earlier pass 01a10ed3; latest destination transition failed | explicit destination readiness rerun required |
| detail history/journal/analytics | lifecycle.e2e.ts | passed run 01a10ee0-d5a8-7f15-bbd4-b8779213b0d8 | navigation alone is not analytics correctness |
| all four persisted home layouts | layout-coverage.e2e.ts | pending | selected state and reopen asserted |
| anchor presets and stack completion/bonus/reversal | stacks.e2e.ts, settings-flows.e2e.ts | pending | persisted balances asserted |
| rewards create/claim/refusal/archive/restore | lifecycle.e2e.ts, reward-management.e2e.ts | pending | balances checked across restart |
| reminders CRUD and notification status | reminders.e2e.ts, settings-flows.e2e.ts | pending | scheduled delivery and miss-alert time advance separate |
| settings children and anchor cancellation | settings-flows.e2e.ts | pending | navigation is not full feature acceptance |
| real export/share-sheet cancellation | backup.e2e.ts | pending | stored row counts preserved |
| JSON/CSV import and malformed rejection | backup.e2e.ts | prerequisite-gated, unverified | set named synthetic Files fixtures using E2E_JSON_IMPORT_FILE, E2E_CSV_IMPORT_FILE and E2E_INVALID_IMPORT_FILE |
| unavailable-board recovery | recovery.e2e.ts | pending | actual deep link |
| sample mirrored views and real-store isolation | sample-mode.e2e.ts | pending | real board rows and balance compared |
| widget entry/deep-link daily writer | widget-links.e2e.ts | pending | home-screen widget installation/UI separate |
| Shortcuts App Intents | native source tests | 195 Swift checks passed | composed signed Shortcuts acceptance pending |
| CloudKit two-target sync | native/domain source tests | source tests passed | isolated account and second target required |
| physical device capabilities | no acceptance result | unverified | paired iPhone exists; isolated signed Habit acceptance is not configured |
| Android | no acceptance result | unverified | this run targets iOS; native feature support differs |

## source checks and initial failures

`bun run validate` passed against main: 212 suites, 3105 Jest tests; required core coverage 100 percent. `bun run test:native` passed 15 plugin checks and 195 Swift tests. No source-only check is counted as UI acceptance.

Unsigned simulator builds omitted embedded entitlements and produced an expo-notifications keychain development overlay. Their UI failures are bootstrap evidence only. The exact source build with simulator entitlement sections and a development signing copy removes that overlay. Test failures from stale reads, hidden offscreen controls and generic iOS back navigation are harness issues until a user-aligned product failure is proven. No product bug fix has yet been claimed.

Consult installed packaged docs and `bunx e2e run --help`, keeping APIs consistent with pinned versions.

## execution boundaries

The existing `.eas/workflows/e2e-pr.yml` runs the broad cloud suite against the base app identity. `bun run test:e2e:cloud-boundary` proves cloud precedence even when synthetic flags are inherited: 17 new portable tests remain selected, and host filesystem acceptance is skipped. The local command above separately runs SQLite, simulated appearance, shared-group and Files-provider acceptance. These local results must never be represented as EAS results.

`bun scripts/e2e/stage-imports.ts` stages unique JSON, CSV and malformed files in the owned simulator Files provider. Set each named fixture and matching `E2E_JSON_IMPORT_BOARD` or `E2E_CSV_IMPORT_BOARD` from its receipt before import acceptance. Shortcuts requires a named test-owned composed shortcut and board. Both remain unverified until actually run.

New `coin-cap.e2e.ts`, `ordering.e2e.ts` and `appearance.e2e.ts` cover daily award capping, persisted adjacent board movement, and light/dark largest Dynamic Type with screenshot judgments and minimum completion target bounds. They remain unverified.

The opt-in reset script requires the exact owned simulator name and UUID, expected development identity and app group, and no active runner. It backs up the synthetic database, resets only the owned app/shared database, reinstalls the recorded native app and verifies the empty database postcondition. Use only between runs to reestablish global coin budget preconditions; it is not a test step and cannot run on retained or personal devices.
