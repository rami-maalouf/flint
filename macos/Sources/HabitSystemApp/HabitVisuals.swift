import SwiftUI

struct HabitHero: View {
  let board: Board
  let subtitle: String
  let today: String?
  let checked: Bool
  let checkIns: Int
  let primaryAction: () -> Void
  let noteAction: () -> Void
  @Environment(\.colorScheme) private var colorScheme
  private var accent: Color { habitAccent(board, colorScheme) }

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(alignment: .top, spacing: 16) {
        Image(systemName: board.symbol)
          .font(.system(size: 29, weight: .medium))
          .foregroundStyle(accent)
          .frame(width: 66, height: 66)
          .background(accent.opacity(colorScheme == .dark ? 0.16 : 0.13), in: RoundedRectangle(cornerRadius: 20))
        VStack(alignment: .leading, spacing: 7) {
          Text(board.title).font(.system(size: 30, weight: .bold, design: .rounded)).fixedSize(horizontal: false, vertical: true)
          Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.top, 3)
        Spacer(minLength: 0)
      }
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center, spacing: 24) { todayStatus; Spacer(minLength: 12); actions }
        VStack(alignment: .leading, spacing: 16) { todayStatus; actions }
      }
    }
    .padding(24)
    .background {
      RoundedRectangle(cornerRadius: 22)
        .fill(Color(nsColor: .controlBackgroundColor))
        .overlay {
          RoundedRectangle(cornerRadius: 22)
            .fill(LinearGradient(colors: [accent.opacity(colorScheme == .dark ? 0.12 : 0.09), .clear], startPoint: .topLeading, endPoint: .bottomTrailing))
        }
    }
    .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(accent.opacity(0.18), lineWidth: 1) }
  }

  private var todayStatus: some View {
    HStack(spacing: 10) {
      Image(systemName: board.archivedAt != nil ? "archivebox" : board.kind == "daily" ? (checked ? "checkmark.circle.fill" : "circle.dotted") : "plus.circle")
        .font(.system(size: 23, weight: .medium))
        .foregroundStyle(checked ? accent : Color.secondary)
      VStack(alignment: .leading, spacing: 3) {
        Text(board.archivedAt != nil ? "History safely kept" : board.kind == "daily" ? (checked ? "You showed up today." : "A little time for yourself.") : "\(checkIns) check-in\(checkIns == 1 ? "" : "s") today")
          .font(.callout.weight(.semibold))
        Text(board.archivedAt != nil ? "Restore this habit to continue." : today.map(dateLabel) ?? "Your daily rhythm")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      if board.archivedAt == nil && board.kind == "daily" && checked {
        Button("Add a Note", action: noteAction).buttonStyle(.borderedProminent).controlSize(.large)
        Button(action: primaryAction) { Label("Uncheck Today", systemImage: "arrow.uturn.backward") }
          .buttonStyle(.bordered).controlSize(.large)
      } else {
        Button(action: primaryAction) {
          Label(board.archivedAt != nil ? "Restore Habit" : board.kind == "daily" ? "Check In" : "Log Check-in",
            systemImage: board.archivedAt != nil ? "arrow.uturn.backward" : "plus")
        }.buttonStyle(.borderedProminent).controlSize(.large)
      }
    }.fixedSize()
  }
}

