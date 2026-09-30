import Foundation
import UserNotifications

@MainActor struct IntentMissNativeAPI {
  var authorization: () async -> UNAuthorizationStatus
  var pending: () async -> [UNNotificationRequest]
  var presented: () async -> [String]
  var add: (UNNotificationRequest) async throws -> Void
  var remove: ([String]) -> Void

  static func live() -> Self {
    let center = UNUserNotificationCenter.current()
    return .init(authorization: { await center.notificationSettings().authorizationStatus },
      pending: { await center.pendingNotificationRequests() },
      presented: { await center.deliveredNotifications().map { $0.request.identifier } },
      add: { try await center.add($0) }, remove: { center.removePendingNotificationRequests(withIdentifiers: $0) })
  }
}

@MainActor final class IntentMissNotifications: IntentMissNotificationCenter {
  private let api: IntentMissNativeAPI
  private let now: () -> Double

  init(api: IntentMissNativeAPI, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.api = api
    self.now = now
  }

  func authorization() async throws -> IntentMissAuthorization {
    // match expo's generic permission mapping, including provisional and ephemeral.
    switch await api.authorization() {
    case .authorized: return .granted
    case .denied: return .denied
    default: return .undetermined
    }
  }

  func pending() async throws -> [IntentMissPending] { await api.pending().map(Self.decode) }
  func presented() async throws -> [String] { await api.presented() }

  private static func decode(_ request: UNNotificationRequest) -> IntentMissPending {
    var data: [String: Any] = [:]
    var validKeys = true
    for (key, value) in request.content.userInfo {
      guard let key = key as? String else { validKeys = false; continue }
      data[key] = value
    }
    let content = validKeys ? IntentMissContent.decode(identifier: request.identifier, title: request.content.title,
      body: request.content.body, data: data) : nil
    let next = (request.trigger as? UNCalendarNotificationTrigger).flatMap {
      content == nil || $0.repeats || !Self.isMissCalendar($0.dateComponents) ? nil : $0.nextTriggerDate()
    }
    return .init(identifier: request.identifier,
      content: content,
      nextFire: next.map { $0.timeIntervalSince1970 * 1000 })
  }

  private static func isMissCalendar(_ value: DateComponents) -> Bool {
    guard let year = value.year, let month = value.month, let day = value.day,
      value.hour == 9, value.minute == 0, value.second == 0,
      IntentMissAlerts.validDate(String(format: "%04d-%02d-%02d", year, month, day)),
      value.timeZone == nil, value.calendar == nil || [.iso8601, .gregorian].contains(value.calendar!.identifier),
      [value.era, value.nanosecond, value.weekday, value.weekdayOrdinal, value.quarter,
        value.weekOfMonth, value.weekOfYear, value.yearForWeekOfYear].allSatisfy({ $0 == nil }),
      value.isLeapMonth != true else { return false }
    return true
  }

  func put(_ request: IntentMissRequest, replacing: IntentMissPending?, isCurrent: () -> Bool) async -> IntentMissScheduleOutcome {
    guard IntentMissPair.parse(request.content.identifier) == request.content.pair else { return .notAccepted }
    let permission = try? await authorization()
    guard isCurrent() else { return .retired }
    guard permission == .granted else { return .notAccepted }
    let presented = await api.presented()
    guard isCurrent() else { return .retired }
    if presented.contains(request.content.identifier) { return replacing == nil ? .accepted : .unchanged }
    let pending = await api.pending()
    guard isCurrent() else { return .retired }
    let existing = pending.first { $0.identifier == request.content.identifier }
    if let replacing {
      guard replacing.identifier == request.content.identifier, let existing else { return .retired }
      let observed = Self.decode(existing)
      guard let content = observed.content, let future = observed.nextFire, future > now(),
        let oldContent = replacing.content, oldContent.identifier == request.content.identifier,
        let oldFire = replacing.nextFire, oldFire > now(),
        content.title.utf8.elementsEqual(oldContent.title.utf8), content.body.utf8.elementsEqual(oldContent.body.utf8) else { return .retired }
    } else if let existing {
      return Self.decode(existing).content == nil ? .unknown : .accepted
    } else {
      // inventory is advisory across processes; sqlite arbitrates the pair, not global os capacity.
      guard pending.count < 64 else { return .notAccepted }
    }
    let trigger: UNNotificationTrigger?
    switch request.trigger {
    case .immediate: trigger = nil
    case .local09(let date):
      guard IntentMissAlerts.validDate(date) else { return .notAccepted }
      let fields = date.split(separator: "-").compactMap { Int($0) }
      var components = DateComponents()
      components.calendar = Calendar(identifier: .iso8601)
      components.year = fields[0]
      components.month = fields[1]
      components.day = fields[2]
      components.hour = 9
      components.minute = 0
      components.second = 0
      let calendarTrigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
      let next = calendarTrigger.nextTriggerDate()
      guard isCurrent() else { return .retired }
      guard let next, next.timeIntervalSince1970 * 1000 > now(),
        let calendar = try? IntentCalendar.calendar(zone: request.zone),
        let wall = try? IntentCivilTime.wall(utcMs: next.timeIntervalSince1970 * 1000, zone: calendar.timeZone),
        wall.minute == 540, IntentCivilTime.date(epochDay: wall.day) == date else { return .notAccepted }
      if let old = existing?.trigger as? UNCalendarNotificationTrigger,
        !old.repeats, old.dateComponents == components { return .unchanged }
      trigger = calendarTrigger
    }
    let content = UNMutableNotificationContent()
    content.title = request.content.title
    content.body = request.content.body
    content.sound = .default
    content.userInfo = request.content.data
    guard isCurrent() else { return .retired }
    do {
      try await api.add(UNNotificationRequest(identifier: request.content.identifier, content: content, trigger: trigger))
      return .accepted
    } catch {
      // the ios completion error proves nonacceptance; a later retirement cannot erase it.
      return .notAccepted
    }
  }

  func cancel(_ identifier: String) async throws {
    guard !Task.isCancelled else { throw IntentFailure.database }
    api.remove([identifier])
    guard !(await api.pending()).contains(where: { $0.identifier == identifier }) else { throw IntentFailure.database }
  }
}
