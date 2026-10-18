import Foundation
import XCTest
@testable import HabitEngine

final class WidgetProjectionTests: XCTestCase {
  func testWidgetSnapshotUsesSharedCompletionAndExcludesPrivateNotes() async throws {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    let board = try await engine.call("createBoard", [["commandId": UUID().uuidString.lowercased(), "title": "Read", "kind": "daily", "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false, "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0, "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1, "requiredInStack": true]]) as! [String: Any]
    let id = board["boardId"] as! String
    let card = (try await engine.call("getHomeBoardProjection") as! [[String: Any]])[0]
    _ = try await engine.call("createCheckIn", [["commandId": UUID().uuidString.lowercased(), "boardId": id, "logicalDate": card["today"]!, "note": "private journal text", "source": "app"]])
    let snapshot = try await engine.call("getWidgetSnapshot") as! [String: Any]
    let habit = (snapshot["habits"] as! [[String: Any]])[0]
    XCTAssertEqual(habit["checkedToday"] as? Bool, true)
    XCTAssertEqual(habit["todayCount"] as? Int, 1)
    XCTAssertEqual(habit["logicalDate"] as? String, card["today"] as? String)
    XCTAssertEqual(snapshot["balance"] as? Int, 1)
    XCTAssertGreaterThan(snapshot["expiresAtUtc"] as! Double, snapshot["generatedAtUtc"] as! Double)
    let text = String(data: try JSONSerialization.data(withJSONObject: snapshot), encoding: .utf8)!
    XCTAssertFalse(text.contains("private journal text"))
    XCTAssertFalse(text.contains("mutationStamp"))
    _ = try await engine.call("archiveBoard", [["commandId": UUID().uuidString.lowercased(), "boardId": id]])
    let archived = try await engine.call("getWidgetSnapshot") as! [String: Any]
    XCTAssertEqual((archived["habits"] as? [Any])?.count, 0)
  }
}
