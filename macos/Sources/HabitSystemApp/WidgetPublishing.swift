import Foundation
import HabitWidgetData
import WidgetKit

extension AppModel {
  func publishWidgets() {
    let args = ProcessInfo.processInfo.arguments
    guard !sampleMode, !isolatedStore || args.contains("--widget-preview"), let host = engine else { return }
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
    guard let url = pendingWidgetURL else { return }
    pendingWidgetURL = nil
    await openWidgetURL(url)
  }

  func openWidgetURL(_ url: URL) async {
    guard url.scheme == "habitsystem-mac", let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.first(where: { $0.name == "environment" })?.value == cloudEnvironment else { return }
    widgetLinkGeneration += 1
    let request = widgetLinkGeneration
    guard ready, !loading else { pendingWidgetURL = url; return }
    if sampleMode { await setSampleMode(false) }
    guard !sampleMode, widgetLinkGeneration == request else { return }
    notificationBoardID = nil
    section = .today
    if url.host == "habit" {
      let id = url.lastPathComponent
      guard UUID(uuidString: id) != nil else { return }
      do {
        let board: Board? = try await query("getBoard", [id])
        guard widgetLinkGeneration == request else { return }
        guard board != nil else { error = "This habit is no longer available. Choose another habit in Edit Widget."; return }
        notificationBoardID = id
      } catch { self.error = error.localizedDescription }
    }
  }
}
