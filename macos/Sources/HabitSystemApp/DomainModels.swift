import Foundation
import SwiftUI

func editableNumber(_ value: Double, locale: Locale = .current) -> String {
  String(value).replacingOccurrences(of: ".", with: locale.decimalSeparator ?? ".")
}

func parseEditableNumber(_ text: String, locale: Locale = .current) -> Double? {
  let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: locale.decimalSeparator ?? ".", with: ".")
  guard let value = Double(normalized), value.isFinite else { return nil }
  return value
}

struct Board: Codable, Identifiable, Hashable {
  let id: String
  var kind: String
  var anchorRelation: String?
  var anchorKind: String?
  var anchorBoardId: String?
  var anchorPreset: String?
  var anchorText: String?
  var usualTimeMinute: Int?
  var requiredInStack: Bool
  var earnsCoins: Bool
  var coinCapPerDay: Int
  var title: String
  var symbol: String
  var accentHex: String
  var usesTintedBackground: Bool
  var tracksAmount: Bool
  var amountUnit: String?
  var quickAmount: Double
  var tracksTime: Bool
  var startOfDayMinute: Int
  var metricsEnabled: Bool
  var orderKey: String
  var archivedAt: Double?
  var mutationStamp: String
  var color: Color { Color(hex: accentHex) }
}
struct HomeCard: Decodable, Identifiable {
  var id: String { board.id }
  let board: Board
  let today: String
  let strip: [Int]
  let daily: DailySummary?
  struct DailySummary: Decodable { let checkedToday: Bool; let completedThisWeek: Int; let currentStreak: Int? }
}
struct CheckIn: Codable, Identifiable {
  let id: String
  let boardId: String
  let logicalDate: String
  let occurredAtUtc: Double?
  let amount: Double?
  let note: String?
  let mutationStamp: String
}
struct DailySnapshot: Decodable, Identifiable {
  var id: String { boardId }
  let boardId: String
  let boardTitle: String
  let logicalDate: String
  let checked: Bool
  let checkInCount: Int
  let noteCount: Int
  let expectedCheckIns: [ExpectedCheck]
  struct ExpectedCheck: Codable { let checkInId: String; let mutationStamp: String }
}
struct HistoryPage: Decodable {
  let months: [Month]
  let hasMore: Bool
  struct Month: Decodable, Identifiable {
    var id: String { month }
    let month: String
    let count: Int
    let days: [Day]
  }
  struct Day: Decodable, Identifiable {
    var id: String { date }
    let date: String
    let count: Int
    let checkIns: [CheckIn]
  }
}
struct BoardSummary: Decodable {
  let today: String
  let eligibleDayCount: Int
  let metricsReady: Bool
  let currentStreak: Int
  let longestStreak: Int
  let consistencyPercent: Double?
  let currentMonthCount: Int
  let currentWeekCount: Int
  let currentMonthDaily: [Int]
}
struct BoardDependencies: Decodable { let checkIns: Int; let notes: Int; let reminders: Int; let anchoredBoards: Int }
struct Catalog: Decodable {
  let symbols: [String]
  let palette: [Swatch]
  struct Swatch: Decodable, Identifiable { var id: String { hex }; let name: String; let hex: String }
}
struct CoinTotals: Decodable { let earned: Int; let spent: Int; let balance: Int }
struct CoinPage: Decodable {
  let items: [CoinItem]
  let nextCursor: CoinCursor?
}
struct CoinCursor: Codable { let logicalDate: String; let createdAt: Double; let id: String }
struct CoinItem: Decodable, Identifiable {
  let id: String
  let kind: String
  let delta: Int
  let logicalDate: String
  let createdAt: Double
  let reference: Reference
  let adjustment: String?
  struct Reference: Decodable { let kind: String; let id: String; let title: String?; let status: String? }
}
struct Reward: Decodable, Identifiable {
  let id: String
  let title: String
  let costCoins: Int
  let symbol: String
  let accentHex: String
  let archivedAt: Double?
  let mutationStamp: String
}
struct RewardPreview: Decodable, Identifiable {
  var id: String { reward.id }
  let reward: Reward
  let balance: Int
  let balanceAfterClaim: Int?
}
struct StackList: Decodable { let stacks: [StackSummary] }
struct StackDetail: Decodable { let stack: StackSummary }
struct StackSummary: Decodable, Identifiable {
  var id: String { rootId }
  let rootId: String
  let members: [Member]
  let currentRun: Run
  let completeRunsThisWeek: Int
  let currentStreak: Int
  let longestStreak: Int?
  let heatmap: [Run]?
  let memberWeeklyCounts: [WeeklyCount]?
  struct Member: Decodable, Identifiable {
    let id: String; let title: String; let symbol: String; let accentHex: String
    let kind: String; let requiredInStack: Bool; let checked: Bool; let eligible: Bool
  }
  struct Run: Decodable {
    let logicalDate: String; let requiredCount: Int; let checkedRequiredCount: Int
    let available: Bool; let complete: Bool
  }
  struct WeeklyCount: Decodable { let boardId: String; let checks: Int }
}
struct Heatmap: Decodable {
  let weeks: [Week]
  struct Week: Decodable { let days: [Day] }
  struct Day: Decodable, Identifiable {
    var id: String { date }; let date: String; let count: Int; let isToday: Bool; let isFuture: Bool; let eligible: Bool
  }
}
struct Timeline: Decodable { let year: Int; let months: [Int] }
struct Consistency: Decodable, Identifiable { var id: String { month }; let month: String; let percent: Double? }

extension Encodable {
  func jsonObject() throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) }
}
extension Color {
  init(hex: String) {
    let value = UInt64(hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted), radix: 16) ?? 0x70A7FF
    self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
  }
}
func minuteLabel(_ minute: Int) -> String { String(format: "%02d:%02d", minute / 60, minute % 60) }
private func logicalDateFormatter() -> DateFormatter {
  let formatter = DateFormatter()
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}
func dateLabel(_ value: String) -> String {
  guard let date = logicalDateFormatter().date(from: value) else { return value }
  return date.formatted(date: .abbreviated, time: .omitted)
}
func logicalDate(_ date: Date) -> String {
  logicalDateFormatter().string(from: date)
}
func parseDate(_ value: String) -> Date {
  logicalDateFormatter().date(from: value) ?? Date()
}
