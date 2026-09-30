# Habit System

A private, local-first habit tracker for iOS, built with Expo and React Native. Habit System combines daily habits, same-day stacks, coins, and rewards you define. A fresh install starts empty.

This is a full-history fork of [Ripples](https://github.com/rami-maalouf/habit-tracker). [FORK.md](FORK.md) records the origin and the separate Habit System app, App Group, and CloudKit identities.

## The app

- Daily boards toggle completion for a logical date; Count boards retain individual check-ins with optional amounts, time, and notes.
- Fourteen-day Home strips, heatmaps, streaks, analytics, a journal, and full check-in history show progress.
- Before/after anchors connect habits into stacks. A stack completes from checks on the same date; usual times are informational.
- Opted-in habits earn coins, complete stacks earn bonuses, and an append-only ledger records earnings and reward claims.
- Weekday reminders and never-miss-twice alerts use local notifications. Miss alerts require permission and depend on the operating system's delivery behavior.
- Home Screen widgets and existing Shortcuts/App Intents support checking habits and removing check-ins.
- Version 2 JSON backups restore habit configuration, checks, rewards, and immutable action/coin history. Version 1 JSON and Ripples CSV imports remain supported.
- Private CloudKit sync is off by default. Version 2 accepts supported version 1 records; older app versions must be upgraded before sharing version 2 data.
- Light and dark appearance, Dynamic Type, and accessible controls are part of the iOS implementation.

The real app stores product data in SQLite inside its own iOS App Group. Widgets and App Intents use the same store. Restoring checks does not mint new earnings, and local notification bookkeeping is excluded from sync and backups.

## Implementation and acceptance

[SPEC-habit-system.md](SPEC-habit-system.md) defines the product changes to the inherited [native foundation](SPEC-native-foundation.md) and [Ripples product](SPEC-ripples-product.md) specifications. [tasks/todo.md](tasks/todo.md) tracks remaining work; [checkpoints.md](checkpoints.md) records validation and device evidence.

The habit, stack, coin, reward, backup/restore, and miss-alert milestones are implemented and reviewed. The deterministic three-year sample dataset and isolated in-memory factory have passed automated and iOS simulator checks. Sample navigation, native sheets, editing, claims, disposal and real-data isolation have passed automated and iOS simulator checks. T24 cosmetics, regressions, production exports and native build checks pass, including a fresh simulator launch. The signed iPhone installation and exact provisioning/capability checks pass. First phone launch still needs the phone unlocked; live two-device sync remains open. The sample database scheduling change reduces measured iOS simulator startup from about 51 seconds to 20 seconds while preserving the exact generated data.

Local sync tests and simulator checks do not establish live CloudKit convergence. T19's actual two-target service acceptance, physical launch verification, and Checkpoint C remain open. This repository does not claim final release acceptance or a published App Store listing.

## Development

The pinned stack is Expo SDK 57, React Native 0.86, React 19, TypeScript 6, and Bun. Native UI uses `@expo/ui`; storage uses `expo-sqlite`; widgets and notifications use their Expo packages. The local `modules/habit-system-apple` module supplies the shared Swift command and CloudKit implementations.

Continuous Native Generation owns generated `ios/` and `android/` projects. Maintain native source and configuration in the local module and plugin. The plugin keeps React Native and Expo modules on a coherent source build; do not replace that with hand-edited generated projects. See [AGENTS.md](AGENTS.md) for local build, signing, simulator, and port conventions.

```bash
bun install --frozen-lockfile
bun run start --port 8082
bun run ios --port 8082
```

Quality checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run validate
bun run test:native
bunx expo-doctor
```

`validate` runs lint, typechecking, and tests with coverage. Core code requires all four coverage metrics at 100 percent. Native tests, signed builds, actual UI checks, and external sync/device acceptance are recorded separately.

[eas.json](eas.json) retains development, preview, simulator, and production build profiles. Their presence is configuration, not evidence of a released build. The inherited agent workflow definitions remain under [`.eas/workflows`](.eas/workflows) and [`.github/workflows`](.github/workflows); their review policy is in [`.agents/prompts/fix-prompt.md`](.agents/prompts/fix-prompt.md). The workflow pattern originated in [SchroederNathan/clarity](https://github.com/SchroederNathan/clarity).

## License

MIT - see [LICENSE](LICENSE).
