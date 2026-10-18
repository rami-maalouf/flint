import SwiftUI

struct TodayView: View {
  @ObservedObject var model: AppModel
  @State private var logging: Board?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageHeader(title: "A little progress, every day.", subtitle: Date().formatted(.dateTime.weekday(.wide).month(.wide).day()))
        if model.cards.isEmpty {
          ContentUnavailableView {
            Label("Make room for a good habit", systemImage: "leaf")
          } description: { Text("Start with something small. Your habits, progress and rewards live together here.") }
          actions: { Button("Create Your First Habit") { model.showNewHabit = true }.buttonStyle(.borderedProminent) }
          .frame(minHeight: 300)
        } else {
          HStack(spacing: 12) {
            Metric(title: "Daily habits checked", value: "\(model.cards.filter { $0.daily?.checkedToday == true }.count) / \(model.cards.filter { $0.board.kind == "daily" }.count)")
            Metric(title: "Coins available", value: "\(model.totals.balance)")
          }
          LazyVStack(spacing: 10) {
            ForEach(model.cards) { card in
              HStack(spacing: 14) {
                NavigationLink { HabitDetailView(model: model, boardID: card.id) } label: {
                  HStack(spacing: 14) {
                    HabitIcon(symbol: card.board.symbol, color: card.board.color)
                    VStack(alignment: .leading, spacing: 5) {
                      Text(card.board.title).font(.headline).foregroundStyle(.primary)
                      Text(card.daily.map { "\($0.completedThisWeek)/7 this week" + ($0.currentStreak.map { " · \($0)-day streak" } ?? "") } ?? "\(card.strip.last ?? 0) check-ins today").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                  }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                ViewThatFits { ActivityStrip(values: card.strip, color: card.board.color); EmptyView() }
                Button {
                  if card.board.kind == "daily" { Task { await model.toggle(card.board) } }
                  else { logging = card.board }
                } label: {
                  Image(systemName: card.board.kind == "daily" ? (card.daily?.checkedToday == true ? "checkmark.circle.fill" : "circle") : "plus.circle.fill")
                    .font(.system(size: 28)).foregroundStyle(card.daily?.checkedToday == true ? card.board.color : Color.accentColor)
                }.buttonStyle(.plain).help(card.board.kind == "daily" ? "Toggle \(card.board.title)" : "Log \(card.board.title)")
                .accessibilityLabel(card.board.kind == "daily" ? "\(card.daily?.checkedToday == true ? "Uncheck" : "Check") \(card.board.title)" : "Log \(card.board.title)")
              }.padding(16).background(card.board.usesTintedBackground ? card.board.color.opacity(0.08) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
            }
          }
        }
      }.padding(28).frame(maxWidth: 1000)
      .frame(maxWidth: .infinity)
    }
    .toolbar { Button { model.showNewHabit = true } label: { Label("New Habit", systemImage: "plus") } }
    .sheet(item: $logging) { CheckInEditor(model: model, board: $0, check: nil) }
  }
}

