import Foundation
import HabitEngine
import XCTest

final class SampleTests: XCTestCase {
  func testSampleRuntimeUsesSharedHistoryInAnIsolatedStore() async throws {
    let real = try EngineHost(databasePath: ":memory:")
    _ = try await real.call("initialize")
    let sample = try EngineHost(databasePath: ":memory:")
    _ = try await sample.call("initializeSample")
    let boards = try await sample.call("listActiveBoards") as! [[String: Any]]
    XCTAssertEqual(boards.count, 8)
    let history = try await sample.call("getGroupedCheckInHistory", [boards[0]["id"]!]) as! [String: Any]
    XCTAssertFalse((history["months"] as! [Any]).isEmpty)
    let originalBoards = try await real.call("listActiveBoards") as! [Any]
    XCTAssertTrue(originalBoards.isEmpty)
    let settings = try await sample.call("getAppSettings") as! [String: Any]
    XCTAssertEqual(settings["iCloudSyncEnabled"] as? Bool, false)
  }

  func testSampleCannotPopulateAPersistentStore() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let engine = try EngineHost(databasePath: directory.appendingPathComponent("habit-system.db").path)
    _ = try await engine.call("initialize")
    do { _ = try await engine.call("initializeSample"); XCTFail("sample must reject a persistent store") }
    catch let error as EngineFailure { XCTAssertEqual(error.code, "validation") }
    let boards = try await engine.call("listActiveBoards") as! [Any]
    XCTAssertTrue(boards.isEmpty)
  }
}
