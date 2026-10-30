import { z } from 'zod';
import type { Board, Reward } from '../../../../src/core/domain/entities';
import type { BoardId } from '../../../../src/core/domain/ids';
import type { CoinHistoryCursor } from '../../../../src/core/domain/coin-queries';
import type { AccountActors, AccountRuntime } from '../accounts/actor';
import type { AuthContext } from '../auth/context';
import { getBoard, listActiveBoards, listArchivedBoards, getHomeBoardProjection, getStackListSnapshot,
  getStackDetailSnapshot, getCoinTotals, getCoinHistoryPage, listRewards } from '../core';
import { contracts, hasToolScope, validateResult, RESPONSE_BYTES, type ToolInput, type Metadata } from './contracts';
import { CursorCodec, type CursorBinding } from './cursors';
import { domainValue, ToolError } from './errors';

export const readToolNames = ['list_habits', 'get_habit', 'get_today', 'list_stacks', 'get_stack',
  'get_checkin_history', 'get_coin_balance', 'get_coin_history', 'list_rewards', 'get_sync_status'] as const;
export type ReadToolName = typeof readToolNames[number];
type Options = { accounts: Pick<AccountActors, 'withAccount'>; cursors: CursorCodec };
const listPosition = z.strictObject({ key: z.string().max(4096), id: z.uuid() });
const historyPosition = z.strictObject({ logicalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id: z.uuid() });
function habit(board: Board) {
  const { id, title, kind, symbol, accentHex, tracksAmount, amountUnit, quickAmount, tracksTime,
    startOfDayMinute, earnsCoins, coinCapPerDay, archivedAt, mutationStamp } = board;
  return { id, title, kind, symbol, accentHex, tracksAmount, amountUnit, quickAmount, tracksTime,
    startOfDayMinute, earnsCoins, coinCapPerDay, archivedAt, mutationStamp };
}
function reward(row: Reward) {
  const { id, title, costCoins, symbol, accentHex, mutationStamp, archivedAt } = row;
  return { id, title, costCoins, symbol, accentHex, mutationStamp, archivedAt };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class ReadTools {
  constructor(private readonly options: Options) {}

  async invoke(name: ReadToolName, raw: unknown, context: AuthContext): Promise<{ data: unknown; meta: Metadata }> {
    const contract = contracts[name];
    const parsed = contract.input.safeParse(raw);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', 'The tool input is invalid.');
    if (!hasToolScope(contract, context.scopes)) throw new ToolError('FORBIDDEN', 'This connection lacks the required permission.');
    const input = parsed.data as Record<string, unknown>;
    const filters = Object.fromEntries(Object.entries(input).filter(([key]) => !['limit', 'cursor', 'freshness'].includes(key)));
    if (['list_habits', 'list_rewards'].includes(name)) filters.lifecycle ??= 'active';
    if (name === 'get_checkin_history') filters.notes = context.scopes.includes('habits:notes:read');
    const binding: CursorBinding = { accountId: context.accountId, clientId: context.clientId, tool: name, filters };
    const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
    // authentication and filter binding are checked before opening the account lane.
    const position = cursor ? name === 'get_checkin_history' || name === 'get_coin_history'
      ? this.options.cursors.decode(binding, cursor, historyPosition)
      : this.options.cursors.decode(binding, cursor, listPosition) : undefined;
    await context.assertActive();
    const result = await this.options.accounts.withAccount(context, {
      ...(typeof input.timeZone === 'string' ? { timeZone: input.timeZone } : {}),
      ...(input.freshness === 'require_sync' || input.freshness === 'allow_cached' ? { freshness: input.freshness } : {}),
    }, async runtime => {
      switch (name) {
        case 'list_habits': {
          const page = input as ToolInput<'list_habits'>;
          await this.bound(runtime, 'boards', 10_000);
          const lifecycle = page.lifecycle ?? 'active';
          const active = lifecycle === 'archived' ? [] : domainValue(await listActiveBoards(runtime));
          const archived = lifecycle === 'active' ? [] : domainValue(await listArchivedBoards(runtime));
          return this.page([...active, ...archived].map(row => ({ ...habit(row), orderKey: row.orderKey })),
            page.limit, binding, position as z.infer<typeof listPosition> | undefined,
            row => row.orderKey, ({ orderKey: _order, ...row }) => row, runtime.meta);
        }
        case 'get_habit': return habit(domainValue(await getBoard(runtime, (input as ToolInput<'get_habit'>).habitId as BoardId)));
        case 'get_today': {
          await this.bound(runtime, 'boards', 100);
          await this.bound(runtime, 'check_ins', 200_000);
          return { items: domainValue(await getHomeBoardProjection(runtime)).map(row => ({
            habit: habit(row.board), logicalDate: row.today, strip: row.strip, daily: row.daily,
          })) };
        }
        case 'get_sync_status': return runtime.recovery;
        case 'get_checkin_history': return this.history(runtime, input as ToolInput<'get_checkin_history'>,
          binding, position as z.infer<typeof historyPosition> | undefined, context.scopes.includes('habits:notes:read'));
        case 'get_coin_balance': return domainValue(await getCoinTotals(runtime));
        case 'get_coin_history': {
          const page = domainValue(await getCoinHistoryPage(runtime, { limit: (input as ToolInput<'get_coin_history'>).limit,
            ...(position ? { before: position as CoinHistoryCursor } : {}) }));
          return this.fitPage(page.items, page.nextCursor !== null, binding, row =>
            ({ logicalDate: row.logicalDate, createdAt: row.createdAt, id: row.id }), row => row, runtime.meta);
        }
        case 'list_rewards': {
          const page = input as ToolInput<'list_rewards'>;
          await this.bound(runtime, 'rewards', 10_000);
          const lifecycle = page.lifecycle ?? 'active';
          const active = lifecycle === 'archived' ? [] : domainValue(await listRewards(runtime));
          const archived = lifecycle === 'active' ? [] : domainValue(await listRewards(runtime, { archived: true }));
          return this.page([...active, ...archived], page.limit, binding, position as z.infer<typeof listPosition> | undefined,
            row => row.orderKey, reward, runtime.meta);
        }
        case 'list_stacks': {
          await this.boundStacks(runtime);
          const page = input as ToolInput<'list_stacks'>;
          const stacks = domainValue(await getStackListSnapshot(runtime)).stacks;
          return this.page(stacks.map(row => ({ ...row, id: row.rootId })), page.limit, binding,
            position as z.infer<typeof listPosition> | undefined, row => row.rootId, ({ id: _id, ...row }) => row, runtime.meta);
        }
        case 'get_stack': {
          await this.boundStacks(runtime);
          return domainValue(await getStackDetailSnapshot(runtime,
            (input as ToolInput<'get_stack'>).rootHabitId as BoardId)).stack;
        }
      }
    });
    await context.assertActive();
    try { return validateResult(name, result); }
    catch { throw new ToolError('UNAVAILABLE', 'The result exceeds the supported response contract or size. Use a smaller page.', true); }
  }

  private page<Row extends { id: string }, Item>(rows: Row[], limit = 50, binding: CursorBinding,
    before: z.infer<typeof listPosition> | undefined, key: (row: Row) => string, project: (row: Row) => Item, meta: Metadata) {
    const ordered = rows.sort((a, b) => compare(key(a), key(b)) || compare(a.id, b.id))
      .filter(row => !before || compare(key(row), before.key) > 0 || (key(row) === before.key && compare(row.id, before.id) > 0));
    return this.fitPage(ordered.slice(0, limit), ordered.length > limit, binding,
      row => ({ key: key(row), id: row.id }), project, meta);
  }

  private fitPage<Row, Item>(rows: Row[], hasMore: boolean, binding: CursorBinding,
    position: (row: Row) => unknown, project: (row: Row) => Item, meta: Metadata) {
    const selected = [...rows];
    while (true) {
      const last = selected.at(-1);
      const data = { items: selected.map(project), nextCursor: hasMore && last
        ? this.options.cursors.encode(binding, position(last)) : null };
      if (Buffer.byteLength(JSON.stringify({ data, meta })) <= RESPONSE_BYTES) return data;
      if (selected.length <= 1) throw new ToolError('UNAVAILABLE', 'One item exceeds the response size budget.', true);
      selected.pop(); hasMore = true;
    }
  }

  private async bound(runtime: AccountRuntime, table: 'boards' | 'check_ins' | 'rewards', limit: number) {
    const row = await runtime.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${table} WHERE deleted_at IS NULL LIMIT ?)`, [limit + 1]);
    if (!row || row.count > limit) throw new ToolError('RATE_LIMITED', 'This projection exceeds its query budget. Use a paged listing.');
  }
  private async boundStacks(runtime: AccountRuntime) {
    await this.bound(runtime, 'boards', 1_000); await this.bound(runtime, 'check_ins', 200_000);
  }
  private async history(runtime: AccountRuntime, input: ToolInput<'get_checkin_history'>, binding: CursorBinding,
    before: z.infer<typeof historyPosition> | undefined, notes: boolean) {
    domainValue(await getBoard(runtime, input.habitId as BoardId));
    const limit = input.limit ?? 50;
    const where = ['board_id = ?', 'deleted_at IS NULL', 'state_suppressed = 0'];
    const params: (string | number)[] = [input.habitId];
    if (input.fromDate) { where.push('logical_date >= ?'); params.push(input.fromDate); }
    if (input.toDate) { where.push('logical_date <= ?'); params.push(input.toDate); }
    if (before) { where.push('(logical_date, created_at, id) < (?, ?, ?)'); params.push(before.logicalDate, before.createdAt, before.id); }
    params.push(limit + 1);
    const rows = await runtime.db.getAllAsync<{ id: string; logicalDate: string; createdAt: number }>(
      `SELECT id, board_id AS habitId, logical_date AS logicalDate, occurred_at_utc AS occurredAtUtc,
        time_zone_id AS timeZoneId, offset_minutes AS offsetMinutes, amount, ${notes ? 'note,' : ''}
        created_at AS createdAt, mutation_stamp AS mutationStamp FROM check_ins
        WHERE ${where.join(' AND ')} ORDER BY logical_date DESC, created_at DESC, id DESC LIMIT ?`, params);
    return this.fitPage(rows.slice(0, limit), rows.length > limit, binding,
      row => ({ logicalDate: row.logicalDate, createdAt: row.createdAt, id: row.id }), row => row, runtime.meta);
  }
}
