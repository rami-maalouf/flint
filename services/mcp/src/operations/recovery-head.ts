import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Client } from 'snapback4/client';

import { api } from '../../../../snapback/generated/api.ts';
import type { ChainEntry, JournalHead } from './journal';
import { canonicalJson, sha256 } from './records';

const genesis = '0'.repeat(64);
export type RemoteRecoveryHead = JournalHead & { owner: string };
export type RecoveryRemote = {
  read(): Promise<RemoteRecoveryHead | null>;
  initialize(generation: string): Promise<RemoteRecoveryHead>;
  advance(previous: JournalHead, next: JournalHead): Promise<RemoteRecoveryHead>;
};
export type RestoreLatch = { assertReady(): void | Promise<void> };
type JournalReader = { head(): JournalHead; entryAt(sequence: number): ChainEntry | null };
export type LatchOptions = { path: string; installationId: string; restoredDirectories: readonly [string, string, ...string[]] };
type AdapterOptions = { owner: string; journal: JournalReader; remote: RecoveryRemote; latch: RestoreLatch;
  // use the same admitted grant/credential and account barrier for each outbound mutation.
  authorize(): Promise<void> };

export class RecoveryFenceError extends Error {
  readonly code = 'OPERATION_PENDING';
  constructor(readonly reason: 'restore_latched' | 'ancestry' | 'remote_unavailable' | 'remote_mismatch' | 'publication_unknown') {
    super('Mutation recovery is fenced. Preserve operation ids and reconcile complete history before retrying.');
  }
}
function fence(reason: RecoveryFenceError['reason']): never { throw new RecoveryFenceError(reason); }
function isHead(value: unknown): value is JournalHead {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.generation === 'string' && row.generation.length === 36 &&
    Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0 &&
    typeof row.headHash === 'string' && /^[0-9a-f]{64}$/.test(row.headHash) &&
    typeof row.previousHash === 'string' && /^[0-9a-f]{64}$/.test(row.previousHash);
}
function sameHead(a: JournalHead, b: JournalHead): boolean {
  return a.generation === b.generation && a.sequence === b.sequence && a.headHash === b.headHash && a.previousHash === b.previousHash;
}
function remoteHead(value: unknown): RemoteRecoveryHead {
  if (!isHead(value) || !('owner' in value) || typeof value.owner !== 'string' || !value.owner.length) fence('remote_mismatch');
  return { owner: value.owner, generation: value.generation, sequence: value.sequence,
    headHash: value.headHash, previousHash: value.previousHash };
}

// a supplied read client stays read-only. this adapter never looks up a stronger credential.
export function createSnapbackRecoveryRemote(client: Pick<Client, 'query' | 'mutate'>): RecoveryRemote {
  return {
    read: async () => {
      const result = await client.query(api.mcpRecoveryHead, {});
      if ('denied' in result || !result.complete) fence('remote_unavailable');
      return result.data === null ? null : remoteHead(result.data);
    },
    initialize: async generation => {
      const result = await client.mutate(api.initializeMcpRecoveryHead, { generation });
      if (result.state !== 'sent') fence('publication_unknown');
      return remoteHead(result.result);
    },
    advance: async (previous, next) => {
      const result = await client.mutate(api.advanceMcpRecoveryHead, { generation: previous.generation,
        expectedSequence: previous.sequence, expectedHash: previous.headHash, nextHash: next.headHash });
      if (result.state !== 'sent') fence('publication_unknown');
      return remoteHead(result.result);
    },
  };
}

// outside both restore roots. missing, truncated, appended or replaced state never means ready.
export class FileRestoreLatch implements RestoreLatch {
  private readonly path: string;
  private readonly marker: string;
  constructor(options: LatchOptions) {
    if (!isAbsolute(options.path) || !options.installationId || options.installationId.length > 255 || options.restoredDirectories.length < 2) fence('restore_latched');
    this.path = join(realpathSync(dirname(options.path)), basename(options.path));
    for (const root of options.restoredDirectories) {
      const inside = relative(realpathSync(root), this.path);
      if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('../'))) fence('restore_latched');
    }
    this.marker = canonicalJson({ installationId: options.installationId, version: 1 }) + '\n';
  }

  // only initial provisioning of a genuinely new installation may call this. never on restore.
  static provisionFresh(options: LatchOptions): void {
    const latch = new FileRestoreLatch(options);
    const fd = openSync(latch.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, latch.marker); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(dirname(latch.path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  assertReady(): void {
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (this.readMarker(fd) !== this.marker) fence('restore_latched');
      } finally { closeSync(fd); }
    } catch { fence('restore_latched'); }
  }

  private readMarker(fd: number): string {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() ||
      (before.mode & 0o177) !== 0 || before.size < 1 || before.size > 4096) fence('restore_latched');
    const buffer = Buffer.alloc(4097), length = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) fence('restore_latched');
    const text = buffer.subarray(0, length).toString('utf8');
    if (!text.startsWith(this.marker) || !Buffer.from(text).equals(buffer.subarray(0, length))) fence('restore_latched');
    const suffix = text.slice(this.marker.length);
    if (suffix !== '' && !/^(?:restored(?: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\n)+$/.test(suffix)) fence('restore_latched');
    return text;
  }

  readGeneration(): Readonly<{ generation: string; restored: boolean }> | null {
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const text = this.readMarker(fd), restored = text !== this.marker;
        if (restored && !text.includes('restored ')) return null;
        return Object.freeze({ generation: sha256(text), restored });
      } finally { closeSync(fd); }
    } catch { return null; }
  }

  // stop admission first, durably append this before replacing either database directory.
  // a torn append also fails closed. no runtime api clears or reprovisions a latched file.
  markRestored(): void {
    const fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const previous = this.readMarker(fd), marker = `restored ${randomUUID()}\n`;
      if (Buffer.byteLength(previous + marker) > 4096) fence('restore_latched');
      writeFileSync(fd, marker); fsyncSync(fd);
    } finally { closeSync(fd); }
  }
}

