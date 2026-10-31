import { createHash, randomUUID } from 'node:crypto';
import type { Clock, Hashing, IdGenerator } from '../../../src/core/domain/ports';
import { timeZone } from './tools/contracts';

export { NodeSqlDatabase } from './storage/sqlite';
export { initializeProductDatabase } from '../../../src/core/persistence/bootstrap';
export { createCheckIn, undoCreatedCheckIn } from '../../../src/core/domain/check-in-commands';
export { claimReward } from '../../../src/core/domain/reward-commands';
export { listActiveBoards, listArchivedBoards, getBoard, getHomeBoardProjection, getSyncSummary } from '../../../src/core/domain/queries';
export { getStackListSnapshot, getStackDetailSnapshot } from '../../../src/core/domain/stack-queries';
export { getCoinTotals, getCoinHistoryPage } from '../../../src/core/domain/coin-queries';
export { listRewards, getRewardClaimPreview } from '../../../src/core/domain/reward-queries';
export { runSync } from '../../../src/core/sync/engine';
export { createSnapbackTransport } from '../../../src/platform/backend/transport';

export function createCorePorts(zone: string, acquiredAtUtc = Date.now()): { clock: Clock; hashing: Hashing; ids: IdGenerator } {
  timeZone.parse(zone);
  if (!Number.isSafeInteger(acquiredAtUtc)) throw new Error('Invalid request clock.');
  return {
    clock: Object.freeze({ nowUtcMs: () => acquiredAtUtc, timeZoneId: () => zone }),
    ids: { uuid: randomUUID },
    hashing: {
      sha1: async bytes => new Uint8Array(createHash('sha1').update(bytes).digest()),
      sha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()),
    },
  };
}
