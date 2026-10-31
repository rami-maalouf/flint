import { randomUUID } from 'node:crypto';

export function syntheticAuthorizationEpoch() {
  const state = Object.freeze({ epoch: randomUUID(), mode: 'normal' as const });
  return Object.freeze({ current: async () => state });
}
