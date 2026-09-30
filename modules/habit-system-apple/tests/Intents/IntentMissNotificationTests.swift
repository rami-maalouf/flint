import Foundation
import UserNotifications
import XCTest
@testable import HabitSystemIntentCore

@MainActor final class IntentMissNotificationTests: XCTestCase {
  @MainActor private final class Harness {
    var permission: UNAuthorizationStatus = .authorized
    var pending: [UNNotificationRequest] = []
    var presented: [String] = []
    var added: [UNNotificationRequest] = []
    var removed: [String] = []
    var reject = false
    var keepRemoved = false
    var onPending: (() -> Void)?
    var onPresented: (() -> Void)?
    var onAdd: (() -> Void)?
    lazy var adapter = IntentMissNotifications(api: .init(
      authorization: { self.permission }, pending: { self.onPending?(); return self.pending },
      presented: { self.onPresented?(); return self.presented }, add: { request in
        self.added.append(request)
        self.onAdd?()
        if self.reject { throw IntentFailure.database }
        self.pending.removeAll { $0.identifier == request.identifier }
        self.pending.append(request)
      }, remove: { ids in
        self.removed.append(contentsOf: ids)
        if !self.keepRemoved { self.pending.removeAll { ids.contains($0.identifier) } }
      }))
    let content = IntentMissContent(pair: .init(boardId: "00000000-0000-4000-8000-00000000A001", secondDate: "2026-09-08"), title: "Thé 水")
    func request(_ trigger: IntentMissTrigger = .local09("2035-01-02")) -> IntentMissRequest {
      .init(content: content, trigger: trigger, zone: TimeZone.current.identifier)
    }
    func native(_ id: String, content: UNNotificationContent = UNMutableNotificationContent()) -> UNNotificationRequest {
      UNNotificationRequest(identifier: id, content: content, trigger: nil)
    }
  }

  func testPermissionMappingMatchesInstalledExpoWithoutPrompt() async throws {
    let h = Harness()
    for raw in 0...5 {
      h.permission = UNAuthorizationStatus(rawValue: raw)!
      let actual = try await h.adapter.authorization()
      XCTAssertEqual(actual, raw == UNAuthorizationStatus.authorized.rawValue ? .granted : raw == UNAuthorizationStatus.denied.rawValue ? .denied : .undetermined)
    }
  }

  func testActualOneShotCalendarUsesExactPayloadAndUnpinnedIsoCalendar() async throws {
    for date in ["2035-01-02", "2035-12-31"] {
      let h = Harness()
      let outcome = await h.adapter.put(h.request(.local09(date)), replacing: nil, isCurrent: { true })
      XCTAssertEqual(outcome, .accepted)
      let request = try XCTUnwrap(h.added.first)
      XCTAssertEqual(request.identifier, h.content.identifier)
      XCTAssertEqual(Array(request.content.title.utf8), Array(h.content.title.utf8))
      XCTAssertEqual(Array(request.content.body.utf8), Array(h.content.body.utf8))
      XCTAssertEqual(request.content.userInfo as? [String: String], h.content.data)
      XCTAssertNotNil(request.content.sound)
      let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
      XCTAssertFalse(trigger.repeats)
      XCTAssertEqual(trigger.dateComponents.calendar?.identifier, .iso8601)
      XCTAssertNil(trigger.dateComponents.timeZone)
      XCTAssertEqual(trigger.dateComponents.year, 2035)
      XCTAssertEqual(trigger.dateComponents.month, date == "2035-01-02" ? 1 : 12)
      XCTAssertEqual(trigger.dateComponents.hour, 9)
      XCTAssertEqual(trigger.dateComponents.minute, 0)
      XCTAssertEqual(trigger.dateComponents.second, 0)
      XCTAssertNotNil(trigger.nextTriggerDate())
      let inventory = try await h.adapter.pending()
      XCTAssertEqual(inventory.first?.content?.data, h.content.data)
      XCTAssertNotNil(inventory.first?.nextFire)
    }
  }

  func testImmediateAndKnownRejectionAreFactualEvenAfterRetirement() async throws {
    let h = Harness()
    var current = true
    h.onAdd = { current = false }
    let accepted = await h.adapter.put(h.request(.immediate), replacing: nil, isCurrent: { current })
    XCTAssertEqual(accepted, .accepted)
    XCTAssertNil(h.added.first?.trigger)
    let other = Harness()
    other.reject = true
    let rejected = await other.adapter.put(other.request(), replacing: nil, isCurrent: { true })
    XCTAssertEqual(rejected, .notAccepted)
    XCTAssertEqual(other.added.count, 1)
  }

  func testCapacityCountsAllFamiliesAndPermissionOrRetirementDispatchesNothing() async throws {
    for mode in ["capacity", "denied", "retired"] {
      let h = Harness()
      var current = true
      if mode == "capacity" { h.pending = (0..<64).map { h.native("ordinary-\($0)") } }
      if mode == "denied" { h.permission = .denied }
      if mode == "retired" { h.onPending = { current = false } }
      let outcome = await h.adapter.put(h.request(), replacing: nil, isCurrent: { current })
      XCTAssertEqual(outcome, mode == "retired" ? .retired : .notAccepted, mode)
      XCTAssertEqual(h.added.count, 0, mode)
    }
  }

