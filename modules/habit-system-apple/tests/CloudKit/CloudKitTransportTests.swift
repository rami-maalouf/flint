import CloudKit
import Foundation
import XCTest
@testable import HabitSystemCloudKit

private final class FakeAccountBinding: CloudKitAccountBindingChecking, @unchecked Sendable {
  private let lock = NSLock()
  private var bound: String?
  func require(provider: String, accountDigest: String) throws {
    lock.lock()
    defer { lock.unlock() }
    if let bound, bound != accountDigest { throw CloudKitFailure.unavailable }
    bound = accountDigest
  }
}

private actor FakeCloudKitClient: CloudKitClient {
  nonisolated let binding = FakeAccountBinding()
  var digest = CloudKitAccountBinding.digest(recordName: "synthetic-user-a")
  var switchDuringRead = false
  var switchDuringChanges = false
  enum SaveMode: Sendable {
    case normal
    case conflict(CKRecord)
    case unknownRace(CKRecord)
    case limitAfterSaveOnce
    case successDifferent(CKRecord)
    case alwaysConflict
    case offlineOnce(String)
    case loseResponseOnce
  }
  var account: CKAccountStatus = .available
  var store: [CKRecord.ID: CKRecord] = [:]
  var savedNames: [String] = []
  var saveBatchSizes: [Int] = []
  var fetchBatchSizes: [Int] = []
  var zones: Set<CKRecordZone.ID> = []
  var changesRequests = 0
  var mode: SaveMode = .normal
  var limit = 200
  var expireFirstPage = false
  var page = CloudKitChangedRecords(records: [], token: nil, more: false, hardDeletedRecordCount: 0)

  func configure(account: CKAccountStatus = .available, mode: SaveMode = .normal, limit: Int = 200) {
    self.account = account
    self.mode = mode
    self.limit = limit
  }
  func seed(_ record: CKRecord, as id: CKRecord.ID? = nil) { store[id ?? record.recordID] = record }
  func setPage(_ page: CloudKitChangedRecords, expireFirst: Bool = false) {
    self.page = page
    expireFirstPage = expireFirst
  }
  func accountStatus() async throws -> CKAccountStatus { account }
  func accountDigest() async throws -> String { digest }
  func switchAccount(duringRead: Bool = false) {
    if duringRead { switchDuringRead = true }
    else { digest = CloudKitAccountBinding.digest(recordName: "synthetic-user-b") }
  }
  func switchAccountDuringChanges() { switchDuringChanges = true }
  func ensureZone(_ zoneID: CKRecordZone.ID) async throws { zones.insert(zoneID) }
  func fetchRecords(_ ids: [CKRecord.ID]) async throws -> [CKRecord.ID: Result<CKRecord, Error>] {
    fetchBatchSizes.append(ids.count)
    if switchDuringRead { switchAccount() }
    if ids.count > limit { throw CKError(.limitExceeded) }
    return Dictionary(uniqueKeysWithValues: ids.map { id in
      (id, store[id].map { .success($0.copy() as! CKRecord) } ?? .failure(CKError(.unknownItem)))
    })
  }
  func saveRecords(_ records: [CKRecord]) async throws -> [CKRecord.ID: Result<CKRecord, Error>] {
    saveBatchSizes.append(records.count)
    if records.count > limit { throw CKError(.limitExceeded) }
    if case .conflict(let winner) = mode {
      store[winner.recordID] = winner
      mode = .normal
      return Dictionary(uniqueKeysWithValues: records.map { ($0.recordID, .failure(CKError(.serverRecordChanged))) })
    }
    if case .unknownRace(let winner) = mode {
      store[winner.recordID] = winner; mode = .normal
      return Dictionary(uniqueKeysWithValues: records.map { ($0.recordID, .failure(CKError(.unknownItem))) })
    }
    if case .successDifferent(let winner) = mode {
      store[winner.recordID] = winner
      return Dictionary(uniqueKeysWithValues: records.map { ($0.recordID, .success(winner)) })
    }
    if case .limitAfterSaveOnce = mode {
      mode = .normal
      let first = records[0]; store[first.recordID] = first.copy() as? CKRecord; savedNames.append(first.recordID.recordName)
      throw CKError(.limitExceeded)
    }
    if case .alwaysConflict = mode {
      return Dictionary(uniqueKeysWithValues: records.map { ($0.recordID, .failure(CKError(.serverRecordChanged))) })
    }
    var results: [CKRecord.ID: Result<CKRecord, Error>] = [:]
    for record in records {
      if case .offlineOnce(let id) = mode, id == record.recordID.recordName {
        mode = .normal
        results[record.recordID] = .failure(CKError(.networkFailure))
      } else {
        store[record.recordID] = record.copy() as? CKRecord
        savedNames.append(record.recordID.recordName)
        results[record.recordID] = .success(record)
      }
    }
    if case .loseResponseOnce = mode {
      mode = .normal
      throw CKError(.serverResponseLost)
    }
    return results
  }
  func fetchChanges(_ zoneID: CKRecordZone.ID, token: CKServerChangeToken?) async throws -> CloudKitChangedRecords {
    changesRequests += 1
    if switchDuringChanges { switchAccount() }
    if expireFirstPage {
      expireFirstPage = false
      throw CKError(.changeTokenExpired)
    }
    return page
  }
}

