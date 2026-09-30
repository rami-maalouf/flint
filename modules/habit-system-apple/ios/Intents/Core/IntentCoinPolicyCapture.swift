import Foundation

struct IntentCoinPolicyBoard: Codable {
  let id: String; let kind: String; let earnsCoins: Bool; let coinCapPerDay: Int
  let anchorKind: String?; let anchorRelation: String?; let anchorBoardId: String?
  let anchorPreset: String?; let anchorText: String?; let usualTimeMinute: Int?
  let startOfDayMinute: Int; let requiredInStack: Bool; let orderKey: String
  let archivedAt: Int64?; let deletedAt: Int64?

  fileprivate func validateTopology() throws {
    guard IntentCoinJSON.uuid(id), (0...720).contains(startOfDayMinute), startOfDayMinute % 30 == 0,
      usualTimeMinute.map({ (0...1425).contains($0) && $0 % 15 == 0 }) ?? true else { throw IntentCoinError.invalid }
    if anchorKind == nil {
      guard anchorRelation == nil, anchorBoardId == nil, anchorPreset == nil, anchorText == nil else { throw IntentCoinError.invalid }
      return
    }
    guard ["before", "after"].contains(anchorRelation) else { throw IntentCoinError.invalid }
    switch anchorKind {
    case "board":
      guard anchorBoardId.map({ IntentCoinJSON.uuid($0) }) == true, anchorPreset == nil, anchorText == nil else { throw IntentCoinError.invalid }
    case "preset":
      guard ["wake", "lunch", "dinner", "sleep"].contains(anchorPreset), anchorBoardId == nil, anchorText == nil else { throw IntentCoinError.invalid }
    case "text":
      // ecmascript trim differs from foundation for next-line and byte-order-mark.
      let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000a}\u{000b}\u{000c}\u{000d}\u{0020}\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}")
      guard let text = anchorText, text == text.trimmingCharacters(in: whitespace),
        (1...80).contains(text.unicodeScalars.count), anchorBoardId == nil, anchorPreset == nil else { throw IntentCoinError.invalid }
    default: throw IntentCoinError.invalid
    }
  }
}

struct IntentCoinPolicyPeriod: Codable {
  let boardId: String; let startDate: String; let endDate: String?
}

// a prospective immutable snapshot, prepared once within its owning transaction.
struct IntentCoinPolicyCapture {
  private let topology: Topology
  private let periods: [String: [IntentCoinPolicyPeriod]]
  private let resolveClose: (String, Int) throws -> Double
  private let allowedIds: Set<String>

  init(boards: [IntentCoinPolicyBoard], periods: [IntentCoinPolicyPeriod], resolveClose: @escaping (String, Int) throws -> Double) throws {
    try self.init(topology: Topology(boards), periods: periods, allowedIds: Set(boards.filter { $0.deletedAt == nil }.map(\.id)), resolveClose: resolveClose)
  }

  private init(topology: Topology, periods: [IntentCoinPolicyPeriod], allowedIds: Set<String>, resolveClose: @escaping (String, Int) throws -> Double) throws {
    for period in periods {
      guard IntentCoinJSON.uuid(period.boardId), IntentCalendar.isValidDate(period.startDate),
        period.endDate.map({ IntentCalendar.isValidDate($0) }) ?? true else { throw IntentCoinError.invalid }
    }
    self.topology = topology
    self.periods = Dictionary(grouping: periods, by: \.boardId)
    self.allowedIds = allowedIds
    self.resolveClose = resolveClose
  }

  func capture(boardId: String, logicalDate: String) throws -> IntentCoinPolicy {
    guard IntentCoinJSON.uuid(boardId), IntentCalendar.isValidDate(logicalDate) else { throw IntentCoinError.invalid }
    guard allowedIds.contains(boardId), let board = topology.boards[boardId] else { throw IntentFailure.notFound }
    let structuralRoot = topology.roots[boardId]!
    let members = topology.members[structuralRoot]!
    let root = topology.boards[structuralRoot]!
    let isStack = members.count > 1 || root.anchorKind != nil
    let required = isStack ? members.filter { id in
      topology.boards[id]!.requiredInStack && (periods[id] ?? []).contains {
        $0.startDate <= logicalDate && ($0.endDate == nil || logicalDate < $0.endDate!)
      }
    }.sorted() : []
    func close(_ shift: Int) throws -> Int64 {
      let value = try resolveClose(logicalDate, shift)
      guard value.isFinite, value.rounded(.towardZero) == value, abs(value) <= Double(IntentCoinJSON.safeInteger),
        value != 0 || value.sign != .minus else { throw IntentCoinError.invalid }
      return Int64(value)
    }
    let policy = try IntentCoinPolicy(version: 1, boardKind: board.kind, earnsCoins: board.earnsCoins,
      coinCapPerDay: board.coinCapPerDay, checkClosesAtUtc: close(board.startOfDayMinute),
      rootId: isStack ? structuralRoot : nil, requiredBoardIds: required,
      bonusClosesAtUtc: isStack ? close(root.startOfDayMinute) : nil, bonusEnabled: !required.isEmpty)
    _ = try policy.canonical()
    return policy
  }

