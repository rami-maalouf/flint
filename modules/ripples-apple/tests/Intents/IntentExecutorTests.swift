import Foundation
import XCTest
@testable import RipplesIntentCore

final class IntentExecutorTests: XCTestCase {
  private static var root: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }

  private func fixture() throws -> [String: Any] {
    // this is the exact fixture consumed by the typescript test suite.
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/intent-contract.json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func migrations() throws -> [[String: Any]] {
    try IntentFixtureMigrations.load(root: Self.root)
  }

  private final class Harness {
    let database: IntentDatabase
    var instant: Double
    var timeZone: String
    var counter = 0
    var generatedIds: [String]?
    lazy var executor = IntentExecutor(database: database, now: { self.instant }, zone: { self.timeZone }, uuid: { self.id() })

    init(seed: [String: Any], migrations: [[String: Any]], path: String = ":memory:") throws {
      database = try IntentDatabase(path: path, createForTesting: true)
      instant = seed["nowUtcMs"] as! Double
      timeZone = seed["timeZoneId"] as! String
      for migration in migrations { try IntentFixtureMigrations.apply(migration, to: database, enqueueAt: Int64(instant)) }
      let version = migrations.last!["version"] as! Int
      try database.run("PRAGMA user_version = \(version)")
      try database.run("INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, ?, '00000000-0000-4000-8000-00000000d001')", [.integer(Int64(version))])
      let boards = seed["boards"] as! [[String: Any]]
      for (index, board) in boards.enumerated() {
        let archived = board["archived"] as! Bool
        let id = board["id"] as! String
        let title = board["title"] as! String
        let kind = board["kind"] as? String ?? "count"
        let date = try IntentCalendar.logicalDate(utcMs: instant, zone: timeZone, startMinute: board["startOfDayMinute"] as! Int)
        try database.run("""
          INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background, tracks_amount,
            amount_unit, quick_amount, tracks_time, start_of_day_minute, metrics_enabled, order_key,
            archived_at, created_at, updated_at, mutation_stamp, deleted_at)
          VALUES (?, ?, 'star.fill', '#70A7FF', 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'seed', NULL)
          """, [.text(id), .text(title), .integer(board["tracksAmount"] as! Bool ? 1 : 0),
                 .string(board["amountUnit"] as? String), .real(board["quickAmount"] as! Double),
                 .integer(board["tracksTime"] as! Bool ? 1 : 0), .integer(Int64(board["startOfDayMinute"] as! Int)),
                 .text(String(index)), archived ? .integer(Int64(instant)) : .null,
                 .integer(Int64(instant)), .integer(Int64(instant))])
        try database.run("UPDATE boards SET kind = ?, earns_coins = ?, coin_cap_per_day = ? WHERE id = ?",
          [.text(kind), .integer(board["earnsCoins"] as? Bool == true ? 1 : 0), .integer(Int64(board["coinCapPerDay"] as? Int ?? 1)), .text(id)])
        try database.run("INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp) VALUES (?, ?, ?, 'seed')", [.text(id), .text(date), archived ? .text(date) : .null])
        if !archived {
          try database.run("INSERT INTO widget_board_rows (board_id, position, title, symbol, accent_hex, strip, strip_end_date, kind) VALUES (?, ?, ?, 'star.fill', '#70A7FF', '[0,0,0,0,0,0,0]', ?, ?)", [.text(id), .integer(Int64(index)), .text(title), .text(date), .text(kind)])
        }
      }
      for row in seed["checkIns"] as? [[String: Any]] ?? [] {
        let id = try XCTUnwrap(row["id"] as? String, "fixture check id")
        let boardId = try XCTUnwrap(row["boardId"] as? String, "fixture check boardId")
        let logicalDate = try XCTUnwrap(row["logicalDate"] as? String, "fixture check logicalDate")
        let source = try XCTUnwrap(row["source"] as? String, "fixture check source")
        let idempotencyKey = try XCTUnwrap(row["idempotencyKey"] as? String, "fixture check idempotencyKey")
        let createdAt = try XCTUnwrap(row["createdAt"] as? Double, "fixture check createdAt")
        let updatedAt = try XCTUnwrap(row["updatedAt"] as? Double, "fixture check updatedAt")
        let mutationStamp = try XCTUnwrap(row["mutationStamp"] as? String, "fixture check mutationStamp")
        try database.run("""
          INSERT INTO check_ins (id, board_id, logical_date, occurred_at_utc, time_zone_id,
            offset_minutes, amount, note, source, idempotency_key, created_at, updated_at, mutation_stamp, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          """, [.text(id), .text(boardId), .text(logicalDate),
                 .number(row["occurredAtUtc"] as? Double), .string(row["timeZoneId"] as? String),
                 .number(row["offsetMinutes"] as? Double), .number(row["amount"] as? Double),
                 .string(row["note"] as? String), .text(source), .text(idempotencyKey),
                 .real(createdAt), .real(updatedAt), .text(mutationStamp), .number(row["deletedAt"] as? Double)])
      }
      let historicalIds = (seed["checkIns"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
      try IntentFixtureMigrations.establishHistorical(database: database, ids: historicalIds, enqueueAt: Int64(instant))
    }

    func id() -> String {
      if let queued = generatedIds {
        guard let next = queued.first else {
          XCTFail("fixture uuid queue exhausted")
          return "invalid-exhausted-fixture-uuid"
        }
        generatedIds = Array(queued.dropFirst())
        return next
      }
      counter += 1
      return String(format: "00000000-0000-4000-8000-%012d", counter)
    }

    func legacyCheck(boardId: String, date: String) throws -> String {
      let checkId = id()
      try database.run("""
        INSERT INTO check_ins (id, board_id, logical_date, source, idempotency_key,
          created_at, updated_at, mutation_stamp, note, amount)
        VALUES (?, ?, ?, 'manual', ?, 1, 1, 'legacy', 'legacy note', 3)
        """, [.text(checkId), .text(boardId), .text(date), .text(id())])
      try IntentFixtureMigrations.establishHistorical(database: database, ids: [checkId], enqueueAt: Int64(instant))
      return checkId
    }

    func run(_ intent: String, _ input: [String: Any], commandId: String? = nil) throws -> [String: Any] {
      let id = commandId ?? self.id()
      let encoded: Data
      switch intent {
      case "listBoards": encoded = try JSONEncoder().encode(executor.listBoards())
      case "checkIn": encoded = try JSONEncoder().encode(executor.checkIn(IntentCheckInInput(
        commandId: id, boardId: input["boardId"] as! String, logicalDate: input["logicalDate"] as? String,
        occurredAtUtc: input["occurredAtUtc"] as? Double, amount: input["amount"] as? Double, note: input["note"] as? String)))
      case "removeLatest": encoded = try JSONEncoder().encode(executor.removeLatest(commandId: id, boardId: input["boardId"] as! String, logicalDate: input["logicalDate"] as? String))
      default: encoded = try JSONEncoder().encode(executor.today(boardId: input["boardId"] as? String))
      }
      return try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    }
  }

  private func harness() throws -> Harness {
    let source = try fixture()
    return try Harness(seed: source["seed"] as! [String: Any], migrations: migrations())
  }

  func testRawPayloadBeforeActionStaysHiddenThroughNativeReadsCheckAndRemoval() throws {
    for kind in ["daily", "count"] {
      let h = try harness()
      let board = "00000000-0000-4000-8000-00000000a002", date = "2026-08-30"
      try h.database.run("UPDATE boards SET kind = ?, tracks_time = 0, tracks_amount = 0, earns_coins = 1, coin_cap_per_day = 10 WHERE id = ?", [.text(kind), .text(board)])
      let pending = h.id()
      try h.database.run("INSERT INTO check_ins (id, board_id, logical_date, source, idempotency_key, created_at, updated_at, mutation_stamp, note) VALUES (?, ?, ?, 'manual', ?, 1, 1, 'pending-payload', 'private pending note')", [.text(pending), .text(board), .text(date), .text(h.id())])
      let payload = try h.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(pending)])
      XCTAssertEqual(try h.executor.today(boardId: board).get().total, 0, kind)
      XCTAssertEqual(h.executor.removalCandidate(boardId: board, logicalDate: date).error, .noCheckIn, kind)
      _ = try h.executor.widgetTimeline().get()
      XCTAssertEqual(try h.database.rows("SELECT strip FROM widget_board_rows WHERE board_id = ?", [.text(board)]).first?["strip"], .text("[0,0,0,0,0,0,0]"), kind)
      let fresh = IntentExecutor(database: h.database, now: { h.instant }, zone: { h.timeZone }, uuid: { h.id() })
      let created = try fresh.checkIn(.init(commandId: h.id(), boardId: board)).get()
      XCTAssertTrue(created.created, kind)
      XCTAssertNotEqual(created.checkInId, pending, kind)
      XCTAssertEqual(try fresh.today(boardId: board).get().total, 1, kind)
      XCTAssertEqual(try h.database.rows("SELECT kind FROM habit_actions"), [["kind": .text("check")]], kind)
      XCTAssertEqual(try h.database.rows("SELECT SUM(delta) AS total FROM coin_ledger").first?["total"], .integer(1), kind)
      XCTAssertEqual(try fresh.removeLatest(commandId: h.id(), boardId: board).get().removedCheckInIds, [created.checkInId], kind)
      XCTAssertEqual(try fresh.today(boardId: board).get().total, 0, kind)
      XCTAssertEqual(try h.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(pending)]), payload, kind)
      XCTAssertEqual(try h.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").count, 0, kind)
    }
  }

  func testNativeBonusSettlementNeverInventsEvidenceForAnotherMembersRawPayload() throws {
    let h = try harness()
    let root = "00000000-0000-4000-8000-00000000a001", member = "00000000-0000-4000-8000-00000000a002", date = "2026-08-30"
    try h.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0, start_of_day_minute = 0, required_in_stack = 1 WHERE id IN (?, ?)", [.text(root), .text(member)])
    try h.database.run("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    try h.database.run("INSERT INTO check_ins (id, board_id, logical_date, source, idempotency_key, created_at, updated_at, mutation_stamp) VALUES (?, ?, ?, 'manual', ?, 1, 1, 'pending-payload')", [.text(h.id()), .text(root), .text(date), .text(h.id())])
    _ = try h.executor.checkIn(.init(commandId: h.id(), boardId: member)).get()
    XCTAssertEqual(try h.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").count, 0)
    XCTAssertEqual(try h.database.rows("SELECT * FROM coin_ledger WHERE kind = 'run_bonus'").count, 0)
    XCTAssertEqual(try h.executor.today(boardId: root).get().total, 0)
  }

  func testPayloadPersistsSuppressedAcrossFileReopenUntilItsGenuineActionArrives() throws {
    for kind in ["daily", "count"] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let path = directory.appendingPathComponent("pending.sqlite").path
      let board = "00000000-0000-4000-8000-00000000a002", date = "2026-08-30"
      let pending = "00000000-0000-4000-8000-000000009001"
      var capturedNow: Double = 0, capturedZone = ""
      do {
        let h = try Harness(seed: XCTUnwrap(fixture()["seed"] as? [String: Any]), migrations: migrations(), path: path)
        capturedNow = h.instant; capturedZone = h.timeZone
        try h.database.run("UPDATE boards SET kind = ?, tracks_time = 0, earns_coins = 1, coin_cap_per_day = 10 WHERE id = ?", [.text(kind), .text(board)])
        try h.database.run("INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp) VALUES (?, ?, ?, 'manual', ?, 1, 1, 'pending-payload')", [.text(pending), .text(board), .text(date), .text(pending)])
        let instant = h.instant, zone = h.timeZone
        let writer = IntentExecutor(database: h.database, now: { instant }, zone: { zone })
        _ = try writer.checkIn(.init(commandId: h.id(), boardId: board)).get()
        XCTAssertEqual(try h.database.rows("SELECT state_suppressed FROM check_ins WHERE id = ?", [.text(pending)]), [["state_suppressed": .integer(1)]])
      }
      let db = try IntentDatabase(path: path)
      let reopened = IntentExecutor(database: db, now: { capturedNow }, zone: { capturedZone })
      XCTAssertEqual(try reopened.today(boardId: board).get().total, 1)
      let policy = IntentCoinPolicy(version: 1, boardKind: kind, earnsCoins: true, coinCapPerDay: 10,
        checkClosesAtUtc: Int64(capturedNow + 86_400_000), rootId: nil, requiredBoardIds: [], bonusClosesAtUtc: nil, bonusEnabled: false)
      let source = IntentHabitAction(id: "00000000-0000-4000-8000-000000009002", commandId: "00000000-0000-4000-8000-000000009003",
        boardId: board, logicalDate: date, checkInId: pending, kind: "check", createdAt: Int64(capturedNow) - 1,
        mutationStamp: String(format: "%014lld-00000-remote", Int64(capturedNow) - 1), policyJson: try policy.canonical())
      try db.transaction(exclusive: true) {
        try source.append(to: db)
        try IntentCoinStore.settleAffected(checkScopes: [.init(boardId: board, logicalDate: date)], database: db, enqueueAt: Int64(capturedNow))
        try IntentCheckVisibility.refresh(database: db, scopes: [.init(boardId: board, logicalDate: date)])
      }
      XCTAssertEqual(try reopened.today(boardId: board).get().total, kind == "daily" ? 1 : 2)
      XCTAssertTrue(try db.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").isEmpty)
      XCTAssertEqual(try db.rows("SELECT SUM(delta) AS total FROM coin_ledger").first?["total"], .integer(kind == "daily" ? 1 : 2))
      XCTAssertEqual(try db.rows("SELECT source_action_id FROM coin_ledger WHERE check_in_id = ?", [.text(pending)]), [["source_action_id": .text(source.id)]])
    }
  }

  func testVisibilityFailureRollsBackNativeSourceCoinsOutboxClockReceiptAndProjection() throws {
    let h = try harness(), board = "00000000-0000-4000-8000-00000000a002"
    try h.database.run("UPDATE boards SET earns_coins = 1 WHERE id = ?", [.text(board)])
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "command_receipts", "widget_board_rows"]
    let before = try tables.map { try h.database.rows("SELECT * FROM \($0)") }
    let command = h.id()
    try h.database.run("CREATE TRIGGER reject_visibility BEFORE UPDATE OF state_suppressed ON check_ins BEGIN SELECT RAISE(ABORT, 'visibility failure'); END")
    XCTAssertEqual(h.executor.checkIn(.init(commandId: command, boardId: board)).error, .database)
    for (index, table) in tables.enumerated() { XCTAssertEqual(try h.database.rows("SELECT * FROM \(table)"), before[index], table) }
    try h.database.run("DROP TRIGGER reject_visibility")
    let created = try h.executor.checkIn(.init(commandId: command, boardId: board)).get()
    XCTAssertEqual(try h.executor.today(boardId: board).get().total, 1)
    XCTAssertEqual(try h.executor.checkIn(.init(commandId: command, boardId: board)).get(), created)
  }

  func testTimedHistoricalCheckInsPreserveProlepticDatesAndSelectedWallTime() throws {
    let harness = try harness()
    harness.timeZone = "UTC"
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET tracks_time = 1, start_of_day_minute = 0 WHERE id = ?", [.text(board)])
    let cases: [(String, Double)] = [
      ("0000-02-29", -62_162_121_600_000),
      ("0001-01-02", -62_135_467_200_000),
      ("1582-10-10", -12_219_724_800_000),
    ]
    for (date, instant) in cases {
      let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, occurredAtUtc: instant)).get()
      XCTAssertEqual(result.logicalDate, date)
      let row = try XCTUnwrap(harness.database.rows("SELECT logical_date, occurred_at_utc, offset_minutes FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first)
      XCTAssertEqual(row["logical_date"]?.string, date)
      XCTAssertEqual(row["occurred_at_utc"]?.number, instant)
      XCTAssertEqual(row["offset_minutes"]?.number, 0)
    }
    // the app intent resolves its selected date and time before calling the executor.
    let instant = try IntentCalendar.occurredAt(logicalDate: "0001-01-02", hour: 12, minute: 0, startMinute: 0, zone: "UTC")
    let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, logicalDate: "0001-01-02", occurredAtUtc: instant)).get()
    XCTAssertEqual(result.logicalDate, "0001-01-02")
    XCTAssertEqual(try harness.database.rows("SELECT occurred_at_utc FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first?["occurred_at_utc"]?.number, -62_135_467_200_000)
  }

  func testTimedHistoricalCheckInsKeepFractionalMinuteOffsets() throws {
    let harness = try harness()
    harness.timeZone = "Europe/Paris"
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET tracks_time = 1, start_of_day_minute = 0 WHERE id = ?", [.text(board)])
    for instant in [-2_208_988_800_000.0, -2_208_988_755_000.0] {
      let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, occurredAtUtc: instant)).get()
      XCTAssertEqual(result.logicalDate, "1900-01-01")
      XCTAssertEqual(try harness.database.rows("SELECT offset_minutes FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first?["offset_minutes"]?.number, 9.35)
    }
  }

  func testSelectedTimesInsideGapsPersistTheSameDayForwardResolution() throws {
    let harness = try harness()
    harness.instant = 1_800_000_000_000
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET tracks_time = 1, start_of_day_minute = 0 WHERE id = ?", [.text(board)])
    let cases: [(String, String, Int, Int, Double, Double)] = [
      ("2026-03-08", "America/New_York", 2, 0, 1_772_953_200_000, -240),
      ("2026-10-04", "Australia/Lord_Howe", 2, 0, 1_791_041_400_000, 660),
      ("2026-10-04", "Australia/Lord_Howe", 2, 15, 1_791_042_300_000, 660),
      ("1972-01-07", "Africa/Monrovia", 0, 0, 63_593_070_000, 0),
      ("1972-01-07", "Africa/Monrovia", 0, 15, 63_593_970_000, 0),
      ("1972-01-07", "Africa/Monrovia", 0, 30, 63_594_870_000, 0),
    ]
    for (date, zone, hour, minute, expected, offset) in cases {
      harness.timeZone = zone
      let instant = try IntentCalendar.occurredAt(logicalDate: date, hour: hour, minute: minute, startMinute: 0, zone: zone)
      let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, logicalDate: date, occurredAtUtc: instant)).get()
      XCTAssertEqual(result.logicalDate, date)
      let row = try XCTUnwrap(harness.database.rows("SELECT occurred_at_utc, offset_minutes FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first)
      XCTAssertEqual(row["occurred_at_utc"]?.number, expected, "\(zone) \(hour):\(minute)")
      XCTAssertEqual(row["offset_minutes"]?.number, offset)
    }
  }

  func testRemovalValidatesDatesBeforeSelectingRowsAndReplaysStoredOutcomesFirst() throws {
    for kind in ["count", "daily"] {
      let harness = try harness()
      let board = "00000000-0000-4000-8000-00000000a001"
      try harness.database.run("UPDATE boards SET kind = ? WHERE id = ?", [.text(kind), .text(board)])
      let current = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
      let before = try harness.database.rows("SELECT * FROM check_ins ORDER BY id")
      let clock = try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings")
      let outbox = try harness.database.rows("SELECT * FROM mutation_outbox")
      for date in ["2026-02-30", "2026-8-30", "2026-08-31"] {
        let command = harness.id()
        let result = harness.executor.removeLatest(commandId: command, boardId: board, logicalDate: date)
        XCTAssertEqual(result.error?.code, "validation", "\(kind) \(date)")
        XCTAssertEqual(result.error?.field, "logicalDate")
        XCTAssertEqual(harness.executor.removalCandidate(boardId: board, logicalDate: date).error?.code, "validation")
        let replay = harness.executor.removeLatest(commandId: command, boardId: board, logicalDate: current.logicalDate)
        XCTAssertEqual(replay.error, result.error)
      }
      XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins ORDER BY id"), before)
      XCTAssertEqual(try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings"), clock)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox"), outbox)
      let command = harness.id()
      let removed = try harness.executor.removeLatest(commandId: command, boardId: board).get()
      XCTAssertEqual(try harness.executor.removeLatest(commandId: command, boardId: board, logicalDate: "invalid").get(), removed)
    }
  }

  func testDailyCheckIsPureAndIdempotentAcrossCommands() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(board)])
    let first = try harness.run("checkIn", ["boardId": board, "amount": -1, "occurredAtUtc": Double.nan])
    XCTAssertEqual(first["ok"] as? Bool, true)
    let value = try XCTUnwrap(first["value"] as? [String: Any])
    XCTAssertEqual(value["created"] as? Bool, true)
    let clock = try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings")
    let second = try harness.run("checkIn", ["boardId": board])
    let secondValue = try XCTUnwrap(second["value"] as? [String: Any])
    XCTAssertEqual(secondValue["created"] as? Bool, false)
    XCTAssertEqual(secondValue["checkInId"] as? String, value["checkInId"] as? String)
    XCTAssertEqual(try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings"), clock)
    let rows = try harness.database.rows("SELECT * FROM check_ins")
    XCTAssertEqual(rows.count, 1)
    for field in ["amount", "occurred_at_utc", "time_zone_id", "offset_minutes"] {
      XCTAssertEqual(rows.first?[field], .null)
    }
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 1)
    XCTAssertEqual(try harness.executor.today(boardId: board).get().total, 1)
  }

  func testDailyRemovalClearsPreservedCountHistoryAndReportsBinaryToday() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET tracks_time = 1 WHERE id = ?", [.text(board)])
    for note in ["first private note", "second private note"] {
      XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, note: note)).ok)
    }
    let historyQuery = "SELECT id, note, amount, occurred_at_utc, time_zone_id, offset_minutes, created_at, idempotency_key FROM check_ins ORDER BY id"
    let history = try harness.database.rows(historyQuery)
    try harness.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0 WHERE id = ?", [.text(board)])
    XCTAssertEqual(try harness.executor.today(boardId: board).get().total, 1)
    let removed = try harness.run("removeLatest", ["boardId": board])
    let value = try XCTUnwrap(removed["value"] as? [String: Any])
    XCTAssertEqual((value["removedCheckInIds"] as? [String])?.count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT note, amount FROM check_ins WHERE deleted_at IS NOT NULL").count, 2)
    XCTAssertEqual(try harness.database.rows(historyQuery), history)
    XCTAssertEqual(try harness.executor.today(boardId: board).get().total, 0)
    let action = try XCTUnwrap(harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'uncheck'").first)
    XCTAssertEqual(action["check_in_id"], .null)
    let policy = try IntentCoinPolicy.parse(XCTUnwrap(action["policy_json"]?.string))
    XCTAssertEqual(policy.boardKind, "daily")
    XCTAssertFalse(policy.earnsCoins)
    XCTAssertFalse(String(describing: action).contains("private note"))
  }

  func testPublicBonusCompletionUsesExplicitOtherMemberLegacyStateAndReplaysWithoutEffects() throws {
    let harness = try harness()
    let root = "00000000-0000-4000-8000-00000000a001"
    let member = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0, start_of_day_minute = 0, required_in_stack = 1 WHERE id IN (?, ?)", [.text(root), .text(member)])
    try harness.database.run("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    let date = try IntentCalendar.logicalDate(utcMs: harness.instant, zone: harness.timeZone, startMinute: 0)
    let legacy = try harness.legacyCheck(boardId: root, date: date)
    let beforeCheck = try harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(legacy)])
    let command = harness.id()
    let result = try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: member)).get()
    XCTAssertTrue(result.created)
    let rows = try IntentCoinStore.entries(scopeKey: "bonus:\(root):\(date)", database: harness.database)
    XCTAssertEqual(rows.map(\.kind), ["run_bonus"])
    XCTAssertEqual(rows.map(\.delta), [1])
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT a.created_at AS source_time, a.mutation_stamp AS source_stamp, o.created_at AS enqueue_time FROM habit_actions a JOIN mutation_outbox o ON o.entity_id = a.id AND o.entity_type = 'habit_action' WHERE a.kind = 'baseline'"),
      [["source_time": .integer(0), "source_stamp": .text(IntentHabitAction.baselineStamp), "enqueue_time": .integer(Int64(harness.instant))]])
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(legacy)]), beforeCheck)
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows", "command_receipts"]
    let before = try tables.map { try harness.database.rows("SELECT * FROM \($0)") }
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: member)).get(), result)
    for (index, table) in tables.enumerated() { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table)"), before[index], table) }
    _ = try harness.executor.removeLatest(commandId: harness.id(), boardId: member).get()
    XCTAssertEqual(try IntentCoinStore.entries(scopeKey: "bonus:\(root):\(date)", database: harness.database).map(\.delta), [1, -1])
  }

  func testPublicBonusFailureRollsBackCheckCoinsAndAllSourceEffectsThenRetries() throws {
    let harness = try harness()
    let root = "00000000-0000-4000-8000-00000000a001"
    let member = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1, tracks_amount = 0, tracks_time = 0, start_of_day_minute = 0, required_in_stack = 1 WHERE id IN (?, ?)", [.text(root), .text(member)])
    try harness.database.run("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    _ = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: root)).get()
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows", "command_receipts"]
    let before = try tables.map { try harness.database.rows("SELECT * FROM \($0)") }
    try harness.database.run("CREATE TRIGGER reject_bonus BEFORE INSERT ON coin_ledger WHEN NEW.kind = 'run_bonus' BEGIN SELECT RAISE(ABORT, 'test'); END")
    let command = harness.id()
    XCTAssertThrowsError(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: member)).get())
    for (index, table) in tables.enumerated() { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table)"), before[index], table) }
    try harness.database.run("DROP TRIGGER reject_bonus")
    XCTAssertTrue(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: member)).get().created)
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(3))
  }

  func testPublicBonusDailyNoOpAndReplayBypassMissingEvidenceBeforeRemovalRollsBack() throws {
    let harness = try harness()
    let root = "00000000-0000-4000-8000-00000000a001"
    let member = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0, start_of_day_minute = 0 WHERE id IN (?, ?)", [.text(root), .text(member)])
    try harness.database.run("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    _ = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: root)).get()
    let command = harness.id()
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: member)).get()
    let json = try XCTUnwrap(harness.database.rows("SELECT policy_json FROM habit_actions WHERE board_id = ?", [.text(member)]).first?["policy_json"]?.string)
    let missing = IntentHabitAction(id: harness.id(), commandId: harness.id(), boardId: member, logicalDate: created.logicalDate,
      checkInId: harness.id(), kind: "check", createdAt: Int64(harness.instant), mutationStamp: "01788105600000-00099-native", policyJson: json)
    let award = try IntentBonusCoins.award(missing, policy: IntentCoinPolicy.parse(json))
    try IntentCoinStore.append(award, to: harness.database, enqueueAt: Int64(harness.instant))
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows"]
    let before = try tables.map { try harness.database.rows("SELECT * FROM \($0)") }
    XCTAssertFalse(try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: member)).get().created)
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: "missing")).get(), created)
    XCTAssertThrowsError(try harness.executor.removeLatest(commandId: harness.id(), boardId: member).get())
    for (index, table) in tables.enumerated() { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table)"), before[index], table) }
  }

  func testPublicBonusCapturedDateRemovalKeepsClosedAwardAndSecondConnectionNextDate() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let h = try Harness(seed: XCTUnwrap(fixture()["seed"] as? [String: Any]), migrations: migrations(), path: directory.appendingPathComponent("bonus.sqlite").path)
    h.timeZone = "UTC"
    let root = "00000000-0000-4000-8000-00000000a001", member = "00000000-0000-4000-8000-00000000a002"
    try h.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0, start_of_day_minute = 240 WHERE id IN (?, ?)", [.text(root), .text(member)])
    try h.database.run("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    _ = try h.executor.checkIn(IntentCheckInInput(commandId: h.id(), boardId: root)).get()
    let old = try h.executor.checkIn(IntentCheckInInput(commandId: h.id(), boardId: member, note: "captured note")).get()
    let candidate = try h.executor.removalCandidate(boardId: member, logicalDate: nil).get()
    let policy = try IntentCoinPolicy.parse(XCTUnwrap(h.database.rows("SELECT policy_json FROM habit_actions WHERE board_id = ?", [.text(member)]).first?["policy_json"]?.string))
    h.instant = Double(try XCTUnwrap(policy.bonusClosesAtUtc))
    let secondDB = try IntentDatabase(path: directory.appendingPathComponent("bonus.sqlite").path)
    let second = IntentExecutor(database: secondDB, now: { h.instant }, zone: { "UTC" }, uuid: { h.id() })
    _ = try second.checkIn(IntentCheckInInput(commandId: h.id(), boardId: root)).get()
    let next = try second.checkIn(IntentCheckInInput(commandId: h.id(), boardId: member)).get()
    XCTAssertNotEqual(next.logicalDate, old.logicalDate)
    let nextRows = try h.database.rows("SELECT * FROM check_ins WHERE logical_date = ?", [.text(next.logicalDate)])
    let nextActions = try h.database.rows("SELECT * FROM habit_actions WHERE logical_date = ?", [.text(next.logicalDate)])
    let nextLedger = try IntentCoinStore.entries(scopeKey: "bonus:\(root):\(next.logicalDate)", database: h.database)
    XCTAssertEqual(nextLedger.map(\.delta), [1])
    let command = h.id()
    let removed = try h.executor.removeLatest(commandId: command, boardId: member, logicalDate: candidate.logicalDate,
      expectedCheckInIds: candidate.checkInIds, expectedSnapshot: candidate.snapshot).get()
    XCTAssertEqual(removed.logicalDate, old.logicalDate)
    XCTAssertEqual(try IntentCoinStore.entries(scopeKey: "bonus:\(root):\(old.logicalDate)", database: h.database).map(\.delta), [1])
    XCTAssertEqual(try h.database.rows("SELECT * FROM check_ins WHERE logical_date = ?", [.text(next.logicalDate)]), nextRows)
    XCTAssertEqual(try h.database.rows("SELECT * FROM habit_actions WHERE logical_date = ?", [.text(next.logicalDate)]), nextActions)
    XCTAssertEqual(try IntentCoinStore.entries(scopeKey: "bonus:\(root):\(next.logicalDate)", database: h.database), nextLedger)
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows", "command_receipts"]
    let before = try tables.map { try h.database.rows("SELECT * FROM \($0)") }
    XCTAssertEqual(try h.executor.removeLatest(commandId: command, boardId: member).get(), removed)
    for (index, table) in tables.enumerated() { XCTAssertEqual(try h.database.rows("SELECT * FROM \(table)"), before[index], table) }
  }

  func testPublicCoinWritersCapturePolicyEnforceCapAndSettleTargetedAndDailyRemoval() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET earns_coins = 1, coin_cap_per_day = 2 WHERE id = ?", [.text(board)])
    var created: [IntentCreatedCheckIn] = []
    for _ in 0..<3 {
      let before = harness.counter
      created.append(try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get())
      XCTAssertEqual(harness.counter, before + 3, "one command id, one check id and one action id")
    }
    let awards = try harness.database.rows("SELECT * FROM coin_ledger ORDER BY mutation_stamp, id")
    XCTAssertEqual(awards.count, 2)
    XCTAssertEqual(awards.compactMap { $0["check_in_id"]?.string }, created.prefix(2).map(\.checkInId))
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(2))
    for row in try harness.database.rows("SELECT policy_json FROM habit_actions") {
      let policy = try IntentCoinPolicy.parse(XCTUnwrap(row["policy_json"]?.string))
      XCTAssertTrue(policy.earnsCoins)
      XCTAssertEqual(policy.coinCapPerDay, 2)
      XCTAssertEqual(policy.boardKind, "count")
    }
    let removed = try harness.executor.removeLatest(commandId: harness.id(), boardId: board).get()
    XCTAssertEqual(removed.removedCheckInIds, [created[0].checkInId])
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(1))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger WHERE kind = 'check'").count, 2)
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(board)])
    let clear = try harness.executor.removeLatest(commandId: harness.id(), boardId: board).get()
    XCTAssertEqual(Set(clear.removedCheckInIds), Set(created.dropFirst().map(\.checkInId)))
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(0))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger WHERE kind = 'reversal'").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'ledger_entry'").count, 4)
  }

  func testPublicDailyCoinNoOpAndReceiptReplayPrecedeLaterMalformedPolicy() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1 WHERE id = ?", [.text(board)])
    let command = harness.id()
    let first = try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: board)).get()
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger").count, 1)
    let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows"]
    var saved: [String: [[String: IntentSQLValue]]] = [:]
    for table in tables { saved[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
    try harness.database.run("PRAGMA ignore_check_constraints = ON")
    try harness.database.run("UPDATE boards SET earns_coins = 2 WHERE id = ?", [.text(board)])
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: "missing", note: String(repeating: "x", count: 10_001))).get(), first)
    let duplicate = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    XCTAssertEqual(duplicate.checkInId, first.checkInId)
    XCTAssertFalse(duplicate.created)
    for table in tables { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), saved[table], table) }
  }

  func testPublicCoinRemovalUsesEarnedCloseDespiteCurrentOptOutAndShiftChange() throws {
    for offset in [-1.0, 0, 1] {
      let harness = try harness()
      let board = "00000000-0000-4000-8000-00000000a001"
      try harness.database.run("UPDATE boards SET earns_coins = 1 WHERE id = ?", [.text(board)])
      let created = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
      let source = try XCTUnwrap(harness.database.rows("SELECT policy_json FROM habit_actions").first?["policy_json"]?.string)
      let earnedPolicy = try IntentCoinPolicy.parse(source)
      try harness.database.run("UPDATE boards SET earns_coins = 0, start_of_day_minute = 240 WHERE id = ?", [.text(board)])
      harness.instant = Double(earnedPolicy.checkClosesAtUtc) + offset
      _ = try harness.executor.removeLatest(commandId: harness.id(), boardId: board, logicalDate: created.logicalDate).get()
      XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(offset < 0 ? 0 : 1))
      let removal = try XCTUnwrap(harness.database.rows("SELECT policy_json FROM habit_actions WHERE kind = 'uncheck'").first?["policy_json"]?.string)
      XCTAssertFalse(try IntentCoinPolicy.parse(removal).earnsCoins)
      XCTAssertEqual(try IntentCoinPolicy.parse(removal).checkClosesAtUtc, earnedPolicy.checkClosesAtUtc + 14_400_000)
    }
  }

  func testPublicCoinWriterFailuresRollBackEveryEffectAndRetrySameCommand() throws {
    for removal in [false, true] {
      for outbox in [false, true] {
        let harness = try harness()
        let board = "00000000-0000-4000-8000-00000000a001"
        try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1 WHERE id = ?", [.text(board)])
        if removal { _ = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get() }
        let tables = ["check_ins", "habit_actions", "coin_ledger", "app_settings", "mutation_outbox", "command_receipts", "widget_board_rows"]
        var before: [String: [[String: IntentSQLValue]]] = [:]
        for table in tables { before[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
        let target = outbox ? "mutation_outbox WHEN NEW.entity_type = 'ledger_entry'" : "coin_ledger"
        try harness.database.run("CREATE TRIGGER fail_coins BEFORE INSERT ON \(target) BEGIN SELECT RAISE(ABORT, 'test'); END")
        let command = harness.id()
        func run() -> Bool {
          if removal { return harness.executor.removeLatest(commandId: command, boardId: board).ok }
          return harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: board)).ok
        }
        XCTAssertFalse(run())
        for table in tables { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), before[table], table) }
        try harness.database.run("DROP TRIGGER fail_coins")
        XCTAssertTrue(run())
        XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(removal ? 0 : 1))
      }
    }
  }

  func testSharedPublicCoinWriterReceiptsPoliciesAndLedger() throws {
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/coin-writers.json"))
    let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let schema = try migrations()
    for scenario in try XCTUnwrap(fixture["scenarios"] as? [[String: Any]]) {
      let name = try XCTUnwrap(scenario["name"] as? String)
      let harness = try Harness(seed: XCTUnwrap(fixture["seed"] as? [String: Any]), migrations: schema)
      let kind = try XCTUnwrap(scenario["kind"] as? String)
      try harness.database.run("UPDATE boards SET kind = ?", [.text(kind)])
      for step in try XCTUnwrap(scenario["steps"] as? [[String: Any]]) {
        let command = try XCTUnwrap(step["commandId"] as? String)
        let intent = try XCTUnwrap(step["intent"] as? String)
        let input = try XCTUnwrap(step["input"] as? [String: Any])
        let expected = try XCTUnwrap(step["expectedReceipt"] as? [String: Any])
        harness.generatedIds = try XCTUnwrap(step["generatedIds"] as? [String])
        let actual = try harness.run(intent, input, commandId: command)
        XCTAssertTrue(NSDictionary(dictionary: actual).isEqual(to: expected), name)
        XCTAssertEqual(harness.generatedIds, [], name)
        let stored = try XCTUnwrap(harness.database.rows("SELECT outcome FROM command_receipts WHERE command_id = ?", [.text(command)]).first?["outcome"]?.string)
        XCTAssertTrue(NSDictionary(dictionary: try XCTUnwrap(JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any])).isEqual(to: expected), name)
        let expectedActions = try JSONDecoder().decode([IntentHabitAction].self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(step["expectedActions"])))
        let expectedRows = expectedActions.map { action in
          ["id": IntentSQLValue.text(action.id), "command_id": .string(action.commandId), "board_id": .text(action.boardId),
            "logical_date": .text(action.logicalDate), "check_in_id": .string(action.checkInId), "kind": .text(action.kind),
            "created_at": .integer(action.createdAt), "mutation_stamp": .text(action.mutationStamp), "policy_json": .string(action.policyJson)]
        }
        XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions ORDER BY mutation_stamp, id"), expectedRows, name)
        let ledger = try JSONDecoder().decode([IntentCoinLedgerRow].self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(step["expectedLedger"])))
        let board = try XCTUnwrap(input["boardId"] as? String)
        XCTAssertEqual(try IntentCoinStore.entries(scopeKey: "check:\(board):2026-09-08", database: harness.database), ledger, name)
        XCTAssertEqual(try harness.database.rows("SELECT id FROM check_ins WHERE deleted_at IS NULL ORDER BY id").compactMap { $0["id"]?.string }, step["expectedLiveCheckIds"] as? [String], name)
        XCTAssertEqual(try harness.database.rows("SELECT hlc_counter FROM app_settings").first?["hlc_counter"]?.number, step["expectedHlcCounter"] as? Double, name)
        let tables = ["check_ins", "habit_actions", "coin_ledger", "mutation_outbox", "app_settings", "widget_board_rows", "command_receipts"]
        var saved: [String: [[String: IntentSQLValue]]] = [:]
        for table in tables { saved[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
        let replay = try harness.run(intent, ["boardId": "missing"], commandId: command)
        XCTAssertTrue(NSDictionary(dictionary: replay).isEqual(to: expected), name)
        XCTAssertEqual(harness.generatedIds, [], name)
        for table in tables { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), saved[table], name + table) }
      }
    }
  }

  func testPublicCoinWriterDefersIncompleteProofWithoutPartialSourceWritesThenRetries() throws {
    struct ProofFixture: Decodable {
      struct Scope: Decodable { let boardId: String }
      struct Correction: Decodable { let actions: [IntentHabitAction]; let existingRows: [IntentCoinLedgerRow]; let expectedAppend: [IntentCoinLedgerRow] }
      let scope: Scope; let correction: Correction
    }
    let proof = try JSONDecoder().decode(ProofFixture.self, from: Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/check-coins.json")))
    var seed = try XCTUnwrap(fixture()["seed"] as? [String: Any])
    var board = try XCTUnwrap((seed["boards"] as? [[String: Any]])?.first)
    board["id"] = proof.scope.boardId
    board["earnsCoins"] = true
    seed["boards"] = [board]
    seed["timeZoneId"] = "UTC"
    seed["nowUtcMs"] = 1_788_868_800_000.0
    let harness = try Harness(seed: seed, migrations: migrations())
    let adjustment = try XCTUnwrap(proof.correction.expectedAppend.first)
    try IntentCoinStore.append(adjustment, to: harness.database, enqueueAt: Int64(harness.instant))
    let tables = ["check_ins", "habit_actions", "coin_ledger", "app_settings", "mutation_outbox", "command_receipts", "widget_board_rows"]
    var before: [String: [[String: IntentSQLValue]]] = [:]
    for table in tables { before[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
    let command = harness.id()
    let input = IntentCheckInInput(commandId: command, boardId: proof.scope.boardId)
    XCTAssertEqual(harness.executor.checkIn(input).error, .database)
    for table in tables { XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), before[table], table) }
    try harness.database.transaction(exclusive: true) {
      for action in proof.correction.actions { try action.append(to: harness.database) }
      for row in proof.correction.existingRows { try IntentCoinStore.append(row, to: harness.database, enqueueAt: Int64(harness.instant)) }
    }
    XCTAssertTrue(harness.executor.checkIn(input).ok)
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(1))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, 1)
  }

  func testPublicCoinCaptureRetainsArchivedStructuralRootAndExactMemberDate() throws {
    let harness = try harness()
    let member = "00000000-0000-4000-8000-00000000a001"
    let root = "00000000-0000-4000-8000-00000000a003"
    try harness.database.run("UPDATE boards SET start_of_day_minute = 240, archived_at = 1 WHERE id = ?", [.text(root)])
    try harness.database.run("UPDATE boards SET earns_coins = 1, anchor_kind = 'board', anchor_relation = 'before', anchor_board_id = ? WHERE id = ?", [.text(root), .text(member)])
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: member)).get()
    let json = try XCTUnwrap(harness.database.rows("SELECT policy_json FROM habit_actions WHERE kind = 'check'").first?["policy_json"]?.string)
    let policy = try IntentCoinPolicy.parse(json)
    XCTAssertEqual(policy.rootId, root)
    XCTAssertEqual(policy.requiredBoardIds, [member])
    XCTAssertEqual(policy.bonusClosesAtUtc, policy.checkClosesAtUtc + 14_400_000)
    XCTAssertEqual(try harness.database.rows("SELECT logical_date FROM coin_ledger").first?["logical_date"]?.string, created.logicalDate)
  }

  func testDailyConfirmationRejectsChangedNotesAndRecordGroup() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let first = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    let second = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, note: "saved note")).get()
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(board)])
    let candidate = try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get()
    XCTAssertEqual(Set(candidate.checkInIds), Set([first.checkInId, second.checkInId]))
    XCTAssertEqual(candidate.confirmationText, "Remove all 2 check-ins from morning pages for 2026-08-30? Saved notes will also be removed.")
    try harness.database.run("UPDATE check_ins SET note = 'edited note', mutation_stamp = 'changed' WHERE id = ?", [.text(second.checkInId)])
    let result = harness.executor.removeLatest(commandId: harness.id(), boardId: board,
      expectedCheckInIds: candidate.checkInIds, expectedSnapshot: candidate.snapshot)
    XCTAssertEqual(result.error?.code, "conflict")
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, 2)
    let refreshed = try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get()
    try harness.database.run("UPDATE check_ins SET deleted_at = 1 WHERE id = ?", [.text(second.checkInId)])
    XCTAssertEqual(harness.executor.removeLatest(commandId: harness.id(), boardId: board,
      expectedCheckInIds: refreshed.checkInIds, expectedSnapshot: refreshed.snapshot).error?.code, "conflict")
  }

  func testConfirmationRejectsBoardKindChangeWithTheSameRecord() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).ok)
    let candidate = try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get()
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(board)])
    let before = try harness.database.rows("SELECT * FROM habit_actions")
    XCTAssertEqual(harness.executor.removeLatest(commandId: harness.id(), boardId: board,
      expectedCheckInIds: candidate.checkInIds, expectedSnapshot: candidate.snapshot).error?.code, "conflict")
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions"), before)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, 1)
  }

  func testActionFailureRollsBackDailyRemovalAndCanReplayAfterRetry() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    for _ in 0..<2 { XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).ok) }
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(board)])
    let before = try harness.database.rows("SELECT * FROM check_ins ORDER BY id")
    let clock = try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings")
    let outbox = try harness.database.rows("SELECT * FROM mutation_outbox")
    try harness.database.run("CREATE TRIGGER fail_action BEFORE INSERT ON habit_actions BEGIN SELECT RAISE(ABORT, 'private details'); END")
    let command = harness.id()
    XCTAssertEqual(harness.executor.removeLatest(commandId: command, boardId: board).error, .database)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins ORDER BY id"), before)
    XCTAssertEqual(try harness.database.rows("SELECT hlc_wall_time, hlc_counter FROM app_settings"), clock)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox"), outbox)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts WHERE command_id = ?", [.text(command)]).count, 0)
    try harness.database.run("DROP TRIGGER fail_action")
    let removed = try harness.executor.removeLatest(commandId: command, boardId: board).get()
    XCTAssertEqual(removed.removedCheckInIds.count, 2)
    XCTAssertEqual(try harness.executor.removeLatest(commandId: command, boardId: "missing").get(), removed)
  }

  func testStoredCreateReceiptReplaysBeforeMalformedNewInput() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let command = harness.id()
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: board)).get()
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: command, boardId: "missing",
      logicalDate: "invalid", note: String(repeating: "x", count: 10_001), source: "invalid")).get(), created)
    let legacyCommand = harness.id()
    let legacy = "{\"ok\":true,\"value\":{\"checkInId\":\"\(created.checkInId)\",\"logicalDate\":\"\(created.logicalDate)\"}}"
    try harness.database.run("INSERT INTO command_receipts VALUES (?, ?, 0)", [.text(legacyCommand), .text(legacy)])
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: legacyCommand, boardId: "missing")).get().created, true)
  }

  func testLegacyCountRemovalPreservesExplicitSurvivingSourcesBeforeTargetedUncheck() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let date = "1969-12-31"
    let first = try harness.legacyCheck(boardId: board, date: date)
    let second = try harness.legacyCheck(boardId: board, date: date)
    let removed = try harness.executor.removeLatest(commandId: harness.id(), boardId: board, logicalDate: date).get()
    XCTAssertEqual(removed.removedCheckInIds, [first])
    XCTAssertEqual(try harness.database.rows("SELECT id FROM check_ins WHERE deleted_at IS NULL").first?["id"]?.string, second)
    let baselines = try harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline' ORDER BY check_in_id")
    XCTAssertEqual(baselines.count, 2)
    for row in baselines {
      XCTAssertEqual(row["created_at"]?.number, 0)
      XCTAssertEqual(row["mutation_stamp"]?.string, IntentHabitAction.baselineStamp)
      XCTAssertEqual(row["command_id"], .null)
      XCTAssertEqual(try harness.database.rows("SELECT created_at FROM mutation_outbox WHERE entity_type = 'habit_action' AND entity_id = ?", [.text(try XCTUnwrap(row["id"]?.string))]).first?["created_at"], .integer(Int64(harness.instant)))
    }
    XCTAssertEqual(try harness.database.rows("SELECT check_in_id FROM habit_actions WHERE kind = 'uncheck'").first?["check_in_id"]?.string, first)
    let baseline = try IntentHabitAction.baseline(checkInId: second, boardId: board, date: date)
    XCTAssertFalse(try baseline.append(to: harness.database))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'habit_action'").count, 3)
  }

  func testLegacyDailyNoOpPreservesHistoryWithoutCreatingEvidence() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let first = try harness.legacyCheck(boardId: board, date: "2026-08-30")
    _ = try harness.legacyCheck(boardId: board, date: "2026-08-30")
    try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1 WHERE id = ?", [.text(board)])
    let before = try harness.database.rows("SELECT * FROM check_ins ORDER BY id")
    let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    XCTAssertEqual(result.checkInId, first)
    XCTAssertFalse(result.created)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins ORDER BY id"), before)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT hlc_wall_time FROM app_settings").first?["hlc_wall_time"]?.number, 0)
  }

  func testImmutableActionsRejectInvalidOrConflictingPayloadWithoutOutboxWrites() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let baseline = try IntentHabitAction.baseline(checkInId: harness.id(), boardId: board, date: "2026-08-30")
    XCTAssertTrue(try baseline.append(to: harness.database))
    XCTAssertFalse(try baseline.append(to: harness.database))
    let conflict = IntentHabitAction(id: baseline.id, commandId: nil, boardId: board, logicalDate: "2026-08-29",
      checkInId: baseline.checkInId, kind: "baseline", createdAt: 0, mutationStamp: IntentHabitAction.baselineStamp, policyJson: nil)
    XCTAssertThrowsError(try conflict.append(to: harness.database))
    let invalid = IntentHabitAction(id: "invalid", commandId: harness.id(), boardId: board, logicalDate: "2026-08-30",
      checkInId: baseline.checkInId, kind: "check", createdAt: 1, mutationStamp: "00000000000001-00000-device", policyJson: nil)
    XCTAssertThrowsError(try invalid.append(to: harness.database))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 1)
    XCTAssertThrowsError(try harness.database.run("UPDATE habit_actions SET logical_date = '2026-08-29'"))
    XCTAssertThrowsError(try harness.database.run("DELETE FROM habit_actions"))
  }

  func testSharedFixtureVerbatim() throws {
    let source = try fixture()
    XCTAssertEqual(source["contractVersion"] as? Int, 1)
    let schema = try migrations()
    for entry in source["cases"] as! [[String: Any]] {
      let name = entry["name"] as! String
      let harness = try Harness(seed: source["seed"] as! [String: Any], migrations: schema)
      for step in entry["given"] as? [[String: Any]] ?? [] {
        XCTAssertEqual(try harness.run(step["intent"] as! String, step["input"] as! [String: Any])["ok"] as? Bool, true, name)
      }
      let intent = entry["intent"] as! String, input = entry["input"] as! [String: Any]
      let expected = entry["expect"] as! [String: Any]
      let commandId = harness.id()
      let result = try harness.run(intent, input, commandId: commandId)
      if input["replayCommandId"] as? Bool == true {
        XCTAssertTrue(NSDictionary(dictionary: result).isEqual(to: try harness.run(intent, input, commandId: commandId)), name)
      }
      XCTAssertEqual(result["ok"] as? Bool, expected["ok"] as? Bool, name)
      if expected["ok"] as? Bool == false {
        XCTAssertEqual((result["error"] as? [String: Any])?["code"] as? String, expected["code"] as? String, name)
        continue
      }
      if intent == "listBoards" {
        let boards = try XCTUnwrap(result["value"] as? [[String: Any]], name)
        XCTAssertEqual(boards.map { $0["title"] as? String }, expected["boards"] as! [String], name)
        continue
      }
      let value = try XCTUnwrap(result["value"] as? [String: Any], name)
      if let date = expected["logicalDate"] as? String { XCTAssertEqual(value["logicalDate"] as? String, date, name) }
      if let amount = expected["amount"] as? Double {
        XCTAssertEqual(try harness.database.rows("SELECT amount FROM check_ins WHERE id = ?", [.text(value["checkInId"] as! String)]).first?["amount"]?.number, amount, name)
      }
      if let boards = expected["boards"] as? [[String: Any]] {
        XCTAssertTrue(NSArray(array: value["boards"] as! [[String: Any]]).isEqual(to: boards), name)
      }
      if let total = expected["total"] as? Int { XCTAssertEqual(value["total"] as? Int, total, name) }
      if let count = expected["recordedCount"] as? Int {
        XCTAssertEqual(try harness.database.rows("SELECT COUNT(*) AS count FROM check_ins WHERE deleted_at IS NULL").first?["count"]?.number, Double(count), name)
      }
      if let remaining = expected["remainingToday"] as? Int {
        XCTAssertEqual(try harness.executor.today(boardId: input["boardId"] as? String).get().total, remaining, name)
      }
      if expected["excludesNoteText"] as? Bool == true {
        XCTAssertFalse(String(describing: result).contains("private thought"), name)
        XCTAssertFalse(String(describing: result).contains("note"), name)
      }
    }
  }

  func testSharedExactReceiptScenarios() throws {
    let source = try fixture()
    let schema = try migrations()
    let scenarios = try XCTUnwrap(source["scenarios"] as? [[String: Any]])
    XCTAssertFalse(scenarios.isEmpty)
    for scenario in scenarios {
      let name = try XCTUnwrap(scenario["name"] as? String)
      let harness = try Harness(seed: XCTUnwrap(scenario["seed"] as? [String: Any]), migrations: schema)
      let steps = try XCTUnwrap(scenario["steps"] as? [[String: Any]])
      for (index, step) in steps.enumerated() {
        let context = "\(name), step \(index + 1)"
        if let instant = step["nowUtcMs"] as? Double { harness.instant = instant }
        if let zone = step["timeZoneId"] as? String { harness.timeZone = zone }
        harness.generatedIds = try XCTUnwrap(step["generatedIds"] as? [String], context)
        let intent = try XCTUnwrap(step["intent"] as? String, context)
        let input = try XCTUnwrap(step["input"] as? [String: Any], context)
        let expected = try XCTUnwrap(step["expectResult"] as? [String: Any], context)
        let tables = ["check_ins", "habit_actions", "boards", "app_settings", "mutation_outbox"]
        var before: [String: [[String: IntentSQLValue]]] = [:]
        if step["expectUnchangedEvidence"] as? Bool == true {
          for table in tables { before[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
        }
        let receiptsBefore = try harness.database.rows("SELECT * FROM command_receipts ORDER BY rowid")
        let commandId = step["commandId"] as? String
        if intent == "checkIn" || intent == "removeLatest" { XCTAssertNotNil(commandId, context) }
        // reads do not consume an invocation or executor uuid.
        let result = try harness.run(intent, input, commandId: commandId ?? "00000000-0000-4000-8000-000000000000")
        XCTAssertEqual(harness.generatedIds, [], context)
        if expected["ok"] as? Bool == true {
          XCTAssertTrue(NSDictionary(dictionary: result).isEqual(to: expected), context)
        } else {
          XCTAssertEqual(result["ok"] as? Bool, false, context)
          XCTAssertEqual((result["error"] as? [String: Any])?["code"] as? String,
                         (expected["error"] as? [String: Any])?["code"] as? String, context)
        }
        if let commandId {
          let storedText = try XCTUnwrap(harness.database.rows("SELECT outcome FROM command_receipts WHERE command_id = ?",
            [.text(commandId)]).first?["outcome"]?.string, context)
          let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(storedText.utf8)) as? [String: Any], context)
          XCTAssertTrue(NSDictionary(dictionary: stored).isEqual(to: result), context)
          if let expectedReceipt = step["expectStoredReceipt"] as? [String: Any] {
            XCTAssertTrue(NSDictionary(dictionary: stored).isEqual(to: expectedReceipt), context)
          }
        } else {
          XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts ORDER BY rowid"), receiptsBefore, context)
        }
        if let ids = step["expectLiveCheckIds"] as? [String] {
          let live = try harness.database.rows("SELECT id FROM check_ins WHERE deleted_at IS NULL ORDER BY id").compactMap { $0["id"]?.string }
          XCTAssertEqual(live, ids.sorted(), context)
        }
        if step["expectPureCreatedCheck"] as? Bool == true {
          let value = try XCTUnwrap(result["value"] as? [String: Any], context)
          let id = try XCTUnwrap(value["checkInId"] as? String, context)
          let row = try XCTUnwrap(harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(id)]).first, context)
          for field in ["amount", "occurred_at_utc", "time_zone_id", "offset_minutes"] { XCTAssertEqual(row[field], .null, context) }
          XCTAssertEqual(row["source"]?.string, "shortcut", context)
        }
        for (table, rows) in before {
          XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), rows, context)
        }
      }
    }
  }

  func testSharedDailyAutomationCases() throws {
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/habit-actions.json"))
    let source = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let cases = try XCTUnwrap(source["automationCases"] as? [[String: Any]])
    for entry in cases {
      let name = entry["name"] as! String
      let harness = try harness()
      let board = "00000000-0000-4000-8000-00000000a002"
      try harness.database.run("UPDATE boards SET kind = 'daily', tracks_time = 1 WHERE id = ?", [.text(board)])
      let date = try IntentCalendar.logicalDate(utcMs: harness.instant, zone: harness.timeZone, startMinute: 0)
      for _ in 0..<(entry["legacyCheckCount"] as! Int) { _ = try harness.legacyCheck(boardId: board, date: date) }
      let admittedBaselines = try harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline' ORDER BY id")
      XCTAssertEqual(admittedBaselines.count, entry["legacyCheckCount"] as? Int, name)
      var created: [Bool] = []
      for _ in 0..<(entry["checkAttempts"] as! Int) {
        let result = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board,
          occurredAtUtc: harness.instant - 86_400_000, amount: 7.25)).get()
        created.append(result.created)
        if result.created {
          let row = try XCTUnwrap(harness.database.rows("SELECT amount, occurred_at_utc FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first)
          XCTAssertEqual(row["amount"], .null, name)
          XCTAssertEqual(row["occurred_at_utc"], .null, name)
        }
      }
      if entry["removeLatest"] as! Bool { _ = try harness.executor.removeLatest(commandId: harness.id(), boardId: board).get() }
      XCTAssertEqual(created, entry["expectedCreated"] as! [Bool], name)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, entry["expectedLiveCount"] as! Int, name)
      XCTAssertEqual(try harness.executor.today(boardId: board).get().total, entry["expectedTodayCount"] as! Int, name)
      let kinds = try harness.database.rows("SELECT kind FROM habit_actions WHERE kind != 'baseline' ORDER BY kind").compactMap { $0["kind"]?.string }
      XCTAssertEqual(kinds, (entry["expectedActionKinds"] as! [String]).filter { $0 != "baseline" }.sorted(), name)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline' ORDER BY id"), admittedBaselines, name)
    }
  }

  func testNativeSchemaGateMatchesAuthoritativeMigrations() throws {
    let source = try migrations()
    let checksums = Dictionary(uniqueKeysWithValues: source.map { ($0["version"] as! Int, $0["checksum"] as! String) })
    XCTAssertEqual(IntentExecutor.migrationChecksums, checksums)
  }

  func testAppIntentFailuresExposeTheirSanitizedLocalizedMessages() throws {
    let failures = [IntentFailure.unavailable, .database, .migration, .notFound, .archived, .noCheckIn,
      IntentFailure(code: "validation", message: "Choose a valid date.", field: "logicalDate")]
    for failure in failures {
      let error: any Error = failure
      let localized = try XCTUnwrap(error as? any CustomLocalizedStringResourceConvertible)
      XCTAssertEqual(String(localized: localized.localizedStringResource), failure.message)
    }
  }

  func testEntityResolutionOmitsMissingArchivedAndDeletedBoardsInActiveOrder() throws {
    let harness = try harness()
    let first = "00000000-0000-4000-8000-00000000a001"
    let second = "00000000-0000-4000-8000-00000000a002"
    let archived = "00000000-0000-4000-8000-00000000a003"
    let missing = "00000000-0000-4000-8000-00000000a099"
    let resolved = try harness.executor.listBoards(identifiers: [second, missing, archived, first, second]).get()
    XCTAssertEqual(resolved.map(\.boardId), [first, second])
    XCTAssertEqual(try harness.executor.listBoards(identifiers: []).get(), [])
    XCTAssertEqual(try harness.executor.listBoards(identifiers: [missing, archived]).get(), [])
    try harness.database.run("UPDATE boards SET deleted_at = 1 WHERE id = ?", [.text(second)])
    XCTAssertEqual(try harness.executor.listBoards(identifiers: [second]).get(), [])
    XCTAssertEqual(try harness.database.rows("SELECT COUNT(*) AS count FROM command_receipts").first?["count"]?.number, 0)
    XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: archived)).error, .archived)
    XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: second)).error, .notFound)
    XCTAssertEqual(try harness.database.rows("SELECT COUNT(*) AS count FROM check_ins").first?["count"]?.number, 0)
    XCTAssertEqual(try harness.database.rows("SELECT COUNT(*) AS count FROM mutation_outbox").first?["count"]?.number, 0)
  }

  func testReplaysTypeScriptFailureReceiptWithOptionalRetryableOmitted() throws {
    let harness = try harness()
    let commandId = harness.id()
    let receipt = #"{"ok":false,"error":{"code":"validation","message":"Amount must be positive.","field":"amount"}}"#
    try harness.database.run("INSERT INTO command_receipts VALUES (?, ?, 0)", [.text(commandId), .text(receipt)])
    let result = harness.executor.checkIn(IntentCheckInInput(commandId: commandId, boardId: "00000000-0000-4000-8000-00000000a001"))
    XCTAssertEqual(result.error, IntentFailure(code: "validation", message: "Amount must be positive.", field: "amount"))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 0)
  }

  func testWrapperReplayPrecedesEntityResolutionAndRemovalConfirmation() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let createId = harness.id()
    XCTAssertNil(try harness.executor.replay(commandId: createId, as: IntentCreatedCheckIn.self))
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: createId, boardId: board)).get()
    let removeId = harness.id()
    let removed = try harness.executor.removeLatest(commandId: removeId, boardId: board).get()
    XCTAssertEqual(harness.executor.removalCandidate(boardId: board, logicalDate: nil).error, .noCheckIn)
    XCTAssertEqual(try harness.executor.replay(commandId: removeId, as: IntentRemovedCheckIn.self)?.get(), removed)
    try harness.database.run("UPDATE boards SET archived_at = 1 WHERE id = ?", [.text(board)])
    XCTAssertThrowsError(try harness.executor.activeBoard(id: board))
    XCTAssertEqual(try harness.executor.replay(commandId: createId, as: IntentCreatedCheckIn.self)?.get(), created)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'check_in'").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'habit_action'").count, 2)
  }

  func testMutationTransactionUpdatesReceiptClockOutboxAndProjection() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let id = harness.id()
    let result = try harness.executor.checkIn(IntentCheckInInput(commandId: id, boardId: board, note: "  thought  ")).get()
    let row = try XCTUnwrap(harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(result.checkInId)]).first)
    XCTAssertEqual(row["note"]?.string, "thought")
    XCTAssertEqual(row["idempotency_key"]?.string, id)
    XCTAssertEqual(row["mutation_stamp"]?.string, "01788105600000-00000-00000000-0000-4000-8000-00000000d001")
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'check_in'").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'habit_action'").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT strip FROM widget_board_rows WHERE board_id = ?", [.text(board)]).first?["strip"]?.string, "[0,0,0,0,0,0,1]")
    harness.instant += 86_400_000
    XCTAssertEqual(try harness.executor.checkIn(IntentCheckInInput(commandId: id, boardId: board)).get(), result)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 2)
  }

  func testCountCommandRetainsDailyKindInWidgetStorageAndTimeline() throws {
    let harness = try harness()
    let count = "00000000-0000-4000-8000-00000000a001"
    let daily = "00000000-0000-4000-8000-00000000a002"
    try harness.database.run("UPDATE boards SET kind = 'daily', tracks_amount = 0, tracks_time = 0 WHERE id = ?", [.text(daily)])
    for _ in 0..<2 { _ = try harness.legacyCheck(boardId: daily, date: "2026-08-30") }
    XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: count)).ok)
    XCTAssertEqual(try harness.database.rows("SELECT kind FROM widget_board_rows WHERE board_id = ?", [.text(daily)]).first?["kind"]?.string, "daily")
    XCTAssertEqual(try harness.database.rows("SELECT strip FROM widget_board_rows WHERE board_id = ?", [.text(daily)]).first?["strip"]?.string, "[0,0,0,0,0,0,1]")
    let timeline = try harness.executor.widgetTimeline().get()
    let rows = try JSONSerialization.jsonObject(with: JSONEncoder().encode(timeline.entries[0].props.rows)) as! [[String: Any]]
    XCTAssertEqual(rows.first { $0["boardId"] as? String == count }?["kind"] as? String, "count")
    XCTAssertEqual(rows.first { $0["boardId"] as? String == daily }?["kind"] as? String, "daily")
  }

  func testStorageFailureRollsBackEveryMutationAndCanRetrySameCommand() throws {
    let harness = try harness()
    try harness.database.run("CREATE TRIGGER fail_outbox BEFORE INSERT ON mutation_outbox BEGIN SELECT RAISE(ABORT, 'private database details'); END")
    let input = IntentCheckInInput(commandId: harness.id(), boardId: "00000000-0000-4000-8000-00000000a001")
    let result = harness.executor.checkIn(input)
    XCTAssertEqual(result.error, .database)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT hlc_wall_time FROM app_settings").first?["hlc_wall_time"]?.number, 0)
    XCTAssertEqual(try harness.database.rows("SELECT strip FROM widget_board_rows").first?["strip"]?.string, "[0,0,0,0,0,0,0]")
    try harness.database.run("DROP TRIGGER fail_outbox")
    XCTAssertTrue(harness.executor.checkIn(input).ok)
  }

  func testAmountNoteAndDateValidationNeverInsertPartialRows() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a002"
    for amount in [0, -1, Double.nan, Double.infinity, 1_000_000_001, 1.0001] {
      XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, amount: amount)).error?.code, "validation")
    }
    for date in ["2026-02-30", "2026-13-01", "2026-9-01", "2027-01-01"] {
      XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, logicalDate: date)).error?.code, "validation")
    }
    let family = "e\u{0301}"
    XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, note: String(repeating: family, count: 5001))).error?.field, "note")
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins").count, 0)
    XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, amount: 1.125)).ok)
  }

  func testShiftedDateAndDSTOffsetAreStoredAtTheEventInstant() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET tracks_time = 1, start_of_day_minute = 240 WHERE id = ?", [.text(board)])
    let instant = ISO8601DateFormatter().date(from: "2026-03-08T07:30:00Z")!.timeIntervalSince1970 * 1000
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, occurredAtUtc: instant)).get()
    XCTAssertEqual(created.logicalDate, "2026-03-07")
    let row = try XCTUnwrap(harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(created.checkInId)]).first)
    XCTAssertEqual(row["offset_minutes"]?.number, -240)
    XCTAssertEqual(row["time_zone_id"]?.string, "America/New_York")
    XCTAssertEqual(row["occurred_at_utc"]?.number, instant)
  }

  func testRemovalConfirmsCandidateAndUsesHistoryOrderThenReplaysReceipt() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let first = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    let candidate = try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get()
    harness.instant += 1000
    let newest = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    XCTAssertEqual(harness.executor.removeLatest(commandId: harness.id(), boardId: board, expectedCheckInId: candidate.checkInId).error?.code, "conflict")
    let commandId = harness.id()
    let removed = try harness.executor.removeLatest(commandId: commandId, boardId: board, expectedCheckInId: newest.checkInId).get()
    XCTAssertEqual(removed.removedCheckInId, newest.checkInId)
    XCTAssertEqual(try harness.executor.removeLatest(commandId: commandId, boardId: board).get(), removed)
    XCTAssertEqual(try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get().checkInId, first.checkInId)
  }

  func testUnknownSchemaAndChecksumRefuseMutationWithoutResettingTheStore() throws {
    let harness = try harness()
    try harness.database.run("PRAGMA user_version = 99")
    XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: "00000000-0000-4000-8000-00000000a001")).error, .migration)
    try harness.database.run("PRAGMA user_version = \(IntentExecutor.schemaVersion)")
    try harness.database.run("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1")
    XCTAssertEqual(harness.executor.listBoards().error, .migration)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM boards").count, 3)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins").count, 0)
  }

  func testWidgetTimelineUsesCommittedProjectionAndExpoSerializationShape() throws {
    let harness = try harness()
    XCTAssertTrue(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: "00000000-0000-4000-8000-00000000a001", note: "private text")).ok)
    let timeline = try harness.executor.widgetTimeline().get()
    XCTAssertEqual(timeline.entries.count, 2)
    XCTAssertEqual(timeline.entries[0].props.rows[0].strip, [0, 0, 0, 0, 0, 0, 1])
    XCTAssertFalse(timeline.entries[0].props.stale)
    XCTAssertTrue(timeline.entries[1].props.stale)
    XCTAssertGreaterThan(timeline.entries[1].timestamp, timeline.entries[0].timestamp)
    let data = try JSONEncoder().encode(timeline.entries)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertEqual(Set(json[0].keys), ["timestamp", "props"])
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private text"))
  }

  func testWidgetPublicationRefreshesConvertedHistoryWithoutMutationEvidence() throws {
    let harness = try harness()
    let daily = "00000000-0000-4000-8000-00000000a001"
    let count = "00000000-0000-4000-8000-00000000a002"
    for board in [daily, count] {
      for _ in 0..<2 { _ = try harness.legacyCheck(boardId: board, date: "2026-08-30") }
    }
    try harness.database.run("UPDATE boards SET kind = 'daily' WHERE id = ?", [.text(daily)])
    try harness.database.run("UPDATE widget_board_rows SET strip = '[0,0,0,0,0,0,99]', strip_end_date = '2026-08-29'")
    let protectedTables = ["boards", "check_ins", "app_settings", "habit_actions", "command_receipts", "mutation_outbox"]
    let before = try protectedTables.map { try harness.database.rows("SELECT * FROM \($0)") }

    let timeline = try harness.executor.widgetTimeline().get()
    let rows = timeline.entries[0].props.rows
    XCTAssertEqual(rows.map(\.boardId), [daily, count])
    XCTAssertEqual(rows[0].kind, .daily)
    XCTAssertEqual(rows[0].strip, [0, 0, 0, 0, 0, 0, 1])
    XCTAssertEqual(rows[1].strip, [0, 0, 0, 0, 0, 0, 2])
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(rows)) as? [[String: Any]])
    XCTAssertEqual(encoded.map { $0["checkedToday"] as? Bool }, [true, true])
    XCTAssertEqual(try harness.database.rows("SELECT strip FROM widget_board_rows WHERE board_id = ?", [.text(daily)]).first?["strip"]?.string, "[0,0,0,0,0,0,1]")
    XCTAssertEqual(try protectedTables.map { try harness.database.rows("SELECT * FROM \($0)") }, before)

    harness.instant += 86_400_000
    let nextDay = try harness.executor.widgetTimeline().get()
    XCTAssertEqual(nextDay.entries[0].props.rows[0].strip, [0, 0, 0, 0, 0, 1, 0])
    XCTAssertEqual(nextDay.entries[0].props.rows[1].strip, [0, 0, 0, 0, 0, 2, 0])
    XCTAssertEqual(try harness.database.rows("SELECT DISTINCT strip_end_date FROM widget_board_rows").first?["strip_end_date"]?.string, "2026-08-31")
    XCTAssertEqual(try protectedTables.map { try harness.database.rows("SELECT * FROM \($0)") }, before)
  }

  func testWidgetPublicationRollsBackCacheFailureAndRespectsSchemaGate() throws {
    let harness = try harness()
    let before = try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position")
    try harness.database.run("CREATE TRIGGER fail_widget_cache BEFORE INSERT ON widget_board_rows BEGIN SELECT RAISE(ABORT, 'cache failed'); END")
    XCTAssertEqual(harness.executor.widgetTimeline().error, .database)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position"), before)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 0)
    try harness.database.run("DROP TRIGGER fail_widget_cache")
    try harness.database.run("PRAGMA user_version = 99")
    XCTAssertEqual(harness.executor.widgetTimeline().error, .migration)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position"), before)
  }

  func testWidgetPublicationMatchesSharedRefreshDeadlines() throws {
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/widget-refresh.json"))
    let cases = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["boundaryCases"] as? [[String: Any]])
    let source = try fixture(), allMigrations = try migrations()
    for item in cases {
      let name = try XCTUnwrap(item["name"] as? String)
      let generated = try XCTUnwrap(item["nowUtcMs"] as? NSNumber)
      let expires = try XCTUnwrap(item["expectedExpiresAtUtc"] as? NSNumber)
      var seed = try XCTUnwrap(source["seed"] as? [String: Any])
      let template = try XCTUnwrap((seed["boards"] as? [[String: Any]])?.first)
      seed["nowUtcMs"] = generated.doubleValue
      seed["timeZoneId"] = try XCTUnwrap(item["timeZoneId"] as? String)
      seed["boards"] = try XCTUnwrap(item["startMinutes"] as? [Int]).enumerated().map { index, minute in
        var board = template
        board["id"] = String(format: "00000000-0000-4000-8000-%012d", 7000 + index)
        board["startOfDayMinute"] = minute
        board["archived"] = false
        return board
      }
      let harness = try Harness(seed: seed, migrations: allMigrations)
      let timeline = try harness.executor.widgetTimeline().get()
      XCTAssertEqual(timeline.entries[0].timestamp, generated.int64Value, name)
      XCTAssertEqual(timeline.entries[1].timestamp, expires.int64Value, name)
      XCTAssertFalse(timeline.entries[0].props.stale, name)
      XCTAssertTrue(timeline.entries[1].props.stale, name)
    }
  }

  func testWidgetRowMatchesSharedPropsForLegacyDuplicateStrips() throws {
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/widget-refresh.json"))
    let cases = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["propsCases"] as? [[String: Any]])
    for item in cases {
      let name = try XCTUnwrap(item["name"] as? String)
      let row = try XCTUnwrap(item["row"] as? [String: Any])
      let kind = try XCTUnwrap(IntentBoardKind(rawValue: XCTUnwrap(row["kind"] as? String)))
      let value = try IntentWidgetRow(boardId: XCTUnwrap(row["boardId"] as? String),
        kind: kind, title: XCTUnwrap(row["title"] as? String), symbol: XCTUnwrap(row["symbol"] as? String),
        accentHex: XCTUnwrap(row["accentHex"] as? String), strip: XCTUnwrap(row["strip"] as? [Int]))
      let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary)
      XCTAssertEqual(actual, try XCTUnwrap(item["expected"] as? NSDictionary), name)
    }
  }

  func testWidgetRefreshTracksRepeatedHourBackwardAndForwardWithoutLosingHistory() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET kind = 'daily', start_of_day_minute = 90 WHERE id = ?", [.text(board)])
    _ = try harness.legacyCheck(boardId: board, date: "2026-11-01")
    let history = try harness.database.rows("SELECT * FROM check_ins")
    let cases: [(String, String, Bool, String)] = [
      ("2026-11-01T05:45:00Z", "2026-11-01", true, "2026-11-01T06:00:00Z"),
      ("2026-11-01T06:00:00Z", "2026-10-31", false, "2026-11-01T06:30:00Z"),
      ("2026-11-01T06:30:00Z", "2026-11-01", true, "2026-11-02T05:00:00Z"),
    ]
    let formatter = ISO8601DateFormatter()
    for (instant, date, checked, expires) in cases {
      harness.instant = try XCTUnwrap(formatter.date(from: instant)).timeIntervalSince1970 * 1000
      let timeline = try harness.executor.widgetTimeline().get()
      let row = try XCTUnwrap(timeline.entries[0].props.rows.first { $0.boardId == board })
      XCTAssertEqual(row.checkedToday, checked, instant)
      XCTAssertEqual(row.strip, [0, 0, 0, 0, 0, 0, checked ? 1 : 0], instant)
      XCTAssertEqual(timeline.entries[1].timestamp, Int64(try XCTUnwrap(formatter.date(from: expires)).timeIntervalSince1970 * 1000), instant)
      XCTAssertEqual(try harness.database.rows("SELECT strip_end_date FROM widget_board_rows WHERE board_id = ?", [.text(board)]).first?["strip_end_date"]?.string, date)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins"), history)
    }
  }

  func testWidgetRefreshCapturesClockAndZoneOnceAndRemovesInactiveCacheRows() throws {
    let harness = try harness()
    var clockReads = 0, zoneReads = 0
    let executor = IntentExecutor(database: harness.database, now: {
      clockReads += 1
      return harness.instant + Double(clockReads - 1) * 86_400_000
    }, zone: {
      zoneReads += 1
      return zoneReads == 1 ? "America/New_York" : "UTC"
    })
    let timeline = try executor.widgetTimeline().get()
    XCTAssertEqual(clockReads, 1)
    XCTAssertEqual(zoneReads, 1)
    XCTAssertEqual(timeline.entries[0].timestamp, Int64(harness.instant))
    XCTAssertEqual(timeline.entries[1].timestamp, 1788148800000)
    XCTAssertEqual(try harness.database.rows("SELECT DISTINCT strip_end_date FROM widget_board_rows").first?["strip_end_date"]?.string, "2026-08-30")

    try harness.database.run("UPDATE boards SET archived_at = 1 WHERE order_key = '0'")
    try harness.database.run("UPDATE boards SET deleted_at = 1 WHERE order_key = '1'")
    let inactive = try harness.executor.widgetTimeline().get()
    XCTAssertEqual(inactive.entries[0].props.rows, [])
    XCTAssertEqual(inactive.entries[1].timestamp, 1788148800000)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM widget_board_rows"), [])
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox"), [])
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts"), [])
  }

  func testWidgetPublicationRejectsInvalidClockAndZoneWithoutChangingCache() throws {
    let harness = try harness()
    let before = try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position")
    for instant in [Double.nan, Double.infinity, Double(Int64.max)] {
      let executor = IntentExecutor(database: harness.database, now: { instant }, zone: { harness.timeZone })
      XCTAssertEqual(executor.widgetTimeline().error, .database)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position"), before)
    }
    harness.timeZone = "invalid/timezone"
    XCTAssertEqual(harness.executor.widgetTimeline().error, .database)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM widget_board_rows ORDER BY position"), before)
  }

  func testSecondSQLiteConnectionReplaysTheSameReceiptWithoutDuplicatingOutbox() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".db")
    defer { try? FileManager.default.removeItem(at: url) }
    let source = try fixture()
    let harness = try Harness(seed: source["seed"] as! [String: Any], migrations: migrations(), path: url.path)
    let second = IntentExecutor(database: try IntentDatabase(path: url.path), now: { harness.instant + 86_400_000 }, zone: { harness.timeZone })
    let input = IntentCheckInInput(commandId: harness.id(), boardId: "00000000-0000-4000-8000-00000000a001")
    let first = try harness.executor.checkIn(input).get()
    XCTAssertEqual(try second.checkIn(input).get(), first)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins").count, 1)
  }

  func testConcurrentDailyCommandsOnSeparateConnectionsCreateOneCompletion() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".db")
    defer { try? FileManager.default.removeItem(at: url) }
    let source = try fixture()
    let harness = try Harness(seed: source["seed"] as! [String: Any], migrations: migrations(), path: url.path)
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1 WHERE id = ?", [.text(board)])
    let lock = NSLock()
    var outcomes: [IntentOutcome<IntentCreatedCheckIn>] = []
    DispatchQueue.concurrentPerform(iterations: 2) { index in
      let outcome: IntentOutcome<IntentCreatedCheckIn>
      do {
        let executor = IntentExecutor(database: try IntentDatabase(path: url.path), now: { harness.instant }, zone: { harness.timeZone })
        let command = String(format: "00000000-0000-4000-8000-%012d", 9000 + index)
        outcome = executor.checkIn(IntentCheckInInput(commandId: command, boardId: board))
      } catch { outcome = .failure(.database) }
      lock.lock()
      outcomes.append(outcome)
      lock.unlock()
    }
    let values = try outcomes.map { try $0.get() }
    XCTAssertEqual(values.filter(\.created).count, 1)
    XCTAssertEqual(Set(values.map(\.checkInId)).count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE deleted_at IS NULL").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 1)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM command_receipts").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 3)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger WHERE kind = 'check'").count, 1)
  }

  func testDailyConfirmationAcrossShiftPreservesNewDateFromAnotherConnectionAndReplaysExactly() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".db")
    defer { try? FileManager.default.removeItem(at: url) }
    let source = try fixture()
    let harness = try Harness(seed: XCTUnwrap(source["seed"] as? [String: Any]), migrations: migrations(), path: url.path)
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET kind = 'daily', earns_coins = 1, start_of_day_minute = 240 WHERE id = ?", [.text(board)])
    harness.instant = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-08-31T07:59:00Z")).timeIntervalSince1970 * 1000
    let original = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, note: "selected before four am")).get()
    let candidate = try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get()
    XCTAssertEqual(candidate.logicalDate, "2026-08-30")
    XCTAssertTrue(candidate.hasNotes)
    XCTAssertEqual(candidate.checkInIds, [original.checkInId])

    harness.instant += 60_000
    let second = IntentExecutor(database: try IntentDatabase(path: url.path), now: { harness.instant },
      zone: { harness.timeZone }, uuid: { harness.id() })
    let newer = try second.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board, note: "new day from another connection")).get()
    XCTAssertEqual(newer.logicalDate, "2026-08-31")
    let newRows = try harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(newer.checkInId)])
    let newActions = try harness.database.rows("SELECT * FROM habit_actions WHERE check_in_id = ? ORDER BY id", [.text(newer.checkInId)])

    let command = harness.id()
    let removed = try harness.executor.removeLatest(commandId: command, boardId: board,
      logicalDate: candidate.logicalDate, expectedCheckInId: candidate.checkInId,
      expectedCheckInIds: candidate.checkInIds, expectedSnapshot: candidate.snapshot).get()
    XCTAssertEqual(removed, IntentRemovedCheckIn(removedCheckInId: original.checkInId,
      logicalDate: "2026-08-30", removedCheckInIds: [original.checkInId]))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM check_ins WHERE id = ?", [.text(newer.checkInId)]), newRows)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions WHERE check_in_id = ? ORDER BY id", [.text(newer.checkInId)]), newActions)
    XCTAssertEqual(try harness.database.rows("SELECT id FROM check_ins WHERE deleted_at IS NULL").compactMap { $0["id"]?.string }, [newer.checkInId])
    XCTAssertEqual(try second.today(boardId: board).get().total, 1)
    let clear = try XCTUnwrap(harness.database.rows("SELECT logical_date, check_in_id FROM habit_actions WHERE command_id = ?", [.text(command)]).first)
    XCTAssertEqual(clear["logical_date"]?.string, candidate.logicalDate)
    XCTAssertEqual(clear["check_in_id"], .null)

    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger WHERE kind = 'reversal'").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger WHERE kind = 'check'").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT SUM(delta) AS balance FROM coin_ledger").first?["balance"], .integer(2))
    let tables = ["check_ins", "habit_actions", "coin_ledger", "app_settings", "mutation_outbox", "command_receipts", "widget_board_rows"]
    var committed: [String: [[String: IntentSQLValue]]] = [:]
    for table in tables { committed[table] = try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid") }
    harness.instant += 86_400_000
    let replay = try second.removeLatest(commandId: command, boardId: board,
      logicalDate: newer.logicalDate, expectedCheckInId: newer.checkInId).get()
    XCTAssertEqual(replay, removed)
    for table in tables {
      XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table) ORDER BY rowid"), committed[table], table)
    }
  }

  func testHistoryOrderingPrefersTimedRowsThenAscendingIdForTies() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    let first = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    let second = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).get()
    XCTAssertEqual(try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get().checkInId, first.checkInId)
    try harness.database.run("UPDATE check_ins SET occurred_at_utc = ? WHERE id = ?", [.real(harness.instant - 1000), .text(second.checkInId)])
    XCTAssertEqual(try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get().checkInId, second.checkInId)
    try harness.database.run("UPDATE check_ins SET occurred_at_utc = ? WHERE id = ?", [.real(harness.instant), .text(first.checkInId)])
    XCTAssertEqual(try harness.executor.removalCandidate(boardId: board, logicalDate: nil).get().checkInId, first.checkInId)
  }

  func testMissingStoreIsNeverCreatedAndNativeErrorsDoNotExposePaths() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".db")
    XCTAssertThrowsError(try IntentDatabase(path: url.path)) { error in
      XCTAssertEqual(error as? IntentFailure, .unavailable)
      XCTAssertFalse(error.localizedDescription.contains(url.path))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testUnicodeNoteRoundTripsNullBytesAndTrimsTheSameWhitespaceAsJavaScript() throws {
    let harness = try harness()
    let note = "\u{FEFF}\u{00A0}hello\0world\u{00A0}"
    let created = try harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: "00000000-0000-4000-8000-00000000a001", note: note)).get()
    XCTAssertEqual(try harness.database.rows("SELECT note FROM check_ins WHERE id = ?", [.text(created.checkInId)]).first?["note"]?.string, "hello\0world")
  }

  func testArchivedDeletedAndMissingBoardsAreExcludedWithoutExposingNotes() throws {
    let harness = try harness()
    let board = "00000000-0000-4000-8000-00000000a001"
    try harness.database.run("UPDATE boards SET deleted_at = 1 WHERE id = ?", [.text(board)])
    XCTAssertEqual(try harness.executor.listBoards().get().map(\.title), ["water"])
    XCTAssertEqual(harness.executor.today(boardId: board).error?.code, "not_found")
    XCTAssertEqual(harness.executor.checkIn(IntentCheckInInput(commandId: harness.id(), boardId: board)).error?.code, "not_found")
  }

  func testCalendarWallTimeMappingAcrossDSTAndShiftedDates() throws {
    let gap = try IntentCalendar.occurredAt(logicalDate: "2026-03-07", hour: 2, minute: 30, startMinute: 240, zone: "America/New_York")
    XCTAssertEqual(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: gap / 1000)), "2026-03-08T07:30:00Z")
    let repeatTime = try IntentCalendar.occurredAt(logicalDate: "2026-11-01", hour: 1, minute: 30, startMinute: 0, zone: "America/New_York")
    XCTAssertEqual(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: repeatTime / 1000)), "2026-11-01T05:30:00Z")
  }
}