private func transport(_ client: FakeCloudKitClient) -> CloudKitTransport {
  CloudKitTransport(client: client, containerIdentifier: "iCloud.studio.orbitlabs.habitsystem", accountBinding: client.binding)
}

private func renamed(_ record: CloudKitWireRecord, _ id: String) -> CloudKitWireRecord {
  var fields = record.fields
  fields["id"] = .string(id)
  return CloudKitWireRecord(schemaVersion: record.schemaVersion, entityType: record.entityType,
    entityId: id, mutationStamp: record.mutationStamp, deleted: record.deleted, fields: fields)
}

final class CloudKitTransportTests: XCTestCase {
  func testReturnedCloudIdentityMustMatchTheRequestedRecordAndZoneBeforeAcknowledgement() async throws {
    let values = try schemaTwoFixtures()
    for value in [values[0], values.last!] {
      let original = try CloudKitRecordMapping.toRecord(value, zoneID: testZone)
      for differentName in [false, true] {
        let otherZone = CKRecordZone.ID(zoneName: "not-the-requested-zone", ownerName: CKCurrentUserDefaultName)
        let wrongId = CKRecord.ID(recordName: differentName ? "00000000-0000-4000-8000-000000000999" : value.entityId,
          zoneID: differentName ? testZone : otherZone)
        let wrong = CKRecord(recordType: value.entityType, recordID: wrongId)
        for key in original.allKeys() { wrong[key] = original[key] }
        wrong["id"] = wrongId.recordName as NSString
        let client = FakeCloudKitClient(); await client.seed(wrong, as: original.recordID)
        do { try await transport(client).upload([value]); XCTFail("expected physical identity failure") }
        catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
        let saves = await client.savedNames; XCTAssertTrue(saves.isEmpty)
      }
    }
    let value = values.last!
    let wrongZone = CKRecordZone.ID(zoneName: "not-the-requested-zone", ownerName: CKCurrentUserDefaultName)
    let wrongAck = try CloudKitRecordMapping.toRecord(value, zoneID: wrongZone)
    let client = FakeCloudKitClient(); await client.configure(mode: .successDifferent(wrongAck))
    do { try await transport(client).upload([value]); XCTFail("expected physical acknowledgement failure") }
    catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
  }

