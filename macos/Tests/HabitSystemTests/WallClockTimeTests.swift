import Foundation
import AppKit
import SwiftUI
import XCTest

final class WallClockTimeTests: XCTestCase {
  func testEveryWallClockMinuteRoundTripsWithoutRounding() {
    for minute in 0..<1440 {
      XCTAssertEqual(WallClockTime.minute(from: WallClockTime.date(for: minute)), minute)
      XCTAssertTrue(WallClockTime.isValid(minute))
    }
  }

  func testNineFourteenUsesFixedUTCReferenceRatherThanCurrentCalendarDate() {
    let formatter = ISO8601DateFormatter()
    XCTAssertEqual(formatter.string(from: WallClockTime.date(for: 9 * 60 + 14)), "2001-01-01T09:14:00Z")
    XCTAssertEqual(formatter.string(from: WallClockTime.date(for: 1439)), "2001-01-01T23:59:00Z")
    XCTAssertEqual(WallClockTime.calendar.timeZone.secondsFromGMT(), 0)
  }

  func testDatePickerExtractionKeepsMinutesAcrossDSTAndSkippedCalendarDates() throws {
    let formatter = ISO8601DateFormatter()
    for date in ["2026-03-08T09:14:00Z", "2026-11-01T09:14:00Z", "2011-12-30T09:14:59Z", "2000-02-29T09:14:00Z"] {
      XCTAssertEqual(WallClockTime.minute(from: try XCTUnwrap(formatter.date(from: date))), 554)
    }
  }

  func testUsualTimeConstraintIsExplicitWhileReminderAcceptsExactMinutes() {
    XCTAssertTrue(WallClockTime.isValid(554))
    XCTAssertFalse(WallClockTime.isValid(554, step: 15))
    XCTAssertTrue(WallClockTime.isValid(555, step: 15))
    XCTAssertTrue(WallClockTime.isValid(1425, step: 15))
    XCTAssertFalse(WallClockTime.isValid(1439, step: 15))
    XCTAssertFalse(WallClockTime.isValid(-1))
    XCTAssertFalse(WallClockTime.isValid(1440))
    XCTAssertFalse(WallClockTime.isValid(0, step: 0))
  }

  @MainActor
  func testNativeTimeFieldUsesUTCForDisplayAndEditing() throws {
    _ = NSApplication.shared
    let picker = NativeWallClockTimePicker.makeDatePicker(title: "Time")
    let calendar = try XCTUnwrap(picker.calendar)
    let timeZone = try XCTUnwrap(picker.timeZone)
    XCTAssertEqual(calendar.identifier, .gregorian)
    XCTAssertEqual(calendar.timeZone.secondsFromGMT(), 0)
    XCTAssertEqual(timeZone.secondsFromGMT(), 0)
    XCTAssertEqual(picker.datePickerStyle, .textField)
    XCTAssertEqual(picker.datePickerElements, .hourMinute)
    XCTAssertTrue(picker.isContinuous)

    picker.dateValue = WallClockTime.date(for: 554)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar
    formatter.timeZone = timeZone
    formatter.dateFormat = "HH:mm"
    XCTAssertEqual(formatter.string(from: picker.dateValue), "09:14")
    XCTAssertEqual(picker.dateValue, ISO8601DateFormatter().date(from: "2001-01-01T09:14:00Z"))

    var storedMinute = 540
    let coordinator = NativeWallClockTimePicker.Coordinator(minute: Binding(
      get: { storedMinute }, set: { storedMinute = $0 }
    ))
    coordinator.didChange(picker)
    XCTAssertEqual(storedMinute, 554)
  }
}
