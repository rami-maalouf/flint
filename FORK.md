# fork origin

this repository is a full-history fork of ripples.

- origin repo: https://github.com/rami-maalouf/habit-tracker (product name ripples)
- fork point: tag `ripples-v1-fork-point`, commit `5ed71a2`, 2026-09-07
- fork method: clone with full git history, no github fork link. ripples fixes are cherry-picked by hand if ever needed.
- what ripples proved before the fork: the first section of `checkpoints.md` ("pre-fork closure").

## identifiers (applied 2026-09-08, task T1)

every row below was changed on 2026-09-08. the eas project is `@ramimaalouf/habit-system` (id `07481ea0-9f44-4f24-ad3c-fd889569cade`). the plugin test `app configuration carries the fork identity` pins the new values and fails if any ripples identifier returns.

also in `app.json` after `eas init` and prebuild: `owner: ramimaalouf` and `extra.eas.build.experimental.ios.appExtensions` declaring the widget extension's bundle id and app group. that block is eas credentials plumbing for the extension target under the new eas project; it is not a product change. t1 also fixed one broken link in `MEMORY.md` (`tasks/pre-fork.md` -> `tasks/ripples/pre-fork.md`) left by the task-file archive.

| where | ripples value | must become |
| --- | --- | --- |
| `app.json` `expo.name` / `expo.slug` | `habit-tracker` | `habit-system` |
| `app.json` `ios.bundleIdentifier` | `studio.orbitlabs.habittracker` | `studio.orbitlabs.habitsystem` |
| `app.json` expo-widgets `groupIdentifier` and the `ios.entitlements` app group | `group.studio.orbitlabs.habittracker` | `group.studio.orbitlabs.habitsystem` (derived from the bundle id by the plugin; also `src/platform/database/index.ts`) |
| cloudkit container (module plugin + entitlements) | `iCloud.studio.orbitlabs.habittracker` | `iCloud.studio.orbitlabs.habitsystem` (derived by the plugin) |
| cloudkit zone (`CloudKitTransport.swift`) | `habit-tracker` | `habit-system` |
| widget kind (`app.json` widgets[0].name, `createWidget`, swift `UserDefaults` keys and `WidgetCenter` kind) | `RipplesBoards` | `HabitSystemBoards` |
| widget display name | `Ripples` | `Habit System` |
| app display name (`ios.infoPlist.CFBundleDisplayName`) | `Ripples` | `Habit System` |
| widget extension target name | `ExpoWidgetsTarget` | unchanged. it is a constant inside the `expo-widgets` plugin (`plugin/build/ios/withIosWidgets.js`), not configurable without patching the dependency. only its bundle id suffix follows the app bundle id: `studio.orbitlabs.habitsystem.ExpoWidgetsTarget`. |
| `app.json` `extra.eas.projectId` and `updates.url` | ripples' eas project `1e477943-...` | `07481ea0-9f44-4f24-ad3c-fd889569cade` |
| `app.json` `scheme` | `habittracker` | `habitsystem` (also the widget deep links) |
| `package.json` `name` | `habit-tracker` | `habit-system` |
| signing team | `3V2UU7RRK9` | unchanged; new provisioning profiles are created by eas on the first signed build |

the local native module was `modules/ripples-apple` with `Ripples`-prefixed swift types until 2026-09-30. it is now `modules/habit-system-apple` with `HabitSystem`-prefixed types, the native module name `HabitSystemApple`, and the info.plist keys `HabitSystemAppGroupIdentifier` and `HabitSystemCloudKitContainerIdentifier`. the same change renamed the database file (`ripples.db` -> `habit-system.db`, moved in place on first open), the miss-alert notification prefix (`habit-system.miss.v1:`), the backup payload format (`habit-system.export`; import still accepts `ripples.export`), and the eas env var `HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT`. the import-from-ripples csv feature keeps its name because it imports ripples data.

## what is inherited on purpose

- boards, check-ins, analytics, reminders, widgets, export/import, the native look
- the cloudkit transport, app intents executor, and alternate-icon adapter in the single approved native module
- the development fixture `src/testing/fixtures/reference-august-2026.ts`
- the test suites and coverage gates

## what this fork adds

see `SPEC-habit-system.md`: daily toggle habits beside count habits, same-day stacking through anchors, an append-only coin ledger with a restorable full-stack bonus, user-defined rewards, one never-miss-twice alert, and a sample mode. no starter stack is seeded; prepared habits enter through import. ripples' spec bans gamification; the new spec replaces that rule.
