import CloudKit
import Foundation
import XCTest
@testable import HabitSystemCloudKit

func cloudKitFixtures() throws -> [CloudKitWireRecord] {
  let url = try XCTUnwrap(Bundle.module.url(forResource: "sync-records", withExtension: "json"))
  return try JSONDecoder().decode([CloudKitWireRecord].self, from: Data(contentsOf: url))
}

let testZone = CKRecordZone.ID(zoneName: "habit-system", ownerName: CKCurrentUserDefaultName)

final class CloudKitMappingTests: XCTestCase {
  func testZoneNameIsTheForkZone() {
    XCTAssertEqual(CloudKitTransport.zoneName, "habit-system")
  }

  func testSharedFixtureRoundTripsThroughCloudKitRecords() throws {
    let fixtures = try cloudKitFixtures()
    XCTAssertEqual(fixtures.count, 9)
    for fixture in fixtures {
      let record = try CloudKitRecordMapping.toRecord(fixture, zoneID: testZone)
      XCTAssertEqual(record.recordType, fixture.entityType)
      XCTAssertEqual(record.recordID.recordName, fixture.entityId)
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(record), fixture)
    }
  }

  func testVersionOneKeepsItsReleasedFiniteScalarBoundaryForSemanticValidation() throws {
    var value = try cloudKitFixtures()[0]
    value.fields["created_at"] = .string("semantic validator rejects this")
    value.fields["title"] = .null
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(CloudKitRecordMapping.toRecord(value, zoneID: testZone)), value)
    let record = try CloudKitRecordMapping.toRecord(cloudKitFixtures()[0], zoneID: testZone)
    record["uses_tinted_background"] = NSNumber(value: true)
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(record).fields["uses_tinted_background"], .number(1))
    value.fields["quick_amount"] = .number(.infinity)
    XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(value, zoneID: testZone))
  }

  func testTombstoneClearsPreviouslyStoredContentAndUnknownKeys() throws {
    let fixtures = try cloudKitFixtures()
    let live = try CloudKitRecordMapping.toRecord(fixtures[2], zoneID: testZone)
    live["unexpected_private_field"] = "synthetic secret" as NSString
    let deleted = try CloudKitRecordMapping.toRecord(fixtures[3], zoneID: testZone, existing: live)
    XCTAssertNil(deleted["note"])
    XCTAssertNil(deleted["amount"])
    XCTAssertNil(deleted["unexpected_private_field"])
    XCTAssertNotNil(live["note"])
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(deleted), fixtures[3])
  }

  func testTombstoneCannotCarryUnsanitizedUserContent() throws {
    var tombstone = try cloudKitFixtures()[3]
    tombstone.fields["note"] = .string("synthetic private note")
    tombstone.fields["amount"] = .number(42)
    tombstone.fields["source"] = .string("siri")
    tombstone.fields["idempotency_key"] = .string("synthetic-command-to-erase")
    let record = try CloudKitRecordMapping.toRecord(tombstone, zoneID: testZone)
    XCTAssertNil(record["note"])
    XCTAssertNil(record["amount"])
    XCTAssertEqual(record["board_id"] as? String, tombstone.fields["board_id"]?.string)
    XCTAssertEqual(record["source"] as? String, "sync")
    XCTAssertEqual(record["idempotency_key"] as? String, tombstone.entityId)
    XCTAssertFalse(String(describing: record).contains("synthetic-command-to-erase"))
  }

  func testUnknownFieldsAndInvalidStructureFailBeforeWriting() throws {
    var fixture = try cloudKitFixtures()[0]
    fixture.fields["device_id"] = .string("not-for-sync")
    XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(fixture, zoneID: testZone))
    fixture = try cloudKitFixtures()[0]
    fixture.fields["id"] = .string("another-entity")
    XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(fixture, zoneID: testZone))
    fixture = try cloudKitFixtures()[0]
    fixture.fields["quick_amount"] = .number(.infinity)
    XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(fixture, zoneID: testZone))
  }

  func testMalformedServerRecordsDoNotBecomePages() throws {
    let record = try CloudKitRecordMapping.toRecord(cloudKitFixtures()[0], zoneID: testZone)
    record["schema_version"] = NSNumber(value: 3)
    XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(record))
    record["schema_version"] = NSNumber(value: 1)
    record["mutation_stamp"] = "not-a-stamp" as NSString
    XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(record))
  }

  func testTokenCodecRejectsMalformedAndDifferentContainerTokens() throws {
    let codec = CloudKitToken(containerIdentifier: "iCloud.studio.orbitlabs.habitsystem", zoneName: "habit-system",
      accountDigest: CloudKitAccountBinding.digest(recordName: "synthetic-user-a"))
    XCTAssertNil(codec.decode(nil))
    XCTAssertNil(codec.decode("not-base64"))
    XCTAssertNil(codec.decode(Data("{}".utf8).base64EncodedString()))
    let other = try JSONSerialization.data(withJSONObject: [
      "version": 1, "containerIdentifier": "iCloud.other.app", "zoneName": "habit-tracker", "archive": ""
    ])
    XCTAssertNil(codec.decode(other.base64EncodedString()))
    XCTAssertNil(try codec.encode(nil))
  }

  func testVersionTwoTokenEnvelopeRoundTripsOnlyWithinItsAccountContainerAndZone() throws {
    let digest = CloudKitAccountBinding.digest(recordName: "synthetic-user-a")
    let codec = CloudKitToken(containerIdentifier: "iCloud.studio.orbitlabs.habitsystem",
      zoneName: "habit-system", accountDigest: digest)
    let archive = Data("opaque-server-token-archive".utf8)
    let token = try codec.encodeArchive(archive)
    XCTAssertEqual(codec.decodeArchive(token), archive)
    for other in [
      CloudKitToken(containerIdentifier: codec.containerIdentifier, zoneName: codec.zoneName,
        accountDigest: CloudKitAccountBinding.digest(recordName: "synthetic-user-b")),
      CloudKitToken(containerIdentifier: "iCloud.other.app", zoneName: codec.zoneName, accountDigest: digest),
      CloudKitToken(containerIdentifier: codec.containerIdentifier, zoneName: "other-zone", accountDigest: digest)
    ] {
      XCTAssertNil(other.decodeArchive(token))
    }
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64Encoded: token))) as? [String: Any])
    XCTAssertEqual(json["version"] as? Int, 2)
    XCTAssertEqual(json["accountDigest"] as? String, digest)
    XCTAssertFalse(String(describing: json).contains("synthetic-user-a"))
  }

  func testPageExplicitlyEncodesANullToken() throws {
    let page = CloudKitWirePage(records: [], nextToken: nil, more: false)
    let data = try JSONEncoder().encode(page)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue(json["nextToken"] is NSNull)
  }
}

