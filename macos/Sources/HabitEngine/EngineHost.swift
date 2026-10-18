import CryptoKit
import Foundation
import JavaScriptCore

public struct EngineFailure: LocalizedError {
  public let code: String
  public let message: String
  public let retryable: Bool
  public var field: String? = nil
  public var errorDescription: String? { message }
  public init(code: String, message: String, retryable: Bool = false, field: String? = nil) {
    self.code = code; self.message = message; self.retryable = retryable; self.field = field
  }
}

public final class EngineHost: @unchecked Sendable {
  public typealias NativeService = ([String: Any]) async throws -> Any
  private let lane = DispatchQueue(label: "studio.orbitlabs.habitsystem.engine", qos: .userInitiated)
  private var context: JSContext!
  private var store: SQLiteStore!
  private var pending: [String: CheckedContinuation<Any, Error>] = [:]
  private var services: [String: NativeService] = [:]
  private var serviceTasks: [String: (name: String, task: Task<Void, Never>)] = [:]
  private var syncGeneration = 0
  public let databasePath: String

  public init(databasePath: String) throws {
    self.databasePath = databasePath
    try lane.sync {
      store = try SQLiteStore(path: databasePath)
      guard let context = JSContext(), let scriptURL = Bundle.module.url(forResource: "engine", withExtension: "js") else {
        throw EngineFailure(code: "bundle", message: "The shared habit engine is missing. Rebuild the Mac app.", retryable: false)
      }
      self.context = context
      let native: @convention(block) (String) -> String = { [weak self] request in
        guard let self else { return "{\"ok\":false,\"error\":\"Engine closed.\"}" }
        do {
          let payload = try JSONSerialization.jsonObject(with: Data(request.utf8)) as! [String: Any]
          let value = try self.nativeRequest(payload)
          return try Self.json(["ok": true, "value": value])
        } catch {
          return (try? Self.json(["ok": false, "error": error.localizedDescription])) ?? "{\"ok\":false,\"error\":\"Native operation failed.\"}"
        }
      }
      let complete: @convention(block) (String, String) -> Void = { [weak self] identifier, response in
        guard let continuation = self?.pending.removeValue(forKey: identifier) else { return }
        do {
          let object = try JSONSerialization.jsonObject(with: Data(response.utf8)) as! [String: Any]
          if object["ok"] as? Bool == true { continuation.resume(returning: object["value"] ?? NSNull()) }
          else {
            let failure = object["error"] as? [String: Any] ?? [:]
            continuation.resume(throwing: EngineFailure(code: failure["code"] as? String ?? "runtime", message: failure["message"] as? String ?? "The operation could not finish.", retryable: failure["retryable"] as? Bool ?? false, field: failure["field"] as? String))
          }
        } catch { continuation.resume(throwing: error) }
      }
      context.setObject(native, forKeyedSubscript: "__habitNative" as NSString)
      context.setObject(complete, forKeyedSubscript: "__habitComplete" as NSString)
      let service: @convention(block) (String, String, String) -> Void = { [weak self] identifier, name, payload in
        self?.startService(identifier: identifier, name: name, payload: payload)
      }
      context.setObject(service, forKeyedSubscript: "__habitService" as NSString)
      let source = try String(contentsOf: scriptURL, encoding: .utf8)
      context.evaluateScript(source, withSourceURL: scriptURL)
      if let exception = context.exception {
        throw EngineFailure(code: "bundle", message: exception.toString(), retryable: false)
      }
    }
  }

  public func registerService(_ name: String, handler: @escaping NativeService) async {
    await withCheckedContinuation { continuation in
      lane.async { self.services[name] = handler; continuation.resume() }
    }
  }

  // this bypasses the operation queue so a stalled network call cannot delay disabling sync.
  public func invalidateSync() async {
    await withCheckedContinuation { continuation in
      lane.async {
        self.syncGeneration += 1
        let cancelled = self.serviceTasks.filter { $0.value.name.hasPrefix("sync.") }
        for (identifier, entry) in cancelled {
          entry.task.cancel()
          self.finishService(identifier, response: self.serviceError(EngineFailure(code: "cancelled", message: "Sync cancelled.")))
        }
        continuation.resume()
      }
    }
  }

  private func startService(identifier: String, name: String, payload: String) {
    guard let service = services[name] else {
      context.objectForKeyedSubscript("HabitEngine").invokeMethod("settleService", withArguments: [identifier,
        serviceError(EngineFailure(code: "unavailable", message: "This native service is unavailable."))])
      return
    }
    let task = Task { [weak self] in
      let response: String
      do {
        let input = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] ?? [:]
        let result = try await service(input)
        response = try Self.json(["ok": true, "value": result])
      } catch {
        guard let self else { return }
        response = self.serviceError(error)
      }
      self?.lane.async { [weak self] in self?.finishService(identifier, response: response) }
    }
    serviceTasks[identifier] = (name, task)
  }

  private func serviceError(_ error: Error) -> String {
    let failure = error as? EngineFailure ?? EngineFailure(code: "failure", message: "The native service could not finish.", retryable: true)
    return (try? Self.json(["ok": false, "error": ["code": failure.code, "message": failure.message, "retryable": failure.retryable]]))!
  }

  private func finishService(_ identifier: String, response: String) {
    guard serviceTasks.removeValue(forKey: identifier) != nil else { return }
    context.objectForKeyedSubscript("HabitEngine").invokeMethod("settleService", withArguments: [identifier, response])
  }

  public func call(_ method: String, _ arguments: [Any] = []) async throws -> Any {
    let request = try Self.json(["method": method, "arguments": arguments])
    return try await withCheckedThrowingContinuation { continuation in
      lane.async {
        let identifier = UUID().uuidString
        self.pending[identifier] = continuation
        self.context.exception = nil
        self.context.objectForKeyedSubscript("HabitEngine").invokeMethod("dispatch", withArguments: [identifier, request])
        if let exception = self.context.exception, let waiting = self.pending.removeValue(forKey: identifier) {
          waiting.resume(throwing: EngineFailure(code: "runtime", message: exception.toString(), retryable: false))
        }
      }
    }
  }

  public func decode<Value: Decodable>(_ method: String, _ arguments: [Any] = [], as type: Value.Type = Value.self) async throws -> Value {
    let result = try await call(method, arguments)
    return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]))
  }

  private func nativeRequest(_ request: [String: Any]) throws -> Any {
    switch request["kind"] as? String {
    case "exec": try store.execute(request["sql"] as! String); return NSNull()
    case "query", "run": return try store.statement(request["sql"] as! String, parameters: request["params"] as? [Any] ?? [], rows: request["kind"] as? String == "query")
    case "uuid": return UUID().uuidString.lowercased()
    case "timeZone": return TimeZone.current.identifier
    case "syncGeneration": return syncGeneration
    case "isMemoryDatabase": return databasePath == ":memory:"
    case "hash":
      let bytes = Data((request["bytes"] as? [NSNumber] ?? []).map(\.uint8Value))
      if request["algorithm"] as? String == "sha1" { return Array(Insecure.SHA1.hash(data: bytes)) }
      return Array(SHA256.hash(data: bytes))
    default: throw EngineFailure(code: "bridge", message: "Unknown native operation.", retryable: false)
    }
  }

  private static func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), as: UTF8.self)
  }
}
