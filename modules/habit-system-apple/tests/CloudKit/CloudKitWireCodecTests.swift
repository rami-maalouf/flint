import CloudKit
import Foundation
import XCTest
@testable import HabitSystemCloudKit

final class CloudKitWireCodecTests: XCTestCase {
  func testBridgeRejectsUnknownOuterKeysAndNonScalarFieldsBeforeUpload() throws {
    let row = try schemaTwoFixtures().last!
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: CloudKitWireCodec.encoder().encode(row)) as? [String: Any])
    object["extra_envelope"] = "cannot silently discard"
    let extra = String(decoding: try JSONSerialization.data(withJSONObject: [object]), as: UTF8.self)
    XCTAssertThrowsError(try CloudKitWireCodec.decodeUpload(extra))
    object.removeValue(forKey: "extra_envelope")
    var fields = object["fields"] as! [String: Any]
    for bad in [true, ["nested": 1], [1]] as [Any] {
      fields["delta"] = bad; object["fields"] = fields
      XCTAssertThrowsError(try CloudKitWireCodec.decodeUpload(String(decoding: JSONSerialization.data(withJSONObject: [object]), as: UTF8.self)))
    }
  }

  func testBridgeCountAndActualPerRecordBoundsAreIndependentOfAggregateAllowance() throws {
    let row = try schemaTwoFixtures().last!
    let encoder = CloudKitWireCodec.encoder()
    XCTAssertEqual(try CloudKitWireCodec.decodeUpload(String(decoding: encoder.encode(Array(repeating: row, count: 200)), as: UTF8.self)).count, 200)
    XCTAssertThrowsError(try CloudKitWireCodec.decodeUpload(String(decoding: encoder.encode(Array(repeating: row, count: 201)), as: UTF8.self)))
    var huge = row
    huge.fields["reward_title_snapshot"] = .string(String(repeating: "a", count: CloudKitWireCodec.recordBytes))
    XCTAssertThrowsError(try CloudKitWireCodec.checkRecord(huge))
    XCTAssertThrowsError(try CloudKitWireCodec.encodePage(CloudKitWirePage(records: [huge], nextToken: nil, more: false)))
  }

  func testTokenAndSyntaxBudgetsPreserveTheExistingOneMiBTokenContractEvenOnEmptyPages() throws {
    let token = String(repeating: "a", count: CloudKitWireCodec.tokenBytes)
    let json = try CloudKitWireCodec.encodePage(CloudKitWirePage(records: [], nextToken: token, more: false))
    let page = try JSONDecoder().decode(CloudKitWirePage.self, from: Data(json.utf8))
    XCTAssertEqual(page.nextToken?.utf8.count, CloudKitWireCodec.tokenBytes)
    XCTAssertThrowsError(try CloudKitWireCodec.encodePage(CloudKitWirePage(records: [], nextToken: token + "a", more: false)))
    let b = CloudKitWireCodec.recordBytes, t = CloudKitWireCodec.tokenBytes, s = CloudKitWireCodec.syntaxBytes
    XCTAssertNoThrow(try CloudKitWireCodec.checkBudget(records: 200, recordsBytes: 200 * b, tokenUTF8Bytes: t, encodedOverheadBytes: 6 * t + s))
    for values in [(201, 0, 0, 0), (1, b + 1, 0, 0), (0, 1, 0, 0), (0, 0, t + 1, 0), (0, 0, 0, s + 1), (-1, 0, 0, 0)] {
      XCTAssertThrowsError(try CloudKitWireCodec.checkBudget(records: values.0, recordsBytes: values.1, tokenUTF8Bytes: values.2, encodedOverheadBytes: values.3))
    }
  }

  func testCanonicalMaximumActionWithEscapedPolicyBytesSurvivesTheBridge() throws {
    let original = try XCTUnwrap(schemaTwoFixtures().first { $0.entityType == "habit_action" })
    var f = original.fields
    let ids = (0..<5035).map { String(format: "00000000-0000-4000-8000-%012x", $0) }
    let quotedIds = ids.map { "\"\($0)\"" }.joined(separator: ",")
    let policy = "{\"version\":1,\"boardKind\":\"count\",\"earnsCoins\":true,\"coinCapPerDay\":1,\"checkClosesAtUtc\":1788926400000,\"rootId\":\"\(ids[0])\",\"requiredBoardIds\":[\(quotedIds)],\"bonusClosesAtUtc\":1788926400000,\"bonusEnabled\":true}"
    // 19 bytes below the policy bound; adding one valid id exceeds that bound.
    XCTAssertEqual(policy.utf8.count, 196_589)
    f["policy_json"] = .string(policy)
    XCTAssertEqual(f["created_at"], .number(1788825600001))
    func canonical(_ stamp: String) throws -> Data {
      let values: [Any] = [f["id"]!.string!, f["command_id"]!.string!, f["board_id"]!.string!, f["logical_date"]!.string!,
        f["check_in_id"]!.string!, f["kind"]!.string!, 1788825600001, stamp, f["policy_json"]!.string!]
      return try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])
    }
    let remaining = CloudKitWireCodec.canonicalRecordBytes - (try canonical(original.mutationStamp).count)
    let stamp = original.mutationStamp + String(repeating: "a", count: remaining)
    XCTAssertEqual(try canonical(stamp).count, CloudKitWireCodec.canonicalRecordBytes)
    let row = CloudKitWireRecord(schemaVersion: 2, entityType: original.entityType, entityId: original.entityId,
      mutationStamp: stamp, deleted: false, fields: f)
    let raw = String(decoding: try CloudKitWireCodec.encoder().encode([row]), as: UTF8.self)
    XCTAssertTrue(raw.contains("\\\"version\\\""))
    let maximallyEscaped = raw.replacingOccurrences(of: stamp, with: stamp.replacingOccurrences(of: "a", with: "\\u0061"))
    XCTAssertGreaterThan(maximallyEscaped.utf8.count, CloudKitWireCodec.canonicalRecordBytes)
    let decoded = try XCTUnwrap(CloudKitWireCodec.decodeUpload(maximallyEscaped).first)
    XCTAssertTrue(CloudKitRecordMapping.sameImmutable(row, decoded))
    let record = try CloudKitRecordMapping.toRecord(row, zoneID: testZone)
    XCTAssertTrue(CloudKitRecordMapping.sameImmutable(try CloudKitRecordMapping.fromRecord(record), row))
  }

  func testUnretainableNativeNumbersAndShapesFailThePageWithoutCoercion() throws {
    let original = try schemaTwoFixtures().last!
    let valid = try CloudKitRecordMapping.toRecord(original, zoneID: testZone)
    for value in [NSNumber(value: true), NSNumber(value: Int64(9_007_199_254_740_993)), NSNumber(value: Double.infinity)] {
      let record = valid.copy() as! CKRecord; record["delta"] = value
      XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(record))
    }
    let version = valid.copy() as! CKRecord; version["schema_version"] = NSNumber(value: true)
    XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(version))
    let wrong = CKRecord(recordType: "ledger_entry", recordID: CKRecord.ID(recordName: "not-a-uuid", zoneID: testZone))
    for key in valid.allKeys() { wrong[key] = valid[key] }
    XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(wrong))
  }
}
