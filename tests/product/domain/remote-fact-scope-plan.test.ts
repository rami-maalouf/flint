import { canonicalCoinProvenance, coinDigest, compareCoinTuple, type CoinFingerprint } from '@/core/domain/coin-provenance';
import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { bonusAwardRow, type BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { canonicalCoinPolicy, COIN_RECORD_BYTES, CoinContractError, parseCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import type { CanonicalRemoteFact } from '@/core/domain/remote-fact-validation';
import { planRemoteCoinScope, type RemoteCoinScope } from '@/core/domain/remote-fact-scope-plan';

import { createTestHashing } from '../helpers/test-db';

const hashing = createTestHashing();
const checkScope = { kind: 'check', ...checkFixture.scope } as RemoteCoinScope;
const checkActions = checkFixture.correction.actions as HabitAction[];
const checkRows = checkFixture.correction.existingRows as CoinLedgerRow[];
const correction = checkFixture.correction.expectedAppend[0] as CoinLedgerRow;

describe('pure exact-scope remote fact planning', () => {
  it('retains valid partial-replica awards and generates only their full-union correction', async () => {
    const plan = await planRemoteCoinScope({ scope: checkScope, actions: checkActions,
      acceptedRows: [], candidateRows: checkRows, knownFacts: [] }, hashing);
    expect(plan).toMatchObject({ capacity: 'fits', ordinaryEvidenceCount: 4,
      generatedRows: checkFixture.correction.expectedAppend });
    expect(plan.candidateResults).toEqual(expect.arrayContaining(checkRows.map(row => ({ id: row.id, status: 'valid' }))));
    expect(plan.candidateResults).toHaveLength(2);
  });

  it('uses a legitimately generated award to validate its supplied reversal in the same scope plan', async () => {
    const vector = checkFixture.cases.find(item => item.name === 'targeted removal never promotes a cap-blocked check')!;
    const award = vector.ordinaryRows[0] as CoinLedgerRow;
    const reversal = vector.ordinaryRows[1] as CoinLedgerRow;
    expect(await planRemoteCoinScope({ scope: checkScope, actions: vector.actions as HabitAction[],
      acceptedRows: [], candidateRows: [reversal], knownFacts: [] }, hashing)).toEqual({
      capacity: 'fits', ordinaryEvidenceCount: 5, generatedRows: [award],
      candidateResults: [{ id: reversal.id, status: 'valid' }],
    });
  });

  it('waits for a raw partial award named by a proof instead of generating an abandoned speculative award', async () => {
    const plan = await planRemoteCoinScope({ scope: checkScope, actions: checkActions,
      acceptedRows: [], candidateRows: [correction], knownFacts: [] }, hashing);
    expect(plan).toMatchObject({ capacity: 'fits', ordinaryEvidenceCount: 3,
      candidateResults: [{ id: correction.id, status: 'pending' }] });
    expect(plan.generatedRows).toHaveLength(1);
    expect(plan.generatedRows[0]).toEqual(checkRows[0]);
  });

  it('accepts a complete self-contained correction and emits no duplicate row', async () => {
    expect(await planRemoteCoinScope({ scope: checkScope, actions: checkActions,
      acceptedRows: checkRows, candidateRows: [correction], knownFacts: [] }, hashing)).toEqual({
      capacity: 'fits', ordinaryEvidenceCount: 4, generatedRows: [],
      candidateResults: [{ id: correction.id, status: 'valid' }],
    });
  });

  it('derives merged-only bonus completion using the existing literal cause and bytes', async () => {
    const vector = bonusFixture.reconciliationCases[0];
    const plan = await planRemoteCoinScope({ scope: { kind: 'bonus', ...vector.scope } as RemoteCoinScope,
      actions: vector.actions as HabitAction[], acceptedRows: [], candidateRows: [], knownFacts: [] }, hashing);
    expect(plan).toEqual({ capacity: 'fits', ordinaryEvidenceCount: 3, candidateResults: [],
      generatedRows: vector.expectedAppendedRows });
  });

  it('isolates a shape-valid bad cause without withholding unrelated valid raw rows', async () => {
    const invalid = { ...checkRows[0], createdAt: checkRows[0].createdAt + 1 };
    const plan = await planRemoteCoinScope({ scope: checkScope, actions: checkActions,
      acceptedRows: [], candidateRows: [invalid, checkRows[1]], knownFacts: [] }, hashing);
    expect(plan.capacity).toBe('fits');
    expect(plan.ordinaryEvidenceCount).toBe(4);
    expect(plan.candidateResults).toEqual(expect.arrayContaining([
      { id: invalid.id, status: 'invalid' }, { id: checkRows[1].id, status: 'valid' },
    ]));
    expect(plan.generatedRows).toEqual([checkRows[0], correction]);
  });

  it.each(bonusFixture.reconciliationCases)('preserves the literal bonus admission fixed point: $name', async vector => {
    const rows = vector.rows as CoinLedgerRow[];
    const plan = await planRemoteCoinScope({ scope: { kind: 'bonus', ...vector.scope } as RemoteCoinScope,
      actions: vector.actions as HabitAction[], acceptedRows: [], candidateRows: rows, knownFacts: [] }, hashing);
    expect(plan.capacity).toBe('fits');
    expect(plan.candidateResults.every(result => result.status === 'valid')).toBe(true);
    expect(plan.candidateResults).toHaveLength(rows.length);
    expect(plan.generatedRows).toEqual(vector.expectedAppendedRows);
    const repeated = await planRemoteCoinScope({ scope: { kind: 'bonus', ...vector.scope } as RemoteCoinScope,
      actions: [...vector.actions].reverse() as HabitAction[], acceptedRows: [...rows, ...plan.generatedRows],
      candidateRows: rows, knownFacts: [] }, hashing);
    expect(repeated.generatedRows).toEqual([]);
    expect(repeated.capacity).toBe('fits');
  });

  it('recovers a referenced G outside current E before distinguishing missing, disabled and not-required controls', async () => {
    const vector = bonusFixture.reconciliationCases[0];
    const scope = { kind: 'bonus', ...vector.scope } as RemoteCoinScope & { kind: 'bonus' };
    const root = vector.actions[0] as HabitAction;
    const originalG = vector.actions[1] as HabitAction;
    const basePolicy = parseCoinPolicy(originalG.policyJson!);
    const g = { ...originalG, policyJson: canonicalCoinPolicy({ ...basePolicy,
      rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
    const knowledge: CanonicalRemoteFact[] = [{ factType: 'habit_action', value: g }];
    const w = vector.expectedAppendedRows[0] as CoinLedgerRow;
    const pending = await planRemoteCoinScope({ scope, actions: [], acceptedRows: [], candidateRows: [w], knownFacts: knowledge }, hashing);
    expect(pending).toEqual({ capacity: 'fits', ordinaryEvidenceCount: 0, generatedRows: [],
      candidateResults: [{ id: w.id, status: 'pending' }] });

    for (const policy of [{ ...basePolicy, bonusEnabled: false }, { ...basePolicy, requiredBoardIds: [root.boardId] }]) {
      const control = { ...root, id: 'aaaaaaaa-0000-4000-8000-000000000001' as HabitAction['id'],
        kind: 'policy' as const, checkInId: null, policyJson: canonicalCoinPolicy(policy) };
      const invalid = await bonusAwardRow(scope, g, policy, hashing);
      const plan = await planRemoteCoinScope({ scope, actions: [control], acceptedRows: [], candidateRows: [invalid], knownFacts: knowledge }, hashing);
      expect(plan.candidateResults).toEqual([{ id: invalid.id, status: 'invalid' }]);
      expect(plan.generatedRows).toEqual([]);
    }
    const control = { ...root, id: 'aaaaaaaa-0000-4000-8000-000000000002' as HabitAction['id'],
      kind: 'policy' as const, checkInId: null };
    const complete = await planRemoteCoinScope({ scope, actions: [control, root, g], acceptedRows: [], candidateRows: [w], knownFacts: knowledge }, hashing);
    expect(complete.candidateResults).toEqual([{ id: w.id, status: 'valid' }]);
    expect(complete.generatedRows).toEqual([]);
    expect(await planRemoteCoinScope({ scope, actions: [], acceptedRows: [], candidateRows: [w], knownFacts: knowledge }, hashing)).toEqual(pending);
  });

  it('fits the real4093-base final action set and blocks only when a partial award was actually supplied', async () => {
    const earlier = { ...checkActions[1], mutationStamp: '00000000000001-00001-fixture' };
    const later = { ...checkActions[0], mutationStamp: '00000000000002-00001-fixture' };
    const base = Array.from({ length: 4093 }, (_, n): HabitAction => ({ ...checkActions[0],
      id: `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as HabitAction['id'],
      kind: 'uncheck', checkInId: null, policyJson: null, mutationStamp: '00000000000000-00000-base' }));
    const ownEarlier = await planRemoteCoinScope({ scope: checkScope, actions: [earlier], acceptedRows: [], candidateRows: [], knownFacts: [] }, hashing);
    const ownLater = await planRemoteCoinScope({ scope: checkScope, actions: [later], acceptedRows: [], candidateRows: [], knownFacts: [] }, hashing);
    const input = { scope: checkScope, actions: [...base, later, earlier], acceptedRows: [], candidateRows: [], knownFacts: [] };
    const full = await planRemoteCoinScope(input, hashing);
    expect(full).toMatchObject({ capacity: 'fits', ordinaryEvidenceCount: 4096, generatedRows: ownEarlier.generatedRows });
    expect(await planRemoteCoinScope({ ...input, actions: [...input.actions].reverse() }, hashing)).toEqual(full);
    const blocked = await planRemoteCoinScope({ ...input, candidateRows: ownLater.generatedRows }, hashing);
    expect(blocked).toMatchObject({ capacity: 'blocked', ordinaryEvidenceCount: 4097, generatedRows: [],
      candidateResults: [{ id: ownLater.generatedRows[0].id, status: 'valid' }] });
  });

  it('never turns guarded provider invalid/missing/size or cancellation into a candidate or scope decision', async () => {
    for (const failure of [new CoinContractError('invalid'), new CoinContractError('missing'), new CoinContractError('size'),
      Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
      const cause = await planRemoteCoinScope({ scope: checkScope, actions: checkActions,
        acceptedRows: [], candidateRows: [correction], knownFacts: [] },
      { ...hashing, sha256: async () => { throw failure; } }).catch(error => error);
      expect(cause).toBeInstanceOf(RemoteFactHashingError);
      expect(cause.cause).toBe(failure);
    }
  });
});

describe('scope candidate dependency and proof classification', () => {
  const empty = { scope: checkScope, actions: [] as HabitAction[], acceptedRows: [] as CoinLedgerRow[],
    candidateRows: [] as CoinLedgerRow[], knownFacts: [] as CanonicalRemoteFact[] };
  const fact = (value: HabitAction | CoinLedgerRow): CanonicalRemoteFact => 'commandId' in value
    ? { factType: 'habit_action', value } : { factType: 'ledger_entry', value };
  const changedDate = '2026-09-07' as HabitAction['logicalDate'];
  const foreignBoard = 'ffffffff-0000-4000-8000-000000000001' as HabitAction['boardId'];
  const removalVector = checkFixture.cases.find(item => item.name === 'targeted removal never promotes a cap-blocked check')!;
  const reversal = removalVector.ordinaryRows[1] as CoinLedgerRow;
  const removal = removalVector.actions.find(action => action.id === reversal.sourceActionId)! as HabitAction;
  const cancellation = checkFixture.overlap.expectedAppend[1] as CoinLedgerRow;

  async function status(row: CoinLedgerRow, knownFacts: CanonicalRemoteFact[], actions: HabitAction[] = []) {
    const result = await planRemoteCoinScope({ ...empty, candidateRows: [row], knownFacts, actions }, hashing);
    return result.candidateResults[0].status;
  }
  async function proofRow(values: (HabitAction | CoinLedgerRow)[], base = correction) {
    const fingerprints = await Promise.all(values.map(async value => [
      'commandId' in value ? 'habit_action' : 'ledger_entry', value.id,
      await coinDigest('commandId' in value ? canonicalHabitAction(value) : canonicalCoinLedger(value), hashing),
    ] as CoinFingerprint));
    return { ...base, provenanceJson: canonicalCoinProvenance(fingerprints.sort(compareCoinTuple)) };
  }

  it('distinguishes absent action causes from known causes on another date or board', async () => {
    expect(await status(checkRows[0], [])).toBe('pending');
    const source = checkActions.find(action => action.id === checkRows[0].sourceActionId)!;
    expect(await status(checkRows[0], [fact({ ...source, logicalDate: changedDate })])).toBe('invalid');
    expect(await status(checkRows[0], [fact({ ...source, boardId: foreignBoard })])).toBe('invalid');
  });

  it('classifies a known forbidden reversal target before a missing source action', async () => {
    const wrongAward = { ...correction, id: reversal.reversesId! };
    expect(await status(reversal, [fact(wrongAward)])).toBe('invalid');
    expect(await status(reversal, [fact({ ...removal, boardId: foreignBoard })])).toBe('invalid');
    expect(await status(reversal, [])).toBe('pending');
  });

  it('rejects a known non-removal source even when its referenced award has not arrived', async () => {
    for (const source of [
      { ...removal, kind: 'policy' as const, checkInId: null },
      { ...removal, kind: 'check' as const },
      { ...removal, kind: 'move_in' as const },
    ]) expect(await status(reversal, [fact(source)])).toBe('invalid');
    const source = checkActions.find(action => action.id === checkRows[0].sourceActionId)!;
    expect(await status(checkRows[0], [fact({ ...source, kind: 'policy', checkInId: null })])).toBe('invalid');
  });

  it('requires an admitted or currently generated award for reversals and diagnoses present wrong-role references', async () => {
    expect(await status(reversal, [fact(removal)])).toBe('pending');
    expect(await status(reversal, [fact(removal), fact(checkRows[0])])).toBe('pending');
    const wrongRole = { ...correction, id: reversal.reversesId! };
    expect(await status(reversal, [fact(removal), fact(wrongRole)])).toBe('invalid');
    const wrongScope = { ...checkRows[0], boardId: foreignBoard, scopeKey: `check:${foreignBoard}:${checkScope.logicalDate}` };
    expect(await status(reversal, [fact(removal), fact(wrongScope)])).toBe('invalid');
    const badReversal = { ...reversal, createdAt: reversal.createdAt + 1 };
    expect(await status(badReversal, [], removalVector.actions as HabitAction[])).toBe('invalid');
  });

  it('validates original correction and cancellation literals against one final E and preserves receipt-like retries', async () => {
    const rows = checkFixture.overlap.existingRows as CoinLedgerRow[];
    const input = { ...empty, actions: checkFixture.overlap.actions as HabitAction[], candidateRows: [...rows, cancellation] };
    const first = await planRemoteCoinScope(input, hashing);
    expect(first.candidateResults.every(result => result.status === 'valid')).toBe(true);
    expect(first.generatedRows).toEqual(checkFixture.overlap.expectedAppend.filter(row => row.id !== cancellation.id));
    const second = await planRemoteCoinScope({ ...input, acceptedRows: [...rows, cancellation, ...first.generatedRows], candidateRows: [] }, hashing);
    expect(second.generatedRows).toEqual([]);
    expect(second.ordinaryEvidenceCount).toBe(6);
  });

  it('leaves cancellations pending until their original valid proof has a strict superset', async () => {
    expect(await status(cancellation, [])).toBe('pending');
    expect(await status(cancellation, [fact(correction)])).toBe('pending');
    const exact = await planRemoteCoinScope({ ...empty, actions: checkActions, acceptedRows: [...checkRows, correction], candidateRows: [cancellation] }, hashing);
    expect(exact.candidateResults).toEqual([{ id: cancellation.id, status: 'pending' }]);
    expect(exact.generatedRows).toEqual([]);
  });

  it('rejects wrong-role/scope parents and corrupt cancellation bytes without rejecting independent candidates', async () => {
    expect(await status(cancellation, [fact({ ...checkRows[0], id: cancellation.adjustsId! })])).toBe('invalid');
    expect(await status(cancellation, [fact({ ...correction, adjustsId: checkRows[0].id })])).toBe('invalid');
    expect(await status(cancellation, [fact({ ...correction, scopeKey: `check:${foreignBoard}:${checkScope.logicalDate}` })])).toBe('invalid');
    const input = { ...empty, actions: checkFixture.overlap.actions as HabitAction[], acceptedRows: checkFixture.overlap.existingRows as CoinLedgerRow[] };
    const bad = { ...cancellation, delta: 2 };
    const plan = await planRemoteCoinScope({ ...input, candidateRows: [bad] }, hashing);
    expect(plan.candidateResults).toEqual([{ id: bad.id, status: 'invalid' }]);
    expect(plan.generatedRows).toEqual(checkFixture.overlap.expectedAppend);
    await expect(planRemoteCoinScope({ ...input, acceptedRows: [...input.acceptedRows, bad] }, hashing))
      .rejects.toMatchObject({ reason: 'integrity' });
  });

  it('treats malformed accepted economics as an operation integrity failure, never a candidate quarantine', async () => {
    await expect(planRemoteCoinScope({ ...empty, actions: checkActions,
      acceptedRows: [{ ...checkRows[0], createdAt: checkRows[0].createdAt + 1 }] }, hashing)).rejects.toMatchObject({ reason: 'integrity' });
    await expect(planRemoteCoinScope({ ...empty, acceptedRows: [correction] }, hashing)).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('rejects present proof facts with another date, check board, ledger role, or ledger scope', async () => {
    const values: (HabitAction | CoinLedgerRow)[] = [
      { ...checkActions[0], logicalDate: changedDate },
      { ...checkActions[0], boardId: foreignBoard },
      { ...correction, id: 'aaaaaaaa-0000-5000-8000-000000000001' as CoinLedgerRow['id'] },
      { ...checkRows[0], boardId: foreignBoard, scopeKey: `check:${foreignBoard}:${checkScope.logicalDate}` },
    ];
    for (const value of values) expect(await status(await proofRow([value]), [fact(value)])).toBe('invalid');
  });

  it('classifies known direct proof defects before an earlier missing reference', async () => {
    const missing = checkActions.find(action => action.id.endsWith('1'))!;
    const later = checkActions.find(action => action.id.endsWith('2'))!;
    for (const known of [
      { ...correction, id: 'aaaaaaaa-0000-5000-8000-000000000001' as CoinLedgerRow['id'] },
      { ...later, logicalDate: changedDate },
      { ...later, boardId: foreignBoard },
    ]) {
      const row = await proofRow([missing, known]);
      expect(await status(row, [fact(known)])).toBe('invalid');
    }
    const withHash = await proofRow([missing, later]);
    const parsed = JSON.parse(withHash.provenanceJson!);
    parsed.facts[1][2] = 'f'.repeat(64);
    const badHash = { ...withHash, provenanceJson: canonicalCoinProvenance(parsed.facts) };
    expect(await status(badHash, [fact(later)])).toBe('invalid');
    const stateOnly = { ...later, policyJson: null };
    const inEnvelope = await proofRow([missing, stateOnly]);
    const changedHash = JSON.parse(inEnvelope.provenanceJson!);
    changedHash.facts[1][2] = 'f'.repeat(64);
    expect(await status({ ...inEnvelope, provenanceJson: canonicalCoinProvenance(changedHash.facts) }, [], [stateOnly])).toBe('invalid');
    expect(await status(withHash, [fact(later)])).toBe('pending');
  });

  it('checks hashes of known facts outside E and refuses a valid proof when the caller omitted its complete scope', async () => {
    const known = [...checkActions, ...checkRows].map(fact);
    const badHash = { ...correction, provenanceJson: correction.provenanceJson!.replace('57905a64', '67905a64') };
    expect(await status(badHash, known)).toBe('invalid');
    await expect(planRemoteCoinScope({ ...empty, candidateRows: [correction], knownFacts: known }, hashing))
      .rejects.toMatchObject({ reason: 'integrity' });
  });

  it('rejects complete bonus proofs that omit their control even when G is known outside E', async () => {
    const vector = bonusFixture.reconciliationCases[0];
    const scope = { kind: 'bonus' as const, ...vector.scope } as RemoteCoinScope;
    const originalG = vector.actions[1] as HabitAction;
    const policy = parseCoinPolicy(originalG.policyJson!);
    const g = { ...originalG, policyJson: canonicalCoinPolicy({ ...policy,
      rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
    const award = vector.expectedAppendedRows[0] as CoinLedgerRow;
    const base = { ...correction, scopeKey: award.scopeKey, logicalDate: award.logicalDate };
    const row = await proofRow([g, award], base);
    const control = { ...vector.actions[0], kind: 'policy', checkInId: null } as HabitAction;
    for (const actions of [[], [control]]) {
      const plan = await planRemoteCoinScope({ scope, actions, acceptedRows: [], candidateRows: [row], knownFacts: [fact(g), fact(award)] }, hashing);
      expect(plan.candidateResults).toEqual([{ id: row.id, status: 'invalid' }]);
      expect(plan.generatedRows).toEqual([]);
    }
  });

  it('does not borrow unlisted check source evidence into a complete correction proof', async () => {
    const row = await proofRow([checkRows[0]]);
    expect(await status(row, [fact(checkRows[0]), ...checkActions.map(fact)])).toBe('invalid');
    const invalidAward = { ...checkRows[0], createdAt: checkRows[0].createdAt + 1 };
    expect(await status(await proofRow([...checkActions, invalidAward]), [...checkActions, invalidAward].map(fact))).toBe('invalid');
  });

  it('propagates hashing failure during candidate classification and outside-E proof validation', async () => {
    const failure = new CoinContractError('size');
    const failing = { ...hashing, sha1: async () => { throw failure; } };
    const source = checkActions.find(action => action.id === checkRows[0].sourceActionId)!;
    for (const request of [
      { ...empty, candidateRows: [checkRows[0]], knownFacts: [fact(source)] },
      { ...empty, candidateRows: [correction], knownFacts: [...checkActions, ...checkRows].map(fact) },
    ]) {
      const error = await planRemoteCoinScope(request, failing).catch(error => error);
      expect(error).toBeInstanceOf(RemoteFactHashingError);
      expect(error.cause).toBe(failure);
    }
  });

  it('fails the operation if the final generated correction exceeds the record byte limit', async () => {
    const lateClear = { ...checkActions[0], id: 'aaaaaaaa-0000-4000-8000-000000000001' as HabitAction['id'],
      kind: 'uncheck' as const, checkInId: null, policyJson: null, createdAt: 1788926400001,
      mutationStamp: `99999999999999-zzzzz-${'a'.repeat(COIN_RECORD_BYTES - 500)}` };
    await expect(planRemoteCoinScope({ ...empty, actions: [...checkActions, lateClear], candidateRows: checkRows }, hashing))
      .rejects.toMatchObject({ reason: 'capacity' });
  });

  it('rejects a hashing-port collision instead of overwriting different generated award bytes', async () => {
    const source = checkActions[0];
    const policy = parseCoinPolicy(source.policyJson!);
    const sources = checkActions.map(action => ({ ...action, policyJson: canonicalCoinPolicy({ ...policy, coinCapPerDay: 2 }) }));
    await expect(planRemoteCoinScope({ ...empty, actions: sources }, { ...hashing, sha1: async () => new Uint8Array(20) }))
      .rejects.toMatchObject({ reason: 'integrity' });
  });

  it('propagates the guarded provider cause when accepted-scope replay itself fails', async () => {
    const failure = new Error('sha provider offline');
    const error = await planRemoteCoinScope({ ...empty, actions: checkActions },
      { ...hashing, sha1: async () => { throw failure; } }).catch(error => error);
    expect(error).toBeInstanceOf(RemoteFactHashingError);
    expect(error.cause).toBe(failure);
  });

  it('captures full caller input before awaiting and can retry with an independently prepared context', async () => {
    const input = { ...empty, actions: checkActions.map(action => ({ ...action })), candidateRows: checkRows.map(row => ({ ...row })) };
    const original = structuredClone(input);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const running = planRemoteCoinScope(input, { ...hashing, sha1: async bytes => { await waiting; return hashing.sha1(bytes); } });
    input.actions[0].policyJson = null; input.actions.length = 0;
    input.candidateRows[0].createdAt += 1; input.candidateRows.length = 0;
    release();
    expect(await running).toEqual(await planRemoteCoinScope(original, hashing));
  });
});