export class RecoveryHeadAdapter {
  constructor(private readonly options: AdapterOptions) {}

  private async ready(): Promise<void> {
    try { await this.options.latch.assertReady(); } catch { fence('restore_latched'); }
  }

  private chain(): ChainEntry[] {
    try {
      const head = this.options.journal.head();
      if (!isHead(head)) fence('ancestry');
      const entries: ChainEntry[] = [];
      for (let sequence = 0; sequence <= head.sequence; sequence++) {
        const entry = this.options.journal.entryAt(sequence);
        if (!isHead(entry) || entry.generation !== head.generation || entry.sequence !== sequence || typeof entry.event !== 'string') fence('ancestry');
        if (sequence === 0) {
          if (entry.headHash !== genesis || entry.previousHash !== genesis || entry.event !== '') fence('ancestry');
        } else if (entry.previousHash !== entries[sequence - 1].headHash || entry.headHash !== sha256(canonicalJson({
          generation: entry.generation, sequence, previousHash: entry.previousHash, event: entry.event,
        }))) fence('ancestry');
        entries.push(entry);
      }
      if (!sameHead(head, entries[head.sequence])) fence('ancestry');
      return entries;
    } catch { fence('ancestry'); }
  }

  private async read(): Promise<RemoteRecoveryHead | null> {
    try {
      const head = await this.options.remote.read();
      if (head === null) return null;
      const parsed = remoteHead(head);
      if (parsed.owner !== this.options.owner) fence('remote_mismatch');
      return parsed;
    } catch (cause) {
      if (cause instanceof RecoveryFenceError) throw cause;
      fence('remote_unavailable');
    }
  }

  private known(remote: RemoteRecoveryHead | null, chain: ChainEntry[]): void {
    // absent metadata cannot rebootstrap a surviving nonempty journal after backend loss.
    if (remote === null) { if (chain.length !== 1) fence('remote_mismatch'); return; }
    const local = chain[remote.sequence];
    if (!local || !sameHead(remote, local)) fence('remote_mismatch');
  }

  // startup readiness and read-only comparisons never initialize or advance metadata.
  async compare(): Promise<'current' | 'unpublished'> {
    await this.ready();
    const chain = this.chain(), remote = await this.read();
    this.known(remote, chain);
    await this.ready();
    return remote?.sequence === chain.length - 1 ? 'current' : 'unpublished';
  }

  async publish(head: JournalHead): Promise<void> {
    await this.ready();
    const chain = this.chain();
    if (!sameHead(head, chain[chain.length - 1])) fence('ancestry');
    let remote = await this.read();
    this.known(remote, chain);
    if (remote === null) remote = await this.send(chain[0], () => this.options.remote.initialize(head.generation));
    while (remote.sequence < head.sequence) {
      const previous = chain[remote.sequence], next = chain[remote.sequence + 1];
      remote = await this.send(next, () => this.options.remote.advance(previous, next));
    }
    await this.ready();
    if (!sameHead(this.options.journal.head(), head)) fence('ancestry');
  }

  private async send(next: JournalHead, send: () => Promise<RemoteRecoveryHead>): Promise<RemoteRecoveryHead> {
    await this.ready();
    // authorization errors propagate; they are never treated as a lost publication response.
    await this.options.authorize();
    await this.ready();
    let response: RemoteRecoveryHead;
    try { response = remoteHead(await send()); } catch {
      // never issue the cas again here. only its exact known successor proves acceptance.
      const observed = await this.read();
      if (!observed || !sameHead(observed, next)) fence('publication_unknown');
      response = observed;
    }
    await this.ready();
    if (response.owner !== this.options.owner || !sameHead(response, next)) fence('remote_mismatch');
    return response;
  }
}
