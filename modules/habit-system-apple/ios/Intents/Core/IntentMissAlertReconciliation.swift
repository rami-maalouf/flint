import Foundation

struct IntentMissReconciliationResult {
  var changed = false
  var error: String?
}

@MainActor final class IntentMissAlertReconciliation {
  private let executor: IntentExecutor
  private let center: IntentMissNotificationCenter
  private let foreground: () -> Bool
  private var store: IntentMissAlertStore { .init(executor: executor) }
  private var time: IntentMissTime { .init(instant: executor.now(), zone: executor.zone(), foreground: foreground()) }

  private struct Qualified {
    let evidence: IntentMissEvidence?
    let row: IntentMissRow?
    let time: IntentMissTime
    let valid: Bool
  }
  private struct Attempt {
    let reserved: IntentMissRow
    let prior: IntentMissRow?
    let request: IntentMissRequest
    let current: () -> Bool
  }

  init(executor: IntentExecutor, center: IntentMissNotificationCenter, foreground: @escaping () -> Bool) {
    self.executor = executor
    self.center = center
    self.foreground = foreground
  }

  // post-commit work never changes the successful command or its receipt.
  func run(checkInId: String) async -> IntentMissReconciliationResult {
    var result = IntentMissReconciliationResult()
    do {
      try Task.checkCancellation()
      let board = try store.boardId(checkInId: checkInId)
      let pending = try await center.pending()
      try Task.checkCancellation()
      let presented = try await center.presented()
      try Task.checkCancellation()
      let owned = pending.filter { IntentMissPair.parse($0.identifier)?.boardId == board }
      var withheld = Set<IntentMissPair>()
      for observed in owned {
        let pair = IntentMissPair.parse(observed.identifier)!
        let qualified = try qualify(pair)
        if qualified.row?.identifier != observed.identifier { withheld.insert(pair) }
        guard qualified.row?.identifier == observed.identifier, observed.content != nil, qualified.valid else {
          try await center.cancel(observed.identifier)
          continue
        }
        if let row = qualified.row, ["pending", "error"].contains(row.status) {
          result.changed = try save(row, status: "scheduled", identifier: row.identifier) || result.changed
        }
        try await refresh(observed, result: &result)
      }
      for identifier in Set(presented) {
        guard let pair = IntentMissPair.parse(identifier), pair.boardId == board else { continue }
        let changed = try store.transaction(true) { database in
          guard let row = try store.row(database, pair), row.identifier == identifier,
            ["pending", "error"].contains(row.status) else { return false }
          return try store.replace(database, expected: row, next: .init(pair: pair, status: "scheduled", identifier: identifier))
        }
        result.changed = changed || result.changed
      }
      // only a clock/zone retirement can replan an undispatched attempt in this invocation.
      for _ in 0..<3 {
        try Task.checkCancellation()
        let permission = try await center.authorization()
        try Task.checkCancellation()
        let (attempt, changed) = try store.transaction(true) { database -> (Attempt?, Bool) in
          let now = time
          guard let evidence = try store.evidence(database, boardId: board, pairs: [], time: now),
            let content = try IntentMissAlerts.candidate(evidence, time: now), !withheld.contains(content.pair) else { return (nil, false) }
          let prior = try store.row(database, content.pair)
          guard prior?.identifier == nil, prior?.status != "denied" else { return (nil, false) }
          let next = IntentMissRow(pair: content.pair, status: permission == .denied ? "denied" : "pending",
            identifier: permission == .granted ? content.identifier : nil)
          let attempt: Attempt?
          if permission == .granted {
            let request = IntentMissRequest(content: content, trigger: try IntentMissAlerts.trigger(now), zone: now.zone)
            attempt = try .init(reserved: next, prior: prior, request: request,
              current: guardFor(request, board: evidence.board, time: now))
          } else { attempt = nil }
          guard try store.replace(database, expected: prior, next: next) else { return (nil, false) }
          return (attempt, true)
        }
        result.changed = changed || result.changed
        guard let attempt else { break }
        let outcome = await center.put(attempt.request, replacing: nil, isCurrent: attempt.current)
        let next: IntentMissRow
        switch outcome {
        case .accepted, .unchanged: next = .init(pair: attempt.reserved.pair, status: "scheduled", identifier: attempt.reserved.identifier)
        case .notAccepted: next = .init(pair: attempt.reserved.pair, status: "error", identifier: nil)
        case .unknown: next = .init(pair: attempt.reserved.pair, status: "error", identifier: attempt.reserved.identifier)
        case .retired: next = attempt.prior ?? .init(pair: attempt.reserved.pair, status: "pending", identifier: nil)
        }
        result.changed = try store.transaction(true) { try store.replace($0, expected: attempt.reserved, next: next) } || result.changed
        if outcome == .notAccepted || outcome == .unknown { result.error = "Miss alerts could not be updated." }
        if outcome == .retired {
          if !attempt.current() && !Task.isCancelled { continue }
        } else {
          try await cancelIfInvalid(attempt.reserved.pair)
        }
        break
      }
    } catch {
      result.error = "Miss alerts could not be updated."
    }
    return result
  }

