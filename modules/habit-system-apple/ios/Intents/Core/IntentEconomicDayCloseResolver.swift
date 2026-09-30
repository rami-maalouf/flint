import Foundation

// this resolver belongs to one transaction, including its captured zone and cache.
final class IntentEconomicDayCloseResolver {
  private let timeZone: TimeZone
  private var results: [String: Double] = [:]

  init(zone: String) throws {
    guard !zone.isEmpty, !zone.hasPrefix("+"), !zone.hasPrefix("-"),
          let timeZone = TimeZone(identifier: zone) else { throw IntentFailure.database }
    self.timeZone = timeZone
  }

  func resolve(date: String, startMinute: Int) throws -> Double {
    guard IntentCalendar.isValidDate(date), (0...720).contains(startMinute), startMinute % 30 == 0 else {
      throw IntentFailure.database
    }
    let key = "\(date)|\(startMinute)"
    if let existing = results[key] { return existing }
    let day = try IntentCivilTime.epochDay(date: date) + 1
    let target = Double(day * 86_400_000 + startMinute * 60_000)
    let result = try IntentCivilTime.resolve(target: target) {
      self.timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: $0 / 1000))
    }
    results[key] = result
    return result
  }
}
