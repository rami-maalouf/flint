import Foundation

struct IntentMissRow: Equatable {
  let pair: IntentMissPair
  let status: String
  let identifier: String?
}

struct IntentMissAlertStore {
  let executor: IntentExecutor

  func transaction<T>(_ write: Bool = false, _ work: (IntentDatabase) throws -> T) throws -> T {
    try executor.missAlertTransaction(exclusive: write, work)
  }

  func boardId(checkInId: String) throws -> String {
    try transaction { database in
      guard let id = try database.rows("SELECT board_id FROM check_ins WHERE id = ?", [.text(checkInId)]).first?["board_id"]?.string,
        IntentMissPair.parse(IntentMissPair(boardId: id, secondDate: "2000-01-01").identifier) != nil else { throw IntentFailure.database }
      return id
    }
  }

  func evidence(_ database: IntentDatabase, boardId: String, pairs: [IntentMissPair], time: IntentMissTime) throws -> IntentMissEvidence? {
    guard let row = try database.rows("SELECT id, kind, title, start_of_day_minute, archived_at, deleted_at FROM boards WHERE id = ?", [.text(boardId)]).first else { return nil }
    guard let id = row["id"]?.string, let kind = row["kind"]?.string, ["daily", "count"].contains(kind),
      let title = row["title"]?.string, let minute = row["start_of_day_minute"]?.number,
      let startMinute = Int(exactly: minute), startMinute >= 0, startMinute <= 720, startMinute % 30 == 0 else { throw IntentFailure.database }
    for key in ["archived_at", "deleted_at"] {
      guard row[key] == .null || (row[key]?.number.map { $0.isFinite && abs($0) <= 8_640_000_000_000_000 } == true) else { throw IntentFailure.database }
    }
    let board = IntentMissBoard(id: id, kind: kind, title: title, startMinute: startMinute,
      active: row["archived_at"] == .null && row["deleted_at"] == .null)
    let periods = try database.rows("SELECT start_date, end_date FROM board_activity_periods WHERE board_id = ? AND deleted_at IS NULL ORDER BY start_date, id", [.text(boardId)]).map { row -> IntentMissPeriod in
      guard let start = row["start_date"]?.string, IntentMissAlerts.validDate(start),
        row["end_date"] == .null || (row["end_date"]?.string.map(IntentMissAlerts.validDate) == true) else { throw IntentFailure.database }
      return .init(start: start, end: row["end_date"]?.string)
    }
    let today = try IntentCalendar.logicalDate(utcMs: time.instant, zone: time.zone, startMinute: startMinute)
    var seconds = Set(pairs.map(\.secondDate))
    seconds.insert(try IntentCalendar.addingDays(-1, to: today))
    var dates = Set<String>()
    for second in seconds where IntentMissAlerts.validDate(second) {
      dates.insert(second)
      let first = try IntentCalendar.addingDays(-1, to: second)
      if IntentMissAlerts.validDate(first) { dates.insert(first) }
    }
    let json = String(decoding: try JSONEncoder().encode(dates.sorted()), as: UTF8.self)
    let checked = try database.rows("""
      SELECT DISTINCT logical_date FROM check_ins WHERE board_id = ? AND deleted_at IS NULL AND state_suppressed = 0
        AND logical_date IN (SELECT value FROM json_each(?))
      """, [.text(boardId), .text(json)]).map { try IntentCoinSQL($0).string("logical_date") }
    return .init(board: board, periods: periods, checked: Set(checked))
  }

  func row(_ database: IntentDatabase, _ pair: IntentMissPair) throws -> IntentMissRow? {
    guard let raw = try database.rows("SELECT status, native_identifier FROM miss_alerts WHERE board_id = ? AND second_missed_date = ?", [.text(pair.boardId), .text(pair.secondDate)]).first else { return nil }
    guard let status = raw["status"]?.string, ["pending", "scheduled", "denied", "error"].contains(status),
      raw["native_identifier"] == .null || raw["native_identifier"]?.string == pair.identifier,
      status != "scheduled" || raw["native_identifier"]?.string != nil,
      status != "denied" || raw["native_identifier"] == .null else { throw IntentFailure.database }
    return .init(pair: pair, status: status, identifier: raw["native_identifier"]?.string)
  }

  @discardableResult func replace(_ database: IntentDatabase, expected: IntentMissRow?, next: IntentMissRow) throws -> Bool {
    try validate(next)
    if let expected {
      try validate(expected)
      guard expected.pair == next.pair else { throw IntentFailure.database }
    }
    if let expected {
      return try database.run("""
        UPDATE miss_alerts SET native_identifier = ?, status = ?
        WHERE board_id = ? AND second_missed_date = ? AND status = ? AND native_identifier IS ?
          AND (native_identifier IS NOT ? OR status != ?)
        """, [.string(next.identifier), .text(next.status), .text(next.pair.boardId), .text(next.pair.secondDate),
          .text(expected.status), .string(expected.identifier), .string(next.identifier), .text(next.status)]) > 0
    }
    return try database.run("""
      INSERT INTO miss_alerts (board_id, second_missed_date, native_identifier, status) VALUES (?, ?, ?, ?)
      ON CONFLICT(board_id, second_missed_date) DO NOTHING
      """, [.text(next.pair.boardId), .text(next.pair.secondDate), .string(next.identifier), .text(next.status)]) > 0
  }

  private func validate(_ row: IntentMissRow) throws {
    guard IntentMissPair.parse(row.pair.identifier) == row.pair,
      ["pending", "scheduled", "denied", "error"].contains(row.status),
      row.identifier == nil || row.identifier == row.pair.identifier,
      row.status != "scheduled" || row.identifier != nil,
      row.status != "denied" || row.identifier == nil else { throw IntentFailure.database }
  }
}
