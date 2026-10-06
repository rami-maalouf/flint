// host filesystem checks require an explicitly opted-in local synthetic simulator.
export const localSyntheticEnabled = process.env.E2E_EAS_SIMULATOR !== '1' &&
  process.env.E2E_TARGET !== 'device' && Boolean(process.env.E2E_DEVICE) &&
  process.env.E2E_DEVICE === process.env.E2E_SYNTHETIC_DEVICE;
