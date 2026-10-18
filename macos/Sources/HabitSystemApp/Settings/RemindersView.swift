import SwiftUI

struct HabitReminder: Decodable, Identifiable {
  let id: String
  let weekdaysMask: Int
  let minuteOfDay: Int
  let message: String?
  let enabled: Bool
  let scheduleState: String
  let lastScheduleError: String?
  let mutationStamp: String
}

struct RemindersView: View {
  @ObservedObject var model: AppModel
  let board: Board
  @State private var reminders: [HabitReminder] = []
  @State private var editing: HabitReminder?
  @State private var showEditor = false
  @State private var removing: HabitReminder?
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Label("Reminders", systemImage: "bell").font(.headline)
        Spacer()
        Button("Add Reminder", systemImage: "plus") { editing = nil; showEditor = true }
          .disabled(board.archivedAt != nil || model.sampleMode)
      }
      if reminders.isEmpty {
        Text("Choose a time to bring this habit back to mind.").foregroundStyle(.secondary)
      }
      ForEach(reminders) { reminder in
        HStack(alignment: .top, spacing: 14) {
          Toggle("Enable reminder at \(minuteLabel(reminder.minuteOfDay))", isOn: Binding(get: { reminder.enabled }, set: { enabled in
            Task { _ = await model.perform("setReminderEnabled", ["reminderId": reminder.id, "enabled": enabled]) }
          })).labelsHidden().toggleStyle(.switch).disabled(board.archivedAt != nil || model.sampleMode)
          VStack(alignment: .leading, spacing: 3) {
            Text(minuteLabel(reminder.minuteOfDay)).font(.headline)
            Text(weekdayLabels(reminder.weekdaysMask)).font(.callout).foregroundStyle(.secondary)
            if let message = reminder.message, !message.isEmpty { Text(message).font(.callout) }
            if reminder.enabled && reminder.scheduleState != "scheduled" {
              Text(reminder.scheduleState == "denied" ? "Notifications are disabled in System Settings." : "Schedule: \(reminder.scheduleState)")
                .font(.caption).foregroundStyle(.orange)
            }
          }
          Spacer()
          Button("Edit") { editing = reminder; showEditor = true }.disabled(board.archivedAt != nil || model.sampleMode)
          Button("Delete", role: .destructive) { removing = reminder }.disabled(model.sampleMode)
        }.padding(.vertical, 4)
      }
      if let error { Text(error).foregroundStyle(.red) }
      Text("Never-miss-twice alerts are handled automatically for eligible daily habits when notifications are allowed.")
        .font(.caption).foregroundStyle(.secondary)
    }
    .task(id: model.revision) { await load() }
    .sheet(isPresented: $showEditor) { ReminderEditor(model: model, board: board, reminder: editing) }
    .confirmationDialog("Delete this reminder?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
      Button("Delete Reminder", role: .destructive) {
        if let removing { Task { _ = await model.perform("deleteReminder", ["reminderId": removing.id]) } }
        removing = nil
      }
      Button("Cancel", role: .cancel) { removing = nil }
    }
  }

  private func load() async {
    do { reminders = try await model.query("listBoardReminders", [board.id]); error = nil }
    catch { self.error = error.localizedDescription }
  }
}

private struct ReminderEditor: View {
  @ObservedObject var model: AppModel
  let board: Board
  let reminder: HabitReminder?
  @Environment(\.dismiss) private var dismiss
  @State private var mask: Int
  @State private var minute: Int
  @State private var message: String
  @State private var saving = false
  @State private var commandID = UUID().uuidString.lowercased()

  init(model: AppModel, board: Board, reminder: HabitReminder?) {
    self.model = model; self.board = board; self.reminder = reminder
    _mask = State(initialValue: reminder?.weekdaysMask ?? 127)
    _minute = State(initialValue: reminder?.minuteOfDay ?? 540)
    _message = State(initialValue: reminder?.message ?? "")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(reminder == nil ? "New reminder" : "Edit reminder").font(.title2.bold())
      Text(board.title).foregroundStyle(.secondary)
      Form {
        WallClockTimeField(title: "Time", minute: $minute)
        LabeledContent("Days") {
          HStack(spacing: 6) {
            ForEach(Array(dayNames.enumerated()), id: \.offset) { index, day in
              Toggle(day, isOn: Binding(get: { mask & (1 << index) != 0 }, set: { checked in
                if checked { mask |= 1 << index } else { mask &= ~(1 << index) }
              })).toggleStyle(.button).help(dayFullNames[index])
            }
          }
        }
        TextField("Message (optional)", text: $message, axis: .vertical).lineLimit(2...4)
      }
      if let error = model.error { Text(error).foregroundStyle(.red).font(.callout) }
      HStack {
        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Spacer()
        if saving { ProgressView().controlSize(.small) }
        Button("Save Reminder") { Task { await save() } }.keyboardShortcut(.defaultAction).disabled(mask == 0 || saving)
      }
    }.padding(28).frame(width: 520).interactiveDismissDisabled(saving)
      .onAppear { model.error = nil }
  }

  private func save() async {
    saving = true
    defer { saving = false }
    var input: [String: Any] = ["commandId": commandID, "weekdaysMask": mask, "minuteOfDay": minute, "message": message]
    if let reminder {
      input["reminderId"] = reminder.id
      input["expectedMutationStamp"] = reminder.mutationStamp
    } else { input["boardId"] = board.id; input["enabled"] = true }
    if await model.perform(reminder == nil ? "createReminder" : "updateReminder", input) { dismiss() }
  }
}

private let dayNames = ["M", "T", "W", "T", "F", "S", "S"]
private let dayFullNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
private func weekdayLabels(_ mask: Int) -> String {
  if mask == 127 { return "Every day" }
  return dayFullNames.enumerated().filter { mask & (1 << $0.offset) != 0 }.map { String($0.element.prefix(3)) }.joined(separator: ", ")
}
