import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import type { HomeBoardCard } from '@/core/domain/queries';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { deriveBoardColors } from './board-colors';
import { BoardSymbol } from './board-symbol';
import { ProductPressable, useScheme } from '../ui';
import { SevenDayStrip } from './seven-day-strip';
import { DailyStrip } from './daily-strip';
import { BoardCardHistory } from './board-card-history';
import type { BoardLayout } from './use-board-layout';

type BoardCardProps = {
  card: HomeBoardCard;
  layout?: BoardLayout;
  onOpen?: () => void;
  onQuickCheckIn?: () => void;
  quickPending?: boolean;
  editMode?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  testID?: string;
};

export function BoardCard({ card, layout = 'compact', onOpen, onQuickCheckIn, quickPending,
  editMode, onMoveUp, onMoveDown, canMoveUp, canMoveDown, testID }: BoardCardProps) {
  const scheme = useScheme();
  const colors = deriveBoardColors(card.board.accentHex, scheme);
  const compact = layout === 'compact';
  const detailed = layout === 'summary';
  const expanded = !compact && !detailed;
  const checked = card.daily?.checkedToday;
  const weekly = card.daily ? `${card.daily.completedThisWeek}/7 this week` : null;
  const streak = card.currentStreak;
  const showStreak = streak != null && streak >= 2;
  const streakHint = showStreak ? `${streak}-day streak` : null;
  const halfStreak = card.currentHalfStreak;
  const halfStreakHint = halfStreak != null && halfStreak >= 2 ? `${halfStreak}-day half streak` : null;
  const summary = [weekly, streakHint, halfStreakHint].filter(Boolean).join(', ');
  const streakColor = semanticColor('secondaryLabel', scheme);
  const flameColor = scheme === 'dark' ? '#FF9F0A' : '#FF9500';

  const title = (
    <ProductPressable onPress={onOpen} label={card.board.title} hint={`Opens the board${summary ? `. ${summary}` : ''}`}
      disabled={!onOpen} stretch style={expanded ? { paddingHorizontal: 4 } : { flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: expanded ? spacing.sm : spacing.md }}>
        <BoardSymbol symbol={card.board.symbol} color={colors.accent} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="headline" numberOfLines={detailed ? undefined : 1} selectable={false}>
            {card.board.title}
          </AppText>
          {showStreak ? <View testID={`${testID}-streak`} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="flame" size={11} color={flameColor} />
            <AppText variant="footnote" selectable={false}
              style={{ color: streakColor, fontVariant: ['tabular-nums'] }}>
              {streak}
            </AppText>
          </View> : null}
          {halfStreakHint ? (
            <AppText variant="footnote" selectable={false} testID={`${testID}-half-streak`}
              style={{ color: streakColor, fontVariant: ['tabular-nums'] }}>
              {halfStreakHint}
            </AppText>
          ) : null}
        </View>
      </View>
    </ProductPressable>
  );
  const action = editMode ? (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
      <ProductPressable onPress={onMoveUp} disabled={!canMoveUp} label={`Move ${card.board.title} up`} testID={`${testID}-move-up`}>
        <Icon name="arrowUp" color={colors.accent} />
      </ProductPressable>
      <ProductPressable onPress={onMoveDown} disabled={!canMoveDown} label={`Move ${card.board.title} down`} testID={`${testID}-move-down`}>
        <Icon name="arrowDown" color={colors.accent} />
      </ProductPressable>
    </View>
  ) : (
    <ProductPressable onPress={onQuickCheckIn} disabled={quickPending || !onQuickCheckIn}
      role={card.daily ? 'checkbox' : 'button'} checked={checked}
      label={card.daily ? (checked ? 'Checked, double tap to uncheck' : 'Not checked, double tap to check') : `Check in to ${card.board.title}`}
      hint={card.daily ? `${card.board.title}, ${card.today}. ${summary}` : 'Records one check-in for today'}
      testID={`${testID}-quick`} style={{ paddingVertical: expanded ? 8 : 0,
        width: expanded ? undefined : minimumTouchTarget, height: expanded ? undefined : minimumTouchTarget,
        borderRadius: expanded ? 16 : radius.capsule, borderCurve: radiusCurve,
        borderWidth: !expanded && card.daily ? 2 : 0, borderColor: colors.accent,
        backgroundColor: !expanded && card.daily && !checked ? 'transparent' : colors.accent,
        flexDirection: 'row', gap: 6 }}>
      {checked ? <Icon name="checkmark" size={expanded ? 20 : 23} color={colors.onAccent} />
        : !card.daily || expanded ? <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: colors.onAccent }} /> : null}
      {expanded ? <AppText variant="headline" selectable={false} style={{ color: colors.onAccent, flexShrink: 1 }}>
        {checked ? 'Checked' : 'Check In'}
      </AppText> : null}
    </ProductPressable>
  );

  return (
    <View testID={testID} style={{
      flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'center' : 'stretch',
      backgroundColor: card.board.usesTintedBackground ? colors.tintedCardBackground : semanticColor('secondaryGroupedBackground', scheme),
      borderWidth: expanded ? 3 : 1, borderColor: colors.cardBorder,
      borderRadius: compact ? radius.capsule : detailed ? radius.lg : 28,
      borderCurve: radiusCurve, padding: expanded ? spacing.sm : detailed ? spacing.lg : spacing.md,
      paddingHorizontal: expanded ? spacing.sm : spacing.lg, gap: compact ? spacing.sm : spacing.md,
      minHeight: 72, flex: 1, minWidth: 0,
    }}>
      {detailed ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>{title}{action}</View>
          <DailyStrip strip={card.strip} colors={colors} testID={testID} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }}>
            <AppText variant="footnote" style={{ fontVariant: ['tabular-nums'] }}>
              {weekly ?? `${card.strip.reduce((total, count) => total + count, 0)} check-ins in 14 days`}
            </AppText>
          </View>
        </>
      ) : (
        <>
          {title}
          {expanded ? <BoardCardHistory card={card} colors={colors} testID={testID} /> : null}
          {compact && !editMode ? <SevenDayStrip strip={card.strip} colors={colors} barWidth={4} barGap={3} testID={testID} /> : null}
          {action}
        </>
      )}
    </View>
  );
}
