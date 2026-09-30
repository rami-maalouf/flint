import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentCoinPolicyCaptureTests: XCTestCase {
  private func fixture() throws -> CaptureFixture {
    let data = try Data(contentsOf: CoinStoreHarness.root.appendingPathComponent("src/core/automations/fixtures/coin-policy-capture.json"))
    return try JSONDecoder().decode(CaptureFixture.self, from: data)
  }

  func testSharedProspectivePolicySnapshotsUseStoredDateAndStructuralRoot() throws {
    for vector in try fixture().cases {
      let resolver = try IntentEconomicDayCloseResolver(zone: vector.timeZoneId)
      let capture = try IntentCoinPolicyCapture(boards: vector.boards, periods: vector.periods, resolveClose: resolver.resolve)
      let actual = try capture.capture(boardId: vector.boardId, logicalDate: vector.logicalDate)
      XCTAssertEqual(actual, vector.expected, vector.name)
      XCTAssertEqual(try actual.canonical(), vector.expectedJson, vector.name)
      let reversed = try IntentCoinPolicyCapture(boards: vector.boards.reversed(), periods: vector.periods.reversed(), resolveClose: resolver.resolve)
      XCTAssertEqual(try reversed.capture(boardId: vector.boardId, logicalDate: vector.logicalDate), actual, vector.name)
    }
  }

  func testReversedStoredIntervalIsEmptyButMalformedDatesAndClosesReject() throws {
    let vector = try XCTUnwrap(fixture().cases.first { $0.expected.rootId != nil })
    let period = IntentCoinPolicyPeriod(boardId: vector.boardId, startDate: "2026-09-09", endDate: "2026-09-08")
    let capture = try IntentCoinPolicyCapture(boards: vector.boards, periods: [period], resolveClose: { _, _ in 0 })
    let policy = try capture.capture(boardId: vector.boardId, logicalDate: "2026-09-08")
    XCTAssertEqual(policy.requiredBoardIds, [])
    XCTAssertFalse(policy.bonusEnabled)
    for malformed in [IntentCoinPolicyPeriod(boardId: vector.boardId, startDate: "bad", endDate: nil),
      IntentCoinPolicyPeriod(boardId: vector.boardId, startDate: "2026-09-01", endDate: "2026-02-30")] {
      XCTAssertThrowsError(try IntentCoinPolicyCapture(boards: vector.boards, periods: [malformed], resolveClose: { _, _ in 0 }))
    }
    for value in [Double.nan, Double.infinity, 0.5, -0.0, Double(IntentCoinJSON.safeInteger) + 1] {
      let invalid = try IntentCoinPolicyCapture(boards: vector.boards, periods: [], resolveClose: { _, _ in value })
      XCTAssertThrowsError(try invalid.capture(boardId: vector.boardId, logicalDate: vector.logicalDate))
    }
  }

  func testDatabaseReaderMatchesSharedPoliciesAndDoesNotWrite() throws {
    for vector in try fixture().cases {
      let harness = try CoinStoreHarness()
      try seed(vector, database: harness.database)
      let resolver = try IntentEconomicDayCloseResolver(zone: vector.timeZoneId)
      let policy = try harness.database.transaction(exclusive: false) {
        try IntentCoinPolicyCapture.read(database: harness.database, boardIds: [vector.boardId], resolveClose: resolver.resolve)
          .capture(boardId: vector.boardId, logicalDate: vector.logicalDate)
      }
      XCTAssertEqual(policy, vector.expected, vector.name)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 0)
      XCTAssertEqual(try harness.database.rows("SELECT * FROM coin_ledger").count, 0)
    }
  }

  func testReaderKeepsAcquiredSnapshotWhileAnotherConnectionChangesRootAndPeriods() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("capture.sqlite").path
    let harness = try CoinStoreHarness(path: path)
    try harness.database.run("PRAGMA journal_mode = WAL")
    let vector = try XCTUnwrap(fixture().cases.first { $0.name == "singleton preset root" })
    try seed(vector, database: harness.database)
    let writer = try IntentDatabase(path: path)
    let resolver = try IntentEconomicDayCloseResolver(zone: vector.timeZoneId)
    let original = try harness.database.transaction(exclusive: false) {
      _ = try harness.database.rows("SELECT id FROM boards")
      try writer.transaction(exclusive: true) {
        try writer.run("UPDATE boards SET start_of_day_minute = 240 WHERE id = ?", [.text(vector.boardId)])
        try writer.run("UPDATE board_activity_periods SET end_date = ? WHERE board_id = ?", [.text(vector.logicalDate), .text(vector.boardId)])
      }
      return try IntentCoinPolicyCapture.read(database: harness.database, boardIds: [vector.boardId], resolveClose: resolver.resolve)
    }
    XCTAssertEqual(try original.capture(boardId: vector.boardId, logicalDate: vector.logicalDate), vector.expected)
    let fresh = try IntentCoinPolicyCapture.read(database: harness.database, boardIds: [vector.boardId], resolveClose: resolver.resolve)
      .capture(boardId: vector.boardId, logicalDate: vector.logicalDate)
    XCTAssertEqual(fresh.requiredBoardIds, [])
    XCTAssertEqual(fresh.checkClosesAtUtc, vector.expected.checkClosesAtUtc + 14_400_000)
    XCTAssertEqual(try original.capture(boardId: vector.boardId, logicalDate: vector.logicalDate), vector.expected)
  }

  func testReaderRestrictsUnloadedComponentsAndRejectsRawBooleanAndMinuteValues() throws {
    let vector = try XCTUnwrap(fixture().cases.first { $0.name == "equal text labels remain separate roots" })
    let harness = try CoinStoreHarness()
    try seed(vector, database: harness.database)
    let resolver = try IntentEconomicDayCloseResolver(zone: vector.timeZoneId)
    let capture = try IntentCoinPolicyCapture.read(database: harness.database, boardIds: [vector.boardId], resolveClose: resolver.resolve)
    let other = try XCTUnwrap(vector.boards.first { $0.id != vector.boardId })
    XCTAssertThrowsError(try capture.capture(boardId: other.id, logicalDate: vector.logicalDate)) {
      XCTAssertEqual(($0 as? IntentFailure)?.code, "not_found")
    }
    for (field, value) in [("earns_coins", "2"), ("required_in_stack", "0.5"), ("coin_cap_per_day", "2.5"), ("start_of_day_minute", "0.5")] {
      try harness.database.run("PRAGMA ignore_check_constraints = ON")
      XCTAssertThrowsError(try harness.database.transaction(exclusive: true) {
        try harness.database.run("UPDATE boards SET \(field) = \(value) WHERE id = ?", [.text(vector.boardId)])
        _ = try IntentCoinPolicyCapture.read(database: harness.database, boardIds: [vector.boardId], resolveClose: resolver.resolve)
      }, field)
    }
  }

  func testTopologyUsesExactAppTextWhitespaceRulesAndRejectsBrokenGraphs() throws {
    let vector = try XCTUnwrap(fixture().cases.first { $0.name == "singleton text root" })
    let board = try XCTUnwrap(vector.boards.first)
    let retained = try replacing(board, fields: ["anchorText": "\u{0085}anchor"])
    let capture = try IntentCoinPolicyCapture(boards: [retained], periods: vector.periods, resolveClose: { _, _ in 0 })
    XCTAssertEqual(try capture.capture(boardId: board.id, logicalDate: vector.logicalDate).rootId, board.id)
    for text in ["\u{FEFF}anchor", "anchor\u{FEFF}", " anchor", "anchor\n"] {
      XCTAssertThrowsError(try IntentCoinPolicyCapture(boards: [replacing(board, fields: ["anchorText": text])], periods: [], resolveClose: { _, _ in 0 }))
    }
    XCTAssertThrowsError(try IntentCoinPolicyCapture(boards: [board, board], periods: [], resolveClose: { _, _ in 0 }))
    for target in [board.id, "00000000-0000-4000-8000-000000000088"] {
      let invalid = try replacing(board, fields: ["anchorKind": "board", "anchorText": NSNull(), "anchorBoardId": target])
      XCTAssertThrowsError(try IntentCoinPolicyCapture(boards: [invalid], periods: [], resolveClose: { _, _ in 0 }))
    }
  }

  func testEmptyAndInvalidRequestedScopesDoNotAccessStorage() throws {
    let database = try IntentDatabase(path: ":memory:", createForTesting: true)
    let empty = try IntentCoinPolicyCapture.read(database: database, boardIds: [], resolveClose: { _, _ in 0 })
    XCTAssertThrowsError(try empty.capture(boardId: "00000000-0000-4000-8000-000000000001", logicalDate: "2026-09-08")) {
      XCTAssertEqual(($0 as? IntentFailure)?.code, "not_found")
    }
    XCTAssertThrowsError(try IntentCoinPolicyCapture.read(database: database, boardIds: ["invalid"], resolveClose: { _, _ in 0 })) {
      XCTAssertEqual(String(describing: $0), "invalid")
    }
  }

  private func replacing(_ board: IntentCoinPolicyBoard, fields: [String: Any]) throws -> IntentCoinPolicyBoard {
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(board)) as? [String: Any])
    for (key, value) in fields { object[key] = value }
    return try JSONDecoder().decode(IntentCoinPolicyBoard.self, from: JSONSerialization.data(withJSONObject: object))
  }

  private func seed(_ vector: CaptureFixture.Case, database: IntentDatabase) throws {
    for board in vector.boards {
      try database.run("""
        INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background, tracks_amount, quick_amount, tracks_time,
          start_of_day_minute, metrics_enabled, order_key, archived_at, created_at, updated_at, mutation_stamp, deleted_at,
          kind, earns_coins, coin_cap_per_day, required_in_stack, usual_time_minute)
        VALUES (?, 'fixture', 'star', '#ffffff', 0, 0, 1, 0, ?, 1, ?, ?, 0, 0, 'seed', ?, ?, ?, ?, ?, ?)
        """, [.text(board.id), .integer(Int64(board.startOfDayMinute)), .text(board.orderKey),
          board.archivedAt.map(IntentSQLValue.integer) ?? .null, board.deletedAt.map(IntentSQLValue.integer) ?? .null,
          .text(board.kind), .integer(board.earnsCoins ? 1 : 0), .integer(Int64(board.coinCapPerDay)),
          .integer(board.requiredInStack ? 1 : 0), board.usualTimeMinute.map { .integer(Int64($0)) } ?? .null])
    }
    for board in vector.boards {
      try database.run("UPDATE boards SET anchor_kind = ?, anchor_relation = ?, anchor_board_id = ?, anchor_preset = ?, anchor_text = ? WHERE id = ?",
        [.string(board.anchorKind), .string(board.anchorRelation), .string(board.anchorBoardId), .string(board.anchorPreset), .string(board.anchorText), .text(board.id)])
    }
    for period in vector.periods {
      try database.run("INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp) VALUES (?, ?, ?, 'seed')",
        [.text(period.boardId), .text(period.startDate), .string(period.endDate)])
    }
  }
}

private struct CaptureFixture: Decodable {
  struct Case: Decodable {
    let name: String; let boardId: String; let logicalDate: String; let timeZoneId: String
    let boards: [IntentCoinPolicyBoard]; let periods: [IntentCoinPolicyPeriod]
    let expected: IntentCoinPolicy; let expectedJson: String
  }
  let cases: [Case]
}
