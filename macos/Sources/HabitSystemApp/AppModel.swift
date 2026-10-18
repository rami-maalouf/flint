import Foundation
import SwiftUI
import HabitEngine

@MainActor
final class AppModel: ObservableObject {
  @Published var engine: EngineHost?
  @Published var ready = false
  @Published var loading = false
  @Published var error: String?
  @Published var revision = 0
  @Published var cards: [HomeCard] = []
  @Published var archivedBoards: [Board] = []
  @Published var totals = CoinTotals(earned: 0, spent: 0, balance: 0)
  @Published var catalog = Catalog(symbols: [], palette: [])
  @Published var pendingToggle: DailySnapshot?
  @Published var showNewHabit = false
  @Published var section: AppSection? = .today
  @Published var sampleMode = false
  @Published var syncStatus: String?
  @Published var notificationBoardID: String?
  var applicationActive = NSApplication.shared.isActive
  var realEngine: EngineHost?
  var notifications: NotificationCoordinator?
  var synchronizer: SyncCoordinator?
  var syncResume: Task<Void, Never>?
  var boards: [Board] { cards.map(\.board) }
  let cloudEnvironment = Bundle.main.object(forInfoDictionaryKey: "HabitSystemCloudEnvironment") as? String ?? "Development"
  let databasePath: String

  init() {
    let args = ProcessInfo.processInfo.arguments
    if let index = args.firstIndex(of: "--database-path"), args.indices.contains(index + 1) {
      databasePath = args[index + 1]
    } else {
      let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      databasePath = support.appendingPathComponent("Habit System/\(cloudEnvironment)/habit-system.db").path
    }
  }

  func start() async {
    guard !loading, !ready else { return }
    error = nil
    loading = true
    defer { loading = false }
    do {
      let path = databasePath
      let host = try await Task.detached { try EngineHost(databasePath: path) }.value
      _ = try await host.call("initialize")
      engine = host
      catalog = try await query("catalog")
      try await reload()
      ready = true
      await configureServices()
    } catch { self.error = error.localizedDescription }
  }

  func query<Value: Decodable>(_ method: String, _ args: [Any] = [], as: Value.Type = Value.self) async throws -> Value {
    guard let engine else { throw EngineFailure(code: "unavailable", message: "The habit store is not ready.", retryable: true) }
    if synchronizer?.status == "syncing" {
      await synchronizer?.cancel()
      resumeSyncAfterInteraction()
    }
    let result = try await engine.call(method, args)
    return try JSONDecoder().decode(Value.self, from: JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]))
  }

  @discardableResult
  func perform(_ method: String, _ input: [String: Any]) async -> Bool {
    do { _ = try await mutate(method, input); return true }
    catch { self.error = error.localizedDescription; return false }
  }

  func mutate(_ method: String, _ input: [String: Any]) async throws -> Any {
    guard !loading else { throw EngineFailure(code: "busy", message: "Wait for the habit store to finish opening.", retryable: true) }
    guard let engine else { throw EngineFailure(code: "unavailable", message: "The habit store is not ready.", retryable: true) }
    syncResume?.cancel()
    await synchronizer?.cancel()
    var payload = input
    if payload["commandId"] == nil { payload["commandId"] = UUID().uuidString.lowercased() }
    let result = try await engine.call(method, [payload])
    await refresh()
    notifications?.requestReconciliation()
    synchronizer?.request()
    return result
  }

  func reload() async throws {
    guard let host = engine else { return }
    if synchronizer?.status == "syncing" {
      await synchronizer?.cancel()
      resumeSyncAfterInteraction()
    }
    let nextCards: [HomeCard] = try await host.decode("getHomeBoardProjection")
    let nextArchived: [Board] = try await host.decode("listArchivedBoards")
    let nextTotals: CoinTotals = try await host.decode("getCoinTotals")
    guard engine === host else { return }
    cards = nextCards
    archivedBoards = nextArchived
    totals = nextTotals
    revision += 1
  }
  func refresh() async {
    guard engine != nil else { return }
    do { try await reload() } catch { self.error = error.localizedDescription }
  }
  func toggle(_ board: Board, date: String? = nil) async {
    do {
      var args: [Any] = [board.id]
      if let date { args.append(date) }
      let snapshot: DailySnapshot = try await query("getDailyToggleSnapshot", args)
      if snapshot.checked && (snapshot.noteCount > 0 || snapshot.checkInCount > 1) { pendingToggle = snapshot }
      else { await confirmToggle(snapshot) }
    } catch { self.error = error.localizedDescription }
  }
  func confirmToggle(_ snapshot: DailySnapshot) async {
    do {
      _ = await perform("toggleDailyCheckIn", ["boardId": snapshot.boardId, "logicalDate": snapshot.logicalDate,
        "expectedCheckIns": try snapshot.expectedCheckIns.jsonObject(), "source": "app"])
    } catch { self.error = error.localizedDescription }
    pendingToggle = nil
  }
}

enum AppSection: String, CaseIterable, Identifiable {
  case today = "Today", habits = "Habits", stacks = "Stacks", coins = "Coins", rewards = "Rewards", history = "History"
  var id: String { rawValue }
  var symbol: String {
    switch self { case .today: "sun.max"; case .habits: "square.grid.2x2"; case .stacks: "square.stack.3d.up"; case .coins: "circle.grid.2x2"; case .rewards: "gift"; case .history: "clock.arrow.circlepath" }
  }
}
