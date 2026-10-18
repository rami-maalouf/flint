import SwiftUI

struct RewardsView: View {
  @ObservedObject var model: AppModel
  @State private var rewards: [Reward] = []
  @State private var archived = false
  @State private var creating = false
  @State private var editing: Reward?
  @State private var claiming: RewardPreview?
  @State private var deleting: Reward?
  @State private var failure: String?
  @State private var loading = true
  @State private var claimBusy = false
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageHeader(title: "Make progress feel rewarding.", subtitle: "\(model.totals.balance) coins available to spend on something you enjoy.")
        Picker("Rewards", selection: $archived) { Text("Active").tag(false); Text("Archived").tag(true) }.pickerStyle(.segmented).frame(width: 230)
        if let failure { Text(failure).foregroundStyle(.red); Button("Try Again") { Task { await load() } } }
        if loading { ProgressView() }
        else if rewards.isEmpty {
          ContentUnavailableView { Label(archived ? "No archived rewards" : "Something to look forward to", systemImage: "gift") }
          description: { Text(archived ? "Archived rewards can be restored whenever you like." : "Choose your own rewards and decide how many coins they cost.") }
          actions: { if !archived { Button("Create a Reward") { creating = true }.buttonStyle(.borderedProminent) } }
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 16)], spacing: 16) {
          ForEach(rewards) { reward in
            VStack(alignment: .leading, spacing: 16) {
              HStack { HabitIcon(symbol: reward.symbol, color: Color(hex: reward.accentHex)); Spacer(); Menu {
                if !archived { Button("Edit Reward") { editing = reward }; Button("Move to Top") { Task { await moveToTop(reward) } }; Button("Move Earlier") { Task { await move(reward, offset: -1) } }.disabled(rewards.first?.id == reward.id); Button("Move Later") { Task { await move(reward, offset: 1) } }.disabled(rewards.last?.id == reward.id) }
                Button(archived ? "Restore Reward" : "Archive Reward") { Task { await model.perform(archived ? "restoreReward" : "archiveReward", ["rewardId": reward.id]) } }
                Divider(); Button("Delete Reward...", role: .destructive) { deleting = reward }
              } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize() }
              Text(reward.title).font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
              Text("\(reward.costCoins) coins").font(.callout).foregroundStyle(.secondary)
              if archived {
                Button("Restore") { Task { await model.perform("restoreReward", ["rewardId": reward.id]) } }
              } else {
                Button(model.totals.balance < reward.costCoins ? "Need \(reward.costCoins - model.totals.balance) more coins" : "Claim Reward") { Task { await preview(reward) } }
                  .buttonStyle(.borderedProminent).disabled(model.totals.balance < reward.costCoins)
              }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
          }
        }
      }.padding(28).frame(maxWidth: 1100).frame(maxWidth: .infinity)
    }.toolbar { Button { creating = true } label: { Label("New Reward", systemImage: "plus") } }
    .task(id: "\(model.revision)-\(archived)") { await load() }
    .sheet(isPresented: $creating) { RewardEditor(model: model, reward: nil) }
    .sheet(item: $editing) { RewardEditor(model: model, reward: $0) }
    .sheet(item: $claiming) { preview in
      VStack(spacing: 20) {
        HabitIcon(symbol: preview.reward.symbol, color: Color(hex: preview.reward.accentHex))
        Text("Claim \(preview.reward.title)?").font(.title2.bold()).multilineTextAlignment(.center)
        Text("Spend \(preview.reward.costCoins) coins. Your balance will be \(preview.balanceAfterClaim ?? preview.balance) coins.").foregroundStyle(.secondary).multilineTextAlignment(.center)
        Text("Claims are recorded permanently in your coin history.").font(.caption).foregroundStyle(.secondary)
        if let error = model.error {
          Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
          Button("Review Updated Reward") { Task { await self.preview(preview.reward) } }
        }
        HStack {
          Button("Cancel") { claiming = nil }.keyboardShortcut(.cancelAction)
          Button(claimBusy ? "Claiming..." : "Confirm Claim") { Task {
            claimBusy = true
            let success = await model.perform("claimReward", ["rewardId": preview.reward.id, "expectedMutationStamp": preview.reward.mutationStamp])
            claimBusy = false
            if success { claiming = nil }
          } }.buttonStyle(.borderedProminent).disabled(claimBusy || preview.balanceAfterClaim == nil)
        }
      }.padding(32).frame(width: 400).interactiveDismissDisabled(claimBusy)
    }
    .confirmationDialog("Delete reward?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      if let deleting { Button("Delete \(deleting.title)", role: .destructive) { Task { await model.perform("deleteReward", ["rewardId": deleting.id]); self.deleting = nil } } }
    } message: { Text("Past claims remain in your coin history. This reward cannot be restored after deletion.") }
  }
  func load() async {
    do { rewards = try await model.query("listRewards", [["archived": archived]]); failure = nil } catch { failure = error.localizedDescription }
    loading = false
  }
  func preview(_ reward: Reward) async { do { model.error = nil; claiming = try await model.query("getRewardClaimPreview", [reward.id]) } catch { failure = error.localizedDescription } }
  func move(_ reward: Reward, offset: Int) async {
    guard let index = rewards.firstIndex(where: { $0.id == reward.id }), rewards.indices.contains(index + offset) else { return }
    var ordered = rewards; ordered.remove(at: index); let destination = index + offset; ordered.insert(reward, at: destination)
    await model.perform("reorderReward", ["rewardId": reward.id, "previousRewardId": destination > 0 ? ordered[destination - 1].id as Any : NSNull(), "nextRewardId": destination + 1 < ordered.count ? ordered[destination + 1].id as Any : NSNull()])
  }
  func moveToTop(_ reward: Reward) async {
    await model.perform("reorderReward", ["rewardId": reward.id, "previousRewardId": NSNull(), "nextRewardId": rewards.first(where: { $0.id != reward.id })?.id as Any? ?? NSNull()])
  }
}