final class CloudKitErrorTests: XCTestCase {
  func testAccountStatusesMapWithoutAccountData() {
    XCTAssertNil(CloudKitFailure.accountFailure(.available))
    XCTAssertEqual(CloudKitFailure.accountFailure(.noAccount), .signedOut)
    XCTAssertEqual(CloudKitFailure.accountFailure(.restricted), .signedOut)
    XCTAssertEqual(CloudKitFailure.accountFailure(.couldNotDetermine), .unavailable)
    XCTAssertEqual(CloudKitFailure.accountFailure(.temporarilyUnavailable), .unavailable)
  }

  func testCloudKitErrorCodesAreSafe() {
    let cases: [(CKError.Code, CloudKitFailure)] = [
      (.networkUnavailable, .offline), (.networkFailure, .offline),
      (.notAuthenticated, .signedOut), (.managedAccountRestricted, .signedOut),
      (.missingEntitlement, .unavailable), (.badContainer, .unavailable),
      (.badDatabase, .unavailable), (.accountTemporarilyUnavailable, .unavailable),
      (.quotaExceeded, .failure), (.internalError, .failure), (.serverResponseLost, .failure)
    ]
    for (code, expected) in cases {
      let error = CKError(code, userInfo: [NSLocalizedDescriptionKey: "synthetic private account detail"])
      XCTAssertEqual(CloudKitFailure.map(error), expected)
      XCTAssertFalse(CloudKitFailure.map(error).message.contains("private"))
    }
    XCTAssertEqual(CloudKitFailure.map(CloudKitFailure.offline), .offline)
    XCTAssertEqual(CloudKitFailure.map(NSError(domain: "private", code: 9)), .failure)
  }

  func testPartialFailuresRetainTheActionableCode() {
    let error = CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: [
      CKRecord.ID(recordName: "a"): CKError(.networkFailure),
      CKRecord.ID(recordName: "b"): CKError(.notAuthenticated)
    ]])
    XCTAssertEqual(CloudKitFailure.map(error), .signedOut)
    XCTAssertTrue(cloudKitErrorHasCode(error, .networkFailure))
    XCTAssertFalse(cloudKitErrorHasCode(error, .limitExceeded))
  }
}

func schemaTwoFixtures() throws -> [CloudKitWireRecord] {
  let url = try XCTUnwrap(Bundle.module.url(forResource: "sync-records-v2", withExtension: "json"))
  return try JSONDecoder().decode([CloudKitWireRecord].self, from: Data(contentsOf: url))
}

