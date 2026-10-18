import CloudKit
import Combine
import Foundation

public struct SyncOutcome: Decodable, Sendable {
  public let status: String
  public let uploaded: Int
  public let applied: Int
  public let localChanged: Bool
  public let retryAfterMs: Int?
}

@MainActor
public final class SyncCoordinator: ObservableObject {
  @Published public private(set) var status = "idle"
  @Published public private(set) var lastOutcome: SyncOutcome?
  public var onOutcome: ((SyncOutcome) -> Void)?
  private let engine: EngineHost
  private var running: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var generation = 0
  private var requestedAgain = false
  private var active = true
  private var accountObserver: NSObjectProtocol?

  public init(engine: EngineHost) {
    self.engine = engine
    accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self else { return }
        await self.cancel()
        self.request()
      }
    }
  }

  deinit {
    if let accountObserver { NotificationCenter.default.removeObserver(accountObserver) }
    running?.cancel()
    retry?.cancel()
  }

  // call after a committed local write and on foreground/day/time-zone refresh.
  public func request() {
    guard active else { return }
    retry?.cancel(); retry = nil
    guard running == nil else { requestedAgain = true; return }
    let expected = generation
    status = "syncing"
    running = Task { [weak self, engine] in
      do {
        let outcome: SyncOutcome = try await engine.decode("sync")
        guard let self, !Task.isCancelled, self.generation == expected else { return }
        self.running = nil
        self.status = outcome.status
        self.lastOutcome = outcome
        self.onOutcome?(outcome)
        if self.requestedAgain {
          self.requestedAgain = false
          self.request()
        } else if let delay = outcome.retryAfterMs {
          self.scheduleRetry(delay, generation: expected)
        }
      } catch {
        guard let self, !Task.isCancelled, self.generation == expected else { return }
        self.running = nil
        self.status = "needs_attention"
        self.scheduleRetry(30_000, generation: expected)
      }
    }
  }

  // call before local edits while sync is active, disabling sync, switching stores, or import.
  public func cancel() async {
    generation += 1
    running?.cancel(); running = nil
    retry?.cancel(); retry = nil
    requestedAgain = false
    await engine.invalidateSync()
    status = "idle"
  }

  public func setActive(_ value: Bool) async {
    active = value
    if value { request() } else { await cancel() }
  }

  public func setEnabled(_ enabled: Bool) async throws {
    await cancel()
    _ = try await engine.call("setICloudSyncEnabled", [["commandId": UUID().uuidString.lowercased(), "enabled": enabled]])
    if enabled { request() }
  }

  private func scheduleRetry(_ delay: Int, generation expected: Int) {
    guard active else { return }
    let bounded = min(300_000, max(1_000, delay))
    retry = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: UInt64(bounded) * 1_000_000) } catch { return }
      guard let self, self.generation == expected, self.active else { return }
      self.retry = nil
      self.request()
    }
  }
}
