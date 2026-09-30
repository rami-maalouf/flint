import Foundation

enum IntentBonusCoins {
  struct Replay { let ordinaryRows: [IntentCoinLedgerRow]; let target: Int64 }
  private struct Held {
    let row: IntentCoinLedgerRow
    let policy: IntentCoinPolicy
    var witnesses: [String: Set<String>]
  }

  static func ordered(rootId: String, logicalDate: String, actions: [IntentHabitAction], requireScope: Bool = true) throws -> [IntentHabitAction] {
    guard IntentCoinJSON.uuid(rootId), IntentCalendar.isValidDate(logicalDate) else { throw IntentCoinError.invalid }
    var unique: [String: IntentHabitAction] = [:]
    for action in actions {
      if let old = unique[action.id], old != action { throw IntentCoinError.invalid }
      unique[action.id] = action
    }
    let groups = Dictionary(grouping: Array(unique.values), by: \.boardId)
    let validated = try groups.flatMap { boardId, rows in
      try IntentCheckCoins.ordered(boardId: boardId, logicalDate: logicalDate, actions: rows)
    }
    if requireScope {
      var members: Set<String> = [rootId]
      for action in validated {
        if let json = action.policyJson {
          let policy = try IntentCoinPolicy.parse(json)
          if policy.rootId == rootId {
            members.insert(action.boardId)
            members.formUnion(policy.requiredBoardIds)
          }
        }
      }
      guard validated.allSatisfy({ members.contains($0.boardId) }) else { throw IntentCoinError.invalid }
    }
    return validated.sorted(by: IntentBonusCoinCauses.precedes)
  }

  static func fingerprint(_ policy: IntentCoinPolicy) throws -> String {
    _ = try policy.canonical()
    guard let root = policy.rootId, let close = policy.bonusClosesAtUtc else { throw IntentCoinError.invalid }
    return IntentCoinProvenance.digest(try IntentCoinJSON.encode([
      "habit-bonus-policy-v1", root, policy.requiredBoardIds, close, policy.bonusEnabled] as [Any]))
  }

  static func award(_ action: IntentHabitAction, policy: IntentCoinPolicy) throws -> IntentCoinLedgerRow {
    guard let root = policy.rootId else { throw IntentCoinError.invalid }
    let scope = "bonus:\(root):\(action.logicalDate)"
    let name = try IntentCoinJSON.encode(["habit-ledger-v1", "run_bonus", scope, action.id, fingerprint(policy)])
    let row = IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: name), kind: "run_bonus", delta: 1,
      boardId: nil, checkInId: nil, runKey: "\(root)|\(action.logicalDate)", rewardId: nil, rewardTitleSnapshot: nil,
      reversesId: nil, scopeKey: scope, sourceActionId: action.id, reconciliationKey: nil, adjustsId: nil,
      provenanceJson: nil, logicalDate: action.logicalDate, createdAt: action.createdAt, mutationStamp: action.mutationStamp, deletedAt: nil)
    try row.validateShape()
    return row
  }

  static func reversal(_ action: IntentHabitAction, award: IntentCoinLedgerRow) throws -> IntentCoinLedgerRow {
    let name = try IntentCoinJSON.encode(["habit-ledger-v1", "reversal", award.id, action.id])
    let row = IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: name), kind: "reversal", delta: -award.delta,
      boardId: nil, checkInId: nil, runKey: nil, rewardId: nil, rewardTitleSnapshot: nil, reversesId: award.id,
      scopeKey: award.scopeKey, sourceActionId: action.id, reconciliationKey: nil, adjustsId: nil, provenanceJson: nil,
      logicalDate: action.logicalDate, createdAt: action.createdAt, mutationStamp: action.mutationStamp, deletedAt: nil)
    try row.validateShape()
    return row
  }

  static func replay(rootId: String, logicalDate: String, actions: [IntentHabitAction]) throws -> Replay {
    var active: [String: Set<String>] = [:]
    var control: IntentCoinPolicy?
    var held: Held?
    var rows: [IntentCoinLedgerRow] = []
    for action in try ordered(rootId: rootId, logicalDate: logicalDate, actions: actions) {
      let observation = try action.policyJson.map(IntentCoinPolicy.parse)
      if action.kind == "policy" {
        if action.boardId == rootId && observation?.rootId == rootId { control = observation }
        continue
      }
      if action.kind == "uncheck" || action.kind == "move_out" {
        if let token = action.checkInId { active[action.boardId, default: []].remove(token) }
        else { active[action.boardId] = [] }
        if var award = held, award.policy.requiredBoardIds.contains(action.boardId),
          action.createdAt < award.policy.bonusClosesAtUtc! {
          let known: Bool
          if let token = action.checkInId { known = award.witnesses[action.boardId, default: []].remove(token) != nil }
          else { known = true; award.witnesses[action.boardId] = [] }
          held = award
          if known && active[action.boardId, default: []].isEmpty {
            rows.append(try reversal(action, award: award.row))
            held = nil
          }
        }
        continue
      }
      let policy = control ?? (observation?.rootId == rootId ? observation : nil)
      let wasComplete = policy.map { complete($0, active: active) } ?? false
      let inserted = active[action.boardId, default: []].insert(action.checkInId!).inserted
      if inserted, held?.policy.requiredBoardIds.contains(action.boardId) == true {
        held?.witnesses[action.boardId, default: []].insert(action.checkInId!)
      }
      if action.kind == "check", observation != nil, inserted, held == nil, let policy,
        policy.bonusEnabled, policy.requiredBoardIds.contains(action.boardId), !wasComplete, complete(policy, active: active) {
        let row = try award(action, policy: policy)
        rows.append(row)
        held = Held(row: row, policy: policy, witnesses: active.filter { policy.requiredBoardIds.contains($0.key) })
      }
    }
    return Replay(ordinaryRows: rows, target: held == nil ? 0 : 1)
  }

  private static func complete(_ policy: IntentCoinPolicy, active: [String: Set<String>]) -> Bool {
    !policy.requiredBoardIds.isEmpty && policy.requiredBoardIds.allSatisfy { !(active[$0] ?? []).isEmpty }
  }
}
