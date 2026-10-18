import SwiftUI
import Charts

struct HabitDetailView: View {
  @ObservedObject var model: AppModel
  let boardID: String
  @Environment(\.dismiss) private var dismiss
  @State private var board: Board?
  @State private var summary: BoardSummary?
  @State private var history: HistoryPage?
  @State private var journalEntries: [CheckIn] = []
  @State private var heatmap: Heatmap?
  @State private var edit = false
  @State private var log = false
  @State private var logDate: String?
  @State private var selectedCheck: CheckIn?
  @State private var deleting: BoardDependencies?
  @State private var failure: String?
  @State private var tab = "Overview"
  @State private var historyLimit = 100
  var body: some View {
    Group {
      if let board {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            let todayCount = heatmap?.weeks.flatMap(\.days).first(where: { $0.isToday })?.count ?? 0
            HabitHero(board: board, subtitle: subtitle(board), today: summary?.today,
              checked: todayCount > 0, checkIns: todayCount,
              primaryAction: {
                if board.archivedAt != nil { Task { await model.perform("restoreBoard", ["boardId": board.id]) } }
                else if board.kind == "daily" { Task { await model.toggle(board) } }
                else { logDate = nil; log = true }
              }, noteAction: { logDate = nil; log = true })
            Picker("Section", selection: $tab) {
              ForEach(["Overview", "History", "Journal", "Reminders"], id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.segmented).labelsHidden()
            if let failure { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red); Button("Try Again") { Task { await load() } } }
            switch tab {
            case "History": historyContent(board, journal: false)
            case "Journal": historyContent(board, journal: true)
            case "Reminders": RemindersView(model: model, board: board)
            default:
              if let days = heatmap?.weeks.last?.days {
                HabitWeekView(board: board, days: days) { date in logDate = date; log = true }
              }
              if let summary { HabitProgressMetrics(summary: summary, board: board) }
              if let heatmap {
                HabitYearView(board: board, heatmap: heatmap)
              }
              if board.metricsEnabled { AnalyticsView(model: model, board: board, summary: summary) }
              else { Text("Analytics are turned off for this habit. You can enable them in Edit Habit.").foregroundStyle(.secondary) }
            }
          }.padding(24).frame(maxWidth: 1120).frame(maxWidth: .infinity)
        }
        .toolbar {
          if board.archivedAt == nil { Button("Edit Habit") { edit = true } }
          Menu {
            Button(board.archivedAt == nil ? "Archive Habit" : "Restore Habit") { Task { await model.perform(board.archivedAt == nil ? "archiveBoard" : "restoreBoard", ["boardId": board.id]) } }
            Divider()
            Button("Delete Habit...", role: .destructive) { Task {
              do { deleting = try await model.query("getBoardDependentCounts", [board.id]) } catch { failure = error.localizedDescription }
            } }
          } label: { Image(systemName: "ellipsis.circle") }
        }
        .sheet(isPresented: $edit) { BoardEditor(model: model, board: board) }
        .sheet(isPresented: $log) { CheckInEditor(model: model, board: board, check: nil, initialLogicalDate: logDate) }
        .sheet(item: $selectedCheck) { CheckInEditor(model: model, board: board, check: $0) }
        .confirmationDialog("Delete \(board.title)?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
          Button("Delete Habit", role: .destructive) { Task { if await model.perform("deleteBoard", ["boardId": board.id]) { dismiss() } } }
          Button("Cancel", role: .cancel) { deleting = nil }
        } message: {
          if let deleting { Text("This removes \(deleting.checkIns) check-ins, \(deleting.notes) notes and \(deleting.reminders) reminders. \(deleting.anchoredBoards) linked habit(s) will lose this anchor. Earned coins may be adjusted. This cannot be undone.") }
        }
      } else if let failure {
        ContentUnavailableView { Label("Habit unavailable", systemImage: "exclamationmark.triangle") } description: { Text(failure) } actions: { Button("Try Again") { Task { await load() } } }
      } else { ProgressView() }
    }
    .navigationTitle(board?.title ?? "Habit")
    .task(id: model.revision) { await load() }
  }
  func subtitle(_ board: Board) -> String {
    var text = board.kind == "daily" ? "Daily habit" : "Count habit"
    if let kind = board.anchorKind {
      let cue = kind == "board" ? (model.boards + model.archivedBoards).first(where: { $0.id == board.anchorBoardId })?.title ?? "linked habit" : kind == "preset" ? board.anchorPreset ?? "daily event" : board.anchorText ?? "cue"
      text += " · \(board.anchorRelation?.capitalized ?? "After") \(cue)"
    }
    if let minute = board.usualTimeMinute { text += " · \(minuteLabel(minute))" }
    return text
  }
  @ViewBuilder func historyContent(_ board: Board, journal: Bool) -> some View {
    if let history {
      let checks = journal ? journalEntries : history.months.flatMap(\.days).flatMap(\.checkIns)
      if checks.isEmpty { ContentUnavailableView(journal ? "No notes yet" : "No check-ins yet", systemImage: journal ? "book" : "calendar", description: Text(journal ? "Add a note to a check-in to keep a journal." : "Your history starts with a check-in.")) }
      else {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(checks) { check in
            Button { selectedCheck = check } label: { CheckInRow(check: check, board: board) }.buttonStyle(.plain).disabled(board.archivedAt != nil)
            Divider()
          }
          if history.hasMore && !journal { Button("Load Older Check-ins") { historyLimit += 100; Task { await load() } }.padding(.top, 12) }
        }
      }
    } else { ProgressView() }
  }
  func load() async {
    do {
      board = try await model.query("getBoard", [boardID])
      summary = try await model.query("getBoardSummary", [boardID])
      history = try await model.query("getGroupedCheckInHistory", [boardID, ["limit": historyLimit]])
      journalEntries = try await model.query("getJournalTimeline", [boardID])
      heatmap = try await model.query("getBoardHeatmap", [boardID])
      failure = nil
    } catch { failure = error.localizedDescription }
  }
}