  private func qualify(_ pair: IntentMissPair) throws -> Qualified {
    try store.transaction { database in
      let now = time
      let evidence = try store.evidence(database, boardId: pair.boardId, pairs: [pair], time: now)
      return try .init(evidence: evidence, row: store.row(database, pair), time: now,
        valid: IntentMissAlerts.valid(pair, evidence: evidence, time: now))
    }
  }

  private func save(_ row: IntentMissRow, status: String, identifier: String?) throws -> Bool {
    try store.transaction(true) { try store.replace($0, expected: row, next: .init(pair: row.pair, status: status, identifier: identifier)) }
  }

  private func refresh(_ observed: IntentMissPending, result: inout IntentMissReconciliationResult) async throws {
    guard let content = observed.content, let future = observed.nextFire, future.isFinite else { return }
    for _ in 0..<3 {
      let qualified = try qualify(content.pair)
      guard let row = qualified.row, row.identifier == observed.identifier, qualified.valid,
        let board = qualified.evidence?.board, future > qualified.time.instant else { return }
      let request = IntentMissRequest(content: .init(pair: content.pair, title: board.title),
        trigger: try IntentMissAlerts.trigger(qualified.time), zone: qualified.time.zone)
      let current = try guardFor(request, board: board, time: qualified.time)
      let outcome = await center.put(request, replacing: observed, isCurrent: current)
      if outcome == .accepted || outcome == .unchanged {
        result.changed = try save(row, status: "scheduled", identifier: row.identifier) || result.changed
      } else if outcome == .notAccepted || outcome == .unknown {
        result.changed = try save(row, status: "error", identifier: row.identifier) || result.changed
        result.error = "Miss alerts could not be updated."
      }
      if outcome == .retired {
        if !current() && !Task.isCancelled { continue }
      } else {
        try await cancelIfInvalid(content.pair)
      }
      return
    }
  }

  private func cancelIfInvalid(_ pair: IntentMissPair) async throws {
    let qualified = try qualify(pair)
    if !qualified.valid { try await center.cancel(pair.identifier) }
  }

  private func guardFor(_ request: IntentMissRequest, board: IntentMissBoard, time: IntentMissTime) throws -> () -> Bool {
    let today = try IntentCalendar.logicalDate(utcMs: time.instant, zone: time.zone, startMinute: board.startMinute)
    return {
      let now = self.time
      return !Task.isCancelled && now.zone == request.zone && (try? IntentMissAlerts.trigger(now)) == request.trigger &&
        (try? IntentCalendar.logicalDate(utcMs: now.instant, zone: now.zone, startMinute: board.startMinute)) == today
    }
  }
}
