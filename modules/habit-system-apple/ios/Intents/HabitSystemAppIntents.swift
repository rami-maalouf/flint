#if os(iOS)
import AppIntents
import Foundation
import UIKit
import WidgetKit

public struct HabitSystemBoardEntity: AppEntity {
  public static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Board")
  public static var defaultQuery = HabitSystemBoardQuery()
  public let id: String
  public let title: String

  public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }

  public init(id: String, title: String) { self.id = id; self.title = title }
}

public struct HabitSystemBoardQuery: EntityStringQuery {
  public init() {}

  public func suggestedEntities() async throws -> [HabitSystemBoardEntity] {
    try HabitSystemIntentRuntime.open().listBoards().get().map { HabitSystemBoardEntity(id: $0.boardId, title: $0.title) }
  }

  public func entities(for identifiers: [String]) async throws -> [HabitSystemBoardEntity] {
    try HabitSystemIntentRuntime.open().listBoards(identifiers: identifiers).get()
      .map { HabitSystemBoardEntity(id: $0.boardId, title: $0.title) }
  }

  public func entities(matching string: String) async throws -> [HabitSystemBoardEntity] {
    try await suggestedEntities().filter { $0.title.localizedCaseInsensitiveContains(string) }
  }
}

public struct HabitSystemCheckInIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check In"
  public static var description = IntentDescription("Record a check-in on an active Habit System board.")

  @Parameter(title: "Board") public var board: HabitSystemBoardEntity
  @Parameter(title: "Date", kind: .date) public var date: DateComponents?
  @Parameter(title: "Time", kind: .time) public var time: DateComponents?
  @Parameter(title: "Amount") public var amount: Double?
  @Parameter(title: "Note") public var note: String?

  // a new invocation gets a new uuid; retrying this invocation reuses it.
  // app intents has no durable, cross-process execution token to persist.
  private let commandId = UUID().uuidString.lowercased()
  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("Check in to \(\.$board)") { \.$date; \.$time; \.$amount; \.$note }
  }

  @MainActor public func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let executor = try HabitSystemIntentRuntime.open()
    if let receipt = try executor.replay(commandId: commandId, as: IntentCreatedCheckIn.self) {
      let result = try receipt.get()
      await HabitSystemIntentRuntime.reconcileMissAlerts(executor, checkInId: result.checkInId)
      HabitSystemIntentRuntime.publishWidgets(executor)
      let text = HabitSystemIntentRuntime.checkInText(result, title: board.title)
      return .result(value: text, dialog: "\(text)")
    }
    let record = try executor.activeBoard(id: board.id)
    let logicalDate = try HabitSystemIntentRuntime.logicalDate(date)
    var occurredAt: Double?
    if record.kind == .count && record.tracksTime, let time {
      guard let hour = time.hour, let minute = time.minute, (0...23).contains(hour), (0...59).contains(minute) else {
        throw IntentFailure(code: "validation", message: "Choose a valid local time.", field: "occurredAtUtc")
      }
      let date = try logicalDate ?? IntentCalendar.logicalDate(utcMs: executor.now(), zone: executor.zone(), startMinute: record.startOfDayMinute)
      occurredAt = try IntentCalendar.occurredAt(logicalDate: date, hour: hour, minute: minute,
        startMinute: record.startOfDayMinute, zone: executor.zone())
    }
    let result = try executor.checkIn(IntentCheckInInput(commandId: commandId, boardId: board.id,
      logicalDate: logicalDate, occurredAtUtc: occurredAt, amount: amount, note: note)).get()
    await HabitSystemIntentRuntime.reconcileMissAlerts(executor, checkInId: result.checkInId)
    HabitSystemIntentRuntime.publishWidgets(executor)
    let text = HabitSystemIntentRuntime.checkInText(result, title: record.title)
    return .result(value: text, dialog: "\(text)")
  }
}

public struct HabitSystemRemoveLatestCheckInIntent: AppIntent {
  public static var title: LocalizedStringResource = "Remove Latest Check-In"
  public static var description = IntentDescription("Confirm and remove the latest Count check-in or all Daily check-ins for a date.")

