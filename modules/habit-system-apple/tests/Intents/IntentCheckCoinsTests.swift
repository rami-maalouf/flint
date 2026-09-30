import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentCheckCoinsTests: XCTestCase {
  private func fixture() throws -> CheckCoinFixture {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: root.appendingPathComponent("src/core/automations/fixtures/check-coins.json"))
    return try JSONDecoder().decode(CheckCoinFixture.self, from: data)
  }
  func testSharedPolicyAndCheckRows() throws {
    let fixture = try fixture()
    XCTAssertEqual(try fixture.policy.canonical(), fixture.policyJson)
    XCTAssertEqual(try IntentCoinPolicy.parse(fixture.policyJson), fixture.policy)
    for vector in fixture.cases {
      let result = try IntentCheckCoins.replay(boardId: fixture.scope.boardId, logicalDate: fixture.scope.logicalDate, actions: vector.actions)
      XCTAssertEqual(result.activeCheckInIds, vector.activeCheckInIds, vector.name)
      XCTAssertEqual(result.target, vector.target, vector.name)
      XCTAssertEqual(result.ordinaryRows, vector.ordinaryRows, vector.name)
    }
    for vector in [fixture.correction, fixture.overlap, fixture.zeroCorrection] {
      let result = try IntentCoinReconciliation.reconcile(boardId: fixture.scope.boardId, logicalDate: fixture.scope.logicalDate,
        actions: vector.actions, rows: vector.existingRows)
      XCTAssertEqual(result.appendedRows, vector.expectedAppend)
      XCTAssertEqual(result.target, vector.target)
      XCTAssertEqual(result.balance, vector.balance)
      let replay = try IntentCoinReconciliation.reconcile(boardId: fixture.scope.boardId, logicalDate: fixture.scope.logicalDate,
        actions: vector.actions.reversed(), rows: vector.existingRows + result.appendedRows)
      XCTAssertTrue(replay.appendedRows.isEmpty)
      XCTAssertEqual(replay.balance, vector.balance)
    }
  }

  func testSharedSignedPolicyBoundariesAndCanonicalLedgerRoles() throws {
    let fixture = try fixture()
    for policy in fixture.validPolicies {
      XCTAssertEqual(try policy.value.canonical(), policy.json)
      XCTAssertEqual(try IntentCoinPolicy.parse(policy.json), policy.value)
    }
    for invalid in fixture.invalidPolicies { XCTAssertThrowsError(try IntentCoinPolicy.parse(invalid), invalid) }
    for vector in fixture.canonicalRows {
      try vector.row.validateShape()
      XCTAssertEqual(try vector.row.canonical(), vector.json)
    }
  }
  func testImmutableUnicodeBytesAndRawTotals() throws {
    let fixture = try fixture()
    XCTAssertNotEqual(fixture.unicodeClaims[0], fixture.unicodeClaims[1])
    XCTAssertNotEqual(Array(try fixture.unicodeClaims[0].canonical().utf8), Array(try fixture.unicodeClaims[1].canonical().utf8))
    for vector in fixture.totalsCases {
      let totals = try IntentCoinLedgerRow.totals(vector.rows)
      XCTAssertEqual(totals.earned, vector.earned)
      XCTAssertEqual(totals.spent, vector.spent)
      XCTAssertEqual(totals.balance, vector.balance)
    }
    for rows in fixture.totalsOverflow { XCTAssertThrowsError(try IntentCoinLedgerRow.totals(rows)) }
  }
  func testSharedMalformedAndDeferredProofs() throws {
    let fixture = try fixture()
    for vector in fixture.rejectedReplays {
      XCTAssertThrowsError(try IntentCheckCoins.replay(boardId: fixture.scope.boardId, logicalDate: fixture.scope.logicalDate, actions: vector.actions)) {
        XCTAssertEqual(String(describing: $0), vector.reason)
      }
    }
    for vector in fixture.rejectedReconciliations {
      XCTAssertThrowsError(try IntentCoinReconciliation.reconcile(boardId: fixture.scope.boardId, logicalDate: fixture.scope.logicalDate, actions: vector.actions, rows: vector.rows)) {
        XCTAssertEqual(String(describing: $0), vector.reason)
      }
    }
  }
  func testProofExcludesClaimsButAcceptsLiveAndBaselineActions() throws {
    let liveId = "00000000-0000-4000-8000-000000000001"
    let derivedId = "00000000-0000-5000-8000-000000000001"
    let digest = String(repeating: "f", count: 64)
    let claims = [["ledger_entry", liveId, digest]]
    XCTAssertThrowsError(try IntentCoinProvenance.canonical(claims)) {
      XCTAssertEqual(String(describing: $0), "invalid")
    }
    let claimJson = "{\"version\":1,\"facts\":" + (try IntentCoinJSON.encode(claims)) + "}"
    XCTAssertThrowsError(try IntentCoinProvenance.parse(claimJson)) {
      XCTAssertEqual(String(describing: $0), "invalid")
    }
    let evidence = [["habit_action", liveId, digest], ["habit_action", derivedId, digest], ["ledger_entry", derivedId, digest]]
    XCTAssertEqual(try IntentCoinProvenance.parse(IntentCoinProvenance.canonical(evidence)), evidence)
  }
  func testProofAndPolicyAllocationBudgets() throws {
    let ids = (0..<5100).map { String(format: "00000000-0000-4000-8000-%012x", $0) }
    let facts = ids.prefix(IntentCoinJSON.proofFacts).map { ["habit_action", $0, String(repeating: "f", count: 64)] }
    let encoded = try IntentCoinProvenance.canonical(facts)
    XCTAssertLessThanOrEqual(encoded.utf8.count, IntentCoinJSON.proofBytes)
    XCTAssertEqual(try IntentCoinProvenance.parse(encoded), facts)
    XCTAssertThrowsError(try IntentCoinProvenance.canonical(facts + [facts[0]]))
    XCTAssertThrowsError(try IntentCoinProvenance.parse(String(repeating: " ", count: IntentCoinJSON.proofBytes + 1)))
    for text in ["null", "{", "{\"version\":2,\"facts\":[]}", " " + encoded] { XCTAssertThrowsError(try IntentCoinProvenance.parse(text)) }
    func policy(_ count: Int) -> IntentCoinPolicy {
      IntentCoinPolicy(version: 1, boardKind: "count", earnsCoins: true, coinCapPerDay: 1, checkClosesAtUtc: -1,
        rootId: ids[0], requiredBoardIds: Array(ids.prefix(count)), bonusClosesAtUtc: 0, bonusEnabled: true)
    }
    XCTAssertLessThanOrEqual(try policy(5000).canonical().utf8.count, IntentCoinJSON.policyBytes)
    XCTAssertThrowsError(try policy(5100).canonical())
    XCTAssertThrowsError(try IntentCoinPolicy.parse(String(repeating: " ", count: IntentCoinJSON.policyBytes + 1)))
  }
}

