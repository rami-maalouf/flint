import AppKit
import Foundation
import HabitEngine

extension AppModel {
  func configureServices() async {
    guard let engine else { return }
    await notifications?.stopAndDrain()
    await synchronizer?.cancel()
    synchronizer = nil
    let isQA = ProcessInfo.processInfo.arguments.contains("--database-path")
    let effects = !sampleMode && !isQA
    let coordinator = NotificationCoordinator(engine: engine, effectsEnabled: effects)
    notifications = coordinator
    coordinator.setForeground(applicationActive)
    await coordinator.start()
    if effects && CloudKitAdapter.isSupportedBuild {
      await CloudKitAdapter.configureCloudKit(on: engine)
      let sync = SyncCoordinator(engine: engine)
      sync.onOutcome = { [weak self] outcome in
        guard let self else { return }
        self.syncStatus = self.syncLabel(outcome.status)
        if outcome.localChanged {
          Task { await self.refresh(); self.notifications?.requestReconciliation() }
        }
      }
      synchronizer = sync
      await sync.setActive(applicationActive)
    } else {
      syncStatus = sampleMode ? "Sync is off in sample mode." : isQA ? "Sync is off for this test store." : "iCloud needs an app signed with the CloudKit provisioning profile."
    }
  }

  func resumeSyncAfterInteraction() {
    syncResume?.cancel()
    syncResume = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
      self?.synchronizer?.request()
    }
  }

  func periodicRefresh() async {
    guard !loading else { return }
    await refresh()
    notifications?.requestReconciliation()
    synchronizer?.request()
  }

  func setActive(_ active: Bool) async {
    applicationActive = active
    notifications?.setForeground(active)
    await synchronizer?.setActive(active)
    if active && !loading { await refresh() }
  }

  func changeSyncEnabled(_ enabled: Bool) async {
    guard !sampleMode else { return }
    do {
      if let synchronizer {
        try await synchronizer.setEnabled(enabled)
      } else {
        if enabled { error = syncStatus; return }
        _ = await perform("setICloudSyncEnabled", ["enabled": false])
      }
      await refresh()
      if enabled { synchronizer?.request() }
    } catch { self.error = error.localizedDescription }
  }

  func syncNow() async {
    guard let synchronizer else { error = syncStatus; return }
    syncStatus = "Syncing…"
    synchronizer.request()
  }

  func setSampleMode(_ enabled: Bool) async {
    guard enabled != sampleMode, !loading else { return }
    loading = true
    showNewHabit = false
    syncResume?.cancel()
    await synchronizer?.cancel()
    await notifications?.stopAndDrain()
    defer { loading = false }
    do {
      if enabled {
        let temporary = try await Task.detached { try EngineHost(databasePath: ":memory:") }.value
        _ = try await temporary.call("initializeSample")
        realEngine = engine
        engine = temporary
      } else {
        guard let realEngine else { return }
        engine = realEngine
        self.realEngine = nil
      }
      sampleMode = enabled
      pendingToggle = nil
      notificationBoardID = nil
      section = .today
      catalog = try await query("catalog")
      try await reload()
      await configureServices()
    } catch {
      self.error = error.localizedDescription
      await configureServices()
    }
  }

  private func syncLabel(_ value: String) -> String {
    switch value {
    case "up_to_date": return "Up to date."
    case "idle": return "iCloud sync is off."
    case "signed_out": return "Sign in to your Apple Account in System Settings to sync."
    case "offline": return "Waiting for a connection. Your changes are saved on this Mac."
    case "needs_attention": return "Sync needs attention. Check your Apple Account and try again. Your local data is retained."
    default: return value.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }
}
