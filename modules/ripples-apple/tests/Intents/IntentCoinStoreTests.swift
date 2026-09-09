import Foundation
import XCTest
@testable import RipplesIntentCore

final class IntentCoinStoreTests: XCTestCase {
  func testLedgerAppendReadsExactScopeAndRejectsChangedCanonicalBytes() throws {
    let harness = try CoinStoreHarness()
    let fixture = try JSONDecoder().decode(CoinStoreFixture.self, from: harness.fixture())
    let award = try IntentCoinLedgerRow.check(harness.firstAction())
    try harness.database.transaction(exclusive: true) {
      XCTAssertTrue(try IntentCoinStore.append(award, to: harness.database, enqueueAt: 42))
      XCTAssertFalse(try IntentCoinStore.append(award, to: harness.database, enqueueAt: 42))
      XCTAssertTrue(try IntentCoinStore.append(fixture.unicodeClaims[0], to: harness.database, enqueueAt: 42))
      XCTAssertFalse(try IntentCoinStore.append(fixture.unicodeClaims[0], to: harness.database, enqueueAt: 42))
    }
    XCTAssertThrowsError(try IntentCoinStore.append(fixture.unicodeClaims[1], to: harness.database, enqueueAt: 43))
    XCTAssertEqual(try IntentCoinStore.entries(scopeKey: XCTUnwrap(award.scopeKey), database: harness.database), [award])
    XCTAssertEqual(try IntentCoinStore.entries(scopeKey: "check:\(try XCTUnwrap(award.boardId)):2026-09-07", database: harness.database), [])
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox WHERE entity_type = 'ledger_entry'").count, 2)
    XCTAssertEqual(try harness.database.rows("SELECT DISTINCT created_at FROM mutation_outbox").first?["created_at"], .integer(42))
  }

