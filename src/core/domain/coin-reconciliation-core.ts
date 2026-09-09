import { assertCoinLedgerShape, canonicalCoinLedger, coinLedgerTotals, type CoinLedgerRow } from './coin-ledger';
import { CoinContractError } from './coin-policy';
import { canonicalCoinProvenance, coinDigest, compareCoinTuple, parseCoinProvenance, type CoinFingerprint } from './coin-provenance';
import { uuidV5 } from './deterministic-ids';
import { canonicalHabitAction, type HabitAction } from './habit-actions';
import type { LedgerEntryId, LogicalDate } from './ids';
import type { Hashing } from './ports';

export type ReconciliationContext = {
  scopeKey: string;
  logicalDate: LogicalDate;
  awardKind: 'check' | 'run_bonus';
  replay: (actions: readonly HabitAction[]) => Promise<{ scopeKey: string; ordinaryRows: CoinLedgerRow[]; target: number }>;
  validateOrdinary: (actions: readonly HabitAction[], rows: readonly CoinLedgerRow[]) => Promise<void>;
};

type Fact = { readonly fingerprint: CoinFingerprint; readonly value: HabitAction | CoinLedgerRow };
export type PreparedCoinEvidence = {
  readonly facts: readonly Fact[];
  readonly get: (type: CoinFingerprint[0], id: string) => Fact | undefined;
};
const issuedEvidence = new WeakSet<PreparedCoinEvidence>();

// callers establish admissible exact-scope membership first; this captures hashes, not that policy.
export async function prepareCoinEvidence(actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], hashing: Hashing): Promise<PreparedCoinEvidence> {
  // snapshot all scalar fields before hashing; a prepared hash always describes its stored value.
  const snapshots = [
    ...actions.map(action => ({ type: 'habit_action' as const, value: Object.freeze({ ...action }), canonical: canonicalHabitAction(action) })),
    ...rows.map(row => {
      if (!['check', 'run_bonus', 'reversal'].includes(row.kind)) throw new CoinContractError('invalid');
      return { type: 'ledger_entry' as const, value: Object.freeze({ ...row }), canonical: canonicalCoinLedger(row) };
    }),
  ];
  const unique = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const key = JSON.stringify([snapshot.type, snapshot.value.id]);
    const previous = unique.get(key);
    if (previous && previous.canonical !== snapshot.canonical) throw new CoinContractError('invalid');
    unique.set(key, snapshot);
  }
  const facts: Fact[] = [];
  for (const snapshot of unique.values()) {
    const fingerprint: CoinFingerprint = [snapshot.type, snapshot.value.id, await coinDigest(snapshot.canonical, hashing)];
    Object.freeze(fingerprint);
    facts.push(Object.freeze({ fingerprint, value: snapshot.value }));
  }
  facts.sort((a, b) => compareCoinTuple(a.fingerprint, b.fingerprint));
  const available = new Map(facts.map(fact => [JSON.stringify(fact.fingerprint.slice(0, 2)), fact]));
  const prepared = Object.freeze({ facts: Object.freeze(facts), get: (type: CoinFingerprint[0], id: string) => available.get(JSON.stringify([type, id])) });
  issuedEvidence.add(prepared);
  return prepared;
}

async function correction(context: ReconciliationContext, actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], facts: readonly Fact[], hashing: Hashing) {
  const replay = await context.replay(actions);
  const saved = new Map(rows.map((row) => [row.id, canonicalCoinLedger(row)]));
  for (const expected of replay.ordinaryRows) if (saved.get(expected.id) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  const delta = replay.target - coinLedgerTotals(rows).balance;
  if (delta === 0) return null;
  const provenanceJson = canonicalCoinProvenance(facts.map((fact) => fact.fingerprint));
  const reconciliationKey = await coinDigest(provenanceJson, hashing);
  const last = [...facts].sort((a, b) => compareCoinTuple([a.value.mutationStamp, a.value.id, a.fingerprint[0]],
    [b.value.mutationStamp, b.value.id, b.fingerprint[0]]))[facts.length - 1].value;
  const scopeKey = replay.scopeKey;
  return assertCoinLedgerShape({ id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'adjustment', scopeKey, reconciliationKey]), hashing),
    kind: 'adjustment', delta, boardId: null, checkInId: null, runKey: null, rewardId: null, rewardTitleSnapshot: null,
    reversesId: null, scopeKey, sourceActionId: null, reconciliationKey, adjustsId: null, provenanceJson,
    logicalDate: context.logicalDate, createdAt: last.createdAt, mutationStamp: last.mutationStamp, deletedAt: null });
}

const validatedSuperset = Symbol('validated coin correction');
export type ValidatedCoinCorrection = {
  readonly row: Readonly<CoinLedgerRow>;
  readonly [validatedSuperset]: boolean;
};
const issuedParents = new WeakSet<ValidatedCoinCorrection>();

