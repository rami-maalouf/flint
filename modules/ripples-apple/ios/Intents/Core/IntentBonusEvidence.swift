import Foundation

// callers own the snapshot; discovery uses immutable exact-date evidence, never current topology.
enum IntentBonusEvidence {
  struct CheckScope: Hashable, Codable { let boardId: String; let logicalDate: String }
  struct Scope: Hashable, Codable {
    let rootId: String; let logicalDate: String
    var key: String { "bonus:\(rootId):\(logicalDate)" }
  }
  struct Group { let scope: Scope; let actions: [IntentHabitAction]; let rows: [IntentCoinLedgerRow] }
  private struct References { let facts: [[String]]; let actions: Set<String>; let rows: Set<String> }

  static func read(database: IntentDatabase, checkScopes: [CheckScope], rootScopes: [Scope] = []) throws -> [Group] {
    let checks = Set(checkScopes)
    var scopes = Set(rootScopes)
    for scope in checks { try valid(scope.boardId, scope.logicalDate) }
    for scope in scopes { try valid(scope.rootId, scope.logicalDate) }
    if checks.isEmpty && scopes.isEmpty { return [] }
    var actions: [String: IntentHabitAction] = [:]
    var rows: [String: IntentCoinLedgerRow] = [:]
    func saveActions(_ sql: String, _ values: [IntentSQLValue]) throws -> [IntentHabitAction] {
      let found = try database.rows(sql, values).map(IntentCoinStore.action)
      for item in found { actions[item.id] = item }
      return found
    }
    func saveRows(_ sql: String, _ values: [IntentSQLValue]) throws -> [IntentCoinLedgerRow] {
      let found = try database.rows(sql, values).map(IntentCoinStore.ledger)
      for item in found { rows[item.id] = item }
      return found
    }
    if !checks.isEmpty {
      let pairs = try json(Array(checks))
      let selected = try saveActions("""
        SELECT DISTINCT a.* FROM json_each(?) scopes JOIN habit_actions a
          ON a.board_id = json_extract(scopes.value, '$.boardId') AND a.logical_date = json_extract(scopes.value, '$.logicalDate')
        """, [pairs])
      _ = try saveActions("""
        SELECT a.* FROM habit_actions a
        WHERE a.logical_date IN (SELECT DISTINCT json_extract(value, '$.logicalDate') FROM json_each(?))
          AND a.kind IN ('check','uncheck','move_out','move_in','policy') AND a.policy_json IS NOT NULL AND CASE
          WHEN json_valid(a.policy_json) = 0 THEN 1
          WHEN json_type(a.policy_json, '$.rootId') IS NOT 'text' AND json_type(a.policy_json, '$.rootId') IS NOT 'null' THEN 1
          WHEN json_type(a.policy_json, '$.requiredBoardIds') IS NOT 'array' THEN 1
          ELSE EXISTS (SELECT 1 FROM json_each(?) scopes JOIN json_each(a.policy_json, '$.requiredBoardIds') members
            ON members.value = json_extract(scopes.value, '$.boardId')
            WHERE a.logical_date = json_extract(scopes.value, '$.logicalDate')) END
        """, [pairs, pairs])
      for action in actions.values {
        if let policy = action.policyJson, let root = try IntentCoinPolicy.parse(policy).rootId {
          scopes.insert(Scope(rootId: root, logicalDate: action.logicalDate))
        }
      }
      let ids = try json(selected.map(\.id))
      let retained = try saveRows("""
        SELECT l.* FROM coin_ledger l
        WHERE l.logical_date IN (SELECT json_extract(value, '$.logicalDate') FROM json_each(?))
        AND l.scope_key LIKE 'bonus:%' AND (l.source_action_id IN (SELECT value FROM json_each(?)) OR
          (l.provenance_json IS NOT NULL AND CASE WHEN json_valid(l.provenance_json) = 0 THEN 1
            WHEN json_type(l.provenance_json, '$.facts') IS NOT 'array' THEN 1
            ELSE EXISTS (SELECT 1 FROM json_each(l.provenance_json, '$.facts') facts
              WHERE json_extract(facts.value, '$[0]') = 'habit_action'
                AND json_extract(facts.value, '$[1]') IN (SELECT value FROM json_each(?))) END))
        """, [pairs, ids, ids])
      for row in retained {
        guard let key = row.scopeKey else { throw IntentCoinError.invalid }
        let parts = key.split(separator: ":")
        guard parts.count == 3, parts[0] == "bonus" else { throw IntentCoinError.invalid }
        let root = String(parts[1]); try valid(root, row.logicalDate)
        scopes.insert(Scope(rootId: root, logicalDate: row.logicalDate))
      }
    }
    if scopes.isEmpty { return [] }
    let ordered = scopes.sorted { [$0.rootId, $0.logicalDate].lexicographicallyPrecedes([$1.rootId, $1.logicalDate]) }
    let scopeJSON = try json(ordered)
    _ = try saveActions("""
      SELECT a.* FROM habit_actions a
      WHERE a.logical_date IN (SELECT DISTINCT json_extract(value, '$.logicalDate') FROM json_each(?))
      AND EXISTS (SELECT 1 FROM json_each(?) scopes WHERE a.logical_date = json_extract(scopes.value, '$.logicalDate')
        AND (a.board_id = json_extract(scopes.value, '$.rootId') OR (a.policy_json IS NOT NULL AND CASE
          WHEN json_valid(a.policy_json) = 0 THEN 1
          ELSE json_extract(a.policy_json, '$.rootId') = json_extract(scopes.value, '$.rootId') END)))
      """, [scopeJSON, scopeJSON])
    _ = try saveRows("SELECT l.* FROM coin_ledger l WHERE l.scope_key IN (SELECT value FROM json_each(?))", [try json(ordered.map(\.key))])
    var refs: [String: References] = [:]
    var pending = Array(rows.values)
    while !pending.isEmpty {
      var actionIds = Set<String>(), rowIds = Set<String>()
      for row in pending {
        let facts = try row.provenanceJson.map(IntentCoinProvenance.parse) ?? []
        let ref = References(facts: facts,
          actions: Set([row.sourceActionId].compactMap { $0 } + facts.filter { $0[0] == "habit_action" }.map { $0[1] }),
          rows: Set([row.reversesId, row.adjustsId].compactMap { $0 } + facts.filter { $0[0] == "ledger_entry" }.map { $0[1] }))
        refs[row.id] = ref
        actionIds.formUnion(ref.actions.filter { actions[$0] == nil })
        rowIds.formUnion(ref.rows.filter { rows[$0] == nil })
      }
      if !actionIds.isEmpty {
        _ = try saveActions("SELECT a.* FROM habit_actions a WHERE a.id IN (SELECT value FROM json_each(?))", [try json(Array(actionIds))])
        guard actionIds.allSatisfy({ actions[$0] != nil }) else { throw IntentCoinError.missing }
      }
      pending = rowIds.isEmpty ? [] : try saveRows("SELECT l.* FROM coin_ledger l WHERE l.id IN (SELECT value FROM json_each(?))", [try json(Array(rowIds))])
      guard rowIds.allSatisfy({ rows[$0] != nil }) else { throw IntentCoinError.missing }
    }
    var digests: [String: String] = [:]
    for row in rows.values {
      guard let ref = refs[row.id] else { throw IntentCoinError.missing }
      guard ref.actions.allSatisfy({ actions[$0]?.logicalDate == row.logicalDate }),
        ref.rows.allSatisfy({ rows[$0]?.scopeKey == row.scopeKey }) else { throw IntentCoinError.invalid }
      if let id = row.reversesId, rows[id]?.kind != "run_bonus" { throw IntentCoinError.invalid }
      if let id = row.adjustsId, rows[id]?.kind != "adjustment" || rows[id]?.adjustsId != nil { throw IntentCoinError.invalid }
      for fact in ref.facts {
        if fact[0] == "ledger_entry", !["run_bonus", "reversal"].contains(rows[fact[1]]!.kind) { throw IntentCoinError.invalid }
        let key = fact[0] + "|" + fact[1]
        if digests[key] == nil {
          let canonical = try fact[0] == "habit_action" ? IntentCoinProvenance.actionCanonical(actions[fact[1]]!) : rows[fact[1]]!.canonical()
          digests[key] = IntentCoinProvenance.digest(canonical)
        }
        guard digests[key] == fact[2] else { throw IntentCoinError.invalid }
      }
    }
    var observations: [CheckScope: [IntentHabitAction]] = [:]
    for action in actions.values {
      if let json = action.policyJson, let root = try IntentCoinPolicy.parse(json).rootId {
        observations[CheckScope(boardId: root, logicalDate: action.logicalDate), default: []].append(action)
      }
    }
    var members: [Scope: Set<String>] = [:]
    var pairs = Set<CheckScope>()
    for scope in ordered {
      var ids: Set<String> = [scope.rootId]
      for action in observations[CheckScope(boardId: scope.rootId, logicalDate: scope.logicalDate)] ?? [] {
        ids.insert(action.boardId)
        ids.formUnion(try IntentCoinPolicy.parse(action.policyJson!).requiredBoardIds)
      }
      members[scope] = ids
      for id in ids { pairs.insert(CheckScope(boardId: id, logicalDate: scope.logicalDate)) }
    }
    let pairJSON = try json(Array(pairs))
    _ = try saveActions("""
      SELECT DISTINCT a.* FROM json_each(?) scopes JOIN habit_actions a
        ON a.board_id = json_extract(scopes.value, '$.boardId') AND a.logical_date = json_extract(scopes.value, '$.logicalDate')
      """, [pairJSON])
    var actionsByPair: [CheckScope: [IntentHabitAction]] = [:]
    for action in actions.values {
      actionsByPair[CheckScope(boardId: action.boardId, logicalDate: action.logicalDate), default: []].append(action)
    }
    var rowsByScope: [String: [IntentCoinLedgerRow]] = [:]
    for row in rows.values { rowsByScope[row.scopeKey!, default: []].append(row) }
    return try ordered.map { scope in
      let groupRows = rowsByScope[scope.key] ?? []
      var groupActions: [String: IntentHabitAction] = [:]
      for id in members[scope]! {
        let pair = CheckScope(boardId: id, logicalDate: scope.logicalDate)
        for action in actionsByPair[pair] ?? [] { groupActions[action.id] = action }
      }
      // direct causes remain available for missing-control recovery before envelope validation.
      for row in groupRows { for id in refs[row.id]!.actions { groupActions[id] = actions[id]! } }
      guard groupActions.count + groupRows.filter({ $0.kind != "adjustment" }).count <= IntentCoinJSON.proofFacts else {
        throw IntentCoinError.size
      }
      return Group(scope: scope, actions: groupActions.values.sorted(by: IntentBonusCoinCauses.precedes),
        rows: groupRows.sorted { [$0.mutationStamp, $0.id].lexicographicallyPrecedes([$1.mutationStamp, $1.id]) })
    }
  }

  private static func valid(_ id: String, _ date: String) throws {
    guard IntentCoinJSON.uuid(id), IntentCalendar.isValidDate(date) else { throw IntentCoinError.invalid }
  }
  private static func json<Value: Encodable>(_ value: Value) throws -> IntentSQLValue {
    .text(String(decoding: try JSONEncoder().encode(value), as: UTF8.self))
  }
}
