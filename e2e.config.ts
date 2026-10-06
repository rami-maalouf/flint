import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { mobile } from '@e2e-dev/mobile';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { easSimulators } from '@e2e-dev/eas';
import { createAnthropic } from '@ai-sdk/anthropic';
import { localIosDevice } from './tests/e2e/local-ios-device';

// separate local daemons prevent runner versions in other projects from colliding.
process.env.AGENT_DEVICE_STATE_DIR ??= `${process.cwd()}/.artifacts/agent-device`;

// where the tests run.
// - default: the development app on Habit System QA. E2E_TARGET=device selects a
//   connected physical iphone. E2E_DEVICE picks a device of that kind by name or udid.
// - E2E_EAS_SIMULATOR=1: lease EAS Simulator sessions through @e2e-dev/eas, one per
//   worker, each with the build E2E_BUILD_ID installed. the provider reads EXPO_TOKEN (or
//   the eas login on this machine) and the project id from app.json. E2E_WORKERS sets how
//   many cloud iphones run at once; test files spread across them.
//   tests/e2e/eas-simulator-provider.ts is the hand-written provider this replaced; it is
//   kept for reference and not loaded.
const onEas = process.env.E2E_EAS_SIMULATOR === '1';
// the eas sim profile uses the base id; local development builds use the .dev id.
// override when testing a build with a different identity.
const appId = process.env.E2E_APP_ID ||
  (onEas ? 'studio.orbitlabs.habitsystem' : 'studio.orbitlabs.habitsystem.dev');

const iphone = mobile({
  platform: 'ios',
  device: onEas
    ? easSimulators({
        buildId: process.env.E2E_BUILD_ID,
        device: process.env.E2E_EAS_DEVICE,
        maxDurationMinutes: 30,
      })
    : localIosDevice(process.env.E2E_TARGET, process.env.E2E_DEVICE),
  // drawing touches into a recording on an eas simulator outlasts the attempt's cleanup.
  videoTouches: !onEas,
});

// a model spec is <provider>/<id>.
// - chatgpt: the ChatGPT subscription login. locally that is ~/.config/e2e/oauth.json
//   from `e2e login openai`; in ci the same json is supplied through
//   E2E_OAUTH_CREDENTIALS. `e2e models openai` lists the ids the login serves.
// - anthropic: an api key in E2E_ANTHROPIC_API_KEY. named this way on purpose so the
//   agent-fix workflow never sees an ANTHROPIC_API_KEY and keeps billing its subscription.
function modelFrom(spec: string) {
  const [provider, modelId] = spec.split('/');
  return provider === 'anthropic'
    ? createAnthropic({
        apiKey: process.env.E2E_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      })(modelId)
    : chatgpt(modelId);
}

// what the app calls things. read by every model call, the judges behind expect and
// agent.assert included, so it must be true for any tester of this app. how an agent
// should work goes in `system` below instead.
const context = [
  'Habit System is an iOS habit tracker built around boards.',
  'The home screen is the boards list. Its header has a Layout button (testID open-board-layout), a Settings gear (open-settings), and a Create board button (create-board).',
  'The Layout button opens a chooser with four options, each an accessibility-labelled pressable: "Full-width cards", "Two-column grid", "Compact rows", "14-day summary". Done (done-board-layout) closes it.',
  'Creating a board asks for a title (board-title-input) and saves with board-form-save. A board opens to its detail screen with check-ins, a heatmap, and an Add check-in button (add-check-in).',
  'Stacks group boards; Coins are earned by check-ins and spent on Rewards.',
  'Settings is a list: Notifications, Anchors, App icon, iCloud sync, Timeline, Export, Import, Archived boards, and a Version row (settings-version) at the very bottom.',
  'Text the app shows changes with the device date; do not treat a different date or count as a bug.',
].join(' ');

const system =
  'You are a careful QA agent testing a habit tracker for iOS. Do one goal at a time and verify every outcome on screen before finishing a step. Do not delete boards or check-ins you did not create.';

const tools = mobileTools(iphone);

export default {
  targets: [{ name: 'ios', engine: iphone, app: {
    bundleId: appId,
    // native user-default arguments keep development tools from covering product controls.
    launchArguments: onEas ? undefined : [
      '-EXDevMenuShowsAtLaunch', 'NO',
      '-EXDevMenuShowFloatingActionButton', 'NO',
      '-EXDevMenuIsOnboardingFinished', 'YES',
      ...(process.env.E2E_METRO_URL ? ['--initialUrl', process.env.E2E_METRO_URL] : []),
    ],
  } }],
  // on eas, one worker per leased phone. locally one simulator, one worker.
  workers: onEas ? Number(process.env.E2E_WORKERS ?? '1') : 1,
  // two named agents with the same verification model and instructions. `default`
  // runs everything unless a test, a group, or `--agent fast` selects the other one.
  // `fast` is for cheap scripted steps; set E2E_FAST_MODEL to change its model.
  // agents do not inherit from each other, so both get the full context.
  agents: {
    default: { model: modelFrom(process.env.E2E_MODEL ?? 'chatgpt/gpt-6-luna'), tools, system, context },
    fast: { model: modelFrom(process.env.E2E_FAST_MODEL ?? 'chatgpt/gpt-6-luna'), tools, system, context },
  },
  // markdown writes .e2e/summary.md, which the pr workflow posts as the comment.
  reporters: ['list', 'markdown', 'junit'],
} satisfies E2EConfig;
