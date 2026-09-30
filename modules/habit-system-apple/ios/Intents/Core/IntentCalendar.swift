import Foundation

enum IntentCalendar {
  static func calendar(zone: String) throws -> Calendar {
    guard let timeZone = TimeZone(identifier: zone) else { throw IntentFailure.database }
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = Locale(identifier: "en_US_POSIX")
    calendar.timeZone = timeZone
    return calendar
  }

  static func logicalDate(utcMs: Double, zone: String, startMinute: Int) throws -> String {
    let calendar = try calendar(zone: zone)
    let wall = try IntentCivilTime.wall(utcMs: utcMs, zone: calendar.timeZone)
    return IntentCivilTime.date(epochDay: wall.day - (wall.minute < startMinute ? 1 : 0))
  }

  // a conservative display refresh deadline, never an economic day close.
  // minute probes also observe skipped thresholds and repeated-hour rollbacks.
  static func nextWidgetRefreshUtc(utcMs: Double, zone: String, startMinutes: [Int]) throws -> Double {
    let calendar = try calendar(zone: zone)
    let initial = try IntentCivilTime.wall(utcMs: utcMs, zone: calendar.timeZone)
    let starts = Set(startMinutes)
    let limit = utcMs + 48 * 60 * 60_000
    var instant = floor(utcMs / 60_000) * 60_000 + 60_000
    while instant < limit {
      let local = try IntentCivilTime.wall(utcMs: instant, zone: calendar.timeZone)
      if local.day != initial.day ||
          starts.contains(where: { (local.minute < $0) != (initial.minute < $0) }) { return instant }
      instant += 60_000
    }
    return limit
  }

  static func isValidDate(_ value: String) -> Bool {
    guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return false }
    let parts = value.split(separator: "-").compactMap { Int($0) }
    let year = parts[0], month = parts[1], day = parts[2]
    guard (1...12).contains(month), day > 0 else { return false }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return day <= lengths[month - 1]
  }

  static func addingDays(_ count: Int, to date: String) throws -> String {
    IntentCivilTime.date(epochDay: try IntentCivilTime.epochDay(date: date) + count)
  }

  // date and time intent parameters are wall-clock components. a time
  // before the shift belongs to the next calendar day of a logical date.
  static func occurredAt(logicalDate: String, hour: Int, minute: Int, startMinute: Int, zone: String) throws -> Double {
    guard (0...23).contains(hour), (0...59).contains(minute) else {
      throw IntentFailure(code: "validation", message: "Choose a valid local time.", field: "occurredAtUtc")
    }
    let day = try IntentCivilTime.epochDay(date: logicalDate) + (hour * 60 + minute < startMinute ? 1 : 0)
    let target = Double(day * 86_400_000 + (hour * 60 + minute) * 60_000)
    let timeZone = try calendar(zone: zone).timeZone
    return try IntentCivilTime.resolve(target: target, preservingGap: true) {
      timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: $0 / 1000))
    }
  }
}
