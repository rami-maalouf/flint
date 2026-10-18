import AppKit
import Foundation
import UserNotifications

public struct HabitNotificationSelection: Equatable, Sendable {
  public enum Kind: String, Sendable { case board, newCheck = "new-check" }
  public let boardID: String
  public let kind: Kind
  public init(boardID: String, kind: Kind) { self.boardID = boardID; self.kind = kind }
  public init?(identifier: String, userInfo: [AnyHashable: Any]) {
    guard let boardID = userInfo["boardId"] as? String, UUID(uuidString: boardID) != nil else { return nil }
    let kind: Kind
    if identifier.hasPrefix("habit-system.miss.v1:") { kind = .board }
    else if identifier.hasPrefix("habit-system.reminder.") { kind = .newCheck }
    else { return nil }
    self.init(boardID: boardID, kind: kind)
  }
}

// notification responses can arrive before the app's first scene or store is ready.
@MainActor public final class HabitNotificationInbox {
  public static let shared = HabitNotificationInbox()
  private var pending: HabitNotificationSelection?
  private var receive: ((HabitNotificationSelection) -> Void)?
  public init() {}
  public func submit(_ selection: HabitNotificationSelection) {
    if let receive { receive(selection) } else { pending = selection }
  }
  public func attach(_ receive: @escaping (HabitNotificationSelection) -> Void) {
    self.receive = receive
    if let pending { self.pending = nil; receive(pending) }
  }
}

protocol NotificationCenterPort: Sendable {
  func authorization() async -> String
  func requestAuthorization() async throws -> String
  func pending() async -> [UNNotificationRequest]
  func deliveredIdentifiers() async -> [String]
  func add(_ request: UNNotificationRequest) async throws
  func remove(_ identifiers: [String])
}

private final class SystemNotificationCenter: NSObject, NotificationCenterPort, UNUserNotificationCenterDelegate, @unchecked Sendable {
  static let shared = SystemNotificationCenter()
  private let center = UNUserNotificationCenter.current()
  override init() { super.init(); center.delegate = self }
  func authorization() async -> String {
    switch await center.notificationSettings().authorizationStatus {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "undetermined"
    }
  }
  func requestAuthorization() async throws -> String {
    _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
    return await authorization()
  }
  func pending() async -> [UNNotificationRequest] { await center.pendingNotificationRequests() }
  func deliveredIdentifiers() async -> [String] { await center.deliveredNotifications().map { $0.request.identifier } }
  func add(_ request: UNNotificationRequest) async throws { try await center.add(request) }
  func remove(_ identifiers: [String]) { center.removePendingNotificationRequests(withIdentifiers: identifiers) }
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
    NotificationCenter.default.post(name: .habitNotificationDelivered, object: nil)
  }
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    if response.actionIdentifier != UNNotificationDismissActionIdentifier,
      let selection = HabitNotificationSelection(identifier: response.notification.request.identifier, userInfo: response.notification.request.content.userInfo) {
      DispatchQueue.main.async {
        HabitNotificationInbox.shared.submit(selection)
      }
    }
    completionHandler()
  }
}

public extension Notification.Name {
  static let habitNotificationDelivered = Notification.Name("studio.orbitlabs.habitsystem.notificationDelivered")
}

public final class HabitNotificationService: @unchecked Sendable {
  public static func prepareForResponses() { _ = SystemNotificationCenter.shared }
  private let center: NotificationCenterPort?
  private let effectsEnabled: Bool
  private let lock = NSLock()
  private var generation = 0
  private var foreground = true
  private var retired = false

