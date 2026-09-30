import Foundation
@testable import HabitSystemIntentCore

// test stores execute the authoritative descriptors; production intents never migrate.
enum IntentFixtureMigrations {
  static func load(root: URL) throws -> [[String: Any]] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["bun", "-e", "import { migrations } from './src/core/persistence/schema.ts'; import { migrationChecksum } from './src/core/persistence/migrations.ts'; console.log(JSON.stringify(migrations.map(m=>({...m,checksum:migrationChecksum(m)}))))"]
    process.currentDirectoryURL = root
    let pipe = Pipe(); process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0, let migrations = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw IntentStorageError.unavailable }
    return migrations
  }

  static func apply(_ migration: [String: Any], to database: IntentDatabase, enqueueAt: Int64) throws {
    guard let statements = migration["statements"] as? [String], let version = migration["version"] as? Int,
      let name = migration["name"] as? String, let checksum = migration["checksum"] as? String else { throw IntentStorageError.unavailable }
    try database.transaction(exclusive: true) {
      try database.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)")
      for statement in statements { try database.run(statement) }
      if let raw = migration["dataStep"] {
        guard let step = raw as? [String: Any], Set(step.keys) == ["name", "version"],
          step["name"] as? String == "legacy_check_evidence", step["version"] as? Int == 1 else { throw IntentStorageError.unavailable }
        let ids = try database.rows("SELECT id FROM check_ins WHERE deleted_at IS NULL ORDER BY id").map { try IntentCoinSQL($0).string("id") }
        try establishHistorical(database: database, ids: ids, enqueueAt: enqueueAt, reconcileStoredLedger: true)
      }
      try database.run("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)", [.integer(Int64(version)), .text(name), .text(checksum), .integer(enqueueAt)])
      try database.run("PRAGMA user_version = \(version)")
    }
  }

  // only explicit historical fixture setup and the named migration step call this boundary.
  static func establishHistorical(database: IntentDatabase, ids: [String], enqueueAt: Int64, reconcileStoredLedger: Bool = false) throws {
    let encoded = String(decoding: try JSONEncoder().encode(Array(Set(ids)).sorted()), as: UTF8.self)
    let raw = try database.rows("""
      SELECT c.id, c.board_id, c.logical_date, EXISTS (
        SELECT 1 FROM habit_actions a WHERE a.board_id = c.board_id AND a.logical_date = c.logical_date
          AND a.check_in_id = c.id) AS has_evidence
      FROM check_ins c WHERE c.id IN (SELECT value FROM json_each(?)) AND c.deleted_at IS NULL ORDER BY c.id
      """, [.text(encoded)])
    var visibleScopes = Set<IntentBonusEvidence.CheckScope>(), settleScopes = Set<IntentBonusEvidence.CheckScope>()
    for row in raw {
      let value = IntentCoinSQL(row), id = try IntentCoinSQL(row).string("id")
      let board = try value.string("board_id"), date = try value.string("logical_date")
      visibleScopes.insert(.init(boardId: board, logicalDate: date))
      if try !value.boolean("has_evidence") {
        try IntentHabitAction.baseline(checkInId: id, boardId: board, date: date).append(to: database, enqueueAt: enqueueAt)
        settleScopes.insert(.init(boardId: board, logicalDate: date))
      }
    }
    var roots = Set<IntentBonusEvidence.Scope>()
    if reconcileStoredLedger {
      for raw in try database.rows("SELECT DISTINCT scope_key, logical_date FROM coin_ledger WHERE scope_key IS NOT NULL") {
        let value = IntentCoinSQL(raw), key = try IntentCoinSQL(raw).string("scope_key")
        let parts = key.split(separator: ":"), date = try value.string("logical_date")
        guard parts.count == 3, String(parts[2]) == date else { throw IntentCoinError.invalid }
        if parts[0] == "check" { settleScopes.insert(.init(boardId: String(parts[1]), logicalDate: date)) }
        else if parts[0] == "bonus" { roots.insert(.init(rootId: String(parts[1]), logicalDate: date)) }
        else { throw IntentCoinError.invalid }
      }
    }
    try IntentCoinStore.settleAffected(checkScopes: Array(settleScopes), rootScopes: Array(roots), database: database, enqueueAt: enqueueAt)
    try IntentCheckVisibility.refresh(database: database, scopes: Array(visibleScopes))
  }
}
