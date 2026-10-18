import Foundation
import UserNotifications
import XCTest
@testable import HabitEngine

private final class FakeNotificationCenter: NotificationCenterPort, @unchecked Sendable {
  var requests: [UNNotificationRequest] = []
  var adds = 0
  var removals = 0
  var permission = "granted"
  var onPending: (() -> Void)?
  func authorization() async -> String { permission }
  func requestAuthorization() async throws -> String { permission }
  func pending() async -> [UNNotificationRequest] { onPending?(); return requests }
  func deliveredIdentifiers() async -> [String] { [] }
  func add(_ request: UNNotificationRequest) async throws { adds += 1; requests.removeAll { $0.identifier == request.identifier }; requests.append(request) }
  func remove(_ identifiers: [String]) { removals += 1; requests.removeAll { identifiers.contains($0.identifier) } }
}

final class NotificationsTests: XCTestCase {
  func testRetiringRealServiceDuringCapacityReadPreventsScheduleWithoutCancellingExisting() async throws {
    let center = FakeNotificationCenter()
    center.requests = [UNNotificationRequest(identifier: "existing", content: UNMutableNotificationContent(), trigger: nil)]
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    center.onPending = { service.retire() }
    do {
      _ = try await service.handle(request: ["method": "scheduleReminder", "request": ["weekday": 1, "minuteOfDay": 0, "reminderId": "r", "boardId": "b", "title": "Read", "body": "Read"]])
      XCTFail("retired service must not schedule")
    } catch {
      XCTAssertEqual(center.adds, 0)
      XCTAssertEqual(center.removals, 0)
      XCTAssertEqual(center.requests.count, 1)
    }
  }