  public init(effectsEnabled: Bool = true) {
    self.effectsEnabled = effectsEnabled
    center = effectsEnabled ? SystemNotificationCenter.shared : nil
  }
  init(center: NotificationCenterPort, effectsEnabled: Bool) {
    self.center = center; self.effectsEnabled = effectsEnabled
  }
  public func install(on engine: EngineHost) async {
    await engine.registerService("notifications") { [self] request in try await handle(request: request) }
  }
  public func setForeground(_ active: Bool) {
    lock.lock(); defer { lock.unlock() }
    if foreground != active { generation += 1; foreground = active }
  }
  public func invalidate() { lock.lock(); generation += 1; lock.unlock() }
  public func retire() { lock.lock(); generation += 1; retired = true; lock.unlock() }
  private func effectsCurrent(_ expected: Int? = nil) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return effectsEnabled && !retired && (expected == nil || generation == expected)
  }
  private func state() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    return ["generation": generation, "foreground": foreground, "effectsEnabled": effectsEnabled && !retired]
  }
  private func current(_ guardValue: [String: Any]) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return effectsEnabled && !retired && guardValue["generation"] as? Int == generation &&
      guardValue["timeZoneId"] as? String == TimeZone.current.identifier &&
      (guardValue["expiresAt"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000
  }
  private func failure() -> EngineFailure {
    EngineFailure(code: "platform", message: "Notifications could not be updated. Try again.", retryable: true)
  }
  public func handle(request: [String: Any]) async throws -> Any {
    let method = request["method"] as? String ?? ""
    if method == "state" { return state() }
    if effectsEnabled && !effectsCurrent() { throw failure() }
    guard effectsEnabled, let center else {
      switch method {
      case "authorization", "requestAuthorization": return "denied"
      case "pending", "presented": return [Any]()
      case "cancel": return NSNull()
      case "scheduleMiss", "cancelMiss": return ["kind": "retired"]
      default: throw failure()
      }
    }
    switch method {
    case "authorization": return await center.authorization()
    case "requestAuthorization":
      do { return try await center.requestAuthorization() } catch { throw failure() }
    case "pending": return await center.pending().map(Self.inventory)
    case "presented": return await center.deliveredIdentifiers()
    case "cancel":
      center.remove(request["identifiers"] as? [String] ?? []); return NSNull()
    case "scheduleReminder":
      let expectedGeneration = state()["generation"] as? Int
      guard let value = request["request"] as? [String: Any],
            let weekday = value["weekday"] as? Int, (1...7).contains(weekday),
            let minute = value["minuteOfDay"] as? Int, (0..<1440).contains(minute),
            let reminderID = value["reminderId"] as? String, let boardID = value["boardId"] as? String,
            let title = value["title"] as? String, let body = value["body"] as? String else { throw failure() }
      guard await center.pending().count < 64 else { throw failure() }
      guard effectsCurrent(expectedGeneration) else { throw failure() }
      let content = UNMutableNotificationContent(); content.title = title; content.body = body; content.sound = .default
      content.userInfo = ["reminderId": reminderID, "boardId": boardID]
      var components = DateComponents(); components.weekday = (weekday % 7) + 1; components.hour = minute / 60; components.minute = minute % 60
      let identifier = "habit-system.reminder." + UUID().uuidString.lowercased()
      do { try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true))) }
      catch { throw failure() }
      return identifier
    case "scheduleMiss":
      let validity = request["guard"] as? [String: Any] ?? [:]
      guard current(validity) else { return ["kind": "retired"] }
      guard let value = request["request"] as? [String: Any],
            let identifier = value["identifier"] as? String,
            let boardID = value["boardId"] as? String, let date = value["secondMissedDate"] as? String,
            let title = value["title"] as? String, let body = value["body"] as? String,
            identifier == "habit-system.miss.v1:\(boardID):\(date)",
            body == "\(title) was missed twice. Fix the environment before anything else today." else { return ["kind": "not_accepted", "code": "schedule_failed"] }
      let pending = await center.pending()
      guard current(validity) else { return ["kind": "retired"] }
      let replacement = request["replacement"] as? Bool == true
      var previousFire: Date?
      if replacement {
        let presented = await center.deliveredIdentifiers()
        guard current(validity) else { return ["kind": "retired"] }
        if presented.contains(identifier) { return ["kind": "unchanged"] }
        let live = await center.pending()
        guard current(validity) else { return ["kind": "retired"] }
        guard let existing = live.first(where: { $0.identifier == identifier }),
              let next = Self.nextFire(existing.trigger), next > Date() else { return ["kind": "unchanged"] }
        previousFire = next
      } else if pending.contains(where: { $0.identifier == identifier }) { return ["kind": "unknown"] }
      if !pending.contains(where: { $0.identifier == identifier }) && pending.count >= 64 { return ["kind": "not_accepted", "code": "capacity"] }
      let content = UNMutableNotificationContent(); content.title = title; content.body = body; content.sound = .default
      content.userInfo = ["boardId": boardID, "secondMissedDate": date]
      let planned = value["trigger"] as? [String: Any] ?? [:]
      var trigger: UNNotificationTrigger?
      if planned["kind"] as? String == "local09", let day = planned["date"] as? String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return ["kind": "not_accepted", "code": "schedule_failed"] }
        var components = DateComponents(); components.year = parts[0]; components.month = parts[1]; components.day = parts[2]; components.hour = 9; components.minute = 0; components.second = 0
        let calendar = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        guard let next = calendar.nextTriggerDate(), next > Date() else { return ["kind": "retired"] }
        trigger = calendar
      } else if planned["kind"] as? String != "immediate" { return ["kind": "not_accepted", "code": "schedule_failed"] }
      if replacement, let next = Self.nextFire(trigger), next == previousFire { return ["kind": "unchanged"] }
      guard current(validity) else { return ["kind": "retired"] }
      if replacement && trigger == nil {
        center.remove([identifier])
        let remaining = await center.pending()
        guard current(validity) else { return ["kind": "cancelled"] }
        if remaining.contains(where: { $0.identifier == identifier }) { return ["kind": "unknown"] }
        let delivered = await center.deliveredIdentifiers()
        guard current(validity) else { return ["kind": "cancelled"] }
        if delivered.contains(identifier) { return ["kind": "unchanged"] }
        if remaining.count >= 64 { return ["kind": "not_accepted", "code": "capacity"] }
      }
      do {
        try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
        return ["kind": "accepted"]
      } catch { return ["kind": "unknown"] }
    case "cancelMiss":
      guard current(request["guard"] as? [String: Any] ?? [:]) else { return ["kind": "retired"] }
      guard let identifier = request["identifier"] as? String else { return ["kind": "unknown"] }
      center.remove([identifier]); return ["kind": "cancelled"]
    default: throw failure()
    }
  }

  private static func nextFire(_ trigger: UNNotificationTrigger?) -> Date? {
    if let calendar = trigger as? UNCalendarNotificationTrigger { return calendar.nextTriggerDate() }
    if let interval = trigger as? UNTimeIntervalNotificationTrigger { return interval.nextTriggerDate() }
    return nil
  }

  private static func inventory(_ request: UNNotificationRequest) -> [String: Any] {
    let content = request.content
    var reminder: Any = NSNull()
    if let trigger = request.trigger as? UNCalendarNotificationTrigger, trigger.repeats {
      let c = trigger.dateComponents
      if let weekday = c.weekday, (1...7).contains(weekday), let hour = c.hour, (0..<24).contains(hour),
         let minute = c.minute, (0..<60).contains(minute), c.year == nil, c.month == nil, c.day == nil,
         c.second == nil, c.timeZone == nil, c.era == nil, c.weekOfYear == nil, c.weekOfMonth == nil,
         c.weekdayOrdinal == nil, c.yearForWeekOfYear == nil, c.quarter == nil, c.nanosecond == nil,
         let boardID = content.userInfo["boardId"] as? String, let reminderID = content.userInfo["reminderId"] as? String {
        reminder = ["reminderId": reminderID, "boardId": boardID, "weekday": ((weekday + 5) % 7) + 1,
                    "minuteOfDay": hour * 60 + minute, "title": content.title, "body": content.body]
      }
    }
    let next: Any = Self.nextFire(request.trigger).map { $0.timeIntervalSince1970 * 1000 } ?? NSNull()
    return ["identifier": request.identifier, "title": content.title, "body": content.body,
            "data": content.userInfo, "reminder": reminder, "nextFireAtUtcMs": next,
            "repeats": request.trigger?.repeats ?? false]
  }
}

