import AppIntents
internal import HabitSystemApple

struct HabitSystemApplicationShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: HabitSystemCheckInIntent(), phrases: ["Check in with \(.applicationName)"],
      shortTitle: "Check In", systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: HabitSystemRemoveLatestCheckInIntent(), phrases: ["Remove my latest check-in in \(.applicationName)"],
      shortTitle: "Remove Latest Check-In", systemImageName: "minus.circle"
    )
    AppShortcut(
      intent: HabitSystemTodayCheckInsIntent(), phrases: ["Show today's check-ins in \(.applicationName)"],
      shortTitle: "Today's Check-Ins", systemImageName: "list.bullet"
    )
  }
}
