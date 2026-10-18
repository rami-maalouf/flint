import SwiftUI

struct StacksView: View {
  @ObservedObject var model: AppModel
  @State private var snapshot: StackList?
  @State private var failure: String?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageHeader(title: "Good habits belong together.", subtitle: "Link habits with before and after anchors to build a routine.")
        if let snapshot {
          if snapshot.stacks.isEmpty {
            ContentUnavailableView("Your routines start here", systemImage: "square.stack.3d.up", description: Text("Create a habit, then choose another habit as its anchor. Connected habits become a stack."))
          }
          ForEach(snapshot.stacks) { stack in
            NavigationLink { StackDetailView(model: model, rootID: stack.rootId) } label: {
              VStack(alignment: .leading, spacing: 16) {
                HStack {
                  Text(stack.members.first?.title ?? "Routine").font(.title3.bold())
                  Spacer()
                  Label(stack.currentRun.complete ? "Complete" : "\(stack.currentRun.checkedRequiredCount) of \(stack.currentRun.requiredCount)", systemImage: stack.currentRun.complete ? "checkmark.circle.fill" : "circle.dotted").foregroundStyle(stack.currentRun.complete ? Color.green : Color.secondary)
                }
                ForEach(stack.members) { member in
                  HStack(spacing: 10) {
                    Image(systemName: member.checked ? "checkmark.circle.fill" : member.symbol).foregroundStyle(Color(hex: member.accentHex)).frame(width: 22)
                    Text(member.title)
                    Spacer()
                    if !member.requiredInStack { Text("Optional").font(.caption).foregroundStyle(.secondary) }
                  }
                }
                Divider()
                HStack { Text("\(stack.completeRunsThisWeek) complete runs this week"); Spacer(); Text("\(stack.currentStreak)-day streak") }.font(.caption).foregroundStyle(.secondary)
              }.padding(20).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14)).contentShape(Rectangle())
            }.buttonStyle(.plain)
          }
        } else if let failure {
          Text(failure).foregroundStyle(.red); Button("Try Again") { Task { await load() } }
        } else { ProgressView() }
      }.padding(28).frame(maxWidth: 1000).frame(maxWidth: .infinity)
    }.task(id: model.revision) { await load() }
  }
  func load() async { do { snapshot = try await model.query("getStackListSnapshot"); failure = nil } catch { failure = error.localizedDescription } }
}

struct StackDetailView: View {
  @ObservedObject var model: AppModel
  let rootID: String
  @State private var snapshot: StackDetail?
  @State private var failure: String?
  @State private var logging: Board?
  @State private var loggingDate: String?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let stack = snapshot?.stack {
          PageHeader(title: stack.members.first?.title ?? "Routine", subtitle: "\(dateLabel(stack.currentRun.logicalDate)) · Complete required habits on the same day.")
          HStack(spacing: 12) {
            Metric(title: "Required habits", value: "\(stack.currentRun.checkedRequiredCount) / \(stack.currentRun.requiredCount)")
            Metric(title: "Current streak", value: "\(stack.currentStreak)")
            Metric(title: "Longest streak", value: "\(stack.longestStreak ?? 0)")
          }
          VStack(spacing: 0) {
            ForEach(stack.members) { member in
              HStack(spacing: 14) {
                NavigationLink { HabitDetailView(model: model, boardID: member.id) } label: {
                  HStack(spacing: 14) {
                    HabitIcon(symbol: member.symbol, color: Color(hex: member.accentHex))
                    VStack(alignment: .leading, spacing: 4) {
                      Text(member.title).font(.headline)
                      Text("\(member.requiredInStack ? "Required" : "Optional") · \(stack.memberWeeklyCounts?.first(where: { $0.boardId == member.id })?.checks ?? 0) this week").font(.caption).foregroundStyle(.secondary)
                    }
                  }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
                Button {
                  guard let board = model.boards.first(where: { $0.id == member.id }) else { return }
                  if board.kind == "daily" { Task { await model.toggle(board, date: stack.currentRun.logicalDate) } }
                  else { loggingDate = stack.currentRun.logicalDate; logging = board }
                } label: { Image(systemName: member.kind == "daily" ? (member.checked ? "checkmark.circle.fill" : "circle") : "plus.circle.fill").font(.title).foregroundStyle(Color(hex: member.accentHex)) }
                .buttonStyle(.plain).disabled(!member.eligible).accessibilityLabel("\(member.kind == "daily" ? (member.checked ? "Uncheck" : "Check") : "Log") \(member.title)")
              }.padding(16)
              if member.id != stack.members.last?.id { Divider().padding(.leading, 72) }
            }
          }.background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
          if let heatmap = stack.heatmap {
            Text("Year of routines").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 12, maximum: 14), spacing: 3)], spacing: 3) {
              ForEach(heatmap, id: \.logicalDate) { run in
                RoundedRectangle(cornerRadius: 2).fill(run.complete ? Color.green : run.checkedRequiredCount > 0 ? Color.green.opacity(0.4) : Color.secondary.opacity(run.available ? 0.15 : 0.05)).frame(height: 12)
                  .help("\(dateLabel(run.logicalDate)): \(run.checkedRequiredCount) of \(run.requiredCount)")
              }
            }
            Text("A complete run includes every required habit. Optional habits never block a run.").font(.caption).foregroundStyle(.secondary)
          }
        } else if let failure { Text(failure).foregroundStyle(.red); Button("Try Again") { Task { await load() } } } else { ProgressView() }
      }.padding(28).frame(maxWidth: 1000).frame(maxWidth: .infinity)
    }.navigationTitle("Stack").task(id: model.revision) { await load() }
    .sheet(item: $logging) { CheckInEditor(model: model, board: $0, check: nil, initialLogicalDate: loggingDate) }
  }
  func load() async { do { snapshot = try await model.query("getStackDetailSnapshot", [rootID]); failure = nil } catch { failure = error.localizedDescription } }
}
