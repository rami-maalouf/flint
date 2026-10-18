import SwiftUI

struct ContentView: View {
  @ObservedObject var model: AppModel
  var body: some View {
    Group {
      if model.ready {
        NavigationSplitView {
          List(AppSection.allCases, selection: $model.section) { section in
            Label(section.rawValue, systemImage: section.symbol).tag(section)
          }
          .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 240)
          .safeAreaInset(edge: .bottom) {
            HStack { Image(systemName: "circle.grid.2x2.fill").foregroundStyle(.orange); Text("\(model.totals.balance) coins").fontWeight(.medium); Spacer() }.padding()
          }
        } detail: {
          NavigationStack {
            Group {
              switch model.section ?? .today {
              case .today: TodayView(model: model)
              case .habits: HabitsView(model: model)
              case .stacks: StacksView(model: model)
              case .coins: CoinsView(model: model)
              case .rewards: RewardsView(model: model)
              case .history: HistoryView(model: model)
              }
            }
            .navigationTitle((model.section ?? .today).rawValue)
            .navigationDestination(isPresented: Binding(get: { model.notificationBoardID != nil }, set: { if !$0 { model.notificationBoardID = nil } })) {
              if let boardID = model.notificationBoardID { HabitDetailView(model: model, boardID: boardID) }
            }
          }.id(model.section?.rawValue ?? "Today")
        }.id(model.sampleMode)
      } else if model.loading {
        ProgressView("Opening your habits...").frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView {
          Label("Your habits could not open", systemImage: "exclamationmark.triangle")
        } description: { Text(model.error ?? "The local store could not be opened. Your data has not been reset.") }
        actions: { Button("Try Again") { Task { await model.start() } } }
      }
    }
    .disabled(model.loading)
    .overlay {
      if model.loading && model.ready {
        ZStack {
          Color(nsColor: .windowBackgroundColor).opacity(0.8)
          ProgressView("Opening habits…").padding(28).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
      }
    }
    .toolbar {
      if model.sampleMode {
        ToolbarItem(placement: .status) {
          Label("Sample mode", systemImage: "play.rectangle").foregroundStyle(.secondary)
            .help("Your personal habits are unchanged.")
        }
        ToolbarItem(placement: .primaryAction) {
          Button("Exit Sample") { Task { await model.setSampleMode(false) } }
        }
      }
    }
    .sheet(isPresented: $model.showNewHabit) { BoardEditor(model: model, board: nil) }
    .alert("Could not complete the action", isPresented: Binding(get: { model.error != nil && model.ready }, set: { if !$0 { model.error = nil } })) {
      Button("OK") { model.error = nil }
      Button("Refresh") { model.error = nil; Task { await model.refresh() } }
    } message: { Text(model.error ?? "") }
    .confirmationDialog("Remove this day's check-ins?", isPresented: Binding(get: { model.pendingToggle != nil }, set: { if !$0 { model.pendingToggle = nil } }), titleVisibility: .visible) {
      if let snapshot = model.pendingToggle {
        Button("Remove \(snapshot.checkInCount) check-in(s)", role: .destructive) { Task { await model.confirmToggle(snapshot) } }
      }
      Button("Cancel", role: .cancel) { model.pendingToggle = nil }
    } message: {
      if let snapshot = model.pendingToggle { Text("\(snapshot.boardTitle) on \(dateLabel(snapshot.logicalDate)). This removes \(snapshot.noteCount) note(s) and adjusts earned coins.") }
    }
  }
}

struct PageHeader: View {
  let title: String
  let subtitle: String
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.largeTitle.bold())
      Text(subtitle).font(.body).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
struct Metric: View {
  let title: String
  let value: String
  var body: some View {
    VStack(alignment: .leading, spacing: 5) { Text(value).font(.title2.weight(.semibold)).monospacedDigit(); Text(title).font(.caption).foregroundStyle(.secondary) }
      .frame(maxWidth: .infinity, alignment: .leading).padding(16).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
  }
}
struct HabitIcon: View {
  let symbol: String
  let color: Color
  var body: some View { Image(systemName: symbol).font(.title3).foregroundStyle(color).frame(width: 42, height: 42).background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12)) }
}
struct ActivityStrip: View {
  let values: [Int]
  let color: Color
  var body: some View {
    HStack(spacing: 4) {
      ForEach(Array(values.enumerated()), id: \.offset) { index, count in
        RoundedRectangle(cornerRadius: 3).fill(count > 0 ? color : Color.secondary.opacity(0.12)).frame(width: 11, height: 15).help("\(values.count - index - 1) days ago: \(count) check-ins")
      }
    }.accessibilityLabel("Activity in the last \(values.count) days")
  }
}
