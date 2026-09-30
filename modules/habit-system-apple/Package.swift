// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HabitSystemAppleNativeTests",
  platforms: [.macOS(.v13), .iOS("18.6")],
  targets: [
    .target(name: "HabitSystemIntentCore", path: "ios/Intents/Core", linkerSettings: [.linkedLibrary("sqlite3")]),
    .testTarget(name: "HabitSystemIntentCoreTests", dependencies: ["HabitSystemIntentCore"], path: "tests/Intents", exclude: ["README.md"]),
    .target(
      name: "HabitSystemCloudKit", path: "ios",
      exclude: ["Intents", "AlternateIconAdapter.swift", "AlternateIconConfiguration.swift", "CloudKitExpoBridge.swift", "HabitSystemAppleModule.swift", "HabitSystemApple.podspec"],
      sources: ["CloudKitErrors.swift", "CloudKitRecordMapping.swift", "CloudKitWireCodec.swift", "CloudKitToken.swift", "CloudKitTransport.swift", "CloudKitOperations.swift", "CloudKitAccountBinding.swift", "CloudKitSQLiteCompat.swift"],
      linkerSettings: [.linkedFramework("CloudKit"), .linkedLibrary("sqlite3")]
    ),
    .testTarget(name: "HabitSystemCloudKitTests", dependencies: ["HabitSystemCloudKit"], path: "tests/CloudKit", resources: [.copy("sync-records.json"), .copy("sync-records-v2.json")]),
  ],
  swiftLanguageVersions: [.v5]
)
