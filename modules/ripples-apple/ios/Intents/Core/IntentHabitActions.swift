import CryptoKit
import Foundation

struct IntentHabitAction: Codable, Equatable, Sendable {
  static let namespace = "4d96f757-73e0-561c-99b9-16b7ef2d1903"
  static let baselineStamp = "00000000000000-00000-baseline"

  let id: String
  let commandId: String?
  let boardId: String
  let logicalDate: String
  let checkInId: String?
  let kind: String
  let createdAt: Int64
  let mutationStamp: String
  let policyJson: String?

  static func uuidV5(name: String) -> String {
    let namespaceUUID = UUID(uuidString: namespace)!.uuid
    var bytes = withUnsafeBytes(of: namespaceUUID) { Array($0) }
    bytes.append(contentsOf: name.utf8)
    var digest = Array(Insecure.SHA1.hash(data: Data(bytes)).prefix(16))
    digest[6] = (digest[6] & 0x0f) | 0x50
    digest[8] = (digest[8] & 0x3f) | 0x80
    let hex = digest.map { String(format: "%02x", $0) }
    return [hex[0..<4], hex[4..<6], hex[6..<8], hex[8..<10], hex[10..<16]]
      .map { $0.joined() }.joined(separator: "-")
  }

  static func baseline(checkInId: String, boardId: String, date: String) throws -> Self {
    guard IntentCalendar.isValidDate(date) else { throw IntentStorageError.unavailable }
    let name = try JSONSerialization.data(withJSONObject: ["habit-baseline-v1", checkInId, boardId, date], options: [.withoutEscapingSlashes])
    return Self(id: uuidV5(name: String(decoding: name, as: UTF8.self)), commandId: nil, boardId: boardId,
      logicalDate: date, checkInId: checkInId, kind: "baseline", createdAt: 0,
      mutationStamp: baselineStamp, policyJson: nil)
  }

  // the input is one board/date scope. baselines rank below every live fact.
  static func effectiveCheckInId(_ actions: [Self]) -> String? {
    activeCheckInIds(actions).last
  }

  static func activeCheckInIds(_ actions: [Self]) -> [String] {
    let ordered = actions.sorted {
      if ($0.kind == "baseline") != ($1.kind == "baseline") { return $0.kind == "baseline" }
      if $0.mutationStamp != $1.mutationStamp { return $0.mutationStamp < $1.mutationStamp }
      return $0.id < $1.id
    }
    var active: [String: Int] = [:]
    for (index, action) in ordered.enumerated() {
      switch action.kind {
      case "baseline", "check", "move_in":
        if let id = action.checkInId { active[id] = index }
      case "uncheck", "move_out":
        if let id = action.checkInId { active.removeValue(forKey: id) }
        else if action.kind == "uncheck" { active.removeAll() }
      default: break
      }
    }
    return active.sorted { $0.value < $1.value }.map(\.key)
  }

  @discardableResult func append(to database: IntentDatabase, enqueueAt: Int64? = nil) throws -> Bool {
    try validate()
    let row: [String: IntentSQLValue] = ["id": .text(id), "command_id": .string(commandId),
      "board_id": .text(boardId), "logical_date": .text(logicalDate), "check_in_id": .string(checkInId),
      "kind": .text(kind), "created_at": .integer(createdAt), "mutation_stamp": .text(mutationStamp), "policy_json": .string(policyJson)]
    if let existing = try database.rows("SELECT * FROM habit_actions WHERE id = ?", [.text(id)]).first {
      guard existing == row else { throw IntentStorageError.unavailable }
      return false
    }
    try database.run("""
      INSERT INTO habit_actions (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      """, [.text(id), .string(commandId), .text(boardId), .text(logicalDate), .string(checkInId), .text(kind),
             .integer(createdAt), .text(mutationStamp), .string(policyJson)])
    try database.run("INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES ('habit_action', ?, ?, ?)",
      [.text(id), .text(mutationStamp), .integer(enqueueAt ?? createdAt)])
    return true
  }

  func validate() throws {
    guard isValid else { throw IntentStorageError.unavailable }
    if let policyJson { _ = try IntentCoinPolicy.parse(policyJson) }
    guard try IntentCoinProvenance.actionCanonical(self).utf8.count <= IntentCoinJSON.recordBytes else {
      throw IntentCoinError.size
    }
  }

  private var isValid: Bool {
    func matches(_ value: String, _ expression: String) -> Bool {
      value.range(of: expression, options: .regularExpression) != nil
    }
    func uuid(_ value: String, version: Int) -> Bool {
      matches(value, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-\(version)[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    }
    let baseline = kind == "baseline"
    return uuid(id, version: baseline ? 5 : 4)
      && (baseline ? commandId == nil : commandId.map { uuid($0, version: 4) } == true)
      && uuid(boardId, version: 4) && IntentCalendar.isValidDate(logicalDate)
      && ["baseline", "check", "uncheck", "move_in", "move_out", "policy"].contains(kind)
      && (checkInId.map { uuid($0, version: 4) } ?? ["uncheck", "policy"].contains(kind))
      && (kind != "policy" || checkInId == nil)
      && createdAt >= 0 && createdAt <= 9_007_199_254_740_991
      && matches(mutationStamp, "^[0-9]{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$")
      && (!baseline || (createdAt == 0 && mutationStamp == Self.baselineStamp && policyJson == nil))
  }

}
