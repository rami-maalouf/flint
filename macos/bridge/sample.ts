import { createSampleRuntime } from '../../src/core/sample/generator';
import { initializeProductDatabase } from '../../src/core/persistence/bootstrap';
import { deps, native } from './runtime';

export async function initializeSample() {
  if (!native<boolean>({ kind: 'isMemoryDatabase' })) {
    return { ok: false, error: { code: 'validation', message: 'Sample data requires a separate temporary database.', retryable: false } };
  }
  const runtime = createSampleRuntime();
  deps.clock = runtime.clock;
  deps.ids = runtime.ids;
  const initialized = await initializeProductDatabase(deps.db, deps.ids, deps.hashing);
  return initialized.ok ? runtime.populate(deps.db, deps.hashing) : initialized;
}
