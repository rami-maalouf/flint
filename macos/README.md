# Habit System for Mac

A native SwiftUI Mac app with habits, stacks, coins, rewards, history, reminders, backups and iCloud sync. Habit detail includes an interactive week, a year activity grid, monthly trends, year comparisons, weekday patterns and streak history. The app runs the mobile app's TypeScript domain engine through JavaScriptCore, native SQLite and the existing CloudKit protocol.

## Build and run

Requires macOS 14 or later, Xcode, Bun and XcodeGen on PATH. From the repository root:

```sh
bun install --frozen-lockfile
macos/scripts/build.sh --local
open 'macos/build/DerivedData/Build/Products/Debug/Habit System.app'
```

`--local` creates a signed sandboxed app without CloudKit entitlements. For an iCloud-enabled Development build, sign into the Apple Developer team in Xcode and run:

```sh
macos/scripts/build.sh -allowProvisioningUpdates
```

The generated project is `macos/HabitSystem.xcodeproj`. Do not edit it directly; edit `project.yml` and regenerate with XcodeGen. The build plugin rebuilds shared JavaScript when its tracked TypeScript inputs change. Icons and JavaScript bundles are generated and not committed.

## Data and environments

Each Mac owns its own SQLite database and device identity. Default storage is `Habit System/<environment>/habit-system.db` inside the app's sandbox Application Support directory. Debug uses Development iCloud. Release uses Production iCloud. Those configurations have separate local stores, preventing test data from being uploaded through a later Production build. Sync starts disabled in a fresh store and is enabled from Settings.

The CloudKit container is `iCloud.studio.orbitlabs.habitsystem`, shared with the mobile app. Production data is not a testing fixture. Production convergence has not been exercised during this implementation; the signed Development build successfully pulled existing records without a habit mutation. Settings reports account, connection and sync failures while retaining local data.

For local UI testing, launch with `--database-path <absolute-path>` inside the app sandbox. This explicitly disables CloudKit and notifications for that test store. Explore Sample Habits uses a separate in-memory store; leaving discards its changes. Sample mode disables sync, notifications and data transfer. Initial sample generation includes years of shared-engine history and can take around 30 seconds.

## Verification

```sh
bun run validate
bun run test:native
sh macos/scripts/test.sh
xcodebuild -project macos/HabitSystem.xcodeproj -scheme HabitSystem \
  -destination 'platform=macOS' -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO test
```

The engine suite checks durable command replay, rollback/retry, backup parity, native values, migrations, notification scheduling, sample isolation, sync convergence and cancellation. Presentation tests decode real engine output and check decimal editing across locales. UI acceptance uses synthetic local stores, including import/export, journal editing, rewards and navigation. See `checkpoints.md` for completed checks and limits.

## Engine boundary

`EngineHost(databasePath:)` owns a serial background JavaScriptCore context. Initialize before product operations. `call(method, arguments)` invokes allowlisted shared APIs and unwraps DomainResult; `decode` returns typed output. Mutations use command IDs and preserve shared receipt/stale-write semantics. SQL callbacks are private to the bundle. A failed store is never silently reset.

Native services settle asynchronous calls back into the same operation queue. Sync cancellation invalidates late callbacks, and sample transitions drain notification reconciliation before changing stores. The native app does not duplicate coin, habit or calendar rules.
