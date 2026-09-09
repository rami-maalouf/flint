import Foundation
import XCTest
@testable import RipplesIntentCore

final class IntentHabitActionsTests: XCTestCase {
  func testCompleteFoldPreservesAllSurvivingTokensInFinalAddOrder() throws {
    let board = "00000000-0000-4000-8000-000000000010"
    let first = "00000000-0000-4000-8000-000000000011", second = "00000000-0000-4000-8000-000000000012"
    func action(_ index: Int, _ kind: String, _ token: String?) -> IntentHabitAction {
      .init(id: String(format: "00000000-0000-4000-8000-%012d", index), commandId: board,
        boardId: board, logicalDate: "2026-08-30", checkInId: token, kind: kind, createdAt: Int64(index),
        mutationStamp: String(format: "%014d-00000-device", index), policyJson: nil)
    }
    let added = [action(1, "check", first), action(2, "move_in", second), action(3, "check", first)]
    XCTAssertEqual(IntentHabitAction.activeCheckInIds(added.reversed()), [second, first])
    XCTAssertEqual(IntentHabitAction.activeCheckInIds(added + [action(4, "move_out", first)]), [second])
    XCTAssertEqual(IntentHabitAction.activeCheckInIds(added + [action(4, "uncheck", nil), action(5, "move_in", second)]), [second])
    XCTAssertEqual(IntentHabitAction.effectiveCheckInId(added), first)
  }

  func testSharedUnicodeAndBaselineIdentityVectors() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("src/core/automations/fixtures/habit-actions.json"))
    let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(IntentHabitAction.namespace, fixture["namespace"] as? String)
    for vector in fixture["uuidVectors"] as! [[String: String]] {
      XCTAssertEqual(IntentHabitAction.uuidV5(name: vector["name"]!), vector["id"])
    }
    let baseline = fixture["baseline"] as! [String: Any]
    let source = baseline["source"] as! [String: String]
    let action = try IntentHabitAction.baseline(checkInId: source["id"]!, boardId: source["boardId"]!, date: source["logicalDate"]!)
    XCTAssertEqual(action.id, baseline["id"] as? String)
    XCTAssertEqual(action.createdAt, baseline["createdAt"] as? Int64)
    XCTAssertEqual(action.mutationStamp, baseline["mutationStamp"] as? String)
    XCTAssertNil(action.commandId)
    XCTAssertNil(action.policyJson)
    for entry in fixture["foldCases"] as! [[String: Any]] {
      let encoded = try JSONSerialization.data(withJSONObject: entry["actions"]!)
      let actions = try JSONDecoder().decode([IntentHabitAction].self, from: encoded)
      let winner = IntentHabitAction.effectiveCheckInId(actions)
      XCTAssertEqual(winner, entry["checkInId"] as? String, entry["name"] as! String)
      XCTAssertEqual(winner != nil, entry["checked"] as? Bool, entry["name"] as! String)
      XCTAssertEqual(IntentHabitAction.effectiveCheckInId(actions.reversed()), winner)
    }
  }
}
