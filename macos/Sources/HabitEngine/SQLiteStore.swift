import Foundation
import SQLite3

final class SQLiteStore {
  private var database: OpaquePointer?
  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(path: String) throws {
    if path != ":memory:" {
      try FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
    }
    guard sqlite3_open_v2(path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      let failure = error()
      sqlite3_close(database)
      database = nil
      throw failure
    }
    sqlite3_busy_timeout(database, 5000)
    try execute("PRAGMA foreign_keys = ON")
  }

  deinit { sqlite3_close(database) }

  func execute(_ sql: String) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw error() }
  }

  func statement(_ sql: String, parameters: [Any], rows: Bool) throws -> Any {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { throw error() }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_bind_parameter_count(statement) == parameters.count else {
      throw NSError(domain: "HabitEngine.SQLite", code: 1, userInfo: [NSLocalizedDescriptionKey: "SQL parameter count mismatch."])
    }
    for (offset, value) in parameters.enumerated() {
      let index = Int32(offset + 1)
      let status: Int32
      if value is NSNull { status = sqlite3_bind_null(statement, index) }
      else if let text = value as? String {
        let bytes = text.utf8CString
        status = bytes.withUnsafeBytes { buffer in
          sqlite3_bind_text(statement, index, buffer.baseAddress?.assumingMemoryBound(to: CChar.self), Int32(bytes.count - 1), transient)
        }
      } else if let number = value as? NSNumber {
        let double = number.doubleValue
        guard double.isFinite else { throw error("Non-finite SQL parameter.") }
        if double.rounded() == double && abs(double) <= 9_007_199_254_740_991 {
          status = sqlite3_bind_int64(statement, index, number.int64Value)
        } else { status = sqlite3_bind_double(statement, index, double) }
      } else { throw error("Unsupported SQL parameter.") }
      guard status == SQLITE_OK else { throw error() }
    }
    var result: [[String: Any]] = []
    while true {
      let status = sqlite3_step(statement)
      if status == SQLITE_DONE { break }
      guard status == SQLITE_ROW else { throw error() }
      if rows {
        var row: [String: Any] = [:]
        for column in 0..<sqlite3_column_count(statement) {
          let name = String(cString: sqlite3_column_name(statement, column))
          switch sqlite3_column_type(statement, column) {
          case SQLITE_NULL: row[name] = NSNull()
          case SQLITE_INTEGER: row[name] = sqlite3_column_int64(statement, column)
          case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, column)
          case SQLITE_TEXT:
            let count = Int(sqlite3_column_bytes(statement, column))
            if let bytes = sqlite3_column_text(statement, column) {
              row[name] = String(decoding: UnsafeBufferPointer(start: bytes, count: count), as: UTF8.self)
            } else { row[name] = "" }
          default: throw error("Unsupported SQL result.")
          }
        }
        result.append(row)
      }
    }
    return rows ? result : ["changes": Int(sqlite3_changes(database))]
  }

  private func error(_ message: String? = nil) -> NSError {
    NSError(domain: "HabitEngine.SQLite", code: Int(sqlite3_errcode(database)), userInfo: [NSLocalizedDescriptionKey: message ?? String(cString: sqlite3_errmsg(database))])
  }
}
