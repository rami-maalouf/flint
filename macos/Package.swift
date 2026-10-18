// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HabitSystemMac",
  platforms: [.macOS(.v14)],
  products: [.library(name: "HabitEngine", targets: ["HabitEngine"]),
    .library(name: "HabitWidgetData", targets: ["HabitWidgetData"]),
    .library(name: "HabitWidgetViews", targets: ["HabitWidgetViews"])],
  dependencies: [.package(path: "../modules/habit-system-apple")],
  targets: [
    .target(name: "HabitWidgetData"),
    .target(name: "HabitWidgetViews", dependencies: ["HabitWidgetData"]),
    .testTarget(name: "HabitWidgetDataTests", dependencies: ["HabitWidgetData"]),
    .target(name: "HabitEngine", dependencies: [.product(name: "HabitSystemCloudKit", package: "habit-system-apple")], resources: [.process("Resources")], linkerSettings: [.linkedLibrary("sqlite3"), .linkedFramework("JavaScriptCore")], plugins: [.plugin(name: "BundleHabitEngine")]),
    .testTarget(name: "HabitEngineTests", dependencies: ["HabitEngine"], plugins: [.plugin(name: "BundleHabitEngine")]),
    .plugin(name: "BundleHabitEngine", capability: .buildTool())
  ]
)
