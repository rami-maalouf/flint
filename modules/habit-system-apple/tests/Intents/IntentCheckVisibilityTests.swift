import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentCheckVisibilityTests: XCTestCase {
  private let board = "00000000-0000-4000-8000-000000000010"
  private let date = "2026-08-30"
  private func id(_ number: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", number) }
  private func action(_ db: IntentDatabase, _ number: Int, kind: String, token: Int?, day: String = "2026-08-30") throws {
    try IntentHabitAction(id: id(number), commandId: id(number + 1000), boardId: board,
      logicalDate: day, checkInId: token.map(id), kind: kind, createdAt: Int64(number),
      mutationStamp: String(format: "%014d-00000-device", number), policyJson: nil).append(to: db)
  }

  func testEmptyAndInvalidScopesDoNotAccessUnavailableTables() throws {
    let db = try IntentDatabase(path: ":memory:", createForTesting: true)
    XCTAssertNoThrow(try IntentCheckVisibility.refresh(database: db, scopes: []))
    XCTAssertThrowsError(try IntentCheckVisibility.refresh(database: db, scopes: [.init(boardId: "invalid", logicalDate: date)])) {
      XCTAssertEqual(String(describing: $0), "invalid")
    }
  }

  func testVisibilityIntersectsEverySurvivingTokenWithLivePayloadAndItsCurrentDate() throws {
    let h = try CoinStoreHarness(), db = h.database
    try db.run("""
      INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
        tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'tokens', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, 'seed')
      """, [.text(board)])
    for number in [101, 102, 103, 105, 106] {
      try db.run("INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp,note,deleted_at) VALUES (?, ?, ?, 'manual', ?, 1, 1, 'raw', 'private', ?)",
        [.text(id(number)), .text(board), .text(number == 105 ? "2026-08-31" : date), .text(id(number + 1000)), number == 103 ? .integer(2) : .null])
    }
    for number in 101...105 { try action(db, number + 1000, kind: "move_in", token: number) }
    let payloadSQL = "SELECT id,logical_date,note,created_at,updated_at,mutation_stamp,deleted_at FROM check_ins ORDER BY id"
    let payloads = try db.rows(payloadSQL), outbox = try db.rows("SELECT * FROM mutation_outbox")
    try db.transaction(exclusive: true) { try IntentCheckVisibility.refresh(database: db, scopes: [.init(boardId: board, logicalDate: date), .init(boardId: board, logicalDate: date)]) }
    XCTAssertEqual(try db.rows("SELECT id FROM check_ins WHERE state_suppressed = 0 ORDER BY id"), [["id": .text(id(101))], ["id": .text(id(102))]])
    XCTAssertEqual(try db.rows(payloadSQL), payloads)
    XCTAssertEqual(try db.rows("SELECT * FROM mutation_outbox"), outbox)
    XCTAssertTrue(try db.rows("SELECT * FROM coin_ledger").isEmpty)

    try action(db, 2000, kind: "uncheck", token: nil)
    try db.run("UPDATE check_ins SET note = 'higher-stamp note', mutation_stamp = '99999999999999-00000-remote' WHERE id = ?", [.text(id(101))])
    try db.run("UPDATE check_ins SET logical_date = '2026-08-31' WHERE id = ?", [.text(id(102))])
    try action(db, 2001, kind: "move_in", token: 102, day: "2026-08-31")
    try db.transaction(exclusive: true) { try IntentCheckVisibility.refresh(database: db, scopes: [.init(boardId: board, logicalDate: date), .init(boardId: board, logicalDate: "2026-08-31")]) }
    XCTAssertEqual(try db.rows("SELECT id FROM check_ins WHERE state_suppressed = 0 ORDER BY id"), [["id": .text(id(102))]])
    XCTAssertEqual(try db.rows("SELECT note FROM check_ins WHERE id = ?", [.text(id(101))]), [["note": .text("higher-stamp note")]])
    XCTAssertTrue(try db.rows("SELECT * FROM coin_ledger").isEmpty)
  }
}
