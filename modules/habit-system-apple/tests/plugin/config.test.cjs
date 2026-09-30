const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const withDevLauncher = require('expo-dev-launcher/plugin/build/withDevLauncher').default;
const { getPngInfo } = require('@expo/image-utils');
const { configureEntitlements, configureInfoPlist, writeAlternateIcons } = require('../../plugin');
const withHabitSystemApple = require('../../plugin');

const appDelegateFixture = `internal import Expo
import React

class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    initializeReactNative()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  public override func application(_ app: UIApplication, open url: URL) -> Bool {
    return openExistingLink(url)
  }
}
`;

async function applyAppDelegateMod(contents, language = 'swift') {
  const config = withHabitSystemApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
  return config.mods.ios.appDelegate({
    ...config,
    modRequest: { platform: 'ios', modName: 'appDelegate' },
    modResults: { path: '/fixture/AppDelegate.swift', language, contents },
  });
}

const devLauncherPhaseName = '[Expo Dev Launcher] Strip Local Network Keys for Release';

async function withTemplateProject(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habit-system-project-config-'));
  try {
    const projectPath = path.join(directory, 'ios/HelloWorld.xcodeproj/project.pbxproj');
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const template = execFileSync('tar', ['-xOf', require.resolve('expo/template.tgz'),
      'package/ios/HelloWorld.xcodeproj/project.pbxproj']);
    await fs.writeFile(projectPath, template);
    await action(xcode.project(projectPath).parseSync());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function applyProjectMod(project, includeDevLauncher = true, afterXcode = () => {}) {
  let config = withHabitSystemApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
  if (includeDevLauncher) config = withDevLauncher(config);
  await config.mods.ios.xcodeproj({
    ...config,
    modRequest: { platform: 'ios', modName: 'xcodeproj', projectName: 'HelloWorld' },
    modResults: project,
  });
  afterXcode(project);
  await fs.writeFile(project.filepath, project.writeSync());
  if (config.mods.ios.finalized) {
    await config.mods.ios.finalized({ ...config,
      modRequest: { platform: 'ios', modName: 'finalized', projectName: 'HelloWorld',
        projectRoot: path.resolve(project.filepath, '../../..') }, modResults: {} });
  }
  project.parseSync();
}

test('dev launcher reads the processed plist after embedding without changing its script or other targets', async () => {
  await withTemplateProject(async (project) => {
    let target = project.getFirstTarget();
    const otherTarget = project.generateUuid();
    project.pbxNativeTargetSection()[otherTarget] = {
      ...structuredClone(target.firstTarget), name: 'Widget',
      productType: '"com.apple.product-type.app-extension"', buildPhases: [],
    };
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', devLauncherPhaseName, otherTarget,
      { shellPath: '/bin/sh', shellScript: 'echo widget' });
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', `${devLauncherPhaseName} Extra`, target.uuid,
      { shellPath: '/bin/sh', shellScript: 'echo unrelated' });
    project.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed Foundation Extensions', target.uuid,
      'app_extension');
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', '[CP] Embed Pods Frameworks', target.uuid,
      { shellPath: '/bin/sh', shellScript: 'echo frameworks' });
    await applyProjectMod(project);
    target = project.getFirstTarget();
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase;
    const selected = target.firstTarget.buildPhases.filter((reference) =>
      phases[reference.value]?.name === `"${devLauncherPhaseName}"`);
    assert.equal(selected.length, 1);
    const phase = phases[selected[0].value];
    assert.equal(phase.alwaysOutOfDate, 1);
    assert.deepEqual(phase.inputPaths, ['"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"']);
    assert.deepEqual(phase.outputPaths, []);
    assert.equal(target.firstTarget.buildPhases.at(-1).value, selected[0].value);
    assert.equal(target.firstTarget.buildPhases.at(-2).comment, '[CP] Embed Pods Frameworks');
    const [reference] = target.firstTarget.buildPhases.splice(-1, 1);
    const widgetIndex = target.firstTarget.buildPhases.findIndex((item) => item.comment === 'Embed Foundation Extensions');
    target.firstTarget.buildPhases.splice(widgetIndex, 0, reference);
    phase.inputPaths = [];
    delete phase.alwaysOutOfDate;
    const before = structuredClone(project.hash);
    const expected = structuredClone(before);
    expected.project.objects.PBXShellScriptBuildPhase[selected[0].value].alwaysOutOfDate = 1;
    expected.project.objects.PBXShellScriptBuildPhase[selected[0].value].inputPaths = ['"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"'];
    const expectedPhases = expected.project.objects.PBXNativeTarget[target.uuid].buildPhases;
    const [expectedReference] = expectedPhases.splice(widgetIndex, 1);
    expectedPhases.push(expectedReference);
    await applyProjectMod(project);
    assert.deepEqual(structuredClone(project.hash), expected);
    await applyProjectMod(project);
    assert.deepEqual(structuredClone(project.hash), expected);
  });
});

