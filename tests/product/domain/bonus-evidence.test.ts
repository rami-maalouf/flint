import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy, COIN_POLICY_BYTES, parseCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance, coinDigest } from '@/core/domain/coin-provenance';
import { baselineAction, canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { readAffectedBonusEvidence } from '@/core/persistence/repositories/bonus-evidence';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const root = id(8001) as BoardId;
const member = id(8002) as BoardId;
const outside = id(8003) as BoardId;
const otherRoot = id(8004) as BoardId;
const date = '2026-09-08' as LogicalDate;
const prior = '2026-09-07' as LogicalDate;
const bonus = fixture.shapeRows.find(row => row.kind === 'run_bonus')! as CoinLedgerRow;

function action(n: number, boardId = root, policyRoot: BoardId | null = root, required = [root, member]): HabitAction {
  return { ...fixture.cases[0].actions[0] as HabitAction, id: id(n) as HabitAction['id'],
    commandId: id(n + 10000) as HabitAction['commandId'], checkInId: id(n + 20000) as HabitAction['checkInId'],
    boardId, logicalDate: date, createdAt: n, mutationStamp: `${String(n).padStart(14, '0')}-00000-qa`,
    policyJson: canonicalCoinPolicy({ ...parseCoinPolicy(fixture.cases[0].actions[0].policyJson!),
      rootId: policyRoot, requiredBoardIds: policyRoot === null ? [] : [...required].sort(),
      bonusClosesAtUtc: policyRoot === null ? null : 1, bonusEnabled: policyRoot !== null && required.length > 0 }) };
}
function award(source: HabitAction, rootId = root): CoinLedgerRow {
  return { ...bonus, sourceActionId: source.id, logicalDate: date, scopeKey: `bonus:${rootId}:${date}`, runKey: `${rootId}|${date}` };
}

describe('exact-date bonus evidence closure', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  const read = (checkScopes = [{ boardId: member, logicalDate: date }], rootScopes: {rootId: BoardId; logicalDate: LogicalDate}[] = []) =>
    readAffectedBonusEvidence(h.db, h.deps.hashing, { checkScopes, rootScopes });
  async function put(...actions: HabitAction[]) { for (const a of actions) await appendHabitAction(h.db, a); }

  it('discovers former membership through closed root controls and retains root-null exact-date state without writes', async () => {
    const c = { ...action(10), kind: 'policy' as const, checkInId: null };
    const a = action(20, member, null);
    const unrelated = action(30, outside, otherRoot, [outside]);
    const yesterday = { ...action(40), logicalDate: prior };
    await put(c, a, unrelated, yesterday);
    const before = await h.db.getAllAsync('SELECT * FROM habit_actions');
    const writes = jest.spyOn(h.db, 'runAsync');
    expect(await read()).toEqual([{ scope: { rootId: root, logicalDate: date }, actions: [c, a], rows: [] }]);
    expect(writes).not.toHaveBeenCalled();
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual(before);
  });

  it('supports explicit root-only scopes, includes observers and all historical required sets but not foreign-root expansion', async () => {
    const old = action(10, root, root, [member]);
    const current = action(20, outside, root, [outside]);
    const oldState = action(30, member, otherRoot, [otherRoot]);
    const unrelated = action(40, otherRoot, otherRoot, [otherRoot]);
    await put(old, current, oldState, unrelated);
    expect(await read([], [{ rootId: root, logicalDate: date }, { rootId: root, logicalDate: date }])).toEqual([
      { scope: { rootId: root, logicalDate: date }, actions: [old, current, oldState], rows: [] },
    ]);
  });

  it('discovers a retained bonus through its root-null source and leaves missing control classification to replay', async () => {
    const source = action(10, member, null);await put(source);const row = award(source);await appendLedgerEntry(h.db, row);
    expect(await read()).toEqual([{ scope: { rootId: root, logicalDate: date }, actions: [source], rows: [row] }]);
  });

  it('resolves proof and reversal dependencies and validates complete canonical fingerprints', async () => {
    const source = action(10);await put(source);const row = award(source);await appendLedgerEntry(h.db, row);
    const proof = canonicalCoinProvenance([['habit_action', source.id, await coinDigest(canonicalHabitAction(source), h.deps.hashing)],
      ['ledger_entry', row.id, await coinDigest(canonicalCoinLedger(row), h.deps.hashing)]]);
    const correction = { ...fixture.correction.expectedAppend[0], scopeKey: row.scopeKey, provenanceJson: proof,
      reconciliationKey: await coinDigest(proof, h.deps.hashing) } as CoinLedgerRow;
    await appendLedgerEntry(h.db, correction);
    const result = await read([], [{ rootId: root, logicalDate: date }]);
    expect(result[0].actions).toEqual([source]);expect(result[0].rows).toHaveLength(2);
  });

  it('does not query storage for an empty input', async () => {
    const reads = jest.spyOn(h.db, 'getAllAsync');expect(await read([], [])).toEqual([]);expect(reads).not.toHaveBeenCalled();
  });
  async function legacy(n: number, boardId = member, logicalDate = date, deletedAt: number | null = null) {
    await h.db.runAsync(`INSERT OR IGNORE INTO boards
      (id,title,symbol,accent_hex,uses_tinted_background,tracks_amount,quick_amount,tracks_time,
       start_of_day_minute,metrics_enabled,order_key,created_at,updated_at,mutation_stamp)
      VALUES (?, 'legacy', 'star', '#ffffff', 0, 0, 1, 0, 0, 1, 'a', 0, 0, '00000000000000-00000-qa')`, [boardId]);
    await h.db.runAsync(`INSERT INTO check_ins (id,board_id,logical_date,note,amount,source,idempotency_key,created_at,updated_at,mutation_stamp,deleted_at)
      VALUES (?, ?, ?, 'retained note', 73, 'import', ?, 0, 0, '00000000000000-00000-qa', ?)`, [id(n),boardId,logicalDate,id(n+100000),deletedAt]);
    return { id: id(n), boardId, logicalDate };
  }
  async function rawAction(row: HabitAction) {
    await h.db.runAsync('INSERT INTO habit_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id,row.commandId,row.boardId,row.logicalDate,row.checkInId,row.kind,row.createdAt,row.mutationStamp,row.policyJson]);
  }
  async function rawLedger(row: CoinLedgerRow) {
    await h.db.runAsync('INSERT INTO coin_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id,row.kind,row.delta,row.boardId,row.checkInId,row.runKey,row.rewardId,row.rewardTitleSnapshot,row.reversesId,row.scopeKey,row.sourceActionId,row.reconciliationKey,row.adjustsId,row.provenanceJson,row.logicalDate,row.createdAt,row.mutationStamp,row.deletedAt]);
  }

  it('never reads pending raw check payloads or infers legacy evidence', async () => {
    const a = action(10);await put(a);
    await legacy(500);await legacy(501);await legacy(502,member,prior);await legacy(503,member,date,1);await legacy(504,outside);
    const removal = { ...action(20,member,null), kind: 'uncheck' as const, checkInId: id(501) as HabitAction['checkInId'] };await put(removal);
    const before = await h.db.getAllAsync('SELECT * FROM check_ins');const reads = jest.spyOn(h.db,'getAllAsync');
    expect((await read())[0].actions).toEqual([a, removal]);
    const historySql = reads.mock.calls.filter(([sql])=>sql.includes('check_ins'));
    expect(historySql).toHaveLength(0);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual(before);
  });

  it('does not infer legacy members from a referenced root-null cause with missing control', async () => {
    const source = action(10,member,null);await put(source);await legacy(500,member);await appendLedgerEntry(h.db,award(source));
    const groups = await read();expect(groups[0].actions).toEqual([source]);expect(groups[0]).not.toHaveProperty('legacyChecks');
  });

  it.each(['source','row'])('reports missing %s dependencies without returning partial evidence', async kind => {
    const source = action(10);
    if (kind==='source') await appendLedgerEntry(h.db,award(source));
    else { await put(source);await appendLedgerEntry(h.db,{ ...fixture.cases[2].ordinaryRows[1], scopeKey:`bonus:${root}:${date}`,sourceActionId:source.id } as CoinLedgerRow); }
    await expect(read([], [{rootId:root,logicalDate:date}])).rejects.toThrow('missing');
  });

  it('rejects a dependency on another date even when it exists', async () => {
    const source={...action(10),logicalDate:prior};await put(source);await appendLedgerEntry(h.db,award(source));
    await expect(read([], [{rootId:root,logicalDate:date}])).rejects.toThrow('invalid');
  });

  it('rejects cross-scope reversal references and terminates cycles', async () => {
    const source=action(10);await put(source);const target=award(source,otherRoot);await appendLedgerEntry(h.db,target);
    await appendLedgerEntry(h.db,{...fixture.cases[2].ordinaryRows[1],scopeKey:`bonus:${root}:${date}`,sourceActionId:source.id,reversesId:target.id} as CoinLedgerRow);
    await expect(read([], [{rootId:root,logicalDate:date},{rootId:otherRoot,logicalDate:date}])).rejects.toThrow('invalid');
  });

  it('rejects a self-referencing reversal without looping', async () => {
    const source=action(10);await put(source);
    const row={...fixture.cases[2].ordinaryRows[1],scopeKey:`bonus:${root}:${date}`,sourceActionId:source.id} as CoinLedgerRow;
    row.reversesId=row.id;await appendLedgerEntry(h.db,row);
    await expect(read()).rejects.toThrow('invalid');
  });

  it.each(['{bad','{}','{"rootId":13}','{"rootId":null,"requiredBoardIds":null}'])('validates malformed reverse-discovery policy %s',async policyJson=>{
    await rawAction({...action(10,outside),policyJson});await expect(read()).rejects.toThrow('invalid');
  });

  it('retains correction-only scope discovery through exact changed action references', async () => {
    const source=action(10,member,null);await put(source);
    const proof=canonicalCoinProvenance([['habit_action',source.id,await coinDigest(canonicalHabitAction(source),h.deps.hashing)]]);
    const correction={...fixture.correction.expectedAppend[0],scopeKey:`bonus:${root}:${date}`,provenanceJson:proof} as CoinLedgerRow;
    await appendLedgerEntry(h.db,correction);const result=await read();expect(result[0].rows).toEqual([correction]);expect(result[0].actions).toEqual([source]);
  });

  it.each(['{bad','{}'])('validates malformed correction discovery proof %s', async provenanceJson => {
    await rawLedger({...fixture.correction.expectedAppend[0],scopeKey:`bonus:${root}:${date}`,provenanceJson} as CoinLedgerRow);
    await expect(read()).rejects.toThrow('invalid');
  });

  it('rejects changed proof bytes', async () => {
    const source=action(10);await put(source);
    await appendLedgerEntry(h.db,{...fixture.correction.expectedAppend[0],scopeKey:`bonus:${root}:${date}`,
      provenanceJson:canonicalCoinProvenance([['habit_action',source.id,'0'.repeat(64)]])} as CoinLedgerRow);
    await expect(read()).rejects.toThrow('invalid');
  });

  it('uses bounded bulk reads and the date index, without unrelated history or per-member queries',async()=>{
    const required=Array.from({length:300},(_,i)=>id(50000+i) as BoardId);
    await h.db.withExclusiveTransactionAsync(async()=>{
      await put(action(10,root,root,required));
      for(let i=0;i<required.length;i++)await put(action(100+i,required[i],null));
      for(let i=0;i<100;i++)await put({...action(1000+i,outside,otherRoot,[outside]),logicalDate:prior});
    });
    const reads=jest.spyOn(h.db,'getAllAsync');const result=await read([{boardId:required[0],logicalDate:date}]);
    expect(result).toHaveLength(1);expect(result[0].actions).toHaveLength(301);expect(reads.mock.calls.length).toBeLessThanOrEqual(8);
    const reverse=reads.mock.calls.find(([sql])=>sql.includes("members.value = json_extract"))!;
    const plan=await h.db.getAllAsync<{detail:string}>(`EXPLAIN QUERY PLAN ${reverse[0]}`,reverse[1]);
    expect(plan.some(row=>row.detail.includes('idx_habit_actions_date_kind'))).toBe(true);
  });

  it('counts accepted evidence toward the budget without counting pending raw payloads',async()=>{
    await h.db.withExclusiveTransactionAsync(async()=>{await put(action(10));for(let i=0;i<4095;i++)await put(action(100+i,member,null));});
    await legacy(90000,member);
    expect((await read())[0].actions).toHaveLength(4096);
    await put(action(9999,member,null));
    await expect(read()).rejects.toThrow('size');
  });

  it('drives reverse discovery once per date while retaining exact board/date pairs', async () => {
    await put(action(10,root,root,[member]), {...action(20,otherRoot,otherRoot,[outside]),logicalDate:prior},
      action(30,otherRoot,otherRoot,[outside]));
    const reads=jest.spyOn(h.db,'getAllAsync');const result=await read([{boardId:member,logicalDate:date},{boardId:outside,logicalDate:prior}]);
    expect(result.map(group=>group.scope)).toEqual([{rootId:root,logicalDate:date},{rootId:otherRoot,logicalDate:prior}]);
    const reverse=reads.mock.calls.find(([sql])=>sql.includes('json_each(a.policy_json'))!;
    const plan=await h.db.getAllAsync<{detail:string}>(`EXPLAIN QUERY PLAN ${reverse[0]}`,reverse[1]);
    const search=plan.findIndex(row=>row.detail.includes('SEARCH a USING INDEX idx_habit_actions_date_kind'));
    const pairScan=plan.findIndex(row=>row.detail.includes('SCAN scopes'));
    expect(search).toBeGreaterThanOrEqual(0);expect(search).toBeLessThan(pairScan);
  });

  it.each([{boardId:'bad',logicalDate:date},{boardId:root,logicalDate:'2026-02-30'}])('rejects invalid input scope before reads: %j',async scope=>{
    const reads=jest.spyOn(h.db,'getAllAsync');await expect(read([scope as {boardId:BoardId;logicalDate:LogicalDate}])).rejects.toThrow('invalid');expect(reads).not.toHaveBeenCalled();
  });

  it('skips bonus reads for a rootless legacy change and accepts omitted explicit roots',async()=>{
    await put({...action(10,member,null),policyJson:null});
    expect(await readAffectedBonusEvidence(h.db,h.deps.hashing,{checkScopes:[{boardId:member,logicalDate:date}]})).toEqual([]);
  });

  it('rejects oversized stored policy before deriving members',async()=>{
    await rawAction({...action(10),policyJson:JSON.stringify({...JSON.parse(action(10).policyJson!),extra:'x'.repeat(COIN_POLICY_BYTES)})});
    await expect(read([], [{rootId:root,logicalDate:date}])).rejects.toThrow('size');
  });

  it('rejects negative zero exposed by a storage adapter even on legacy null-policy actions',async()=>{
    await put({...action(10,member,null),policyJson:null});const get=h.db.getAllAsync.bind(h.db);
    jest.spyOn(h.db,'getAllAsync').mockImplementation(async(sql,params)=>{
      const rows=await get(sql,params);return sql.includes('habit_actions a')?rows.map(row=>({...row as HabitAction,createdAt:-0})):rows;
    });
    await expect(read()).rejects.toThrow('invalid');
  });

  it('does not let malformed raw payloads poison accepted economic evidence',async()=>{
    await put(action(10));await legacy(500);await h.db.runAsync('UPDATE check_ins SET id = ? WHERE id = ?',['bad',id(500)]);
    expect((await read())[0].actions).toEqual([action(10)]);
  });

  it('orders explicitly accepted baselines first and ignores unadmitted raw candidates',async()=>{
    await legacy(500);await legacy(501);await legacy(502,root);
    const baseline=await baselineAction({id:id(200) as HabitAction['checkInId'] & string,boardId:member,logicalDate:date},h.deps.hashing);
    const source=action(10);await put(source,baseline);
    const result=await read();expect(result[0].actions).toEqual([baseline,source]);expect(result[0]).not.toHaveProperty('legacyChecks');
  });

  it('loads same-date proof actions beyond the known member envelope without inventing baselines',async()=>{
    const source=action(10,member,null);await put(source);await legacy(500,member);
    const proof=canonicalCoinProvenance([['habit_action',source.id,await coinDigest(canonicalHabitAction(source),h.deps.hashing)]]);
    const correction={...fixture.correction.expectedAppend[0],scopeKey:`bonus:${root}:${date}`,provenanceJson:proof} as CoinLedgerRow;
    await appendLedgerEntry(h.db,correction);
    const result=await read([], [{rootId:root,logicalDate:date}]);expect(result[0].actions).toEqual([source]);expect(result[0]).not.toHaveProperty('legacyChecks');
  });

  it('reuses valid cancellation dependencies and hashes while rejecting forbidden adjustment evidence',async()=>{
    const source=action(10);await put(source);const w=award(source);await appendLedgerEntry(h.db,w);
    const proof=canonicalCoinProvenance([['habit_action',source.id,await coinDigest(canonicalHabitAction(source),h.deps.hashing)],['ledger_entry',w.id,await coinDigest(canonicalCoinLedger(w),h.deps.hashing)]]);
    const correction={...fixture.correction.expectedAppend[0],scopeKey:w.scopeKey,provenanceJson:proof} as CoinLedgerRow;
    const cancel={...correction,id:id(900).replace('-4000-','-5000-') as CoinLedgerRow['id'],delta:1,adjustsId:correction.id};
    await appendLedgerEntry(h.db,correction);await appendLedgerEntry(h.db,cancel);
    expect((await read())[0].rows).toHaveLength(3);
    const bad={...correction,id:id(901).replace('-4000-','-5000-') as CoinLedgerRow['id'],provenanceJson:canonicalCoinProvenance([['ledger_entry',correction.id,await coinDigest(canonicalCoinLedger(correction),h.deps.hashing)]])};
    await appendLedgerEntry(h.db,bad);await expect(read()).rejects.toThrow('invalid');
  });

  it.each(['award','cancellation'])('rejects cancellation targeting %s',async kind=>{
    const source=action(10);await put(source);const w=award(source);await appendLedgerEntry(h.db,w);
    const proof=canonicalCoinProvenance([]);
    const correction={...fixture.correction.expectedAppend[0],scopeKey:w.scopeKey,provenanceJson:proof} as CoinLedgerRow;
    await appendLedgerEntry(h.db,correction);
    const cancel={...correction,id:id(900).replace('-4000-','-5000-') as CoinLedgerRow['id'],delta:1,adjustsId:kind==='award'?w.id:correction.id};await appendLedgerEntry(h.db,cancel);
    if(kind==='cancellation')await appendLedgerEntry(h.db,{...cancel,id:id(901).replace('-4000-','-5000-') as CoinLedgerRow['id'],adjustsId:cancel.id});
    await expect(read()).rejects.toThrow('invalid');
  });

  it('rejects a referenced economic row outside discovered scopes',async()=>{
    const source=action(10);await put(source);const other=fixture.cases[0].ordinaryRows[0] as CoinLedgerRow;await appendLedgerEntry(h.db,other);
    const row={...fixture.cases[2].ordinaryRows[1],scopeKey:`bonus:${root}:${date}`,sourceActionId:source.id,reversesId:other.id} as CoinLedgerRow;await appendLedgerEntry(h.db,row);
    await expect(read()).rejects.toThrow('missing');
    const oldSource=fixture.cases[0].actions[0] as HabitAction;await put(oldSource);
    await expect(read()).rejects.toThrow('invalid');
  });

  it('keeps many small scopes valid beyond the single-proof aggregate count',async()=>{
    const roots=Array.from({length:65},(_,i)=>id(50000+i) as BoardId);
    await h.db.withExclusiveTransactionAsync(async()=>{for(let r=0;r<roots.length;r++)for(let n=0;n<64;n++)await put(action(100+r*64+n,roots[r],roots[r],[roots[r]]));});
    const result=await read([],roots.map(rootId=>({rootId,logicalDate:date})));expect(result).toHaveLength(65);expect(result.every(group=>group.actions.length===64)).toBe(true);
  });

  it('honors the caller read snapshot while another connection commits member evidence',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'bonus-evidence-'));const file=join(directory,'fixture.db');
    await h.db.closeAsync();h.db=new NodeSqlDatabase(file);await h.db.execAsync('PRAGMA journal_mode=WAL');
    const initialized=await initializeProductDatabase(h.db,h.ids,h.deps.hashing);expect(initialized.ok).toBe(true);
    const writer=new NodeSqlDatabase(file);const control=action(10);const late=action(20,member,null);await put(control);
    try {
      const get=h.db.getAllAsync.bind(h.db);let committed=false;
      jest.spyOn(h.db,'getAllAsync').mockImplementation(async(sql,params)=>{const result=await get(sql,params);if(!committed){committed=true;await appendHabitAction(writer,late);}return result;});
      const snapshot=await h.db.withTransactionAsync(()=>read());expect(snapshot[0].actions).toEqual([control]);
      expect((await read())[0].actions).toEqual([control,late]);
    } finally {await writer.closeAsync();rmSync(directory,{recursive:true,force:true});}
  });

});
