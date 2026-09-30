import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentBonusCoinsTests: XCTestCase {
  private let root = "00000000-0000-4000-8000-000000000001"
  private let member = "00000000-0000-4000-8000-000000000002"
  private let date = "2026-09-08"

  func testSharedBonusCauseEncodingAndReplayVectors() throws {
    let fixture = try fixture()
    for vector in fixture.encodingCases {
      let policy = try IntentCoinPolicy.parse(vector.effectivePolicyJson)
      XCTAssertEqual(try IntentBonusCoins.fingerprint(policy), vector.expectedBonusPolicyFingerprint, vector.name)
      XCTAssertEqual(IntentCoinProvenance.digest(vector.expectedBonusPolicyName), vector.expectedBonusPolicyFingerprint, vector.name)
      XCTAssertEqual(IntentHabitAction.uuidV5(name: vector.expectedUuidName), vector.expectedAwardRow.id, vector.name)
      XCTAssertEqual(try IntentBonusCoins.award(vector.sourceAction, policy: policy), vector.expectedAwardRow, vector.name)
      XCTAssertEqual(try IntentBonusCoins.reversal(vector.removalAction, award: vector.expectedAwardRow), vector.expectedReversalRow, vector.name)
    }
    for vector in fixture.replayCases {
      for actions in [vector.actions, Array(vector.actions.reversed()), vector.actions + vector.actions] {
        let result = try IntentBonusCoins.replay(rootId: vector.scope.rootId, logicalDate: vector.scope.logicalDate, actions: actions)
        XCTAssertEqual(result.target, vector.expectedTarget, vector.name)
        XCTAssertEqual(result.ordinaryRows, vector.expectedOrdinaryRows, vector.name)
      }
    }
  }

  func testSharedBonusReconciliationRowsAndFixedPoints() throws {
    for vector in try fixture().reconciliationCases {
      for (actions, rows) in [(vector.actions, vector.rows), (Array(vector.actions.reversed()), Array(vector.rows.reversed())),
                              (vector.actions + vector.actions, vector.rows + vector.rows)] {
        let result = try IntentCoinReconciliation.reconcileBonus(rootId: vector.scope.rootId,
          logicalDate: vector.scope.logicalDate, actions: actions, rows: rows)
        XCTAssertEqual(result.appendedRows, vector.expectedAppendedRows, vector.name)
        XCTAssertEqual(result.target, vector.expectedTarget, vector.name)
        XCTAssertEqual(result.balance, vector.expectedBalance, vector.name)
        let repeated = try IntentCoinReconciliation.reconcileBonus(rootId: vector.scope.rootId,
          logicalDate: vector.scope.logicalDate, actions: actions, rows: rows + result.appendedRows)
        XCTAssertEqual(repeated.appendedRows, [], vector.name)
        XCTAssertEqual(repeated.target, vector.expectedTarget, vector.name)
        XCTAssertEqual(repeated.balance, vector.expectedBalance, vector.name)
      }
    }
  }

  func testGenuineCompletionUsesLiteralBonusIdentityWithoutCheckEarning() throws {
    let first = try action(101, board: root, token: 201)
    let final = try action(102, board: member, token: 202)
    XCTAssertEqual(try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: [first]).target, 0)
    let replay = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: [final, first, final])
    XCTAssertEqual(replay.target, 1)
    XCTAssertEqual(replay.ordinaryRows, [IntentCoinLedgerRow(
      id: "94f8e281-8593-57b6-8a92-9c67d148560c", kind: "run_bonus", delta: 1,
      boardId: nil, checkInId: nil, runKey: "\(root)|\(date)", rewardId: nil, rewardTitleSnapshot: nil,
      reversesId: nil, scopeKey: "bonus:\(root):\(date)", sourceActionId: final.id,
      reconciliationKey: nil, adjustsId: nil, provenanceJson: nil, logicalDate: date,
      createdAt: final.createdAt, mutationStamp: final.mutationStamp, deletedAt: nil)] )
  }

  func testTimelyRemovalReversesAndGenuineRecompletionCreatesAnotherAward() throws {
    let first = try action(101, board: root, token: 201)
    let final = try action(102, board: member, token: 202)
    let remove = try action(103, board: member, token: 202, kind: "uncheck")
    let removed = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: [first, final, remove])
    XCTAssertEqual(removed.target, 0)
    XCTAssertEqual(removed.ordinaryRows.map(\.delta), [1, -1])
    XCTAssertEqual(removed.ordinaryRows.last?.id, "db4803fa-9e3a-50f2-9c89-11f9a57d65fb")
    XCTAssertEqual(removed.ordinaryRows.last?.reversesId, removed.ordinaryRows.first?.id)
    let again = try action(104, board: member, token: 204)
    let restored = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: [first, final, remove, again])
    XCTAssertEqual(restored.target, 1)
    XCTAssertEqual(restored.ordinaryRows.map(\.delta), [1, -1, 1])
    XCTAssertNotEqual(restored.ordinaryRows.first?.id, restored.ordinaryRows.last?.id)
  }

  func testClosingInstantKeepsTheBonusAndBlocksAnotherNetAward() throws {
    let first = try action(101, board: root, token: 201)
    let final = try action(102, board: member, token: 202)
    let remove = try action(103, board: member, token: 202, kind: "uncheck", instant: 10_000)
    let again = try action(104, board: member, token: 204, instant: 10_001)
    let replay = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: [first, final, remove, again])
    XCTAssertEqual(replay.target, 1)
    XCTAssertEqual(replay.ordinaryRows.map(\.delta), [1])
  }

  func testLocallyValidDuplicateBonusesReconcileAndReachAFixedPoint() throws {
    let first = try action(101, board: root, token: 201)
    let final = try action(102, board: member, token: 202)
    let offline = try action(103, board: member, token: 203)
    let firstAward = try IntentBonusCoins.award(final, policy: IntentCoinPolicy.parse(final.policyJson!))
    let offlineAward = try IntentBonusCoins.award(offline, policy: IntentCoinPolicy.parse(offline.policyJson!))
    let actions = [first, final, offline]
    let result = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: actions, rows: [firstAward, offlineAward])
    XCTAssertEqual(result.target, 1)
    XCTAssertEqual(result.balance, 1)
    XCTAssertEqual(result.appendedRows.map(\.kind), ["adjustment"])
    XCTAssertEqual(result.appendedRows.map(\.delta), [-1])
    XCTAssertEqual(try IntentCoinProvenance.parse(XCTUnwrap(result.appendedRows.first?.provenanceJson)).count, 5)
    let repeated = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: actions.reversed(), rows: [offlineAward, firstAward] + result.appendedRows)
    XCTAssertEqual(repeated.appendedRows, [])
    XCTAssertEqual(repeated.balance, 1)
  }

  func testTimelyRemovalConsumesItsWitnessEvenWhenAnotherTokenKeepsTheBonus() throws {
    let prefix = try [action(101, board: root, token: 201), action(102, board: member, token: 202),
      action(103, board: member, token: 203), action(104, board: member, token: 202, kind: "uncheck"),
      action(105, board: member, token: nil, kind: "uncheck", instant: 10_000),
      action(106, board: member, token: 202, kind: "uncheck", instant: 9_000)]
    let held = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: prefix)
    XCTAssertEqual(held.target, 1)
    XCTAssertEqual(held.ordinaryRows.map(\.delta), [1])
    let unknown = try action(107, board: member, token: 999, kind: "uncheck", instant: 9_001)
    XCTAssertEqual(try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: prefix + [unknown]).target, 1)
    for token in [203, nil] as [Int?] {
      let timely = try action(108, board: member, token: token, kind: "uncheck", instant: 9_002)
      let result = try IntentBonusCoins.replay(rootId: root, logicalDate: date, actions: prefix + [timely])
      XCTAssertEqual(result.target, 0)
      XCTAssertEqual(result.ordinaryRows.map(\.delta), [1, -1])
      XCTAssertEqual(result.ordinaryRows.last?.sourceActionId, timely.id)
    }
  }

  func testAdmissibleRawConsumedAndPreAwardDeadTargetsAreCorrectedInsteadOfRejected() throws {
    let first = try action(101, board: root, token: 201)
    let final = try action(102, board: member, token: 202)
    let award = try IntentBonusCoins.award(final, policy: IntentCoinPolicy.parse(final.policyJson!))
    let duplicate = try action(103, board: member, token: 203)
    let consumed = try action(104, board: member, token: 202, kind: "uncheck")
    let late = try action(105, board: member, token: nil, kind: "uncheck", instant: 10_000)
    let repeated = try action(106, board: member, token: 202, kind: "uncheck", instant: 9_000)
    let raw = try [IntentBonusCoins.reversal(consumed, award: award), IntentBonusCoins.reversal(repeated, award: award)]
    let result = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [first, final, duplicate, consumed, late, repeated], rows: [award] + raw + raw)
    XCTAssertEqual(result.target, 1)
    XCTAssertEqual(result.balance, 1)
    XCTAssertEqual(result.appendedRows.map(\.delta), [2])
    let old = try action(99, board: member, token: 299)
    let removedBeforeAward = try action(100, board: member, token: 299, kind: "uncheck")
    let oldTarget = try action(107, board: member, token: 299, kind: "uncheck")
    let historical = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [old, removedBeforeAward, first, final, oldTarget],
      rows: [award, IntentBonusCoins.reversal(oldTarget, award: award)])
    XCTAssertEqual(historical.target, 1)
    XCTAssertEqual(historical.balance, 1)
    XCTAssertEqual(historical.appendedRows.map(\.delta), [1])
  }

  func testMissingControlDefersOrphanSourceAndLaterControlRecoversExactAward() throws {
    let (control, first, final, policy) = try controlled()
    let row = try IntentBonusCoins.award(final, policy: policy)
    XCTAssertThrowsError(try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [first, final], rows: [row])) { XCTAssertEqual(String(describing: $0), "missing") }
    let result = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [control, first, final], rows: [row])
    XCTAssertEqual(result.target, 1)
    XCTAssertEqual(result.balance, 1)
    XCTAssertEqual(result.appendedRows, [])
    let unmatched = try changing(row, ["id": "eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee"])
    XCTAssertThrowsError(try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [control, first, final], rows: [unmatched])) { XCTAssertEqual(String(describing: $0), "missing") }
    let wrongMetadata = try changing(row, ["createdAt": 999])
    XCTAssertThrowsError(try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: [control, first, final], rows: [wrongMetadata])) { XCTAssertEqual(String(describing: $0), "invalid") }
  }

  func testCorrectionSubsetCannotBorrowItsMissingControlFromFullEvidence() throws {
    let (control, first, final, policy) = try controlled()
    let offline = try replacingPolicy(action(103, board: member, token: 203), with: nil)
    let rows = try [IntentBonusCoins.award(final, policy: policy), IntentBonusCoins.award(offline, policy: policy)]
    let actions = [control, first, final, offline]
    let full = try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date, actions: actions, rows: rows)
    let correction = try XCTUnwrap(full.appendedRows.first)
    let facts = try IntentCoinProvenance.parse(XCTUnwrap(correction.provenanceJson)).filter { $0[1] != control.id }
    let proof = try IntentCoinProvenance.canonical(facts)
    let digest = IntentCoinProvenance.digest(proof)
    let name = try IntentCoinJSON.encode(["habit-ledger-v1", "adjustment", "bonus:\(root):\(date)", digest])
    let incomplete = try changing(correction, ["id": IntentHabitAction.uuidV5(name: name), "provenanceJson": proof, "reconciliationKey": digest])
    XCTAssertThrowsError(try IntentCoinReconciliation.reconcileBonus(rootId: root, logicalDate: date,
      actions: actions, rows: rows + [incomplete])) { XCTAssertEqual(String(describing: $0), "invalid") }
  }

  func testManyPartialAwardsRecoverPoliciesWithinOneEvidenceSet() throws {
    var actions: [IntentHabitAction] = []
    var rows: [IntentCoinLedgerRow] = []
    let first = try action(1999, board: root, token: 2001)
    let final = try action(2000, board: member, token: 2002)
    for number in 1000..<1300 {
      let policy = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: false, coinCapPerDay: 1,
        checkClosesAtUtc: 8000, rootId: root, requiredBoardIds: [root, member], bonusClosesAtUtc: Int64(10000 + number), bonusEnabled: true)
      actions.append(try replacingPolicy(action(number, board: root, token: nil, kind: "policy"), with: policy))
      rows.append(try IntentBonusCoins.award(final, policy: policy))
    }
    actions += [first, final]
    try IntentBonusCoinCauses.validateOrdinary(rootId: root, actions: actions, rows: rows)
    XCTAssertEqual(Set(rows.map(\.id)).count, 300)
  }

  func testSharedFailureClassification() throws {
    for item in try fixture().errorCases {
      XCTAssertThrowsError(try {
        if item.operation == "replay" {
          _ = try IntentBonusCoins.replay(rootId: item.scope.rootId, logicalDate: item.scope.logicalDate, actions: item.actions)
        } else {
          _ = try IntentCoinReconciliation.reconcileBonus(rootId: item.scope.rootId, logicalDate: item.scope.logicalDate,
            actions: item.actions, rows: item.rows)
        }
      }(), item.name) { XCTAssertEqual(String(describing: $0), item.expectedReason, item.name) }
    }
  }

  private func action(_ suffix: Int, board: String, token: Int?, kind: String = "check", instant: Int64? = nil) throws -> IntentHabitAction {
    let policy = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: false, coinCapPerDay: 1,
      checkClosesAtUtc: 8_000, rootId: root, requiredBoardIds: [root, member], bonusClosesAtUtc: 10_000, bonusEnabled: true)
    return IntentHabitAction(id: id(suffix), commandId: id(suffix + 1000), boardId: board, logicalDate: date,
      checkInId: token.map(id), kind: kind, createdAt: instant ?? Int64(suffix),
      mutationStamp: String(format: "%014d-00000-native", suffix), policyJson: try policy.canonical())
  }

  private func id(_ suffix: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", suffix) }

  private func controlled() throws -> (IntentHabitAction, IntentHabitAction, IntentHabitAction, IntentCoinPolicy) {
    let policy = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: false, coinCapPerDay: 1,
      checkClosesAtUtc: 8_000, rootId: root, requiredBoardIds: [root, member], bonusClosesAtUtc: 20_000, bonusEnabled: true)
    return try (replacingPolicy(action(100, board: root, token: nil, kind: "policy"), with: policy),
      replacingPolicy(action(101, board: root, token: 201), with: nil),
      replacingPolicy(action(102, board: member, token: 202), with: nil), policy)
  }

  private func replacingPolicy(_ action: IntentHabitAction, with policy: IntentCoinPolicy?) throws -> IntentHabitAction {
    let fallback = IntentCoinPolicy(version: 1, boardKind: "daily", earnsCoins: false, coinCapPerDay: 1,
      checkClosesAtUtc: 8_000, rootId: nil, requiredBoardIds: [], bonusClosesAtUtc: nil, bonusEnabled: false)
    return IntentHabitAction(id: action.id, commandId: action.commandId, boardId: action.boardId, logicalDate: action.logicalDate,
      checkInId: action.checkInId, kind: action.kind, createdAt: action.createdAt, mutationStamp: action.mutationStamp,
      policyJson: try (policy ?? fallback).canonical())
  }

  private func changing(_ row: IntentCoinLedgerRow, _ values: [String: Any]) throws -> IntentCoinLedgerRow {
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(row)) as? [String: Any])
    for (key, value) in values { json[key] = value }
    return try JSONDecoder().decode(IntentCoinLedgerRow.self, from: JSONSerialization.data(withJSONObject: json))
  }

  private func fixture() throws -> NativeBonusFixture {
    let file = CoinStoreHarness.root.appendingPathComponent("src/core/automations/fixtures/bonus-coins.json")
    return try JSONDecoder().decode(NativeBonusFixture.self, from: Data(contentsOf: file))
  }
}

