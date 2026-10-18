// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HabitSystemMac",
  platforms: [.macOS(.v14)],
  products: [.library(name: "HabitEngine", targets: ["HabitEngine"])],
  targets: [
    .target(name: "HabitEngine", resources: [.process("Resources")], linkerSettings: [.linkedLibrary("sqlite3"), .linkedFramework("JavaScriptCore")], plugins: [.plugin(name: "BundleHabitEngine")]),
    .testTarget(name: "HabitEngineTests", dependencies: ["HabitEngine"], plugins: [.plugin(name: "BundleHabitEngine")]),
    .plugin(name: "BundleHabitEngine", capability: .buildTool())
  ]
)