struct CheckInRow: View {
  let check: CheckIn
  let board: Board
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "checkmark.circle.fill").foregroundStyle(board.color).padding(.top, 3)
      VStack(alignment: .leading, spacing: 5) {
        HStack { Text(dateLabel(check.logicalDate)).fontWeight(.medium); if let time = check.occurredAtUtc { Text(Date(timeIntervalSince1970: time / 1000).formatted(date: .omitted, time: .shortened)).foregroundStyle(.secondary) } }
        if let note = check.note { Text(note).foregroundStyle(.secondary).lineLimit(4) }
      }
      Spacer(minLength: 10)
      if let amount = check.amount { Text("\(amount.formatted()) \(board.amountUnit ?? "")").monospacedDigit() }
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14).contentShape(Rectangle())
  }
}

struct CheckInEditor: View {
  @ObservedObject var model: AppModel
  let board: Board
  let check: CheckIn?
  var initialLogicalDate: String? = nil
  @Environment(\.dismiss) private var dismiss
  @State private var date = Date()
  @State private var time = Date()
  @State private var amount = "1"
  @State private var note = ""
  @State private var saving = false
  @State private var deleting = false
  @State private var loadedCheck: CheckIn?
  @State private var resolvedDate: String?
  @State private var occurrenceEdited = false
  @State private var amountEdited = false
  @State private var failure: String?
  private var resolvingDate: Bool { check == nil && board.kind == "daily" && resolvedDate != logicalDate(date) }
  private var effectiveCheck: CheckIn? { check ?? (resolvingDate ? nil : loadedCheck) }
  var body: some View {
    VStack(spacing: 0) {
      HStack { VStack(alignment: .leading, spacing: 5) { Text(effectiveCheck == nil ? "Log Check-in" : "Edit Check-in").font(.title2.bold()); Text(board.title).foregroundStyle(.secondary) }; Spacer() }.padding(24)
      Form {
        if check == nil && loadedCheck != nil { Text("This day is already checked. You are editing its existing note.").font(.callout).foregroundStyle(.secondary) }
        DatePicker("Habit date", selection: $date, in: ...Date(), displayedComponents: .date)
        if board.tracksTime { DatePicker("Time occurred", selection: Binding(get: { time }, set: { time = $0; occurrenceEdited = true }), displayedComponents: [.date, .hourAndMinute]) }
        if board.tracksAmount { TextField("Amount\(board.amountUnit.map { " (\($0))" } ?? "")", text: Binding(get: { amount }, set: { amount = $0; amountEdited = true })) }
        Section("Note") { TextEditor(text: $note).frame(minHeight: 130).font(.body).accessibilityLabel("Check-in note") }
        if resolvingDate { ProgressView("Checking this day…").controlSize(.small) }
        if let failure { Text(failure).foregroundStyle(.red); if resolvingDate { Button("Retry") { Task { await loadDailyCheck() } } } }
      }.formStyle(.grouped)
      HStack {
        if effectiveCheck != nil { Button("Delete", role: .destructive) { deleting = true } }
        Spacer()
        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button(saving ? "Saving..." : "Save Check-in") { Task { await save() } }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(saving || resolvingDate)
      }.padding(20)
    }.frame(width: 500, height: 480)
    .onAppear {
      if let check { date = parseDate(check.logicalDate); time = Date(timeIntervalSince1970: (check.occurredAtUtc ?? Date().timeIntervalSince1970 * 1000) / 1000); note = check.note ?? ""; amount = check.amount.map { editableNumber($0) } ?? "" }
      else { date = parseDate(initialLogicalDate ?? model.cards.first(where: { $0.id == board.id })?.today ?? logicalDate(Date())); amount = editableNumber(board.quickAmount) }
    }
    .task(id: logicalDate(date)) { await loadDailyCheck() }
    .confirmationDialog("Delete this check-in?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete Check-in", role: .destructive) { Task {
        guard let check = effectiveCheck else { return }
        if await model.perform("removeCheckIn", ["checkInId": check.id, "expectedMutationStamp": check.mutationStamp]) { dismiss() }
        else { failure = model.error; model.error = nil }
      } }
    } message: { Text("Its note and amount will be removed. Earned coins may be adjusted.") }
  }
  func save() async {
    guard !saving, !resolvingDate else { return }
    saving = true; defer { saving = false }
    var input: [String: Any] = ["logicalDate": logicalDate(date), "note": note]
    if board.tracksAmount && (effectiveCheck == nil || amountEdited) {
      guard let amount = parseEditableNumber(amount), amount > 0 else { failure = "Enter a valid amount."; return }
      input["amount"] = amount
    }
    if board.tracksTime && (effectiveCheck == nil || occurrenceEdited) { input["occurredAtUtc"] = Int64(time.timeIntervalSince1970 * 1000) }
    if let check = effectiveCheck { input["checkInId"] = check.id; input["expectedMutationStamp"] = check.mutationStamp }
    else { input["boardId"] = board.id; input["source"] = "app" }
    do {
      let value = try await model.mutate(effectiveCheck == nil ? "createCheckIn" : "updateCheckIn", input)
      if effectiveCheck == nil, let result = value as? [String: Any], result["created"] as? Bool == false {
        failure = "This day was checked elsewhere while you were editing. Your note has not overwritten it. Close this sheet and review the existing check-in in History."
      } else { dismiss() }
    } catch { failure = error.localizedDescription }
  }
  func loadDailyCheck() async {
    guard check == nil, board.kind == "daily" else { return }
    let selectedDate = logicalDate(date)
    resolvedDate = nil
    do {
      let existing: CheckIn? = try await model.query("getLatestCheckInForDate", [board.id, selectedDate])
      guard selectedDate == logicalDate(date) else { return }
      if existing?.id != loadedCheck?.id { note = existing?.note ?? "" }
      loadedCheck = existing
      resolvedDate = selectedDate
    } catch { failure = error.localizedDescription }
  }
}

