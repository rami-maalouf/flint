This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Product context (read before touching product code)

This repository is the habit-system fork of Ripples. Read in this order:

1. `FORK.md` - origin, fork point, and the identifiers that must change before any build.
2. `SPEC-habit-system.md` - the approved product spec for this fork. It is a delta on `SPEC-ripples-product.md`; everything inherited stays unless the delta names the rule it replaces.
3. `tasks/plan.md` and `tasks/todo.md` - the phase plan and the 24-task list. Work one task at a time, in order, following `.agents/skills/incremental-implementation` and `.agents/skills/test-driven-development`.
4. `checkpoints.md` - the ledger. One entry per task. The first section records what Ripples proved before the fork.
5. `docs/design/` - the habit-system design documents the spec was derived from, starting with `docs/design/README.md` and `docs/design/habit-os-context.md`.

Process is inherited from Ripples: tests first, `bun run validate` exit 0 with every `src/core` file at 100 percent, `bun run test:native` green, Argent simulator evidence for visible changes, independent verification by a non-author, one `checkpoints.md` entry, lowercase conventional commits with no co-author lines. `CAPABILITY-MAP.md` lists the module ids and build order.

## Operational notes (learned the hard way; read before building or running)

- **Metro port 8081 belongs to Rami's Ripples project.** If the fork's dev client attaches to it, the fork's native shell loads Ripples' JavaScript and the dev menu banner reads `habit-tracker`. Start the fork's Metro on another port (`bun run start -- --port 8082`) and open the dev client with that URL. Never stop 8081.
- **Expo SDK 57 build flags:** `expo run:ios` rejects combining `--port` with `--no-bundler`. For a build against an already running fork Metro, build without a bundler, install the resulting simulator app on the intended device without uninstalling it, and open an explicit port-8082 dev-client URL. Check the installed CLI's `--help` for build-only/output options.
- **Dedicated fork QA simulator:** `Habit System QA`, iPhone 17 Pro / iOS 26.5, udid `62014A57-2B4A-4083-8A4D-452D4E5F764B`. Synthetic acceptance data belongs here. Use an in-place install for migration testing; Argent `reinstall-app` uninstalls first and erases app data.
- **Keep migration rehearsal data off live development reloads.** A running dev client can apply an uncommitted migration as soon as Metro reloads JavaScript. Close the client and preserve a full database snapshot before editing a new migration; never rewrite a stored checksum to conceal a mismatch. T3's clean rehearsal uses `Habit System Migration QA`, udid `DF054717-410A-4F91-996B-2BCBC29296B1`, with committed T2 JavaScript on a temporary, separately owned port 8083 before the final in-place upgrade. The earlier QA device retains its uncommitted schema-7 snapshot as development evidence.
- **CocoaPods needs a UTF-8 locale.** In a shell with `LANG=""`, `pod install` fails with `Unicode Normalization not appropriate for ASCII-8BIT`. Prefix with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.
- **SDK 57 prebuild cleans by default.** For an incremental native configuration refresh, use `bun expo prebuild --platform ios --no-install --no-clean`, then ordinary Pods installation. Omitting `--clean` or `--template` does not preserve the generated project. T24 verified the installed CLI's explicit `--no-clean` option and preserved target IDs with it. Keep the existing DerivedData cache when native dependencies are unchanged.
- **New local Swift files need a refreshed Pods source list.** After adding files under the local module's podspec glob, run `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install` from `ios/` before the next generic simulator build. Expo can reuse an existing Pods project that omits new files, producing missing-type errors despite green Swift package tests. Regenerate the source list; never edit the generated Pods project manually.
- **Keep React Native and Expo in the same iOS source-build mode.** The local plugin sets `ios.buildReactNativeFromSource` to `"true"` and `EXPO_USE_PRECOMPILED_MODULES` to `"false"` in generated Podfile properties. With the pinned SDK 57 packages, unavailable React artifacts can otherwise make React fall back to static source libraries while Expo retains binaries requiring missing dynamic React frameworks. T21 reproduced that launch crash after successful compilation/signing. Keep inherited `RCT_USE_PREBUILT_RNCORE` and `RCT_USE_RN_DEP` unset or `0`; intentional environment overrides take precedence over their property defaults. Regenerate Pods after changing this mode. Audit dependencies of every embedded executable/framework and launch the resulting app; main-executable symbols and signatures alone are insufficient. ExpoModulesJSI's generated native framework is a separate supported source-build step and must not be removed manually.
- **The Swift intents executor gates on the schema.** `modules/habit-system-apple/ios/Intents/Core/IntentExecutor.swift` hardcodes `schemaVersion` and a map of every migration checksum, and refuses all mutations on mismatch. Any new migration must update both in the same commit. `bun run test:native` runs the Swift test that catches a stale map.
- **Real Shortcuts needs a development-signed simulator build on the tested iOS 26.5 runtime.** Generic Expo simulator builds are ad hoc and have no TeamIdentifier. T8 reproduced `LNContextErrorDomain` 2004 / `LNPerformActionErrorCodeUnsupportedValueType` with linkd unable to obtain the process team id. A signing-only copy using the existing Apple Development identity and team `3V2UU7RRK9` executes the same composed Daily shortcut successfully. Sign nested executable bundles/frameworks/dylibs inside-out, then the copied app, preserving identifier/entitlements/flags/runtime; verify every code target's team and `codesign --verify --deep --strict`. Terminate the fork and Shortcuts before the in-place install and fresh launch. The reproducible local recipe/evidence is under `.artifacts/t8/`; do not edit generated Xcode files or App Intent contracts to work around this handoff failure. Development-signing a simulator artifact is not physical-device or CloudKit entitlement proof.
- **The Swift CloudKit mapping allowlists columns per entity** (`modules/habit-system-apple/ios/CloudKitRecordMapping.swift`). A column added to `SPECS` in `src/core/sync/records.ts` without the matching Swift change makes every upload fail natively.
- **Identity.** Bundle `studio.orbitlabs.habitsystem`, App Group `group.studio.orbitlabs.habitsystem`, CloudKit container `iCloud.studio.orbitlabs.habitsystem`, zone `habit-system`, scheme `habitsystem`, widget kind `HabitSystemBoards`, EAS project `@ramimaalouf/habit-system` (`07481ea0-9f44-4f24-ad3c-fd889569cade`), team `3V2UU7RRK9`. The plugin test `app configuration carries the fork identity` fails if any of these regress. Ripples (`studio.orbitlabs.habittracker`) is a separate app that must never share a container or app group.
- **Native module and internal names.** The local module is `modules/habit-system-apple` (native module name `HabitSystemApple`, podspec `HabitSystemApple.podspec`, Swift types prefixed `HabitSystem`, Info.plist keys `HabitSystemAppGroupIdentifier` / `HabitSystemCloudKitContainerIdentifier`, EAS env `HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT`). The database file is `habit-system.db`; `src/platform/database/index.ts` moves a legacy `ripples.db` to the new name on first open, so an App Intent that runs before that first launch after upgrade finds no database. The backup payload format is `habit-system.export` and import also accepts `ripples.export`. The `ripples-csv` import source, its `parseRipplesCsv` parser, and the fork history documents keep the Ripples name on purpose because they refer to the Ripples app. Renaming the podspec or a plugin-generated Swift file needs a clean regeneration (`bunx expo prebuild --platform ios --clean` with the UTF-8 locale): the `--no-clean` path keeps the stale generated file, the old `AppDelegate` call, and the old Info.plist keys, which was reproduced on 2026-09-30.
- **Widget extension target name** `ExpoWidgetsTarget` is a constant inside the expo-widgets plugin and cannot be renamed from config.
- **Simulator used for evidence:** iPhone 17 Pro, udid `B47A3DF3-056A-4531-B9FA-8327C7C8A485`. Evidence goes under `.artifacts/<task>/` (ignored). Generated `ios/` is ignored; regenerate with `bunx expo prebuild --platform ios --clean`.
- **`MEMORY.md` in this repo** is the Argent environment inspector's memory, not a general agent file. This section is the place for facts every agent needs.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Token Budget & Agent Cost Rules

