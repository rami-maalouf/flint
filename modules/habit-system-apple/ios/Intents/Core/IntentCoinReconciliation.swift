import Foundation

enum IntentCoinReconciliation {
  struct Result { let appendedRows: [IntentCoinLedgerRow]; let target: Int64; let balance: Int64 }
  private typealias Replay = ([IntentHabitAction]) throws -> (ordinaryRows: [IntentCoinLedgerRow], target: Int64)
  private typealias OrdinaryValidator = ([IntentHabitAction], [IntentCoinLedgerRow]) throws -> Void
  private struct Fact {
    let fingerprint: [String]; let action: IntentHabitAction?; let row: IntentCoinLedgerRow?
    var createdAt: Int64 { action?.createdAt ?? row!.createdAt }
    var stamp: String { action?.mutationStamp ?? row!.mutationStamp }
  }

  private static func sum(_ rows: [IntentCoinLedgerRow]) throws -> Int64 {
    try IntentCoinLedgerRow.totals(rows).balance
  }

  private static func validateCheckOrdinary(_ actions: [IntentHabitAction], _ rows: [IntentCoinLedgerRow]) throws {
    let causes = Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0) })
    let awards = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    for row in rows {
      guard let cause = row.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
      let expected: IntentCoinLedgerRow
      if row.kind == "check" {
        guard cause.kind == "check", let json = cause.policyJson, try IntentCoinPolicy.parse(json).earnsCoins else { throw IntentCoinError.invalid }
        expected = try .check(cause)
      } else {
        guard let award = row.reversesId.flatMap({ awards[$0] }),
          let source = award.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
        guard row.kind == "reversal", award.kind == "check", ["uncheck", "move_out"].contains(cause.kind),
          cause.checkInId == nil || cause.checkInId == award.checkInId, let json = source.policyJson,
          try cause.createdAt < IntentCoinPolicy.parse(json).checkClosesAtUtc,
          [source.mutationStamp, source.id].lexicographicallyPrecedes([cause.mutationStamp, cause.id]) else { throw IntentCoinError.invalid }
        expected = try .check(cause, reversing: award)
      }
      guard expected == row else { throw IntentCoinError.invalid }
    }
  }

  private static func evidence(_ actions: [IntentHabitAction], _ rows: [IntentCoinLedgerRow]) throws -> [Fact] {
    var facts = try actions.map { Fact(fingerprint: ["habit_action", $0.id, IntentCoinProvenance.digest(try IntentCoinProvenance.actionCanonical($0))], action: $0, row: nil) }
    facts += try rows.map { Fact(fingerprint: ["ledger_entry", $0.id, IntentCoinProvenance.digest(try $0.canonical())], action: nil, row: $0) }
    return facts.sorted { $0.fingerprint.lexicographicallyPrecedes($1.fingerprint) }
  }

  private static func correction(scope: String, date: String, actions: [IntentHabitAction], rows: [IntentCoinLedgerRow], facts: [Fact], replay: Replay) throws -> IntentCoinLedgerRow? {
    let replay = try replay(actions)
    let saved = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    guard replay.ordinaryRows.allSatisfy({ saved[$0.id] == $0 }) else { throw IntentCoinError.invalid }
    let delta = replay.target - (try sum(rows))
    if delta == 0 { return nil }
    let proof = try IntentCoinProvenance.canonical(facts.map { $0.fingerprint })
    let digest = IntentCoinProvenance.digest(proof)
    guard let last = facts.max(by: {
      [$0.stamp, $0.fingerprint[1], $0.fingerprint[0]].lexicographicallyPrecedes([$1.stamp, $1.fingerprint[1], $1.fingerprint[0]])
    }) else { throw IntentCoinError.invalid }
    let row = IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: try IntentCoinJSON.encode(["habit-ledger-v1", "adjustment", scope, digest])),
      kind: "adjustment", delta: delta, boardId: nil, checkInId: nil, runKey: nil, rewardId: nil, rewardTitleSnapshot: nil,
      reversesId: nil, scopeKey: scope, sourceActionId: nil, reconciliationKey: digest, adjustsId: nil, provenanceJson: proof,
      logicalDate: date, createdAt: last.createdAt, mutationStamp: last.stamp, deletedAt: nil)
    try row.validateShape()
    return row
  }

  private static func cancellation(_ old: IntentCoinLedgerRow) -> IntentCoinLedgerRow {
    IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: "cancel:\(old.id)"), kind: "adjustment", delta: -old.delta,
      boardId: nil, checkInId: nil, runKey: nil, rewardId: nil, rewardTitleSnapshot: nil, reversesId: nil,
      scopeKey: old.scopeKey, sourceActionId: nil, reconciliationKey: old.reconciliationKey, adjustsId: old.id,
      provenanceJson: old.provenanceJson, logicalDate: old.logicalDate, createdAt: old.createdAt,
      mutationStamp: old.mutationStamp, deletedAt: nil)
  }

  static func reconcile(boardId: String, logicalDate: String, actions inputActions: [IntentHabitAction], rows inputRows: [IntentCoinLedgerRow]) throws -> Result {
    let actions = try IntentCheckCoins.ordered(boardId: boardId, logicalDate: logicalDate, actions: inputActions)
    return try reconcile(scope: "check:\(boardId):\(logicalDate)", date: logicalDate, actions: actions, inputRows: inputRows,
      allowedKinds: ["check", "reversal", "adjustment"], replay: { actions in
        let value = try IntentCheckCoins.replay(boardId: boardId, logicalDate: logicalDate, actions: actions)
        return (value.ordinaryRows, value.target)
      }, validateOrdinary: validateCheckOrdinary)
  }

  static func reconcileBonus(rootId: String, logicalDate: String, actions inputActions: [IntentHabitAction], rows inputRows: [IntentCoinLedgerRow]) throws -> Result {
    let actions = try IntentBonusCoins.ordered(rootId: rootId, logicalDate: logicalDate, actions: inputActions, requireScope: false)
    return try reconcile(scope: "bonus:\(rootId):\(logicalDate)", date: logicalDate, actions: actions, inputRows: inputRows,
      allowedKinds: ["run_bonus", "reversal", "adjustment"], replay: { actions in
        let value = try IntentBonusCoins.replay(rootId: rootId, logicalDate: logicalDate, actions: actions)
        return (value.ordinaryRows, value.target)
      }, validateOrdinary: { actions, rows in
        try IntentBonusCoinCauses.validateOrdinary(rootId: rootId, actions: actions, rows: rows)
        _ = try IntentBonusCoins.ordered(rootId: rootId, logicalDate: logicalDate, actions: actions)
      })
  }

  private static func reconcile(scope: String, date: String, actions: [IntentHabitAction], inputRows: [IntentCoinLedgerRow],
                                allowedKinds: Set<String>, replay replayActions: Replay, validateOrdinary: OrdinaryValidator) throws -> Result {
    var rows: [String: IntentCoinLedgerRow] = [:]
    var appended: [IntentCoinLedgerRow] = []
    for row in inputRows {
      try row.validateShape()
      guard row.scopeKey == scope, allowedKinds.contains(row.kind),
        rows[row.id] == nil || rows[row.id] == row else { throw IntentCoinError.invalid }
      rows[row.id] = row
    }
    func append(_ row: IntentCoinLedgerRow) { if rows[row.id] == nil { rows[row.id] = row; appended.append(row) } }
    try validateOrdinary(actions, rows.values.filter { $0.kind != "adjustment" })
    let replay = try replayActions(actions)
    for row in replay.ordinaryRows { append(row) }
    let ordinary = rows.values.filter { $0.kind != "adjustment" }
    let facts = try evidence(actions, ordinary)
    let available = Dictionary(uniqueKeysWithValues: facts.map { (Array($0.fingerprint.prefix(2)), $0) })
    for row in rows.values where row.kind == "adjustment" && row.adjustsId == nil {
      var subset: [Fact] = []
      for fingerprint in try IntentCoinProvenance.parse(row.provenanceJson!) {
        guard let fact = available[Array(fingerprint.prefix(2))] else { throw IntentCoinError.missing }
        guard fingerprint == fact.fingerprint else { throw IntentCoinError.invalid }
        subset.append(fact)
      }
      let subsetActions = subset.compactMap { $0.action }
      let subsetRows = subset.compactMap { $0.row }
      do { try validateOrdinary(subsetActions, subsetRows) } catch { throw IntentCoinError.invalid }
      guard try correction(scope: scope, date: date, actions: subsetActions, rows: subsetRows, facts: subset, replay: replayActions) == row else { throw IntentCoinError.invalid }
    }
    for row in rows.values.filter({ $0.kind == "adjustment" }).sorted(by: { $0.id < $1.id }) {
      guard let old = row.adjustsId.flatMap({ rows[$0] }) ?? (row.adjustsId == nil ? row : nil) else { throw IntentCoinError.missing }
      guard old.kind == "adjustment", old.adjustsId == nil else { throw IntentCoinError.invalid }
      if try IntentCoinProvenance.parse(old.provenanceJson!).count >= facts.count {
        if row.adjustsId != nil { throw IntentCoinError.missing }
        continue
      }
      let cancel = cancellation(old)
      try cancel.validateShape()
      guard row.adjustsId == nil || row == cancel else { throw IntentCoinError.invalid }
      append(cancel)
    }
    if let current = try correction(scope: scope, date: date, actions: actions, rows: ordinary, facts: facts, replay: replayActions) { append(current) }
    return Result(appendedRows: appended, target: replay.target, balance: try sum(Array(rows.values)))
  }
}
