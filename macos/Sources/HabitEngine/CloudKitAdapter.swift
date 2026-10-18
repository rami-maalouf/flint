import Foundation
import HabitSystemCloudKit
import Security

public enum CloudKitAdapter {
  public static var isSupportedBuild: Bool {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
      let entitlements = (information as? [String: Any])?[kSecCodeInfoEntitlementsDict as String] as? [String: Any] else { return false }
    let containers = entitlements["com.apple.developer.icloud-container-identifiers"] as? [String] ?? []
    let services = entitlements["com.apple.developer.icloud-services"] as? [String] ?? []
    return containers.contains("iCloud.studio.orbitlabs.habitsystem") && services.contains("CloudKit")
  }

  // initialize the product database first; account metadata must never create a second store.
  public static func configureCloudKit(on engine: EngineHost) async {
    guard isSupportedBuild, engine.databasePath != ":memory:" else { return }
    let facade = MacCloudKitFacade(databasePath: engine.databasePath)
    await engine.registerService("sync.available") { _ in await facade.available() }
    await engine.registerService("sync.ensureZone") { _ in
      try await mapped { try await facade.ensureZone(); return NSNull() }
    }
    await engine.registerService("sync.upload") { request in
      guard let records = request["records"] as? String else { throw EngineFailure(code: "failure", message: "Invalid sync upload.") }
      return try await mapped { try await facade.upload(records); return NSNull() }
    }
    await engine.registerService("sync.fetchChanges") { request in
      try await mapped { try await facade.fetchChanges(request["token"] as? String) }
    }
  }

  private static func mapped(_ operation: () async throws -> Any) async throws -> Any {
    do { return try await operation() }
    catch let error as MacCloudKitError {
      throw EngineFailure(code: error.code, message: error.message, retryable: error.code != "unavailable")
    }
  }
}
