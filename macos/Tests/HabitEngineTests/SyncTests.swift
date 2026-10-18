import Combine
import Foundation
import XCTest
@testable import HabitEngine

final class SyncTests: XCTestCase {
  private func initialized(sync: Bool = true) async throws -> EngineHost {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    if sync { _ = try await engine.call("setICloudSyncEnabled", [["commandId": UUID().uuidString, "enabled": true]]) }
    return engine
  }

  private func createBoard(_ engine: EngineHost) async throws -> String {
    let created = try await engine.call("createBoard", [[
      "commandId": UUID().uuidString.lowercased(), "title": "Read", "kind": "daily",
      "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false,
      "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0,
      "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1
    ]]) as! [String: Any]
    return created["boardId"] as! String
  }

  private func install(_ server: SyncServer, on engine: EngineHost) async {
    await engine.registerService("sync.ensureZone") { _ in NSNull() }
    await engine.registerService("sync.upload") { request in try await server.upload(request["records"] as! String); return NSNull() }
    await engine.registerService("sync.fetchChanges") { request in try await server.fetch(request["token"] as? String) }
  }

  func testSyncRemainsIdleUntilExplicitlyEnabled() async throws {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    let outcome = try await engine.call("sync") as! [String: Any]
    XCTAssertEqual(outcome["status"] as? String, "idle")
    XCTAssertEqual(outcome["uploaded"] as? Int, 0)
  }

  func testTwoNativeStoresConvergeAfterDuplicateOfflineDailyChecksAndReorderedPages() async throws {
    let server = SyncServer()
    let first = try await initialized(), second = try await initialized()
    await install(server, on: first); await install(server, on: second)
    let board = try await createBoard(first)
    _ = try await first.call("sync")
    _ = try await second.call("sync")
    for engine in [first, second] {
      _ = try await engine.call("toggleDailyCheckIn", [["commandId": UUID().uuidString.lowercased(), "boardId": board, "expectedCheckIns": []]])
    }
    for _ in 0..<3 {
      for engine in [first, second] {
        let outcome = try await engine.call("sync") as! [String: Any]
        XCTAssertEqual(outcome["status"] as? String, "up_to_date")
      }
    }
    for engine in [first, second] {
      let coins = try await engine.call("getCoinTotals") as! [String: Any]
      XCTAssertEqual(coins["balance"] as? Int, 1)
      let state = try await engine.call("getDailyToggleSnapshot", [board]) as! [String: Any]
      XCTAssertEqual(state["checked"] as? Bool, true)
    }
  }

  func testOfflineRetryAndAccountMismatchKeepLocalWork() async throws {
    let engine = try await initialized()
    _ = try await createBoard(engine)
    await engine.registerService("sync.ensureZone") { _ in throw EngineFailure(code: "offline", message: "offline") }
    let offline = try await engine.call("sync") as! [String: Any]
    XCTAssertEqual(offline["status"] as? String, "offline")
    XCTAssertTrue((1000...2000).contains(offline["retryAfterMs"] as! Int))
    await engine.registerService("sync.ensureZone") { _ in throw EngineFailure(code: "unavailable", message: "account mismatch") }
    let mismatch = try await engine.call("sync") as! [String: Any]
    XCTAssertEqual(mismatch["status"] as? String, "needs_attention")
    let boards = try await engine.call("listActiveBoards") as! [Any]
    XCTAssertEqual(boards.count, 1)
    let summary = try await engine.call("getSyncSummary") as! [String: Any]
    XCTAssertGreaterThan(summary["pendingChanges"] as? Int ?? -1, 0)
  }

  func testCancellationDuringFetchReleasesEngineAndDiscardsLatePage() async throws {
    let engine = try await initialized()
    let server = SyncServer()
    await install(server, on: engine)
    let started = expectation(description: "fetch started")
    let gate = FetchGate()
    await engine.registerService("sync.fetchChanges") { _ in
      started.fulfill()
      return await gate.wait()
    }
    let running = Task { try await engine.call("sync") as! [String: Any] }
    await fulfillment(of: [started], timeout: 5)
    await engine.invalidateSync()
    let cancelled = try await running.value
    XCTAssertEqual(cancelled["status"] as? String, "idle")
    _ = try await createBoard(engine)
    await gate.finish()
    let home = try await engine.call("listActiveBoards") as! [Any]
    XCTAssertEqual(home.count, 1)
  }

