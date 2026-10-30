import { establishLegacyCheckEvidence } from '../domain/legacy-check-evidence';
import type { Clock, Hashing } from '../domain/ports';
import { guardRemoteFactHashing, RemoteFactHashingError } from '../domain/remote-fact-hashing';
import type { DomainResult } from '../domain/result';
import { err, ok } from '../domain/result';
import type { SqlDatabase, SqlExecutor } from '../persistence/database';
import { admitRemoteFacts } from '../persistence/remote-fact-admission';
import { rebuildWidgetRows } from '../persistence/projections/widget-rows';
import { refreshCheckVisibility } from '../persistence/repositories/check-visibility';
import { readRemoteFactInboxCounts } from '../persistence/repositories/remote-fact-inbox';
import { readUniquePeriodAlias } from '../persistence/repositories/sync-periods';
import { deleteOutboxRows, getSettings, getSyncState, listDeferredRecords, listOutbox,
  readRawRow, saveHlc, saveSyncState } from '../persistence/repositories/support';
import { observe } from './hybrid-clock';
import { immutableSyncCandidate } from './immutable-records';
import type { Schema2MutableRecord } from './inbound-validation';
import { recoverLocalFacts } from './local-fact-recovery';
import { applyMutableSyncPage } from './mutable-sync-page';
import { SETTINGS_ENTITY_ID, periodEntityId } from './records';
import { schema2SpecFor, toSchema2SyncRecord } from './schema-2-records';
import { captureSyncPage } from './sync-page';
import type { SyncTransport, WireSyncRecord } from './transport';
import { SyncTransportError } from './transport';

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'up_to_date'
  | 'offline'
  | 'signed_out'
  | 'needs_attention';

export type SyncOutcome = {
  status: SyncStatus;
  uploaded: number;
  applied: number;
  localChanged: boolean;
  // retry delay in ms when the run failed and another attempt is worth it
  retryAfterMs: number | null;
};

export type SyncDeps = {
  db: SqlDatabase;
  clock: Clock;
  hashing: Hashing;
  transport: SyncTransport<WireSyncRecord>;
  // deterministic in tests; Math.random in the app
  random: () => number;
  // pull-only retains reconciliation and queued facts without provider mutations.
  mode?: 'bidirectional' | 'pull_only';
  // optional coordinator gates; exact acceptance must persist before queue deletion.
  delivery?: {
    authorize: () => Promise<void>;
    beforeQueueClear: (outboxIds: readonly number[]) => Promise<void>;
  };
  // a coordinator generation guard; false cancels without retry metadata
  shouldContinue?: () => boolean;
};

class SyncCancelled extends Error {}

function checkpoint(deps: SyncDeps): void {
  if (deps.shouldContinue?.() === false) {
    throw new SyncCancelled();
  }
}

// bounded exponential backoff with jitter; retries never block local
// commands because the engine only ever runs outside them
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 5 * 60_000;
const UPLOAD_BATCH = 200;

export function retryDelayMs(attempt: number, random: () => number): number {
  const capped = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
  // full jitter keeps a fleet of devices from retrying in lockstep
  return Math.round(capped * (0.5 + random() * 0.5));
}

type RetryState = { attempt: number };