export async function validateCoinCorrection(context: ReconciliationContext, input: CoinLedgerRow,
  prepared: PreparedCoinEvidence, knownLedgerById: ReadonlyMap<string, CoinLedgerRow>, hashing: Hashing): Promise<ValidatedCoinCorrection> {
  if (!issuedEvidence.has(prepared)) throw new CoinContractError('invalid');
  const row = Object.freeze(assertCoinLedgerShape({ ...input }));
  const capturedContext = { ...context };
  if (row.kind !== 'adjustment' || row.adjustsId !== null || row.scopeKey !== capturedContext.scopeKey ||
    row.logicalDate !== capturedContext.logicalDate) throw new CoinContractError('invalid');
  const subset: Fact[] = [];
  for (const fingerprint of parseCoinProvenance(row.provenanceJson!)) {
    const fact = prepared.get(fingerprint[0], fingerprint[1]);
    if (!fact) {
      const known = fingerprint[0] === 'ledger_entry' ? knownLedgerById.get(fingerprint[1]) : undefined;
      if (known && (known.kind !== capturedContext.awardKind && known.kind !== 'reversal' ||
        known.scopeKey !== capturedContext.scopeKey || known.logicalDate !== capturedContext.logicalDate)) {
        throw new CoinContractError('invalid');
      }
      throw new CoinContractError('missing');
    }
    if (compareCoinTuple(fingerprint, fact.fingerprint) !== 0) throw new CoinContractError('invalid');
    subset.push(fact);
  }
  const subsetActions = subset.filter(fact => fact.fingerprint[0] === 'habit_action').map(fact => fact.value as HabitAction);
  const subsetRows = subset.filter(fact => fact.fingerprint[0] === 'ledger_entry').map(fact => fact.value as CoinLedgerRow);
  try { await capturedContext.validateOrdinary(subsetActions, subsetRows); } catch (cause) {
    if (cause instanceof CoinContractError && cause.reason === 'missing') throw new CoinContractError('invalid');
    throw cause;
  }
  const expected = await correction(capturedContext, subsetActions, subsetRows, subset, hashing);
  if (!expected || canonicalCoinLedger(row) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  // only this validated subset of this unique available set can authorize cancellation.
  const parent = Object.freeze({ row, [validatedSuperset]: subset.length < prepared.facts.length });
  issuedParents.add(parent);
  return parent;
}

export async function prepareCoinCancellation(parent: ValidatedCoinCorrection, hashing: Hashing): Promise<CoinLedgerRow | null> {
  // object spreads can copy a type brand, but cannot copy an issued object's identity.
  if (!issuedParents.has(parent)) throw new CoinContractError('invalid');
  if (!parent[validatedSuperset]) return null;
  const old = parent.row;
  return assertCoinLedgerShape({ ...old, id: await uuidV5(`cancel:${old.id}`, hashing) as LedgerEntryId, delta: -old.delta, adjustsId: old.id });
}

export async function reconcileCoinEvidence(context: ReconciliationContext, actions: readonly HabitAction[], inputRows: readonly CoinLedgerRow[], hashing: Hashing) {
  const rows = new Map<LedgerEntryId, CoinLedgerRow>();
  const appendedRows: CoinLedgerRow[] = [];
  for (const input of inputRows) {
    const row = assertCoinLedgerShape(input);
    if (row.scopeKey !== context.scopeKey || ![context.awardKind, 'reversal', 'adjustment'].includes(row.kind)) throw new CoinContractError('invalid');
    const prior = rows.get(row.id);
    if (prior && canonicalCoinLedger(prior) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
    rows.set(row.id, row);
  }
  function append(row: CoinLedgerRow) { if (!rows.has(row.id)) { rows.set(row.id, row); appendedRows.push(row); } }
  await context.validateOrdinary(actions, [...rows.values()].filter((row) => row.kind !== 'adjustment'));
  const replay = await context.replay(actions);
  for (const row of replay.ordinaryRows) append(row);
  const ordinary = [...rows.values()].filter((row) => row.kind !== 'adjustment');
  const prepared = await prepareCoinEvidence(actions, ordinary, hashing);
  const parents = new Map<LedgerEntryId, ValidatedCoinCorrection>();
  for (const row of rows.values()) {
    if (row.kind !== 'adjustment' || row.adjustsId !== null) continue;
    parents.set(row.id, await validateCoinCorrection(context, row, prepared, rows, hashing));
  }
  for (const row of [...rows.values()].filter((value) => value.kind === 'adjustment').sort((a, b) => compareCoinTuple([a.id], [b.id]))) {
    const old = row.adjustsId === null ? row : rows.get(row.adjustsId);
    if (!old) throw new CoinContractError('missing');
    if (old.kind !== 'adjustment' || old.adjustsId !== null) throw new CoinContractError('invalid');
    const cancel = await prepareCoinCancellation(parents.get(old.id)!, hashing);
    if (!cancel) {
      if (row.adjustsId !== null) throw new CoinContractError('missing');
      continue;
    }
    if (row.adjustsId !== null && canonicalCoinLedger(cancel) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
    append(cancel);
  }
  const current = await correction(context, actions, ordinary, prepared.facts, hashing);
  if (current) append(current);
  return { appendedRows, target: replay.target, balance: coinLedgerTotals([...rows.values()]).balance };
}
