import Foundation

struct IntentWidgetRow: Codable, Equatable, Sendable {
  let boardId: String
  let kind: IntentBoardKind
  let title: String
  let symbol: String
  let accentHex: String
  let strip: [Int]
  let checkedToday: Bool

  init(boardId: String, kind: IntentBoardKind, title: String, symbol: String, accentHex: String, strip: [Int]) {
    self.boardId = boardId
    self.kind = kind
    self.title = title
    self.symbol = symbol
    self.accentHex = accentHex
    self.strip = kind == .daily ? strip.map { $0 > 0 ? 1 : 0 } : strip
    checkedToday = (self.strip.last ?? 0) > 0
  }
}

struct IntentWidgetProps: Codable, Equatable, Sendable {
  let rows: [IntentWidgetRow]
  let stale: Bool
}

struct IntentWidgetEntry: Codable, Equatable, Sendable {
  let timestamp: Int64
  let props: IntentWidgetProps
}

struct IntentWidgetTimeline: Codable, Sendable {
  let entries: [IntentWidgetEntry]

  init(rows: [IntentWidgetRow], generatedAtUtc: Double, expiresAtUtc: Double) throws {
    guard let generated = Int64(exactly: generatedAtUtc), let expires = Int64(exactly: expiresAtUtc),
          expires > generated else { throw IntentFailure.database }
    entries = [
      IntentWidgetEntry(timestamp: generated, props: IntentWidgetProps(rows: Array(rows.prefix(12)), stale: false)),
      IntentWidgetEntry(timestamp: expires, props: IntentWidgetProps(rows: Array(rows.prefix(12)), stale: true)),
    ]
  }
}
