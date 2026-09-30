import Foundation

enum IntentCheckCoins {
  struct Replay {
    let activeCheckInIds: [String]
    let ordinaryRows: [IntentCoinLedgerRow]
    let target: Int64
  }

  static func ordered(boardId: String, logicalDate: String, actions: [IntentHabitAction]) throws -> [IntentHabitAction] {
    guard IntentCoinJSON.uuid(boardId), IntentCalendar.isValidDate(logicalDate) else { throw IntentCoinError.invalid }
    var unique: [String: IntentHabitAction] = [:]
    for action in actions {
      let baseline = action.kind == "baseline"
      guard action.boardId == boardId, action.logicalDate == logicalDate,
        IntentCoinJSON.uuid(action.id, version: baseline ? 5 : 4),
        (baseline ? action.commandId == nil : action.commandId.map { IntentCoinJSON.uuid($0) } == true),
        ["check", "uncheck", "move_out", "move_in", "policy", "baseline"].contains(action.kind),
        action.checkInId.map({ IntentCoinJSON.uuid($0) }) ?? ["uncheck", "policy"].contains(action.kind),
        action.kind != "policy" || action.checkInId == nil,
        (0...IntentCoinJSON.safeInteger).contains(action.createdAt),
        action.mutationStamp.range(of: "^[0-9]{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
        !baseline || (action.createdAt == 0 && action.mutationStamp == IntentHabitAction.baselineStamp && action.policyJson == nil)
      else { throw IntentCoinError.invalid }
      if let policy = action.policyJson { _ = try IntentCoinPolicy.parse(policy) }
      if baseline, try IntentHabitAction.baseline(checkInId: action.checkInId!, boardId: boardId, date: logicalDate) != action { throw IntentCoinError.invalid }
      guard try IntentCoinProvenance.actionCanonical(action).utf8.count <= IntentCoinJSON.recordBytes else { throw IntentCoinError.size }
      if let old = unique[action.id], old != action { throw IntentCoinError.invalid }
      unique[action.id] = action
    }
    return unique.values.sorted {
      if ($0.kind == "baseline") != ($1.kind == "baseline") { return $0.kind == "baseline" }
      if $0.mutationStamp != $1.mutationStamp { return $0.mutationStamp < $1.mutationStamp }
      return $0.id < $1.id
    }
  }

  static func replay(boardId: String, logicalDate: String, actions: [IntentHabitAction]) throws -> Replay {
    var active = Set<String>()
    var outstanding: [(row: IntentCoinLedgerRow, close: Int64)] = []
    var rows: [IntentCoinLedgerRow] = []
    for action in try ordered(boardId: boardId, logicalDate: logicalDate, actions: actions) {
      if action.kind == "policy" { continue }
      if action.kind == "uncheck" || action.kind == "move_out" {
        let revoked = outstanding.filter {
          (action.checkInId == nil || action.checkInId == $0.row.checkInId) && action.createdAt < $0.close }
        for award in revoked { rows.append(try IntentCoinLedgerRow.check(action, reversing: award.row)) }
        let ids = Set(revoked.map { $0.row.id })
        outstanding.removeAll { ids.contains($0.row.id) }
        if let target = action.checkInId { active.remove(target) } else { active.removeAll() }
        continue
      }
      let policy = try action.policyJson.map { try IntentCoinPolicy.parse($0) }
      let qualifies = action.kind == "check" && !active.contains(action.checkInId!) && policy?.earnsCoins == true &&
        (policy?.boardKind == "count" || active.isEmpty) && outstanding.count < (policy?.coinCapPerDay ?? 0)
      active.insert(action.checkInId!)
      if qualifies, let policy {
        let row = try IntentCoinLedgerRow.check(action)
        rows.append(row)
        outstanding.append((row, policy.checkClosesAtUtc))
      }
    }
    return Replay(activeCheckInIds: active.sorted(), ordinaryRows: rows, target: Int64(outstanding.count))
  }
}
