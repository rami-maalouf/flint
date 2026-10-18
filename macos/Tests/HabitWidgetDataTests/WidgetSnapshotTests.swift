import Foundation
import XCTest
@testable import HabitWidgetData

final class WidgetSnapshotTests: XCTestCase {
  func testAtomicSnapshotRoundTripAndExpiry() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("snapshot.json")
    let snapshot = WidgetSnapshot(generatedAtUtc: 1_000, expiresAtUtc: 2_000, timeZoneID: "UTC", balance: 42, habits: [])
    try WidgetSnapshotStore.write(snapshot, to: url)
    XCTAssertEqual(WidgetSnapshotStore.read(from: url), snapshot)
    XCTAssertNil(WidgetSnapshotStore.read(from: url, environment: "Production"))
    XCTAssertEqual(WidgetSnapshotStore.read(from: url, environment: "Development"), snapshot)
    XCTAssertFalse(snapshot.isStale(at: Date(timeIntervalSince1970: 1.5), timeZoneID: "UTC"))
    XCTAssertTrue(snapshot.isStale(at: Date(timeIntervalSince1970: 2), timeZoneID: "UTC"))
    XCTAssertTrue(snapshot.isStale(at: Date(timeIntervalSince1970: 1.5), timeZoneID: "America/Toronto"))
    XCTAssertTrue(snapshot.isStale(at: Date(timeIntervalSince1970: 0), timeZoneID: "UTC"))
    try Data("partial json".utf8).write(to: url)
    XCTAssertNil(WidgetSnapshotStore.read(from: url))
    try WidgetSnapshotStore.write(WidgetSnapshot(schemaVersion: 99, generatedAtUtc: 1, expiresAtUtc: 2, timeZoneID: "UTC", balance: 0, habits: []), to: url)
    XCTAssertNil(WidgetSnapshotStore.read(from: url))
  }
  func testWidgetLinksKeepTheCloudEnvironmentExplicit() {
    let id = UUID().uuidString.lowercased()
    let url = WidgetSnapshotStore.destination(habitID: id, environment: "Development")
    XCTAssertEqual(url.host, "habit")
    XCTAssertEqual(url.lastPathComponent, id)
    XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "Development")
    XCTAssertNil(WidgetSnapshotStore.url(environment: "../Production"))
  }
}
