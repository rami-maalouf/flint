import { replayBonusCoins } from './bonus-coins';
import { assertBonusEnvelope, prepareBonusActions } from './bonus-evidence';
import { prepareBonusOrdinaryValidator, validateBonusOrdinary } from './bonus-validation';
import { canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { COIN_PROOF_FACTS, CoinContractError } from './coin-policy';
import { coinDigest, parseCoinProvenance } from './coin-provenance';
import { validateCheckOrdinary } from './coin-reconciliation';
import { prepareCoinCancellation, prepareCoinEvidence, reconcileCoinEvidence, validateCoinCorrection,
  type ReconciliationContext, type ValidatedCoinCorrection } from './coin-reconciliation-core';
import { orderedCoinActions, replayCheckCoins } from './coins';
import { canonicalHabitAction, type HabitAction } from './habit-actions';
import type { LedgerEntryId } from './ids';
import type { Hashing } from './ports';
import { guardRemoteFactHashing } from './remote-fact-hashing';
import { captureRemoteCoinScope, remoteFactKey, type RemoteCoinScopeInput } from './remote-fact-scope-inputs';
import { RemoteFactAdmissionError, type CanonicalRemoteFact } from './remote-fact-validation';

export type { RemoteCoinScope, RemoteCoinScopeInput } from './remote-fact-scope-inputs';
export type RemoteCoinScopePlan = {
  capacity: 'fits' | 'blocked';
  ordinaryEvidenceCount: number;
  generatedRows: CoinLedgerRow[];
  candidateResults: { id: LedgerEntryId; status: 'valid' | 'pending' | 'invalid' }[];
};

// valid here is intrinsic scope validity, never cross-scope permission to persist a fact.
export async function planRemoteCoinScope(input: RemoteCoinScopeInput, sourceHashing: Hashing): Promise<RemoteCoinScopePlan> {
  const captured = captureRemoteCoinScope(input);
  const hashing = guardRemoteFactHashing(sourceHashing);
  const { scope, scopeKey, acceptedRows, candidateRows, facts } = captured;
  const awardKind = scope.kind === 'check' ? 'check' : 'run_bonus';
  async function operation<Value>(work: () => Promise<Value>): Promise<Value> {
    try { return await work(); }
    catch (cause) {
      if (cause instanceof CoinContractError) throw new RemoteFactAdmissionError(cause.reason === 'size' ? 'capacity' : 'integrity');
      throw cause;
    }
  }
  const actions = await operation(async () => {
    if (scope.kind === 'check') return orderedCoinActions(scope, captured.actions);
    const prepared = await prepareBonusActions(scope, captured.actions, hashing);
    assertBonusEnvelope(scope, prepared);
    return prepared;
  });
  const context: ReconciliationContext = { scopeKey, logicalDate: scope.logicalDate, awardKind,
    replay: evidence => scope.kind === 'check' ? replayCheckCoins(scope, evidence, hashing) : replayBonusCoins(scope, evidence, hashing),
    // each correction subset invokes a fresh factory through the existing public wrapper.
    validateOrdinary: (evidence, rows) => scope.kind === 'check'
      ? validateCheckOrdinary(evidence, rows, hashing) : validateBonusOrdinary(scope, evidence, rows, hashing),
  };
  const knownActions = [...facts.values()].filter((fact): fact is Extract<CanonicalRemoteFact, { factType: 'habit_action' }> =>
    fact.factType === 'habit_action' && fact.value.logicalDate === scope.logicalDate).map(fact => fact.value);
  const recoveryActions = scope.kind === 'bonus'
    ? await operation(() => prepareBonusActions(scope, knownActions, hashing)) : knownActions;
  const validateOrdinary = scope.kind === 'bonus' ? prepareBonusOrdinaryValidator(scope, recoveryActions, hashing)
    : (rows: readonly CoinLedgerRow[]) => validateCheckOrdinary(recoveryActions, rows, hashing);
  const accepted = new Map(acceptedRows.map(row => [row.id, row]));
  const ordinary = new Map<string, CoinLedgerRow>();
  function addOrdinary(row: CoinLedgerRow) {
    const old = ordinary.get(row.id);
    if (old !== undefined && canonicalCoinLedger(old) !== canonicalCoinLedger(row)) throw new RemoteFactAdmissionError('integrity');
    ordinary.set(row.id, row);
  }
  const acceptedOrdinary = acceptedRows.filter(row => row.kind !== 'adjustment');
  await operation(() => context.validateOrdinary(actions, acceptedOrdinary));
  for (const row of acceptedOrdinary) addOrdinary(row);
  // current action-only outputs can unlock supplied reversals; no speculative prior plan survives.
  const replay = await operation(() => context.replay(actions));
  for (const row of replay.ordinaryRows) addOrdinary(row);
  const decisions = new Map<LedgerEntryId, RemoteCoinScopePlan['candidateResults'][number]>();
  async function classify(row: CoinLedgerRow, validate: () => Promise<void>) {
    let status: 'valid' | 'pending' | 'invalid';
    try { await validate(); status = 'valid'; }
    catch (cause) {
      if (cause instanceof CoinContractError && cause.reason === 'missing') status = 'pending';
      else if (cause instanceof CoinContractError && cause.reason === 'invalid') status = 'invalid';
      else throw cause;
    }
    decisions.set(row.id, { id: row.id, status });
    return status;
  }
  function actionCause(id: string, role: 'award' | 'removal') {
    const fact = facts.get(remoteFactKey('habit_action', id));
    if (fact === undefined) return false;
    const action = fact.value as HabitAction;
    if (action.logicalDate !== scope.logicalDate || (scope.kind === 'check' && action.boardId !== scope.boardId)) {
      throw new CoinContractError('invalid');
    }
    if (role === 'award' ? action.kind !== 'check' : !['uncheck', 'move_out'].includes(action.kind)) {
      throw new CoinContractError('invalid');
    }
    return true;
  }
  function originalAward(id: string) {
    const known = ordinary.get(id) ?? facts.get(remoteFactKey('ledger_entry', id))?.value as CoinLedgerRow | undefined;
    if (known !== undefined && (known.kind !== awardKind || known.scopeKey !== scopeKey || known.logicalDate !== scope.logicalDate)) {
      throw new CoinContractError('invalid');
    }
    const award = ordinary.get(id);
    return award !== undefined && actionCause(award.sourceActionId!, 'award') ? award : undefined;
  }
  // sequential calls reuse only full-context source preparation, never verdicts or proof context.
  for (const row of candidateRows.filter(row => row.kind === awardKind)) {
    if (await classify(row, async () => {
      if (!actionCause(row.sourceActionId!, 'award')) throw new CoinContractError('missing');
      await validateOrdinary([row]);
    }) === 'valid') addOrdinary(row);
  }
  for (const row of candidateRows.filter(row => row.kind === 'reversal')) {
    if (await classify(row, async () => {
      const causeKnown = actionCause(row.sourceActionId!, 'removal');
      const award = originalAward(row.reversesId!);
      if (!causeKnown || award === undefined) throw new CoinContractError('missing');
      await validateOrdinary([award, row]);
    }) === 'valid') addOrdinary(row);
  }
  const prepared = await prepareCoinEvidence(actions, [...ordinary.values()], hashing);
  const knownRows = new Map([...facts.values()].filter((fact): fact is Extract<CanonicalRemoteFact, { factType: 'ledger_entry' }> =>
    fact.factType === 'ledger_entry').map(fact => [fact.value.id as string, fact.value]));
  for (const row of ordinary.values()) knownRows.set(row.id, row);
  const parents = new Map<string, ValidatedCoinCorrection>();

  async function validateParent(row: CoinLedgerRow) {
    const subsetActions: HabitAction[] = []; const subsetRows: CoinLedgerRow[] = [];
    let outsideEnvelope = false; let missing = false;
    for (const fingerprint of parseCoinProvenance(row.provenanceJson!)) {
      const included = prepared.get(fingerprint[0], fingerprint[1]);
      const fact = included === undefined ? facts.get(remoteFactKey(fingerprint[0], fingerprint[1]))
        : { factType: fingerprint[0], value: included.value };
      if (fact === undefined) { missing = true; continue; }
      if (fact.value.logicalDate !== scope.logicalDate) throw new CoinContractError('invalid');
      if (fingerprint[0] === 'habit_action') {
        const action = fact.value as HabitAction;
        if (scope.kind === 'check' && action.boardId !== scope.boardId) throw new CoinContractError('invalid');
        subsetActions.push(action);
      } else {
        const ledger = fact.value as CoinLedgerRow;
        if (![awardKind, 'reversal'].includes(ledger.kind) || ledger.scopeKey !== scopeKey) throw new CoinContractError('invalid');
        subsetRows.push(ledger);
      }
      if (included !== undefined) {
        if (included.fingerprint[2] !== fingerprint[2]) throw new CoinContractError('invalid');
      } else {
        outsideEnvelope = true;
        const text = fingerprint[0] === 'habit_action' ? canonicalHabitAction(fact.value as HabitAction) : canonicalCoinLedger(fact.value as CoinLedgerRow);
        if (await coinDigest(text, hashing) !== fingerprint[2]) throw new CoinContractError('invalid');
      }
    }
    // direct known defects take precedence; incomplete subsets never run economic validation.
    if (missing) throw new CoinContractError('missing');
    if (outsideEnvelope) {
      // complete declared facts must prove their own cause even when G is outside current E.
      try { await context.validateOrdinary(subsetActions, subsetRows); }
      catch (cause) {
        if (cause instanceof CoinContractError && cause.reason === 'missing') throw new CoinContractError('invalid');
        throw cause;
      }
      await context.replay(subsetActions);
      const subset = await prepareCoinEvidence(subsetActions, subsetRows, hashing);
      await validateCoinCorrection(context, row, subset, knownRows, hashing);
      // a valid exact-scope proof outside final E means the caller did not supply complete E.
      throw new RemoteFactAdmissionError('integrity');
    }
    return validateCoinCorrection(context, row, prepared, knownRows, hashing);
  }
  for (const row of acceptedRows.filter(row => row.kind === 'adjustment' && row.adjustsId === null)) {
    parents.set(row.id, await operation(() => validateParent(row)));
  }
  for (const row of candidateRows.filter(row => row.kind === 'adjustment' && row.adjustsId === null)) {
    await classify(row, async () => { parents.set(row.id, await validateParent(row)); });
  }
  async function validateCancellation(row: CoinLedgerRow) {
    const known = knownRows.get(row.adjustsId!);
    if (known !== undefined && (known.kind !== 'adjustment' || known.adjustsId !== null || known.scopeKey !== scopeKey)) {
      throw new CoinContractError('invalid');
    }
    const parent = parents.get(row.adjustsId!);
    if (parent === undefined) throw new CoinContractError('missing');
    const expected = await prepareCoinCancellation(parent, hashing);
    if (expected === null) throw new CoinContractError('missing');
    if (canonicalCoinLedger(expected) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
  }
  for (const row of acceptedRows.filter(row => row.kind === 'adjustment' && row.adjustsId !== null)) {
    await operation(() => validateCancellation(row));
  }
  for (const row of candidateRows.filter(row => row.kind === 'adjustment' && row.adjustsId !== null)) {
    await classify(row, () => validateCancellation(row));
  }
  const candidateResults = candidateRows.map(row => decisions.get(row.id)!);
  const ordinaryEvidenceCount = prepared.facts.length;
  if (ordinaryEvidenceCount > COIN_PROOF_FACTS) return { capacity: 'blocked', ordinaryEvidenceCount, generatedRows: [], candidateResults };
  const validRows = new Map(accepted);
  for (const row of candidateRows) if (decisions.get(row.id)!.status === 'valid') validRows.set(row.id, row);
  const generatedRows: CoinLedgerRow[] = [];
  for (const row of ordinary.values()) if (!validRows.has(row.id)) { validRows.set(row.id, row); generatedRows.push(row); }
  const final = await operation(() => reconcileCoinEvidence(context, actions, [...validRows.values()], hashing));
  return { capacity: 'fits', ordinaryEvidenceCount, generatedRows: [...generatedRows, ...final.appendedRows], candidateResults };
}