  func testNativeMissRefreshDeduplicatesAndConfirmsCancellationBeforeImmediateReplacement() async throws {
    let center = FakeNotificationCenter()
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let boardID = UUID().uuidString.lowercased()
    let identifier = "habit-system.miss.v1:\(boardID):2026-01-01"
    let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
    var components = Calendar.current.dateComponents([.year, .month, .day], from: tomorrow)
    components.hour = 9; components.minute = 0; components.second = 0
    let content = UNMutableNotificationContent(); content.title = "Read"; content.body = "Read was missed twice. Fix the environment before anything else today."
    content.userInfo = ["boardId": boardID, "secondMissedDate": "2026-01-01"]
    center.requests = [UNNotificationRequest(identifier: identifier, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))]
    let state = try await service.handle(request: ["method": "state"]) as! [String: Any]
    let validity: [String: Any] = ["generation": state["generation"]!, "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000, "timeZoneId": TimeZone.current.identifier]
    let date = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)
    var value: [String: Any] = ["identifier": identifier, "boardId": boardID, "secondMissedDate": "2026-01-01", "title": content.title, "body": content.body, "trigger": ["kind": "local09", "date": date]]
    let unchanged = try await service.handle(request: ["method": "scheduleMiss", "replacement": true, "guard": validity, "request": value]) as! [String: Any]
    XCTAssertEqual(unchanged["kind"] as? String, "unchanged")
    XCTAssertEqual(center.adds, 0)
    value["trigger"] = ["kind": "immediate"]
    let refreshed = try await service.handle(request: ["method": "scheduleMiss", "replacement": true, "guard": validity, "request": value]) as! [String: Any]
    XCTAssertEqual(refreshed["kind"] as? String, "accepted")
    XCTAssertEqual(center.removals, 1)
    XCTAssertEqual(center.adds, 1)
    XCTAssertNil(center.requests.first?.trigger)
  }

  func testNativeEffectRetiresWhenLifecycleChangesDuringInventoryAwait() async throws {
    let center = FakeNotificationCenter()
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let state = try await service.handle(request: ["method": "state"]) as! [String: Any]
    center.onPending = { service.invalidate() }
    let boardID = UUID().uuidString.lowercased()
    let result = try await service.handle(request: ["method": "scheduleMiss", "guard": ["generation": state["generation"]!, "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000, "timeZoneId": TimeZone.current.identifier], "request": ["identifier": "habit-system.miss.v1:\(boardID):2026-01-01", "boardId": boardID, "secondMissedDate": "2026-01-01", "title": "Read", "body": "Read was missed twice. Fix the environment before anything else today.", "trigger": ["kind": "immediate"]]]) as! [String: Any]
    XCTAssertEqual(result["kind"] as? String, "retired")
    XCTAssertEqual(center.adds, 0)
  }

  private func makeHabit(_ engine: EngineHost) async throws -> String {
    let result = try await engine.call("createBoard", [["commandId": UUID().uuidString.lowercased(), "title": "Read", "kind": "daily",
      "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false, "tracksAmount": false,
      "tracksTime": false, "startOfDayMinute": 0, "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1]]) as! [String: Any]
    return result["boardId"] as! String
  }

  func testSharedReminderCommandsPreserveDeniedDraftAndCancelDeletedSchedule() async throws {
    let center = FakeNotificationCenter(); center.permission = "denied"
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize"); await service.install(on: engine)
    let boardID = try await makeHabit(engine)
    let created = try await engine.call("createReminder", [["commandId": UUID().uuidString.lowercased(), "boardId": boardID,
      "weekdaysMask": 65, "minuteOfDay": 600, "message": "Read a page", "enabled": true]]) as! [String: Any]
    XCTAssertEqual(created["scheduleState"] as? String, "denied")
    XCTAssertEqual(center.adds, 0)
    let reminderID = created["reminderId"] as! String
    center.permission = "granted"
    _ = try await engine.call("setReminderEnabled", [["commandId": UUID().uuidString.lowercased(), "reminderId": reminderID, "enabled": true]])
    XCTAssertEqual(center.requests.count, 2)
    _ = try await engine.call("reconcileNotifications")
    XCTAssertEqual(center.adds, 2)
    _ = try await engine.call("deleteReminder", [["commandId": UUID().uuidString.lowercased(), "reminderId": reminderID]])
    XCTAssertEqual(center.requests.count, 0)
  }

  func testSharedReconciliationPreservesMissAlertsWithoutDuplicateAndCancelsAfterBackfill() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    defer { try? FileManager.default.removeItem(atPath: path) }
    let center = FakeNotificationCenter()
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let engine = try EngineHost(databasePath: path)
    _ = try await engine.call("initialize"); await service.install(on: engine)
    let boardID = try await makeHabit(engine)
    let database = try SQLiteStore(path: path)
    _ = try database.statement("UPDATE board_activity_periods SET start_date = '2020-01-01' WHERE board_id = ?", parameters: [boardID], rows: false)
    _ = try await engine.call("reconcileNotifications")
    XCTAssertEqual(center.adds, 1)
    let request = try XCTUnwrap(center.requests.first)
    XCTAssertTrue(request.identifier.hasPrefix("habit-system.miss.v1:"))
    _ = try await engine.call("reconcileNotifications")
    XCTAssertEqual(center.adds, 1)
    XCTAssertEqual(center.requests.count, 1)
    let date = try XCTUnwrap(request.content.userInfo["secondMissedDate"] as? String)
    _ = try await engine.call("createCheckIn", [["commandId": UUID().uuidString.lowercased(), "boardId": boardID, "logicalDate": date, "source": "app"]])
    _ = try await engine.call("reconcileNotifications")
    XCTAssertEqual(center.requests.count, 0)
  }

  func testSampleNeverPromptsOrSchedulesAndNeverTouchesRealInventory() async throws {
    let center = FakeNotificationCenter()
    let service = HabitNotificationService(center: center, effectsEnabled: false)
    let authorization = try await service.handle(request: ["method": "requestAuthorization"]) as? String
    XCTAssertEqual(authorization, "denied")
    do { _ = try await service.handle(request: ["method": "scheduleReminder", "request": [:]]); XCTFail("sample effects must fail") }
    catch { XCTAssertEqual(center.adds, 0) }
  }

  func testWeeklyReminderUsesLocalISOWeekdayAndReportsActualTrigger() async throws {
    let center = FakeNotificationCenter()
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let identifier = try await service.handle(request: ["method": "scheduleReminder", "request": [
      "reminderId": "r", "boardId": "b", "weekday": 7, "minuteOfDay": 545, "title": "Read", "body": "Pages"
    ]]) as! String
    let request = try XCTUnwrap(center.requests.first)
    let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
    XCTAssertEqual(trigger.dateComponents.weekday, 1)
    XCTAssertNil(trigger.dateComponents.timeZone)
    XCTAssertTrue(trigger.repeats)
    let inventory = try await service.handle(request: ["method": "pending"]) as! [[String: Any]]
    XCTAssertEqual(inventory.first?["identifier"] as? String, identifier)
    let weekly = inventory.first?["reminder"] as? [String: Any]
    XCTAssertEqual(weekly?["weekday"] as? Int, 7)
    XCTAssertEqual(weekly?["minuteOfDay"] as? Int, 545)
  }

  func testCapacityCheckedAtDispatchAndRetiredMissCannotSchedule() async throws {
    let center = FakeNotificationCenter()
    center.requests = (0..<64).map { UNNotificationRequest(identifier: String($0), content: UNMutableNotificationContent(), trigger: nil) }
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    do {
      _ = try await service.handle(request: ["method": "scheduleReminder", "request": ["weekday": 1, "minuteOfDay": 0, "reminderId": "r", "boardId": "b", "title": "x", "body": "x"]])
      XCTFail("capacity must be enforced")
    } catch { XCTAssertEqual(center.adds, 0) }
    let state = try await service.handle(request: ["method": "state"]) as! [String: Any]
    service.setForeground(false)
    let result = try await service.handle(request: ["method": "scheduleMiss", "guard": ["generation": state["generation"]!, "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000, "timeZoneId": TimeZone.current.identifier], "request": [:]]) as! [String: Any]
    XCTAssertEqual(result["kind"] as? String, "retired")
    XCTAssertEqual(center.adds, 0)
  }

  func testMalformedOrPinnedWeeklyRequestRemainsVisibleAsOrphan() async throws {
    let center = FakeNotificationCenter()
    let content = UNMutableNotificationContent()
    content.userInfo = ["boardId": "b", "reminderId": "r"]
    var components = DateComponents(); components.weekday = 2; components.hour = 9; components.minute = 0; components.year = 2030
    center.requests = [UNNotificationRequest(identifier: "orphan", content: content, trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true))]
    let service = HabitNotificationService(center: center, effectsEnabled: true)
    let pending = try await service.handle(request: ["method": "pending"]) as! [[String: Any]]
    XCTAssertEqual(pending.count, 1)
    XCTAssertTrue(pending[0]["reminder"] is NSNull)
  }
}