  @Parameter(title: "Board") public var board: HabitSystemBoardEntity
  @Parameter(title: "Date", kind: .date) public var date: DateComponents?
  private let commandId = UUID().uuidString.lowercased()
  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("Remove the latest check-in from \(\.$board)") { \.$date }
  }

  @MainActor public func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let executor = try HabitSystemIntentRuntime.open()
    if let receipt = try executor.replay(commandId: commandId, as: IntentRemovedCheckIn.self) {
      let result = try receipt.get()
      await HabitSystemIntentRuntime.reconcileMissAlerts(executor, checkInId: result.removedCheckInId)
      HabitSystemIntentRuntime.publishWidgets(executor)
      let text = HabitSystemIntentRuntime.removalText(result, title: board.title)
      return .result(value: text, dialog: "\(text)")
    }
    let candidate = try executor.removalCandidate(boardId: board.id, logicalDate: HabitSystemIntentRuntime.logicalDate(date)).get()
    try await requestConfirmation(
      actionName: .custom(acceptLabel: "Remove", acceptAlternatives: [], denyLabel: "Cancel", denyAlternatives: [], destructive: true),
      dialog: "\(candidate.confirmationText)"
    )
    let result = try executor.removeLatest(commandId: commandId, boardId: board.id,
      logicalDate: candidate.logicalDate, expectedCheckInId: candidate.checkInId,
      expectedCheckInIds: candidate.checkInIds, expectedSnapshot: candidate.snapshot).get()
    await HabitSystemIntentRuntime.reconcileMissAlerts(executor, checkInId: result.removedCheckInId)
    HabitSystemIntentRuntime.publishWidgets(executor)
    let text = HabitSystemIntentRuntime.removalText(result, title: candidate.boardTitle)
    return .result(value: text, dialog: "\(text)")
  }
}

public struct HabitSystemTodayCheckInsIntent: AppIntent {
  public static var title: LocalizedStringResource = "Get Today's Check-Ins"
  public static var description = IntentDescription("Get check-in counts and board names for each board's current logical date.")

  @Parameter(title: "Board") public var board: HabitSystemBoardEntity?
  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("Get today's check-ins") { \.$board }
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let result = try HabitSystemIntentRuntime.open().today(boardId: board?.id).get()
    let lines = result.boards.map { String(localized: "\($0.title): \($0.count)") }
    let text = (lines + [String(localized: "Total: \(result.total)")]).joined(separator: "\n")
    return .result(value: text, dialog: "\(text)")
  }
}

enum HabitSystemIntentRuntime {
  @MainActor static func reconcileMissAlerts(_ executor: IntentExecutor, checkInId: String) async {
    let alerts = IntentMissAlertReconciliation(executor: executor, center: IntentMissNotifications(api: .live()),
      foreground: { UIApplication.shared.applicationState == .active })
    _ = await alerts.run(checkInId: checkInId)
  }

  static func checkInText(_ result: IntentCreatedCheckIn, title: String) -> String {
    result.created ? String(localized: "Checked in to \(title) for \(result.logicalDate).")
      : String(localized: "\(title) is already checked for \(result.logicalDate).")
  }

  static func removalText(_ result: IntentRemovedCheckIn, title: String) -> String {
    result.removedCheckInIds.count > 1
      ? String(localized: "Removed all \(result.removedCheckInIds.count) check-ins from \(title) for \(result.logicalDate).")
      : String(localized: "Removed the latest check-in from \(title) for \(result.logicalDate).")
  }

  static func open() throws -> IntentExecutor {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HabitSystemAppGroupIdentifier") as? String,
          !group.isEmpty,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
      throw IntentFailure.unavailable
    }
    return IntentExecutor(database: try IntentDatabase(path: container.appendingPathComponent("habit-system.db").path))
  }

  static func logicalDate(_ components: DateComponents?) throws -> String? {
    guard let components else { return nil }
    guard let year = components.year, let month = components.month, let day = components.day else {
      throw IntentFailure(code: "validation", message: "Choose a valid date.", field: "logicalDate")
    }
    let value = String(format: "%04d-%02d-%02d", year, month, day)
    guard IntentCalendar.isValidDate(value) else {
      throw IntentFailure(code: "validation", message: "Choose a valid date.", field: "logicalDate")
    }
    return value
  }

  // sdk 57's widget reads serialized timeline props from this app-group
  // suite. update those props from committed sql before asking for reload.
  static func publishWidgets(_ executor: IntentExecutor) {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String,
          let defaults = UserDefaults(suiteName: group),
          defaults.string(forKey: "__expo_widgets_HabitSystemBoards_layout") != nil,
          let timeline = try? executor.widgetTimeline().get(),
          let data = try? JSONEncoder().encode(timeline.entries),
          let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
    defaults.set(entries, forKey: "__expo_widgets_HabitSystemBoards_timeline")
    WidgetCenter.shared.reloadTimelines(ofKind: "HabitSystemBoards")
  }
}
#endif
