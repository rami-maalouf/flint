import Foundation
import XCTest
@testable import HabitWidgetData

final class WidgetSelectionTests: XCTestCase {
  private let ids = (0..<10).map { String(format: "ABCDEFAB-1234-4ABC-8DEF-%012d", $0) }
  private func snapshot(_ ids: [String], environment: String = "Development") -> WidgetSnapshot {
    WidgetSnapshot(generatedAtUtc: 1_000, expiresAtUtc: 2_000, timeZoneID: "UTC", balance: 0,
      habits: ids.map { WidgetHabit(id: $0, title: $0, symbol: "book", accentHex: "#78D98B", kind: "daily", logicalDate: "2026-10-18", checkedToday: false, currentStreak: nil, todayCount: 0, weeks: []) }, environment: environment)
  }
  private func key(environment: String = "Development", kind: String = "HabitSystem.ActivityGrid", family: String = "small", configured: String? = nil) -> WidgetSelectionKey {
    WidgetSelectionKey(environment: environment, kind: kind, family: family, configuredHabitID: configured)!
  }

  func testSelectionResolvesExactIDsAndNeverReplacesMissingPinnedOrChosenHabit() {
    let current = snapshot(ids)
    XCTAssertEqual(WidgetSelectionState().selectedHabit(in: current, configuredHabitID: nil)?.id, ids[0])
    XCTAssertEqual(WidgetSelectionState().selectedHabit(in: current, configuredHabitID: ids[2])?.id, ids[2])
    XCTAssertNil(WidgetSelectionState().selectedHabit(in: current, configuredHabitID: UUID().uuidString))
    XCTAssertNil(WidgetSelectionState(selectedID: UUID().uuidString).selectedHabit(in: current, configuredHabitID: ids[0]))
    XCTAssertEqual(WidgetSelectionState(selectedID: ids[3]).selectedHabit(in: current, configuredHabitID: UUID().uuidString)?.id, ids[3])
    XCTAssertNil(WidgetSelectionState().selectedHabit(in: snapshot([]), configuredHabitID: nil))
  }

  func testClickAdvancesFromDisplayedHabitAndWrapsInSnapshotOrder() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(configured: ids[7]), directory: directory)
    XCTAssertEqual(try store.advance(snapshot: snapshot(ids)).selectedID, ids[8])
    XCTAssertEqual(try store.advance(snapshot: snapshot(ids)).selectedID, ids[9])
    XCTAssertEqual(try store.advance(snapshot: snapshot(ids)).selectedID, ids[0])
    XCTAssertEqual(store.read().selectedID, ids[0])
    XCTAssertEqual(try store.advance(snapshot: snapshot(Array(ids.reversed()))).selectedID, ids[9])
  }

  func testClickHandlesDefaultMissingSingleAndEmptyHabits() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    XCTAssertEqual(try store.advance(snapshot: snapshot(ids)).selectedID, ids[1])
    XCTAssertEqual(try store.advance(snapshot: snapshot([ids[3], ids[4]])).selectedID, ids[3])
    XCTAssertEqual(try store.advance(snapshot: snapshot([ids[3]])).selectedID, ids[3])
    let original = try Data(contentsOf: XCTUnwrap(store.url))
    XCTAssertThrowsError(try store.advance(snapshot: snapshot([])))
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(store.url)), original)
  }

  func testOverlappingClicksEachAdvanceOnce() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    let current = snapshot(ids)
    try store.write(WidgetSelectionState(selectedID: ids[0]))
    DispatchQueue.concurrentPerform(iterations: 128) { _ in
      do { _ = try store.advance(snapshot: current) }
      catch { XCTFail("cycle failed: \(error)") }
    }
    XCTAssertEqual(store.read().selectedID, ids[8])
  }

  func testPreviousChooserStateKeepsSelectionWhenUpgradingToCycling() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = Data("{\"selectedID\":\"\(ids[4])\",\"pickerPage\":1,\"isChoosing\":true}".utf8)
    try data.write(to: XCTUnwrap(store.url))
    XCTAssertEqual(store.read().selectedID, ids[4])
    XCTAssertEqual(try store.advance(snapshot: snapshot(ids)).selectedID, ids[5])
  }

  func testKeysIsolateEnvironmentKindFamilyAndConfigurationWithoutWritingSnapshots() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    let snapshotURL = directory.appendingPathComponent("widgets-Development.json")
    try WidgetSnapshotStore.write(snapshot(ids), to: snapshotURL)
    let original = try Data(contentsOf: snapshotURL)
    _ = try store.advance(snapshot: snapshot(ids))
    XCTAssertEqual(try Data(contentsOf: snapshotURL), original)
    for scope in [key(environment: "Production"), key(kind: "HabitSystem.WeeklyFocus"), key(family: "medium"), key(configured: ids[0])] {
      let other = WidgetSelectionStore(key: scope, directory: directory)
      XCTAssertNotEqual(other.url, store.url)
      XCTAssertEqual(other.read(), WidgetSelectionState())
    }
    XCTAssertThrowsError(try store.advance(snapshot: snapshot(ids, environment: "Production")))
    let data = try Data(contentsOf: XCTUnwrap(store.url))
    let fields = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual(Set(fields.keys), ["selectedID"])
  }

  func testInvalidKeysAndCorruptOrOversizedFilesAreSafe() throws {
    XCTAssertNil(WidgetSelectionKey(environment: "../Production", kind: "HabitSystem.ActivityGrid", family: "small", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "Today", family: "small", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "HabitSystem.ActivityGrid", family: "../large", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "HabitSystem.ActivityGrid", family: "small", configuredHabitID: "../../snapshot"))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    _ = try store.advance(snapshot: snapshot(ids))
    let url = try XCTUnwrap(store.url)
    for data in [Data("{partial".utf8), Data(repeating: 32, count: 4_097), Data("{\"selectedID\":\"invalid\"}".utf8)] {
      try data.write(to: url)
      XCTAssertEqual(store.read(), WidgetSelectionState())
    }
  }

  func testCaseDistinctImportedConfigurationIDsDoNotShareStateOnMacFilesystem() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let uppercase = WidgetSelectionStore(key: key(configured: ids[0]), directory: directory)
    let lowercase = WidgetSelectionStore(key: key(configured: ids[0].lowercased()), directory: directory)
    _ = try uppercase.advance(snapshot: snapshot(ids))
    XCTAssertEqual(lowercase.read(), WidgetSelectionState())
  }
}