  func testMalformedRemotePageNeverAdvancesToken() async throws {
    let engine = try await initialized()
    let server = SyncServer()
    await install(server, on: engine)
    await engine.registerService("sync.fetchChanges") { _ in "{\"records\":[],\"nextToken\":null,\"more\":true}" }
    let result = try await engine.call("sync") as! [String: Any]
    XCTAssertEqual(result["status"] as? String, "needs_attention")
    await engine.registerService("sync.fetchChanges") { request in
      XCTAssertTrue(request["token"] is NSNull)
      return "{\"records\":[],\"nextToken\":\"accepted\",\"more\":false}"
    }
    let recovery = try await engine.call("sync") as! [String: Any]
    XCTAssertEqual(recovery["status"] as? String, "up_to_date")
  }

  func testUnsignedBuildDoesNotConstructCloudKitContainer() async throws {
    let engine = try await initialized()
    await CloudKitAdapter.configureCloudKit(on: engine)
    let available = try await engine.call("cloudKitAvailable") as! Bool
    XCTAssertFalse(available)
  }

  @MainActor
  func testThrownEngineFailureReplacesPreviouslySuccessfulStatus() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("habit-system.db").path
    let engine = try EngineHost(databasePath: path)
    _ = try await engine.call("initialize")
    _ = try await engine.call("setICloudSyncEnabled", [["commandId": UUID().uuidString.lowercased(), "enabled": true]])
    await install(SyncServer(), on: engine)
    let coordinator = SyncCoordinator(engine: engine)
    var displayedStatus = "idle"
    let succeeded = expectation(description: "initial sync succeeds")
    coordinator.onOutcome = { outcome in
      displayedStatus = outcome.status
      succeeded.fulfill()
    }
    coordinator.onStatusChange = { displayedStatus = $0 }
    coordinator.request()
    await fulfillment(of: [succeeded], timeout: 5)
    XCTAssertEqual(displayedStatus, "up_to_date")
    coordinator.onOutcome = nil

    let database = try SQLiteStore(path: path)
    try database.execute("DROP TABLE sync_state")
    let failed = expectation(description: "engine exception reaches coordinator")
    let observation = coordinator.$status.filter { $0 == "needs_attention" }.sink { _ in failed.fulfill() }
    coordinator.request()
    await fulfillment(of: [failed], timeout: 5)
    XCTAssertEqual(displayedStatus, "needs_attention")
    observation.cancel()
    await coordinator.cancel()
  }

  @MainActor
  func testCoordinatorRetiresCancelledRunBeforeNewGenerationCompletes() async throws {
    let engine = try await initialized()
    let server = SyncServer()
    await install(server, on: engine)
    let firstFetch = expectation(description: "first run waiting")
    let gate = FetchGate()
    await engine.registerService("sync.fetchChanges") { _ in firstFetch.fulfill(); return await gate.wait() }
    let coordinator = SyncCoordinator(engine: engine)
    coordinator.request()
    coordinator.request()
    await fulfillment(of: [firstFetch], timeout: 5)
    await coordinator.cancel()
    XCTAssertEqual(coordinator.status, "idle")
    await install(server, on: engine)
    let completed = expectation(description: "new generation completes once")
    coordinator.onOutcome = { outcome in
      XCTAssertEqual(outcome.status, "up_to_date")
      completed.fulfill()
    }
    coordinator.request()
    await fulfillment(of: [completed], timeout: 5)
    await gate.finish()
    XCTAssertEqual(coordinator.status, "up_to_date")
    await coordinator.cancel()
  }
}

private actor FetchGate {
  private var continuation: CheckedContinuation<String, Never>?
  func wait() async -> String { await withCheckedContinuation { continuation = $0 } }
  func finish() { continuation?.resume(returning: "{\"records\":[],\"nextToken\":\"late\",\"more\":false}"); continuation = nil }
}

private actor SyncServer {
  private var records: [String: [String: Any]] = [:]
  private var version = 0

  func upload(_ json: String) throws {
    for record in try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]] {
      let id = record["entityId"] as! String
      if let prior = records[id], (prior["mutationStamp"] as! String) >= (record["mutationStamp"] as! String) { continue }
      records[id] = record; version += 1
    }
  }

  func fetch(_ token: String?) throws -> String {
    let changes = token == String(version) ? [] : records.values.sorted { ($0["entityId"] as! String) > ($1["entityId"] as! String) }
    return String(decoding: try JSONSerialization.data(withJSONObject: ["records": changes, "nextToken": String(version), "more": false]), as: UTF8.self)
  }
}
