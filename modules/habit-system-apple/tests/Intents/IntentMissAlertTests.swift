import Foundation
import XCTest
@testable import HabitSystemIntentCore

@MainActor final class IntentMissAlertTests: XCTestCase {
  private static var root: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }

  private func fixture() throws -> [String: Any] {
    let data = try Data(contentsOf: Self.root.appendingPathComponent("src/core/automations/fixtures/miss-alert-contract.json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testSharedPolicyAndPayloadLiterals() throws {
    let source = try fixture(), board = source["board"] as! [String: Any]
    let id = board["id"] as! String
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    for value in source["policy"] as! [[String: Any]] {
      let name = value["name"] as! String
      let time = IntentMissTime(instant: formatter.date(from: value["now"] as! String)!.timeIntervalSince1970 * 1000,
        zone: value["zone"] as! String, foreground: value["foreground"] as! Bool)
      let model = IntentMissBoard(id: id, kind: value["kind"] as? String ?? "daily", title: board["title"] as! String,
        startMinute: value["startOfDayMinute"] as? Int ?? 0, active: value["archivedAt"] == nil && value["deletedAt"] == nil)
      let periods = (value["periods"] as! [[String: Any]]).map {
        IntentMissPeriod(start: $0["startDate"] as! String, end: $0["endDate"] as? String)
      }
      let evidence = IntentMissEvidence(board: model, periods: periods, checked: Set(value["checks"] as! [String]))
      let pair = IntentMissPair(boardId: id, secondDate: value["pair"] as! String)
      XCTAssertEqual(try IntentMissAlerts.valid(pair, evidence: evidence, time: time), value["valid"] as! Bool, name)
      XCTAssertEqual(try IntentMissAlerts.candidate(evidence, time: time)?.pair.secondDate, value["candidate"] as? String, name)
      let trigger = value["trigger"] as! [String: String]
      XCTAssertEqual(try IntentMissAlerts.trigger(time), trigger["kind"] == "immediate" ? .immediate : .local09(trigger["date"]!), name)
    }
    for value in source["payloads"] as! [[String: Any]] {
      let content = IntentMissContent.decode(identifier: value["identifier"] as! String,
        title: value["title"] as! String, body: value["body"] as! String, data: value["data"] as! [String: Any])
      XCTAssertEqual(content != nil, value["valid"] as! Bool, value["name"] as! String)
      if let content {
        XCTAssertEqual(Array(content.title.utf8), Array((value["title"] as! String).utf8))
        XCTAssertEqual(content.data, value["data"] as? [String: String])
      }
    }
  }

  private final class Center: IntentMissNotificationCenter {
    var permission: IntentMissAuthorization = .granted
    var requests: [IntentMissPending] = []
    var delivered: [String] = []
    var result: IntentMissScheduleOutcome = .accepted
    var added: [IntentMissRequest] = []
    var cancelled: [String] = []
    var beforeAdd: (() async throws -> Void)?
    var beforePending: (() async throws -> Void)?
    var refreshes: [IntentMissRequest] = []
    var cancelError = false
    func authorization() async throws -> IntentMissAuthorization { permission }
    func pending() async throws -> [IntentMissPending] { try await beforePending?(); return requests }
    func presented() async throws -> [String] { delivered }
    func put(_ request: IntentMissRequest, replacing: IntentMissPending?, isCurrent: () -> Bool) async -> IntentMissScheduleOutcome {
      do { try await beforeAdd?() } catch { return .unknown }
      guard isCurrent() else { return .retired }
      if replacing == nil { added.append(request) } else { refreshes.append(request) }
      if result == .accepted {
        requests.removeAll { $0.identifier == request.content.identifier }
        requests.append(.init(identifier: request.content.identifier, content: request.content, nextFire: 9_999_999_999_999))
      }
      return result
    }
    func cancel(_ identifier: String) async throws {
      if cancelError { throw IntentFailure.database }
      cancelled.append(identifier)
      requests.removeAll { $0.identifier == identifier }
    }
  }

  @MainActor private final class Harness {
    let database: IntentDatabase
    let center = Center()
    var instant = 1_788_955_200_000.0
    var zone = "America/Toronto"
    var foreground = false
    let board = "00000000-0000-4000-8000-00000000A001"
    var sequence = 0
    lazy var executor = IntentExecutor(database: database, now: { self.instant }, zone: { self.zone }, uuid: { self.id() })
    lazy var runner = IntentMissAlertReconciliation(executor: executor, center: center, foreground: { self.foreground })
    var pair: IntentMissPair { .init(boardId: board, secondDate: "2026-09-08") }
    init(path: String = ":memory:") throws {
      database = try IntentDatabase(path: path, createForTesting: true)
      for migration in try IntentFixtureMigrations.load(root: IntentMissAlertTests.root) {
        try IntentFixtureMigrations.apply(migration, to: database, enqueueAt: 1)
      }
      try database.run("INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, 12, '00000000-0000-4000-8000-00000000d001')")
      try database.run("""
        INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background, tracks_amount, quick_amount,
          tracks_time, start_of_day_minute, metrics_enabled, order_key, created_at, updated_at, mutation_stamp, kind)
        VALUES (?, 'Thé 水', 'star.fill', '#70A7FF', 1, 0, 1, 0, 0, 1, '1', 1, 1, 'seed', 'daily')
        """, [.text(board)])
      try database.run("INSERT INTO board_activity_periods (board_id, start_date, mutation_stamp) VALUES (?, '2026-09-01', 'seed')", [.text(board)])
      instant = ISO8601DateFormatter().date(from: "2026-09-09T12:00:00Z")!.timeIntervalSince1970 * 1000
    }
    func id() -> String {
      sequence += 1
      return String(format: "00000000-0000-4000-8000-%012d", sequence)
    }
    func check(_ date: String) throws -> IntentCreatedCheckIn {
      try executor.checkIn(.init(commandId: id(), boardId: board, logicalDate: date)).get()
    }
    func rows() throws -> [[String: IntentSQLValue]] {
      try database.rows("SELECT * FROM miss_alerts ORDER BY board_id, second_missed_date")
    }
    func productSnapshot() throws -> [String: [[String: IntentSQLValue]]] {
      var result: [String: [[String: IntentSQLValue]]] = [:]
      for row in try database.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'miss_alerts' ORDER BY name") {
        let name = row["name"]!.string!
        result[name] = try database.rows("SELECT * FROM \(name) ORDER BY rowid")
      }
      return result
    }
  }

  func testRemoveSchedulesOnlyAfterProductCommitAndCheckCancels() async throws {
    let h = try Harness()
    let created = try h.check("2026-09-08")
    let removed = try h.executor.removeLatest(commandId: h.id(), boardId: h.board, logicalDate: "2026-09-08").get()
    let before = try h.productSnapshot()
    h.center.beforeAdd = {
      XCTAssertEqual(try h.productSnapshot(), before)
      XCTAssertEqual(try h.rows().first?["status"], .text("pending"))
      XCTAssertEqual(try h.rows().first?["native_identifier"], .text(h.pair.identifier))
    }
    let first = await h.runner.run(checkInId: removed.removedCheckInId)
    XCTAssertNil(first.error)
    XCTAssertEqual(h.center.added.count, 1)
    XCTAssertEqual(h.center.added.first?.trigger, .local09("2026-09-09"))
    XCTAssertEqual(try h.rows().first?["status"], .text("scheduled"))
    XCTAssertEqual(try h.productSnapshot(), before)
    let checked = try h.check("2026-09-08")
    let afterCheck = try h.productSnapshot()
    let second = await h.runner.run(checkInId: checked.checkInId)
    XCTAssertNil(second.error)
    XCTAssertEqual(h.center.cancelled, [h.pair.identifier])
    XCTAssertEqual(try h.rows().first?["native_identifier"], .text(h.pair.identifier))
    XCTAssertEqual(try h.productSnapshot(), afterCheck)
    let replay = await h.runner.run(checkInId: created.checkInId)
    XCTAssertNil(replay.error)
    XCTAssertEqual(h.center.added.count, 1)
  }

  func testSharedRowOutcomesAndConsumedReservations() async throws {
    let source = try fixture(), context = try fixture()["rowContext"] as! [String: Any]
    for value in source["rows"] as! [[String: Any]] {
      let h = try Harness()
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      h.instant = formatter.date(from: context["now"] as! String)!.timeIntervalSince1970 * 1000
      h.zone = context["zone"] as! String
      h.foreground = context["foreground"] as! Bool
      XCTAssertEqual(h.board, context["boardId"] as? String)
      XCTAssertEqual(h.pair.secondDate, context["secondMissedDate"] as? String)
      XCTAssertTrue((context["pending"] as! [Any]).isEmpty)
      XCTAssertTrue((context["presented"] as! [Any]).isEmpty)
      try h.database.run("DELETE FROM board_activity_periods")
      for period in context["periods"] as! [[String: Any]] {
        try h.database.run("INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp) VALUES (?, ?, ?, 'seed')",
          [.text(h.board), .text(period["startDate"] as! String), .string(period["endDate"] as? String)])
      }
      let checks = try (context["checks"] as! [String]).map(h.check)
      let token = try XCTUnwrap(checks.first)
      if let prior = value["prior"] as? [String: Any] {
        try h.database.run("INSERT INTO miss_alerts VALUES (?, ?, ?, ?)", [.text(h.board), .text(h.pair.secondDate),
          prior["hasIdentifier"] as! Bool ? .text(h.pair.identifier) : .null, .text(prior["status"] as! String)])
      }
      h.center.permission = IntentMissAuthorization(rawValue: value["authorization"] as! String)!
      h.center.result = IntentMissScheduleOutcome(rawValue: value["outcome"] as! String)!
      _ = await h.runner.run(checkInId: token.checkInId)
      let row = try h.rows().first, name = value["name"] as! String
      XCTAssertEqual(row?["status"]?.string, value["finalStatus"] as? String, name)
      XCTAssertEqual(row?["board_id"]?.string, context["boardId"] as? String, name)
      XCTAssertEqual(row?["second_missed_date"]?.string, context["secondMissedDate"] as? String, name)
      XCTAssertEqual(row?["native_identifier"]?.string, value["finalIdentifier"] as? String, name)
      XCTAssertEqual(h.center.added.count, value["adds"] as! Int, name)
    }
  }

  func testMalformedAndOrphanOwnedRequestsCancelWithoutReissuingInSamePass() async throws {
    for mode in ["malformed", "orphan"] {
      let h = try Harness(), token = try h.check("2026-09-09")
      if mode == "malformed" {
        try h.database.run("INSERT INTO miss_alerts VALUES (?, ?, ?, 'pending')", [.text(h.board), .text(h.pair.secondDate), .text(h.pair.identifier)])
      }
      h.center.requests = [.init(identifier: h.pair.identifier,
        content: mode == "orphan" ? .init(pair: h.pair, title: "Old title") : nil, nextFire: h.instant + 60000)]
      let result = await h.runner.run(checkInId: token.checkInId)
      XCTAssertNil(result.error, mode)
      XCTAssertEqual(h.center.cancelled, [h.pair.identifier], mode)
      XCTAssertEqual(h.center.added.count, 0, mode)
      if mode == "malformed" { XCTAssertEqual(try h.rows().first?["status"], .text("pending")) }
      else { XCTAssertTrue(try h.rows().isEmpty) }
    }
  }

  func testFutureRefreshAcceptsCapturedTitleAndPreservesConsumedIdentifierOnFailure() async throws {
    for outcome in [IntentMissScheduleOutcome.accepted, .notAccepted, .unknown, .retired] {
      let h = try Harness(), token = try h.check("2026-09-09")
      h.instant += 7200000
      h.foreground = true
      try h.database.run("INSERT INTO miss_alerts VALUES (?, ?, ?, 'scheduled')", [.text(h.board), .text(h.pair.secondDate), .text(h.pair.identifier)])
      h.center.requests = [.init(identifier: h.pair.identifier, content: .init(pair: h.pair, title: "Captured title"), nextFire: h.instant + 60000)]
      h.center.result = outcome
      _ = await h.runner.run(checkInId: token.checkInId)
      XCTAssertEqual(h.center.refreshes.count, 1, outcome.rawValue)
      XCTAssertEqual(h.center.refreshes.first?.content.title, "Thé 水")
      XCTAssertEqual(h.center.refreshes.first?.trigger, .immediate)
      XCTAssertEqual(h.center.added.count, 0)
      XCTAssertEqual(try h.rows().first?["native_identifier"], .text(h.pair.identifier))
      XCTAssertEqual(try h.rows().first?["status"], .text(outcome == .notAccepted || outcome == .unknown ? "error" : "scheduled"))
    }
  }

  func testClockAndZoneChangesBeforeDispatchReplanWithoutLosingPair() async throws {
    for mode in ["nine", "zone"] {
      let h = try Harness(), token = try h.check("2026-09-09")
      h.foreground = true
      var changed = false
      h.center.beforeAdd = {
        guard !changed else { return }
        changed = true
        if mode == "nine" { h.instant += 3_600_000 } else { h.zone = "UTC" }
      }
      let result = await h.runner.run(checkInId: token.checkInId)
      XCTAssertNil(result.error)
      XCTAssertEqual(h.center.added.count, 1, mode)
      XCTAssertEqual(h.center.added.first?.trigger, .immediate, mode)
      XCTAssertEqual(try h.rows().first?["status"], .text("scheduled"), mode)
    }
  }

  func testRealSecondConnectionSeesCommittedReservationAndCannotJoinIt() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite")
    defer { try? FileManager.default.removeItem(at: path) }
    let h = try Harness(path: path.path), token = try h.check("2026-09-09")
    let other = try IntentDatabase(path: path.path)
    let otherCenter = Center()
    let executor = IntentExecutor(database: other, now: { h.instant }, zone: { h.zone })
    h.center.beforeAdd = {
      XCTAssertEqual(try other.rows("SELECT status FROM miss_alerts").first?["status"], .text("pending"))
      let runner = IntentMissAlertReconciliation(executor: executor, center: otherCenter, foreground: { false })
      let result = await runner.run(checkInId: token.checkInId)
      XCTAssertNil(result.error)
      XCTAssertEqual(otherCenter.added.count, 0)
    }
    _ = await h.runner.run(checkInId: token.checkInId)
    XCTAssertEqual(h.center.added.count, 1)
    XCTAssertEqual(otherCenter.added.count, 0)
  }

  func testOutcomeSqlFailurePreservesCommittedCommandAndReservation() async throws {
    let h = try Harness(), token = try h.check("2026-09-09")
    let before = try h.productSnapshot()
    h.center.beforeAdd = {
      try h.database.run("CREATE TRIGGER fail_miss_outcome BEFORE UPDATE ON miss_alerts BEGIN SELECT RAISE(ABORT, 'private native sql'); END")
    }
    let result = await h.runner.run(checkInId: token.checkInId)
    XCTAssertEqual(result.error, "Miss alerts could not be updated.")
    XCTAssertTrue(result.changed)
    XCTAssertEqual(h.center.added.count, 1)
    XCTAssertEqual(try h.rows().first?["status"], .text("pending"))
    XCTAssertEqual(try h.rows().first?["native_identifier"], .text(h.pair.identifier))
    XCTAssertEqual(try h.productSnapshot(), before)
  }

  func testPostEffectBackfillCancelsAndReplayedTokenUsesOriginalBoard() async throws {
    let h = try Harness()
    let command = h.id()
    let created = try h.executor.checkIn(.init(commandId: command, boardId: h.board, logicalDate: "2026-09-09")).get()
    h.center.beforeAdd = { _ = try h.check("2026-09-08") }
    _ = await h.runner.run(checkInId: created.checkInId)
    XCTAssertEqual(h.center.cancelled, [h.pair.identifier])
    let replayed = try h.executor.checkIn(.init(commandId: command, boardId: "missing", logicalDate: "broken")).get()
    XCTAssertEqual(replayed, created)
    _ = await h.runner.run(checkInId: replayed.checkInId)
    XCTAssertEqual(h.center.added.count, 1)
    let before = try h.productSnapshot()
    let missing = await h.runner.run(checkInId: "missing")
    XCTAssertEqual(missing.error, "Miss alerts could not be updated.")
    XCTAssertEqual(try h.productSnapshot(), before)
  }

  func testStoreRejectsInvalidAndCrossPairExpectedStates() throws {
    let h = try Harness(), store = IntentMissAlertStore(executor: h.executor)
    let other = IntentMissPair(boardId: h.board, secondDate: "2026-09-07")
    let a = IntentMissRow(pair: h.pair, status: "pending", identifier: nil)
    let b = IntentMissRow(pair: other, status: "pending", identifier: nil)
    try store.transaction(true) { database in
      try store.replace(database, expected: nil, next: a)
      try store.replace(database, expected: nil, next: b)
    }
    let before = try h.rows()
    XCTAssertThrowsError(try store.transaction(true) {
      try store.replace($0, expected: a, next: .init(pair: other, status: "denied", identifier: nil))
    })
    XCTAssertThrowsError(try store.transaction(true) {
      try store.replace($0, expected: a, next: .init(pair: h.pair, status: "error", identifier: "wrong"))
    })
    XCTAssertEqual(try h.rows(), before)
  }

  func testCommitFailureReportsNoUncommittedProgressOrNativeEffect() async throws {
    let h = try Harness(), token = try h.check("2026-09-09")
    try h.database.run("CREATE TABLE miss_fault (board_id TEXT REFERENCES boards(id) DEFERRABLE INITIALLY DEFERRED)")
    try h.database.run("CREATE TEMP TRIGGER fail_miss_commit AFTER INSERT ON miss_alerts BEGIN INSERT INTO miss_fault VALUES ('missing'); END")
    let before = try h.productSnapshot()
    let result = await h.runner.run(checkInId: token.checkInId)
    XCTAssertFalse(result.changed)
    XCTAssertEqual(result.error, "Miss alerts could not be updated.")
    XCTAssertTrue(try h.rows().isEmpty)
    XCTAssertEqual(h.center.added.count, 0)
    XCTAssertEqual(try h.productSnapshot(), before)
  }

  func testDeniedAndUndeterminedNeedNoRepresentableNativeTrigger() async throws {
    for permission in [IntentMissAuthorization.denied, .undetermined] {
      let h = try Harness(), token = try h.check("2026-09-09")
      h.instant = ISO8601DateFormatter().date(from: "9999-12-31T23:00:00Z")!.timeIntervalSince1970 * 1000
      h.zone = "UTC"
      h.center.permission = permission
      let result = await h.runner.run(checkInId: token.checkInId)
      XCTAssertNil(result.error)
      XCTAssertEqual(try h.rows().first?["status"], .text(permission == .denied ? "denied" : "pending"))
      XCTAssertEqual(try h.rows().first?["native_identifier"], .null)
      XCTAssertEqual(h.center.added.count, 0)
    }
  }

  func testActualJavascriptAndSwiftCompeteForTheSamePairInBothDirections() async throws {
    for winner in ["swift", "javascript"] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let h = try Harness(path: directory.appendingPathComponent("store.sqlite").path)
      try h.database.run("PRAGMA journal_mode = WAL")
      let token = try h.check("2026-09-09")
      let before = try h.productSnapshot()
      let process = Process(), output = Pipe(), input = Pipe()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["bun", "modules/habit-system-apple/tests/native/miss-alert-javascript.cjs",
        directory.appendingPathComponent("store.sqlite").path, String(h.instant), h.zone,
        winner == "javascript" ? "hold" : "run"]
      process.currentDirectoryURL = Self.root
      process.standardOutput = output
      process.standardInput = input
      func finalOutput() throws -> [String: Any] {
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
      }
      if winner == "swift" {
        h.center.beforeAdd = {
          try process.run()
          let js = try finalOutput()
          XCTAssertEqual(js["calls"] as? Int, 0)
          XCTAssertTrue((js["result"] as? [String: Any])?["error"] is NSNull)
          XCTAssertEqual((js["rows"] as? [[String: Any]])?.first?["status"] as? String, "pending")
        }
        let native = await h.runner.run(checkInId: token.checkInId)
        XCTAssertNil(native.error)
        XCTAssertEqual(h.center.added.count, 1)
      } else {
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
          if byte == Data([10]) { break }
          line.append(byte)
        }
        let ready = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Bool])
        XCTAssertEqual(ready["ready"], true)
        XCTAssertEqual(try h.rows().first?["status"], .text("pending"))
        let native = await h.runner.run(checkInId: token.checkInId)
        XCTAssertNil(native.error)
        XCTAssertEqual(h.center.added.count, 0)
        try input.fileHandleForWriting.write(contentsOf: Data("release\n".utf8))
        let js = try finalOutput()
        XCTAssertEqual(js["calls"] as? Int, 1)
        XCTAssertTrue((js["result"] as? [String: Any])?["error"] is NSNull)
      }
      XCTAssertEqual(try h.rows().first?["status"], .text("scheduled"), winner)
      XCTAssertEqual(try h.rows().first?["native_identifier"], .text(h.pair.identifier), winner)
      XCTAssertEqual(try h.productSnapshot(), before, winner)
    }
  }

  func testReceiptReplayAndNoopReconcileRetainedTokenWithoutTouchingOtherRequests() async throws {
    let h = try Harness(), created = try h.check("2026-09-08")
    let noop = try h.check("2026-09-08")
    XCTAssertFalse(noop.created)
    XCTAssertEqual(noop.checkInId, created.checkInId)
    h.center.requests = [.init(identifier: "ordinary", content: nil, nextFire: nil),
      .init(identifier: "habit-system.miss.v1:00000000-0000-4000-8000-00000000A002:2026-09-08", content: nil, nextFire: nil)]
    _ = await h.runner.run(checkInId: noop.checkInId)
    XCTAssertEqual(h.center.added.count, 0)
    let command = h.id()
    let removed = try h.executor.removeLatest(commandId: command, boardId: h.board, logicalDate: "2026-09-08").get()
    _ = await h.runner.run(checkInId: removed.removedCheckInId)
    let repeated = try h.executor.removeLatest(commandId: command, boardId: "missing", logicalDate: "bad").get()
    XCTAssertEqual(repeated, removed)
    _ = await h.runner.run(checkInId: repeated.removedCheckInId)
    XCTAssertEqual(h.center.added.count, 1)
    XCTAssertEqual(h.center.cancelled, [])
    XCTAssertTrue(h.center.requests.contains { $0.identifier == "ordinary" })
    XCTAssertTrue(h.center.requests.contains { $0.identifier.hasSuffix("A002:2026-09-08") })
  }

  func testArchivedDeletedAndCountBoardsCancelOnlyTheirOwnedPendingAssertion() async throws {
    for change in ["archived_at = 1", "deleted_at = 1", "kind = 'count'"] {
      let h = try Harness(), token = try h.check("2026-09-09")
      _ = await h.runner.run(checkInId: token.checkInId)
      try h.database.run("UPDATE boards SET \(change) WHERE id = ?", [.text(h.board)])
      let before = try h.productSnapshot()
      _ = await h.runner.run(checkInId: token.checkInId)
      XCTAssertEqual(h.center.cancelled, [h.pair.identifier], change)
      XCTAssertEqual(h.center.added.count, 1, change)
      XCTAssertEqual(try h.productSnapshot(), before, change)
    }
  }

  func testSuppressedRawCheckDoesNotPreventAlertAndInvalidStorageIsSafe() async throws {
    let h = try Harness(), token = try h.check("2026-09-09")
    try h.database.run("""
      INSERT INTO check_ins (id, board_id, logical_date, source, idempotency_key, created_at, updated_at, mutation_stamp)
      VALUES (?, ?, '2026-09-08', 'manual', ?, 1, 1, 'remote-payload')
      """, [.text(h.id()), .text(h.board), .text(h.id())])
    XCTAssertEqual(try h.database.rows("SELECT state_suppressed FROM check_ins WHERE logical_date = '2026-09-08'").first?["state_suppressed"], .integer(1))
    _ = await h.runner.run(checkInId: token.checkInId)
    XCTAssertEqual(h.center.added.count, 1)
    try h.database.run("PRAGMA user_version = 11")
    let before = try h.productSnapshot()
    let failed = await h.runner.run(checkInId: token.checkInId)
    XCTAssertFalse(failed.changed)
    XCTAssertEqual(failed.error, "Miss alerts could not be updated.")
    XCTAssertEqual(try h.productSnapshot(), before)
    XCTAssertEqual(h.center.added.count, 1)
  }

  func testLateFailurePreservesEarlierRecoveryAndOldOutcomeCannotOverwriteNewAcceptance() async throws {
    let h = try Harness(), token = try h.check("2026-09-09")
    try h.database.run("INSERT INTO miss_alerts VALUES (?, '2026-09-05', ?, 'error')",
      [.text(h.board), .text(IntentMissPair(boardId: h.board, secondDate: "2026-09-05").identifier)])
    h.center.delivered = [IntentMissPair(boardId: h.board, secondDate: "2026-09-05").identifier]
    try h.database.run("CREATE TEMP TRIGGER fail_new_miss BEFORE INSERT ON miss_alerts BEGIN SELECT RAISE(ABORT, 'private'); END")
    let result = await h.runner.run(checkInId: token.checkInId)
    XCTAssertTrue(result.changed)
    XCTAssertEqual(result.error, "Miss alerts could not be updated.")
    XCTAssertEqual(try h.rows().first?["status"], .text("scheduled"))
    try h.database.run("DROP TRIGGER fail_new_miss")
    h.center.beforeAdd = {
      let store = IntentMissAlertStore(executor: h.executor)
      try store.transaction(true) { database in
        let prior = try XCTUnwrap(store.row(database, h.pair))
        try store.replace(database, expected: prior, next: .init(pair: h.pair, status: "scheduled", identifier: h.pair.identifier))
      }
    }
    h.center.result = .unknown
    _ = await h.runner.run(checkInId: token.checkInId)
    XCTAssertEqual(try h.rows().last?["status"], .text("scheduled"))
  }
}