private struct NativeBonusFixture: Decodable {
  struct Scope: Decodable { let rootId: String; let logicalDate: String }
  struct Encoding: Decodable {
    let name: String; let sourceAction: IntentHabitAction; let removalAction: IntentHabitAction
    let effectivePolicyJson: String; let expectedBonusPolicyName: String
    let expectedBonusPolicyFingerprint: String; let expectedUuidName: String
    let expectedAwardRow: IntentCoinLedgerRow; let expectedReversalRow: IntentCoinLedgerRow
  }
  struct Replay: Decodable {
    let name: String; let scope: Scope; let actions: [IntentHabitAction]
    let expectedOrdinaryRows: [IntentCoinLedgerRow]; let expectedTarget: Int64
  }
  struct Reconciliation: Decodable {
    let name: String; let scope: Scope; let actions: [IntentHabitAction]; let rows: [IntentCoinLedgerRow]
    let expectedAppendedRows: [IntentCoinLedgerRow]; let expectedTarget: Int64; let expectedBalance: Int64
  }
  struct Failure: Decodable {
    let name: String; let operation: String; let scope: Scope; let actions: [IntentHabitAction]
    let rows: [IntentCoinLedgerRow]; let expectedReason: String
  }
  let errorCases: [Failure]
  let encodingCases: [Encoding]; let replayCases: [Replay]; let reconciliationCases: [Reconciliation]
}
