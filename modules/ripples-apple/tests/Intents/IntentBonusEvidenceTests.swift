import Foundation
import XCTest
@testable import RipplesIntentCore

final class IntentBonusEvidenceTests: XCTestCase {
  private let root = "00000000-0000-4000-8000-000000000001"
  private let member = "00000000-0000-4000-8000-000000000002"
  private let outside = "00000000-0000-4000-8000-000000000003"
  private let date = "2026-09-08"

  func testEmptyAndInvalidScopesDoNotReadUnavailableStorage() throws {
    let db = try IntentDatabase(path: ":memory:", createForTesting: true)
    XCTAssertTrue(try IntentBonusEvidence.read(database: db, checkScopes: []).isEmpty)
    XCTAssertThrowsError(try IntentBonusEvidence.read(database: db, checkScopes: [.init(boardId: "invalid", logicalDate: date)])) {
      XCTAssertEqual(String(describing: $0), "invalid")
    }
  }

  func testExactDateReverseMembershipRetainsRootlessStateAndExcludesForeignTopology() throws {
    let h = try CoinStoreHarness()
    let control = try action(100, board: root, policyRoot: root, kind: "policy")
    let state = try action(101, board: member, policyRoot: nil)
    let unrelated = try action(102, board: outside, policyRoot: outside, required: [outside])
    let yesterday = try action(103, board: root, policyRoot: root, date: "2026-09-07")
    for item in [control, state, unrelated, yesterday] { try item.append(to: h.database) }
    let before = try h.database.rows("SELECT * FROM mutation_outbox")
    let groups = try IntentBonusEvidence.read(database: h.database, checkScopes: [.init(boardId: member, logicalDate: date)])
    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual(groups.first?.scope, .init(rootId: root, logicalDate: date))
    XCTAssertEqual(groups.first?.actions, [control, state])
    XCTAssertEqual(try h.database.rows("SELECT * FROM mutation_outbox"), before)
  }

  func testRetainedAwardDiscoversMissingControlScopeThroughRootlessSource() throws {
    let h = try CoinStoreHarness()
    let source = try action(101, board: member, policyRoot: nil)
    let policy = try IntentCoinPolicy.parse(XCTUnwrap(action(100, board: root, policyRoot: root).policyJson))
    let row = try IntentBonusCoins.award(source, policy: policy)
    try source.append(to: h.database)
    try IntentCoinStore.append(row, to: h.database, enqueueAt: 42)
    let groups = try IntentBonusEvidence.read(database: h.database, checkScopes: [.init(boardId: member, logicalDate: date)])
    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual(groups.first?.actions, [source])
    XCTAssertEqual(groups.first?.rows, [row])
    XCTAssertThrowsError(try IntentCoinStore.settleAffected(checkScopes: [.init(boardId: member, logicalDate: date)], database: h.database, enqueueAt: 42)) {
      XCTAssertEqual(String(describing: $0), "missing")
    }
  }

