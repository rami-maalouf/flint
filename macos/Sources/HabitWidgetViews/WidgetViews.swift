import SwiftUI
import WidgetKit
import HabitWidgetData

public enum HabitWidgetStyle {
  case activity, week, today
}

public struct HabitWidgetView: View {
  private let style: HabitWidgetStyle
  private let snapshot: WidgetSnapshot?
  private let selectedHabit: WidgetHabit?
  private let family: WidgetFamily
  private let isStale: Bool
  private let habitHeader: AnyView?

  public init(style: HabitWidgetStyle, snapshot: WidgetSnapshot?, selectedHabit: WidgetHabit?, family: WidgetFamily, isStale: Bool, habitHeader: AnyView? = nil) {
    self.style = style
    self.snapshot = snapshot
    self.selectedHabit = selectedHabit
    self.family = family
    self.isStale = isStale
    self.habitHeader = habitHeader
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Group {
        if let snapshot, !snapshot.habits.isEmpty {
          switch style {
          case .today:
            TodayWidget(snapshot: snapshot, family: family, stale: isStale)
          case .activity, .week:
            if let habit = selectedHabit {
              if style == .activity { ActivityWidget(habit: habit, family: family, stale: isStale, habitHeader: habitHeader) }
              else { WeekWidget(habit: habit, family: family, stale: isStale, habitHeader: habitHeader) }
            } else {
              VStack(alignment: .leading, spacing: 10) {
                habitHeader
                WidgetUnavailableState(family: family, canCycle: habitHeader != nil)
              }
            }
          }
        } else {
          WidgetEmptyState(family: family)
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      if let snapshot, !snapshot.habits.isEmpty {
        Text(savedLabel(snapshot)).font(.system(size: 8)).foregroundStyle(.secondary).lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .privacySensitive()
  }

  private func savedLabel(_ snapshot: WidgetSnapshot) -> String {
    let formatter = DateFormatter()
    formatter.timeZone = TimeZone(identifier: snapshot.timeZoneID)
    formatter.setLocalizedDateFormatFromTemplate("MMM d jm")
    return "Saved \(formatter.string(from: snapshot.generatedAt))"
  }
}

private struct ActivityWidget: View {
  let habit: WidgetHabit
  let family: WidgetFamily
  let stale: Bool
  var habitHeader: AnyView?
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  private var small: Bool { family == .systemSmall }
  private var large: Bool { family == .systemLarge || family == .systemExtraLarge }
  private var tint: Color { widgetTint(habit.accentHex, scheme, renderingMode) }
  private var visibleWeeks: [[WidgetDay]] { Array(habit.weeks.suffix(large ? 53 : small ? 14 : 40)) }

  var body: some View {
    VStack(alignment: .leading, spacing: small ? 8 : 10) {
      if let habitHeader { habitHeader }
      else { HabitWidgetHeader(habit: habit, tint: tint, large: large) }
      if large {
        Text("A year, one day at a time.").font(.caption).foregroundStyle(.secondary)
        VStack(spacing: 16) {
          let split = (visibleWeeks.count + 1) / 2
          WidgetActivityGrid(weeks: Array(visibleWeeks.prefix(split)), tint: tint, daily: habit.kind == "daily", stale: stale, monthLabels: true)
          WidgetActivityGrid(weeks: Array(visibleWeeks.dropFirst(split)), tint: tint, daily: habit.kind == "daily", stale: stale, monthLabels: true)
        }.frame(maxHeight: .infinity)
        Divider().opacity(0.5)
        HStack(alignment: .firstTextBaseline) {
          if let streak = habit.currentStreak {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
              Text("\(streak)").font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit()
              Text(stale ? "day streak at snapshot" : "day streak").font(.caption).foregroundStyle(.secondary)
            }
          } else { Text("Every check-in counts.").font(.caption).foregroundStyle(.secondary) }
          Spacer(minLength: 6)
          Image(systemName: "square.grid.3x3.fill").foregroundStyle(tint).widgetAccentable()
        }
      } else {
        WidgetActivityGrid(weeks: visibleWeeks, tint: tint, daily: habit.kind == "daily", stale: stale, monthLabels: !small)
          .frame(maxHeight: .infinity)
        if stale { WidgetStaleLabel(compact: small) }
        else {
          HStack(spacing: 4) {
            if let streak = habit.currentStreak {
              Image(systemName: "flame").foregroundStyle(tint).widgetAccentable()
              Text("\(streak) day\(streak == 1 ? "" : "s")").fontWeight(.medium)
            } else { Text(shortWidgetDate(habit.logicalDate)) }
            Spacer(minLength: 4)
            Text("\(visibleWeeks.count) weeks").foregroundStyle(.secondary)
          }.font(.caption2)
        }
      }
      if stale && large { WidgetStaleLabel(compact: false) }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct WeekWidget: View {
  let habit: WidgetHabit
  let family: WidgetFamily
  let stale: Bool
  var habitHeader: AnyView?
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  private var small: Bool { family == .systemSmall }
  private var large: Bool { family == .systemLarge || family == .systemExtraLarge }
  private var tint: Color { widgetTint(habit.accentHex, scheme, renderingMode) }

  var body: some View {
    VStack(alignment: .leading, spacing: small ? 8 : 12) {
      if let habitHeader { habitHeader }
      else { HabitWidgetHeader(habit: habit, tint: tint, large: large) }
      if small {
        HStack(alignment: .center, spacing: 9) {
          focusMark(size: 37)
          VStack(alignment: .leading, spacing: 2) {
            Text(status).font(.system(size: 12, weight: .semibold)).lineLimit(2)
            Text(shortWidgetDate(habit.logicalDate)).font(.system(size: 9)).foregroundStyle(.secondary)
          }
        }.frame(maxHeight: .infinity, alignment: .center)
        WeekCells(days: habit.week, tint: tint, daily: habit.kind == "daily", compact: true, stale: stale)
      } else if large {
        HStack(spacing: 15) {
          focusMark(size: 58)
          VStack(alignment: .leading, spacing: 4) {
            Text(status).font(.title3.weight(.semibold))
            Text(shortWidgetDate(habit.logicalDate)).font(.caption).foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
        }.padding(.vertical, 3)
        WeekCells(days: habit.week, tint: tint, daily: habit.kind == "daily", compact: false, stale: stale)
        Divider().opacity(0.5)
        HStack {
          Text("Recent weeks").font(.caption.weight(.medium))
          Spacer()
          if let streak = habit.currentStreak {
            Label("\(streak) day\(streak == 1 ? "" : "s")\(stale ? " saved" : "")", systemImage: "flame").font(.caption).foregroundStyle(.secondary)
          }
        }
        WidgetActivityGrid(weeks: Array(habit.weeks.suffix(20)), tint: tint, daily: habit.kind == "daily", stale: stale, monthLabels: false)
          .frame(maxHeight: .infinity)
      } else {
        HStack(spacing: 20) {
          VStack(alignment: .center, spacing: 5) {
            focusMark(size: 38)
            Text(stale ? "Saved" : habit.kind == "daily" ? (habit.checkedToday ? "Checked" : "Ready") : "\(habit.todayCount) today")
              .font(.system(size: 10, weight: .medium)).multilineTextAlignment(.center).lineLimit(1).minimumScaleFactor(0.8)
          }.frame(width: 62)
          WeekCells(days: habit.week, tint: tint, daily: habit.kind == "daily", compact: false, stale: stale)
        }.frame(maxHeight: .infinity)
      }
      if stale { WidgetStaleLabel(compact: small) }
      else if !small && !large {
        HStack {
          Text(shortWidgetDate(habit.logicalDate)).foregroundStyle(.secondary)
          Spacer()
          if let streak = habit.currentStreak { Label("\(streak)-day streak", systemImage: "flame").foregroundStyle(.secondary) }
        }.font(.caption2)
      }
    }
  }

  private var status: String {
    if stale { return "Saved activity" }
    if habit.kind == "daily" { return habit.checkedToday ? "Checked today" : "A moment for you" }
    return "\(habit.todayCount) today"
  }

  private func focusMark(size: CGFloat) -> some View {
    ZStack {
      Circle().fill(tint.opacity(0.13))
      if stale {
        Image(systemName: "clock.arrow.circlepath").font(.system(size: size * 0.38, weight: .medium)).foregroundStyle(.secondary)
      } else if habit.kind == "daily" {
        Image(systemName: habit.checkedToday ? "checkmark" : "plus")
          .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(tint).widgetAccentable()
      } else {
        Text("\(habit.todayCount)").font(.system(size: size * 0.44, weight: .semibold, design: .rounded)).minimumScaleFactor(0.5).lineLimit(1).foregroundStyle(tint).widgetAccentable()
      }
    }.frame(width: size, height: size)
    .accessibilityLabel(status)
  }
}

private struct TodayWidget: View {
  let snapshot: WidgetSnapshot
  let family: WidgetFamily
  let stale: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var renderingMode
  private var small: Bool { family == .systemSmall }
  private var large: Bool { family == .systemLarge || family == .systemExtraLarge }
  private var limit: Int { large ? 8 : small ? 3 : 4 }
  private var visible: [WidgetHabit] { Array(snapshot.habits.prefix(limit)) }

  var body: some View {
    VStack(alignment: .leading, spacing: large ? 13 : 9) {
      HStack(alignment: .firstTextBaseline) {
        Text(stale ? "Saved habits" : "Today").font(large ? .title2.weight(.bold) : .headline)
        Spacer(minLength: 4)
        if !small { Text(snapshotDate).font(.caption).foregroundStyle(.secondary) }
      }
      if large {
        Text(stale ? "Your last saved view" : "Small steps. A steady rhythm.").font(.caption).foregroundStyle(.secondary)
      }
      if family == .systemMedium {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 12) {
          ForEach(visible) { habit in row(habit, spacious: false) }
        }.frame(maxHeight: .infinity, alignment: .center)
      } else {
        VStack(spacing: large ? 11 : 8) {
          ForEach(visible) { habit in row(habit, spacious: large) }
        }.frame(maxHeight: .infinity, alignment: .top)
      }
      if stale { WidgetStaleLabel(compact: small) }
      else {
        HStack(spacing: 4) {
          Image(systemName: "circle.grid.2x2.fill").foregroundStyle(renderingMode == .fullColor ? .orange : .primary).widgetAccentable()
          Text("\(snapshot.balance) coins").fontWeight(.medium).monospacedDigit()
          Spacer(minLength: 3)
          if snapshot.habits.count > visible.count { Text("+\(snapshot.habits.count - visible.count) more").foregroundStyle(.secondary) }
          else if !small { Image(systemName: "arrow.up.right").foregroundStyle(.secondary) }
        }.font(.caption2)
      }
    }
  }

  private func row(_ habit: WidgetHabit, spacious: Bool) -> some View {
    let tint = widgetTint(habit.accentHex, scheme, renderingMode)
    return HStack(spacing: spacious ? 10 : 7) {
      Image(systemName: stale ? "clock" : habit.kind == "daily" ? (habit.checkedToday ? "checkmark.circle.fill" : "circle") : habit.symbol)
        .font(.system(size: spacious ? 18 : 14, weight: .medium))
        .foregroundStyle(stale ? Color.secondary : tint).widgetAccentable(!stale)
        .frame(width: spacious ? 25 : 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(habit.title).font(.system(size: spacious ? 13 : 11, weight: .medium)).lineLimit(1)
        if !stale && habit.kind == "count" && (spacious || family == .systemMedium) {
          Text("\(habit.todayCount) check-in\(habit.todayCount == 1 ? "" : "s")")
            .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      if habit.kind == "count" && small && !stale {
        Text("\(habit.todayCount)").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(habit.title), \(stale ? "saved activity on \(shortWidgetDate(habit.logicalDate))" : habit.kind == "daily" ? habit.checkedToday ? "checked today" : "not checked today" : "\(habit.todayCount) check-ins today")")
  }

  private var snapshotDate: String {
    let formatter = DateFormatter()
    formatter.timeZone = TimeZone(identifier: snapshot.timeZoneID)
    formatter.setLocalizedDateFormatFromTemplate("MMM d")
    return formatter.string(from: snapshot.generatedAt)
  }
}

private struct HabitWidgetHeader: View {
  let habit: WidgetHabit
  let tint: Color
  let large: Bool
  var body: some View {
    HStack(alignment: .center, spacing: large ? 9 : 7) {
      Image(systemName: habit.symbol).font(.system(size: large ? 20 : 14, weight: .medium))
        .foregroundStyle(tint).widgetAccentable()
      Text(habit.title).font(large ? .title3.weight(.semibold) : .system(size: 12, weight: .semibold)).lineLimit(large ? 2 : 1)
      Spacer(minLength: 0)
    }.accessibilityElement(children: .combine)
  }
}

private struct WeekCells: View {
  let days: [WidgetDay]
  let tint: Color
  let daily: Bool
  let compact: Bool
  let stale: Bool
  private let names = ["M", "T", "W", "T", "F", "S", "S"]
  var body: some View {
    HStack(spacing: compact ? 3 : 5) {
      ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
        VStack(spacing: compact ? 4 : 6) {
          Text(names[index % 7]).font(.system(size: compact ? 8 : 9, weight: .medium))
            .foregroundStyle(day.isToday && !stale ? .primary : .secondary)
          ZStack {
            RoundedRectangle(cornerRadius: compact ? 3 : 7)
              .fill(day.count > 0 ? tint.opacity(compact ? 0.8 : 0.17) : Color.primary.opacity(day.isFuture ? 0.035 : 0.075))
              .widgetAccentable(day.count > 0)
            if !compact {
              if daily && day.count > 0 {
                Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(tint).widgetAccentable()
              } else if !daily && !day.isFuture {
                Text("\(day.count)").font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundStyle(day.count > 0 ? .primary : .secondary).minimumScaleFactor(0.5).lineLimit(1)
              } else { Text("·").foregroundStyle(.tertiary) }
            }
          }.frame(height: compact ? 11 : 30)
          .overlay { RoundedRectangle(cornerRadius: compact ? 3 : 7).strokeBorder(day.isToday && !stale ? tint : .clear, lineWidth: 1) }
          if !compact {
            Text(String(Int(day.date.suffix(2)) ?? 0)).font(.system(size: 9)).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(shortWidgetDate(day.date)), \(day.count) check-ins\(day.isToday && !stale ? ", today" : "")")
      }
    }
  }
}

private struct WidgetActivityGrid: View {
  let weeks: [[WidgetDay]]
  let tint: Color
  let daily: Bool
  let stale: Bool
  let monthLabels: Bool
  var body: some View {
    GeometryReader { geometry in
      let gap: CGFloat = weeks.count > 20 ? 2.2 : 2.8
      let labelHeight: CGFloat = monthLabels ? 14 : 0
      let width = (geometry.size.width - gap * CGFloat(max(0, weeks.count - 1))) / CGFloat(max(1, weeks.count))
      let height = (geometry.size.height - labelHeight - gap * 6) / 7
      let side = max(1, min(width, height))
      HStack(alignment: .top, spacing: gap) {
        ForEach(Array(weeks.enumerated()), id: \.offset) { index, week in
          VStack(spacing: gap) {
            if monthLabels {
              Text(month(week, first: index == 0)).font(.system(size: 8)).foregroundStyle(.secondary)
                .fixedSize().frame(width: side, height: labelHeight - gap, alignment: .leading)
            }
            ForEach(week) { day in
              RoundedRectangle(cornerRadius: min(2.2, side / 4))
                .fill(day.count > 0 ? tint.opacity(daily ? 0.84 : min(1, 0.3 + Double(day.count) * 0.17)) : Color.primary.opacity(day.eligible && !day.isFuture ? 0.09 : 0.035))
                .widgetAccentable(day.count > 0)
                .frame(width: side, height: side)
                .overlay { RoundedRectangle(cornerRadius: min(2.2, side / 4)).strokeBorder(day.isToday && !stale ? tint : .clear, lineWidth: 1) }
            }
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(week.map { "\(shortWidgetDate($0.date)): \($0.count) check-ins" }.joined(separator: ". "))
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
  }
  private func month(_ week: [WidgetDay], first: Bool) -> String {
    let showInitialMonth = first && (week.first.flatMap { Int($0.date.suffix(2)) } ?? 31) <= 14
    guard let day = week.first(where: { $0.date.hasSuffix("-01") }) ?? (showInitialMonth ? week.first : nil),
      let number = Int(day.date.dropFirst(5).prefix(2)), (1...12).contains(number) else { return "" }
    return Calendar.current.shortMonthSymbols[number - 1]
  }
}

private struct WidgetStaleLabel: View {
  let compact: Bool
  var body: some View {
    Label("Open app to refresh", systemImage: "arrow.clockwise")
      .font(.system(size: compact ? 9 : 10, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
      .accessibilityLabel("This widget contains saved data. Open Habit System to refresh.")
  }
}

private struct WidgetEmptyState: View {
  let family: WidgetFamily
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: "leaf").font(.system(size: family == .systemSmall ? 22 : 28, weight: .light)).foregroundStyle(.secondary)
      Text("Make a little progress.").font(family == .systemSmall ? .headline : .title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
      Text("Open Habit System to choose your first habit.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

private struct WidgetUnavailableState: View {
  let family: WidgetFamily
  var canCycle = false
  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Image(systemName: "square.dashed").font(.system(size: family == .systemSmall ? 22 : 28, weight: .light)).foregroundStyle(.secondary)
      Text("Habit unavailable").font(.headline).fixedSize(horizontal: false, vertical: true)
      Text(canCycle ? "Click Next habit above." : "Choose a habit in Edit Widget.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

private func widgetTint(_ hex: String, _ scheme: ColorScheme, _ mode: WidgetRenderingMode) -> Color {
  if mode != .fullColor { return .primary }
  if hex.uppercased() == "#F2F2F7" && scheme == .light { return Color(red: 0.45, green: 0.45, blue: 0.48) }
  let value = UInt64(hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted), radix: 16) ?? 0x78D98B
  return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}

private func shortWidgetDate(_ value: String) -> String {
  let parser = DateFormatter()
  parser.calendar = Calendar(identifier: .gregorian)
  parser.locale = Locale(identifier: "en_US_POSIX")
  parser.timeZone = TimeZone(secondsFromGMT: 0)
  parser.dateFormat = "yyyy-MM-dd"
  guard let date = parser.date(from: value) else { return value }
  let output = DateFormatter()
  output.calendar = Calendar(identifier: .gregorian)
  output.timeZone = TimeZone(secondsFromGMT: 0)
  output.setLocalizedDateFormatFromTemplate("MMM d")
  return output.string(from: date)
}