test('dev launcher ordering is finalized after a later widget xcode mod appends its embedding phase', async () => {
  await withTemplateProject(async (project) => {
    await applyProjectMod(project, true, (current) => {
      current.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed Foundation Extensions',
        current.getFirstTarget().uuid, 'app_extension');
    });
    const references = project.getFirstTarget().firstTarget.buildPhases;
    assert.equal(references.at(-1).comment, devLauncherPhaseName);
    assert.equal(references.at(-2).comment, 'Embed Foundation Extensions');
  });
});

test('unchanged dev launcher script strips only its release values and preserves debug and custom plist entries', async () => {
  await withTemplateProject(async (project) => {
    const config = withDevLauncher({});
    await config.mods.ios.xcodeproj({
      ...config,
      modRequest: { platform: 'ios', modName: 'xcodeproj', projectName: 'HelloWorld' },
      modResults: project,
    });
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase;
    const reference = project.getFirstTarget().firstTarget.buildPhases.find((item) =>
      phases[item.value]?.name === `"${devLauncherPhaseName}"`);
    await fs.writeFile(project.filepath, project.writeSync());
    const upstream = JSON.parse(execFileSync('/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', project.filepath], { encoding: 'utf8' }));
    const upstreamScript = upstream.objects[reference.value].shellScript;
    await applyProjectMod(project);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habit-system-release-plist-'));
    try {
      const plistPath = path.join(directory, 'App With Spaces.app/Info.plist');
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      const scriptPath = path.join(directory, 'strip.sh');
      await fs.writeFile(project.filepath, project.writeSync());
      const serialized = JSON.parse(execFileSync('/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', project.filepath], { encoding: 'utf8' }));
      assert.equal(serialized.objects[reference.value].shellScript, upstreamScript);
      await fs.writeFile(scriptPath, serialized.objects[reference.value].shellScript);
      const defaultDescription = 'Expo Dev Launcher uses the local network to discover and connect to development servers running on your computer.';
      for (const configuration of ['Debug', 'Release']) {
        for (const custom of [false, true]) {
          const original = {
            CFBundleIdentifier: 'studio.orbitlabs.habitsystem',
            NSBonjourServices: custom ? ['_custom._tcp', '_expo._tcp', '_other._udp'] : ['_expo._tcp'],
            NSLocalNetworkUsageDescription: custom ? 'Find my household devices.' : defaultDescription,
          };
          const originalBytes = plist.build(original);
          await fs.writeFile(plistPath, originalBytes);
          execFileSync('/bin/sh', [scriptPath], { env: { ...process.env,
            CONFIGURATION: configuration, TARGET_BUILD_DIR: directory,
            INFOPLIST_PATH: 'App With Spaces.app/Info.plist' } });
          const actualBytes = await fs.readFile(plistPath, 'utf8');
          const expected = configuration === 'Debug' ? original : {
            CFBundleIdentifier: 'studio.orbitlabs.habitsystem',
            ...(custom ? { NSBonjourServices: ['_custom._tcp', '_other._udp'],
              NSLocalNetworkUsageDescription: 'Find my household devices.' } : {}),
          };
          assert.deepEqual({ ...plist.parse(actualBytes) }, expected);
          if (configuration === 'Debug') assert.equal(actualBytes, originalBytes);
          execFileSync('/bin/sh', [scriptPath], { env: { ...process.env,
            CONFIGURATION: configuration, TARGET_BUILD_DIR: directory,
            INFOPLIST_PATH: 'App With Spaces.app/Info.plist' } });
          assert.deepEqual({ ...plist.parse(await fs.readFile(plistPath, 'utf8')) }, expected);
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

test('dev launcher phase configuration fails clearly when the application phase is missing or duplicated', async () => {
  await withTemplateProject(async (project) => {
    await assert.rejects(applyProjectMod(project, false), /exactly one.*dev launcher.*application/i);
    await applyProjectMod(project);
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', devLauncherPhaseName, project.getFirstTarget().uuid,
      { shellPath: '/bin/sh', shellScript: 'echo duplicate' });
    await assert.rejects(applyProjectMod(project), /exactly one.*dev launcher.*application/i);
  });
});

test('native generation keeps react and expo modules in the same source build mode', async () => {
  const apply = async (properties) => {
    const config = withHabitSystemApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
    assert.equal(typeof config.mods.ios.podfileProperties, 'function');
    return (await config.mods.ios.podfileProperties({
      ...config,
      modRequest: { platform: 'ios', modName: 'podfileProperties' },
      modResults: properties,
    })).modResults;
  };
  const existing = { 'expo.jsEngine': 'hermes', 'ios.useFrameworks': 'static',
    'ios.buildReactNativeFromSource': 'false', EXPO_USE_PRECOMPILED_MODULES: 'true' };
  const first = await apply(existing);
  assert.deepEqual(first, { 'expo.jsEngine': 'hermes', 'ios.useFrameworks': 'static',
    'ios.buildReactNativeFromSource': 'true', EXPO_USE_PRECOMPILED_MODULES: 'false' });
  assert.deepEqual(await apply(first), first);
  assert.deepEqual(await apply({}), {
    'ios.buildReactNativeFromSource': 'true', EXPO_USE_PRECOMPILED_MODULES: 'false' });
});

test('native startup registers the three app shortcuts once across repeated prebuilds', async () => {
  const first = (await applyAppDelegateMod(appDelegateFixture)).modResults.contents;
  const second = (await applyAppDelegateMod(first)).modResults.contents;
  const call = 'HabitSystemApplicationShortcuts.updateAppShortcutParameters()';
  assert.equal(second, first);
  assert.equal(first.split(call).length - 1, 1);
  assert.equal(first.split('import AppIntents').length - 1, 1);
  assert.ok(first.indexOf(call) > first.indexOf('initializeReactNative()'));
  assert.ok(first.indexOf(call) < first.indexOf('return super.application(application, didFinishLaunchingWithOptions: launchOptions)'));
  assert.ok(first.includes('return openExistingLink(url)'));
  assert.ok(first.startsWith('import AppIntents\ninternal import Expo'));
});

test('shortcut startup registration fails closed when the native launch hook changes', async () => {
  await assert.rejects(applyAppDelegateMod(appDelegateFixture, 'objc'), /swift app delegate/);
  await assert.rejects(applyAppDelegateMod('import Expo\nclass AppDelegate {}'), /launch hook/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture + appDelegateFixture), /launch hook/);
});

test('shortcut registration rejects duplicate or misplaced executable calls', async () => {
  const call = 'HabitSystemApplicationShortcuts.updateAppShortcutParameters()';
  const registered = (await applyAppDelegateMod(appDelegateFixture)).modResults.contents;
  await assert.rejects(applyAppDelegateMod(registered.replace(call, `${call}\n    ${call}`)), /shortcut registration/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture.replace('return openExistingLink(url)', `${call}\n    return openExistingLink(url)`)), /shortcut registration/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture.replace('    initializeReactNative()', `    ${call}\n    initializeReactNative()`)), /shortcut registration/);
});

test('a commented registration example never suppresses the executable startup call', async () => {
  const call = 'HabitSystemApplicationShortcuts.updateAppShortcutParameters()';
  const source = `// ${call}\n${appDelegateFixture}`;
  const first = (await applyAppDelegateMod(source)).modResults.contents;
  assert.match(first, /\n    HabitSystemApplicationShortcuts\.updateAppShortcutParameters\(\)\n    return super/);
  assert.equal((await applyAppDelegateMod(first)).modResults.contents, first);
});

test('generated shortcut provider uses the statically linked intents without an external package dependency', async () => {
  const projectRoot = path.resolve(__dirname, '../../../..');
  const platformProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'habit-system-native-config-'));
  try {
    const config = withHabitSystemApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
    await config.mods.ios.dangerous({
      ...config,
      modRequest: { platform: 'ios', modName: 'dangerous', projectRoot, platformProjectRoot, projectName: 'fixture' },
      modResults: {},
    });
    const source = await fs.readFile(path.join(platformProjectRoot, 'fixture/HabitSystemApplicationIntents.swift'), 'utf8');
    assert.doesNotMatch(source, /:\s*AppIntentsPackage\b|includedPackages/);
    assert.match(source, /struct HabitSystemApplicationShortcuts: AppShortcutsProvider/);
    const intents = [...source.matchAll(/intent: (HabitSystem\w+Intent)\(\)/g)].map((match) => match[1]);
    assert.deepEqual(intents, ['HabitSystemCheckInIntent', 'HabitSystemRemoveLatestCheckInIntent', 'HabitSystemTodayCheckInsIntent']);
  } finally {
    await fs.rm(platformProjectRoot, { recursive: true, force: true });
  }
});

