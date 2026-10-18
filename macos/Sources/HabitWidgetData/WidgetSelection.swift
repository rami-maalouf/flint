import Foundation

public struct WidgetSelectionKey: Equatable, Sendable {
  public let environment: String
  public let kind: String
  public let family: String
  public let configuredHabitID: String?
  public var pageSize: Int { family == "small" ? 3 : family == "medium" ? 4 : 7 }

  public init?(environment: String, kind: String, family: String, configuredHabitID: String?) {
    guard ["Development", "Production"].contains(environment),
      ["HabitSystem.ActivityGrid", "HabitSystem.WeeklyFocus"].contains(kind),
      ["small", "medium", "large"].contains(family),
      configuredHabitID == nil || UUID(uuidString: configuredHabitID!) != nil else { return nil }
    self.environment = environment
    self.kind = kind
    self.family = family
    self.configuredHabitID = configuredHabitID
  }

  fileprivate var filename: String {
    // preserve case-distinct imported ids on case-insensitive mac volumes.
    let configuration = configuredHabitID.map { $0.utf8.map { String(format: "%02x", $0) }.joined() } ?? "default"
    return "selection-\(environment)-\(kind)-\(family)-\(configuration).json"
  }
}

public struct WidgetSelectionState: Codable, Equatable, Sendable {
  public var selectedID: String?
  public var pickerPage: Int
  public var isChoosing: Bool
  public init(selectedID: String? = nil, pickerPage: Int = 0, isChoosing: Bool = false) {
    self.selectedID = selectedID
    self.pickerPage = pickerPage
    self.isChoosing = isChoosing
  }

  public func selectedHabit(in snapshot: WidgetSnapshot?, configuredHabitID: String?) -> WidgetHabit? {
    guard let snapshot else { return nil }
    if let id = selectedID ?? configuredHabitID { return snapshot.habits.first { $0.id == id } }
    return snapshot.habits.first
  }

  public func boundedPage(in snapshot: WidgetSnapshot, pageSize: Int) -> Int {
    let lastPage = max(0, snapshot.habits.count - 1) / max(1, pageSize)
    return min(max(0, pickerPage), lastPage)
  }

  public func visibleHabits(in snapshot: WidgetSnapshot, pageSize: Int) -> [WidgetHabit] {
    let size = max(1, pageSize)
    return Array(snapshot.habits.dropFirst(boundedPage(in: snapshot, pageSize: size) * size).prefix(size))
  }

  fileprivate var isValid: Bool {
    pickerPage >= 0 && (selectedID == nil || UUID(uuidString: selectedID!) != nil)
  }
}

public enum WidgetSelectionAction: Sendable {
  case open, close, select(String), page(Int)
}

public enum WidgetSelectionError: Error {
  case unavailableContainer, invalidState, wrongEnvironment, unavailableHabit
}

public struct WidgetSelectionStore: Sendable {
  public let key: WidgetSelectionKey
  public let url: URL?
  public init(key: WidgetSelectionKey, directory: URL? = nil) {
    self.key = key
    let container = directory ?? WidgetSnapshotStore.url(environment: key.environment)?.deletingLastPathComponent()
    url = container?.appendingPathComponent(key.filename)
  }

  public func read() -> WidgetSelectionState {
    guard let url, let handle = try? FileHandle(forReadingFrom: url) else { return WidgetSelectionState() }
    defer { try? handle.close() }
    guard let data = try? handle.read(upToCount: 4_097), data.count <= 4_096,
      let state = try? JSONDecoder().decode(WidgetSelectionState.self, from: data), state.isValid else { return WidgetSelectionState() }
    return state
  }

  public func write(_ state: WidgetSelectionState) throws {
    guard state.isValid else { throw WidgetSelectionError.invalidState }
    guard let url else { throw WidgetSelectionError.unavailableContainer }
    let data = try JSONEncoder().encode(state)
    guard data.count <= 4_096 else { throw WidgetSelectionError.invalidState }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }

  @discardableResult public func apply(_ action: WidgetSelectionAction, snapshot: WidgetSnapshot) throws -> WidgetSelectionState {
    guard snapshot.environment == key.environment else { throw WidgetSelectionError.wrongEnvironment }
    var state = read()
    state.pickerPage = state.boundedPage(in: snapshot, pageSize: key.pageSize)
    switch action {
    case .open:
      let selected = state.selectedHabit(in: snapshot, configuredHabitID: key.configuredHabitID)
      state.pickerPage = snapshot.habits.firstIndex { $0.id == selected?.id }.map { $0 / key.pageSize } ?? 0
      state.isChoosing = true
    case .close:
      state.isChoosing = false
    case .select(let id):
      guard let index = snapshot.habits.firstIndex(where: { $0.id == id }) else { throw WidgetSelectionError.unavailableHabit }
      state.selectedID = id
      state.pickerPage = index / key.pageSize
      state.isChoosing = false
    case .page(let page):
      state.pickerPage = page
      state.pickerPage = state.boundedPage(in: snapshot, pageSize: key.pageSize)
      state.isChoosing = true
    }
    try write(state)
    return state
  }
}
