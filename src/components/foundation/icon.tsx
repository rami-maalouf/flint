import { Image } from 'expo-image';
import { Platform, Text } from 'react-native';

// the platform icon mapping boundary: semantic names resolve to an sf symbol
// on ios and to a text glyph everywhere else. later platform work replaces
// the glyph path with compose-native icons.
export const icons = {
  layoutCards: { sfSymbol: "rectangle.grid.1x2", fallbackGlyph: "▤" },
  layoutGrid: { sfSymbol: "square.grid.2x2", fallbackGlyph: "⊞" },
  layoutCompact: { sfSymbol: "rectangle.grid.1x3", fallbackGlyph: "☰" },
  layoutSummary: { sfSymbol: 'rectangle.topthird.inset.filled', fallbackGlyph: '▣' },
  add: { sfSymbol: 'plus', fallbackGlyph: '+' },
  settings: { sfSymbol: 'gearshape.fill', fallbackGlyph: '⚙' },
  stacks: { sfSymbol: 'square.stack.3d.up', fallbackGlyph: '▤' },
  checkmark: { sfSymbol: 'checkmark', fallbackGlyph: '✓' },
  close: { sfSymbol: 'xmark', fallbackGlyph: '×' },
  pencil: { sfSymbol: 'pencil', fallbackGlyph: '✎' },
  analytics: { sfSymbol: 'chart.bar', fallbackGlyph: '▥' },
  checkIns: { sfSymbol: 'checklist', fallbackGlyph: '☑' },
  journal: { sfSymbol: 'book.closed', fallbackGlyph: '▤' },
  chevronLeft: { sfSymbol: 'chevron.left', fallbackGlyph: '‹' },
  chevronRight: { sfSymbol: 'chevron.right', fallbackGlyph: '›' },
  arrowUp: { sfSymbol: 'arrow.up', fallbackGlyph: '↑' },
  arrowDown: { sfSymbol: 'arrow.down', fallbackGlyph: '↓' },
  flameOutline: { sfSymbol: 'flame', fallbackGlyph: '△' },
  flame: { sfSymbol: 'flame.fill', fallbackGlyph: '▲' },
} as const;

export type IconName = keyof typeof icons;

type IconProps = {
  name: IconName;
  size?: number;
  // expo-image tint accepts plain color strings; resolve platform colors to
  // their web-safe values before passing them here
  color?: string;
  // a label makes the icon an accessible image; without one it is decorative
  // and hidden from assistive technology
  label?: string;
  testID?: string;
};

export function Icon({ name, size = 20, color, label, testID }: IconProps) {
  const entry = icons[name];
  const accessibilityProps = label
    ? ({ accessible: true, accessibilityRole: 'image', accessibilityLabel: label } as const)
    : ({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const);

  if (Platform.OS === 'ios') {
    return (
      <Image
        source={`sf:${entry.sfSymbol}`}
        tintColor={color}
        style={{ width: size, height: size }}
        testID={testID}
        {...accessibilityProps}
      />
    );
  }

  return (
    <Text
      style={{ fontSize: size, lineHeight: size, color }}
      testID={testID}
      {...accessibilityProps}
    >
      {entry.fallbackGlyph}
    </Text>
  );
}
