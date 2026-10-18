import AppIntents
import SwiftUI
import WidgetKit
import HabitWidgetData

struct ChooseWidgetHabit: AppIntent {
  static var title: LocalizedStringResource = "Choose widget habit"
  static var description = IntentDescription("Change the habit displayed in a desktop widget.")
  static var openAppWhenRun = false
  static var isDiscoverable = false

  @Parameter(title: "Widget") var kind: String
  @Parameter(title: "Size") var family: String
  @Parameter(title: "Configured habit") var configuredHabitID: String?
  @Parameter(title: "Action") var action: String
  @Parameter(title: "Habit") var habitID: String?
  @Parameter(title: "Page", default: 0) var page: Int

  init() {}
  init(key: WidgetSelectionKey, action: String, habitID: String? = nil, page: Int = 0) {
    self.kind = key.kind; self.family = key.family; self.configuredHabitID = key.configuredHabitID
    self.action = action; self.habitID = habitID; self.page = page
  }

  func perform() async throws -> some IntentResult {
    guard let key = WidgetSelectionKey(environment: WidgetSnapshotStore.environment, kind: kind, family: family, configuredHabitID: configuredHabitID),
      let snapshot = WidgetSnapshotStore.read(from: WidgetSnapshotStore.url(), environment: key.environment) else { throw SelectionError.unavailable }
    let selection: WidgetSelectionAction
    switch action {
    case "open": selection = .open
    case "close": selection = .close
    case "page": selection = .page(page)
    case "select":
      guard let habitID else { throw SelectionError.unavailable }
      selection = .select(habitID)
    default: throw SelectionError.unavailable
    }
    _ = try WidgetSelectionStore(key: key).apply(selection, snapshot: snapshot)
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
    return .result()
  }

  private enum SelectionError: LocalizedError {
    case unavailable
    var errorDescription: String? { "Open Habit System to refresh the available habits." }
  }
}

struct HabitWidgetChooserButton: View {
  let habit: WidgetHabit?
  let key: WidgetSelectionKey
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  var body: some View {
    Button(intent: ChooseWidgetHabit(key: key, action: "open")) {
      HStack(spacing: 7) {
        if let habit {
          Image(systemName: habit.symbol).font(.system(size: key.family == "large" ? 20 : 14, weight: .medium))
            .foregroundStyle(chooserTint(habit.accentHex, scheme: scheme, mode: renderingMode)).widgetAccentable()
        }
        Text(habit?.title ?? "Choose a habit")
          .font(.system(size: key.family == "large" ? 17 : 12, weight: .semibold))
          .lineLimit(key.family == "large" ? 2 : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
      }.contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Choose habit, currently \(habit?.title ?? "unavailable")")
    .accessibilityHint("Show the habit picker inside this widget")
    .invalidatableContent()
  }
}

struct HabitWidgetChooser: View {
  let snapshot: WidgetSnapshot
  let key: WidgetSelectionKey
  let state: WidgetSelectionState
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  private var small: Bool { key.family == "small" }
  private var medium: Bool { key.family == "medium" }
  private var currentPage: Int { state.boundedPage(in: snapshot, pageSize: key.pageSize) }
  private var pageCount: Int { max(1, (snapshot.habits.count + key.pageSize - 1) / key.pageSize) }
  private var selectedID: String? { state.selectedHabit(in: snapshot, configuredHabitID: key.configuredHabitID)?.id }

  var body: some View {
    VStack(alignment: .leading, spacing: small ? 5 : 8) {
      HStack {
        Text("Choose habit").font(.system(size: small ? 12 : 14, weight: .semibold))
        Spacer(minLength: 4)
        Button(intent: ChooseWidgetHabit(key: key, action: "close")) {
          Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
            .frame(width: 22, height: 22).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Close habit picker")
      }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: medium ? 2 : 1), spacing: small ? 3 : 5) {
        ForEach(state.visibleHabits(in: snapshot, pageSize: key.pageSize)) { habit in
          Button(intent: ChooseWidgetHabit(key: key, action: "select", habitID: habit.id)) {
            HStack(spacing: 6) {
              Image(systemName: habit.symbol).font(.system(size: small ? 10 : 12, weight: .medium))
                .foregroundStyle(chooserTint(habit.accentHex, scheme: scheme, mode: renderingMode)).widgetAccentable().frame(width: 15)
              Text(habit.title).font(.system(size: small ? 10 : 11, weight: .medium))
                .lineLimit(small ? 1 : 2).frame(maxWidth: .infinity, alignment: .leading)
              if habit.id == selectedID {
                Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
              }
            }
            .padding(.horizontal, 6).frame(height: small ? 22 : 30)
            .background(Color.primary.opacity(habit.id == selectedID ? 0.09 : 0.035), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Show \(habit.title)\(habit.id == selectedID ? ", selected" : "")")
          .invalidatableContent()
        }
      }
      Spacer(minLength: 0)
      HStack(spacing: 6) {
        pageButton("chevron.left", label: "Previous habits", page: currentPage - 1, disabled: currentPage == 0)
        Spacer(minLength: 0)
        Text("\(currentPage + 1) / \(pageCount)").font(.system(size: 9, weight: .medium)).monospacedDigit().foregroundStyle(.secondary)
        Spacer(minLength: 0)
        pageButton("chevron.right", label: "Next habits", page: currentPage + 1, disabled: currentPage + 1 >= pageCount)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .privacySensitive()
  }

  private func pageButton(_ symbol: String, label: String, page: Int, disabled: Bool) -> some View {
    Button(intent: ChooseWidgetHabit(key: key, action: "page", page: page)) {
      Image(systemName: symbol).font(.system(size: 9, weight: .semibold))
        .frame(width: 28, height: 18)
        .background(Color.primary.opacity(0.06), in: Capsule())
    }.buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.3 : 1).accessibilityLabel(label)
  }
}

private func chooserTint(_ hex: String, scheme: ColorScheme, mode: WidgetRenderingMode) -> Color {
  if mode != .fullColor { return .primary }
  if hex.uppercased() == "#F2F2F7" && scheme == .light { return Color(red: 0.45, green: 0.45, blue: 0.48) }
  let value = UInt64(hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted), radix: 16) ?? 0x78D98B
  return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}
