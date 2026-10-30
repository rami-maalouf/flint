import { execFileSync } from 'node:child_process';

function launchIdentity(overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.E2E_EAS_SIMULATOR;
  delete env.E2E_APP_ID;
  delete env.E2E_TARGET;
  delete env.E2E_DEVICE;
  return execFileSync('bun', ['-e',
    'import config from "./e2e.config.ts"; console.log(config.targets[0].app.bundleId)',
  ], { cwd: process.cwd(), env: { ...env, ...overrides }, encoding: 'utf8' }).trim();
}

it('launches the development app for local e2e runs', () => {
  expect(launchIdentity()).toBe('studio.orbitlabs.habitsystem.fullstack.dev');
});

it('launches the matching app for the eas sim build profile', () => {
  expect(launchIdentity({ E2E_EAS_SIMULATOR: '1' })).toBe('studio.orbitlabs.habitsystem.fullstack');
});

it.each(['0', '1'])('honors an explicit app id with eas mode %s', (mode) => {
  expect(launchIdentity({ E2E_EAS_SIMULATOR: mode, E2E_APP_ID: 'studio.orbitlabs.habitsystem.fullstack.dev' }))
    .toBe('studio.orbitlabs.habitsystem.fullstack.dev');
});