struct HabitsView: View {
  @ObservedObject var model: AppModel
  @State private var archived = false
  @State private var search = ""
  var selectedBoards: [Board] { (archived ? model.archivedBoards : model.boards).filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) } }
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Picker("Habits", selection: $archived) { Text("Active").tag(false); Text("Archived").tag(true) }.pickerStyle(.segmented).frame(width: 230)
        Spacer()
        Text("\(selectedBoards.count) habits").foregroundStyle(.secondary)
      }.padding(20)
      if selectedBoards.isEmpty {
        ContentUnavailableView(archived ? "No archived habits" : "No habits here yet", systemImage: "square.grid.2x2", description: Text(archived ? "Archived habits keep their history and can be restored." : "Create a habit to start tracking your progress."))
      } else {
        List {
          ForEach(selectedBoards) { board in
            NavigationLink {
              HabitDetailView(model: model, boardID: board.id)
            } label: {
              HStack(spacing: 14) {
                HabitIcon(symbol: board.symbol, color: board.color)
                VStack(alignment: .leading, spacing: 4) {
                  Text(board.title).font(.headline)
                  Text("\(board.kind == "daily" ? "Once a day" : "Count")\(board.earnsCoins ? " · Earns coins" : "")").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
              }.padding(.vertical, 6)
            }
            .contextMenu {
              Button(archived ? "Restore" : "Archive") { Task { await model.perform(archived ? "restoreBoard" : "archiveBoard", ["boardId": board.id]) } }
              if !archived {
                Button("Move to Top") { Task {
                  await model.perform("reorderBoard", ["boardId": board.id, "previousBoardId": NSNull(), "nextBoardId": model.boards.first(where: { $0.id != board.id })?.id as Any? ?? NSNull()])
                } }
              }
            }
          }
          .onMove { indices, destination in
            guard !archived, search.isEmpty, let index = indices.first else { return }
            var moved = selectedBoards; let board = moved.remove(at: index)
            let insertion = destination > index ? destination - 1 : destination
            moved.insert(board, at: insertion)
            Task { await model.perform("reorderBoard", ["boardId": board.id,
              "previousBoardId": insertion > 0 ? moved[insertion - 1].id as Any : NSNull(),
              "nextBoardId": insertion + 1 < moved.count ? moved[insertion + 1].id as Any : NSNull()]) }
          }
        }.listStyle(.inset)
      }
    }
    .searchable(text: $search, prompt: "Find a habit")
    .toolbar { Button { model.showNewHabit = true } label: { Label("New Habit", systemImage: "plus") } }
  }
}

