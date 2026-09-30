import Foundation

enum IntentBonusCoinCauses {
  static func precedes(_ first: IntentHabitAction, _ second: IntentHabitAction) -> Bool {
    if (first.kind == "baseline") != (second.kind == "baseline") { return first.kind == "baseline" }
    return [first.mutationStamp, first.id].lexicographicallyPrecedes([second.mutationStamp, second.id])
  }

  private struct Candidate { let policy: IntentCoinPolicy; let row: IntentCoinLedgerRow }

  private static func candidates(source: IntentHabitAction, rootId: String, actions: [IntentHabitAction]) throws -> [String: Candidate] {
    guard source.kind == "check", let sourceJSON = source.policyJson else { throw IntentCoinError.invalid }
    let observation = try IntentCoinPolicy.parse(sourceJSON)
    var policies: [IntentCoinPolicy] = observation.rootId == rootId ? [observation] : []
    for action in actions where action.kind == "policy" && action.boardId == rootId && !precedes(source, action) {
      if let json = action.policyJson {
        let policy = try IntentCoinPolicy.parse(json)
        if policy.rootId == rootId { policies.append(policy) }
      }
    }
    var result: [String: Candidate] = [:]
    for policy in policies {
      let row = try IntentBonusCoins.award(source, policy: policy)
      result[row.id] = Candidate(policy: policy, row: row)
    }
    return result
  }

  static func validateOrdinary(rootId: String, actions: [IntentHabitAction], rows: [IntentCoinLedgerRow]) throws {
    let causes = Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0) })
    let entries = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    let awards = Dictionary(uniqueKeysWithValues: rows.filter { $0.kind == "run_bonus" }.map { ($0.id, $0) })
    var policies: [String: IntentCoinPolicy] = [:]
    // this cache belongs only to this exact evidence set, including each proof subset.
    var cache: [String: [String: Candidate]] = [:]
    for award in awards.values {
      guard let source = award.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
      if cache[source.id] == nil { cache[source.id] = try candidates(source: source, rootId: rootId, actions: actions) }
      guard let candidate = cache[source.id]?[award.id] else { throw IntentCoinError.missing }
      let policy = candidate.policy
      guard policy.bonusEnabled, policy.requiredBoardIds.contains(source.boardId), candidate.row == award else { throw IntentCoinError.invalid }
      for boardId in policy.requiredBoardIds {
        guard actions.contains(where: { $0.boardId == boardId && ["baseline", "check", "move_in"].contains($0.kind) && !precedes(source, $0) }) else {
          throw IntentCoinError.missing
        }
      }
      policies[award.id] = policy
    }
    for row in rows where row.kind != "run_bonus" {
      guard let award = row.reversesId.flatMap({ entries[$0] }) else { throw IntentCoinError.missing }
      guard award.kind == "run_bonus" else { throw IntentCoinError.invalid }
      guard let policy = policies[award.id],
        let source = award.sourceActionId.flatMap({ causes[$0] }), let cause = row.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
      guard row.kind == "reversal", ["uncheck", "move_out"].contains(cause.kind),
        policy.requiredBoardIds.contains(cause.boardId), cause.createdAt < policy.bonusClosesAtUtc!, precedes(source, cause) else { throw IntentCoinError.invalid }
      if let token = cause.checkInId {
        guard actions.contains(where: { $0.boardId == cause.boardId && $0.checkInId == token &&
          ["baseline", "check", "move_in"].contains($0.kind) && precedes($0, cause) }) else { throw IntentCoinError.missing }
      }
      guard try IntentBonusCoins.reversal(cause, award: award) == row else { throw IntentCoinError.invalid }
    }
  }
}