  func testMalformedVersionTwoServerRowsCannotAcknowledgeANewerMutableValue() async throws {
    let original = try schemaTwoFixtures()[0]
    for defect in 0..<3 {
      let client = FakeCloudKitClient()
      let server = try CloudKitRecordMapping.toRecord(original, zoneID: testZone)
      server["mutation_stamp"] = "99999999999999-zzzzz-remote" as NSString
      switch defect {
      case 0: server["mutation_stamp"] = "zz-invalid" as NSString
      case 1: server["deleted"] = NSNumber(value: true)
      default: server["created_at"] = "wrong type" as NSString
      }
      await client.seed(server)
      do { try await transport(client).upload([original]); XCTFail("expected malformed mutable acknowledgement failure") }
      catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
      let saves = await client.savedNames
      XCTAssertTrue(saves.isEmpty)
    }
  }

  func testNewerSelfAnchoredServerBoardCannotAcknowledgeAValidLocalUpload() async throws {
    let original = try schemaTwoFixtures()[0]
    for arrival in 0..<3 {
      let client = FakeCloudKitClient()
      let server = try CloudKitRecordMapping.toRecord(original, zoneID: testZone)
      server["mutation_stamp"] = "99999999999999-zzzzz-remote" as NSString
      server["anchor_kind"] = "board" as NSString
      server["anchor_board_id"] = original.entityId as NSString
      server["anchor_preset"] = nil
      let serverValue = try CloudKitRecordMapping.fromRecord(server)
      switch arrival {
      case 0: await client.seed(server)
      case 1: await client.configure(mode: .conflict(server))
      default: await client.configure(mode: .unknownRace(server))
      }
      do { try await transport(client).upload([original]); XCTFail("expected self-anchor acknowledgement failure") }
      catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
      let saves = await client.savedNames
      let attempts = await client.saveBatchSizes
      let stored = await client.store[server.recordID]
      XCTAssertTrue(saves.isEmpty)
      XCTAssertEqual(attempts.count, arrival == 0 ? 0 : 1)
      XCTAssertEqual(try CloudKitRecordMapping.fromRecord(XCTUnwrap(stored)), serverValue)
    }
  }

  func testSelfAnchorCannotUploadButRemainsAvailableAsInboundDiagnostics() async throws {
    var invalid = try schemaTwoFixtures()[0]
    invalid.fields["anchor_kind"] = .string("board")
    invalid.fields["anchor_board_id"] = .string(invalid.entityId)
    invalid.fields["anchor_preset"] = .null
    for archived in [false, true] {
      var candidate = invalid
      if archived { candidate.fields["archived_at"] = .number(1787572800000) }
      let client = FakeCloudKitClient()
      do { try await transport(client).upload([candidate]); XCTFail("expected invalid local self-anchor failure") }
      catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
      let fetches = await client.fetchBatchSizes
      let saves = await client.savedNames
      XCTAssertTrue(fetches.isEmpty)
      XCTAssertTrue(saves.isEmpty)

      let server = try CloudKitRecordMapping.toRecord(schemaTwoFixtures()[0], zoneID: testZone)
      server["anchor_kind"] = "board" as NSString
      server["anchor_board_id"] = candidate.entityId as NSString
      server["anchor_preset"] = nil
      if archived { server["archived_at"] = NSNumber(value: 1787572800000) }
      await client.setPage(CloudKitChangedRecords(records: [server], token: nil, more: false, hardDeletedRecordCount: 0))
      let page = try await transport(client).fetchChanges(nil)
      XCTAssertEqual(page.records, [candidate])
    }
  }

  func testSelfAnchorGuardPreservesBoardTombstoneNormalizationAndAcknowledgement() async throws {
    let fixtures = try schemaTwoFixtures()
    var tombstone = fixtures[1]
    tombstone.fields["anchor_relation"] = .string("after")
    tombstone.fields["anchor_kind"] = .string("board")
    tombstone.fields["anchor_board_id"] = .string(tombstone.entityId)
    XCTAssertEqual(try CloudKitRecordMapping.normalizedOutbound(tombstone), fixtures[1])
    let server = try CloudKitRecordMapping.toRecord(fixtures[1], zoneID: testZone)
    server["anchor_relation"] = "after" as NSString
    server["anchor_kind"] = "board" as NSString
    server["anchor_board_id"] = tombstone.entityId as NSString
    let client = FakeCloudKitClient()
    await client.seed(server)
    try await transport(client).upload([fixtures[0]])
    let saves = await client.savedNames
    XCTAssertTrue(saves.isEmpty)
  }

