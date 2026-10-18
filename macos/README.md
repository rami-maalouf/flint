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

For a signed Release build with the Production entitlement, use `macos/scripts/build.sh --release -allowProvisioningUpdates`. Building does not access iCloud. A fresh Release store still starts with sync disabled.

Match the phone's **CloudKit environment**, not its build configuration or icon. The current locally installed phone build uses Development iCloud, even though it is compiled as Release. For an optimized Mac build matching that phone, use `macos/scripts/build.sh --release HABIT_CLOUD_ENVIRONMENT=Development`. This sets both the signed CloudKit entitlement and the environment used for local storage and widgets. Settings always displays the active environment. Never copy records or databases between environments to repair a mismatch.

## Desktop widgets

The app includes three WidgetKit variations: Activity Grid (small, medium and large), Weekly Focus (small and medium), and Today (small, medium and large). Activity Grid uses a GitHub-style calendar; its large layout shows a full year. Right-click the desktop, choose Edit Widgets, and select Habit System. Click the habit name in Activity Grid or Weekly Focus to open an inline habit chooser. Use its arrows to browse longer lists, select a habit to display it, or close the chooser to keep the current habit. Clicking the chart opens the displayed habit in the Mac app. Today opens the Today screen.

Edit Widget sets the starting habit. Browsing selection is saved locally and kept separate by widget style, size, starting habit and CloudKit environment. Copies with identical settings share this browsing selection because WidgetKit does not expose a per-instance identifier to the provider or button intent. Choose different starting habits in Edit Widget when you want otherwise identical copies to browse independently. If a selected habit disappears, the widget asks you to choose another instead of silently substituting one.

Widgets read an atomic snapshot in the Mac app group `3V2UU7RRK9.studio.orbitlabs.habitsystem.mac`. They never open the database, connect to CloudKit, or mutate habits. Development and Production snapshots and links are separate. Notes, amounts and sync metadata are excluded. Each view displays its save time; after the next shared-calendar refresh boundary it shows saved activity and asks you to reopen the app. WidgetKit controls refresh timing, and the app republishes after reloads and changes.

Sample mode never replaces real widget content. Isolated QA stores also cannot publish unless launched with the explicit `--widget-preview` testing flag. The signed local extension was exercised in Apple's `/System/Library/CoreServices/WidgetKit Simulator.app`, across all eight supported size/variation combinations and their expiry entries. Additional native fixture renders cover light, dark, tinted, populated, stale and missing-habit states. Actual desktop placement and OS-budgeted background refresh remain separate from simulator verification.

## Data and environments

Each Mac owns its own SQLite database and device identity. Default storage is `Habit System/<environment>/habit-system.db` inside the app's sandbox Application Support directory. Debug uses Development iCloud. Release uses Production iCloud. Those configurations have separate local stores, preventing test data from being uploaded through a later Production build. Sync starts disabled in a fresh store and is enabled from Settings.

The CloudKit container is `iCloud.studio.orbitlabs.habitsystem`, shared with the mobile app. Production data is not a testing fixture. Production convergence has not been exercised during this implementation; the signed Development build successfully pulled existing records without a habit mutation. Settings reports account, connection and sync failures while retaining local data.

For local UI testing, launch with `--database-path <absolute-path>` inside the app sandbox, or `--database-path :memory:`. This explicitly disables CloudKit and notifications for that test store. A missing or invalid path stops startup without opening personal storage. Explore Sample Habits uses a separate in-memory store; leaving discards its changes. Sample mode disables sync, notifications and data transfer. Initial sample generation includes years of shared-engine history and can take around 30 seconds.

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

### Isolated notification acceptance

Use the separate notification QA app for real macOS delivery checks:

```sh
xcodegen generate --spec macos/project.yml
xcodebuild -project macos/HabitSystem.xcodeproj -scheme HabitSystemNotificationQA \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath macos/build/NotificationQA -skipPackagePluginValidation build
open 'macos/build/NotificationQA/Build/Products/Debug/Habit System Notification QA.app'
```

This target has its own bundle identity, sandbox database and notification permission. It has no CloudKit, network, shared app-group entitlement or production URL scheme. Its compile-time policy forces the QA store, refuses notification effects if the bundle identity is wrong, and prevents widget publication even with `--widget-preview`. The normal app's `--database-path` mode still disables both notifications and CloudKit.

Create a synthetic habit, allow notifications through the app, and schedule a reminder a few minutes ahead. Settings offers a read-only notification inventory showing native pending requests and delivered identifiers. Check foreground/background delivery, edit/cancel behavior and notification-tap navigation, then remove the QA reminder. OS permission and banner interactions require a UI session capable of accessing macOS's permission dialog; a successful build or pending request does not prove delivery.

The QA settings also provide explicit destination previews using the same typed notification inbox. They open a reminder's check-in editor or a missed habit's overview without sending notifications or requesting permission. Repeated reminder navigation was exercised through these controls. Actual delivery remains unverified because the available computer-use tool cannot access the macOS notification permission dialog.

## Engine boundary

`EngineHost(databasePath:)` owns a serial background JavaScriptCore context. Initialize before product operations. `call(method, arguments)` invokes allowlisted shared APIs and unwraps DomainResult; `decode` returns typed output. Mutations use command IDs and preserve shared receipt/stale-write semantics. SQL callbacks are private to the bundle. A failed store is never silently reset.

Native services settle asynchronous calls back into the same operation queue. Sync cancellation invalidates late callbacks, and sample transitions drain notification reconciliation before changing stores. The native app does not duplicate coin, habit or calendar rules.
