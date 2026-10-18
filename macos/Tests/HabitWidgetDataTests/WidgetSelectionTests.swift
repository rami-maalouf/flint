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

  func testChooserOpensCurrentPageClampsAndSelectsOnlyPresentHabits() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(configured: ids[7]), directory: directory)
    let current = snapshot(ids)
    XCTAssertEqual(store.read(), WidgetSelectionState())
    let opened = try store.apply(.open, snapshot: current)
    XCTAssertTrue(opened.isChoosing)
    XCTAssertEqual(opened.pickerPage, 2)
    XCTAssertEqual(opened.visibleHabits(in: current, pageSize: 3).map(\.id), Array(ids[6...8]))
    XCTAssertEqual(try store.apply(.page(Int.max), snapshot: current).pickerPage, 3)
    XCTAssertEqual(try store.apply(.page(-1), snapshot: current).pickerPage, 0)
    XCTAssertThrowsError(try store.apply(.select(UUID().uuidString), snapshot: current))
    let chosen = try store.apply(.select(ids[4]), snapshot: current)
    XCTAssertEqual(chosen.selectedID, ids[4])
    XCTAssertFalse(chosen.isChoosing)
    XCTAssertEqual(store.read(), chosen)
    XCTAssertEqual(try store.apply(.open, snapshot: snapshot(Array(ids.reversed()))).pickerPage, 1)
    XCTAssertFalse(try store.apply(.close, snapshot: current).isChoosing)
  }

  func testDeletionAndEmptySnapshotsKeepSelectionButBoundPickerPages() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    _ = try store.apply(.select(ids[9]), snapshot: snapshot(ids))
    let lastPage = try store.apply(.open, snapshot: snapshot(ids))
    XCTAssertEqual(lastPage.pickerPage, 3)
    XCTAssertEqual(lastPage.boundedPage(in: snapshot(Array(ids.prefix(2))), pageSize: 3), 0)
    let empty = try store.apply(.page(Int.max), snapshot: snapshot([]))
    XCTAssertEqual(empty.pickerPage, 0)
    XCTAssertEqual(empty.selectedID, ids[9])
    XCTAssertNil(empty.selectedHabit(in: snapshot(Array(ids.prefix(2))), configuredHabitID: nil))
    XCTAssertTrue(empty.visibleHabits(in: snapshot([]), pageSize: 3).isEmpty)
  }

  func testKeysIsolateEnvironmentKindFamilyAndConfigurationWithoutWritingSnapshots() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    let snapshotURL = directory.appendingPathComponent("widgets-Development.json")
    try WidgetSnapshotStore.write(snapshot(ids), to: snapshotURL)
    let original = try Data(contentsOf: snapshotURL)
    _ = try store.apply(.select(ids[2]), snapshot: snapshot(ids))
    XCTAssertEqual(try Data(contentsOf: snapshotURL), original)
    for scope in [key(environment: "Production"), key(kind: "HabitSystem.WeeklyFocus"), key(family: "medium"), key(configured: ids[0])] {
      let other = WidgetSelectionStore(key: scope, directory: directory)
      XCTAssertNotEqual(other.url, store.url)
      XCTAssertEqual(other.read(), WidgetSelectionState())
    }
    XCTAssertThrowsError(try store.apply(.open, snapshot: snapshot(ids, environment: "Production")))
    let data = try Data(contentsOf: XCTUnwrap(store.url))
    let fields = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual(Set(fields.keys), ["selectedID", "pickerPage", "isChoosing"])
  }

  func testInvalidKeysAndCorruptOrOversizedFilesAreSafe() throws {
    XCTAssertNil(WidgetSelectionKey(environment: "../Production", kind: "HabitSystem.ActivityGrid", family: "small", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "Today", family: "small", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "HabitSystem.ActivityGrid", family: "../large", configuredHabitID: nil))
    XCTAssertNil(WidgetSelectionKey(environment: "Development", kind: "HabitSystem.ActivityGrid", family: "small", configuredHabitID: "../../snapshot"))
    XCTAssertEqual(key().pageSize, 3)
    XCTAssertEqual(key(family: "medium").pageSize, 4)
    XCTAssertEqual(key(family: "large").pageSize, 7)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = WidgetSelectionStore(key: key(), directory: directory)
    _ = try store.apply(.open, snapshot: snapshot(ids))
    let url = try XCTUnwrap(store.url)
    for data in [Data("{partial".utf8), Data(repeating: 32, count: 4_097), Data("{\"selectedID\":null,\"pickerPage\":-1,\"isChoosing\":true}".utf8)] {
      try data.write(to: url)
      XCTAssertEqual(store.read(), WidgetSelectionState())
    }
  }

  func testCaseDistinctImportedConfigurationIDsDoNotShareStateOnMacFilesystem() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let uppercase = WidgetSelectionStore(key: key(configured: ids[0]), directory: directory)
    let lowercase = WidgetSelectionStore(key: key(configured: ids[0].lowercased()), directory: directory)
    _ = try uppercase.apply(.select(ids[2]), snapshot: snapshot(ids))
    XCTAssertEqual(lowercase.read(), WidgetSelectionState())
  }
}
