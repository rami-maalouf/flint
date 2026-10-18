import Foundation
import PackagePlugin

@main
struct BundleHabitEngine: BuildToolPlugin {
  func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
    let root = context.package.directory.removingLastComponent()
    let folders = [root.appending("src/core"), context.package.directory.appending("bridge")]
    let inputs = folders.flatMap { folder -> [Path] in
      let enumerator = FileManager.default.enumerator(atPath: folder.string)
      return (enumerator?.allObjects as? [String] ?? []).filter { $0.hasSuffix(".ts") || $0.hasSuffix(".json") }.map { folder.appending($0) }
    }
    let isTest = target.name == "HabitEngineTests"
    let output = context.pluginWorkDirectory.appending(isTest ? "parity.js" : "engine.js")
    let entry = isTest ? "bridge/parity.test-entry.ts" : "bridge/index.ts"
    return [.buildCommand(displayName: "Bundle shared habit engine", executable: Path("/usr/bin/env"),
      arguments: ["bun", "build", context.package.directory.appending(entry).string, "--target=browser", "--format=iife", "--outfile=" + output.string],
      inputFiles: inputs + [root.appending("tsconfig.json"), root.appending("src/platform/notifications/miss-content.ts")], outputFiles: [output])]
  }
}
