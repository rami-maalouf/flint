import SwiftUI

struct CoinsView: View {
  @ObservedObject var model: AppModel
  @State private var items: [CoinItem] = []
  @State private var cursor: CoinCursor?
  @State private var loading = false
  @State private var failure: String?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageHeader(title: "Your progress adds up.", subtitle: "Coins record your habits, completed routines and rewards.")
        HStack(spacing: 12) {
          Metric(title: "Available", value: "\(model.totals.balance)")
          Metric(title: "Earned", value: "\(model.totals.earned)")
          Metric(title: "Spent", value: "\(model.totals.spent)")
        }
        Text("Coin history").font(.title2.bold())
        if let failure { Text(failure).foregroundStyle(.red); Button("Try Again") { Task { await load(reset: items.isEmpty) } } }
        if items.isEmpty && !loading { ContentUnavailableView("Your first coin is ahead", systemImage: "circle.grid.2x2", description: Text("Check in to a habit that earns coins. Your earnings and reward claims will appear here.")) }
        LazyVStack(spacing: 0) {
          ForEach(items) { item in
            HStack(spacing: 14) {
              Image(systemName: item.reference.kind == "reward" ? "gift" : item.reference.kind == "stack" ? "square.stack.3d.up" : "checkmark.circle")
                .font(.title3).foregroundStyle(item.delta > 0 ? Color.green : Color.secondary).frame(width: 30)
              VStack(alignment: .leading, spacing: 5) {
                Text(item.reference.title ?? (item.reference.kind == "stack" ? "Past routine" : "Past habit")).fontWeight(.medium)
                Text("\(dateLabel(item.logicalDate)) · \(entryLabel(item))").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Text(item.delta > 0 ? "+\(item.delta)" : "\(item.delta)").font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(item.delta > 0 ? Color.green : Color.primary)
            }.padding(.vertical, 14)
            Divider()
          }
        }
        if loading { ProgressView() }
        if cursor != nil { Button("Load Older Entries") { Task { await load(reset: false) } }.disabled(loading) }
      }.padding(28).frame(maxWidth: 1000).frame(maxWidth: .infinity)
    }.task(id: model.revision) { await load(reset: true) }
  }
  func entryLabel(_ item: CoinItem) -> String {
    switch item.kind { case "claim": "Reward claimed"; case "run_bonus": "Stack bonus"; case "check": "Habit check-in"; case "reversal": "Check-in reversed"; default: item.adjustment == "cancellation" ? "Adjustment cancelled" : "Balance adjustment" }
  }
  func load(reset: Bool) async {
    guard !loading else { return }
    loading = true; defer { loading = false }
    do {
      var input: [String: Any] = ["limit": 50]
      if !reset, let cursor { input["before"] = try cursor.jsonObject() }
      let page: CoinPage = try await model.query("getCoinHistoryPage", [input])
      items = reset ? page.items : items + page.items; cursor = page.nextCursor; failure = nil
    } catch { failure = error.localizedDescription }
  }
}

struct HistoryView: View {
  @ObservedObject var model: AppModel
  @State private var entries: [Entry] = []
  @State private var boardFilter = "all"
  @State private var notesOnly = false
  @State private var search = ""
  @State private var selected: Entry?
  @State private var loading = true
  @State private var failure: String?
  @State private var limit = 100
  @State private var hasMore = false
  struct Entry: Identifiable { var id: String { check.id }; let board: Board; let check: CheckIn }
  var visible: [Entry] { entries.filter { (boardFilter == "all" || $0.board.id == boardFilter) && (!notesOnly || $0.check.note != nil) && (search.isEmpty || $0.board.title.localizedCaseInsensitiveContains(search) || $0.check.note?.localizedCaseInsensitiveContains(search) == true) } }
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Picker("Habit", selection: $boardFilter) {
          Text("All habits").tag("all")
          ForEach(model.boards + model.archivedBoards) { Text($0.title).tag($0.id) }
        }.frame(maxWidth: 320)
        Spacer()
        Toggle("Notes only", isOn: $notesOnly).toggleStyle(.checkbox)
      }.padding(20)
      if let failure { Text(failure).foregroundStyle(.red); Button("Try Again") { Task { await load() } } }
      if loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
      else if visible.isEmpty { ContentUnavailableView("No history to show", systemImage: "clock.arrow.circlepath", description: Text("Check-ins and notes from your habits will appear here.")) }
      else {
        List {
          ForEach(visible) { entry in
            Button { selected = entry } label: {
              VStack(alignment: .leading, spacing: 0) {
                HStack { Text(entry.board.title).font(.caption.weight(.semibold)).foregroundStyle(entry.board.color); if entry.board.archivedAt != nil { Text("Archived").font(.caption).foregroundStyle(.secondary) } }
                CheckInRow(check: entry.check, board: entry.board)
              }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(entry.board.archivedAt != nil)
          }
          if hasMore { Button("Load Older History") { limit += 100; Task { await load() } } }
        }.listStyle(.inset)
      }
    }.searchable(text: $search, prompt: "Find a habit or note")
    .task(id: "\(model.revision)-\(notesOnly)") { await load() }
    .sheet(item: $selected) { CheckInEditor(model: model, board: $0.board, check: $0.check) }
  }
  func load() async {
    do {
      var result: [Entry] = []
      var more = false
      for board in model.boards + model.archivedBoards {
        if notesOnly {
          let journal: [CheckIn] = try await model.query("getJournalTimeline", [board.id])
          result += journal.map { Entry(board: board, check: $0) }
        } else {
          let history: HistoryPage = try await model.query("getGroupedCheckInHistory", [board.id, ["limit": limit]])
          more = more || history.hasMore
          result += history.months.flatMap(\.days).flatMap(\.checkIns).map { Entry(board: board, check: $0) }
        }
      }
      entries = result.sorted { $0.check.logicalDate == $1.check.logicalDate ? ($0.check.occurredAtUtc ?? 0) > ($1.check.occurredAtUtc ?? 0) : $0.check.logicalDate > $1.check.logicalDate }
      hasMore = more; failure = nil
    } catch { failure = error.localizedDescription }
    loading = false
  }
}
