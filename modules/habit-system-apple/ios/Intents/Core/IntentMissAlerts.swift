import Foundation

struct IntentMissPair: Hashable {
  let boardId: String
  let secondDate: String
  var identifier: String { "habit-system.miss.v1:\(boardId):\(secondDate)" }

  static func parse(_ value: String) -> Self? {
    let prefix = "habit-system.miss.v1:"
    guard value.hasPrefix(prefix) else { return nil }
    let parts = value.dropFirst(prefix.count).split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let board = String(parts[0]), date = String(parts[1])
    guard board.utf8.count == 36,
      board.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil,
      IntentMissAlerts.validDate(date) else { return nil }
    return .init(boardId: board, secondDate: date)
  }
}

struct IntentMissContent {
  let pair: IntentMissPair
  let title: String
  var identifier: String { pair.identifier }
  var body: String { "\(title) was missed twice. Fix the environment before anything else today." }
  var data: [String: String] { ["boardId": pair.boardId, "secondMissedDate": pair.secondDate] }

  static func decode(identifier: String, title: String, body: String, data: [String: Any]) -> Self? {
    guard let pair = IntentMissPair.parse(identifier), Set(data.keys) == ["boardId", "secondMissedDate"],
      let board = data["boardId"] as? String, let date = data["secondMissedDate"] as? String,
      board.utf8.elementsEqual(pair.boardId.utf8), date.utf8.elementsEqual(pair.secondDate.utf8) else { return nil }
    let content = Self(pair: pair, title: title)
    // swift string equality normalizes unicode; the javascript contract preserves bytes.
    return body.utf8.elementsEqual(content.body.utf8) ? content : nil
  }
}

struct IntentMissBoard {
  let id: String
  let kind: String
  let title: String
  let startMinute: Int
  let active: Bool
}
struct IntentMissPeriod { let start: String; let end: String? }
struct IntentMissEvidence { let board: IntentMissBoard; let periods: [IntentMissPeriod]; let checked: Set<String> }
struct IntentMissTime { let instant: Double; let zone: String; let foreground: Bool }
enum IntentMissTrigger: Equatable { case immediate, local09(String) }
struct IntentMissRequest { let content: IntentMissContent; let trigger: IntentMissTrigger; let zone: String }
struct IntentMissPending { let identifier: String; let content: IntentMissContent?; let nextFire: Double? }
enum IntentMissAuthorization: String { case granted, denied, undetermined }
enum IntentMissScheduleOutcome: String { case accepted, notAccepted = "not_accepted", unknown, retired, unchanged }

@MainActor protocol IntentMissNotificationCenter {
  func authorization() async throws -> IntentMissAuthorization
  func pending() async throws -> [IntentMissPending]
  func presented() async throws -> [String]
  func put(_ request: IntentMissRequest, replacing: IntentMissPending?, isCurrent: () -> Bool) async -> IntentMissScheduleOutcome
  func cancel(_ identifier: String) async throws
}

enum IntentMissAlerts {
  static func validDate(_ date: String) -> Bool { date.utf8.count == 10 && IntentCalendar.isValidDate(date) }

  static func valid(_ pair: IntentMissPair, evidence: IntentMissEvidence?, time: IntentMissTime) throws -> Bool {
    guard let evidence, evidence.board.id == pair.boardId, evidence.board.kind == "daily", evidence.board.active else { return false }
    let today = try IntentCalendar.logicalDate(utcMs: time.instant, zone: time.zone, startMinute: evidence.board.startMinute)
    let first = try IntentCalendar.addingDays(-1, to: pair.secondDate)
    guard validDate(first), pair.secondDate < today else { return false }
    return [first, pair.secondDate].allSatisfy { date in
      !evidence.checked.contains(date) && evidence.periods.contains { date >= $0.start && ($0.end == nil || date <= $0.end!) }
    }
  }

  static func candidate(_ evidence: IntentMissEvidence, time: IntentMissTime) throws -> IntentMissContent? {
    guard evidence.board.active, evidence.board.kind == "daily" else { return nil }
    let today = try IntentCalendar.logicalDate(utcMs: time.instant, zone: time.zone, startMinute: evidence.board.startMinute)
    let second = try IntentCalendar.addingDays(-1, to: today)
    guard validDate(second) else { return nil }
    let pair = IntentMissPair(boardId: evidence.board.id, secondDate: second)
    return try valid(pair, evidence: evidence, time: time) ? .init(pair: pair, title: evidence.board.title) : nil
  }

  static func trigger(_ time: IntentMissTime) throws -> IntentMissTrigger {
    let calendar = try IntentCalendar.calendar(zone: time.zone)
    let wall = try IntentCivilTime.wall(utcMs: time.instant, zone: calendar.timeZone)
    if wall.minute < 540 { return .local09(IntentCivilTime.date(epochDay: wall.day)) }
    if time.foreground { return .immediate }
    let date = IntentCivilTime.date(epochDay: wall.day + 1)
    guard validDate(date) else { throw IntentFailure.database }
    return .local09(date)
  }
}
