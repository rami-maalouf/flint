import Foundation
import HabitWidgetData
import XCTest

final class WidgetNavigationTests: XCTestCase {
  @MainActor func testWidgetLinkDuringSampleInitializationReturnsToOriginalStore() async throws {
    let model = AppModel(databasePath: ":memory:")
    await model.start()
    XCTAssertTrue(model.ready)
    let result = try await model.mutate("createBoard", ["title": "Original habit", "kind": "daily", "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false, "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0, "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1, "requiredInStack": true]) as! [String: Any]
    let id = result["boardId"] as! String
    model.showNewHabit = true
    let transition = Task { await model.setSampleMode(true) }
    while !model.loading { await Task.yield() }
    await model.openWidgetURL(WidgetSnapshotStore.destination(habitID: id, environment: model.cloudEnvironment))
    XCTAssertNotNil(model.pendingWidgetURL)
    await transition.value
    XCTAssertFalse(model.sampleMode)
    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.showNewHabit)
    XCTAssertNil(model.pendingWidgetURL)
    XCTAssertEqual(model.notificationBoardID, id)
    XCTAssertEqual(model.boards.map(\.title), ["Original habit"])
    await model.notifications?.stopAndDrain()
  }

  @MainActor func testColdWidgetLinkWaitsForInitializationAndRejectsWrongEnvironment() async {
    let model = AppModel(databasePath: ":memory:")
    let wrongEnvironment = model.cloudEnvironment == "Development" ? "Production" : "Development"
    await model.openWidgetURL(WidgetSnapshotStore.destination(environment: wrongEnvironment))
    XCTAssertNil(model.pendingWidgetURL)
    await model.openWidgetURL(WidgetSnapshotStore.destination(environment: model.cloudEnvironment))
    XCTAssertNotNil(model.pendingWidgetURL)
    await model.start()
    XCTAssertNil(model.pendingWidgetURL)
    XCTAssertEqual(model.section, .today)
    await model.notifications?.stopAndDrain()
  }
}
