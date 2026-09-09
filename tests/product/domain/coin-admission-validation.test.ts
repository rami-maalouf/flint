import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { reconcileBonusCoins } from '@/core/domain/bonus-reconciliation';
import { canonicalCoinLedger, checkCoinRow, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { CoinContractError } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance, coinDigest, compareCoinTuple, parseCoinProvenance, type CoinFingerprint } from '@/core/domain/coin-provenance';
import { reconcileCheckCoins, validateCheckOrdinary } from '@/core/domain/coin-reconciliation';
import { prepareCoinCancellation, prepareCoinEvidence, validateCoinCorrection, type ReconciliationContext } from '@/core/domain/coin-reconciliation-core';
import { replayCheckCoins, type CheckCoinScope } from '@/core/domain/coins';
import { uuidV5 } from '@/core/domain/deterministic-ids';
import { canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';

import { createTestHashing } from '../helpers/test-db';

const hashing = createTestHashing();
const checkScope = checkFixture.scope as CheckCoinScope;
const checkActions = checkFixture.correction.actions as HabitAction[];
const checkRows = checkFixture.correction.existingRows as CoinLedgerRow[];
const checkCorrection = checkFixture.correction.expectedAppend[0] as CoinLedgerRow;
const context: ReconciliationContext = { scopeKey: checkCorrection.scopeKey!, logicalDate: checkScope.logicalDate,
  awardKind: 'check', replay: actions => replayCheckCoins(checkScope, actions, hashing),
  validateOrdinary: (actions, rows) => validateCheckOrdinary(actions, rows, hashing) };

async function proofRow(facts: CoinFingerprint[]): Promise<CoinLedgerRow> {
  const provenanceJson = canonicalCoinProvenance([...facts].sort(compareCoinTuple));
  const reconciliationKey = await coinDigest(provenanceJson, hashing);
  return { ...checkCorrection, provenanceJson, reconciliationKey,
    id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'adjustment', context.scopeKey, reconciliationKey]), hashing) as CoinLedgerRow['id'] };
}

describe('public correction validation dependency failures', () => {
  it.each(['hash unavailable', 'AbortError'])('propagates %s from hashing the complete check proof subset', async (name) => {
    const failure = new Error(name);
    failure.name = name;
    let hashingSubset = false;
    let failedInsideSubset = false;
    const port = { ...hashing,
      sha256: async (bytes: Uint8Array) => {
        if (new TextDecoder().decode(bytes) === canonicalHabitAction(checkActions[0])) hashingSubset = true;
        return hashing.sha256(bytes);
      },
      sha1: async (bytes: Uint8Array) => {
        if (hashingSubset) { failedInsideSubset = true; throw failure; }
        return hashing.sha1(bytes);
      },
    };
    await expect(reconcileCheckCoins(checkScope, checkActions, [...checkRows, checkCorrection], port)).rejects.toBe(failure);
    expect(failedInsideSubset).toBe(true);
  });

  it('propagates a bonus policy fingerprint hashing failure after full evidence was prepared', async () => {
    const vector = bonusFixture.reconciliationCases.find(item => item.name === 'duplicate correction is already a fixed point')!;
    const failure = new Error('bonus policy hashing unavailable');
    let hashingSubset = false;
    let failedInsideSubset = false;
    const port = { ...hashing, sha256: async (bytes: Uint8Array) => {
      const text = new TextDecoder().decode(bytes);
      if (text === canonicalHabitAction(vector.actions[0] as HabitAction)) hashingSubset = true;
      if (hashingSubset && text.startsWith('["habit-bonus-policy-v1"')) {
        failedInsideSubset = true;
        throw failure;
      }
      return hashing.sha256(bytes);
    } };
    await expect(reconcileBonusCoins(vector.scope as BonusCoinScope, vector.actions as HabitAction[],
      vector.rows as CoinLedgerRow[], port)).rejects.toBe(failure);
    expect(failedInsideSubset).toBe(true);
  });
});