struct HabitWeekView: View {
  let board: Board
  let days: [Heatmap.Day]
  let onSelect: (String) -> Void
  @Environment(\.colorScheme) private var colorScheme
  private var accent: Color { habitAccent(board, colorScheme) }
  private let names = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
  private var peakCount: Int { max(1, days.map(\.count).max() ?? 1) }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack(alignment: .firstTextBaseline) {
        Text("This week's rhythm").font(.headline)
        Spacer()
        if let first = days.first, let last = days.last {
          Text("\(shortDate(first.date)) - \(shortDate(last.date))").font(.caption).foregroundStyle(.secondary)
        }
      }
      HStack(spacing: 8) {
        ForEach(Array(days.enumerated()), id: \.element.date) { index, day in
          Button { onSelect(day.date) } label: {
            VStack(spacing: 10) {
              Text(names[index % 7]).font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(day.isToday ? Color.primary : Color.secondary)
              if board.kind == "daily" {
                ZStack {
                  Circle().fill(day.count > 0 ? accent.opacity(0.17) : Color.secondary.opacity(day.isFuture ? 0.04 : 0.07))
                  Circle().strokeBorder(day.isToday ? accent : Color.clear, lineWidth: 1.5)
                  if day.count > 0 { Image(systemName: "checkmark").font(.system(size: 19, weight: .semibold)).foregroundStyle(accent) }
                  else { Image(systemName: day.isToday ? "plus" : "minus").font(.system(size: 14, weight: .medium)).foregroundStyle(day.isFuture ? .tertiary : .secondary) }
                }.frame(height: 48).frame(maxWidth: 48)
              } else {
                ZStack(alignment: .bottom) {
                  RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.06))
                  if day.count > 0 {
                    RoundedRectangle(cornerRadius: 8).fill(accent.gradient)
                      .frame(height: max(12, 48 * CGFloat(day.count) / CGFloat(peakCount)))
                  }
                  Text("\(day.count)").font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.primary).frame(maxHeight: .infinity)
                }.frame(height: 48).frame(maxWidth: 48)
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(day.isToday ? accent : .clear, lineWidth: 1.5) }
              }
              Text(day.isToday ? "Today" : dayNumber(day.date)).font(.caption2.weight(day.isToday ? .semibold : .regular))
                .foregroundStyle(day.isToday ? Color.primary : Color.secondary)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(day.isToday ? accent.opacity(0.055) : .clear, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
          }.buttonStyle(.plain).disabled(day.isFuture || board.archivedAt != nil)
          .help("\(dateLabel(day.date)): \(day.count) check-ins. Click to view or add a check-in.")
          .accessibilityLabel("\(dateLabel(day.date)), \(day.isToday ? "today, " : "")\(day.isFuture ? "upcoming" : board.kind == "daily" ? day.count > 0 ? "completed" : "not checked" : "\(day.count) check-ins")")
        }
      }
      HStack(spacing: 6) {
        Image(systemName: "cursorarrow")
        Text(board.archivedAt == nil ? "Select a day to add a check-in or revisit a note." : "A record of the time you made for this habit.")
      }.font(.caption).foregroundStyle(.secondary)
    }.habitSurface()
  }
  private func dayNumber(_ date: String) -> String { String(Int(date.suffix(2)) ?? 0) }
  private func shortDate(_ date: String) -> String { parseDate(date).formatted(.dateTime.month(.abbreviated).day()) }
}

struct HabitYearView: View {
  let board: Board
  let heatmap: Heatmap
  @State private var hovered: Heatmap.Day?
  @State private var gridHeight: CGFloat = 140
  @Environment(\.colorScheme) private var colorScheme
  private var accent: Color { habitAccent(board, colorScheme) }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 5) {
          Text("The bigger picture").font(.headline)
          Text("A year of showing up, one day at a time.").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Text(hovered.map { "\(shortDate($0.date)) · \($0.count) check-in\($0.count == 1 ? "" : "s")" } ?? "Past 365 days")
          .font(.caption).foregroundStyle(.secondary).monospacedDigit()
      }
      GeometryReader { geometry in
        let cell = min(14.0, max(7.0, (geometry.size.width - 28) / CGFloat(max(1, heatmap.weeks.count)) - 3))
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 5) {
            VStack(spacing: 3) {
              Color.clear.frame(height: 16)
              ForEach(0..<7, id: \.self) { index in
                Text(index == 0 ? "M" : index == 2 ? "W" : index == 4 ? "F" : "")
                  .font(.system(size: 9)).foregroundStyle(.tertiary).frame(width: 14, height: cell)
              }
            }
            HStack(alignment: .top, spacing: 3) {
              ForEach(Array(heatmap.weeks.enumerated()), id: \.offset) { index, week in
                VStack(spacing: 3) {
                  Text(monthLabel(week, first: index == 0)).font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize().frame(width: cell, height: 16, alignment: .leading)
                  ForEach(week.days) { day in
                    RoundedRectangle(cornerRadius: 2.5)
                      .fill(fill(day))
                      .frame(width: cell, height: cell)
                      .overlay { RoundedRectangle(cornerRadius: 2.5).strokeBorder(day.isToday ? accent : hovered?.date == day.date ? Color.primary.opacity(0.5) : .clear, lineWidth: 1) }
                      .onHover { entered in hovered = entered ? day : nil }
                      .help("\(dateLabel(day.date)): \(day.count) check-ins\(day.isToday ? ", today" : "")")
                  }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(week.days.map { "\(dateLabel($0.date)): \($0.count) check-ins" }.joined(separator: ". "))
              }
            }
          }.padding(.vertical, 2)
        }
        .defaultScrollAnchor(.trailing)
        .onChange(of: geometry.size.width, initial: true) { _, _ in gridHeight = cell * 7 + 54 }
      }.frame(height: gridHeight)
      HStack(spacing: 5) {
        Text("Your history stays with you.").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Text("Less").font(.caption2).foregroundStyle(.secondary)
        ForEach(0..<5, id: \.self) { level in RoundedRectangle(cornerRadius: 2).fill(level == 0 ? Color.secondary.opacity(0.12) : accent.opacity(0.25 + Double(level) * 0.18)).frame(width: 10, height: 10) }
        Text("More").font(.caption2).foregroundStyle(.secondary)
      }
    }.habitSurface()
  }
  private func fill(_ day: Heatmap.Day) -> Color {
    if day.isFuture { return Color.secondary.opacity(0.035) }
    if day.count == 0 { return Color.secondary.opacity(day.eligible ? 0.12 : 0.045) }
    return accent.opacity(board.kind == "daily" ? 0.85 : min(1, 0.3 + Double(day.count) * 0.18))
  }
  private func monthLabel(_ week: Heatmap.Week, first: Bool) -> String {
    guard let date = week.days.first(where: { $0.date.hasSuffix("-01") }) ?? (first ? week.days.first : nil) else { return "" }
    return parseDate(date.date).formatted(.dateTime.month(.abbreviated))
  }
  private func shortDate(_ date: String) -> String { parseDate(date).formatted(.dateTime.month(.abbreviated).day()) }
}

