import CloudKit
import CoreFoundation
import Foundation

enum CloudKitFieldValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case null

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() { self = .null }
    else if let string = try? value.decode(String.self) { self = .string(string) }
    else if let number = try? value.decode(Double.self), number.isFinite { self = .number(number) }
    else { throw CloudKitFailure.failure }
  }

  func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .string(let string): try value.encode(string)
    case .number(let number): try value.encode(number)
    case .null: try value.encodeNil()
    }
  }

  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }
}

struct CloudKitWireRecord: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let entityType: String
  let entityId: String
  let mutationStamp: String
  let deleted: Bool
  var fields: [String: CloudKitFieldValue]

  enum CodingKeys: String, CodingKey, CaseIterable { case schemaVersion, entityType, entityId, mutationStamp, deleted, fields }
  private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }
  init(schemaVersion: Int, entityType: String, entityId: String, mutationStamp: String, deleted: Bool, fields: [String: CloudKitFieldValue]) {
    self.schemaVersion = schemaVersion; self.entityType = entityType; self.entityId = entityId
    self.mutationStamp = mutationStamp; self.deleted = deleted; self.fields = fields
  }
  init(from decoder: Decoder) throws {
    let raw = try decoder.container(keyedBy: AnyKey.self)
    guard Set(raw.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw CloudKitFailure.failure }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
    entityType = try values.decode(String.self, forKey: .entityType)
    entityId = try values.decode(String.self, forKey: .entityId)
    mutationStamp = try values.decode(String.self, forKey: .mutationStamp)
    deleted = try values.decode(Bool.self, forKey: .deleted)
    fields = try values.decode([String: CloudKitFieldValue].self, forKey: .fields)
  }
}

struct CloudKitWirePage: Codable, Sendable {
  let records: [CloudKitWireRecord]
  let nextToken: String?
  let more: Bool

  enum CodingKeys: String, CodingKey { case records, nextToken, more }

  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(records, forKey: .records)
    try values.encode(nextToken, forKey: .nextToken)
    try values.encode(more, forKey: .more)
  }
}

enum CloudKitRecordMapping {
  static let versionOneColumns: [String: [String]] = [
    "board": ["id", "title", "symbol", "accent_hex", "uses_tinted_background", "tracks_amount",
      "amount_unit", "quick_amount", "tracks_time", "start_of_day_minute", "metrics_enabled",
      "order_key", "archived_at", "created_at", "updated_at", "deleted_at"],
    "check_in": ["id", "board_id", "logical_date", "occurred_at_utc", "time_zone_id", "offset_minutes",
      "amount", "note", "source", "idempotency_key", "created_at", "updated_at", "deleted_at"],
    "reminder": ["id", "board_id", "weekdays_mask", "minute_of_day", "message", "enabled",
      "created_at", "updated_at", "deleted_at"],
    "activity_period": ["board_id", "start_date", "end_date", "deleted_at"],
    "settings": ["metrics_education_dismissed"]
  ]

  static let versionTwoColumns: [String: [String]] = {
    var columns = versionOneColumns
    columns["board"]! += ["kind", "anchor_relation", "anchor_kind", "anchor_board_id", "anchor_preset", "anchor_text",
      "usual_time_minute", "required_in_stack", "earns_coins", "coin_cap_per_day"]
    columns["settings"]! += ["wake_minute", "lunch_minute", "dinner_minute", "sleep_minute"]
    columns["reward"] = ["id", "title", "cost_coins", "symbol", "accent_hex", "order_key", "archived_at", "created_at", "updated_at", "deleted_at"]
    columns["habit_action"] = ["id", "command_id", "board_id", "logical_date", "check_in_id", "kind", "created_at", "policy_json"]
    columns["ledger_entry"] = ["id", "kind", "delta", "board_id", "check_in_id", "run_key", "reward_id", "reward_title_snapshot",
      "reverses_id", "scope_key", "source_action_id", "reconciliation_key", "adjusts_id", "provenance_json", "logical_date", "created_at", "deleted_at"]
    return columns
  }()