struct RewardEditor: View {
  @ObservedObject var model: AppModel
  let reward: Reward?
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var cost = "10"
  @State private var symbol = "gift.fill"
  @State private var accent = "#8F82FF"
  @State private var saving = false
  @State private var failure: String?
  var body: some View {
    VStack(spacing: 0) {
      Text(reward == nil ? "New Reward" : "Edit Reward").font(.title2.bold()).frame(maxWidth: .infinity, alignment: .leading).padding(24)
      Form {
        TextField("Name", text: $title)
        TextField("Cost in coins", text: $cost)
        Picker("Symbol", selection: $symbol) { ForEach(model.catalog.symbols, id: \.self) { Label($0.replacingOccurrences(of: ".", with: " "), systemImage: $0).tag($0) } }
        Picker("Color", selection: $accent) { ForEach(model.catalog.palette) { Text($0.name.capitalized).tag($0.hex) } }
        if let failure { Text(failure).foregroundStyle(.red) }
      }.formStyle(.grouped)
      HStack { Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction); Spacer(); Button("Save Reward") { Task { await save() } }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.padding(20)
    }.frame(width: 460, height: 360)
    .onAppear { if let reward { title = reward.title; cost = String(reward.costCoins); symbol = reward.symbol; accent = reward.accentHex } }
  }
  func save() async {
    guard let coins = Int(cost), (1...100000).contains(coins) else { failure = "Enter a cost from 1 to 100,000 coins."; return }
    saving = true; defer { saving = false }
    var input: [String: Any] = ["title": title, "costCoins": coins, "symbol": symbol, "accentHex": accent]
    if let reward { input["rewardId"] = reward.id; input["expectedMutationStamp"] = reward.mutationStamp }
    if await model.perform(reward == nil ? "createReward" : "updateReward", input) { dismiss() }
    else { failure = model.error; model.error = nil }
  }
}
