import AppIntents
import SwiftUI
import WidgetKit
import HabitWidgetData

struct CycleWidgetHabit: AppIntent {
  static var title: LocalizedStringResource = "Next widget habit"
  static var description = IntentDescription("Show the next habit in a desktop widget.")
  static var openAppWhenRun = false
  static var isDiscoverable = false

  @Parameter(title: "Widget") var kind: String
  @Parameter(title: "Size") var family: String
  @Parameter(title: "Configured habit") var configuredHabitID: String?
  init() {}
  init(key: WidgetSelectionKey) {
    self.kind = key.kind; self.family = key.family; self.configuredHabitID = key.configuredHabitID
  }

  func perform() async throws -> some IntentResult {
    guard let key = WidgetSelectionKey(environment: WidgetSnapshotStore.environment, kind: kind, family: family, configuredHabitID: configuredHabitID),
      let snapshot = WidgetSnapshotStore.read(from: WidgetSnapshotStore.url(), environment: key.environment) else { throw SelectionError.unavailable }
    _ = try WidgetSelectionStore(key: key).advance(snapshot: snapshot)
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
    return .result()
  }

  private enum SelectionError: LocalizedError {
    case unavailable
    var errorDescription: String? { "Open Habit System to refresh the available habits." }
  }
}

struct HabitWidgetCycleButton: View {
  let habit: WidgetHabit?
  let key: WidgetSelectionKey
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  var body: some View {
    Button(intent: CycleWidgetHabit(key: key)) {
      HStack(spacing: 7) {
        if let habit {
          Image(systemName: habit.symbol).font(.system(size: key.family == "large" ? 20 : 14, weight: .medium))
            .foregroundStyle(cycleTint(habit.accentHex, scheme: scheme, mode: renderingMode)).widgetAccentable()
        }
        Text(habit?.title ?? "Next habit")
          .font(.system(size: key.family == "large" ? 17 : 12, weight: .semibold))
          .lineLimit(key.family == "large" ? 2 : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
      }.contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Next habit, currently \(habit?.title ?? "unavailable")")
    .accessibilityHint("Show the next habit. After the last habit, return to the first.")
    .invalidatableContent()
  }
}

private func cycleTint(_ hex: String, scheme: ColorScheme, mode: WidgetRenderingMode) -> Color {
  if mode != .fullColor { return .primary }
  if hex.uppercased() == "#F2F2F7" && scheme == .light { return Color(red: 0.45, green: 0.45, blue: 0.48) }
  let value = UInt64(hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted), radix: 16) ?? 0x78D98B
  return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}
