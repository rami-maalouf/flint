import Foundation
import XCTest
@testable import HabitSystemIntentCore

final class IntentCalendarTests: XCTestCase {
  func testSharedEconomicClosesUseExactLiteralInstants() throws {
    struct Vector: Decodable {
      let date: String; let zone: String; let shift: Int; let expectedUtcMs: Double
    }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: root.appendingPathComponent("src/core/calendar/fixtures/economic-day-close.json")))
    for vector in vectors {
      let resolver = try IntentEconomicDayCloseResolver(zone: vector.zone)
      XCTAssertEqual(try resolver.resolve(date: vector.date, startMinute: vector.shift), vector.expectedUtcMs, "\(vector.date) \(vector.zone)")
      XCTAssertEqual(try resolver.resolve(date: vector.date, startMinute: vector.shift), vector.expectedUtcMs)
    }
  }

  func testEconomicResolverRejectsInvalidInputsAndKeepsSyntheticGapAndFoldCrossings() throws {
    let resolver = try IntentEconomicDayCloseResolver(zone: "UTC")
    for date in ["2026-02-30", "26-01-01", "10000-01-01", ""] {
      XCTAssertThrowsError(try resolver.resolve(date: date, startMinute: 0))
    }
    for minute in [-30, 15, 721] { XCTAssertThrowsError(try resolver.resolve(date: "2026-09-08", startMinute: minute)) }
    for zone in ["Invalid/Zone", "+23:59", ""] { XCTAssertThrowsError(try IntentEconomicDayCloseResolver(zone: zone)) }
    let target = 1_788_912_000_000.0
    XCTAssertEqual(try IntentCivilTime.resolve(target: target) { $0 < target - 30_000 ? 0 : 90 }, target - 30_000)
    XCTAssertEqual(try IntentCivilTime.resolve(target: target) { $0 < target - 30_000 ? 90 : 0 }, target - 90_000)
    for offset in [-86400, 86400, Int.min] {
      XCTAssertThrowsError(try IntentCivilTime.resolve(target: target) { _ in offset })
    }
    for invalid in [Double.nan, Double.infinity, 0.5, 8_640_000_000_000_000] {
      XCTAssertThrowsError(try IntentCivilTime.resolve(target: invalid) { _ in 0 })
    }
    XCTAssertEqual(try IntentCivilTime.resolve(target: target) { _ in -86399 }, target + 86_399_000)
    XCTAssertEqual(try IntentCivilTime.resolve(target: target) { _ in 86399 }, target - 86_399_000)
    for changeCandidate in [true, false] {
      XCTAssertThrowsError(try IntentCivilTime.resolve(target: target) { instant in
        if changeCandidate && instant == target - 90_000 { return 89 }
        if !changeCandidate && instant == target - 90_001 { return 91 }
        return 90
      })
    }
  }

  func testProlepticArithmeticHasNoCutoverAndKeepsAstronomicalYearZero() throws {
    XCTAssertEqual(try IntentCalendar.addingDays(1, to: "1582-10-09"), "1582-10-10")
    XCTAssertEqual(try IntentCalendar.addingDays(1, to: "0000-02-28"), "0000-02-29")
    XCTAssertEqual(try IntentCalendar.addingDays(1, to: "0000-02-29"), "0000-03-01")
    XCTAssertEqual(try IntentCalendar.addingDays(-1, to: "0001-01-01"), "0000-12-31")
    XCTAssertEqual(try IntentCalendar.addingDays(1, to: "0099-12-31"), "0100-01-01")
  }

  func testHistoricalWallDatesAndModernGapComponentsUseDistinctRulesFromEconomicClose() throws {
    XCTAssertEqual(try IntentCalendar.logicalDate(utcMs: -62_162_121_600_000, zone: "UTC", startMinute: 0), "0000-02-29")
    XCTAssertEqual(try IntentCalendar.occurredAt(logicalDate: "0000-02-29", hour: 0, minute: 0, startMinute: 0, zone: "UTC"), -62_162_121_600_000)
    XCTAssertEqual(try IntentCalendar.occurredAt(logicalDate: "1582-10-10", hour: 0, minute: 0, startMinute: 0, zone: "UTC"), -12_219_724_800_000)
    XCTAssertEqual(try IntentCalendar.occurredAt(logicalDate: "2026-03-08", hour: 2, minute: 30, startMinute: 0, zone: "America/New_York"), 1_772_955_000_000)
    XCTAssertEqual(try IntentCalendar.occurredAt(logicalDate: "2026-11-01", hour: 1, minute: 30, startMinute: 0, zone: "America/New_York"), 1_793_511_000_000)
  }
}
