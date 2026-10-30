# Habit System Full Stack

A private, local-first habit tracker for iOS, built with Expo and React Native. Habit System combines daily habits, same-day stacks, coins, and rewards you define. A fresh install starts empty.

This is a full-history fork of [Habit System](https://github.com/rami-maalouf/habit-system), originally Ripples. Snapback 4 adds private account sync while SQLite remains the local source of truth. [FORK.md](FORK.md) records the independent app and EAS identities. The backend runs at `https://habits.ramimaalouf.com` on Oracle.

## The app

- Daily boards toggle completion for a logical date; Count boards retain individual check-ins with optional amounts, time, and notes.
- Fourteen-day Home strips, heatmaps, streaks, analytics, a journal, and full check-in history show progress.
- Before/after anchors connect habits into stacks. A stack completes from checks on the same date; usual times are informational.
- Opted-in habits earn coins, complete stacks earn bonuses, and an append-only ledger records earnings and reward claims.
- Weekday reminders and never-miss-twice alerts use local notifications. Miss alerts require permission and depend on the operating system's delivery behavior.
- Home Screen widgets and existing Shortcuts/App Intents support checking habits and removing check-ins.
- Version 2 JSON backups restore habit configuration, checks, rewards, and immutable action/coin history. Version 1 JSON and Ripples CSV imports remain supported.
- Account sync is off until you connect. Email/password sessions are stored in the device Keychain. Snapback is the sole active provider; CloudKit code is retained for reference.
- Light and dark appearance, Dynamic Type, and accessible controls are part of the iOS implementation.

The real app stores product data in SQLite inside its own iOS App Group. Widgets and App Intents use the same store. Restoring checks does not mint new earnings, and local notification bookkeeping is excluded from sync and backups.

## Implementation and acceptance

[SPEC-habit-system.md](SPEC-habit-system.md) defines the product changes to the inherited [native foundation](SPEC-native-foundation.md) and [Ripples product](SPEC-ripples-product.md) specifications. [tasks/todo.md](tasks/todo.md) tracks remaining work; [checkpoints.md](checkpoints.md) records validation and device evidence.

The habit, stack, coin, reward, backup/restore, and miss-alert milestones are implemented and reviewed. The deterministic three-year sample dataset and isolated in-memory factory have passed automated and iOS simulator checks. Sample navigation, native sheets, editing, claims, disposal and real-data isolation have passed automated and iOS simulator checks. T24 cosmetics, regressions, production exports and native build checks pass, including a fresh simulator launch. The signed iPhone installation and exact provisioning/capability checks pass. First phone launch still needs the phone unlocked; live two-device sync remains open. The sample database scheduling change reduces measured iOS simulator startup from about 51 seconds to 20 seconds while preserving the exact generated data.

The inherited CloudKit acceptance status above describes the original app. The new backend plan is [tasks/fullstack-plan.md](tasks/fullstack-plan.md); deployment, backups, restoration and capability limits are documented in [ops/README.md](ops/README.md). This repository does not claim an App Store release.

## Development

The pinned stack is Expo SDK 57, React Native 0.86, React 19, TypeScript 6, and Bun. Native UI uses `@expo/ui`; storage uses `expo-sqlite`; widgets and notifications use their Expo packages. The local `modules/ripples-apple` module supplies the shared Swift command and CloudKit implementations.

Continuous Native Generation owns generated `ios/` and `android/` projects. Maintain native source and configuration in the local module and plugin. The plugin keeps React Native and Expo modules on a coherent source build; do not replace that with hand-edited generated projects. See [AGENTS.md](AGENTS.md) for local build, signing, simulator, and port conventions.

```bash
bun install --frozen-lockfile
bun run start -- --port 8090
bun run ios -- --port 8090
```

Quality checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run validate
bun run test:native
bun run test:backend
bunx expo-doctor
```

`validate` runs lint, typechecking, and tests with coverage. Core code requires all four coverage metrics at 100 percent. Native tests, signed builds, actual UI checks, and external sync/device acceptance are recorded separately.

`bun install` generates the typed Snapback API. `bun run backend:dev` starts an isolated local server on port 4410. Set `EXPO_PUBLIC_SNAPBACK_URL=http://127.0.0.1:4410` for a local iOS simulator or use `http://10.0.2.2:4410` on an Android emulator. The default is the public HTTPS server. A database binds to its first server and account; sign-out retains local data and does not permit silently switching accounts. Keep development and production app data separate.

[eas.json](eas.json) retains development, preview, simulator, and production build profiles. Their presence is configuration, not evidence of a released build. The inherited agent workflow definitions remain under [`.eas/workflows`](.eas/workflows) and [`.github/workflows`](.github/workflows); their review policy is in [`.agents/prompts/fix-prompt.md`](.agents/prompts/fix-prompt.md). The workflow pattern originated in [SchroederNathan/clarity](https://github.com/SchroederNathan/clarity).

## License

MIT - see [LICENSE](LICENSE).
