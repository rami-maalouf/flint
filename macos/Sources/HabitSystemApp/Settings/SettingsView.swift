import AppKit
import SwiftUI
import UniformTypeIdentifiers
import HabitEngine

struct AppPreferences: Decodable {
  var wakeMinute: Int
  var lunchMinute: Int
  var dinnerMinute: Int
  var sleepMinute: Int
  var iCloudSyncEnabled: Bool
}

struct SyncSummary: Decodable {
  let enabled: Bool
  let pendingChanges: Int
  let incoming: Incoming
  let lastSuccessAtUtc: Double?
  struct Incoming: Decodable { let pending: Int; let blocked: Int; let quarantined: Int }
}

struct SettingsView: View {
  @ObservedObject var model: AppModel
  @State private var settings: AppPreferences?
  @State private var summary: SyncSummary?
  @State private var notification: NotificationStatus?
  @State private var busy = false
  @State private var status: String?
  @State private var importDraft: [String: Any]?
  @State private var importPreview: ImportPreview?
  @State private var importCommand = UUID().uuidString.lowercased()
  @State private var showImport = false
  @State private var notificationDiagnostics: String?

  var body: some View {
    Form {
      if model.runtimePolicy.requiresQAStore {
        Section("Notification acceptance testing") {
          Text("This separate QA app uses its own local store and notification permission. iCloud and desktop widget publishing are disabled.")
            .font(.callout).foregroundStyle(.secondary)
          LabeledContent("App identity", value: Bundle.main.bundleIdentifier ?? "Unknown")
          Text(model.databasePath).font(.caption).textSelection(.enabled)
          if !model.runtimePolicy.notificationQA {
            Text("Notification effects are disabled because this build has the wrong QA app identity.").foregroundStyle(.red)
          }
          if model.runtimePolicy.notificationQA {
            if let board = model.boards.first { LabeledContent("Preview habit", value: board.title) }
            Button("Preview Reminder Destination") { previewNotification(.newCheck) }
              .disabled(model.boards.isEmpty || model.sampleMode || model.loading)
            Button("Preview Missed Habit Destination") { previewNotification(.board) }
              .disabled(model.boards.isEmpty || model.sampleMode || model.loading)
            Text("These previews open the same destination as a notification tap. They do not schedule or send notifications, or request permission.")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      Section("Daily anchors") {
        Text("Habits anchored to these moments follow the same times on your phone and Mac.")
          .font(.callout).foregroundStyle(.secondary)
        if let settings {
          anchor("Wake up", preset: "wake", value: settings.wakeMinute)
          anchor("Lunch", preset: "lunch", value: settings.lunchMinute)
          anchor("Dinner", preset: "dinner", value: settings.dinnerMinute)
          anchor("Bedtime", preset: "sleep", value: settings.sleepMinute)
        }
      }
      Section("iCloud sync") {
        LabeledContent("iCloud environment", value: model.cloudEnvironment)
        Text("This must match your iPhone build. Development and Production iCloud keep separate data, even with the same Apple Account.")
          .font(.callout).foregroundStyle(.secondary)
        Toggle("Sync with iCloud", isOn: Binding(get: { settings?.iCloudSyncEnabled ?? false }, set: { enabled in
          Task { await updateSync(enabled) }
        })).disabled(model.sampleMode || busy || settings == nil)
        Text("Use the same Apple Account on your Mac and phone. Changes stay available offline and sync when connected.")
          .font(.callout).foregroundStyle(.secondary)
        if let syncStatus = model.syncStatus { Text(syncStatus).font(.callout).foregroundStyle(.secondary) }
        if let summary {
          LabeledContent("Waiting to upload", value: "\(summary.pendingChanges)")
          if let time = summary.lastSuccessAtUtc {
            LabeledContent("Last synced", value: Date(timeIntervalSince1970: time / 1000).formatted(date: .abbreviated, time: .shortened))
          }
          if summary.incoming.blocked + summary.incoming.quarantined > 0 {
            Text("\(summary.incoming.blocked + summary.incoming.quarantined) incoming changes need attention. Your local data has been retained.")
              .foregroundStyle(.orange)
          }
        }
        Button("Sync Now") { Task { await syncNow() } }
          .disabled(model.sampleMode || busy || settings?.iCloudSyncEnabled != true)
      }
      Section("Notifications") {
        LabeledContent("Permission", value: notification?.authorization.capitalized ?? "Checking")
        Text("Create reminders from a habit’s detail view. Never-miss-twice alerts use the same rules as the mobile app.")
          .font(.callout).foregroundStyle(.secondary)
        HStack {
          Button("Allow Notifications") { Task { await requestNotifications() } }
            .disabled(model.sampleMode || notification?.authorization == "granted" || busy)
          Button("Notification Settings") {
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
          }
        }
        if model.runtimePolicy.notificationQA {
          Button("Read Notification Inventory") { Task { await readNotificationDiagnostics() } }
            .disabled(model.sampleMode || busy || !model.ready)
          if let notificationDiagnostics {
            ScrollView {
              Text(notificationDiagnostics).font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.frame(height: 180)
            Button("Copy Notification Inventory") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(notificationDiagnostics, forType: .string)
            }
          }
        }
      }
      Section("Your data") {
        HStack {
          Button("Export Backup…") { Task { await exportBackup() } }
          Button("Import Backup or CSV…") { Task { await previewImport() } }
        }.disabled(busy || !model.ready || model.sampleMode)
        Text("JSON backups preserve habits, history, rewards and coin evidence. You can also import a Ripples CSV file.")
          .font(.callout).foregroundStyle(.secondary)
      }
      Section("Desktop widgets") {
        Text("Add Activity Grid, Weekly Focus or Today from the Mac widget gallery. Click a widget to open its habit.").font(.callout).foregroundStyle(.secondary)
        if let status = model.widgetStatus { Text(status).font(.callout).foregroundStyle(.secondary) }
      }
      Section("Explore") {
        Button(model.sampleMode ? "Return to My Habits" : "Explore Sample Habits") {
          Task { busy = true; await model.setSampleMode(!model.sampleMode); await load(); busy = false }
        }.disabled(busy)
        Text("Sample habits run in a separate temporary store. iCloud and notifications are disabled there. Leaving discards sample changes.")
          .font(.callout).foregroundStyle(.secondary)
      }
      if busy { ProgressView().controlSize(.small) }
      if let status { Text(status).font(.callout).textSelection(.enabled) }
      if let error = model.error { Text(error).foregroundStyle(.red).font(.callout).textSelection(.enabled) }
    }
    .formStyle(.grouped).frame(width: 570, height: 720)
    .task { await load() }
    .onChange(of: model.revision) { _, _ in Task { await load() } }
    .sheet(isPresented: $showImport) { importSheet }
  }

  private func previewNotification(_ kind: HabitNotificationSelection.Kind) {
    guard model.runtimePolicy.notificationQA, !model.sampleMode, !model.loading, let board = model.boards.first else { return }
    NSApplication.shared.keyWindow?.close()
    HabitNotificationInbox.shared.submit(HabitNotificationSelection(boardID: board.id, kind: kind))
  }

  private func anchor(_ title: String, preset: String, value: Int) -> some View {
    Picker(title, selection: Binding(get: { value }, set: { minute in
      Task {
        busy = true
        _ = await model.perform("setAnchorPresetMinute", ["preset": preset, "minute": minute])
        await load()
        busy = false
      }
    })) {
      ForEach(0..<96, id: \.self) { quarter in
        Text(minuteLabel(quarter * 15)).tag(quarter * 15)
      }
    }.disabled(busy)
  }

  private var importSheet: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Import backup").font(.title2.bold())
      Text("Review the contents before importing. Existing data is retained; compatible records are merged by the shared habit engine.")
      if let preview = importPreview {
        Grid(alignment: .leading, horizontalSpacing: 40, verticalSpacing: 8) {
          GridRow { Text("Habits"); Text("\(preview.boards)") }
          GridRow { Text("Check-ins"); Text("\(preview.checkIns)") }
          GridRow { Text("Reminders"); Text("\(preview.reminders)") }
          GridRow { Text("Rewards"); Text("\(preview.rewards)") }
          GridRow { Text("Habit actions"); Text("\(preview.habitActions)") }
          GridRow { Text("Coin records"); Text("\(preview.coinLedger)") }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      HStack {
        Button("Cancel", role: .cancel) { showImport = false }.keyboardShortcut(.cancelAction)
        Spacer()
        Button("Import") { Task { await confirmImport() } }.keyboardShortcut(.defaultAction).disabled(busy)
      }
    }.padding(28).frame(width: 460).interactiveDismissDisabled(busy)
  }

  private func load() async {
    guard model.ready else { return }
    do {
      settings = try await model.query("getAppSettings")
      summary = try await model.query("getSyncSummary")
      notification = try await model.query("notificationStatus")
    } catch { status = error.localizedDescription }
  }

  private func updateSync(_ enabled: Bool) async {
    busy = true
    defer { busy = false }
    await model.changeSyncEnabled(enabled)
    await load()
  }

  private func syncNow() async {
    await model.syncNow()
    await load()
  }

  private func requestNotifications() async {
    busy = true
    defer { busy = false }
    do {
      _ = try await model.engine?.call("requestNotificationAuthorization")
      _ = try await model.engine?.call("reconcileNotifications")
      await load()
    } catch { status = error.localizedDescription }
  }

  private func readNotificationDiagnostics() async {
    guard model.runtimePolicy.notificationQA, !model.sampleMode, let service = model.notifications?.service else { return }
    busy = true
    defer { busy = false }
    do {
      let authorization = try await service.handle(request: ["method": "authorization"])
      let pending = try await service.handle(request: ["method": "pending"])
      let presented = try await service.handle(request: ["method": "presented"])
      let evidence: [String: Any] = ["capturedAt": ISO8601DateFormatter().string(from: Date()),
        "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "databasePath": model.databasePath,
        "authorization": authorization, "pending": pending, "presentedIdentifiers": presented]
      let data = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
      notificationDiagnostics = String(decoding: data, as: UTF8.self)
    } catch { status = error.localizedDescription }
  }

  private func exportBackup() async {
    guard !model.sampleMode else { return }
    busy = true
    defer { busy = false }
    do {
      let backup: ExportBackup = try await model.query("export")
      let panel = NSSavePanel()
      panel.allowedContentTypes = [.json]
      panel.nameFieldStringValue = backup.filename
      guard await panel.begin() == .OK, let url = panel.url else { return }
      let accessing = url.startAccessingSecurityScopedResource()
      defer { if accessing { url.stopAccessingSecurityScopedResource() } }
      try backup.text.write(to: url, atomically: true, encoding: .utf8)
      status = "Backup saved."
    } catch { status = error.localizedDescription }
  }

  private func previewImport() async {
    guard !model.sampleMode else { return }
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.json, .commaSeparatedText]
    panel.allowsMultipleSelection = false
    guard await panel.begin() == .OK, let url = panel.url else { return }
    busy = true
    defer { busy = false }
    do {
      let accessing = url.startAccessingSecurityScopedResource()
      defer { if accessing { url.stopAccessingSecurityScopedResource() } }
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 50_000_000 else { status = "Choose a backup smaller than 50 MB."; return }
      let source = try String(contentsOf: url, encoding: .utf8)
      guard let result = try await model.engine?.call("previewImport", [source, url.pathExtension.lowercased() == "csv" ? "csv" : "json"]) as? [String: Any],
        let draft = result["draft"] as? [String: Any], let preview = result["preview"] else { return }
      importDraft = draft
      importPreview = try JSONDecoder().decode(ImportPreview.self, from: JSONSerialization.data(withJSONObject: preview))
      importCommand = UUID().uuidString.lowercased()
      model.error = nil
      showImport = true
    } catch { status = error.localizedDescription }
  }

  private func confirmImport() async {
    guard !model.sampleMode, let importDraft else { return }
    busy = true
    defer { busy = false }
    if await model.perform("importSnapshot", ["commandId": importCommand, "draft": importDraft]) {
      showImport = false
      status = "Import complete."
      await load()
    }
  }
}

private struct ExportBackup: Decodable { let text: String; let filename: String }
private struct ImportPreview: Decodable {
  let boards: Int; let checkIns: Int; let reminders: Int; let rewards: Int; let habitActions: Int; let coinLedger: Int
}
struct NotificationStatus: Decodable { let authorization: String; let remainingCapacity: Int }