To keep context small and costs low, observe these rules during UI builds:
1. **Prefer Text over Pixels:** Use `describe` or `debugger-component-tree` to verify state. Only use `screenshot` when a check is strictly visual (spacing, color, clipping).
2. **Minimize Screenshot Weight:** The system is configured with `ARGENT_SCREENSHOT_SCALE=0.2`. Use `includeImageInContext: false` when capturing baselines just for diffing.
3. **Run Sequences:** Use `run-sequence` for multi-step actions instead of tapping and screenshotting repeatedly. Use `await-ui-element` to wait for state to settle.
4. **One Session Per Checkpoint:** Use `checkpoints.md` as the handoff artifact. Start fresh sessions per checkpoint to avoid dragging the whole build history along.
5. **Delegate Exploration:** Use subagents to explore and dump files, returning only the conclusion to the main context.
6. **Use the Cheapest Capable Subagent:** When the active client supports subagents, delegate bounded exploration, file inspection, and log analysis to the least expensive available model that can reliably complete the task. Use only model identifiers supported by the active client.
7. **Keep Heavy Device Work Isolated:** When the active client supports subagents, delegate repeated Argent inspection loops to one bounded subagent and have it return a concise conclusion. Use the active client's own context-management features instead of assuming commands or tool parameters from another client.