private struct CheckCoinFixture: Decodable {
  struct Scope: Decodable { let boardId: String; let logicalDate: String }
  struct Case: Decodable {
    let name: String; let actions: [IntentHabitAction]; let activeCheckInIds: [String]
    let target: Int64; let ordinaryRows: [IntentCoinLedgerRow]
  }
  struct Reconciliation: Decodable {
    let actions: [IntentHabitAction]; let existingRows: [IntentCoinLedgerRow]; let expectedAppend: [IntentCoinLedgerRow]
    let target: Int64; let balance: Int64
  }
  struct Policy: Decodable { let value: IntentCoinPolicy; let json: String }
  struct CanonicalRow: Decodable { let row: IntentCoinLedgerRow; let json: String }
  struct Totals: Decodable { let rows: [IntentCoinLedgerRow]; let earned: Int64; let spent: Int64; let balance: Int64 }
  struct RejectedReplay: Decodable { let actions: [IntentHabitAction]; let reason: String }
  struct RejectedProof: Decodable { let actions: [IntentHabitAction]; let rows: [IntentCoinLedgerRow]; let reason: String }
  let scope: Scope; let policy: IntentCoinPolicy; let policyJson: String; let cases: [Case]
  let correction: Reconciliation; let overlap: Reconciliation; let zeroCorrection: Reconciliation
  let validPolicies: [Policy]; let invalidPolicies: [String]; let canonicalRows: [CanonicalRow]
  let unicodeClaims: [IntentCoinLedgerRow]; let totalsCases: [Totals]; let totalsOverflow: [[IntentCoinLedgerRow]]
  let rejectedReplays: [RejectedReplay]; let rejectedReconciliations: [RejectedProof]
}
