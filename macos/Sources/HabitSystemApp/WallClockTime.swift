import Foundation
import SwiftUI
import AppKit

enum WallClockTime {
  static var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }
  static func date(for minute: Int) -> Date {
    Date(timeIntervalSinceReferenceDate: Double(minute) * 60)
  }

  static func minute(from date: Date) -> Int {
    let components = calendar.dateComponents([.hour, .minute], from: date)
    return (components.hour ?? 0) * 60 + (components.minute ?? 0)
  }

  static func isValid(_ minute: Int, step: Int = 1) -> Bool {
    step > 0 && (0..<1440).contains(minute) && minute % step == 0
  }
}

struct WallClockTimeField: View {
  let title: String
  @Binding var minute: Int
  var step = 1

  var body: some View {
    HStack {
      Text(title)
      Spacer()
      NativeWallClockTimePicker(title: title, minute: $minute)
        .frame(width: 118, height: 24)
    }
    if step > 1 {
      Text(WallClockTime.isValid(minute, step: step)
        ? "Usual times use 15-minute intervals: :00, :15, :30 or :45."
        : "Choose a minute of :00, :15, :30 or :45 to save this habit.")
        .font(.caption)
        .foregroundStyle(WallClockTime.isValid(minute, step: step) ? Color.secondary : Color.red)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct NativeWallClockTimePicker: NSViewRepresentable {
  let title: String
  @Binding var minute: Int

  static func makeDatePicker(title: String) -> NSDatePicker {
    let picker = NSDatePicker()
    picker.datePickerStyle = .textField
    picker.datePickerElements = .hourMinute
    picker.datePickerMode = .single
    picker.calendar = WallClockTime.calendar
    picker.timeZone = WallClockTime.calendar.timeZone
    picker.isContinuous = true
    picker.isBordered = true
    picker.drawsBackground = true
    picker.setAccessibilityLabel(title)
    return picker
  }

  func makeCoordinator() -> Coordinator { Coordinator(minute: $minute) }

  func makeNSView(context: Context) -> NSDatePicker {
    let picker = Self.makeDatePicker(title: title)
    picker.dateValue = WallClockTime.date(for: minute)
    picker.target = context.coordinator
    picker.action = #selector(Coordinator.didChange(_:))
    return picker
  }

  func updateNSView(_ picker: NSDatePicker, context: Context) {
    context.coordinator.minute = $minute
    let date = WallClockTime.date(for: minute)
    if picker.dateValue != date { picker.dateValue = date }
  }

  final class Coordinator: NSObject {
    var minute: Binding<Int>

    init(minute: Binding<Int>) { self.minute = minute }

    @objc func didChange(_ picker: NSDatePicker) {
      minute.wrappedValue = WallClockTime.minute(from: picker.dateValue)
    }
  }
}
