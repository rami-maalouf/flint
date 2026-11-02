import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from 'snapback4/auth';
import { createClient } from 'snapback4/client';

import { setICloudSyncEnabled } from '../../../src/core/domain/commands.ts';
import type { CommandId } from '../../../src/core/domain/ids.ts';
import type { Clock, Hashing } from '../../../src/core/domain/ports.ts';
import type { SqlDatabase } from '../../../src/core/persistence/database.ts';
import { getSyncSummary } from '../../../src/core/domain/queries.ts';
import { initializeProductDatabase } from '../../../src/core/persistence/bootstrap.ts';
import { runSync } from '../../../src/core/sync/engine.ts';
import { bindBackendAccount } from '../../../src/platform/backend/account-binding.ts';
import { createSnapbackTransport } from '../../../src/platform/backend/transport.ts';
import type { Credentials } from './snapback.ts';
import { NodeSqlDatabase } from './sqlite.ts';

export class ToolError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'DECLINED' |
    'RECONNECT_REQUIRED' | 'UNAVAILABLE', message: string) { super(message); }
}

export const hashing: Hashing = {
  sha1: async bytes => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

// every request reads one instant, so a command cannot straddle midnight halfway through.
export function clockAt(timeZone: string, now = Date.now()): Clock {
  return { nowUtcMs: () => now, timeZoneId: () => timeZone };
}

export type SyncState = {
  status: 'synced' | 'offline' | 'needs_attention';
  lastSyncedAt: string | null;
  pendingUploads: number;
};

type Replica = { db: NodeSqlDatabase; lane: Promise<unknown>; lastSyncAt: number; state: SyncState | null };

// reads within this window reuse the previous pull instead of syncing again.
const READ_FRESHNESS_MS = 15_000;

// one product replica per account. all work for an account runs in one lane, so
// sync, commands, session refresh and reads never interleave.
export class Accounts {
  private readonly replicas = new Map<string, Replica>();

  constructor(private readonly options: { dataDir: string; backendUrl: string; credentials: Credentials;
    fetch?: typeof fetch; now?: () => number }) {
    mkdirSync(join(options.dataDir, 'accounts'), { recursive: true, mode: 0o700 });
  }

  // runs `work` in the account lane after bringing the replica up to date. writes always
  // sync before and after; reads sync when the last pull is older than the freshness window.
  async run<T>(accountId: string, mode: 'read' | 'write',
    work: (db: SqlDatabase, state: SyncState, sync: () => Promise<SyncState>) => Promise<T>): Promise<T> {
    return this.inLane(accountId, async replica => {
      const now = this.options.now?.() ?? Date.now();
      let state = replica.state;
      if (mode === 'write' || !state || now - replica.lastSyncAt > READ_FRESHNESS_MS) state = await this.sync(accountId, replica);
      // a retry is recognized from synced data, so writes need a current pull first.
      if (mode === 'write' && state.status === 'offline') {
        throw new ToolError('UNAVAILABLE', 'Flint cannot reach your account right now, so nothing was changed. Try again shortly.');
      }
      return work(replica.db, state, () => this.sync(accountId, replica));
    });
  }

  // serializes non-replica work, such as a session refresh, with the account's commands.
  inLane<T>(accountId: string, work: (replica: Replica) => Promise<T>): Promise<T> {
    const replica = this.replica(accountId);
    const result = replica.lane.then(() => work(replica));
    replica.lane = result.catch(() => undefined);
    return result;
  }

  // retries uploads that a write could not deliver, so they reach the phone without another call.
  async deliverPending(): Promise<void> {
    for (const [accountId, replica] of this.replicas) {
      if (!replica.state || replica.state.pendingUploads === 0) continue;
      await this.inLane(accountId, () => this.sync(accountId, replica)).catch(() => undefined);
    }
  }

  async forget(accountId: string): Promise<void> {
    const replica = this.replicas.get(accountId);
    if (!replica) return;
    this.replicas.delete(accountId);
    await replica.lane.catch(() => undefined);
    await replica.db.closeAsync();
  }

  async close(): Promise<void> {
    await Promise.all([...this.replicas.keys()].map(id => this.forget(id)));
  }

  private replica(accountId: string): Replica {
    const existing = this.replicas.get(accountId);
    if (existing) return existing;
    if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('Invalid account id.');
    const db = new NodeSqlDatabase(join(this.options.dataDir, 'accounts', `${accountId}.sqlite`));
    const ready = initializeProductDatabase(db, { uuid: randomUUID }, hashing).then(async initialized => {
      // the sync switch is device-local; this replica exists only to sync.
      const result = initialized.ok ? await setICloudSyncEnabled({ db, clock: clockAt('UTC'), ids: { uuid: randomUUID }, hashing },
        { commandId: randomUUID() as CommandId, enabled: true }) : initialized;
      if (result.ok) return;
      // drop the broken replica so the next request retries instead of reusing it.
      this.replicas.delete(accountId);
      await db.closeAsync();
      throw new ToolError('UNAVAILABLE', 'Flint could not open this account\'s data.');
    });
    const replica: Replica = { db, lastSyncAt: 0, state: null, lane: ready };
    this.replicas.set(accountId, replica);
    return replica;
  }

  private async sync(accountId: string, replica: Replica): Promise<SyncState> {
    const session = await this.options.credentials.current(accountId);
    if (!session) throw new ToolError('RECONNECT_REQUIRED', 'This Flint connection has expired. Reconnect it to continue.');
    const outcome = await this.runSync(replica.db, session);
    const summary = await getSyncSummary({ db: replica.db, clock: clockAt('UTC') });
    if (!summary.ok) throw new ToolError('UNAVAILABLE', 'Flint could not read its sync state.');
    if (outcome === 'signed_out') {
      // a sign-in that replaced the session while this sync ran leaves the account connected.
      if (!await this.options.credentials.deleteIfCurrent(accountId, session.token)) {
        throw new ToolError('UNAVAILABLE', 'Flint could not reach your account just now. Try again.');
      }
      throw new ToolError('RECONNECT_REQUIRED', 'This Flint connection was signed out. Reconnect it to continue.');
    }
    const { lastSuccessAtUtc, pendingChanges } = summary.value;
    // a replica that never completed a pull has no data worth answering from.
    if (lastSuccessAtUtc === null) {
      throw new ToolError('UNAVAILABLE', 'Flint could not load your account yet. Try again in a moment.');
    }
    if (outcome === 'synced') replica.lastSyncAt = this.options.now?.() ?? Date.now();
    replica.state = { status: outcome, lastSyncedAt: new Date(lastSuccessAtUtc).toISOString(), pendingUploads: pendingChanges };
    return replica.state;
  }

  private async runSync(db: NodeSqlDatabase, session: Session): Promise<SyncState['status'] | 'signed_out'> {
    const { backendUrl, fetch: fetcher } = this.options;
    const client = createClient({ url: backendUrl, token: session.token, ...(fetcher ? { fetch: fetcher } : {}) });
    try {
      const transport = createSnapbackTransport({
        connection: async () => ({ client, session, isCurrent: () => true }),
        bind: bound => bindBackendAccount({ db, hashing }, backendUrl, bound),
        hash: async text => createHash('sha256').update(text).digest('hex'),
      });
      const result = await runSync({ db, clock: clockAt('UTC'), hashing, transport, random: Math.random });
      if (!result.ok) return 'needs_attention';
      const { status } = result.value;
      if (status === 'up_to_date') return 'synced';
      if (status === 'offline' || status === 'signed_out' || status === 'needs_attention') return status;
      return 'needs_attention';
    } finally {
      await client.close();
    }
  }
}
