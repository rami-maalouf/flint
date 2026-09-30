import Foundation

enum IntentCoinError: Error { case invalid, size, missing }

enum IntentCoinJSON {
  static let policyBytes = 196_608
  static let recordBytes = 786_432
  static let proofBytes = 524_288
  static let proofFacts = 4096
  static let safeInteger: Int64 = 9_007_199_254_740_991
  static func encode(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
  }
  static func uuid(_ value: String, version: Int = 4) -> Bool {
    value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-\(version)[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
  }
}

struct IntentCoinPolicy: Codable, Equatable {
  let version: Int
  let boardKind: String
  let earnsCoins: Bool
  let coinCapPerDay: Int
  let checkClosesAtUtc: Int64
  let rootId: String?
  let requiredBoardIds: [String]
  let bonusClosesAtUtc: Int64?
  let bonusEnabled: Bool

  func canonical() throws -> String {
    guard version == 1, ["daily", "count"].contains(boardKind), (1...10).contains(coinCapPerDay),
      (-IntentCoinJSON.safeInteger...IntentCoinJSON.safeInteger).contains(checkClosesAtUtc),
      rootId.map({ IntentCoinJSON.uuid($0) }) ?? true,
      requiredBoardIds.allSatisfy({ IntentCoinJSON.uuid($0) }),
      zip(requiredBoardIds, requiredBoardIds.dropFirst()).allSatisfy({ $0 < $1 }),
      bonusClosesAtUtc.map({ (-IntentCoinJSON.safeInteger...IntentCoinJSON.safeInteger).contains($0) }) ?? true,
      (rootId == nil ? requiredBoardIds.isEmpty && bonusClosesAtUtc == nil && !bonusEnabled : bonusClosesAtUtc != nil),
      !bonusEnabled || !requiredBoardIds.isEmpty else { throw IntentCoinError.invalid }
    let pairs: [(String, Any)] = [("version", version), ("boardKind", boardKind), ("earnsCoins", earnsCoins),
      ("coinCapPerDay", coinCapPerDay), ("checkClosesAtUtc", checkClosesAtUtc), ("rootId", rootId as Any? ?? NSNull()),
      ("requiredBoardIds", requiredBoardIds), ("bonusClosesAtUtc", bonusClosesAtUtc as Any? ?? NSNull()), ("bonusEnabled", bonusEnabled)]
    let json = try "{" + pairs.map { try IntentCoinJSON.encode($0.0) + ":" + IntentCoinJSON.encode($0.1) }.joined(separator: ",") + "}"
    guard json.utf8.count <= IntentCoinJSON.policyBytes else { throw IntentCoinError.size }
    return json
  }

  static func parse(_ json: String) throws -> Self {
    guard json.utf8.count <= IntentCoinJSON.policyBytes else { throw IntentCoinError.size }
    guard let value = try? JSONDecoder().decode(Self.self, from: Data(json.utf8)) else { throw IntentCoinError.invalid }
    guard try value.canonical() == json else { throw IntentCoinError.invalid }
    return value
  }
}