  func testExistingIdentifierNeverAuthorizesFreshReissueAndFutureRefreshIsExact() async throws {
    let h = Harness()
    _ = await h.adapter.put(h.request(), replacing: nil, isCurrent: { true })
    let inventory = try await h.adapter.pending()
    let existing = try XCTUnwrap(inventory.first)
    let duplicate = await h.adapter.put(h.request(), replacing: nil, isCurrent: { true })
    XCTAssertEqual(duplicate, .accepted)
    let same = await h.adapter.put(h.request(), replacing: existing, isCurrent: { true })
    XCTAssertEqual(same, .unchanged)
    XCTAssertEqual(h.added.count, 1)
    let immediate = await h.adapter.put(h.request(.immediate), replacing: existing, isCurrent: { true })
    XCTAssertEqual(immediate, .accepted)
    XCTAssertNil(h.added.last?.trigger)
    let absent = Harness()
    let retired = await absent.adapter.put(absent.request(), replacing: existing, isCurrent: { true })
    XCTAssertEqual(retired, .retired)
    XCTAssertEqual(absent.added.count, 0)
    let malformed = Harness()
    malformed.pending = [malformed.native(malformed.content.identifier)]
    let unknown = await malformed.adapter.put(malformed.request(), replacing: nil, isCurrent: { true })
    XCTAssertEqual(unknown, .unknown)
    XCTAssertEqual(malformed.added.count, 0)
  }

  func testCancellationObservesOnlyPendingRemovalAndKeepsDelivered() async throws {
    let h = Harness()
    h.pending = [h.native("ordinary"), h.native(h.content.identifier)]
    h.presented = [h.content.identifier]
    try await h.adapter.cancel(h.content.identifier)
    XCTAssertEqual(h.removed, [h.content.identifier])
    XCTAssertEqual(h.pending.map(\.identifier), ["ordinary"])
    XCTAssertEqual(h.presented, [h.content.identifier])
    h.pending.append(h.native(h.content.identifier))
    h.keepRemoved = true
    do { try await h.adapter.cancel(h.content.identifier); XCTFail("still pending is not confirmed removal") }
    catch {}
  }

  func testOnlyExactUnpinnedNineCalendarSuppliesFutureRefreshAuthority() async throws {
    for mode in ["minute", "pinned", "missing-year", "weekday", "repeating"] {
      let h = Harness()
      _ = await h.adapter.put(h.request(), replacing: nil, isCurrent: { true })
      let original = try XCTUnwrap(h.added.first)
      var components = (original.trigger as! UNCalendarNotificationTrigger).dateComponents
      if mode == "minute" { components.minute = 17 }
      if mode == "pinned" { components.timeZone = TimeZone(identifier: "UTC") }
      if mode == "missing-year" { components.year = nil }
      if mode == "weekday" { components.weekday = 3 }
      h.pending = [UNNotificationRequest(identifier: original.identifier, content: original.content,
        trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: mode == "repeating"))]
      let inventory = try await h.adapter.pending()
      let existing = try XCTUnwrap(inventory.first)
      XCTAssertNotNil(existing.content, mode)
      XCTAssertNil(existing.nextFire, mode)
      let outcome = await h.adapter.put(h.request(.immediate), replacing: existing, isCurrent: { true })
      XCTAssertEqual(outcome, .retired, mode)
      XCTAssertEqual(h.added.count, 1, mode)
    }
  }

  func testPresentedEvidenceBlocksAReplacementEvenWhenSameIdIsPending() async throws {
    let h = Harness()
    _ = await h.adapter.put(h.request(), replacing: nil, isCurrent: { true })
    let inventory = try await h.adapter.pending()
    h.presented = [h.content.identifier]
    let outcome = await h.adapter.put(h.request(.immediate), replacing: inventory.first, isCurrent: { true })
    XCTAssertEqual(outcome, .unchanged)
    XCTAssertEqual(h.added.count, 1)
  }

  func testReplacementReinspectsPendingAfterPresentedAwaitAndUsesCurrentTitle() async throws {
    let h = Harness()
    _ = await h.adapter.put(h.request(), replacing: nil, isCurrent: { true })
    let inventory = try await h.adapter.pending()
    let replacement = IntentMissRequest(content: .init(pair: h.content.pair, title: "Renamed board"),
      trigger: .immediate, zone: TimeZone.current.identifier)
    let outcome = await h.adapter.put(replacement, replacing: inventory.first, isCurrent: { true })
    XCTAssertEqual(outcome, .accepted)
    XCTAssertEqual(h.added.last?.content.title, "Renamed board")
    let other = Harness()
    _ = await other.adapter.put(other.request(), replacing: nil, isCurrent: { true })
    let pending = try await other.adapter.pending()
    other.onPresented = { other.pending = [] }
    let retired = await other.adapter.put(other.request(.immediate), replacing: pending.first, isCurrent: { true })
    XCTAssertEqual(retired, .retired)
    XCTAssertEqual(other.added.count, 1)
  }
}
