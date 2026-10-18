import Foundation
import HabitEngine
import HabitWidgetData
import XCTest

final class NotificationNavigationTests: XCTestCase {
  @MainActor func testImportedUppercaseHabitIDRoutesFromReminderAndWidget() async throws {
    let source = AppModel(databasePath: ":memory:")
    await source.start()
    let originalID = try await createBoard(source)
    let uppercaseID = "ABCDEFAB-1234-4ABC-8DEF-123456ABCDEF"
    let backup = try await source.engine!.call("export") as! [String: Any]
    let text = (backup["text"] as! String).replacingOccurrences(of: originalID, with: uppercaseID)
    let model = AppModel(databasePath: ":memory:")
    await model.start()
    let preview = try await model.engine!.call("previewImport", [text, "json"]) as! [String: Any]
    _ = try await model.mutate("importSnapshot", ["draft": preview["draft"]!])
    XCTAssertEqual(model.boards.map(\.id), [uppercaseID])
    let response = try XCTUnwrap(HabitNotificationSelection(identifier: "habit-system.reminder.qa", userInfo: ["boardId": uppercaseID]))
    await model.openNotification(response)
    XCTAssertEqual(model.navigationDestination?.boardID, uppercaseID)
    XCTAssertEqual(model.navigationDestination?.kind, .newCheck)
    XCTAssertNil(model.error)
    model.navigationDestination = nil
    model.error = nil
    await model.openWidgetURL(WidgetSnapshotStore.destination(habitID: uppercaseID, environment: model.cloudEnvironment))
    XCTAssertEqual(model.navigationDestination?.boardID, uppercaseID)
    XCTAssertEqual(model.navigationDestination?.kind, .board)
    XCTAssertNil(model.error)
    await source.notifications?.stopAndDrain()
    await model.notifications?.stopAndDrain()
  }

  @MainActor func testColdResponseOpensAnExistingPersonalHabitAfterInitialization() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("test.db").path
    let original = AppModel(databasePath: path)
    await original.start()
    let id = try await createBoard(original)
    await original.notifications?.stopAndDrain()
    let inbox = HabitNotificationInbox()
    inbox.submit(HabitNotificationSelection(boardID: id, kind: .newCheck))
    let launched = AppModel(databasePath: path)
    launched.connectNotificationInbox(inbox)
    await launched.start()
    XCTAssertEqual(launched.navigationDestination?.boardID, id)
    XCTAssertEqual(launched.navigationDestination?.kind, .newCheck)
    XCTAssertNil(launched.pendingNavigation)
    XCTAssertNil(launched.error)
    await launched.notifications?.stopAndDrain()
  }

  @MainActor func testColdReminderAndRepeatedTapPreserveEditorDestination() async throws {
    let model = AppModel(databasePath: ":memory:")
    let inbox = HabitNotificationInbox()
    let id = UUID().uuidString.lowercased()
    inbox.submit(HabitNotificationSelection(boardID: id, kind: .newCheck))
    model.connectNotificationInbox(inbox)
    XCTAssertNotNil(model.pendingNavigation)
    await model.start()
    XCTAssertNil(model.notificationBoardID)
    XCTAssertNotNil(model.error)
    let boardID = try await createBoard(model)
    model.error = nil
    await model.openNotification(HabitNotificationSelection(boardID: boardID, kind: .newCheck))
    XCTAssertEqual(model.navigationDestination?.boardID, boardID)
    XCTAssertEqual(model.navigationDestination?.kind, .newCheck)
    let first = model.navigationDestination?.id
    await model.openNotification(HabitNotificationSelection(boardID: boardID, kind: .newCheck))
    XCTAssertNotEqual(model.navigationDestination?.id, first)
    await model.openNotification(HabitNotificationSelection(boardID: boardID, kind: .board))
    XCTAssertEqual(model.navigationDestination?.kind, .board)
    _ = try await model.mutate("archiveBoard", ["boardId": boardID])
    await model.openNotification(HabitNotificationSelection(boardID: boardID, kind: .newCheck))
    XCTAssertEqual(model.navigationDestination?.kind, .board)
    await model.notifications?.stopAndDrain()
  }

  @MainActor func testQueuedReminderAndWidgetUseOneLatestDestination() async throws {
    let model = AppModel(databasePath: ":memory:")
    await model.start()
    let id = try await createBoard(model)
    model.loading = true
    await model.openNotification(HabitNotificationSelection(boardID: id, kind: .newCheck))
    await model.openWidgetURL(WidgetSnapshotStore.destination(environment: model.cloudEnvironment))
    model.loading = false
    await model.resumePendingWidgetLink()
    XCTAssertNil(model.navigationDestination)
    model.loading = true
    await model.openWidgetURL(WidgetSnapshotStore.destination(environment: model.cloudEnvironment))
    await model.openNotification(HabitNotificationSelection(boardID: id, kind: .newCheck))
    model.loading = false
    await model.resumePendingWidgetLink()
    XCTAssertEqual(model.navigationDestination?.kind, .newCheck)
    XCTAssertEqual(model.notificationBoardID, id)
    await model.openNotification(HabitNotificationSelection(boardID: "invalid", kind: .board))
    XCTAssertEqual(model.notificationBoardID, id)
    await model.notifications?.stopAndDrain()
  }

  @MainActor func testReminderDuringSampleTransitionReturnsToPersonalStore() async throws {
    let model = AppModel(databasePath: ":memory:")
    await model.start()
    let id = try await createBoard(model)
    let transition = Task { await model.setSampleMode(true) }
    while !model.loading { await Task.yield() }
    await model.openNotification(HabitNotificationSelection(boardID: id, kind: .newCheck))
    await transition.value
    XCTAssertFalse(model.sampleMode)
    XCTAssertFalse(model.loading)
    XCTAssertEqual(model.navigationDestination?.boardID, id)
    XCTAssertEqual(model.navigationDestination?.kind, .newCheck)
    XCTAssertEqual(model.boards.map(\.title), ["Reminder habit"])
    await model.notifications?.stopAndDrain()
  }

  @MainActor private func createBoard(_ model: AppModel) async throws -> String {
    let result = try await model.mutate("createBoard", ["title": "Reminder habit", "kind": "daily", "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false, "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0, "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1, "requiredInStack": true]) as! [String: Any]
    return result["boardId"] as! String
  }
}
