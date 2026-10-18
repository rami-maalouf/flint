import XCTest

final class IsolatedStoreArgumentsTests: XCTestCase {
  @MainActor func testMalformedTestStoreArgumentsNeverFallBackToPersonalStorage() async {
    for arguments in [["app", "--database-path"], ["app", "--database-path", "--widget-preview"], ["app", "--database-path", "relative.db"]] {
      let model = AppModel(arguments: arguments)
      XCTAssertTrue(model.isolatedStore)
      // never start a failed isolation case against personal storage, even in the red test.
      guard model.isolatedStore, model.databasePath.isEmpty else {
        XCTFail("invalid test-store arguments must fail closed before opening a database")
        continue
      }
      await model.start()
      XCTAssertFalse(model.ready)
      XCTAssertNil(model.engine)
      XCTAssertNil(model.notifications)
      XCTAssertNil(model.synchronizer)
      XCTAssertNotNil(model.error)
    }
  }

  @MainActor func testExplicitMemoryAndAbsoluteTestPathsStayIsolated() {
    for path in [":memory:", "/tmp/habit-system-qa.db"] {
      let model = AppModel(arguments: ["app", "--database-path", path])
      XCTAssertTrue(model.isolatedStore)
      XCTAssertEqual(model.databasePath, path)
    }
  }
}
