import Foundation

// callers own the transaction; settlement never captures clocks or generates live ids.
enum IntentCoinStore {
  @discardableResult static func append(_ entry: IntentCoinLedgerRow, to database: IntentDatabase, enqueueAt: Int64) throws -> Bool {
    try entry.validateShape()
    if let saved = try database.rows("SELECT * FROM coin_ledger WHERE id = ?", [.text(entry.id)]).first {
      guard try ledger(saved) == entry else { throw IntentStorageError.unavailable }
      return false
    }
    try database.run("""
      INSERT INTO coin_ledger (id, kind, delta, board_id, check_in_id, run_key, reward_id, reward_title_snapshot,
        reverses_id, scope_key, source_action_id, reconciliation_key, adjusts_id, provenance_json,
        logical_date, created_at, mutation_stamp, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      """, [.text(entry.id), .text(entry.kind), .integer(entry.delta), .string(entry.boardId), .string(entry.checkInId),
        .string(entry.runKey), .string(entry.rewardId), .string(entry.rewardTitleSnapshot), .string(entry.reversesId),
        .string(entry.scopeKey), .string(entry.sourceActionId), .string(entry.reconciliationKey), .string(entry.adjustsId),
        .string(entry.provenanceJson), .text(entry.logicalDate), .integer(entry.createdAt), .text(entry.mutationStamp), .null])
    try database.run("INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES ('ledger_entry', ?, ?, ?)",
      [.text(entry.id), .text(entry.mutationStamp), .integer(enqueueAt)])
    return true
  }

  static func entries(scopeKey: String, database: IntentDatabase) throws -> [IntentCoinLedgerRow] {
    try database.rows("SELECT * FROM coin_ledger WHERE scope_key = ? ORDER BY mutation_stamp, id", [.text(scopeKey)]).map(ledger)
  }

  static func settleCheck(boardId: String, logicalDate: String, database: IntentDatabase, enqueueAt: Int64) throws -> IntentCoinReconciliation.Result {
    let actions = try database.rows("SELECT * FROM habit_actions WHERE board_id = ? AND logical_date = ? ORDER BY mutation_stamp, id",
      [.text(boardId), .text(logicalDate)]).map(action)
    let rows = try entries(scopeKey: "check:\(boardId):\(logicalDate)", database: database)
    let result = try IntentCoinReconciliation.reconcile(boardId: boardId, logicalDate: logicalDate, actions: actions, rows: rows)
    for row in result.appendedRows { try append(row, to: database, enqueueAt: enqueueAt) }
    return result
  }

  static func settleAffected(checkScopes: [IntentBonusEvidence.CheckScope], rootScopes: [IntentBonusEvidence.Scope] = [],
    database: IntentDatabase, enqueueAt: Int64) throws {
    let groups = try IntentBonusEvidence.read(database: database, checkScopes: checkScopes, rootScopes: rootScopes)
    for scope in Set(checkScopes).sorted(by: { [$0.boardId, $0.logicalDate].lexicographicallyPrecedes([$1.boardId, $1.logicalDate]) }) {
      _ = try settleCheck(boardId: scope.boardId, logicalDate: scope.logicalDate, database: database, enqueueAt: enqueueAt)
    }
    for group in groups {
      let result = try IntentCoinReconciliation.reconcileBonus(rootId: group.scope.rootId, logicalDate: group.scope.logicalDate,
        actions: group.actions, rows: group.rows)
      for row in result.appendedRows { try append(row, to: database, enqueueAt: enqueueAt) }
    }
  }

  static func action(_ row: [String: IntentSQLValue]) throws -> IntentHabitAction {
    let row = IntentCoinSQL(row)
    let action = try IntentHabitAction(id: row.string("id"), commandId: row.optionalString("command_id"),
      boardId: row.string("board_id"), logicalDate: row.string("logical_date"), checkInId: row.optionalString("check_in_id"),
      kind: row.string("kind"), createdAt: row.integer("created_at"), mutationStamp: row.string("mutation_stamp"),
      policyJson: row.optionalString("policy_json"))
    try action.validate()
    return action
  }

  static func ledger(_ row: [String: IntentSQLValue]) throws -> IntentCoinLedgerRow {
    let row = IntentCoinSQL(row)
    let entry = try IntentCoinLedgerRow(id: row.string("id"), kind: row.string("kind"), delta: row.integer("delta"),
      boardId: row.optionalString("board_id"), checkInId: row.optionalString("check_in_id"), runKey: row.optionalString("run_key"),
      rewardId: row.optionalString("reward_id"), rewardTitleSnapshot: row.optionalString("reward_title_snapshot"),
      reversesId: row.optionalString("reverses_id"), scopeKey: row.optionalString("scope_key"), sourceActionId: row.optionalString("source_action_id"),
      reconciliationKey: row.optionalString("reconciliation_key"), adjustsId: row.optionalString("adjusts_id"), provenanceJson: row.optionalString("provenance_json"),
      logicalDate: row.string("logical_date"), createdAt: row.integer("created_at"), mutationStamp: row.string("mutation_stamp"), deletedAt: row.optionalInteger("deleted_at"))
    try entry.validateShape()
    return entry
  }
}

// sqlite affinity is not a substitute for validating the stored scalar type.
struct IntentCoinSQL {
  let values: [String: IntentSQLValue]
  init(_ values: [String: IntentSQLValue]) { self.values = values }
  func string(_ key: String) throws -> String {
    guard case .text(let value) = values[key] else { throw IntentStorageError.unavailable }
    return value
  }
  func optionalString(_ key: String) throws -> String? {
    if values[key] == .null { return nil }
    return try string(key)
  }
  func integer(_ key: String) throws -> Int64 {
    guard case .integer(let value) = values[key], (-IntentCoinJSON.safeInteger...IntentCoinJSON.safeInteger).contains(value) else {
      throw IntentStorageError.unavailable
    }
    return value
  }
  func optionalInteger(_ key: String) throws -> Int64? {
    if values[key] == .null { return nil }
    return try integer(key)
  }
  func boolean(_ key: String) throws -> Bool {
    let value = try integer(key)
    guard value == 0 || value == 1 else { throw IntentStorageError.unavailable }
    return value == 1
  }
}