struct BoardEditor: View {
  @ObservedObject var model: AppModel
  let board: Board?
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var kind = "daily"
  @State private var symbol = "checkmark.circle.fill"
  @State private var accent = "#78D98B"
  @State private var tinted = true
  @State private var tracksAmount = false
  @State private var amountUnit = ""
  @State private var quickAmount = "1"
  @State private var tracksTime = false
  @State private var dayStart = 0
  @State private var metrics = true
  @State private var earnsCoins = true
  @State private var coinCap = 1
  @State private var anchorKind = "none"
  @State private var relation = "after"
  @State private var anchorBoard = ""
  @State private var preset = "wake"
  @State private var anchorText = ""
  @State private var usualTime = false
  @State private var minute = 480
  @State private var required = true
  @State private var saving = false
  @State private var failure: String?
  var body: some View {
    VStack(spacing: 0) {
      HStack { Text(board == nil ? "New Habit" : "Edit Habit").font(.title2.bold()); Spacer() }.padding(24)
      Form {
        Section("Habit") {
          TextField("Name", text: $title).accessibilityIdentifier("habit-name")
          Picker("Tracking", selection: $kind) { Text("Daily: once per day").tag("daily"); Text("Count: every occurrence").tag("count") }
          Picker("Symbol", selection: $symbol) { ForEach(model.catalog.symbols, id: \.self) { name in Label(name.replacingOccurrences(of: ".fill", with: "").replacingOccurrences(of: ".", with: " "), systemImage: name).tag(name) } }
          Picker("Color", selection: $accent) { ForEach(model.catalog.palette) { swatch in Text(swatch.name.capitalized).tag(swatch.hex) } }
          Toggle("Tint habit background", isOn: $tinted)
        }
        if kind == "count" {
          Section("Check-ins") {
            Toggle("Track an amount", isOn: $tracksAmount)
            if tracksAmount { TextField("Unit", text: $amountUnit); TextField("Quick amount", text: $quickAmount) }
            Toggle("Record time", isOn: $tracksTime)
          }
        }
        Section("Routine") {
          Picker("Anchor", selection: $anchorKind) { Text("None").tag("none"); Text("Another habit").tag("board"); Text("Daily event").tag("preset"); Text("Custom cue").tag("text") }
          if anchorKind != "none" {
            Picker("Relation", selection: $relation) { Text("After").tag("after"); Text("Before").tag("before") }.pickerStyle(.segmented)
            if anchorKind == "board" {
              Picker("Habit", selection: $anchorBoard) { Text("Choose a habit").tag(""); ForEach((model.boards + model.archivedBoards).filter { $0.id != board?.id }) { Text($0.title).tag($0.id) } }
            } else if anchorKind == "preset" {
              Picker("Event", selection: $preset) { Text("Waking up").tag("wake"); Text("Lunch").tag("lunch"); Text("Dinner").tag("dinner"); Text("Going to sleep").tag("sleep") }
            } else { TextField("Cue", text: $anchorText) }
          }
          Toggle("Required for stack completion", isOn: $required)
          Toggle("Set a usual time", isOn: $usualTime)
          if usualTime { MinutePicker(title: "Usual time", minute: $minute) }
          Picker("Day starts at", selection: $dayStart) { ForEach(Array(stride(from: 0, through: 720, by: 30)), id: \.self) { Text(minuteLabel($0)).tag($0) } }
        }
        Section("Progress") {
          Toggle("Show analytics", isOn: $metrics)
          Toggle("Earn coins", isOn: $earnsCoins)
          if earnsCoins { Stepper("Daily coin cap: \(coinCap)", value: $coinCap, in: 1...10) }
        }
        if let failure { Text(failure).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
      }.formStyle(.grouped)
      HStack { Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction); Spacer(); Button(saving ? "Saving..." : "Save Habit") { Task { await save() } }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (usualTime && !WallClockTime.isValid(minute, step: 15))) }.padding(20)
    }.frame(width: 540, height: 660).onAppear(perform: load)
  }
  func load() {
    guard let board else { return }
    title = board.title; kind = board.kind; symbol = board.symbol; accent = board.accentHex; tinted = board.usesTintedBackground
    tracksAmount = board.tracksAmount; amountUnit = board.amountUnit ?? ""; quickAmount = editableNumber(board.quickAmount)
    tracksTime = board.tracksTime; dayStart = board.startOfDayMinute; metrics = board.metricsEnabled
    earnsCoins = board.earnsCoins; coinCap = board.coinCapPerDay; anchorKind = board.anchorKind ?? "none"; relation = board.anchorRelation ?? "after"
    anchorBoard = board.anchorBoardId ?? ""; preset = board.anchorPreset ?? "wake"; anchorText = board.anchorText ?? ""
    usualTime = board.usualTimeMinute != nil; minute = board.usualTimeMinute ?? 480; required = board.requiredInStack
  }
  func save() async {
    guard !usualTime || WallClockTime.isValid(minute, step: 15) else { return }
    guard let amount = parseEditableNumber(quickAmount), amount > 0 else { failure = "Enter a positive quick amount."; return }
    saving = true; defer { saving = false }
    var input: [String: Any] = ["title": title, "kind": kind, "symbol": symbol, "accentHex": accent, "usesTintedBackground": tinted, "tracksAmount": tracksAmount, "amountUnit": amountUnit.isEmpty ? NSNull() : amountUnit as Any, "quickAmount": amount, "tracksTime": tracksTime, "startOfDayMinute": dayStart, "metricsEnabled": metrics, "earnsCoins": earnsCoins, "coinCapPerDay": coinCap, "requiredInStack": required, "usualTimeMinute": usualTime ? minute as Any : NSNull()]
    if anchorKind == "none" { input["anchor"] = NSNull() }
    else {
      let key = anchorKind == "board" ? "boardId" : anchorKind == "preset" ? "preset" : "text"
      let value = anchorKind == "board" ? anchorBoard : anchorKind == "preset" ? preset : anchorText
      input["anchor"] = ["kind": anchorKind, "relation": relation, key: value]
    }
    if let board { input["boardId"] = board.id; input["expectedMutationStamp"] = board.mutationStamp }
    if await model.perform(board == nil ? "createBoard" : "updateBoard", input) { dismiss() }
    else { failure = model.error; model.error = nil }
  }
}
struct MinutePicker: View {
  let title: String
  @Binding var minute: Int
  var body: some View { WallClockTimeField(title: title, minute: $minute, step: 15) }
}