  static func read(database: IntentDatabase, boardIds: [String], resolveClose: @escaping (String, Int) throws -> Double) throws -> Self {
    guard boardIds.allSatisfy({ IntentCoinJSON.uuid($0) }) else { throw IntentCoinError.invalid }
    if boardIds.isEmpty { return try Self(boards: [], periods: [], resolveClose: resolveClose) }
    let boards = try database.rows("""
      SELECT id, kind, earns_coins, coin_cap_per_day, anchor_kind, anchor_relation, anchor_board_id,
        anchor_preset, anchor_text, usual_time_minute, start_of_day_minute, required_in_stack, order_key,
        archived_at, deleted_at FROM boards WHERE deleted_at IS NULL
      """).map { values in
        let row = IntentCoinSQL(values)
        return try IntentCoinPolicyBoard(id: row.string("id"), kind: row.string("kind"), earnsCoins: row.boolean("earns_coins"),
          coinCapPerDay: Int(row.integer("coin_cap_per_day")), anchorKind: row.optionalString("anchor_kind"),
          anchorRelation: row.optionalString("anchor_relation"), anchorBoardId: row.optionalString("anchor_board_id"),
          anchorPreset: row.optionalString("anchor_preset"), anchorText: row.optionalString("anchor_text"),
          usualTimeMinute: row.optionalInteger("usual_time_minute").map(Int.init), startOfDayMinute: Int(row.integer("start_of_day_minute")),
          requiredInStack: row.boolean("required_in_stack"), orderKey: row.string("order_key"),
          archivedAt: row.optionalInteger("archived_at"), deletedAt: row.optionalInteger("deleted_at"))
      }
    let topology = try Topology(boards)
    var allowed = Set<String>()
    for id in boardIds {
      guard let root = topology.roots[id] else { throw IntentFailure.notFound }
      allowed.formUnion(topology.members[root]!)
    }
    let periods = try database.rows("""
      SELECT board_id, start_date, end_date FROM board_activity_periods
      WHERE deleted_at IS NULL AND board_id IN (SELECT value FROM json_each(?))
      """, [.text(try IntentCoinJSON.encode(allowed.sorted()))]).map { values in
        let row = IntentCoinSQL(values)
        return try IntentCoinPolicyPeriod(boardId: row.string("board_id"), startDate: row.string("start_date"), endDate: row.optionalString("end_date"))
      }
    return try Self(topology: topology, periods: periods, allowedIds: allowed, resolveClose: resolveClose)
  }

  private struct Topology {
    let boards: [String: IntentCoinPolicyBoard]
    let roots: [String: String]
    let members: [String: [String]]
    init(_ input: [IntentCoinPolicyBoard]) throws {
      var boards: [String: IntentCoinPolicyBoard] = [:]
      for board in input where board.deletedAt == nil {
        try board.validateTopology()
        guard boards[board.id] == nil else { throw IntentCoinError.invalid }
        boards[board.id] = board
      }
      var roots: [String: String] = [:]
      for board in boards.values {
        var current = board
        var path = Set<String>()
        while roots[current.id] == nil && current.anchorKind == "board" {
          guard path.insert(current.id).inserted, let parent = current.anchorBoardId.flatMap({ boards[$0] }) else { throw IntentCoinError.invalid }
          current = parent
        }
        let root = roots[current.id] ?? current.id
        roots[current.id] = root
        for id in path { roots[id] = root }
      }
      self.boards = boards
      self.roots = roots
      self.members = Dictionary(grouping: roots.keys, by: { roots[$0]! })
    }
  }
}