  func testSharedReconciliationFactsPersistWithoutClockOrSettingsChanges() throws {
    for item in try fixture().reconciliationCases {
      let h = try CoinStoreHarness()
      for action in item.actions { try action.append(to: h.database) }
      for row in item.rows { try IntentCoinStore.append(row, to: h.database, enqueueAt: 41) }
      let settings = try h.database.rows("SELECT * FROM app_settings")
      try h.database.transaction(exclusive: true) {
        try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: [.init(rootId: item.scope.rootId, logicalDate: item.scope.logicalDate)],
          database: h.database, enqueueAt: 42)
      }
      let stored = try IntentCoinStore.entries(scopeKey: "bonus:\(item.scope.rootId):\(item.scope.logicalDate)", database: h.database)
      XCTAssertEqual(Set(stored.map(\.id)), Set((item.rows + item.expectedAppendedRows).map(\.id)), item.name)
      XCTAssertEqual(stored.reduce(0) { $0 + $1.delta }, item.expectedBalance, item.name)
      for row in item.expectedAppendedRows {
        XCTAssertEqual(stored.first { $0.id == row.id }, row, item.name)
        XCTAssertEqual(try h.database.rows("SELECT created_at FROM mutation_outbox WHERE entity_type = 'ledger_entry' AND entity_id = ?", [.text(row.id)]).first?["created_at"], .integer(42))
      }
      let outbox = try h.database.rows("SELECT * FROM mutation_outbox")
      try h.database.transaction(exclusive: true) {
        try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: [.init(rootId: item.scope.rootId, logicalDate: item.scope.logicalDate)],
          database: h.database, enqueueAt: 43)
      }
      XCTAssertEqual(try h.database.rows("SELECT * FROM mutation_outbox"), outbox, item.name)
      XCTAssertEqual(try h.database.rows("SELECT * FROM app_settings"), settings, item.name)
    }
  }

  func testRawPayloadsNeverBecomeBonusEvidenceDuringDiscoveryOrSettlement() throws {
    let h = try CoinStoreHarness()
    try action(100, board: root, policyRoot: root, kind: "policy").append(to: h.database)
    for number in 1...3 {
      try h.database.run("""
        INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
          tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
        VALUES (?, 'legacy', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, ?, 0, 0, 'seed')
        """, [.text(id(number)), .text(String(number))])
    }
    for (number, board, day, deleted) in [(201, member, date, false), (202, member, date, false),
      (203, member, date, true), (204, member, "2026-09-07", false), (205, outside, date, false)] {
      try h.database.run("""
        INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp,note,amount,deleted_at)
        VALUES (?, ?, ?, 'import', ?, 0, 0, 'seed', 'retained', 73, ?)
        """, [.text(id(number)), .text(board), .text(day), .text(id(number + 1000)), deleted ? .integer(1) : .null])
    }
    let removal = try action(302, board: member, policyRoot: nil)
    // any target evidence, even removal without an add, prevents resurrection.
    let tombstone = IntentHabitAction(id: id(301), commandId: id(1301), boardId: member, logicalDate: date,
      checkInId: id(202), kind: "uncheck", createdAt: 301, mutationStamp: "00000000000301-00000-native", policyJson: removal.policyJson)
    try tombstone.append(to: h.database)
    let before = try h.database.rows("SELECT * FROM check_ins")
    let groups = try IntentBonusEvidence.read(database: h.database, checkScopes: [.init(boardId: member, logicalDate: date)])
    XCTAssertEqual(groups.first?.actions.count, 2)
    try h.database.transaction(exclusive: true) {
      try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: [.init(rootId: root, logicalDate: date)], database: h.database, enqueueAt: 42)
    }
    XCTAssertEqual(try h.database.rows("SELECT * FROM check_ins"), before)
    XCTAssertTrue(try h.database.rows("SELECT * FROM habit_actions WHERE kind = 'baseline'").isEmpty)
    XCTAssertTrue(try h.database.rows("SELECT * FROM coin_ledger").isEmpty)
  }

  func testExplicitHistoricalTokenAcrossRootsQueuesOnceAndDuplicateAppendPreservesEnqueueTime() throws {
    let h = try CoinStoreHarness()
    try action(100, board: root, policyRoot: root, kind: "policy", required: [member]).append(to: h.database)
    try action(101, board: outside, policyRoot: outside, kind: "policy", required: [member]).append(to: h.database)
    try h.database.run("""
      INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
        tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'legacy', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, 'seed')
      """, [.text(member)])
    try h.database.run("""
      INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp)
      VALUES (?, ?, ?, 'import', ?, 0, 0, 'seed')
      """, [.text(id(201)), .text(member), .text(date), .text(id(1201))])
    try IntentFixtureMigrations.establishHistorical(database: h.database, ids: [id(201)], enqueueAt: 42)
    let roots: [IntentBonusEvidence.Scope] = [.init(rootId: root, logicalDate: date), .init(rootId: outside, logicalDate: date)]
    try h.database.transaction(exclusive: true) {
      try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: roots, database: h.database, enqueueAt: 42)
    }
    let baseline = try IntentHabitAction.baseline(checkInId: id(201), boardId: member, date: date)
    XCTAssertEqual(try h.database.rows("SELECT created_at FROM habit_actions WHERE kind = 'baseline'"), [["created_at": .integer(0)]])
    XCTAssertEqual(try h.database.rows("SELECT created_at FROM mutation_outbox WHERE entity_type = 'habit_action' AND entity_id = ?", [.text(baseline.id)]), [["created_at": .integer(42)]])
    let before = try h.database.rows("SELECT * FROM mutation_outbox")
    XCTAssertFalse(try baseline.append(to: h.database, enqueueAt: 99))
    try h.database.transaction(exclusive: true) {
      try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: roots, database: h.database, enqueueAt: 43)
    }
    XCTAssertEqual(try h.database.rows("SELECT * FROM mutation_outbox"), before)
  }

  func testMalformedProofHashRejectsBeforeAnySettlementEffects() throws {
    let vector = try XCTUnwrap(fixture().reconciliationCases.first { $0.expectedAppendedRows.contains { $0.kind == "adjustment" } })
    let h = try CoinStoreHarness()
    for action in vector.actions { try action.append(to: h.database) }
    for row in vector.rows { try IntentCoinStore.append(row, to: h.database, enqueueAt: 41) }
    let correction = try XCTUnwrap(vector.expectedAppendedRows.first { $0.kind == "adjustment" })
    var facts = try IntentCoinProvenance.parse(XCTUnwrap(correction.provenanceJson))
    facts[0][2] = String(repeating: "f", count: 64)
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(correction)) as? [String: Any])
    json["provenanceJson"] = try IntentCoinProvenance.canonical(facts)
    let bad = try JSONDecoder().decode(IntentCoinLedgerRow.self, from: JSONSerialization.data(withJSONObject: json))
    try IntentCoinStore.append(bad, to: h.database, enqueueAt: 41)
    let before = try h.database.rows("SELECT * FROM mutation_outbox")
    XCTAssertThrowsError(try h.database.transaction(exclusive: true) {
      try IntentCoinStore.settleAffected(checkScopes: [], rootScopes: [.init(rootId: vector.scope.rootId, logicalDate: vector.scope.logicalDate)], database: h.database, enqueueAt: 42)
    }) { XCTAssertEqual(String(describing: $0), "invalid") }
    XCTAssertEqual(try h.database.rows("SELECT * FROM mutation_outbox"), before)
  }

  func testFactBudgetIsPerScopeAndRawPayloadDoesNotConsumeEvidenceBudget() throws {
    let h = try CoinStoreHarness()
    func add(_ start: Int, _ count: Int, board: String) throws {
      let policy = try XCTUnwrap(action(start, board: board, policyRoot: board, required: [board]).policyJson)
      try h.database.run("""
        WITH RECURSIVE numbers(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?)
        INSERT INTO habit_actions (id,command_id,board_id,logical_date,check_in_id,kind,created_at,mutation_stamp,policy_json)
        SELECT printf('00000000-0000-4000-8000-%012d', n), printf('00000000-0000-4000-8000-%012d', n + 100000),
          ?, ?, printf('00000000-0000-4000-8000-%012d', n + 200000), 'check', n, printf('%014d-00000-native', n), ? FROM numbers
        """, [.integer(Int64(start)), .integer(Int64(start + count)), .text(board), .text(date), .text(policy)])
    }
    try add(10000, 2050, board: root)
    try add(20000, 2050, board: outside)
    let both = try IntentBonusEvidence.read(database: h.database, checkScopes: [],
      rootScopes: [.init(rootId: root, logicalDate: date), .init(rootId: outside, logicalDate: date)])
    XCTAssertEqual(both.map { $0.actions.count }, [2050, 2050])
    try add(30000, 2046, board: root)
    XCTAssertEqual(try IntentBonusEvidence.read(database: h.database, checkScopes: [], rootScopes: [.init(rootId: root, logicalDate: date)]).first?.actions.count, 4096)
    try h.database.run("""
      INSERT INTO boards (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,
        tracks_time,start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'legacy', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, 'seed')
      """, [.text(root)])
    try h.database.run("""
      INSERT INTO check_ins (id,board_id,logical_date,source,idempotency_key,created_at,updated_at,mutation_stamp)
      VALUES (?, ?, ?, 'import', ?, 0, 0, 'seed')
      """, [.text(id(900000)), .text(root), .text(date), .text(id(900001))])
    XCTAssertEqual(try IntentBonusEvidence.read(database: h.database, checkScopes: [], rootScopes: [.init(rootId: root, logicalDate: date)]).first?.actions.count, 4096)
    try add(50000, 1, board: root)
    XCTAssertThrowsError(try IntentBonusEvidence.read(database: h.database, checkScopes: [], rootScopes: [.init(rootId: root, logicalDate: date)])) {
      XCTAssertEqual(String(describing: $0), "size")
    }
    XCTAssertTrue(try h.database.rows("SELECT * FROM mutation_outbox").isEmpty)
  }

  private struct Fixture: Decodable {
    struct Scope: Decodable { let rootId: String; let logicalDate: String }
    struct Reconciliation: Decodable {
      let name: String; let scope: Scope; let actions: [IntentHabitAction]; let rows: [IntentCoinLedgerRow]
      let expectedAppendedRows: [IntentCoinLedgerRow]; let expectedBalance: Int64
    }
    let reconciliationCases: [Reconciliation]
  }
  private func fixture() throws -> Fixture {
    try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: CoinStoreHarness.root.appendingPathComponent("src/core/automations/fixtures/bonus-coins.json")))
  }

  private func action(_ number: Int, board: String, policyRoot: String?, kind: String = "check", required: [String]? = nil, date: String? = nil) throws -> IntentHabitAction {
    let policy = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: false, coinCapPerDay: 1, checkClosesAtUtc: 10000,
      rootId: policyRoot, requiredBoardIds: policyRoot == nil ? [] : (required ?? [root, member]),
      bonusClosesAtUtc: policyRoot == nil ? nil : 10000, bonusEnabled: policyRoot != nil)
    return IntentHabitAction(id: id(number), commandId: id(number + 1000), boardId: board, logicalDate: date ?? self.date,
      checkInId: kind == "policy" ? nil : id(number + 2000), kind: kind, createdAt: Int64(number),
      mutationStamp: String(format: "%014d-00000-native", number), policyJson: try policy.canonical())
  }
  private func id(_ value: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", value) }
}
