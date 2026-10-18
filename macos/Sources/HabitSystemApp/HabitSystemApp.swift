import SwiftUI
import HabitEngine

@main
struct HabitSystemApp: App {
  @StateObject private var model = AppModel()
  var body: some Scene {
    WindowGroup {
      ContentView(model: model)
        .frame(minWidth: 760, minHeight: 560)
        .task { await model.start() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await model.setActive(true) } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in Task { await model.setActive(false) } }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name.NSSystemTimeZoneDidChange)) { _ in Task { await model.periodicRefresh() } }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name.NSSystemClockDidChange)) { _ in Task { await model.periodicRefresh() } }
        .onReceive(NotificationCenter.default.publisher(for: .habitNotificationDelivered)) { _ in model.notifications?.requestReconciliation() }
        .onReceive(NotificationCenter.default.publisher(for: .habitNotificationSelected)) { notification in
          model.notificationBoardID = notification.userInfo?["boardId"] as? String
          NSApplication.shared.activate(ignoringOtherApps: true)
        }
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in Task { await model.periodicRefresh() } }
    }
    .defaultSize(width: 1100, height: 760)
    .commands {
      CommandGroup(after: .newItem) {
        Button("New Habit") { model.showNewHabit = true }.keyboardShortcut("n").disabled(!model.ready)
        Button("Refresh") { Task { await model.refresh() } }.keyboardShortcut("r").disabled(!model.ready)
      }
    }
    Settings { SettingsView(model: model) }
  }
}
