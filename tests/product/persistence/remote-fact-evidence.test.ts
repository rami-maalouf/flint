import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { CoinContractError, canonicalCoinPolicy, parseCoinPolicy } from '@/core/domain/coin-policy';
import { baselineAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { RemoteFactAdmissionError, type CanonicalRemoteFact, type RemoteFactIdentity } from '@/core/domain/remote-fact-validation';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import type { SqlExecutor } from '@/core/persistence/database';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';
import { readRemoteFactEvidencePage, readRemoteFactsById, type RemoteEvidenceSelection } from '@/core/persistence/repositories/remote-fact-evidence';

import { createTestHarness, createTestHashing, NodeSqlDatabase, TestIds, type TestHarness } from '../helpers/test-db';

const date = '2026-09-08' as LogicalDate;
const boardId = '10000000-0000-4000-8000-000000000001' as BoardId;
const otherBoardId = '10000000-0000-4000-8000-000000000002' as BoardId;
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const identity = (fact: CanonicalRemoteFact): RemoteFactIdentity => ({ factType: fact.factType, factId: fact.value.id });
const actionFact = (value: HabitAction): CanonicalRemoteFact => ({ factType: 'habit_action', value });
const ledgerFact = (value: CoinLedgerRow): CanonicalRemoteFact => ({ factType: 'ledger_entry', value });
const key = (fact: CanonicalRemoteFact) => `${fact.factType}|${fact.value.id}`;
const sorted = (facts: CanonicalRemoteFact[]) => [...facts].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const action = (n: number, patch: Partial<HabitAction> = {}): HabitAction => ({
  ...checkFixture.correction.actions[0] as HabitAction, id: uuid(n) as HabitAction['id'], boardId,
  logicalDate: date, kind: 'uncheck', checkInId: null, policyJson: null, ...patch,
});

describe('bounded accepted remote evidence reads', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });
  async function seed(actions: HabitAction[], rows: CoinLedgerRow[] = []) {
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (const value of actions) await appendHabitAction(tx, value);
      for (const value of rows) await appendLedgerEntry(tx, value);
    });
  }

  it('returns present claims and adjustments, binary typed identities and explicit missing without parent joins', async () => {
    const upper = action(1, { id: uuid(1).toUpperCase() as HabitAction['id'] });
    const lower = action(1);
    const claim = { ...checkFixture.shapeRows.find(row => row.kind === 'claim')!, id: lower.id } as unknown as CoinLedgerRow;
    const adjustment = checkFixture.correction.expectedAppend[0] as CoinLedgerRow;
    await seed([upper, lower], [claim, adjustment]);
    const expected = sorted([actionFact(upper), actionFact(lower), ledgerFact(claim), ledgerFact(adjustment)]);
    const missing: RemoteFactIdentity = { factType: 'habit_action', factId: adjustment.id };
    expect(await readRemoteFactsById(h.db, [...expected.map(identity).reverse(), missing, identity(actionFact(lower))]))
      .toEqual({ facts: expected, missing: [missing] });
    expect(await h.db.getAllAsync('SELECT id FROM boards')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT id FROM rewards')).toEqual([]);
  });

  it('reads only the exact check scope, including adjustments and historical dates', async () => {
    const selected = checkFixture.correction.actions as HabitAction[];
    const rows = [...checkFixture.correction.existingRows, ...checkFixture.correction.expectedAppend] as CoinLedgerRow[];
    await seed([...selected, action(20), action(21, { boardId: selected[0].boardId, logicalDate: '0000-02-29' as LogicalDate })], rows);
    const page = await readRemoteFactEvidencePage(h.db, { checkScopes: [checkFixture.scope as { boardId: BoardId; logicalDate: LogicalDate }] });
    expect(page).toEqual({ facts: sorted([...selected.map(actionFact), ...rows.map(ledgerFact)]), nextCursor: null });
    expect(await readRemoteFactEvidencePage(h.db, { checkScopes: [{ boardId: selected[0].boardId, logicalDate: '0000-02-29' as LogicalDate }] }))
      .toEqual({ facts: [actionFact(action(21, { boardId: selected[0].boardId, logicalDate: '0000-02-29' as LogicalDate }))], nextCursor: null });
  });

  it('finds direct root observers and reverse exact-date membership without assuming current boards exist', async () => {
    const vector = bonusFixture.reconciliationCases[2];
    const actions = vector.actions as HabitAction[];
    const rows = vector.rows as CoinLedgerRow[];
    const rootNull = action(50, { boardId: otherBoardId });
    await seed([...actions, rootNull, action(51, { boardId: otherBoardId, logicalDate: '2026-09-09' as LogicalDate })], rows);
    expect(await readRemoteFactEvidencePage(h.db, { rootScopes: [vector.scope as { rootId: BoardId; logicalDate: LogicalDate }] }))
      .toEqual({ facts: sorted([...actions.map(actionFact), ...rows.map(ledgerFact)]), nextCursor: null });
    expect(await readRemoteFactEvidencePage(h.db, { reverseScopes: [{ boardId: otherBoardId, logicalDate: date }] }))
      .toEqual({ facts: sorted([...actions.map(actionFact), ...rows.map(ledgerFact)]), nextCursor: null });
    expect(await readRemoteFactsById(h.db, [identity(actionFact(rootNull))]))
      .toEqual({ facts: [actionFact(rootNull)], missing: [] });
  });

  it('pages more than64 facts with stable binary ties and only hydrates the returned bounded payloads', async () => {
    const actions = Array.from({ length: 130 }, (_, n) => action(n + 1));
    actions.push(action(1, { id: uuid(1).toUpperCase() as HabitAction['id'] }));
    await seed(actions);
    const read = jest.spyOn(h.db, 'getAllAsync');
    const found: CanonicalRemoteFact[] = [];
    let after: RemoteFactIdentity | undefined;
    try {
      do {
        const page = await readRemoteFactEvidencePage(h.db, { checkScopes: [{ boardId, logicalDate: date }], after, limit: 64 });
        expect(page.facts.length).toBeLessThanOrEqual(64);
        found.push(...page.facts);
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      expect(found).toEqual(sorted(actions.map(actionFact)));
      expect(read).toHaveBeenCalledTimes(6);
      const hydrated: number[] = [];
      for (const [sql, params] of read.mock.calls) {
        expect(sql).not.toMatch(/check_ins|notes|amount/i);
        if (sql.includes('command_id AS commandId')) hydrated.push(JSON.parse(params![0] as string).length);
      }
      expect(hydrated).toEqual([64, 64, 3]);
    } finally { read.mockRestore(); }
  });

  it('uses default32 pages, exact-limit exhaustion and a cursor from the last returned fact rather than lookahead', async () => {
    const actions = Array.from({ length: 33 }, (_, n) => action(n + 1));
    await seed(actions);
    const selection = { checkScopes: [{ boardId, logicalDate: date }] };
    const page = await readRemoteFactEvidencePage(h.db, selection);
    expect(page.facts).toEqual(actions.slice(0, 32).map(actionFact));
    expect(page.nextCursor).toEqual(identity(actionFact(actions[31])));
    expect(await readRemoteFactEvidencePage(h.db, { ...selection, after: page.nextCursor!, limit: 1 }))
      .toEqual({ facts: [actionFact(actions[32])], nextCursor: null });
    expect(await readRemoteFactEvidencePage(h.db, { ...selection, after: identity(actionFact(actions[32])) }))
      .toEqual({ facts: [], nextCursor: null });
    expect(await readRemoteFactEvidencePage(h.db, { checkScopes: [{ boardId, logicalDate: '9999-12-31' as LogicalDate }] }))
      .toEqual({ facts: [], nextCursor: null });
  });

  it('deduplicates overlapping selectors and pages across action/ledger roles without ID-only ambiguity', async () => {
    const vector = bonusFixture.reconciliationCases[2];
    const actions = vector.actions as HabitAction[]; const rows = vector.rows as CoinLedgerRow[];
    await seed(actions, rows);
    const selection = { checkScopes: actions.map(a => ({ boardId: a.boardId, logicalDate: date })),
      rootScopes: [vector.scope, vector.scope] as { rootId: BoardId; logicalDate: LogicalDate }[],
      reverseScopes: [{ boardId: otherBoardId, logicalDate: date }] };
    const expected = sorted([...actions.map(actionFact), ...rows.map(ledgerFact)]);
    const first = await readRemoteFactEvidencePage(h.db, { ...selection, limit: 4 });
    expect(first).toEqual({ facts: expected.slice(0, 4), nextCursor: identity(expected[3]) });
    expect(await readRemoteFactEvidencePage(h.db, { ...selection, after: first.nextCursor!, limit: 2 }))
      .toEqual({ facts: expected.slice(4), nextCursor: null });
  });

  it('discovers retained bonus scopes through root-null sources and proof-only former member references', async () => {
    const vector = bonusFixture.reconciliationCases[2];
    const source = vector.actions[1] as HabitAction;
    const former = { ...source, policyJson: canonicalCoinPolicy({ ...parseCoinPolicy(source.policyJson!),
      rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
    const award = vector.rows[0] as CoinLedgerRow;
    const adjustment = vector.rows[2] as CoinLedgerRow;
    // raw economic rows are existing accepted evidence; this reader does not rejudge their causes.
    await seed([former], [award, adjustment]);
    expect(await readRemoteFactEvidencePage(h.db, { reverseScopes: [{ boardId: former.boardId, logicalDate: date }] }))
      .toEqual({ facts: sorted([ledgerFact(award), ledgerFact(adjustment)]), nextCursor: null });
    expect(await readRemoteFactEvidencePage(h.db, { rootScopes: [vector.scope as { rootId: BoardId; logicalDate: LogicalDate }] }))
      .toEqual({ facts: sorted([ledgerFact(award), ledgerFact(adjustment)]), nextCursor: null });
    const missing = { factType: 'habit_action' as const, factId: vector.actions[0].id };
    expect(await readRemoteFactsById(h.db, [missing, identity(actionFact(former))]))
      .toEqual({ facts: [actionFact(former)], missing: [missing] });
  });

  it('returns valid v5 legacy baseline evidence without synthesizing missing payload or actions', async () => {
    const outbox = await h.db.getAllAsync('SELECT * FROM mutation_outbox');
    const baseline = await baselineAction({ id: uuid(5) as HabitAction['checkInId'] & string, boardId, logicalDate: date }, createTestHashing());
    await seed([baseline]);
    expect(await readRemoteFactsById(h.db, [identity(actionFact(baseline))])).toEqual({ facts: [actionFact(baseline)], missing: [] });
    expect(await readRemoteFactEvidencePage(h.db, { rootScopes: [{ rootId: boardId, logicalDate: date }] }))
      .toEqual({ facts: [actionFact(baseline)], nextCursor: null });
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual(outbox);
  });

  it('projects caller objects and captures every selector and typed ID before any awaited SQL', async () => {
    const a = action(1); const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    await seed([a], [claim]);
    const identities = [{ ...identity(actionFact(a)), ignored: 'private caller text' }, identity(ledgerFact(claim))];
    const read = h.db.getAllAsync.bind(h.db);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => { await held; return read(sql, params); });
    const pending = readRemoteFactsById(h.db, identities);
    identities[0].factId = uuid(999); identities[1].factType = 'habit_action';
    identities.length = 0;
    release();
    expect(await pending).toEqual({ facts: [actionFact(a), ledgerFact(claim)], missing: [] });
    expect(spy.mock.calls.map(call => call[1])).toEqual([[JSON.stringify([a.id])], [JSON.stringify([claim.id])]]);
    spy.mockRestore();

    const selection = { checkScopes: [{ boardId, logicalDate: date, ignored: 'private caller text' }], limit: 1 };
    let releasePage!: () => void;
    const heldPage = new Promise<void>(resolve => { releasePage = resolve; });
    const pageSpy = jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => { await heldPage; return read(sql, params); });
    const paging = readRemoteFactEvidencePage(h.db, selection);
    selection.checkScopes[0].boardId = otherBoardId;
    selection.checkScopes[0].logicalDate = '9999-12-31' as LogicalDate;
    selection.limit = 64;
    releasePage();
    expect(await paging).toEqual({ facts: [actionFact(a)], nextCursor: null });
    expect(JSON.stringify(pageSpy.mock.calls)).not.toContain('private caller text');
    expect(pageSpy.mock.calls[0][1]).toEqual([JSON.stringify([{ id: boardId, logicalDate: date }]),
      JSON.stringify([{ id: boardId, logicalDate: date }]), 2]);
    pageSpy.mockRestore();
  });

  it('reads one caller-owned WAL snapshot across key selection and both payload tables', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'habit-remote-evidence-'));
    const path = join(directory, 'db.sqlite');
    const db = new NodeSqlDatabase(path); const other = new NodeSqlDatabase(path);
    try {
      await db.execAsync('PRAGMA journal_mode = WAL');
      expect((await initializeProductDatabase(db, new TestIds(), createTestHashing())).ok).toBe(true);
      const first = action(1); const second = action(2);
      await appendHabitAction(db, first);
      const read = db.getAllAsync.bind(db);
      let intervened = false;
      const spy = jest.spyOn(db, 'getAllAsync').mockImplementation(async (sql, params) => {
        const result = await read(sql, params);
        if (!intervened) {
          intervened = true;
          await other.withExclusiveTransactionAsync(tx => appendHabitAction(tx, second));
        }
        return result;
      });
      await db.withTransactionAsync(async tx => {
        expect(await readRemoteFactEvidencePage(tx, { checkScopes: [{ boardId, logicalDate: date }] }))
          .toEqual({ facts: [actionFact(first)], nextCursor: null });
        expect(await readRemoteFactsById(tx, [identity(actionFact(second))]))
          .toEqual({ facts: [], missing: [identity(actionFact(second))] });
      });
      spy.mockRestore();
      expect(await readRemoteFactEvidencePage(db, { checkScopes: [{ boardId, logicalDate: date }] }))
        .toEqual({ facts: [actionFact(first), actionFact(second)], nextCursor: null });
    } finally { await other.closeAsync(); await db.closeAsync(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects malformed selectors, IDs and oversized ID batches before querying and does no SQL for empty input', async () => {
    const read = jest.spyOn(h.db, 'getAllAsync');
    try {
      expect(await readRemoteFactsById(h.db, [])).toEqual({ facts: [], missing: [] });
      expect(await readRemoteFactEvidencePage(h.db, {})).toEqual({ facts: [], nextCursor: null });
      for (const input of [
        { factType: 'other', factId: uuid(1) }, { factType: 'habit_action', factId: 'bad' },
        { factType: 'ledger_entry', factId: [uuid(1)] },
      ]) await expect(readRemoteFactsById(h.db, [input as RemoteFactIdentity])).rejects.toMatchObject({ reason: 'envelope' });
      await expect(readRemoteFactsById(h.db, Array.from({ length: 65 }, (_, n) => ({ factType: 'habit_action', factId: uuid(n) }))))
        .rejects.toMatchObject({ reason: 'envelope' });
      for (const input of [{ checkScopes: [{ boardId: 'bad', logicalDate: date }] },
        { rootScopes: [{ rootId: boardId, logicalDate: '2026-02-30' }] },
        { reverseScopes: [{ boardId, logicalDate: 0 }] }, { after: { factType: 'habit_action', factId: 'bad' } },
        ...[0, 65, 0.5, NaN, Infinity].map(limit => ({ limit }))]) {
        await expect(readRemoteFactEvidencePage(h.db, input as RemoteEvidenceSelection)).rejects.toMatchObject({ reason: 'envelope' });
      }
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('treats malformed selected accepted storage as integrity failure, never candidate invalid/missing/size', async () => {
    const a = action(1);
    const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    await seed([a], [claim]);
    await h.db.execAsync('DROP TRIGGER habit_actions_no_update; DROP TRIGGER coin_ledger_no_update;');
    await h.db.runAsync('UPDATE habit_actions SET policy_json = ? WHERE id = ?', ['not JSON', a.id]);
    for (const selection of [{ rootScopes: [{ rootId: otherBoardId, logicalDate: date }] },
      { reverseScopes: [{ boardId: otherBoardId, logicalDate: date }] }]) {
      const cause = await readRemoteFactEvidencePage(h.db, selection).catch(error => error);
      expect(cause).toBeInstanceOf(RemoteFactAdmissionError);
      expect(cause).not.toBeInstanceOf(CoinContractError);
      expect(cause.reason).toBe('integrity');
    }
    await h.db.runAsync('UPDATE coin_ledger SET reward_title_snapshot = ? WHERE id = ?', ['', claim.id]);
    await expect(readRemoteFactsById(h.db, [identity(ledgerFact(claim))])).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('propagates storage/cancellation failures and refuses a disappearing selected fact outside a proper snapshot', async () => {
    const failure = Object.assign(new Error('storage cancelled'), { name: 'AbortError' });
    const broken = { getAllAsync: async () => { throw failure; } } as unknown as SqlExecutor;
    await expect(readRemoteFactsById(broken, [{ factType: 'habit_action', factId: uuid(1) }])).rejects.toBe(failure);
    await expect(readRemoteFactEvidencePage(broken, { checkScopes: [{ boardId, logicalDate: date }] })).rejects.toBe(failure);
    let calls = 0;
    const incomplete = { getAllAsync: async () => ++calls === 1 ? [{ factType: 'habit_action', factId: uuid(1) }] : [] } as unknown as SqlExecutor;
    await expect(readRemoteFactEvidencePage(incomplete, { checkScopes: [{ boardId, logicalDate: date }] }))
      .rejects.toMatchObject({ reason: 'integrity' });
  });

  it('batches more than the SQLite variable limit worth of selectors using existing exact-scope/date indexes', async () => {
    const a = action(1);
    await seed([a]);
    const pairs = Array.from({ length: 1200 }, (_, n) => ({ boardId: uuid(n) as BoardId, logicalDate: date }));
    const read = jest.spyOn(h.db, 'getAllAsync');
    let sql = ''; let params: Parameters<SqlExecutor['getAllAsync']>[1];
    try {
      expect(await readRemoteFactEvidencePage(h.db, { checkScopes: [...pairs, { boardId, logicalDate: date }],
        rootScopes: [{ rootId: boardId, logicalDate: date }], reverseScopes: [{ boardId, logicalDate: date }] }))
        .toEqual({ facts: [actionFact(a)], nextCursor: null });
      [sql, params] = read.mock.calls[0];
      expect(read).toHaveBeenCalledTimes(2);
      expect(params!.length).toBeLessThan(20);
    } finally { read.mockRestore(); }
    const plan = await h.db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
    const details = plan.map(row => row.detail).join('\n');
    for (const index of ['idx_habit_actions_scope', 'idx_habit_actions_date_kind', 'idx_coin_ledger_scope', 'idx_coin_ledger_history']) {
      expect(details).toContain(index);
    }
    expect(details).not.toMatch(/SCAN (?:a|l)(?:\s|$)/m);
  });

  it('allows an exact64-identity batch with duplicate requests without spending another slot', async () => {
    const actions = Array.from({ length: 64 }, (_, n) => action(n + 1));
    await seed(actions);
    const requested = actions.map(value => identity(actionFact(value)));
    expect(await readRemoteFactsById(h.db, [...requested, ...requested].reverse()))
      .toEqual({ facts: actions.map(actionFact), missing: [] });
  });

  it('extracts a same-date observed root once per policy even when many absent roots are requested', async () => {
    const policyJson = bonusFixture.reconciliationCases[0].actions[0].policyJson;
    await seed(Array.from({ length: 500 }, (_, n) => action(n + 1, { policyJson })));
    let rootReads = 0;
    const sqlite = (h.db as unknown as { db: DatabaseSync }).db;
    sqlite.function('probe_root', { deterministic: true }, value => {
      rootReads += 1;
      return (JSON.parse(value as string) as { rootId: string | null }).rootId;
    });
    const read = h.db.getAllAsync.bind(h.db);
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) =>
      read(sql.replaceAll("json_extract(a.policy_json, '$.rootId')", 'probe_root(a.policy_json)'), params));
    try {
      for (const count of [1, 100]) {
        rootReads = 0;
        const rootScopes = Array.from({ length: count }, (_, n) => ({ rootId: uuid(n + 1000) as BoardId, logicalDate: date }));
        expect(await readRemoteFactEvidencePage(h.db, { rootScopes })).toEqual({ facts: [], nextCursor: null });
        expect(rootReads).toBe(500);
      }
    } finally { spy.mockRestore(); }
  });

  it('opens each required-member array once per policy when many reverse scopes share a date', async () => {
    const policyJson = bonusFixture.reconciliationCases[0].actions[0].policyJson;
    await seed(Array.from({ length: 500 }, (_, n) => action(n + 1, { policyJson })));
    let memberReads = 0;
    const sqlite = (h.db as unknown as { db: DatabaseSync }).db;
    sqlite.function('probe_members', { deterministic: true }, value => {
      memberReads += 1;
      return JSON.stringify((JSON.parse(value as string) as { requiredBoardIds: string[] }).requiredBoardIds);
    });
    const read = h.db.getAllAsync.bind(h.db);
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) =>
      read(sql.replaceAll("json_each(a.policy_json, '$.requiredBoardIds')", 'json_each(probe_members(a.policy_json))'), params));
    try {
      for (const count of [1, 100]) {
        memberReads = 0;
        const reverseScopes = Array.from({ length: count }, (_, n) => ({ boardId: uuid(n + 1000) as BoardId, logicalDate: date }));
        expect(await readRemoteFactEvidencePage(h.db, { reverseScopes })).toEqual({ facts: [], nextCursor: null });
        expect(memberReads).toBe(500);
      }
    } finally { spy.mockRestore(); }
  });

  it('opens retained proof arrays once per row when reverse scopes do not match their action references', async () => {
    const vector = bonusFixture.reconciliationCases[2];
    const adjustment = vector.rows[2] as CoinLedgerRow;
    await seed(vector.actions as HabitAction[], Array.from({ length: 100 }, (_, n) => ({ ...adjustment,
      id: uuid(n + 1).replace('-4000-', '-5000-') as CoinLedgerRow['id'] })));
    let proofReads = 0;
    const sqlite = (h.db as unknown as { db: DatabaseSync }).db;
    sqlite.function('probe_proof', { deterministic: true }, value => {
      proofReads += 1;
      return JSON.stringify((JSON.parse(value as string) as { facts: unknown[] }).facts);
    });
    const read = h.db.getAllAsync.bind(h.db);
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) =>
      read(sql.replaceAll("json_each(l.provenance_json, '$.facts')", 'json_each(probe_proof(l.provenance_json))'), params));
    try {
      for (const count of [1, 100]) {
        proofReads = 0;
        const reverseScopes = Array.from({ length: count }, (_, n) => ({ boardId: uuid(n + 1000) as BoardId, logicalDate: date }));
        expect(await readRemoteFactEvidencePage(h.db, { reverseScopes })).toEqual({ facts: [], nextCursor: null });
        expect(proofReads).toBe(100);
      }
    } finally { spy.mockRestore(); }
  });

  it('keeps requested root/date and reverse-member/date pairs coupled across two dates', async () => {
    const secondDate = '2026-09-09' as LogicalDate;
    const base = parseCoinPolicy(bonusFixture.reconciliationCases[0].actions[0].policyJson);
    const pairs = [[boardId, date], [boardId, secondDate], [otherBoardId, date], [otherBoardId, secondDate]] as const;
    const observers = pairs.map(([rootId, logicalDate], n) => action(n + 1, { boardId: uuid(900) as BoardId,
      logicalDate, policyJson: canonicalCoinPolicy({ ...base, rootId, requiredBoardIds: [rootId] }) }));
    await seed(observers);
    const expected = { facts: [actionFact(observers[0]), actionFact(observers[3])], nextCursor: null };
    expect(await readRemoteFactEvidencePage(h.db, { rootScopes: [{ rootId: boardId, logicalDate: date },
      { rootId: otherBoardId, logicalDate: secondDate }] })).toEqual(expected);
    expect(await readRemoteFactEvidencePage(h.db, { reverseScopes: [{ boardId, logicalDate: date },
      { boardId: otherBoardId, logicalDate: secondDate }] })).toEqual(expected);
  });
});