test('one bundle identifier drives app group, cloudkit and native lookup keys idempotently', () => {
  const bundle = 'studio.orbitlabs.habitsystem';
  const entitlements = configureEntitlements({ 'aps-environment': 'development' }, bundle);
  assert.deepEqual(configureEntitlements(entitlements, bundle), entitlements);
  assert.equal(entitlements['aps-environment'], 'development');
  assert.deepEqual(entitlements['com.apple.security.application-groups'], [`group.${bundle}`]);
  assert.deepEqual(entitlements['com.apple.developer.icloud-container-identifiers'], [`iCloud.${bundle}`]);
  assert.deepEqual(entitlements['com.apple.developer.icloud-services'], ['CloudKit']);
  assert.equal(entitlements['com.apple.developer.icloud-container-environment'], 'Development');
  const plist = configureInfoPlist({ CFBundleDisplayName: 'Habit System' }, bundle);
  assert.deepEqual(configureInfoPlist(plist, bundle), plist);
  assert.equal(plist.HabitSystemAppGroupIdentifier, `group.${bundle}`);
  assert.equal(plist.HabitSystemCloudKitContainerIdentifier, `iCloud.${bundle}`);
  assert.equal(plist.CFBundleDisplayName, 'Habit System');
});

test('cloudkit release environment is explicit and rejects unknown values', () => {
  const bundle = 'studio.orbitlabs.habitsystem';
  const environmentKey = 'com.apple.developer.icloud-container-environment';
  assert.equal(configureEntitlements({}, bundle, 'Production')[environmentKey], 'Production');
  assert.throws(() => configureEntitlements({}, bundle, 'production'), /cloudkit environment/);
  const profiles = require('../../../../eas.json').build;
  assert.equal(profiles.development.env.HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT, 'Development');
  assert.equal(profiles.production.env.HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT, 'Production');
});

