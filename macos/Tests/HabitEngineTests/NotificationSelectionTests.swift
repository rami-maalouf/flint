import XCTest
@testable import HabitEngine

final class NotificationSelectionTests: XCTestCase {
  @MainActor func testInboxRetainsLatestResponseUntilConsumerAttaches() {
    let inbox = HabitNotificationInbox()
    let first = HabitNotificationSelection(boardID: UUID().uuidString, kind: .board)
    let last = HabitNotificationSelection(boardID: UUID().uuidString, kind: .newCheck)
    inbox.submit(first)
    inbox.submit(last)
    var received: [HabitNotificationSelection] = []
    inbox.attach { received.append($0) }
    XCTAssertEqual(received, [last])
    inbox.submit(last)
    XCTAssertEqual(received, [last, last])
  }

  func testOnlyKnownResponseKindsAndValidBoardIdentifiersRoute() {
    let id = UUID().uuidString.lowercased()
    XCTAssertEqual(HabitNotificationSelection(identifier: "habit-system.reminder.123", userInfo: ["boardId": id])?.kind, .newCheck)
    XCTAssertEqual(HabitNotificationSelection(identifier: "habit-system.miss.v1:\(id):2026-10-18", userInfo: ["boardId": id])?.kind, .board)
    XCTAssertNil(HabitNotificationSelection(identifier: "unrelated", userInfo: ["boardId": id]))
    XCTAssertNil(HabitNotificationSelection(identifier: "habit-system.reminder.123", userInfo: ["boardId": "invalid"]))
  }
}