function readRetry(raw: string | null): RetryState {
  if (raw === null) {
    return { attempt: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as { attempt?: number };
    return { attempt: typeof parsed.attempt === 'number' ? parsed.attempt : 0 };
  } catch {
    return { attempt: 0 };
  }
}

function statusForFailure(cause: unknown): SyncStatus {
  if (cause instanceof SyncTransportError) {
    if (cause.code === 'offline') {
      return 'offline';
    }
    if (cause.code === 'signed_out') {
      return 'signed_out';
    }
  }
  return 'needs_attention';
}

// --- upload -------------------------------------------------------------------

async function collectUpload(
  tx: SqlExecutor,
): Promise<{ records: WireSyncRecord[]; outboxIds: number[] }> {
  const rows = await listOutbox(tx, UPLOAD_BATCH);
  const records: WireSyncRecord[] = [];
  const outboxIds: number[] = [];
  const checkedPeriodAliases = new Set<string>();
  for (const row of rows) {
    outboxIds.push(row.id);
    const spec = schema2SpecFor(row.entityType);
    // the settings singleton lives at primary key 1; sync addresses it by
    // its stable entity id instead
    const lookupId = row.entityType === 'settings' ? '1' : row.entityId;
    const raw = await readRawRow(tx, spec.table, spec.idColumn, lookupId);
    if (!raw) {
      // the row vanished (a hard-deleted period id); nothing to upload but
      // the outbox entry is still consumed
      if (row.entityType === 'habit_action' || row.entityType === 'ledger_entry') throw new Error('Missing accepted sync evidence.');
      continue;
    }
    const entityId =
      row.entityType === 'activity_period'
        ? periodEntityId(String(raw.board_id), String(raw.start_date))
        : row.entityType === 'settings'
          ? SETTINGS_ENTITY_ID
          : row.entityId;
    if (row.entityType === 'activity_period' && !checkedPeriodAliases.has(entityId)) {
      await readUniquePeriodAlias(tx, String(raw.board_id), String(raw.start_date));
      checkedPeriodAliases.add(entityId);
    }
    const stamp = row.entityType === 'settings' ? raw.settings_mutation_stamp : raw.mutation_stamp;
    if (typeof stamp !== 'string') throw new Error('Missing sync mutation stamp.');
    records.push(toSchema2SyncRecord(row.entityType, entityId, stamp, raw));
  }
  return { records, outboxIds };
}

// --- run ----------------------------------------------------------------------

// one sync pass: upload the outbox, then drain remote pages. the change
// token is persisted only after every fetched record in that page commits.
export function runSync(deps: SyncDeps): Promise<DomainResult<SyncOutcome>> {
  return (async () => {
    try {
      checkpoint(deps);
    } catch {
      return ok({ status: 'idle' as SyncStatus, uploaded: 0, applied: 0, localChanged: false, retryAfterMs: null });
    }
    const now = deps.clock.nowUtcMs();

    const preflight = await deps.db.withTransactionAsync(async (tx) => {
      const settings = await getSettings(tx);
      const state = await getSyncState(tx);
      return { settings, state };
    });
    if (!preflight.settings) {
      return err('database', 'The database is not initialized.');
    }
    let localChanged: boolean;
    try {
      localChanged = await recoverLocalFacts(deps, () => checkpoint(deps));
    } catch (cause) {
      if (cause instanceof SyncCancelled || deps.shouldContinue?.() === false) {
        return ok({ status: 'idle', uploaded: 0, applied: 0, localChanged: false, retryAfterMs: null });
      }
      return err('database', 'Local data could not be processed. Try again.', { retryable: true });
    }
    if (!preflight.settings.iCloudSyncEnabled) {
      return ok({ status: 'idle' as SyncStatus, uploaded: 0, applied: 0, localChanged, retryAfterMs: null });
    }

    const retry = readRetry(preflight.state.retryState);
    let uploaded = 0;
    let applied = 0;

    try {
      if (deps.mode !== 'pull_only') {
        await deps.delivery?.authorize();
        checkpoint(deps);
      }
      if (deps.mode !== 'pull_only' && !preflight.state.zoneCreated) {
        checkpoint(deps);
        await deps.transport.ensureZone();
        checkpoint(deps);
        await deps.db.withExclusiveTransactionAsync(async (tx) => {
          checkpoint(deps);
          await saveSyncState(tx, { ...(await getSyncState(tx)), zoneCreated: true });
          checkpoint(deps);
        });
      }

      // upload in batches until the outbox drains; each batch clears only
      // its own rows, so an interrupted run never loses a mutation
      while (deps.mode !== 'pull_only') {
        checkpoint(deps);
        const batch = await deps.db.withTransactionAsync((tx) => collectUpload(tx));
        if (batch.outboxIds.length === 0) {
          break;
        }
        await deps.delivery?.authorize();
        checkpoint(deps);
        if (batch.records.length > 0) {
          checkpoint(deps);
          await deps.transport.upload(batch.records);
          checkpoint(deps);
          uploaded += batch.records.length;
        }
        await deps.delivery?.beforeQueueClear(batch.outboxIds);
        checkpoint(deps);
        await deps.db.withExclusiveTransactionAsync(async (tx) => {
          checkpoint(deps);
          await deleteOutboxRows(tx, batch.outboxIds);
          checkpoint(deps);
        });
      }

      let token = preflight.state.changeToken;
      for (;;) {
        checkpoint(deps);
        const page = captureSyncPage(await deps.transport.fetchChanges(token), token);
        checkpoint(deps);
        const committed = await deps.db.withExclusiveTransactionAsync(async tx => {
          checkpoint(deps);
          const now = deps.clock.nowUtcMs();
          const timeZoneId = deps.clock.timeZoneId();
          const rawHashing = { sha1: deps.hashing.sha1.bind(deps.hashing), sha256: deps.hashing.sha256.bind(deps.hashing) };
          const settings = await getSettings(tx);
          checkpoint(deps);
          if (!settings) throw new Error('The database is not initialized.');
          const candidates = page.records.filter(record => record.entityType === 'habit_action' || record.entityType === 'ledger_entry')
            .map(immutableSyncCandidate);
          const mutable = page.records.filter(record => record.entityType !== 'habit_action' && record.entityType !== 'ledger_entry') as Schema2MutableRecord[];
          const changes = await applyMutableSyncPage(tx, mutable, now, () => checkpoint(deps));
          checkpoint(deps);
          const legacy = await establishLegacyCheckEvidence({ tx, now, hashing: guardRemoteFactHashing(rawHashing) }, changes.legacyChecks);
          checkpoint(deps);
          const admission = await admitRemoteFacts(tx, { candidates, acquiredNow: now,
            checkScopes: changes.checkScopes, checkpoint: () => checkpoint(deps) }, rawHashing);
          checkpoint(deps);
          const accepted = [...admission.admitted, ...admission.generated];
          await refreshCheckVisibility(tx, admission.affected.checkScopes);
          checkpoint(deps);
          let hlc = { wallTime: settings.hlcWallTime, counter: settings.hlcCounter };
          for (const stamp of changes.observedStamps) hlc = observe(hlc, stamp);
          for (const fact of accepted) hlc = observe(hlc, fact.mutationStamp);
          if (hlc.wallTime !== settings.hlcWallTime || hlc.counter !== settings.hlcCounter) {
            await saveHlc(tx, hlc);
            checkpoint(deps);
          }
          const changed = changes.localChanged || legacy.actions.length > 0 || admission.localChanged;
          if (changes.applied > 0 || accepted.length > 0) {
            await rebuildWidgetRows(tx, now, timeZoneId);
            checkpoint(deps);
          }
          await saveSyncState(tx, { ...(await getSyncState(tx)), changeToken: page.nextToken });
          checkpoint(deps);
          return { applied: changes.applied + admission.admitted.length, localChanged: changed };
        }).catch(cause => {
          // owned provider failures leave the page transaction before losing their wrapper.
          if (cause instanceof RemoteFactHashingError) throw cause.cause;
          throw cause;
        });
        applied += committed.applied;
        localChanged ||= committed.localChanged;
        token = page.nextToken;
        if (!page.more) {
          break;
        }
      }

      let unresolved = false;
      await deps.db.withExclusiveTransactionAsync(async (tx) => {
        checkpoint(deps);
        const inbox = await readRemoteFactInboxCounts(tx);
        unresolved = (await listDeferredRecords(tx)).length > 0 || inbox.variants > 0;
        await saveSyncState(tx, {
          ...(await getSyncState(tx)),
          retryState: null,
          lastSuccessAtUtc: now,
        });
        checkpoint(deps);
      });
      checkpoint(deps);
      return ok({
        status: (unresolved ? 'needs_attention' : 'up_to_date') as SyncStatus,
        uploaded,
        applied,
        localChanged,
        retryAfterMs: null,
      });
    } catch (cause) {
      if (cause instanceof SyncCancelled) {
        return ok({ status: 'idle' as SyncStatus, uploaded, applied, localChanged, retryAfterMs: null });
      }
      if (deps.shouldContinue?.() === false) {
        return ok({ status: 'idle' as SyncStatus, uploaded, applied, localChanged, retryAfterMs: null });
      }
      const attempt = retry.attempt + 1;
      const retryAfterMs = retryDelayMs(attempt, deps.random);
      try {
        await deps.db.withExclusiveTransactionAsync(async (tx) => {
          checkpoint(deps);
          await saveSyncState(tx, {
            ...(await getSyncState(tx)),
            retryState: JSON.stringify({ attempt }),
          });
          checkpoint(deps);
        });
      } catch (retryCause) {
        if (retryCause instanceof SyncCancelled) {
          return ok({ status: 'idle' as SyncStatus, uploaded, applied, localChanged, retryAfterMs: null });
        }
        throw retryCause;
      }
      // raw provider errors and account data never reach the ui or logs
      return ok({ status: statusForFailure(cause), uploaded, applied, localChanged, retryAfterMs });
    }
  })();
}
