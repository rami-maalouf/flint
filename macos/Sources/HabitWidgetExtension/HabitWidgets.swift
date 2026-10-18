import AppIntents
import SwiftUI
import WidgetKit
import HabitWidgetData
import HabitWidgetViews

struct HabitEntity: AppEntity {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Habit")
  static var defaultQuery = HabitEntityQuery()
  let id: String
  let title: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

struct HabitEntityQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [HabitEntity] {
    available().filter { identifiers.contains($0.id) }
  }
  func suggestedEntities() async throws -> [HabitEntity] { available() }
  private func available() -> [HabitEntity] {
    WidgetSnapshotStore.read(from: WidgetSnapshotStore.url(), environment: WidgetSnapshotStore.environment)?.habits
      .map { HabitEntity(id: $0.id, title: $0.title) } ?? []
  }
}

struct HabitConfiguration: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Choose a habit"
  static var description = IntentDescription("Keep a habit and its progress on your desktop.")
  @Parameter(title: "Habit") var habit: HabitEntity?
}

struct HabitEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
  let selectedID: String?
  var selectedHabit: WidgetHabit? {
    guard let selectedID else { return snapshot?.habits.first }
    return snapshot?.habits.first { $0.id == selectedID }
  }
  var isStale: Bool { snapshot?.isStale(at: date) ?? false }
}

struct HabitProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> HabitEntry { HabitEntry(date: .now, snapshot: nil, selectedID: nil) }
  func snapshot(for configuration: HabitConfiguration, in context: Context) async -> HabitEntry { entry(configuration) }
  func timeline(for configuration: HabitConfiguration, in context: Context) async -> Timeline<HabitEntry> {
    widgetTimeline(entry(configuration))
  }

  private func entry(_ configuration: HabitConfiguration) -> HabitEntry {
    HabitEntry(date: .now, snapshot: WidgetSnapshotStore.read(from: WidgetSnapshotStore.url(), environment: WidgetSnapshotStore.environment), selectedID: configuration.habit?.id)
  }
}

private func widgetTimeline(_ current: HabitEntry) -> Timeline<HabitEntry> {
  var entries = [current]
  if let expiry = current.snapshot?.expiresAt, expiry > current.date {
    entries.append(HabitEntry(date: expiry, snapshot: current.snapshot, selectedID: current.selectedID))
  }
  return Timeline(entries: entries, policy: .after(current.date.addingTimeInterval(900)))
}

struct TodayProvider: TimelineProvider {
  func placeholder(in context: Context) -> HabitEntry { HabitEntry(date: .now, snapshot: nil, selectedID: nil) }
  func getSnapshot(in context: Context, completion: @escaping (HabitEntry) -> Void) { completion(current()) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<HabitEntry>) -> Void) { completion(widgetTimeline(current())) }
  private func current() -> HabitEntry {
    HabitEntry(date: .now, snapshot: WidgetSnapshotStore.read(from: WidgetSnapshotStore.url(), environment: WidgetSnapshotStore.environment), selectedID: nil)
  }
}

struct HabitWidgetEntryView: View {
  let entry: HabitEntry
  let style: HabitWidgetStyle
  @Environment(\.widgetFamily) private var family
  var body: some View {
    HabitWidgetView(style: style, snapshot: entry.snapshot, selectedHabit: entry.selectedHabit, family: family, isStale: entry.isStale)
      .containerBackground(for: .widget) { Color(nsColor: .windowBackgroundColor) }
      .widgetURL(WidgetSnapshotStore.destination(habitID: style == .today ? nil : entry.selectedHabit?.id))
  }
}

struct ActivityGridWidget: Widget {
  let kind = "HabitSystem.ActivityGrid"
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: kind, intent: HabitConfiguration.self, provider: HabitProvider()) { HabitWidgetEntryView(entry: $0, style: .activity) }
      .configurationDisplayName("Activity Grid")
      .description("A GitHub-style record of the days you showed up.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
struct WeeklyFocusWidget: Widget {
  let kind = "HabitSystem.WeeklyFocus"
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: kind, intent: HabitConfiguration.self, provider: HabitProvider()) { HabitWidgetEntryView(entry: $0, style: .week) }
      .configurationDisplayName("Weekly Focus")
      .description("One habit, seven days, and your next small step.")
      .supportedFamilies([.systemSmall, .systemMedium])
  }
}
struct TodayWidget: Widget {
  let kind = "HabitSystem.Today"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: TodayProvider()) { HabitWidgetEntryView(entry: $0, style: .today) }
      .configurationDisplayName("Today")
      .description("Your habits and progress together at a glance.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

@main
struct HabitWidgetBundle: WidgetBundle {
  var body: some Widget { ActivityGridWidget(); WeeklyFocusWidget(); TodayWidget() }
}