  func testAccountSwitchRefusesZoneUploadAndFetchBeforeCloudOperations() async throws {
    let client = FakeCloudKitClient()
    try await transport(client).upload([])
    await client.switchAccount()
    for operation in 0..<4 {
      do {
        switch operation {
        case 0: try await transport(client).ensureZone()
        case 1: try await transport(client).upload([cloudKitFixtures()[0]])
        case 2: try await transport(client).upload([])
        default: _ = try await transport(client).fetchChanges(nil)
        }
        XCTFail("expected account mismatch")
      } catch { XCTAssertEqual(CloudKitFailure.map(error), .unavailable) }
    }
    let zones = await client.zones
    let fetches = await client.fetchBatchSizes
    let saves = await client.savedNames
    let pages = await client.changesRequests
    XCTAssertTrue(zones.isEmpty)
    XCTAssertTrue(fetches.isEmpty)
    XCTAssertTrue(saves.isEmpty)
    XCTAssertEqual(pages, 0)
  }

  func testAccountSwitchAfterReadCannotRedirectTheConditionalSave() async throws {
    let client = FakeCloudKitClient()
    await client.switchAccount(duringRead: true)
    do {
      try await transport(client).upload([cloudKitFixtures()[0]])
      XCTFail("expected account mismatch")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .unavailable) }
    let saves = await client.savedNames
    XCTAssertTrue(saves.isEmpty)
  }

  func testAccountSwitchDuringFetchCannotReturnAnotherAccountsRecordsOrToken() async throws {
    let client = FakeCloudKitClient()
    let record = try CloudKitRecordMapping.toRecord(cloudKitFixtures()[0], zoneID: testZone)
    await client.setPage(CloudKitChangedRecords(records: [record], token: nil, more: false, hardDeletedRecordCount: 0))
    await client.switchAccountDuringChanges()
    do {
      _ = try await transport(client).fetchChanges(nil)
      XCTFail("expected account mismatch")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .unavailable) }
  }

  func testZoneAndUploadsAreIdempotent() async throws {
    let client = FakeCloudKitClient()
    let transport = transport(client)
    let record = try cloudKitFixtures()[0]
    try await transport.ensureZone()
    try await transport.ensureZone()
    try await transport.upload([record])
    try await transport.upload([record])
    let zones = await client.zones
    let saved = await client.savedNames
    XCTAssertEqual(zones.count, 1)
    XCTAssertEqual(saved, [record.entityId])
  }

  func testOutOfOrderDuplicateMutationsCannotResurrectATombstone() async throws {
    let client = FakeCloudKitClient()
    let fixtures = try cloudKitFixtures()
    try await transport(client).upload([fixtures[1], fixtures[0]])
    try await transport(client).upload([fixtures[0]])
    let stored = await client.store.values.map { $0 }
    XCTAssertEqual(stored.count, 1)
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(stored[0]), fixtures[1])
    let saved = await client.savedNames
    XCTAssertEqual(saved.count, 1)
  }

  func testConcurrentNewerTombstoneWinsAfterConditionalSaveConflict() async throws {
    let fixtures = try cloudKitFixtures()
    let client = FakeCloudKitClient()
    let winner = try CloudKitRecordMapping.toRecord(fixtures[1], zoneID: testZone)
    await client.configure(mode: .conflict(winner))
    try await transport(client).upload([fixtures[0]])
    let stored = await client.store[winner.recordID]
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(XCTUnwrap(stored)), fixtures[1])
    let saves = await client.saveBatchSizes
    XCTAssertEqual(saves.count, 1)
  }

  func testNewerLocalMutationRetriesAgainstLatestServerChangeTag() async throws {
    let fixtures = try cloudKitFixtures()
    let client = FakeCloudKitClient()
    let older = try CloudKitRecordMapping.toRecord(fixtures[0], zoneID: testZone)
    await client.configure(mode: .conflict(older))
    try await transport(client).upload([fixtures[1]])
    let stored = await client.store[older.recordID]
    XCTAssertEqual(try CloudKitRecordMapping.fromRecord(XCTUnwrap(stored)), fixtures[1])
    let saves = await client.saveBatchSizes
    XCTAssertEqual(saves.count, 2)
  }

  func testConflictRetriesAreBounded() async throws {
    let client = FakeCloudKitClient()
    await client.configure(mode: .alwaysConflict)
    do {
      try await transport(client).upload([cloudKitFixtures()[0]])
      XCTFail("expected a bounded retry failure")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
    let saves = await client.saveBatchSizes
    XCTAssertEqual(saves.count, CloudKitTransport.conflictAttempts)
  }

  func testLostServerResponseDoesNotRepeatAMutation() async throws {
    let client = FakeCloudKitClient()
    let record = try cloudKitFixtures()[0]
    await client.configure(mode: .loseResponseOnce)
    do {
      try await transport(client).upload([record])
      XCTFail("expected lost response")
    } catch { XCTAssertTrue(cloudKitErrorHasCode(error, .serverResponseLost)) }
    try await transport(client).upload([record])
    let saved = await client.savedNames
    XCTAssertEqual(saved, [record.entityId])
  }

  func testPartialFailureRetainsSuccessfulRecordsDuringRetry() async throws {
    let client = FakeCloudKitClient()
    let first = try cloudKitFixtures()[0]
    let second = renamed(first, "00000000-0000-4000-8000-000000000002")
    await client.configure(mode: .offlineOnce(second.entityId))
    do {
      try await transport(client).upload([first, second])
      XCTFail("expected offline failure")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .offline) }
    try await transport(client).upload([first, second])
    let saved = await client.savedNames
    XCTAssertEqual(saved, [first.entityId, second.entityId])
  }

  func testServerBatchLimitsSplitWithoutDroppingRecords() async throws {
    let client = FakeCloudKitClient()
    await client.configure(limit: 1)
    let first = try cloudKitFixtures()[0]
    try await transport(client).upload([first, renamed(first, "second")])
    let saved = await client.savedNames
    let sizes = await client.fetchBatchSizes
    XCTAssertEqual(saved.count, 2)
    XCTAssertEqual(sizes, [2, 1, 1])
  }

  func testLargeUploadUsesAtMostTwoHundredRecordsPerOperation() async throws {
    let client = FakeCloudKitClient()
    let sample = try cloudKitFixtures()[0]
    try await transport(client).upload((0..<201).map { renamed(sample, "board-\($0)") })
    let sizes = await client.saveBatchSizes
    let count = await client.savedNames.count
    XCTAssertEqual(sizes, [200, 1])
    XCTAssertEqual(count, 201)
  }

  func testInvalidInputDoesNotPartiallyUpload() async throws {
    let client = FakeCloudKitClient()
    let sample = try cloudKitFixtures()[0]
    var bad = renamed(sample, "second")
    bad.fields["device_id"] = .string("local-only")
    do {
      try await transport(client).upload([sample, bad])
      XCTFail("expected validation failure")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
    let saved = await client.savedNames
    XCTAssertTrue(saved.isEmpty)
  }

  func testSignedOutAccountIsDeterminateButCannotMutate() async throws {
    let client = FakeCloudKitClient()
    await client.configure(account: .noAccount)
    let available = await transport(client).available()
    XCTAssertTrue(available)
    do {
      try await transport(client).ensureZone()
      XCTFail("expected signed out")
    } catch { XCTAssertEqual(CloudKitFailure.map(error), .signedOut) }
    await client.configure(account: .couldNotDetermine)
    let unavailable = await transport(client).available()
    XCTAssertFalse(unavailable)
  }

  func testExpiredTokenRescansRetainedTombstones() async throws {
    let client = FakeCloudKitClient()
    let fixture = try cloudKitFixtures()[1]
    let record = try CloudKitRecordMapping.toRecord(fixture, zoneID: testZone)
    await client.setPage(CloudKitChangedRecords(records: [record], token: nil, more: false,
      hardDeletedRecordCount: 0), expireFirst: true)
    let page = try await transport(client).fetchChanges("expired-opaque-token")
    XCTAssertEqual(page.records, [fixture])
    let count = await client.changesRequests
    XCTAssertEqual(count, 2)
  }

  func testHardDeletesAndIncompletePagesNeverReturnAToken() async throws {
    let client = FakeCloudKitClient()
    for page in [
      CloudKitChangedRecords(records: [], token: nil, more: false, hardDeletedRecordCount: 1),
      CloudKitChangedRecords(records: [], token: nil, more: true, hardDeletedRecordCount: 0)
    ] {
      await client.setPage(page)
      do {
        _ = try await transport(client).fetchChanges(nil)
        XCTFail("expected unsafe page rejection")
      } catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
    }
  }
}

