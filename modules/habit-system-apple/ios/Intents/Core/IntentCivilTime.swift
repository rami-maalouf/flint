import Foundation

// integer proleptic gregorian arithmetic avoids foundation's historical cutover.
enum IntentCivilTime {
  static func epochDay(year: Int, month: Int, day: Int) -> Int {
    let y = year - (month <= 2 ? 1 : 0)
    let era = (y >= 0 ? y : y - 399) / 400
    let within = y - era * 400
    let adjustedMonth = month + (month > 2 ? -3 : 9)
    let dayOfYear = (153 * adjustedMonth + 2) / 5 + day - 1
    return era * 146097 + within * 365 + within / 4 - within / 100 + dayOfYear - 719468
  }

  static func fields(epochDay: Int) -> (year: Int, month: Int, day: Int) {
    let shifted = epochDay + 719468
    let era = (shifted >= 0 ? shifted : shifted - 146096) / 146097
    let within = shifted - era * 146097
    let yearOfEra = (within - within / 1460 + within / 36524 - within / 146096) / 365
    let year = yearOfEra + era * 400
    let dayOfYear = within - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let adjustedMonth = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * adjustedMonth + 2) / 5 + 1
    let month = adjustedMonth + (adjustedMonth < 10 ? 3 : -9)
    return (year + (month <= 2 ? 1 : 0), month, day)
  }

  static func epochDay(date: String) throws -> Int {
    guard IntentCalendar.isValidDate(date) else { throw IntentFailure.database }
    let parts = date.split(separator: "-").map { Int($0)! }
    return epochDay(year: parts[0], month: parts[1], day: parts[2])
  }

  static func date(epochDay: Int) -> String {
    let value = fields(epochDay: epochDay)
    return String(format: "%04d-%02d-%02d", value.year, value.month, value.day)
  }

  static func wall(utcMs: Double, zone: TimeZone) throws -> (day: Int, minute: Int) {
    guard utcMs.isFinite, abs(utcMs) <= 8_640_000_000_000_000 else { throw IntentFailure.database }
    let shifted = utcMs + Double(zone.secondsFromGMT(for: Date(timeIntervalSince1970: utcMs / 1000))) * 1000
    let day = Int(floor(shifted / 86_400_000))
    return (day, Int(floor((shifted - Double(day) * 86_400_000) / 60_000)))
  }

  // supported iana zones have at most one transition per hour. economic closes
  // use the first crossing; selected wall times preserve minutes inside a gap.
  static func resolve(target: Double, preservingGap: Bool = false, offsetSecondsAt: (Double) throws -> Int) throws -> Double {
    guard target.isFinite, target.rounded() == target, abs(target) <= 8_640_000_000_000_000 - 86_400_000 else {
      throw IntentFailure.database
    }
    var offsets: [Double: Double] = [:]
    func offset(_ instant: Double) throws -> Double {
      if let cached = offsets[instant] { return cached }
      let seconds = try offsetSecondsAt(instant)
      guard seconds > -86400, seconds < 86400 else { throw IntentFailure.database }
      let value = Double(seconds) * 1000
      offsets[instant] = value
      return value
    }
    var previousOffset: Double?
    func crossing(_ from: Double, _ to: Double, _ shift: Double) throws -> Double? {
      // a transition at the grid endpoint leaves an empty post-transition segment.
      guard from < to else { return nil }
      let candidate = max(from, target - shift)
      guard candidate < to else { previousOffset = shift; return nil }
      guard try candidate + offset(candidate) >= target,
            try candidate - 1 + offset(candidate - 1) < target else { throw IntentFailure.database }
      if preservingGap, candidate + shift > target, let previousOffset {
        return target - previousOffset
      }
      return candidate
    }
    var left = target - 86_400_000
    var before = try offset(left)
    for index in 0..<48 {
      let right = left + 3_600_000
      let after = try offset(right)
      if before != after {
        var low = left, high = right
        while high - low > 1000 {
          let middle = floor((low + high) / 2000) * 1000
          if try offset(middle) == before { low = middle } else { high = middle }
        }
        if let result = try crossing(left, high, before) { return result }
        left = high
      }
      if let result = try crossing(left, index == 47 ? right + 1 : right, after) { return result }
      left = right
      before = after
    }
    throw IntentFailure.database
  }
}
