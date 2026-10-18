import Foundation

public struct MacCloudKitError: LocalizedError, Sendable {
  public let code: String
  public let message: String
  public var errorDescription: String? { message }

  init(_ error: Error) {
    let failure = CloudKitFailure.map(error)
    code = failure.rawValue
    message = failure.message
  }
}

public struct MacCloudKitFacade: Sendable {
  private let transport: CloudKitTransport

  init(transport: CloudKitTransport) { self.transport = transport }

  public init(databasePath: String, containerIdentifier: String = "iCloud.studio.orbitlabs.habitsystem") {
    transport = CloudKitTransport(client: CloudKitOperations(containerIdentifier: containerIdentifier),
      containerIdentifier: containerIdentifier, accountBinding: CloudKitAccountBinding(databasePath: databasePath))
  }

  public func available() async -> Bool { await transport.available() }

  public func ensureZone() async throws {
    do { try Task.checkCancellation(); try await transport.ensureZone(); try Task.checkCancellation() }
    catch { throw MacCloudKitError(error) }
  }

  public func upload(_ recordsJSON: String) async throws {
    do {
      try Task.checkCancellation()
      try await transport.upload(CloudKitWireCodec.decodeUpload(recordsJSON))
      try Task.checkCancellation()
    } catch { throw MacCloudKitError(error) }
  }

  public func fetchChanges(_ token: String?) async throws -> String {
    do {
      try Task.checkCancellation()
      let page = try await transport.fetchChanges(token)
      try Task.checkCancellation()
      return try CloudKitWireCodec.encodePage(page)
    } catch { throw MacCloudKitError(error) }
  }
}
