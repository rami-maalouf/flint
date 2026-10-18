import Foundation
import HabitEngine
import XCTest

final class PresentationContractTests: XCTestCase {
  func testEditableAmountsRoundTripWithoutRoundingInDecimalCommaLocales() {
    for locale in [Locale(identifier: "en_CA"), Locale(identifier: "fr_CA"), Locale(identifier: "de_DE")] {
      for amount in [0.123456789012345, 123456.789123456, 1.0, 0.0000001] {
        XCTAssertEqual(parseEditableNumber(editableNumber(amount, locale: locale), locale: locale), amount)
      }
    }
    XCTAssertEqual(parseEditableNumber(" 1,25 ", locale: Locale(identifier: "fr_CA")), 1.25)
    XCTAssertNil(parseEditableNumber("NaN"))
    XCTAssertNil(parseEditableNumber("inf"))
    XCTAssertNil(parseEditableNumber("1,2,3", locale: Locale(identifier: "fr_CA")))
  }

  func testScreenModelsDecodeRealHabitAndStackHistory() async throws {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    let catalog: Catalog = try await engine.decode("catalog")
    XCTAssertFalse(catalog.symbols.isEmpty)
    var input: [String: Any] = ["commandId": UUID().uuidString.lowercased(), "title": "Read", "kind": "daily",
      "symbol": "book.fill", "accentHex": "#78D98B", "usesTintedBackground": false,
      "tracksAmount": false, "tracksTime": false, "startOfDayMinute": 0,
      "metricsEnabled": true, "earnsCoins": true, "coinCapPerDay": 1, "requiredInStack": true]
    let parent = try await engine.call("createBoard", [input]) as! [String: Any]
    let id = parent["boardId"] as! String
    input["commandId"] = UUID().uuidString.lowercased(); input["title"] = "Stretch"
    input["anchor"] = ["kind": "board", "relation": "after", "boardId": id]
    _ = try await engine.call("createBoard", [input])
    let before: DailySnapshot = try await engine.decode("getDailyToggleSnapshot", [id])
    _ = try await engine.call("toggleDailyCheckIn", [["commandId": UUID().uuidString.lowercased(), "boardId": id,
      "logicalDate": before.logicalDate, "expectedCheckIns": try before.expectedCheckIns.jsonObject()]])
    let cards: [HomeCard] = try await engine.decode("getHomeBoardProjection")
    XCTAssertEqual(cards.count, 2)
    let summary: BoardSummary = try await engine.decode("getBoardSummary", [id])
    XCTAssertEqual(summary.currentWeekCount, 1)
    let history: HistoryPage = try await engine.decode("getGroupedCheckInHistory", [id])
    XCTAssertEqual(history.months.first?.days.first?.checkIns.count, 1)
    let _: BoardDependencies = try await engine.decode("getBoardDependentCounts", [id])
    let _: Heatmap = try await engine.decode("getBoardHeatmap", [id])
    let stacks: StackList = try await engine.decode("getStackListSnapshot")
    XCTAssertEqual(stacks.stacks.first?.members.count, 2)
    let detail: StackDetail = try await engine.decode("getStackDetailSnapshot", [id])
    XCTAssertNotNil(detail.stack.heatmap)
    let _: CoinPage = try await engine.decode("getCoinHistoryPage")
  }

  func testRewardClaimScreenUsesCurrentRevisionAndCoinEvidence() async throws {
    let engine = try EngineHost(databasePath: ":memory:")
    _ = try await engine.call("initialize")
    _ = try await engine.call("createReward", [["commandId": UUID().uuidString.lowercased(), "title": "Coffee", "costCoins": 5,
      "symbol": "cup.and.saucer.fill", "accentHex": "#78D98B"]])
    let rewards: [Reward] = try await engine.decode("listRewards")
    let reward = try XCTUnwrap(rewards.first)
    let preview: RewardPreview = try await engine.decode("getRewardClaimPreview", [reward.id])
    XCTAssertNil(preview.balanceAfterClaim)
    XCTAssertEqual(preview.balance, 0)
    let totals: CoinTotals = try await engine.decode("getCoinTotals")
    XCTAssertEqual(totals.balance, 0)
  }
}
