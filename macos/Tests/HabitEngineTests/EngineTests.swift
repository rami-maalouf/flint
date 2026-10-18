import Foundation
import JavaScriptCore
import XCTest
@testable import HabitEngine

final class EngineTests: XCTestCase {
  func testDailyCheckPersistsAndReplayingCommandDoesNotMintCoins() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("habit-system.db").path
    var engine: EngineHost? = try EngineHost(databasePath: path)
    _ = try await engine!.call("initialize")
    let created = try await engine!.call("createBoard", [[
      "commandId": UUID().uuidString.lowercased(), "title": "Read", "kind": "daily",
      "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false,
      "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0,
      "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1
    ]]) as! [String: Any]
    let boardID = try XCTUnwrap(created["boardId"] as? String)
    let command: [String: Any] = ["commandId": UUID().uuidString.lowercased(), "boardId": boardID, "expectedCheckIns": []]
    _ = try await engine!.call("toggleDailyCheckIn", [command])
    _ = try await engine!.call("toggleDailyCheckIn", [command])
    let coins = try await engine!.call("getCoinTotals") as! [String: Any]
    XCTAssertEqual(coins["balance"] as? Int, 1)
    engine = nil
    let reopened = try EngineHost(databasePath: path)
    _ = try await reopened.call("initialize")
    let home = try await reopened.call("getHomeBoardProjection") as! [[String: Any]]
    XCTAssertEqual(home.count, 1)
    XCTAssertEqual((home[0]["daily"] as? [String: Any])?["checkedToday"] as? Bool, true)
    let savedCoins = try await reopened.call("getCoinTotals") as! [String: Any]
    XCTAssertEqual(savedCoins["balance"] as? Int, 1)
  }
}

extension EngineTests {
  private func habit(_ title: String = "Read", kind: String = "daily") -> [String: Any] {
    ["commandId": UUID().uuidString.lowercased(), "title": title, "kind": kind,
     "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false,
     "tracksAmount": kind == "count", "amountUnit": "pages", "quickAmount": 1,
     "tracksTime": false, "startOfDayMinute": 0, "metricsEnabled": true,
     "earnsCoins": true, "coinCapPerDay": 1]
  }

  func testFailureRollsBackMutationAndSameRequestCanRetry() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    defer { try? FileManager.default.removeItem(atPath: path) }
    let engine = try EngineHost(databasePath: path)
    _ = try await engine.call("initialize")
    let inspector = try SQLiteStore(path: path)
    try inspector.execute("CREATE TRIGGER reject_outbox BEFORE INSERT ON mutation_outbox BEGIN SELECT RAISE(ABORT, 'forced failure'); END;")
    let request = habit()
    do { _ = try await engine.call("createBoard", [request]); XCTFail("write should fail") }
    catch let error as EngineFailure { XCTAssertEqual(error.code, "database") }
    let empty = try await engine.call("getHomeBoardProjection") as! [Any]
    XCTAssertEqual(empty.count, 0)
    try inspector.execute("DROP TRIGGER reject_outbox")
    _ = try await engine.call("createBoard", [request])
    let home = try await engine.call("getHomeBoardProjection") as! [Any]
    XCTAssertEqual(home.count, 1)
  }

  func testCountNotesAndBackupRoundTripPreserveBalance() async throws {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    let board = try await engine.call("createBoard", [habit("Lire café", kind: "count")]) as! [String: Any]
    _ = try await engine.call("createCheckIn", [["commandId": UUID().uuidString.lowercased(), "boardId": board["boardId"]!, "amount": 12.5, "note": "日本語 café", "source": "app"]])
    let backup = try await engine.call("export") as! [String: Any]
    let other = try EngineHost(databasePath: ":memory:")
    _ = try await other.call("initialize")
    let preview = try await other.call("previewImport", [backup["text"]!, "json"]) as! [String: Any]
    let request: [String: Any] = ["commandId": UUID().uuidString.lowercased(), "draft": preview["draft"]!]
    _ = try await other.call("importSnapshot", [request])
    _ = try await other.call("importSnapshot", [request])
    let coins = try await other.call("getCoinTotals") as! [String: Any]
    XCTAssertEqual(coins["balance"] as? Int, 1)
    let restored = try await other.call("export") as! [String: Any]
    let source = try JSONSerialization.jsonObject(with: Data((restored["text"] as! String).utf8)) as! [String: Any]
    let checks = source["checkIns"] as! [[String: Any]]
    XCTAssertEqual(checks.count, 1)
    XCTAssertEqual(checks[0]["note"] as? String, "日本語 café")
    XCTAssertEqual(checks[0]["amount"] as? Double, 12.5)
  }

  func testSQLPreservesEmptyStringsNullUnicodeAndEmbeddedNul() throws {
    let store = try SQLiteStore(path: ":memory:")
    let rows = try store.statement("SELECT ? AS empty, ? AS nullValue, ? AS text, ? AS number", parameters: ["", NSNull(), "a\0日本語", 12.5], rows: true) as! [[String: Any]]
    XCTAssertEqual(rows[0]["empty"] as? String, "")
    XCTAssertTrue(rows[0]["nullValue"] is NSNull)
    XCTAssertEqual(rows[0]["text"] as? String, "a\0日本語")
    XCTAssertEqual(rows[0]["number"] as? Double, 12.5)
  }

  func testMigrationMismatchPreservesExistingDatabase() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    defer { try? FileManager.default.removeItem(atPath: path) }
    let engine = try EngineHost(databasePath: path)
    _ = try await engine.call("initialize")
    _ = try await engine.call("createBoard", [habit()])
    let inspector = try SQLiteStore(path: path)
    try inspector.execute("UPDATE schema_migrations SET checksum = 'unexpected' WHERE version = 1")
    do { _ = try await engine.call("initialize"); XCTFail("mismatched schema must fail") }
    catch { XCTAssertTrue(FileManager.default.fileExists(atPath: path)) }
    let rows = try inspector.statement("SELECT title FROM boards", parameters: [], rows: true) as! [[String: Any]]
    XCTAssertEqual(rows.first?["title"] as? String, "Read")
  }
}

extension EngineTests {
  func testActualJavaScriptCoreCalendarAndUTF8Parity() throws {
    let context = try XCTUnwrap(JSContext())
    let url = try XCTUnwrap(Bundle.module.url(forResource: "parity", withExtension: "js"))
    context.evaluateScript(try String(contentsOf: url))
    XCTAssertNil(context.exception, context.exception?.toString() ?? "")
    XCTAssertEqual(context.objectForKeyedSubscript("parityFailures")?.toArray() as? [String], [])
  }
}