@MainActor public final class NotificationCoordinator {
  public let service: HabitNotificationService
  private let engine: EngineHost
  private var worker: Task<Void, Never>?
  private var timer: Task<Void, Never>?
  private var rerun = false
  private var enabled = false
  public private(set) var lastError: String?
  public init(engine: EngineHost, effectsEnabled: Bool = true) {
    self.engine = engine; service = HabitNotificationService(effectsEnabled: effectsEnabled)
  }
  public func start() async { await service.install(on: engine); enabled = true; requestReconciliation() }
  public func setForeground(_ active: Bool) {
    service.setForeground(active)
    requestReconciliation()
  }
  public func stop() { enabled = false; service.retire(); timer?.cancel(); worker?.cancel() }
  public func stopAndDrain() async {
    stop()
    await worker?.value
  }
  public func requestReconciliation() {
    guard enabled else { return }
    timer?.cancel()
    if worker != nil { rerun = true; return }
    worker = Task { [weak self] in
      guard let self else { return }
      repeat {
        rerun = false
        do {
          let result = try await engine.call("reconcileNotifications") as? [String: Any]
          let miss = result?["missAlerts"] as? [String: Any]
          let error = miss?["error"] as? [String: Any]
          lastError = error?["message"] as? String
          if let next = miss?["nextRunAtUtcMs"] as? Double { schedule(at: next) }
        } catch { lastError = error.localizedDescription; schedule(at: Date().timeIntervalSince1970 * 1000 + 30_000) }
      } while rerun && enabled && !Task.isCancelled
      worker = nil
    }
  }
  private func schedule(at milliseconds: Double) {
    guard enabled, !Task.isCancelled else { return }
    timer?.cancel()
    let delay = max(1, min(86_400, milliseconds / 1000 - Date().timeIntervalSince1970))
    timer = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
      self?.requestReconciliation()
    }
  }
}