  func testSettlementPersistsActualReplayCorrectionAndThenDoesNothing() throws {
    let harness = try CoinStoreHarness()
    let fixture = try JSONDecoder().decode(CoinStoreFixture.self, from: harness.fixture())
    let vector = fixture.correction
    let source = try XCTUnwrap(vector.actions.first)
    let settings = try harness.database.rows("SELECT * FROM app_settings")
    try harness.database.transaction(exclusive: true) {
      for action in vector.actions { try action.append(to: harness.database) }
      for row in vector.existingRows { try IntentCoinStore.append(row, to: harness.database, enqueueAt: 42) }
      let result = try IntentCoinStore.settleCheck(boardId: source.boardId, logicalDate: source.logicalDate, database: harness.database, enqueueAt: 42)
      XCTAssertEqual(result.appendedRows, vector.expectedAppend)
      XCTAssertEqual(result.target, vector.target)
      XCTAssertEqual(result.balance, vector.balance)
    }
    let before = try harness.database.rows("SELECT * FROM mutation_outbox ORDER BY id")
    let replay = try harness.database.transaction(exclusive: true) {
      try IntentCoinStore.settleCheck(boardId: source.boardId, logicalDate: source.logicalDate, database: harness.database, enqueueAt: 42)
    }
    XCTAssertTrue(replay.appendedRows.isEmpty)
    XCTAssertEqual(replay.balance, vector.balance)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox ORDER BY id"), before)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM app_settings"), settings)
    let rows = try IntentCoinStore.entries(scopeKey: "check:\(source.boardId):\(source.logicalDate)", database: harness.database)
    XCTAssertEqual(Set(rows.map(\.id)), Set((vector.existingRows + vector.expectedAppend).map(\.id)))
  }

  func testSettlementOutboxFailureRollsBackActionLedgerAndReceiptTogether() throws {
    let harness = try CoinStoreHarness()
    let action = try harness.firstAction()
    let settings = try harness.database.rows("SELECT * FROM app_settings")
    try harness.database.run("CREATE TRIGGER reject_ledger_outbox BEFORE INSERT ON mutation_outbox WHEN NEW.entity_type = 'ledger_entry' BEGIN SELECT RAISE(ABORT, 'test'); END")
    XCTAssertThrowsError(try harness.database.transaction(exclusive: true) {
      try action.append(to: harness.database)
      try harness.database.run("INSERT INTO command_receipts VALUES (?, '{}', 0)", [.text(try XCTUnwrap(action.commandId))])
      _ = try IntentCoinStore.settleCheck(boardId: action.boardId, logicalDate: action.logicalDate, database: harness.database, enqueueAt: 42)
    })
    for table in ["habit_actions", "coin_ledger", "mutation_outbox", "command_receipts"] {
      XCTAssertEqual(try harness.database.rows("SELECT * FROM \(table)").count, 0, table)
    }
    XCTAssertEqual(try harness.database.rows("SELECT * FROM app_settings"), settings)
    try harness.database.run("DROP TRIGGER reject_ledger_outbox")
    let result = try harness.database.transaction(exclusive: true) {
      try action.append(to: harness.database)
      return try IntentCoinStore.settleCheck(boardId: action.boardId, logicalDate: action.logicalDate, database: harness.database, enqueueAt: 42)
    }
    XCTAssertEqual(result.balance, 1)
    XCTAssertEqual(result.appendedRows, [try IntentCoinLedgerRow.check(action)])
  }

  func testLiveActionRepositoryAcceptsOnlyCanonicalPolicyAndPreservesLegacyNull() throws {
    let harness = try CoinStoreHarness()
    let action = try harness.firstAction()
    try harness.database.transaction(exclusive: true) {
      XCTAssertTrue(try action.append(to: harness.database))
      XCTAssertFalse(try action.append(to: harness.database))
    }
    XCTAssertEqual(try harness.database.rows("SELECT policy_json FROM habit_actions").first?["policy_json"]?.string, action.policyJson)
    let legacy = replacing(action, id: "00000000-0000-4000-8000-000000000002", policy: nil)
    XCTAssertTrue(try legacy.append(to: harness.database))
    let baseline = try IntentHabitAction.baseline(checkInId: "00000000-0000-4000-8000-000000000003", boardId: action.boardId, date: action.logicalDate)
    XCTAssertTrue(try baseline.append(to: harness.database))
    let before = try harness.database.rows("SELECT * FROM mutation_outbox")
    for policy in ["{}", " " + (try XCTUnwrap(action.policyJson)), String(repeating: " ", count: IntentCoinJSON.policyBytes + 1)] {
      XCTAssertThrowsError(try replacing(action, id: "00000000-0000-4000-8000-000000000004", policy: policy).append(to: harness.database))
    }
    XCTAssertThrowsError(try replacing(baseline, id: baseline.id, policy: action.policyJson).append(to: harness.database))
    XCTAssertThrowsError(try replacing(action, id: action.id, policy: nil).append(to: harness.database))
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox"), before)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 3)
  }

  func testSettlementReadsOnlyItsScopeAndRejectsMalformedStoredScalarBeforeAppending() throws {
    let harness = try CoinStoreHarness()
    let action = try harness.firstAction()
    try action.append(to: harness.database)
    try harness.database.run("PRAGMA ignore_check_constraints = ON")
    try harness.database.run("""
      INSERT INTO habit_actions (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES ('00000000-0000-4000-8000-000000000090', ?, ?, '2026-09-07', ?, 'check', 1.5, ?, ?)
      """, [.string(action.commandId), .text(action.boardId), .string(action.checkInId), .text(action.mutationStamp), .string(action.policyJson)])
    let result = try harness.database.transaction(exclusive: true) {
      try IntentCoinStore.settleCheck(boardId: action.boardId, logicalDate: action.logicalDate, database: harness.database, enqueueAt: 42)
    }
    XCTAssertEqual(result.balance, 1)
    let before = try harness.database.rows("SELECT * FROM mutation_outbox")
    XCTAssertThrowsError(try harness.database.transaction(exclusive: true) {
      try IntentCoinStore.settleCheck(boardId: action.boardId, logicalDate: "2026-09-07", database: harness.database, enqueueAt: 42)
    })
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox"), before)
    let empty = try IntentCoinStore.settleCheck(boardId: action.boardId, logicalDate: "2026-09-06", database: harness.database, enqueueAt: 42)
    XCTAssertEqual(empty.balance, 0)
    XCTAssertTrue(empty.appendedRows.isEmpty)
  }

  func testCompleteActionRecordBudgetRejectsBeforeAnyStorageWrite() throws {
    let harness = try CoinStoreHarness()
    let action = try harness.firstAction()
    let oversized = IntentHabitAction(id: action.id, commandId: action.commandId, boardId: action.boardId,
      logicalDate: action.logicalDate, checkInId: action.checkInId, kind: action.kind, createdAt: action.createdAt,
      mutationStamp: "00000000000001-00000-" + String(repeating: "a", count: IntentCoinJSON.recordBytes), policyJson: action.policyJson)
    XCTAssertThrowsError(try oversized.append(to: harness.database)) {
      XCTAssertEqual(String(describing: $0), "size")
    }
    XCTAssertEqual(try harness.database.rows("SELECT * FROM habit_actions").count, 0)
    XCTAssertEqual(try harness.database.rows("SELECT * FROM mutation_outbox").count, 0)
  }

  private func replacing(_ action: IntentHabitAction, id: String, policy: String?) -> IntentHabitAction {
    IntentHabitAction(id: id, commandId: action.commandId, boardId: action.boardId, logicalDate: action.logicalDate,
      checkInId: action.checkInId, kind: action.kind, createdAt: action.createdAt, mutationStamp: action.mutationStamp, policyJson: policy)
  }
}

private struct CoinStoreFixture: Decodable {
  struct Reconciliation: Decodable {
    let actions: [IntentHabitAction]; let existingRows: [IntentCoinLedgerRow]; let expectedAppend: [IntentCoinLedgerRow]
    let target: Int64; let balance: Int64
  }
  let correction: Reconciliation
  let unicodeClaims: [IntentCoinLedgerRow]
}

final class CoinStoreHarness {
  static var root: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }
  let database: IntentDatabase
  init(path: String = ":memory:") throws {
    database = try IntentDatabase(path: path, createForTesting: true)
    let migrations = try IntentFixtureMigrations.load(root: Self.root)
    for migration in migrations { try IntentFixtureMigrations.apply(migration, to: database, enqueueAt: 0) }
    let version = try XCTUnwrap(migrations.last?["version"] as? Int)
    try database.run("INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, ?, '00000000-0000-4000-8000-000000000099')", [.integer(Int64(version))])
  }
  func fixture() throws -> Data {
    try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/check-coins.json"))
  }
  func firstAction() throws -> IntentHabitAction {
    struct Fixture: Decodable {
      struct Case: Decodable { let actions: [IntentHabitAction] }
      let cases: [Case]
    }
    return try XCTUnwrap(JSONDecoder().decode(Fixture.self, from: fixture()).cases.first?.actions.first)
  }
}
