import { settleAffectedCoinScopes } from '@/core/domain/coin-settlement';
import type { CheckIn } from '@/core/domain/entities';
import { establishLegacyCheckEvidence } from '@/core/domain/legacy-check-evidence';
import { refreshCheckVisibility } from '@/core/persistence/repositories/check-visibility';
import type { TestHarness } from './test-db';

// fixtures opt into historical compatibility explicitly, before the operation under test.
export async function admitLegacyChecks(h: TestHarness, checks: readonly Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>[]) {
  await h.db.withExclusiveTransactionAsync(async tx => {
    const evidence = await establishLegacyCheckEvidence({ tx, now: h.clock.utcMs, hashing: h.deps.hashing }, checks);
    await settleAffectedCoinScopes(h.deps, { tx, now: h.clock.utcMs }, { checkScopes: evidence.checkScopes });
    await refreshCheckVisibility(tx, evidence.checkScopes);
  });
}