struct AnalyticsView: View {
  @ObservedObject var model: AppModel
  let board: Board
  let summary: BoardSummary?
  @Environment(\.colorScheme) private var colorScheme
  private var accent: Color { habitAccent(board, colorScheme) }
  @State private var year = Calendar.current.component(.year, from: Date())
  @State private var timeline: Timeline?
  @State private var weekdays: Weekdays?
  @State private var comparison: Comparison?
  @State private var consistency: [Consistency]?
  @State private var streaks: Streaks?
  @State private var failure: String?
  struct Weekdays: Decodable { let weekdayCounts: [Int]; let workdayPercent: Double?; let weekendPercent: Double?; let direction: String }
  struct Comparison: Decodable { let previousYear: Int; let selected: [Int?]; let previous: [Int] }
  struct Streaks: Decodable {
    let allTimeLongest: Int; let spans: [Span]
    struct Span: Decodable, Identifiable { var id: String { startDate }; let startDate: String; let endDate: String; let length: Int }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 5) {
          Text("Patterns over time").font(.title2.weight(.semibold))
          Text("A wider view of the rhythm you are building.").font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
        Stepper("\(String(year))", value: $year, in: 1900...Calendar.current.component(.year, from: Date())).frame(width: 132)
      }.padding(.top, 8)
      if let failure { Text(failure).foregroundStyle(.red); Button("Retry Analytics") { Task { await load() } } }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
        if let timeline {
          InsightCard(title: "Monthly rhythm", subtitle: "Check-ins across \(year)") {
            Chart(Array(timeline.months.enumerated()), id: \.offset) { index, count in
              BarMark(x: .value("Month", Calendar.current.shortMonthSymbols[index]), y: .value("Check-ins", count))
                .foregroundStyle(accent.gradient).cornerRadius(3)
            }.chartXAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
              .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in AxisGridLine().foregroundStyle(.secondary.opacity(0.1)); AxisValueLabel().font(.caption2) } }
              .frame(height: 165)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("Check-ins by month")
              .accessibilityValue(timeline.months.enumerated().map { "\(Calendar.current.monthSymbols[$0.offset]): \($0.element)" }.joined(separator: ". "))
          }
        }
        if let comparison {
          InsightCard(title: "Year on year", subtitle: "Your activity alongside \(comparison.previousYear)") {
            Chart {
              ForEach(0..<12, id: \.self) { index in
                LineMark(x: .value("Month", Calendar.current.shortMonthSymbols[index]), y: .value("Check-ins", comparison.previous[index]), series: .value("Year", String(comparison.previousYear)))
                  .foregroundStyle(Color.secondary.opacity(0.45)).lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                if let count = comparison.selected[index] {
                  LineMark(x: .value("Month", Calendar.current.shortMonthSymbols[index]), y: .value("Check-ins", count), series: .value("Year", String(year)))
                    .foregroundStyle(accent).lineStyle(StrokeStyle(lineWidth: 2.5)).symbol(.circle).symbolSize(16)
                }
              }
            }.chartXAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
              .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in AxisGridLine().foregroundStyle(.secondary.opacity(0.1)); AxisValueLabel().font(.caption2) } }
              .frame(height: 139)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("Year comparison")
              .accessibilityValue((0..<12).map { "\(Calendar.current.monthSymbols[$0]): \(comparison.selected[$0].map(String.init) ?? "not available") this year, \(comparison.previous[$0]) last year" }.joined(separator: ". "))
            HStack(spacing: 14) {
              Label(String(year), systemImage: "circle.fill").foregroundStyle(accent)
              Label(String(comparison.previousYear), systemImage: "minus").foregroundStyle(.secondary)
            }.font(.caption2)
          }
        }
        if let weekdays {
          InsightCard(title: "Days you come back to", subtitle: "Check-ins by weekday · past 365 days") {
            Chart(Array(weekdays.weekdayCounts.enumerated()), id: \.offset) { index, count in
              BarMark(x: .value("Day", ["M", "T", "W", "Th", "F", "Sa", "Su"][index]), y: .value("Check-ins", count))
                .foregroundStyle(accent.opacity(index >= 5 ? 0.45 : 0.9).gradient).cornerRadius(4)
            }.chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in AxisGridLine().foregroundStyle(.secondary.opacity(0.1)); AxisValueLabel().font(.caption2) } }
              .frame(height: 139)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("Weekday patterns")
              .accessibilityValue(weekdays.weekdayCounts.enumerated().map { "\(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][$0.offset]): \($0.element)" }.joined(separator: ". "))
            Text("Weekdays \(Int(weekdays.workdayPercent ?? 0))% · Weekends \(Int(weekdays.weekendPercent ?? 0))%")
              .font(.caption2).foregroundStyle(.secondary)
          }
        }
        if let consistency {
          InsightCard(title: "Finding consistency", subtitle: "Share of eligible days checked each month") {
            Chart(consistency.filter { $0.percent != nil }) { month in
              AreaMark(x: .value("Month", month.month), y: .value("Percent", month.percent ?? 0))
                .foregroundStyle(LinearGradient(colors: [accent.opacity(0.24), accent.opacity(0.02)], startPoint: .top, endPoint: .bottom))
              LineMark(x: .value("Month", month.month), y: .value("Percent", month.percent ?? 0)).foregroundStyle(accent).lineStyle(StrokeStyle(lineWidth: 2))
            }.chartYScale(domain: 0...100)
              .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { value in AxisValueLabel { if let label = value.as(String.self) { Text(monthLabel(label)).font(.caption2) } } } }
              .chartYAxis { AxisMarks(position: .leading, values: [0, 50, 100]) { value in AxisGridLine().foregroundStyle(.secondary.opacity(0.1)); AxisValueLabel { if let value = value.as(Int.self) { Text("\(value)%").font(.caption2) } } } }
              .frame(height: 139)
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("Monthly consistency")
              .accessibilityValue(consistency.map { "\($0.month): \($0.percent.map { "\($0.formatted()) percent" } ?? "not available")" }.joined(separator: ". "))
            Text("\(summary?.consistencyPercent.map { "\($0.formatted(.number.precision(.fractionLength(0))))% consistency over the past 30 days" } ?? "Keep showing up. Patterns take time.")")
              .font(.caption2).foregroundStyle(.secondary)
          }
        }
      }
      if summary?.metricsReady == false {
        HStack(spacing: 12) {
          Image(systemName: "chart.xyaxis.line").font(.title3).foregroundStyle(accent)
          VStack(alignment: .leading, spacing: 4) {
            Text("Give your patterns a little time.").font(.callout.weight(.medium))
            Text("Consistency and weekday insights appear after seven eligible days.").font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
        }.habitSurface()
      }
      if let streaks {
        DisclosureGroup {
          VStack(alignment: .leading, spacing: 12) {
            if streaks.spans.isEmpty { Text("Your first check-in starts a streak.").foregroundStyle(.secondary).font(.callout) }
            ForEach(streaks.spans.reversed()) { span in
              HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 3).fill(accent.opacity(0.7)).frame(width: 3, height: 28)
                Text("\(dateLabel(span.startDate)) - \(dateLabel(span.endDate))").font(.callout)
                Spacer()
                Text("\(span.length) \(span.length == 1 ? "day" : "days")").font(.callout.weight(.medium)).monospacedDigit()
              }
            }
          }.padding(.top, 16)
        } label: {
          HStack {
            Label("Your streak history", systemImage: "flame").font(.headline)
            Spacer()
            Text("Best: \(streaks.allTimeLongest) \(streaks.allTimeLongest == 1 ? "day" : "days")").font(.caption).foregroundStyle(.secondary)
          }
        }.habitSurface()
      }
    }.task(id: "\(model.revision)-\(year)") { await load() }
  }
  private func monthLabel(_ month: String) -> String {
    guard let number = Int(month.suffix(2)), (1...12).contains(number) else { return month }
    return Calendar.current.shortMonthSymbols[number - 1]
  }
  func load() async {
    do {
      timeline = try await model.query("getTimelineAnalytics", [board.id, year])
      comparison = try await model.query("getYearComparison", [board.id, year])
      weekdays = try await model.query("getWeekdayAnalytics", [board.id])
      consistency = try await model.query("getConsistencyAnalytics", [board.id])
      streaks = try await model.query("getStreakAnalytics", [board.id])
      failure = nil
    } catch { failure = error.localizedDescription }
  }
}