final class CloudKitSchemaTwoMappingTests: XCTestCase {
  func testVersionTwoDeletionMismatchIsRetainedInboundAndRejectedOutbound() throws {
    for value in try schemaTwoFixtures().filter({ !CloudKitRecordMapping.immutable($0.entityType) && $0.entityType != "settings" }) {
      var mismatch = value
      mismatch.fields["deleted_at"] = value.deleted ? .null : .number(1788825600999)
      XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(mismatch, zoneID: testZone))
      let server = try CloudKitRecordMapping.toRecord(value, zoneID: testZone)
      server["deleted_at"] = value.deleted ? nil : NSNumber(value: 1788825600999)
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(server), mismatch)
    }
    // the released v1 tombstone behavior is deliberately unchanged.
    for value in try cloudKitFixtures().filter({ $0.entityType != "settings" }) {
      var mismatch = value
      mismatch.fields["deleted_at"] = value.deleted ? .null : .number(1788825600999)
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(CloudKitRecordMapping.toRecord(mismatch, zoneID: testZone)), mismatch)
    }
  }

  func testBoundedVersionTwoMutableDefectsReachTheSemanticValidatorUnchanged() throws {
    for value in try schemaTwoFixtures().filter({ !CloudKitRecordMapping.immutable($0.entityType) && !$0.deleted }) {
      let server = try CloudKitRecordMapping.toRecord(value, zoneID: testZone)
      server["unexpected"] = "retain this invalid field" as NSString
      let scalarKey = value.entityType == "settings" ? "wake_minute" : value.entityType == "activity_period" ? "end_date" : "created_at"
      server[scalarKey] = "wrong scalar type" as NSString
      let decoded = try CloudKitRecordMapping.fromRecord(server)
      XCTAssertEqual(decoded.fields["unexpected"], .string("retain this invalid field"))
      XCTAssertEqual(decoded.fields[scalarKey], .string("wrong scalar type"))
      XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(decoded, zoneID: testZone))
    }
  }

  func testEightVersionTwoTypesRoundTripWithoutRelabelingVersionOne() throws {
    let values = try schemaTwoFixtures()
    XCTAssertEqual(Set(values.map(\.entityType)).count, 8)
    for value in values {
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(CloudKitRecordMapping.toRecord(value, zoneID: testZone)), value)
    }
    for value in try cloudKitFixtures() {
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(CloudKitRecordMapping.toRecord(value, zoneID: testZone)), value)
    }
  }

  func testTrustedImmutableDefectsSurviveDownloadButCannotUpload() throws {
    for value in try schemaTwoFixtures().filter({ ["habit_action", "ledger_entry"].contains($0.entityType) }) {
      let source = try CloudKitRecordMapping.toRecord(value, zoneID: testZone)
      for defect in 0..<7 {
        let server = source.copy() as! CKRecord
        switch defect {
        case 0: server["id"] = "wrong-inner-id" as NSString
        case 1: server["unexpected"] = "keep exact diagnostic bytes" as NSString
        case 2: server["kind"] = nil
        case 3: server["deleted"] = NSNumber(value: true)
        case 4: server["mutation_stamp"] = "not-a-stamp" as NSString
        case 5: server["created_at"] = "not-numeric" as NSString
        default: server["created_at"] = NSNumber(value: 9_007_199_254_740_992.0)
        }
        let decoded = try CloudKitRecordMapping.fromRecord(server)
        XCTAssertEqual(decoded.entityId, value.entityId)
        XCTAssertEqual(decoded.fields["id"]?.string, defect == 0 ? "wrong-inner-id" : value.entityId)
        if defect == 1 { XCTAssertEqual(decoded.fields["unexpected"], .string("keep exact diagnostic bytes")) }
        if defect == 2 { XCTAssertEqual(decoded.fields["kind"], .null) }
        if defect == 3 { XCTAssertTrue(decoded.deleted) }
        if defect == 4 { XCTAssertEqual(decoded.mutationStamp, "not-a-stamp") }
        XCTAssertThrowsError(try CloudKitRecordMapping.toRecord(decoded, zoneID: testZone))
      }
    }
  }
  func testNewTypesNeverAcquireVersionOneAuthorityAndUnknownVersionsAbort() throws {
    for value in try schemaTwoFixtures() {
      let record = try CloudKitRecordMapping.toRecord(value, zoneID: testZone)
      record["schema_version"] = NSNumber(value: 3)
      XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(record))
      if ["reward", "habit_action", "ledger_entry"].contains(value.entityType) {
        record["schema_version"] = NSNumber(value: 1)
        XCTAssertThrowsError(try CloudKitRecordMapping.fromRecord(record))
      }
    }
  }

  func testMutableTombstonesEraseAllNewContentOverExistingCloudRecords() throws {
    let values = try schemaTwoFixtures()
    for type in ["board", "reward", "check_in"] {
      let live = values.first { $0.entityType == type && !$0.deleted }!
      let tombstone = values.first { $0.entityType == type && $0.deleted }!
      let old = try CloudKitRecordMapping.toRecord(live, zoneID: testZone)
      old["old_private_key"] = "must disappear" as NSString
      let deleted = try CloudKitRecordMapping.toRecord(tombstone, zoneID: testZone, existing: old)
      XCTAssertNil(deleted["old_private_key"])
      let roundtrip = try CloudKitRecordMapping.fromRecord(deleted)
      XCTAssertEqual(roundtrip, tombstone)
      if type == "board" { XCTAssertEqual(roundtrip.fields["earns_coins"], .number(0)); XCTAssertEqual(roundtrip.fields["anchor_preset"], .null) }
      if type == "reward" { XCTAssertEqual(roundtrip.fields["title"], .string("")); XCTAssertEqual(roundtrip.fields["cost_coins"], .number(1)) }
    }
  }

}
