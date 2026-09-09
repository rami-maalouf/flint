import { createHash } from 'node:crypto';

import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import * as ledger from '@/core/domain/coin-ledger';
import { baselineAction, canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import { prepareRemoteFact, RemoteFactAdmissionError } from '@/core/domain/remote-fact-validation';

import { createTestHashing } from '../helpers/test-db';

const boardId = 'AAAAAAAA-0000-4000-8000-000000000001' as BoardId;
const checkInId = '00000000-0000-4000-8000-000000000002' as CheckInId;
const date = '0000-02-29' as LogicalDate;
const action: HabitAction = {
  id: 'BBBBBBBB-0000-4000-8000-000000000003' as HabitActionId,
  commandId: '00000000-0000-4000-8000-000000000004' as CommandId,
  boardId, logicalDate: date, checkInId, kind: 'check', createdAt: 0,
  mutationStamp: '00000000000000-00000-test', policyJson: null,
};
const claim: CoinLedgerRow = {
  id: 'CCCCCCCC-0000-4000-8000-000000000005' as LedgerEntryId,
  kind: 'claim', delta: -5, boardId: null, checkInId: null, runKey: null,
  rewardId: '00000000-0000-4000-8000-000000000006' as RewardId,
  rewardTitleSnapshot: 'Café 🎨', reversesId: null, scopeKey: null, sourceActionId: null,
  reconciliationKey: null, adjustsId: null, provenanceJson: null, logicalDate: date,
  createdAt: 0, mutationStamp: action.mutationStamp, deletedAt: null,
};
const hashing = createTestHashing();
const candidate = (value: unknown = action) => ({
  factType: 'habit_action' as const, factId: action.id, value, enqueueOnAdmission: false,
});

describe('source-neutral remote fact preparation', () => {
  it('preserves canonical action bytes and UUID case without consulting live parents', async () => {
    const input = Object.freeze({ ...action });
    const prepared = await prepareRemoteFact(candidate(input), hashing);
    const payload = canonicalHabitAction(action);
    expect(prepared).toEqual({
      factType: 'habit_action', factId: action.id, payloadEncoding: 'canonical_v1', payload,
      payloadDigest: createHash('sha256').update(payload).digest('hex'),
      payloadBytes: Buffer.byteLength(payload), logicalDate: date, scopeKey: `check:${boardId}:${date}`,
      enqueueOnAdmission: false, fact: { factType: 'habit_action', value: action },
    });
    expect(prepared.fact?.value).not.toBe(input);
  });

  it('retains a claim snapshot without a reward or affordability dependency', async () => {
    const prepared = await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
      value: claim, enqueueOnAdmission: true }, hashing);
    expect(prepared).toMatchObject({ fact: { factType: 'ledger_entry', value: claim }, scopeKey: null,
      enqueueOnAdmission: true, payload: canonicalCoinLedger(claim), payloadEncoding: 'canonical_v1' });
    expect(prepared.payloadBytes).toBe(Buffer.byteLength(prepared.payload));
  });

  it('recomputes a baseline cause and quarantines a different valid UUID instead of inventing authority', async () => {
    const baseline = await baselineAction({ id: checkInId, boardId, logicalDate: date }, hashing);
    expect((await prepareRemoteFact({ ...candidate(baseline), factId: baseline.id }, hashing)).fact)
      .toEqual({ factType: 'habit_action', value: baseline });
    const wrong = { ...baseline, id: '00000000-0000-5000-8000-000000000099' };
    expect(await prepareRemoteFact({ ...candidate(wrong), factId: wrong.id }, hashing))
      .toMatchObject({ fact: null, payloadEncoding: 'rejected_json_v1', scopeKey: `check:${boardId}:${date}` });
  });

  it.each([
    { ...action, policyJson: '{"version":1}' },
    { ...action, commandId: null },
    { ...action, extra: 'not an action field' },
    { ...action, id: checkInId },
    { ...action, logicalDate: '0000-02-30' },
    null,
  ])('retains an identifiable malformed inner payload as diagnostic JSON: %j', async (value) => {
    const result = await prepareRemoteFact(candidate(value), hashing);
    expect(result.fact).toBeNull();
    expect(result.payloadEncoding).toBe('rejected_json_v1');
    expect(result.payload).toBe(JSON.stringify(value));
    expect(result.payloadDigest).not.toBe(createHash('sha256').update(result.payload).digest('hex'));
  });

  it('retains a malformed immutable tombstone without turning it into a live claim', async () => {
    const value = { ...claim, deletedAt: 12 };
    expect(await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id, value,
      enqueueOnAdmission: false }, hashing)).toMatchObject({ fact: null,
      payload: JSON.stringify(value), payloadEncoding: 'rejected_json_v1', logicalDate: date, scopeKey: null });
  });

  it('does not turn a rejected signed zero into valid claim bytes while snapshotting JSON', async () => {
    expect(await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
      value: { ...claim, createdAt: -0 }, enqueueOnAdmission: false }, hashing))
      .toMatchObject({ fact: null, payloadEncoding: 'rejected_json_v1' });
  });

  it('captures the trusted envelope and body before awaiting hashing', async () => {
    const body = { ...action };
    const input = candidate(body);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const result = prepareRemoteFact(input, { ...hashing, sha256: async bytes => {
      await held; return hashing.sha256(bytes);
    } });
    Object.assign(input, { factType: 'ledger_entry', factId: 'bad-after-hash-start', enqueueOnAdmission: true,
      value: { ...claim } });
    body.logicalDate = '2026-09-09' as LogicalDate;
    release();
    expect(await result).toMatchObject({ factType: 'habit_action', factId: action.id, enqueueOnAdmission: false,
      scopeKey: `check:${boardId}:${date}`, fact: { factType: 'habit_action', value: action } });
  });

  it('propagates policy and provenance byte bounds as operation capacity instead of invalid quarantine', async () => {
    await expect(prepareRemoteFact(candidate({ ...action, policyJson: ' '.repeat(196609) }), hashing))
      .rejects.toMatchObject({ reason: 'capacity' });
    await expect(prepareRemoteFact({ factType: 'ledger_entry', factId: '00000000-0000-5000-8000-000000000099',
      value: { ...claim, id: '00000000-0000-5000-8000-000000000099', kind: 'adjustment', delta: 1,
        rewardId: null, rewardTitleSnapshot: null, scopeKey: `check:${boardId}:${date}`,
        reconciliationKey: 'a'.repeat(64), provenanceJson: ' '.repeat(524289) }, enqueueOnAdmission: false }, hashing))
      .rejects.toMatchObject({ reason: 'capacity' });
  });

  it('throws for an untrusted identity, non-JSON body, or individually unretainable diagnostic', async () => {
    for (const invalid of [{ ...candidate(), factId: 'not-a-uuid' },
      { ...candidate(), factType: 'check_in' }, { ...candidate(), enqueueOnAdmission: 1 }]) {
      await expect(prepareRemoteFact(invalid as never, hashing)).rejects.toMatchObject({ reason: 'envelope' });
    }
    await expect(prepareRemoteFact({ ...candidate(), value: undefined }, hashing)).rejects.toBeInstanceOf(RemoteFactAdmissionError);
    await expect(prepareRemoteFact(candidate('é'.repeat(393216)), hashing)).rejects.toMatchObject({ reason: 'capacity' });
    await expect(prepareRemoteFact(null as never, hashing)).rejects.toMatchObject({ reason: 'envelope' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(prepareRemoteFact(candidate(cyclic), hashing)).rejects.toMatchObject({ reason: 'envelope' });
  });

  it('uses only validated exact-date selectors for ordinary ledger candidates and malformed diagnostics', async () => {
    const ordinary = { ...claim, id: '00000000-0000-5000-8000-000000000099', kind: 'check', delta: 1,
      boardId, checkInId, rewardId: null, rewardTitleSnapshot: null, scopeKey: `check:${boardId}:${date}`,
      sourceActionId: action.id };
    const input = { factType: 'ledger_entry' as const, factId: ordinary.id, value: ordinary, enqueueOnAdmission: false };
    expect(await prepareRemoteFact(input, hashing)).toMatchObject({ scopeKey: ordinary.scopeKey,
      logicalDate: date, fact: { factType: 'ledger_entry', value: ordinary } });
    for (const scopeKey of ['garbage', `wrong:${boardId}:${date}`, `check:bad:${date}`, `check:${boardId}:2026-09-08`]) {
      expect(await prepareRemoteFact({ ...input, value: { ...ordinary, scopeKey } }, hashing))
        .toMatchObject({ fact: null, logicalDate: date, scopeKey: null });
    }
  });

  it('applies the record bound to canonical tuple bytes rather than the larger JSON transport object', async () => {
    const budget = 786432;
    const bounded = { ...action, mutationStamp: action.mutationStamp + 'x'.repeat(budget - Buffer.byteLength(canonicalHabitAction(action))) };
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeGreaterThan(budget);
    const prepared = await prepareRemoteFact(candidate(bounded), hashing);
    expect(prepared.payloadBytes).toBe(budget);
    expect(prepared.payloadEncoding).toBe('canonical_v1');
    await expect(prepareRemoteFact(candidate({ ...bounded, mutationStamp: bounded.mutationStamp + 'x' }), hashing))
      .rejects.toMatchObject({ reason: 'capacity' });
  });

  it('does not hide unexpected validator failures as malformed source evidence', async () => {
    const failure = new Error('validator dependency failed');
    const spy = jest.spyOn(ledger, 'assertCoinLedgerShape').mockImplementation(() => { throw failure; });
    try {
      await expect(prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id, value: claim,
        enqueueOnAdmission: false }, hashing)).rejects.toBe(failure);
    } finally { spy.mockRestore(); }
  });

  it('propagates hasher rejection and malformed digest output instead of quarantining a valid fact', async () => {
    const failure = new Error('hashing cancelled');
    await expect(prepareRemoteFact(candidate(), { ...hashing, sha256: async () => { throw failure; } })).rejects.toBe(failure);
    await expect(prepareRemoteFact(candidate(), { ...hashing, sha256: async () => new Uint8Array(31) })).rejects.toThrow('SHA-256');
    const baseline = await baselineAction({ id: checkInId, boardId, logicalDate: date }, hashing);
    await expect(prepareRemoteFact({ ...candidate(baseline), factId: baseline.id },
      { ...hashing, sha1: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
