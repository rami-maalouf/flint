import Foundation
import HabitEngine
import HabitWidgetData
import WidgetKit

extension AppModel {
  func publishWidgets() {
    let args = ProcessInfo.processInfo.arguments
    guard !runtimePolicy.requiresQAStore, !sampleMode, !isolatedStore || args.contains("--widget-preview"), let host = engine else { return }
    widgetPublication?.cancel()
    widgetPublication = Task { [weak self] in
      guard let self else { return }
      do {
        let snapshot: WidgetSnapshot = try await host.decode("getWidgetSnapshot", [self.cloudEnvironment])
        guard !Task.isCancelled, !self.sampleMode, self.engine === host,
          let url = WidgetSnapshotStore.url(environment: self.cloudEnvironment) else { return }
        try WidgetSnapshotStore.write(snapshot, to: url)
        self.widgetStatus = nil
        WidgetCenter.shared.reloadAllTimelines()
      } catch {
        // retain the last good snapshot; its expiry prevents stale today claims.
        self.widgetStatus = "Widgets could not refresh. Open the app again to retry."
      }
    }
  }

  func resumePendingWidgetLink() async {
    await resumePendingNavigation()
  }

  func openWidgetURL(_ url: URL) async {
    guard url.scheme == "habitsystem-mac", let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.first(where: { $0.name == "environment" })?.value == cloudEnvironment else { return }
    guard url.host == "today" || url.host == "habit" else { return }
    let boardID = url.host == "habit" ? url.lastPathComponent : nil
    guard boardID == nil || UUID(uuidString: boardID!) != nil else { return }
    queueNavigation(boardID: boardID, kind: .board, widgetURL: url)
    await resumePendingNavigation()
  }

  func connectNotificationInbox(_ inbox: HabitNotificationInbox, activate: (() -> Void)? = nil) {
    inbox.attach { [weak self] selection in
      guard let self, UUID(uuidString: selection.boardID) != nil else { return }
      self.queueNavigation(boardID: selection.boardID, kind: selection.kind)
      activate?()
      Task { await self.resumePendingNavigation() }
    }
  }

  func openNotification(_ selection: HabitNotificationSelection) async {
    guard UUID(uuidString: selection.boardID) != nil else { return }
    queueNavigation(boardID: selection.boardID, kind: selection.kind)
    await resumePendingNavigation()
  }

  private func queueNavigation(boardID: String?, kind: HabitNotificationSelection.Kind, widgetURL: URL? = nil) {
    navigationGeneration += 1
    pendingNavigation = PendingAppNavigation(generation: navigationGeneration, boardID: boardID, kind: kind, widgetURL: widgetURL)
  }

  func resumePendingNavigation() async {
    guard ready, !loading, let request = pendingNavigation else { return }
    pendingNavigation = nil
    if sampleMode { await setSampleMode(false) }
    guard !sampleMode, !loading, navigationGeneration == request.generation, let host = engine else { return }
    navigationDestination = nil
    section = .today
    showNewHabit = false
    pendingToggle = nil
    if let id = request.boardID {
      do {
        let board: Board? = try await query("getBoard", [id])
        guard navigationGeneration == request.generation, engine === host, !loading, !sampleMode else { return }
        guard let board else { error = "This habit is no longer available."; return }
        navigationDestination = HabitNavigationDestination(boardID: id, kind: board.archivedAt == nil ? request.kind : .board)
      } catch {
        if navigationGeneration == request.generation { self.error = error.localizedDescription }
      }
    }
  }
}
