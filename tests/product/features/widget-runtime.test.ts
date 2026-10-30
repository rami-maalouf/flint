import { transformFileSync } from '@babel/core';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createContext, runInContext } from 'node:vm';

import type { RipplesWidgetProps, WidgetRowProps } from '@/features/widgets/widget-props';

type Node = {
  type: string;
  props: {
    children?: Node | Node[];
    modifiers?: {
      $type: string;
      container?: string;
      label?: string;
      style?: { color: string; type: string };
      value?: number;
    }[];
    destination?: string;
    systemName?: string;
    text?: string;
  };
};

// use expo's compiler and extension runtime, so external closure references
// fail here just as they would in the widget process.
const caller = { name: 'metro', platform: 'ios', isDev: true };
const compiled = transformFileSync(resolve('src/platform/widgets/ripples-boards-widget.tsx'), {
  presets: ['babel-preset-expo'],
  caller,
})?.code;
if (!compiled) throw new Error('widget compilation failed');
const moduleContext = createContext({
  exports: {} as { default?: string },
  require: (name: string) => name === 'expo-widgets'
    ? { createWidget: (_name: string, layout: string) => layout }
    : {},
});
runInContext(compiled, moduleContext);
const runtime = createContext({});
const bundleDirectory = mkdtempSync(join(tmpdir(), 'habit-widget-runtime-'));

beforeAll(async () => {
  const widgetPackage = resolve('node_modules/expo-widgets');
  const bundlePath = join(bundleDirectory, 'ExpoWidgets.bundle');
  const cacheDirectory = join(bundleDirectory, 'cache');
  mkdirSync(cacheDirectory);
  // the published package builds this runtime during native compilation; a
  // clean test install uses that same producer without writing to dependencies.
  await promisify(execFile)(process.execPath, [
    require.resolve('expo/bin/cli'), 'export:embed', '--platform', 'ios',
    '--bundle-output', bundlePath, '--entry-file', join(widgetPackage, 'bundle/index.ts'),
    '--dev', 'false', '--skip-server', '--max-workers', '2',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: cacheDirectory, EXPO_OVERRIDE_METRO_CONFIG: join(widgetPackage, 'metro.config.js') },
    timeout: 25000,
  });
  runInContext(readFileSync(bundlePath, 'utf8'), runtime);
  runInContext(`globalThis.__expoWidgetLayout = (${moduleContext.exports.default})`, runtime);
}, 30000);

afterAll(() => { rmSync(bundleDirectory, { recursive: true, force: true }); });

const row: WidgetRowProps = {
  boardId: 'a', kind: 'daily', title: 'Reading', symbol: 'star.fill', accentHex: '#70A7FF',
  strip: [0, 1, 3, 0, 0, 0, 2], checkedToday: true,
};

function render(
  rows: WidgetRowProps[],
  stale = false,
  widgetFamily = 'systemSmall',
  colorScheme: 'light' | 'dark' = 'light',
): Node[] {
  const props: RipplesWidgetProps = { rows, stale };
  const tree = runtime.__expoWidgetRender(props, { colorScheme, widgetFamily }) as Node;
  const flatten = (node: Node): Node[] => [node, ...[node.props.children ?? []].flat().flatMap(flatten)];
  return flatten(tree);
}

function label(node: Node) {
  return node.props.modifiers?.find((modifier) => modifier.$type === 'accessibilityLabel')?.label;
}

describe('serialized widget layout', () => {
  it.each(['systemSmall', 'systemMedium', 'systemLarge', 'systemExtraLarge'] as const)(
    'adopts the WidgetKit container background API for %s',
    (family) => {
      const root = render([row], false, family)[0];
      expect(root.props.modifiers).toContainEqual(expect.objectContaining({
        $type: 'containerBackground',
        container: 'widget',
      }));
    },
  );

  it('adopts the WidgetKit container background API for the empty state', () => {
    const root = render([])[0];
    expect(root.props.modifiers).toContainEqual(expect.objectContaining({
      $type: 'containerBackground',
      container: 'widget',
    }));
  });

  it.each([['light', '#FFFFFF'], ['dark', '#1C1C1E']] as const)(
    'uses the %s WidgetKit container background',
    (colorScheme, color) => {
      const root = render([row], false, 'systemSmall', colorScheme)[0];
      expect(root.props.modifiers).toContainEqual(expect.objectContaining({
        $type: 'containerBackground',
        container: 'widget',
        style: { color, type: 'color' },
      }));
    },
  );

  it('renders Daily completion as binary and opens an explicit fresh-state action', () => {
    const nodes = render([row]);
    const circles = nodes.filter((node) => node.type === 'CircleView');
    expect(circles).toHaveLength(7);
    expect(circles.map((node) => node.props.modifiers?.find((item) => item.$type === 'opacity')?.value)).toEqual([0.25, 1, 1, 0.25, 0.25, 0.25, 1]);
    expect(nodes.find((node) => label(node) === 'Uncheck Reading')?.props.destination).toBe('habitsystemfullstack://boards/a/quick-action');
    expect(nodes.some((node) => node.props.systemName === 'checkmark.circle.fill')).toBe(true);
  });

  it('offers Check for an unchecked Daily and accepts older timeline rows without checkedToday', () => {
    expect(render([{ ...row, checkedToday: false }]).some((node) => label(node) === 'Check Reading')).toBe(true);
    const legacy = { ...row } as Partial<WidgetRowProps>;
    delete legacy.checkedToday;
    expect(render([legacy as WidgetRowProps]).some((node) => label(node) === 'Uncheck Reading')).toBe(true);
  });

  it('makes expired Daily state a neutral review action rather than an authoritative toggle', () => {
    const nodes = render([row], true);
    expect(nodes.find((node) => label(node) === 'Review Reading in Habit System')?.props.destination).toBe('habitsystemfullstack://boards/a/quick-action');
    expect(nodes.some((node) => node.props.systemName === 'arrow.clockwise')).toBe(true);
    expect(nodes.some((node) => node.props.systemName === 'checkmark.circle.fill')).toBe(false);
    expect(nodes.some((node) => label(node)?.startsWith('Saved history:'))).toBe(true);
  });

  it('preserves Count intensity and its Add Check-In fallback with widget provenance', () => {
    const nodes = render([{ ...row, kind: 'count' }]);
    const opacities = nodes.filter((node) => node.type === 'CircleView').map((node) => node.props.modifiers?.find((item) => item.$type === 'opacity')?.value);
    expect(opacities[1]).toBeCloseTo(0.6);
    expect(opacities[2]).toBe(1);
    expect(nodes.find((node) => label(node) === 'Check in to Reading')?.props.destination).toBe('habitsystemfullstack://boards/a/check-ins/new?source=widget');
  });

  it.each([['systemSmall', 1], ['systemMedium', 3], ['systemLarge', 7], ['systemExtraLarge', 12]] as const)('keeps ordered row budget for %s', (family, limit) => {
    const nodes = render(Array.from({ length: 15 }, (_, index) => ({ ...row, boardId: String(index) })), false, family);
    const destinations = nodes.filter((node) => node.type === 'LinkView' && label(node) === 'Reading').map((node) => node.props.destination);
    expect(destinations).toEqual(Array.from({ length: limit }, (_, index) => `habitsystemfullstack://boards/${index}`));
  });
});
