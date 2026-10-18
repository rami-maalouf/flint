import Foundation

public struct WidgetDay: Codable, Identifiable, Equatable, Sendable {
  public var id: String { date }
  public let date: String
  public let count: Int
  public let isToday: Bool
  public let isFuture: Bool
  public let eligible: Bool
  public init(date: String, count: Int, isToday: Bool, isFuture: Bool, eligible: Bool) {
    self.date = date; self.count = count; self.isToday = isToday; self.isFuture = isFuture; self.eligible = eligible
  }
}

public struct WidgetHabit: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let symbol: String
  public let accentHex: String
  public let kind: String
  public let logicalDate: String
  public let checkedToday: Bool
  public let currentStreak: Int?
  public let todayCount: Int
  public let weeks: [[WidgetDay]]
  public var week: [WidgetDay] { weeks.last ?? [] }
  public init(id: String, title: String, symbol: String, accentHex: String, kind: String, logicalDate: String,
              checkedToday: Bool, currentStreak: Int?, todayCount: Int, weeks: [[WidgetDay]]) {
    self.id = id; self.title = title; self.symbol = symbol; self.accentHex = accentHex; self.kind = kind
    self.logicalDate = logicalDate; self.checkedToday = checkedToday; self.currentStreak = currentStreak
    self.todayCount = todayCount; self.weeks = weeks
  }
}

public struct WidgetSnapshot: Codable, Equatable, Sendable {
  public let environment: String
  public let schemaVersion: Int
  public let generatedAtUtc: Double
  public let expiresAtUtc: Double
  public let timeZoneID: String
  public let balance: Int
  public let habits: [WidgetHabit]
  public var generatedAt: Date { Date(timeIntervalSince1970: generatedAtUtc / 1000) }
  public var expiresAt: Date { Date(timeIntervalSince1970: expiresAtUtc / 1000) }
  public init(schemaVersion: Int = 1, generatedAtUtc: Double, expiresAtUtc: Double, timeZoneID: String, balance: Int, habits: [WidgetHabit], environment: String = "Development") {
    self.environment = environment; self.schemaVersion = schemaVersion; self.generatedAtUtc = generatedAtUtc; self.expiresAtUtc = expiresAtUtc
    self.timeZoneID = timeZoneID; self.balance = balance; self.habits = habits
  }
  public func isStale(at date: Date, timeZoneID: String = TimeZone.current.identifier) -> Bool {
    schemaVersion != 1 || date >= expiresAt || date < generatedAt || self.timeZoneID != timeZoneID
  }
}

public enum WidgetSnapshotStore {
  public static let groupIdentifier = "3V2UU7RRK9.studio.orbitlabs.habitsystem.mac"
  public static var environment: String { Bundle.main.object(forInfoDictionaryKey: "HabitSystemCloudEnvironment") as? String ?? "Development" }
  public static func url(environment: String = environment) -> URL? {
    guard ["Development", "Production"].contains(environment),
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier) else { return nil }
    return container.appendingPathComponent("widgets-\(environment).json")
  }
  public static func read(from url: URL?, environment: String? = nil) -> WidgetSnapshot? {
    guard let url, let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 16_000_000,
      let data = try? Data(contentsOf: url), let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
      (environment == nil || snapshot.environment == environment), snapshot.schemaVersion == 1, snapshot.expiresAtUtc > snapshot.generatedAtUtc else { return nil }
    return snapshot
  }
  public static func write(_ snapshot: WidgetSnapshot, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
  }
  public static func destination(habitID: String? = nil, environment: String = environment) -> URL {
    var components = URLComponents()
    components.scheme = "habitsystem-mac"
    components.host = habitID == nil ? "today" : "habit"
    components.path = habitID.map { "/\($0)" } ?? ""
    components.queryItems = [URLQueryItem(name: "environment", value: environment)]
    return components.url!
  }
}