  static func keys(version: Int, type: String) throws -> [String] {
    guard let keys = (version == 1 ? versionOneColumns : version == 2 ? versionTwoColumns : [:])[type] else { throw CloudKitFailure.failure }
    return keys
  }
  static func immutable(_ type: String) -> Bool { type == "habit_action" || type == "ledger_entry" }
  static func sameBytes(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
  static func uuid(_ value: String) -> Bool {
    value.range(of: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[45][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$", options: .regularExpression) != nil
  }
  static func validStamp(_ value: String) -> Bool {
    value.range(of: "^[0-9]{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$", options: .regularExpression) != nil
  }

  private static let numeric: Set<String> = ["uses_tinted_background", "tracks_amount", "quick_amount", "tracks_time", "start_of_day_minute",
    "metrics_enabled", "archived_at", "created_at", "updated_at", "deleted_at", "occurred_at_utc", "offset_minutes", "amount",
    "weekdays_mask", "minute_of_day", "enabled", "usual_time_minute", "required_in_stack", "earns_coins",
    "coin_cap_per_day", "wake_minute", "lunch_minute", "dinner_minute", "sleep_minute", "cost_coins", "delta"]
  private static let nullable: [String: Set<String>] = [
    "board": ["amount_unit", "archived_at", "deleted_at", "anchor_relation", "anchor_kind", "anchor_board_id", "anchor_preset", "anchor_text", "usual_time_minute"],
    "check_in": ["occurred_at_utc", "time_zone_id", "offset_minutes", "amount", "note", "deleted_at"],
    "activity_period": ["end_date", "deleted_at"], "reminder": ["message", "deleted_at"], "settings": [],
    "reward": ["archived_at", "deleted_at"], "habit_action": ["command_id", "check_in_id", "policy_json"],
    "ledger_entry": ["board_id", "check_in_id", "run_key", "reward_id", "reward_title_snapshot", "reverses_id", "scope_key", "source_action_id",
      "reconciliation_key", "adjusts_id", "provenance_json", "deleted_at"]
  ]

  // these empty values match records.ts and preserve sqlite's required columns.
  private static let tombstoneValues: [String: [String: CloudKitFieldValue]] = [
    "board": ["title": .string(""), "symbol": .string(""), "accent_hex": .string(""),
      "amount_unit": .null, "quick_amount": .number(0), "uses_tinted_background": .number(0),
      "tracks_amount": .number(0), "tracks_time": .number(0), "start_of_day_minute": .number(0),
      "metrics_enabled": .number(0), "archived_at": .null],
    "check_in": ["note": .null, "amount": .null, "logical_date": .string(""),
      "occurred_at_utc": .null, "time_zone_id": .null, "offset_minutes": .null],
    "reminder": ["message": .null, "weekdays_mask": .number(0), "minute_of_day": .number(0),
      "enabled": .number(0)],
    "activity_period": ["end_date": .null],
    "settings": [:],
    "reward": ["title": .string(""), "symbol": .string(""), "accent_hex": .string(""), "archived_at": .null, "cost_coins": .number(1)]
  ]

  static func normalizedInbound(_ input: CloudKitWireRecord) throws -> CloudKitWireRecord {
    _ = try keys(version: input.schemaVersion, type: input.entityType)
    guard !input.entityId.isEmpty, input.entityId.utf8.count <= 255 else { throw CloudKitFailure.failure }
    for value in input.fields.values { if case .number(let number) = value, !number.isFinite { throw CloudKitFailure.failure } }
    if immutable(input.entityType) {
      guard uuid(input.entityId) else { throw CloudKitFailure.failure }
    }
    if input.schemaVersion == 2 {
      try CloudKitWireCodec.checkRecord(input)
      // admission and mutable validation own inner defects, without transport repair.
      return input
    }
    return try normalizedOutbound(input)
  }

  static func normalizedOutbound(_ input: CloudKitWireRecord) throws -> CloudKitWireRecord {
    let keys = try keys(version: input.schemaVersion, type: input.entityType)
    guard Set(input.fields.keys) == Set(keys), !input.entityId.isEmpty, input.entityId.utf8.count <= 255,
      validStamp(input.mutationStamp) else { throw CloudKitFailure.failure }
    for (key, value) in input.fields {
      if input.schemaVersion == 1 {
        if case .number(let number) = value, !number.isFinite { throw CloudKitFailure.failure }
        continue
      }
      switch value {
      case .null: guard nullable[input.entityType]!.contains(key) else { throw CloudKitFailure.failure }
      case .string: guard !numeric.contains(key) else { throw CloudKitFailure.failure }
      case .number(let number): guard numeric.contains(key), number.isFinite else { throw CloudKitFailure.failure }
      }
    }
    switch input.entityType {
    case "settings": guard input.entityId == "app-settings", !input.deleted else { throw CloudKitFailure.failure }
    case "activity_period":
      guard let boardId = input.fields["board_id"]?.string, let startDate = input.fields["start_date"]?.string,
        sameBytes(input.entityId, "\(boardId)|\(startDate)") else { throw CloudKitFailure.failure }
    default: guard let id = input.fields["id"]?.string, sameBytes(id, input.entityId) else { throw CloudKitFailure.failure }
    }
    if input.schemaVersion == 2, !immutable(input.entityType), input.entityType != "settings" {
      guard input.deleted == (input.fields["deleted_at"] != .null) else { throw CloudKitFailure.failure }
    }
    if input.schemaVersion == 2, input.entityType == "board", !input.deleted,
      input.fields["anchor_kind"] == .string("board"), let target = input.fields["anchor_board_id"]?.string {
      guard !sameBytes(target, input.entityId) else { throw CloudKitFailure.failure }
    }
    if immutable(input.entityType) {
      guard uuid(input.entityId), !input.deleted else { throw CloudKitFailure.failure }
      for value in input.fields.values { if case .number(let number) = value {
        guard number.rounded(.towardZero) == number, abs(number) <= 9_007_199_254_740_991, !(number == 0 && number.sign == .minus) else { throw CloudKitFailure.failure }
      } }
      if input.entityType == "ledger_entry" {
        guard input.fields["deleted_at"] == .null, ["check", "run_bonus", "claim", "reversal", "adjustment"].contains(input.fields["kind"]?.string ?? "") else { throw CloudKitFailure.failure }
      } else {
        guard ["check", "uncheck", "move_out", "move_in", "policy", "baseline"].contains(input.fields["kind"]?.string ?? "") else { throw CloudKitFailure.failure }
      }
    }
    var output = input
    if input.deleted {
      for (key, value) in tombstoneValues[input.entityType] ?? [:] { output.fields[key] = value }
      if input.entityType == "board", input.schemaVersion == 2 {
        for key in ["anchor_relation", "anchor_kind", "anchor_board_id", "anchor_preset", "anchor_text", "usual_time_minute"] { output.fields[key] = .null }
        output.fields["kind"] = .string("count"); output.fields["required_in_stack"] = .number(0)
        output.fields["earns_coins"] = .number(0); output.fields["coin_cap_per_day"] = .number(1)
      }
      if input.entityType == "check_in" { output.fields["source"] = .string("sync"); output.fields["idempotency_key"] = .string(input.entityId) }
    }
    try CloudKitWireCodec.checkRecord(output)
    return output
  }

  static func sameImmutable(_ a: CloudKitWireRecord, _ b: CloudKitWireRecord) -> Bool {
    guard a.schemaVersion == b.schemaVersion, sameBytes(a.entityType, b.entityType), sameBytes(a.entityId, b.entityId),
      sameBytes(a.mutationStamp, b.mutationStamp), a.deleted == b.deleted, a.fields.count == b.fields.count else { return false }
    for (key, value) in a.fields {
      guard let other = b.fields[key] else { return false }
      switch (value, other) {
      case (.string(let left), .string(let right)): if !sameBytes(left, right) { return false }
      case (.number(let left), .number(let right)): if left != right || (left == 0 && left.sign != right.sign) { return false }
      case (.null, .null): break
      default: return false
      }
    }
    return true
  }

  static func toRecord(_ input: CloudKitWireRecord, zoneID: CKRecordZone.ID, existing: CKRecord? = nil) throws -> CKRecord {
    let input = try normalizedOutbound(input)
    let id = CKRecord.ID(recordName: input.entityId, zoneID: zoneID)
    if let existing, existing.recordID != id || existing.recordType != input.entityType {
      throw CloudKitFailure.failure
    }
    let record = existing?.copy() as? CKRecord ?? CKRecord(recordType: input.entityType, recordID: id)
    // conditional saves preserve the fetched change tag; clearing every old key
    // ensures a tombstone also erases previously stored user content.
    for key in record.allKeys() { record[key] = nil }
    record["schema_version"] = NSNumber(value: input.schemaVersion)
    record["mutation_stamp"] = input.mutationStamp as NSString
    record["deleted"] = NSNumber(value: input.deleted)
    for (key, value) in input.fields {
      switch value {
      case .string(let string): record[key] = string as NSString
      case .number(let number): record[key] = NSNumber(value: number)
      case .null: record[key] = nil
      }
    }
    return record
  }

  static func fromRecord(_ record: CKRecord) throws -> CloudKitWireRecord {
    guard let version = record["schema_version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1 || version.doubleValue == 2,
      let stamp = record["mutation_stamp"] as? String, let deleted = record["deleted"] as? NSNumber,
      deleted.doubleValue == 0 || deleted.doubleValue == 1 else { throw CloudKitFailure.failure }
    let versionNumber = version.intValue
    let declared = try keys(version: versionNumber, type: record.recordType)
    let extras = versionNumber == 2 ? record.allKeys().filter { !["schema_version", "mutation_stamp", "deleted"].contains($0) } : []
    var fields: [String: CloudKitFieldValue] = [:]
    for key in Set(declared + extras) {
      switch record[key] {
      case nil: fields[key] = .null
      case let value as String: fields[key] = .string(value)
      case let value as NSNumber where value.doubleValue.isFinite:
        if versionNumber == 2 {
          guard CFGetTypeID(value) != CFBooleanGetTypeID() else { throw CloudKitFailure.failure }
          let code = String(cString: value.objCType)
          if ["q", "l", "i", "s", "c"].contains(code), Double(exactly: value.int64Value) == nil { throw CloudKitFailure.failure }
          if ["Q", "L", "I", "S", "C"].contains(code), Double(exactly: value.uint64Value) == nil { throw CloudKitFailure.failure }
        }
        fields[key] = .number(value.doubleValue)
      default: throw CloudKitFailure.failure
      }
    }
    return try normalizedInbound(CloudKitWireRecord(schemaVersion: versionNumber, entityType: record.recordType,
      entityId: record.recordID.recordName, mutationStamp: stamp, deleted: deleted.boolValue, fields: fields))
  }
}