final class CloudKitImmutableUploadTests: XCTestCase {
  func testImmutableInputGroupsRejectUnequalBytesBeforeAnyCloudCall() async throws {
    let original = try schemaTwoFixtures().last!
    for stamp in ["00000000000000-00000-old", original.mutationStamp, "99999999999999-zzzzz-new"] {
      let client = FakeCloudKitClient()
      var fields = original.fields; fields["reward_title_snapshot"] = .string("Café")
      let different = CloudKitWireRecord(schemaVersion: 2, entityType: original.entityType, entityId: original.entityId,
        mutationStamp: stamp, deleted: false, fields: fields)
      XCTAssertFalse(CloudKitRecordMapping.sameBytes(original.fields["reward_title_snapshot"]!.string!, "Café"))
      do { try await transport(client).upload([original, different]); XCTFail("expected immutable conflict") }
      catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
      let fetches = await client.fetchBatchSizes; let saves = await client.savedNames
      XCTAssertTrue(fetches.isEmpty); XCTAssertTrue(saves.isEmpty)
    }
  }

  func testEveryServerReadRejectsImmutableUnicodeDifferencesRegardlessOfStamp() async throws {
    let original = try schemaTwoFixtures().last!
    for mode in 0..<3 {
      for stamp in ["00000000000000-00000-old", original.mutationStamp, "99999999999999-zzzzz-new"] {
        let client = FakeCloudKitClient()
        var fields = original.fields; fields["reward_title_snapshot"] = .string("Café")
        let different = CloudKitWireRecord(schemaVersion: 2, entityType: original.entityType, entityId: original.entityId,
          mutationStamp: stamp, deleted: false, fields: fields)
        let stored = try CloudKitRecordMapping.toRecord(different, zoneID: testZone)
        if mode == 0 { await client.seed(stored) }
        else { await client.configure(mode: mode == 1 ? .conflict(stored) : .unknownRace(stored)) }
        do { try await transport(client).upload([original]); XCTFail("expected immutable conflict") }
        catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
        let final = await client.store[stored.recordID]
        XCTAssertTrue(CloudKitRecordMapping.sameImmutable(try CloudKitRecordMapping.fromRecord(XCTUnwrap(final)), different))
        let saves = await client.savedNames; XCTAssertTrue(saves.isEmpty)
      }
    }
  }