describe('prepared exact-scope evidence and candidate correction validation', () => {
  it('hashes unique facts once, preserving typed lookup and caller input bytes', async () => {
    const before = JSON.stringify([checkActions, checkRows]);
    const sha256 = jest.fn(hashing.sha256);
    const prepared = await prepareCoinEvidence([...checkActions, ...checkActions], [...checkRows, ...checkRows], { ...hashing, sha256 });
    expect(sha256).toHaveBeenCalledTimes(checkActions.length + checkRows.length);
    expect(prepared.facts.map(fact => fact.fingerprint)).toEqual(parseCoinProvenance(checkCorrection.provenanceJson!));
    expect(prepared.get('habit_action', checkActions[0].id)?.value).toEqual(checkActions[0]);
    expect(prepared.get('ledger_entry', checkRows[0].id)?.value).toEqual(checkRows[0]);
    expect(prepared.get('ledger_entry', checkActions[0].id)).toBeUndefined();
    expect(JSON.stringify([checkActions, checkRows])).toBe(before);
  });

  it('keeps every prepared value paired with its original hash while caller-owned inputs change', async () => {
    const actions = checkActions.map(action => ({ ...action }));
    const rows = checkRows.map(row => ({ ...row }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preparing = prepareCoinEvidence(actions, rows, { ...hashing, sha256: async bytes => {
      await held; return hashing.sha256(bytes);
    } });
    actions[0].createdAt += 1;
    actions[1].policyJson = null;
    rows[0].mutationStamp = '00000000000000-00000-changed';
    rows.length = 0;
    release();
    const prepared = await preparing;
    expect(prepared.facts.map(fact => fact.fingerprint)).toEqual(parseCoinProvenance(checkCorrection.provenanceJson!));
    expect(prepared.get('habit_action', checkActions[0].id)?.value).toEqual(checkActions[0]);
    expect(Object.isFrozen(prepared.facts)).toBe(true);
    expect(Object.isFrozen(prepared.get('habit_action', checkActions[0].id)?.value)).toBe(true);
  });

  it('refuses conflicting immutable duplicates and never inserts adjustment or claim knowledge into ordinary E', async () => {
    await expect(prepareCoinEvidence([checkActions[0], { ...checkActions[0], createdAt: 2 }], [], hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(prepareCoinEvidence([], [checkRows[0], { ...checkRows[0], createdAt: 2 }], hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
    const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    for (const row of [checkCorrection, claim]) {
      await expect(prepareCoinEvidence([], [row], hashing)).rejects.toMatchObject({ reason: 'invalid' });
    }
  });

  it('validates candidate corrections independently against the same prepared evidence', async () => {
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    const facts = parseCoinProvenance(checkCorrection.provenanceJson!);
    const bad = await proofRow(facts.map((fact, index) => index ? fact : [fact[0], fact[1], 'f'.repeat(64)]));
    await expect(validateCoinCorrection(context, bad, prepared, new Map(), hashing)).rejects.toMatchObject({ reason: 'invalid' });
    const parent = await validateCoinCorrection(context, checkCorrection, prepared, new Map(), hashing);
    expect(parent.row).toEqual(checkCorrection);
    expect(await prepareCoinCancellation(parent, hashing)).toBeNull();
  });

  it('distinguishes a present wrong-role proof dependency from an absent typed identity', async () => {
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    const facts = parseCoinProvenance(checkCorrection.provenanceJson!);
    const requested = await proofRow([...facts, ['ledger_entry', checkCorrection.id, await coinDigest(canonicalCoinLedger(checkCorrection), hashing)]]);
    await expect(validateCoinCorrection(context, requested, prepared, new Map(), hashing)).rejects.toMatchObject({ reason: 'missing' });
    await expect(validateCoinCorrection(context, requested, prepared,
      new Map([[checkCorrection.id, checkCorrection]]), hashing)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('waits for missing action or eligible ordinary evidence but rejects a known dependency from another exact scope', async () => {
    const missingAction = await prepareCoinEvidence(checkActions.slice(1), checkRows, hashing);
    await expect(validateCoinCorrection(context, checkCorrection, missingAction, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'missing' });
    const missingRow = await prepareCoinEvidence(checkActions, checkRows.slice(1), hashing);
    await expect(validateCoinCorrection(context, checkCorrection, missingRow,
      new Map([[checkRows[0].id, checkRows[0]]]), hashing)).rejects.toMatchObject({ reason: 'missing' });
    const foreign = await checkCoinRow({ ...checkActions[0], logicalDate: '2026-09-09' as HabitAction['logicalDate'],
      id: '00000000-0000-4000-8000-000000000999' as HabitAction['id'] }, hashing);
    const proof = await proofRow([...parseCoinProvenance(checkCorrection.provenanceJson!),
      ['ledger_entry', foreign.id, await coinDigest(canonicalCoinLedger(foreign), hashing)]]);
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    await expect(validateCoinCorrection(context, proof, prepared, new Map([[foreign.id, foreign]]), hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects an omitted necessary cause after every listed proof fingerprint is available', async () => {
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    const facts = parseCoinProvenance(checkCorrection.provenanceJson!).filter(fact => fact[1] !== checkActions[0].id);
    await expect(validateCoinCorrection(context, await proofRow(facts), prepared, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  it('keeps size, invalid and unexpected subset-validator failures distinct', async () => {
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    for (const failure of [new CoinContractError('size'), new CoinContractError('invalid'), new Error('cancelled')]) {
      await expect(validateCoinCorrection({ ...context, validateOrdinary: async () => { throw failure; } },
        checkCorrection, prepared, new Map(), hashing)).rejects.toBe(failure);
    }
  });

  it('binds cancellation to a validated parent subset of the same unique E, without duplicate inflation', async () => {
    const exact = await prepareCoinEvidence([...checkActions, ...checkActions], [...checkRows, ...checkRows], hashing);
    const exactParent = await validateCoinCorrection(context, checkCorrection, exact, new Map(), hashing);
    expect(await prepareCoinCancellation(exactParent, hashing)).toBeNull();
    const union = checkFixture.overlap;
    const ordinary = union.existingRows.filter(row => row.kind !== 'adjustment') as CoinLedgerRow[];
    const expanded = await prepareCoinEvidence(union.actions as HabitAction[], ordinary, hashing);
    const parent = await validateCoinCorrection(context, checkCorrection, expanded, new Map(), hashing);
    const expected = union.expectedAppend.find(row => row.adjustsId === checkCorrection.id)!;
    expect(await prepareCoinCancellation(parent, hashing)).toEqual(expected);
    expect(await prepareCoinCancellation(parent, hashing)).toEqual(expected);
    expect(await prepareCoinCancellation(exactParent, hashing)).toBeNull();
    await expect(validateCoinCorrection(context, expected as CoinLedgerRow, expanded, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(validateCoinCorrection(context, checkRows[0], expanded, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  it('does not authorize cancellation merely because a different evidence set is larger than the parent proof', async () => {
    const union = checkFixture.overlap;
    const unrelatedSet = await prepareCoinEvidence(union.actions as HabitAction[], union.existingRows
      .filter(row => row.kind !== 'adjustment' && row.id !== checkRows[0].id) as CoinLedgerRow[], hashing);
    expect(unrelatedSet.facts.length).toBeGreaterThan(parseCoinProvenance(checkCorrection.provenanceJson!).length);
    await expect(validateCoinCorrection(context, checkCorrection, unrelatedSet, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'missing' });
  });

  it('captures parent and context before awaiting validation and protects the resulting cancellation authority', async () => {
    const union = checkFixture.overlap;
    const prepared = await prepareCoinEvidence(union.actions as HabitAction[],
      union.existingRows.filter(row => row.kind !== 'adjustment') as CoinLedgerRow[], hashing);
    const input = { ...checkCorrection };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const mutableContext = { ...context, validateOrdinary: async (actions: readonly HabitAction[], rows: readonly CoinLedgerRow[]) => {
      await held; return context.validateOrdinary(actions, rows);
    } };
    const validating = validateCoinCorrection(mutableContext, input, prepared, new Map(), hashing);
    input.delta = -99;
    input.provenanceJson = 'changed';
    mutableContext.scopeKey = 'changed';
    release();
    const parent = await validating;
    expect(parent.row).toEqual(checkCorrection);
    expect(Object.isFrozen(parent)).toBe(true);
    expect(() => Object.assign(parent.row, { delta: -99 })).toThrow(TypeError);
    expect(await prepareCoinCancellation(parent, hashing)).toEqual(union.expectedAppend.find(row => row.adjustsId === checkCorrection.id));
  });

  it('rejects a copied parent whose public row is replaced after genuine validation', async () => {
    const union = checkFixture.overlap;
    const prepared = await prepareCoinEvidence(union.actions as HabitAction[],
      union.existingRows.filter(row => row.kind !== 'adjustment') as CoinLedgerRow[], hashing);
    const parent = await validateCoinCorrection(context, checkCorrection, prepared, new Map(), hashing);
    await expect(prepareCoinCancellation({ ...parent, row: { ...parent.row, delta: -99 } }, hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
    expect(await prepareCoinCancellation(parent, hashing)).toEqual(union.expectedAppend.find(row => row.adjustsId === checkCorrection.id));
  });

  it('rejects copied prepared evidence that inflates its public count while retaining the real lookup', async () => {
    const prepared = await prepareCoinEvidence(checkActions, checkRows, hashing);
    const inflated = { ...prepared, facts: [...prepared.facts, prepared.facts[0]] };
    await expect(validateCoinCorrection(context, checkCorrection, inflated, new Map(), hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
    const parent = await validateCoinCorrection(context, checkCorrection, prepared, new Map(), hashing);
    expect(await prepareCoinCancellation(parent, hashing)).toBeNull();
  });
});
