import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { COIN_POLICY_BYTES, COIN_PROOF_BYTES } from '@/core/domain/coin-policy';
import { captureRemoteCoinScope, remoteFactKey, type RemoteCoinScopeInput } from '@/core/domain/remote-fact-scope-inputs';
import { RemoteFactAdmissionError, type CanonicalRemoteFact } from '@/core/domain/remote-fact-validation';
import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import { bonusAwardRow, type BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { prepareBonusOrdinaryValidator } from '@/core/domain/bonus-validation';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy, parseCoinPolicy } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';

import { createTestHashing } from '../helpers/test-db';

const hashing = createTestHashing();
const vector = bonusFixture.reconciliationCases[1];
const scope = vector.scope as BonusCoinScope;
const actions = vector.actions as HabitAction[];

describe('captured intrinsic bonus validation context', () => {
  it('reuses source candidate preparation across sequential partial-award classifications', async () => {
    const source = actions[1];
    const base = parseCoinPolicy(source.policyJson!);
    const policies = Array.from({ length: 64 }, (_, n) => ({ ...base, bonusClosesAtUtc: base.bonusClosesAtUtc! + n }));
    const controls = policies.map((policy, n): HabitAction => ({ ...actions[0],
      id: `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as HabitAction['id'],
      kind: 'policy', checkInId: null, mutationStamp: '00000000000000-00001-fixture', policyJson: canonicalCoinPolicy(policy) }));
    const rows = await Promise.all(policies.map(policy => bonusAwardRow(scope, source, policy, hashing)));
    const sha1 = jest.fn(hashing.sha1); const sha256 = jest.fn(hashing.sha256);
    const validate = prepareBonusOrdinaryValidator(scope, [...actions, ...controls], { sha1, sha256 });
    for (const row of rows) await validate([row]);
    expect(sha1).toHaveBeenCalledTimes(64);
    expect(sha256).toHaveBeenCalledTimes(64);
  });

  it('binds scope/actions/row bytes before awaiting and keeps a fresh subset context independent', async () => {
    const inputScope = { ...scope }; const inputActions = actions.map(action => ({ ...action }));
    const row = { ...vector.rows[0] } as CoinLedgerRow;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const validate = prepareBonusOrdinaryValidator(inputScope, inputActions,
      { ...hashing, sha256: async bytes => { await held; return hashing.sha256(bytes); } });
    const checking = validate([row]);
    inputScope.rootId = 'ffffffff-0000-4000-8000-000000000001' as BonusCoinScope['rootId'];
    inputActions[0].policyJson = null; inputActions.length = 0;
    row.delta = 99; row.createdAt += 1;
    release();
    await expect(checking).resolves.toBeUndefined();
    const isolated = prepareBonusOrdinaryValidator(scope, [actions[1]], hashing);
    await expect(isolated([vector.rows[0] as CoinLedgerRow])).rejects.toMatchObject({ reason: 'missing' });
    await expect(validate([vector.rows[0] as CoinLedgerRow])).resolves.toBeUndefined();
  });
});

describe('scope input integrity boundary', () => {
  const input = { scope: { kind: 'bonus' as const, ...scope }, actions,
    acceptedRows: [] as CoinLedgerRow[], candidateRows: vector.rows as CoinLedgerRow[], knownFacts: [] as CanonicalRemoteFact[] };

  it('owns scalar facts, preserves typed identity, and deduplicates equal candidates before any hashing', () => {
    const source = structuredClone(input);
    source.actions.push({ ...source.actions[0] });
    source.candidateRows.push({ ...source.candidateRows[0] });
    const claim = { ...checkFixture.shapeRows[2], id: actions[0].id as string } as CoinLedgerRow;
    source.knownFacts.push({ factType: 'ledger_entry', value: claim });
    const captured = captureRemoteCoinScope(source);
    source.actions[0].policyJson = null;
    source.candidateRows[0].createdAt += 1;
    expect(captured.actions).toHaveLength(actions.length);
    expect(captured.candidateRows).toHaveLength(vector.rows.length);
    expect(captured.actions[0]).toEqual(actions[0]);
    expect(captured.candidateRows).toContainEqual(vector.rows[0]);
    expect(captured.facts.get(remoteFactKey('ledger_entry', actions[0].id))?.value).toEqual(claim);
    expect(captured.facts.get(remoteFactKey('habit_action', actions[0].id))?.value).toEqual(actions[0]);
    expect(Object.isFrozen(captured.actions[0])).toBe(true);
  });

  it.each([
    { kind: 'other', rootId: scope.rootId, logicalDate: scope.logicalDate },
    { kind: 'bonus', rootId: [scope.rootId], logicalDate: scope.logicalDate },
    { kind: 'check', boardId: 'not-an-id', logicalDate: scope.logicalDate },
    { kind: 'bonus', rootId: scope.rootId, logicalDate: 0 },
    { kind: 'bonus', rootId: scope.rootId, logicalDate: '2026-02-30' },
  ])('rejects unretainable scope selectors %j', badScope => {
    expect(() => captureRemoteCoinScope({ ...input, scope: badScope as RemoteCoinScopeInput['scope'] })).toThrow(
      new RemoteFactAdmissionError('envelope'));
  });

  it('keeps malformed action, negative zero, and ledger storage failures outside candidate classification', () => {
    for (const action of [{ ...actions[0], createdAt: -1 }, { ...actions[0], createdAt: -0, policyJson: null }]) {
      expect(() => captureRemoteCoinScope({ ...input, actions: [action] })).toThrow(new RemoteFactAdmissionError('integrity'));
    }
    expect(() => captureRemoteCoinScope({ ...input, candidateRows: [{ ...input.candidateRows[0], delta: 0 }] }))
      .toThrow(new RemoteFactAdmissionError('integrity'));
    expect(() => captureRemoteCoinScope({ ...input, knownFacts: [{ factType: 'unknown', value: actions[0] } as unknown as CanonicalRemoteFact] }))
      .toThrow(new RemoteFactAdmissionError('envelope'));
  });

  it('propagates individual policy and proof byte limits as operation capacity', () => {
    expect(() => captureRemoteCoinScope({ ...input, actions: [{ ...actions[0], policyJson: ' '.repeat(COIN_POLICY_BYTES + 1) }] }))
      .toThrow(new RemoteFactAdmissionError('capacity'));
    const oversized = { ...checkFixture.correction.expectedAppend[0], provenanceJson: ' '.repeat(COIN_PROOF_BYTES + 1) } as CoinLedgerRow;
    expect(() => captureRemoteCoinScope({ ...input, knownFacts: [{ factType: 'ledger_entry', value: oversized }] }))
      .toThrow(new RemoteFactAdmissionError('capacity'));
  });

  it('rejects conflicts and wrong-scope envelope facts while retaining foreign knowledge for classification', () => {
    expect(() => captureRemoteCoinScope({ ...input, knownFacts: [{ factType: 'habit_action', value: { ...actions[0], createdAt: actions[0].createdAt + 1 } }] }))
      .toThrow(new RemoteFactAdmissionError('integrity'));
    expect(() => captureRemoteCoinScope({ ...input, actions: [{ ...actions[0], logicalDate: '2026-09-07' as HabitAction['logicalDate'] }] }))
      .toThrow(new RemoteFactAdmissionError('integrity'));
    expect(() => captureRemoteCoinScope({ ...input, scope: { kind: 'check', boardId: actions[1].boardId, logicalDate: scope.logicalDate } }))
      .toThrow(new RemoteFactAdmissionError('integrity'));
    expect(() => captureRemoteCoinScope({ ...input, candidateRows: [checkFixture.shapeRows[2] as CoinLedgerRow] }))
      .toThrow(new RemoteFactAdmissionError('integrity'));
  });
});
