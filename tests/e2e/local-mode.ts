import { ownedSyntheticDevice } from '../../scripts/e2e/synthetic-device';

// host filesystem checks require an explicitly opted-in local synthetic simulator.
const optedIn = process.env.E2E_EAS_SIMULATOR !== '1' &&
  process.env.E2E_TARGET !== 'device' && Boolean(process.env.E2E_DEVICE) &&
  process.env.E2E_DEVICE === process.env.E2E_SYNTHETIC_DEVICE;
if (optedIn) ownedSyntheticDevice();
export const localSyntheticEnabled = optedIn;
