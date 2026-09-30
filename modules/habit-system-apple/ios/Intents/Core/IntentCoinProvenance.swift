import CryptoKit
import Foundation

enum IntentCoinProvenance {
  static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  static func canonical(_ facts: [[String]]) throws -> String {
    guard facts.count <= IntentCoinJSON.proofFacts else { throw IntentCoinError.size }
    var seen = Set<[String]>()
    for (index, fact) in facts.enumerated() {
      guard fact.count == 3, ["habit_action", "ledger_entry"].contains(fact[0]),
        IntentCoinJSON.uuid(fact[1], version: 5) || (fact[0] == "habit_action" && IntentCoinJSON.uuid(fact[1])),
        fact[2].range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        index == 0 || facts[index - 1].lexicographicallyPrecedes(fact),
        seen.insert(Array(fact.prefix(2))).inserted else { throw IntentCoinError.invalid }
    }
    let json = "{\"version\":1,\"facts\":" + (try IntentCoinJSON.encode(facts)) + "}"
    guard json.utf8.count <= IntentCoinJSON.proofBytes else { throw IntentCoinError.size }
    return json
  }
  static func parse(_ json: String) throws -> [[String]] {
    guard json.utf8.count <= IntentCoinJSON.proofBytes else { throw IntentCoinError.size }
    struct Proof: Decodable { let version: Int; let facts: [[String]] }
    guard let proof = try? JSONDecoder().decode(Proof.self, from: Data(json.utf8)), proof.version == 1,
      try canonical(proof.facts) == json else { throw IntentCoinError.invalid }
    return proof.facts
  }
  static func actionCanonical(_ action: IntentHabitAction) throws -> String {
    func nullable(_ value: String?) -> Any { value as Any? ?? NSNull() }
    return try IntentCoinJSON.encode([action.id, nullable(action.commandId), action.boardId, action.logicalDate,
      nullable(action.checkInId), action.kind, action.createdAt, action.mutationStamp, nullable(action.policyJson)])
  }
}
