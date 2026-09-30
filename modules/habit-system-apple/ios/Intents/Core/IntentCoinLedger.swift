import Foundation

struct IntentCoinLedgerRow: Codable, Equatable {
  let id: String; let kind: String; let delta: Int64
  let boardId: String?; let checkInId: String?; let runKey: String?
  let rewardId: String?; let rewardTitleSnapshot: String?; let reversesId: String?
  let scopeKey: String?; let sourceActionId: String?; let reconciliationKey: String?
  let adjustsId: String?; let provenanceJson: String?; let logicalDate: String
  let createdAt: Int64; let mutationStamp: String; let deletedAt: Int64?

  static func == (left: Self, right: Self) -> Bool {
    guard let lhs = try? left.canonical(), let rhs = try? right.canonical() else { return false }
    return lhs.utf8.elementsEqual(rhs.utf8)
  }

  static func totals(_ rows: [Self]) throws -> (earned: Int64, spent: Int64, balance: Int64) {
    var earned: Int64 = 0
    var spent: Int64 = 0
    for row in rows {
      try row.validateShape()
      if row.delta > 0 { earned += row.delta } else { spent -= row.delta }
      guard earned <= IntentCoinJSON.safeInteger, spent <= IntentCoinJSON.safeInteger else { throw IntentCoinError.invalid }
    }
    return (earned, spent, earned - spent)
  }

  func validateShape() throws {
    let roles: [String: Set<String>] = ["check": ["boardId", "checkInId", "scopeKey", "sourceActionId"],
      "run_bonus": ["runKey", "scopeKey", "sourceActionId"], "claim": ["rewardId", "rewardTitleSnapshot"],
      "reversal": ["reversesId", "scopeKey", "sourceActionId"],
      "adjustment": ["scopeKey", "reconciliationKey", "provenanceJson", "adjustsId"]]
    guard let role = roles[kind], IntentCoinJSON.uuid(id, version: kind == "claim" ? 4 : 5),
      (-IntentCoinJSON.safeInteger...IntentCoinJSON.safeInteger).contains(delta), delta != 0,
      (0...IntentCoinJSON.safeInteger).contains(createdAt), IntentCalendar.isValidDate(logicalDate), deletedAt == nil,
      mutationStamp.range(of: "^[0-9]{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    else { throw IntentCoinError.invalid }
    let values: [(String, String?)] = [("boardId", boardId), ("checkInId", checkInId), ("runKey", runKey),
      ("rewardId", rewardId), ("rewardTitleSnapshot", rewardTitleSnapshot), ("reversesId", reversesId),
      ("scopeKey", scopeKey), ("sourceActionId", sourceActionId), ("reconciliationKey", reconciliationKey),
      ("adjustsId", adjustsId), ("provenanceJson", provenanceJson)]
    for (key, value) in values {
      if role.contains(key) {
        guard value != nil || (kind == "adjustment" && key == "adjustsId") else { throw IntentCoinError.invalid }
      } else if value != nil { throw IntentCoinError.invalid }
    }
    guard (["check", "run_bonus"].contains(kind) ? delta == 1 : kind == "adjustment" || delta < 0),
      [boardId, checkInId, rewardId, sourceActionId].allSatisfy({ $0.map { IntentCoinJSON.uuid($0) } ?? true }),
      [reversesId, adjustsId].allSatisfy({ $0.map { IntentCoinJSON.uuid($0, version: 5) } ?? true }) else { throw IntentCoinError.invalid }
    if let scopeKey {
      let parts = scopeKey.components(separatedBy: ":")
      guard parts.count == 3, ["check", "bonus"].contains(parts[0]), IntentCoinJSON.uuid(parts[1]), parts[2] == logicalDate,
        kind != "check" || scopeKey == "check:\(boardId!):\(logicalDate)",
        kind != "run_bonus" || (parts[0] == "bonus" && runKey == "\(parts[1])|\(logicalDate)") else { throw IntentCoinError.invalid }
    }
    if let title = rewardTitleSnapshot {
      let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
      guard !title.isEmpty, title.unicodeScalars.count <= 80, title.trimmingCharacters(in: whitespace) == title else { throw IntentCoinError.invalid }
    }
    if let key = reconciliationKey, key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) == nil { throw IntentCoinError.invalid }
    if let proof = provenanceJson { _ = try IntentCoinProvenance.parse(proof) }
    guard try canonical().utf8.count <= IntentCoinJSON.recordBytes else { throw IntentCoinError.size }
  }

  func canonical() throws -> String {
    func nullable(_ value: Any?) -> Any { value ?? NSNull() }
    return try IntentCoinJSON.encode(["habit-ledger-row-v1", id, kind, delta, nullable(boardId), nullable(checkInId),
      nullable(runKey), nullable(rewardId), nullable(rewardTitleSnapshot), nullable(reversesId), nullable(scopeKey),
      nullable(sourceActionId), nullable(reconciliationKey), nullable(adjustsId), nullable(provenanceJson),
      logicalDate, createdAt, mutationStamp, nullable(deletedAt)])
  }

  static func check(_ action: IntentHabitAction, reversing award: Self? = nil) throws -> Self {
    let scope = "check:\(action.boardId):\(action.logicalDate)"
    let kind = award == nil ? "check" : "reversal"
    let name = ["habit-ledger-v1", kind, award?.id ?? scope, action.id]
    let row = Self(id: IntentHabitAction.uuidV5(name: try IntentCoinJSON.encode(name)), kind: kind,
      delta: award.map { -$0.delta } ?? 1, boardId: award == nil ? action.boardId : nil,
      checkInId: award == nil ? action.checkInId : nil, runKey: nil, rewardId: nil,
      rewardTitleSnapshot: nil, reversesId: award?.id, scopeKey: scope, sourceActionId: action.id,
      reconciliationKey: nil, adjustsId: nil, provenanceJson: nil, logicalDate: action.logicalDate,
      createdAt: action.createdAt, mutationStamp: action.mutationStamp, deletedAt: nil)
    try row.validateShape()
    return row
  }
}
