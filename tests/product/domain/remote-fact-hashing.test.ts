import fixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { CoinContractError } from '@/core/domain/coin-policy';
import { reconcileCheckCoins } from '@/core/domain/coin-reconciliation';
import type { CheckCoinScope } from '@/core/domain/coins';
import { canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import type { Hashing } from '@/core/domain/ports';
import { guardRemoteFactHashing, RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { prepareRemoteFact } from '@/core/domain/remote-fact-validation';

import { createTestHashing } from '../helpers/test-db';

const hashing = createTestHashing();
const actions = fixture.correction.actions as HabitAction[];
const rows = [...fixture.correction.existingRows, ...fixture.correction.expectedAppend] as CoinLedgerRow[];

describe('remote fact provider failure isolation', () => {
  it.each(['invalid', 'missing', 'size'] as const)('isolates provider %s from complete correction subset classification', async (reason) => {
    const failure = new CoinContractError(reason);
    let subset = false;
    let reached = false;
    const port = { ...hashing,
      sha256: async (bytes: Uint8Array) => {
        if (new TextDecoder().decode(bytes) === canonicalHabitAction(actions[0])) subset = true;
        return hashing.sha256(bytes);
      },
      sha1: async (bytes: Uint8Array) => {
        if (subset) { reached = true; throw failure; }
        return hashing.sha1(bytes);
      },
    };
    await expect(reconcileCheckCoins(fixture.scope as CheckCoinScope, actions, rows, guardRemoteFactHashing(port)))
      .rejects.toEqual(new RemoteFactHashingError(failure));
    expect(reached).toBe(true);
  });

  it('preserves successful public preparation and reconciliation bytes', async () => {
    const guarded = guardRemoteFactHashing(hashing);
    const candidate = { factType: 'habit_action' as const, factId: actions[0].id, value: actions[0], enqueueOnAdmission: false };
    expect(await prepareRemoteFact(candidate, guarded)).toEqual(await prepareRemoteFact(candidate, hashing));
    expect(await reconcileCheckCoins(fixture.scope as CheckCoinScope, actions, rows, guarded))
      .toEqual(await reconcileCheckCoins(fixture.scope as CheckCoinScope, actions, rows, hashing));
  });

  it.each(['sha1', 'sha256'] as const)('retains the original %s cancellation and provider cause', async method => {
    for (const failure of [Object.assign(new Error('cancelled'), { name: 'AbortError' }), new Error('unavailable'), 'provider failure']) {
      const guarded = guardRemoteFactHashing({ ...hashing, [method]: () => { throw failure; } });
      const error = await guarded[method](new Uint8Array()).catch(cause => cause);
      expect(error).toBeInstanceOf(RemoteFactHashingError);
      expect(error).not.toBeInstanceOf(CoinContractError);
      expect(error.cause).toBe(failure);
    }
  });

  it('captures both methods and their receiver before an awaited call or method replacement', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const source = { marker: 7,
      async sha1() { await held; return new Uint8Array(20).fill(this.marker); },
      async sha256() { return new Uint8Array(32).fill(this.marker); },
    };
    const guarded = guardRemoteFactHashing(source);
    const waiting = guarded.sha1(new Uint8Array());
    source.sha1 = source.sha256 = async () => { throw new Error('replacement must not run'); };
    release();
    expect(await waiting).toEqual(new Uint8Array(20).fill(7));
    expect(await guarded.sha256(new Uint8Array())).toEqual(new Uint8Array(32).fill(7));
  });

  it.each(['sha1', 'sha256'] as const)('owns %s output bytes even for a view into a reused provider buffer', async method => {
    const length = method === 'sha1' ? 20 : 32;
    const buffer = new Uint8Array(100).fill(9);
    const guarded = guardRemoteFactHashing({ ...hashing, [method]: async () => buffer.subarray(10, 10 + length) });
    const digest = await guarded[method](new Uint8Array());
    buffer.fill(1);
    expect(digest).toEqual(new Uint8Array(length).fill(9));
    digest.fill(2);
    expect(buffer).toEqual(new Uint8Array(100).fill(1));
  });

  it.each(['sha1', 'sha256'] as const)('rejects invalid %s digest types and lengths as provider failures', async method => {
    const length = method === 'sha1' ? 20 : 32;
    for (const value of [null, [], Array(length).fill(0), new DataView(new ArrayBuffer(length)),
      new Uint8Array(length - 1), new Uint8Array(length + 1)]) {
      const guarded = guardRemoteFactHashing({ ...hashing, [method]: async () => value } as Hashing);
      const error = await guarded[method](new Uint8Array()).catch(cause => cause);
      expect(error).toBeInstanceOf(RemoteFactHashingError);
      expect(error.cause).toBeInstanceOf(TypeError);
    }
  });

  it('wraps method capture failures before any provider call can begin', () => {
    const failure = new CoinContractError('missing');
    const sha1 = jest.fn(hashing.sha1);
    const source = { sha1, get sha256(): Hashing['sha256'] { throw failure; } };
    try { guardRemoteFactHashing(source); throw new Error('capture should fail'); }
    catch (cause) {
      expect(cause).toBeInstanceOf(RemoteFactHashingError);
      expect((cause as RemoteFactHashingError).cause).toBe(failure);
    }
    expect(sha1).not.toHaveBeenCalled();
  });
});
