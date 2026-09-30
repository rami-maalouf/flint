import { Circle, HStack, Image, Link, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  opacity,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import type { BoardsWidgetProps, WidgetRowProps } from '@/features/widgets/widget-props';

// one widget kind covers every home screen family; the family decides how
// many projection rows render. the widget reads only widget_board_rows
// data handed to it through the timeline - no ad hoc queries.
//
// the marked function executes inside the widget extension's own sandbox:
// every constant and helper it uses must live inside the function body,
// because module-scope values are not serialized with it.
//
// quick actions deep-link to a current-state app flow.
// expo-widgets runs an interactive button's app intent inside the extension
// process (verified on device: `openAppWhenRun: NO`, perform() logged under
// expowidgetstarget) and posts its interaction event to that process's own
// notification center, so the app never observes the press and no validated
// row could be written. per the spec's rule for an action that cannot
// safely execute, the press deep-links instead of silently doing nothing;
// writing in place needs the native executor in the local module.
const HabitSystemBoards = (props: BoardsWidgetProps, environment: WidgetEnvironment) => {
  'widget';
  const family = environment.widgetFamily;
  const limit =
    family === 'systemSmall'
      ? 1
      : family === 'systemLarge'
        ? 7
        : family === 'systemExtraLarge'
          ? 12
          : 3;
  const rows = (props.rows ?? []).slice(0, limit);
  const small = family === 'systemSmall';

  const renderRow = (row: WidgetRowProps) => {
    const daily = row.kind === 'daily';
    // previously stored timelines may predate the explicit completion field.
    const checked = row.checkedToday ?? row.strip[row.strip.length - 1] > 0;
    const actionLabel = daily
      ? props.stale ? `Review ${row.title} in Habit System` : `${checked ? 'Uncheck' : 'Check'} ${row.title}`
      : `Check in to ${row.title}`;
    const actionSymbol = daily
      ? props.stale ? 'arrow.clockwise' : checked ? 'checkmark.circle.fill' : 'circle'
      : 'circle';
    // the truncated title carries the full accessibility title; each
    // control keeps its own label, so the row never collapses into one
    // ambiguous element
    const titleLabel = props.stale
      ? `${row.title}. Open Habit System to refresh.`
      : row.title;
    const days = row.strip.reduce((total, count) => (count > 0 ? total + 1 : total), 0);
    const title = (
        <Link
          destination={`habitsystem://boards/${row.boardId}`}
          modifiers={[accessibilityLabel(titleLabel)]}
        >
          <Text modifiers={[lineLimit(small ? 2 : 1), ...(small ? [font({ weight: 'semibold' })] : [])]}>{row.title}</Text>
        </Link>
    );
    const history = (
        <HStack
          spacing={3}
          modifiers={[accessibilityLabel(`${props.stale ? 'Saved history: ' : ''}${days} of the last 7 days checked in`)]}
        >
          {row.strip.map((count, index) => (
            <Circle
              key={index}
              modifiers={[
                frame({ width: small ? 10 : 8, height: small ? 10 : 8 }),
                foregroundStyle(count > 0 ? row.accentHex : '#787880'),
                opacity(count > 0 ? daily ? 1 : Math.min(1, 0.4 + count * 0.2) : 0.25),
              ]}
            />
          ))}
        </HStack>
    );
    const action = (
        <Link
          destination={daily
            ? `habitsystem://boards/${row.boardId}/quick-action`
            : `habitsystem://boards/${row.boardId}/check-ins/new?source=widget`}
          modifiers={[accessibilityLabel(actionLabel)]}
        >
          <Image systemName={actionSymbol} color={row.accentHex} size={small ? 28 : 20} />
        </Link>
    );
    if (small) {
      return (
        <VStack key={row.boardId} alignment="leading" spacing={8}>
          <HStack>
            <Image systemName={row.symbol as never} color={row.accentHex} size={22} />
            <Spacer />
            {action}
          </HStack>
          <Spacer minLength={0} />
          {title}
          {history}
        </VStack>
      );
    }
    return (
      <HStack key={row.boardId}>
        <Image systemName={row.symbol as never} color={row.accentHex} size={14} />
        {title}
        <Spacer />
        {history}
        {action}
      </HStack>
    );
  };

  // flexible gaps use the widget's height instead of centering a short list.
  const renderColumn = (column: WidgetRowProps[]) => (
    <VStack spacing={0}>
      {column.flatMap((row, index) => index === 0
        ? [renderRow(row)]
        : [<Spacer key={`gap-${row.boardId}`} minLength={8} />, renderRow(row)])}
      {column.length === 1 && !small ? [<Spacer key="remaining-space" minLength={0} />] : []}
    </VStack>
  );

  if (rows.length === 0) {
    return (
      <VStack modifiers={[widgetURL('habitsystem://boards/new'), padding({ all: 12 })]}>
        <Text>Open Habit System to create your first board</Text>
      </VStack>
    );
  }

  if (family === 'systemExtraLarge') {
    // two balanced columns of up to six rows each
    const half = Math.ceil(rows.length / 2);
    return (
      <HStack alignment="top" spacing={16}>
        {renderColumn(rows.slice(0, half))}
        {renderColumn(rows.slice(half))}
      </HStack>
    );
  }

  return renderColumn(rows);
};

export default createWidget('HabitSystemBoards', HabitSystemBoards);
