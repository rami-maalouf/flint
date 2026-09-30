import Foundation

// canonical tuples already bound their values. a json bridge may escape every
// byte as six ascii characters; the fixed allowance covers field/envelope keys.
enum CloudKitWireCodec {
  static let canonicalRecordBytes = 786_432
  static let recordBytes = 6 * canonicalRecordBytes + 8_192
  static let recordCount = 200
  static let tokenBytes = 1_048_576
  static let syntaxBytes = 8_192
  static let uploadBytes = recordCount * recordBytes + syntaxBytes
  static let pageBytes = uploadBytes + 6 * tokenBytes

  static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
  }

  static func checkRecord(_ record: CloudKitWireRecord) throws {
    // reject oversized captured strings before creating a second encoded copy.
    var bytes = record.entityId.utf8.count + record.entityType.utf8.count + record.mutationStamp.utf8.count
    guard bytes <= recordBytes else { throw CloudKitFailure.failure }
    for (key, value) in record.fields {
      bytes += key.utf8.count
      if case .string(let text) = value { bytes += text.utf8.count }
      guard bytes <= recordBytes else { throw CloudKitFailure.failure }
    }
    guard try encoder().encode(record).count <= recordBytes else { throw CloudKitFailure.failure }
  }

  static func checkBudget(records: Int, recordsBytes: Int, tokenUTF8Bytes: Int, encodedOverheadBytes: Int) throws {
    guard records >= 0, records <= recordCount, recordsBytes >= 0, recordsBytes <= records * recordBytes,
      tokenUTF8Bytes >= 0, tokenUTF8Bytes <= tokenBytes, encodedOverheadBytes >= 0,
      encodedOverheadBytes <= 6 * tokenUTF8Bytes + syntaxBytes,
      recordsBytes + encodedOverheadBytes <= pageBytes else { throw CloudKitFailure.failure }
  }

  private struct Upload: Decodable {
    let records: [CloudKitWireRecord]
    init(from decoder: Decoder) throws {
      var values = try decoder.unkeyedContainer()
      guard let count = values.count, count <= recordCount else { throw CloudKitFailure.failure }
      var records: [CloudKitWireRecord] = []
      records.reserveCapacity(count)
      while !values.isAtEnd { records.append(try values.decode(CloudKitWireRecord.self)) }
      self.records = records
    }
  }

  static func decodeUpload(_ json: String) throws -> [CloudKitWireRecord] {
    guard json.utf8.count <= uploadBytes else { throw CloudKitFailure.failure }
    let records = try JSONDecoder().decode(Upload.self, from: Data(json.utf8)).records
    for record in records { try checkRecord(record) }
    return try records.map(CloudKitRecordMapping.normalizedOutbound)
  }

  static func encodePage(_ page: CloudKitWirePage) throws -> String {
    guard page.records.count <= recordCount, (page.nextToken?.utf8.count ?? 0) <= tokenBytes else { throw CloudKitFailure.failure }
    var recordsBytes = 0
    for record in page.records { try checkRecord(record); recordsBytes += try encoder().encode(record).count }
    let overhead = try encoder().encode(CloudKitWirePage(records: [], nextToken: page.nextToken, more: page.more)).count + page.records.count
    try checkBudget(records: page.records.count, recordsBytes: recordsBytes, tokenUTF8Bytes: page.nextToken?.utf8.count ?? 0, encodedOverheadBytes: overhead)
    let data = try encoder().encode(page)
    guard data.count <= pageBytes, let text = String(data: data, encoding: .utf8) else { throw CloudKitFailure.failure }
    return text
  }
}