struct HabitProgressMetrics: View {
  let summary: BoardSummary
  let board: Board
  @Environment(\.colorScheme) private var colorScheme
  private var accent: Color { habitAccent(board, colorScheme) }
  var body: some View {
    HStack(spacing: 12) {
      stat("This month", value: String(summary.currentMonthCount), unit: summary.currentMonthCount == 1 ? "check-in" : "check-ins", symbol: "calendar")
      if board.metricsEnabled {
        stat("Current streak", value: String(summary.currentStreak), unit: summary.currentStreak == 1 ? "day" : "days", symbol: "flame")
        stat("Longest streak", value: String(summary.longestStreak), unit: summary.longestStreak == 1 ? "day" : "days", symbol: "sparkle")
      } else { stat("This week", value: String(summary.currentWeekCount), unit: summary.currentWeekCount == 1 ? "check-in" : "check-ins", symbol: "checkmark.circle") }
    }
  }
  private func stat(_ title: String, value: String, unit: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 13) {
      HStack { Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary); Spacer(minLength: 2); Image(systemName: symbol).font(.caption).foregroundStyle(accent) }
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .firstTextBaseline, spacing: 5) { Text(value).font(.system(size: 30, weight: .semibold, design: .rounded)).monospacedDigit(); Text(unit).font(.caption).foregroundStyle(.secondary) }
        Text(value).font(.system(size: 30, weight: .semibold, design: .rounded)).monospacedDigit()
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 15))
      .overlay { RoundedRectangle(cornerRadius: 15).strokeBorder(Color.primary.opacity(0.045), lineWidth: 1) }
      .accessibilityElement(children: .ignore).accessibilityLabel("\(title): \(value) \(unit)")
  }
}

struct InsightCard<Content: View>: View {
  let title: String
  let subtitle: String
  @ViewBuilder let content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 5) { Text(title).font(.headline); Text(subtitle).font(.caption).foregroundStyle(.secondary) }
      content
    }.frame(maxWidth: .infinity, alignment: .leading).habitSurface()
  }
}

extension View {
  func habitSurface() -> some View {
    padding(20)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 17))
      .overlay { RoundedRectangle(cornerRadius: 17).strokeBorder(Color.primary.opacity(0.055), lineWidth: 1) }
  }
}

func habitAccent(_ board: Board, _ scheme: ColorScheme) -> Color {
  if board.accentHex.uppercased() == "#F2F2F7" && scheme == .light { return Color(hex: "#73737A") }
  return board.color
}
