import Foundation

// callers own the transaction. visibility changes no payload, clock, receipt, or outbox.
enum IntentCheckVisibility {
  private struct Token: Encodable { let id: String; let boardId: String; let logicalDate: String }

  static func refresh(database: IntentDatabase, scopes: [IntentBonusEvidence.CheckScope]) throws {
    let scopes = Array(Set(scopes)).sorted { [$0.boardId, $0.logicalDate].lexicographicallyPrecedes([$1.boardId, $1.logicalDate]) }
    for scope in scopes {
      guard IntentCoinJSON.uuid(scope.boardId), IntentCalendar.isValidDate(scope.logicalDate) else { throw IntentCoinError.invalid }
    }
    if scopes.isEmpty { return }
    let encoded = IntentSQLValue.text(String(decoding: try JSONEncoder().encode(scopes), as: UTF8.self))
    let actions = try database.rows("""
      SELECT a.* FROM json_each(?) scopes JOIN habit_actions a
        ON a.board_id = json_extract(scopes.value, '$.boardId')
          AND a.logical_date = json_extract(scopes.value, '$.logicalDate')
      """, [encoded]).map(IntentCoinStore.action)
    let byScope = Dictionary(grouping: actions) { IntentBonusEvidence.CheckScope(boardId: $0.boardId, logicalDate: $0.logicalDate) }
    var active: [Token] = []
    for scope in scopes {
      let ordered = try IntentCheckCoins.ordered(boardId: scope.boardId, logicalDate: scope.logicalDate, actions: byScope[scope] ?? [])
      active += IntentHabitAction.activeCheckInIds(ordered).map { Token(id: $0, boardId: scope.boardId, logicalDate: scope.logicalDate) }
    }
    try database.run("""
      UPDATE check_ins SET state_suppressed = 1 WHERE state_suppressed != 1 AND id IN (
        SELECT c.id FROM json_each(?) scopes JOIN check_ins c
          ON c.board_id = json_extract(scopes.value, '$.boardId')
            AND c.logical_date = json_extract(scopes.value, '$.logicalDate'))
      """, [encoded])
    let tokens = IntentSQLValue.text(String(decoding: try JSONEncoder().encode(active), as: UTF8.self))
    try database.run("""
      UPDATE check_ins SET state_suppressed = 0 WHERE state_suppressed != 0 AND id IN (
        SELECT c.id FROM json_each(?) tokens JOIN check_ins c ON c.id = json_extract(tokens.value, '$.id')
          AND c.board_id = json_extract(tokens.value, '$.boardId')
          AND c.logical_date = json_extract(tokens.value, '$.logicalDate') WHERE c.deleted_at IS NULL)
      """, [tokens])
  }
}
