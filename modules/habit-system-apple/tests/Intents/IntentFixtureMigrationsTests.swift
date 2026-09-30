import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentFixtureMigrationsTests: XCTestCase {
  private let board = "00000000-0000-4000-8000-000000000010"
  private let date = "2026-08-30"
  private func oldStore() throws -> (IntentDatabase, [[String: Any]]) {
    let db = try IntentDatabase(path: ":memory:", createForTesting: true)
    let migrations = try IntentFixtureMigrations.load(root: CoinStoreHarness.root)
    for migration in migrations where (migration["version"] as? Int ?? 0) <= 10 {
      try IntentFixtureMigrations.apply(migration, to: db, enqueueAt: 12)
    }
    try db.run("INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, 10, ?)", [.text(board)])
    try db.run("""
      INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
        tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'legacy', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, 'seed')
      """, [.text(board)])
    return (db, migrations)
  }
  private func raw(_ db: IntentDatabase, _ number: Int, day: String = "2026-08-30", deleted: Bool = false) throws -> String {
    let id = String(format: "00000000-0000-4000-8000-%012d", number)
    try db.run("INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp,note,deleted_at) VALUES (?, ?, ?, 'import', ?, 1, 2, 'old-payload', 'preserved note', ?)", [.text(id), .text(board), .text(day), .text(id), deleted ? .integer(3) : .null])
    return id
  }
  private func removal(_ db: IntentDatabase, token: String?, day: String, index: Int) throws {
    try IntentHabitAction(id: String(format: "00000000-0000-4000-8000-%012d", index), commandId: board,
      boardId: board, logicalDate: day, checkInId: token, kind: "uncheck", createdAt: 4,
      mutationStamp: "00000000000004-00000-device", policyJson: nil).append(to: db)
  }

  func testNonemptyVersionTenUpgradeExecutesEvidenceBeforeVisibilityAndMarkers() throws {
    let (db, migrations) = try oldStore()
    let first = try raw(db, 101), second = try raw(db, 102), removed = try raw(db, 103)
    let cleared = try raw(db, 104, day: "2026-08-29")
    _ = try raw(db, 105, deleted: true)
    try removal(db, token: removed, day: date, index: 201)
    try removal(db, token: nil, day: "2026-08-29", index: 202)
    let payloadSQL = "SELECT id,board_id,logical_date,note,created_at,updated_at,mutation_stamp,deleted_at FROM check_ins ORDER BY id"
    let before = try db.rows(payloadSQL)
    try IntentFixtureMigrations.apply(XCTUnwrap(migrations.first { $0["version"] as? Int == 11 }), to: db, enqueueAt: 91)
    XCTAssertEqual(try db.rows(payloadSQL), before)
    XCTAssertEqual(try db.rows("SELECT id FROM check_ins WHERE state_suppressed = 0 ORDER BY id"), [["id": .text(first)], ["id": .text(second)]])
    let baselines = try db.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").map(IntentCoinStore.action)
    XCTAssertEqual(Set(baselines.compactMap(\.checkInId)), Set([first, second, cleared]))
    for baseline in baselines {
      XCTAssertEqual(baseline, try IntentHabitAction.baseline(checkInId: XCTUnwrap(baseline.checkInId), boardId: board, date: baseline.logicalDate))
      XCTAssertEqual(try db.rows("SELECT created_at FROM mutation_outbox WHERE entity_type = 'habit_action' AND entity_id = ?", [.text(baseline.id)]), [["created_at": .integer(91)]])
    }
    XCTAssertTrue(try db.rows("SELECT * FROM coin_ledger").isEmpty)
    XCTAssertEqual(try db.rows("PRAGMA user_version").first?["user_version"], .integer(11))
    XCTAssertEqual(try db.rows("SELECT applied_at FROM schema_migrations WHERE version = 11"), [["applied_at": .integer(91)]])
  }

  func testUnknownDescriptorAndLaterBaselineFailureRollBackDDLBitsEvidenceAndMarkers() throws {
    let (db, migrations) = try oldStore()
    _ = try raw(db, 101); let second = try raw(db, 102)
    let migration = try XCTUnwrap(migrations.first { $0["version"] as? Int == 11 })
    var unknown = migration; unknown["dataStep"] = ["name": "unrecognized", "version": 1]
    XCTAssertThrowsError(try IntentFixtureMigrations.apply(unknown, to: db, enqueueAt: 91))
    try db.run("CREATE TRIGGER reject_second_baseline BEFORE INSERT ON habit_actions WHEN NEW.check_in_id = '\(second)' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    XCTAssertThrowsError(try IntentFixtureMigrations.apply(migration, to: db, enqueueAt: 91))
    XCTAssertTrue(try db.rows("SELECT * FROM habit_actions").isEmpty)
    XCTAssertTrue(try db.rows("SELECT * FROM mutation_outbox").isEmpty)
    XCTAssertFalse(try db.rows("PRAGMA table_info(check_ins)").contains { $0["name"]?.string == "state_suppressed" })
    XCTAssertTrue(try db.rows("SELECT * FROM schema_migrations WHERE version = 11").isEmpty)
    XCTAssertEqual(try db.rows("PRAGMA user_version").first?["user_version"], .integer(10))
  }

  func testUpgradeSettlesExistingDailyAwardMismatchWithoutInventingANewBaseline() throws {
    let (db, migrations) = try oldStore()
    let legacy = try raw(db, 101), genuine = try raw(db, 102)
    let baseline = try IntentHabitAction.baseline(checkInId: legacy, boardId: board, date: date)
    try baseline.append(to: db, enqueueAt: 10)
    let policy = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: true, coinCapPerDay: 1,
      checkClosesAtUtc: 200, rootId: nil, requiredBoardIds: [], bonusClosesAtUtc: nil, bonusEnabled: false)
    let action = IntentHabitAction(id: "00000000-0000-4000-8000-000000000301", commandId: board,
      boardId: board, logicalDate: date, checkInId: genuine, kind: "check", createdAt: 100,
      mutationStamp: "00000000000100-00000-device", policyJson: try policy.canonical())
    try action.append(to: db)
    let award = try IntentCoinLedgerRow.check(action)
    try IntentCoinStore.append(award, to: db, enqueueAt: 100)
    let actions = try db.rows("SELECT * FROM habit_actions ORDER BY id")
    try IntentFixtureMigrations.apply(XCTUnwrap(migrations.first { $0["version"] as? Int == 11 }), to: db, enqueueAt: 191)
    XCTAssertEqual(try db.rows("SELECT * FROM habit_actions ORDER BY id"), actions)
    let rows = try IntentCoinStore.entries(scopeKey: "check:\(board):\(date)", database: db)
    XCTAssertEqual(rows.first { $0.id == award.id }, award)
    XCTAssertEqual(rows.filter { $0.kind == "adjustment" }.map(\.delta), [-1])
    XCTAssertEqual(rows.reduce(0) { $0 + $1.delta }, 0)
    XCTAssertEqual(try db.rows("SELECT COUNT(*) AS count FROM check_ins WHERE state_suppressed = 0").first?["count"], .integer(2))
    XCTAssertEqual(try db.rows("SELECT entity_type FROM mutation_outbox WHERE created_at = 191"), [["entity_type": .text("ledger_entry")]])
  }
}