test('alternate artwork produces opaque universal 1024px app icon sets on repeat prebuilds', async () => {
  const root = path.resolve(__dirname, '../../../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'habit-system-icons-'));
  try {
    await writeAlternateIcons(root, output);
    await writeAlternateIcons(root, output);
    for (const name of ['midnight', 'paper']) {
      const directory = path.join(output, `${name}.appiconset`);
      const contents = JSON.parse(await fs.readFile(path.join(directory, 'Contents.json'), 'utf8'));
      assert.deepEqual(contents.images, [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]);
      const info = await getPngInfo(path.join(directory, 'icon.png'));
      assert.equal(info.width, 1024);
      assert.equal(info.height, 1024);
      assert.equal(info.bpp, 3);
    }
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('app configuration carries the fork identity and never the ripples identity', () => {
  const root = path.resolve(__dirname, '../../../..');
  const app = require(path.join(root, 'app.json')).expo;
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.name, 'habit-system');
  assert.equal(app.name, 'habit-system');
  assert.equal(app.slug, 'habit-system');
  assert.equal(app.scheme, 'habitsystem');
  assert.equal(app.ios.bundleIdentifier, 'studio.orbitlabs.habitsystem');
  assert.equal(app.ios.infoPlist.CFBundleDisplayName, 'Habit System');
  const widgets = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets')[1];
  assert.equal(widgets.groupIdentifier, 'group.studio.orbitlabs.habitsystem');
  assert.equal(widgets.widgets[0].displayName, 'Habit System');
  assert.equal(widgets.widgets[0].name, 'HabitSystemBoards');
  assert.equal(widgets.widgets[0].description, 'Your boards with seven-day strips and quick check-in.');
  // the app group is duplicated as a typescript constant; it must not drift from the plugin-derived value
  const databaseSource = require('node:fs').readFileSync(path.join(root, 'src/platform/database/index.ts'), 'utf8');
  assert.match(databaseSource, /appGroupId = 'group\.studio\.orbitlabs\.habitsystem'/);
  const transportSource = require('node:fs').readFileSync(path.join(root, 'modules/habit-system-apple/ios/CloudKitTransport.swift'), 'utf8');
  assert.match(transportSource, /static let zoneName = "habit-system"/);
  const podspec = require('node:fs').readFileSync(path.join(root, 'modules/habit-system-apple/ios/HabitSystemApple.podspec'), 'utf8');
  assert.match(podspec, /s\.homepage\s*=\s*'https:\/\/github\.com\/rami-maalouf\/habit-system'/);
  assert.match(podspec, /git: 'https:\/\/github\.com\/rami-maalouf\/habit-system\.git'/);
  const widgetSource = require('node:fs').readFileSync(path.join(root, 'src/platform/widgets/boards-widget.tsx'), 'utf8');
  assert.match(widgetSource, /createWidget\('HabitSystemBoards'/);
  assert.doesNotMatch(widgetSource, /habittracker:\/\//);
  const intentsSource = require('node:fs').readFileSync(path.join(root, 'modules/habit-system-apple/ios/Intents/HabitSystemAppIntents.swift'), 'utf8');
  assert.doesNotMatch(intentsSource, /RipplesBoards/);
  assert.match(intentsSource, /reloadTimelines\(ofKind: "HabitSystemBoards"\)/);
  assert.equal(app.extra.eas.projectId, '07481ea0-9f44-4f24-ad3c-fd889569cade');
  assert.equal(app.updates.url, `https://u.expo.dev/${app.extra.eas.projectId}`);
  const serialized = JSON.stringify(app) + JSON.stringify(pkg);
  assert.doesNotMatch(serialized, /habittracker|habit-tracker|1e477943/);
});
