import Foundation
import Darwin

public struct WidgetSelectionKey: Equatable, Sendable {
  public let environment: String
  public let kind: String
  public let family: String
  public let configuredHabitID: String?

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
  public init(selectedID: String? = nil) { self.selectedID = selectedID }

  public func selectedHabit(in snapshot: WidgetSnapshot?, configuredHabitID: String?) -> WidgetHabit? {
    guard let snapshot else { return nil }
    if let id = selectedID ?? configuredHabitID { return snapshot.habits.first { $0.id == id } }
    return snapshot.habits.first
  }

  fileprivate var isValid: Bool {
    selectedID == nil || UUID(uuidString: selectedID!) != nil
  }
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

  @discardableResult public func advance(snapshot: WidgetSnapshot) throws -> WidgetSelectionState {
    guard snapshot.environment == key.environment else { throw WidgetSelectionError.wrongEnvironment }
    guard !snapshot.habits.isEmpty else { throw WidgetSelectionError.unavailableHabit }
    guard let url else { throw WidgetSelectionError.unavailableContainer }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    // keep the lock separate from the atomically replaced selection file.
    let descriptor = open(url.appendingPathExtension("lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    while flock(descriptor, LOCK_EX) != 0 {
      if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    defer { flock(descriptor, LOCK_UN) }
    let current = read().selectedHabit(in: snapshot, configuredHabitID: key.configuredHabitID)
    let nextIndex = snapshot.habits.firstIndex { $0.id == current?.id }.map { ($0 + 1) % snapshot.habits.count } ?? 0
    let state = WidgetSelectionState(selectedID: snapshot.habits[nextIndex].id)
    try write(state)
    return state
  }
}
