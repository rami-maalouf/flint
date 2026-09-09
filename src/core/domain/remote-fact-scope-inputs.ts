import { isValidLogicalDate } from '../calendar/logical-date';
import { assertCoinLedgerShape, canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { CoinContractError } from './coin-policy';
import { canonicalHabitAction, validateHabitAction, type HabitAction } from './habit-actions';
import { isUuidV4, type BoardId, type LogicalDate } from './ids';
import { RemoteFactAdmissionError, type CanonicalRemoteFact } from './remote-fact-validation';

export type RemoteCoinScope = { kind: 'check'; boardId: BoardId; logicalDate: LogicalDate }
  | { kind: 'bonus'; rootId: BoardId; logicalDate: LogicalDate };
export type RemoteCoinScopeInput = {
  scope: RemoteCoinScope;
  actions: readonly HabitAction[];
  acceptedRows: readonly CoinLedgerRow[];
  candidateRows: readonly CoinLedgerRow[];
  // accepted or nonconflicting provisionally admissible knowledge, never excluded variants.
  knownFacts: readonly CanonicalRemoteFact[];
};

export const remoteFactKey = (type: CanonicalRemoteFact['factType'], id: string) => `${type}|${id}`;
const canonical = (fact: CanonicalRemoteFact) => fact.factType === 'habit_action'
  ? canonicalHabitAction(fact.value) : canonicalCoinLedger(fact.value);

// this captures caller-owned inputs; it does not authorize admission or an evidence subset.
export function captureRemoteCoinScope(input: RemoteCoinScopeInput) {
  const scope = Object.freeze({ ...input.scope });
  const id = scope.kind === 'check' ? scope.boardId : scope.rootId;
  if (!['check', 'bonus'].includes(scope.kind) || typeof id !== 'string' || !isUuidV4(id) ||
    typeof scope.logicalDate !== 'string' || !isValidLogicalDate(scope.logicalDate)) {
    throw new RemoteFactAdmissionError('envelope');
  }
  const scopeKey = `${scope.kind === 'check' ? 'check' : 'bonus'}:${id}:${scope.logicalDate}`;
  const facts = new Map<string, CanonicalRemoteFact>();
  function add(fact: CanonicalRemoteFact): CanonicalRemoteFact {
    let owned: CanonicalRemoteFact;
    try {
      if (fact.factType === 'habit_action') {
        const value = Object.freeze({ ...fact.value });
        const result = validateHabitAction(value);
        if (!result.ok) throw new RemoteFactAdmissionError(result.error.code === 'capacity' ? 'capacity' : 'integrity');
        if (Object.is(value.createdAt, -0)) throw new RemoteFactAdmissionError('integrity');
        owned = Object.freeze({ factType: 'habit_action', value });
      } else if (fact.factType === 'ledger_entry') {
        owned = Object.freeze({ factType: 'ledger_entry', value: Object.freeze(assertCoinLedgerShape({ ...fact.value })) });
      } else throw new RemoteFactAdmissionError('envelope');
    } catch (cause) {
      if (cause instanceof CoinContractError) throw new RemoteFactAdmissionError(cause.reason === 'size' ? 'capacity' : 'integrity');
      throw cause;
    }
    const key = remoteFactKey(owned.factType, owned.value.id);
    const old = facts.get(key);
    if (old !== undefined && canonical(old) !== canonical(owned)) throw new RemoteFactAdmissionError('integrity');
    facts.set(key, owned);
    return owned;
  }
  const actions = new Map<string, HabitAction>();
  for (const value of input.actions) {
    const fact = add({ factType: 'habit_action', value }) as Extract<CanonicalRemoteFact, { factType: 'habit_action' }>;
    if (fact.value.logicalDate !== scope.logicalDate || (scope.kind === 'check' && fact.value.boardId !== scope.boardId)) {
      throw new RemoteFactAdmissionError('integrity');
    }
    actions.set(fact.value.id, fact.value);
  }
  function rows(inputRows: readonly CoinLedgerRow[]) {
    const found = new Map<string, CoinLedgerRow>();
    for (const value of inputRows) {
      const fact = add({ factType: 'ledger_entry', value }) as Extract<CanonicalRemoteFact, { factType: 'ledger_entry' }>;
      if (fact.value.scopeKey !== scopeKey) throw new RemoteFactAdmissionError('integrity');
      found.set(fact.value.id, fact.value);
    }
    return [...found.values()].sort((a, b) => a.id < b.id ? -1 : 1);
  }
  const acceptedRows = rows(input.acceptedRows);
  const candidateRows = rows(input.candidateRows);
  for (const fact of input.knownFacts) add(fact);
  return { scope, scopeKey, actions: [...actions.values()], acceptedRows, candidateRows, facts };
}