  func testSuccessfulSaveMustAcknowledgeTheExactImmutableBytes() async throws {
    let original = try schemaTwoFixtures().last!
    let changed = try CloudKitRecordMapping.toRecord(original, zoneID: testZone)
    changed["reward_title_snapshot"] = "Café" as NSString
    let client = FakeCloudKitClient(); await client.configure(mode: .successDifferent(changed))
    do { try await transport(client).upload([original]); XCTFail("expected unequal acknowledgement failure") }
    catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
  }

  func testStoredPolicyJsonIsComparedAsBytesWithoutReserializing() async throws {
    let original = try XCTUnwrap(schemaTwoFixtures().first { $0.entityType == "habit_action" })
    let changed = try CloudKitRecordMapping.toRecord(original, zoneID: testZone)
    changed["policy_json"] = (original.fields["policy_json"]!.string! + " ") as NSString
    let client = FakeCloudKitClient(); await client.seed(changed)
    do { try await transport(client).upload([original]); XCTFail("expected policy byte conflict") }
    catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
    let saved = await client.savedNames; XCTAssertTrue(saved.isEmpty)
  }

  func testFetchedPagePreservesTrustedImmutableDefectsAndRejectsUnretainablePageBounds() async throws {
    let values = try schemaTwoFixtures().filter { $0.entityType == "ledger_entry" }
    let good = try CloudKitRecordMapping.toRecord(values[0], zoneID: testZone)
    let malformed = try CloudKitRecordMapping.toRecord(values[1], zoneID: testZone)
    malformed["id"] = "bad-inner-id" as NSString; malformed["deleted"] = NSNumber(value: true)
    malformed["extra"] = "retain" as NSString; malformed["mutation_stamp"] = "invalid-stamp" as NSString
    let client = FakeCloudKitClient()
    await client.setPage(CloudKitChangedRecords(records: [good, malformed], token: nil, more: false, hardDeletedRecordCount: 0))
    let page = try await transport(client).fetchChanges(nil)
    XCTAssertEqual(page.records.count, 2); XCTAssertEqual(page.records[1].fields["extra"], .string("retain"))
    XCTAssertEqual(page.records[1].mutationStamp, "invalid-stamp"); XCTAssertTrue(page.records[1].deleted)
    await client.setPage(CloudKitChangedRecords(records: Array(repeating: good, count: 201), token: nil, more: false, hardDeletedRecordCount: 0))
    do { _ = try await transport(client).fetchChanges(nil); XCTFail("expected oversized page failure") }
    catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
    malformed["extra"] = Data([1, 2, 3]) as NSData
    await client.setPage(CloudKitChangedRecords(records: [good, malformed], token: nil, more: false, hardDeletedRecordCount: 0))
    do { _ = try await transport(client).fetchChanges(nil); XCTFail("expected unretainable scalar failure") }
    catch { XCTAssertEqual(CloudKitFailure.map(error), .failure) }
  }

  func testExactImmutableBytesRecoverFromConflictLostResponsePartialFailureAndSplit() async throws {
    let records = try schemaTwoFixtures().filter { $0.entityType == "ledger_entry" }
    for scenario in 0..<5 {
      let client = FakeCloudKitClient()
      switch scenario {
      case 0: await client.configure(mode: .conflict(try CloudKitRecordMapping.toRecord(records[0], zoneID: testZone)))
      case 1: await client.configure(mode: .loseResponseOnce)
      case 2: await client.configure(mode: .offlineOnce(records[1].entityId))
      case 3: await client.configure(limit: 1)
      default: await client.configure(mode: .limitAfterSaveOnce)
      }
      do { try await transport(client).upload(records + [records[0]]) }
      catch { XCTAssertTrue(scenario == 1 || scenario == 2) }
      try await transport(client).upload(records)
      let stored = await client.store
      for value in records {
        let record = try XCTUnwrap(stored[CKRecord.ID(recordName: value.entityId, zoneID: testZone)])
        XCTAssertTrue(CloudKitRecordMapping.sameImmutable(try CloudKitRecordMapping.fromRecord(record), value))
      }
      let names = await client.savedNames
      XCTAssertEqual(Set(names).count, names.count)
    }
  }
}
