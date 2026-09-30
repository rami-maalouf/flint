const fs = require('node:fs/promises');
const path = require('node:path');
const { IOSConfig, withAppDelegate, withDangerousMod, withEntitlementsPlist, withFinalizedMod, withInfoPlist, withPodfileProperties, withXcodeProject } = require('expo/config-plugins');
const { generateImageAsync } = require('@expo/image-utils');

const alternateIcons = ['midnight', 'paper'];
const intentSourceName = 'HabitSystemApplicationIntents.swift';

function registerAppShortcuts(appDelegate) {
  if (appDelegate.language !== 'swift') {
    throw new Error('habit-system-apple shortcut registration requires a swift app delegate');
  }
  let contents = appDelegate.contents;
  const launchReturn = /^([ \t]*)return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)[ \t]*$/gm;
  const matches = [...contents.matchAll(launchReturn)];
  if (matches.length !== 1) {
    throw new Error('habit-system-apple could not find one native launch hook for shortcut registration');
  }
  const call = 'HabitSystemApplicationShortcuts.updateAppShortcutParameters()';
  const existingCalls = [...contents.matchAll(/^[ \t]*HabitSystemApplicationShortcuts\.updateAppShortcutParameters\(\)[ \t]*$/gm)];
  if (existingCalls.length > 1 || (existingCalls.length === 1 && (
    existingCalls[0].index >= matches[0].index ||
    contents.slice(existingCalls[0].index + existingCalls[0][0].length, matches[0].index).trim() !== ''
  ))) {
    throw new Error('habit-system-apple found duplicate or misplaced shortcut registration');
  }
  if (existingCalls.length === 0) {
    contents = contents.replace(launchReturn, `$1${call}\n$&`);
  }
  if (!/^(?:internal )?import AppIntents[ \t]*$/m.test(contents)) {
    contents = `import AppIntents\n${contents}`;
  }
  return { ...appDelegate, contents };
}

function configureEntitlements(entitlements, bundleIdentifier, cloudKitEnvironment = 'Development') {
  if (!['Development', 'Production'].includes(cloudKitEnvironment)) {
    throw new Error('habit-system-apple requires a Development or Production cloudkit environment');
  }
  return {
    ...entitlements,
    'com.apple.security.application-groups': [`group.${bundleIdentifier}`],
    'com.apple.developer.icloud-container-identifiers': [`iCloud.${bundleIdentifier}`],
    'com.apple.developer.icloud-services': ['CloudKit'],
    'com.apple.developer.icloud-container-environment': cloudKitEnvironment,
  };
}

function configureInfoPlist(infoPlist, bundleIdentifier) {
  return {
    ...infoPlist,
    HabitSystemAppGroupIdentifier: `group.${bundleIdentifier}`,
    HabitSystemCloudKitContainerIdentifier: `iCloud.${bundleIdentifier}`,
  };
}

async function writeAlternateIcons(projectRoot, catalogDirectory) {
  for (const name of alternateIcons) {
    const directory = path.join(catalogDirectory, `${name}.appiconset`);
    await fs.mkdir(directory, { recursive: true });
    const image = await generateImageAsync({ projectRoot, cacheType: `habit-system-icon-${name}` }, {
      src: path.join(projectRoot, 'assets/images/alternate-icons', `${name}.png`),
      name: 'icon.png', width: 1024, height: 1024,
      resizeMode: 'cover', removeTransparency: true, backgroundColor: '#ffffff',
    });
    await fs.writeFile(path.join(directory, 'icon.png'), image.source);
    await fs.writeFile(path.join(directory, 'Contents.json'), JSON.stringify({
      images: [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { version: 1, author: 'xcode' },
    }, null, 2) + '\n');
  }
}

function withHabitSystemApple(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) throw new Error('habit-system-apple requires ios.bundleIdentifier');

  config = withPodfileProperties(config, (mod) => {
    // precompiled expo modules cannot load against a source-only react native build.
    mod.modResults['ios.buildReactNativeFromSource'] = 'true';
    mod.modResults.EXPO_USE_PRECOMPILED_MODULES = 'false';
    return mod;
  });

  config = withAppDelegate(config, (mod) => {
    mod.modResults = registerAppShortcuts(mod.modResults);
    return mod;
  });

  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults = configureEntitlements(mod.modResults, bundleIdentifier, process.env.HABIT_SYSTEM_CLOUDKIT_ENVIRONMENT);
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults = configureInfoPlist(mod.modResults, bundleIdentifier);
    return mod;
  });
  config = withDangerousMod(config, ['ios', async (mod) => {
    const projectRoot = mod.modRequest.projectRoot;
    const projectName = mod.modRequest.projectName ?? IOSConfig.XcodeUtils.getProjectName(projectRoot);
    const applicationDirectory = path.join(mod.modRequest.platformProjectRoot, projectName);
    await writeAlternateIcons(projectRoot, path.join(applicationDirectory, 'Images.xcassets'));
    await fs.copyFile(path.join(__dirname, intentSourceName), path.join(applicationDirectory, intentSourceName));
    return mod;
  }]);
  config = withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const projectName = mod.modRequest.projectName;
    const { target, uuid } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
    for (const [, configuration] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, target.buildConfigurationList)) {
      // actool generates CFBundleAlternateIcons for iphone and ipad from these sets.
      configuration.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = '"' + alternateIcons.join(' ') + '"';
    }
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/${intentSourceName}`, groupName: projectName,
      project, targetUuid: uuid,
    });
    return mod;
  });
  config = withFinalizedMod(config, ['ios', async (mod) => {
    // widget xcode mods can append embedding phases after the local xcode mod.
    const project = IOSConfig.XcodeUtils.getPbxproj(mod.modRequest.projectRoot);
    const projectName = mod.modRequest.projectName;
    const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
    const devLauncherPhaseName = '"[Expo Dev Launcher] Strip Local Network Keys for Release"';
    const shellPhases = project.hash.project.objects.PBXShellScriptBuildPhase;
    const devLauncherPhases = target.buildPhases
      .filter((reference) => shellPhases?.[reference.value]?.name === devLauncherPhaseName);
    if (devLauncherPhases.length !== 1) {
      throw new Error('habit-system-apple requires exactly one dev launcher network-key phase on the application target');
    }
    const devLauncherReference = devLauncherPhases[0];
    const devLauncherPhase = shellPhases[devLauncherReference.value];
    // the processed plist depends on embedded extensions, so strip only after embedding.
    target.buildPhases = target.buildPhases.filter((reference) => reference !== devLauncherReference);
    target.buildPhases.push(devLauncherReference);
    devLauncherPhase.inputPaths = ['"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"'];
    devLauncherPhase.alwaysOutOfDate = 1;
    await fs.writeFile(project.filepath, project.writeSync());
    return mod;
  }]);
  return config;
}

module.exports = withHabitSystemApple;
module.exports.configureEntitlements = configureEntitlements;
module.exports.configureInfoPlist = configureInfoPlist;
module.exports.writeAlternateIcons = writeAlternateIcons;
