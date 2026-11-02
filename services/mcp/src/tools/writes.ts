import { randomUUID } from 'node:crypto';
import { acceptedContent, inputRequired, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { createCheckIn, undoCreatedCheckIn } from '../../../../src/core/domain/check-in-commands.ts';
import { getCoinTotals } from '../../../../src/core/domain/coin-queries.ts';
import type { BoardId, CheckInId, CommandId, LogicalDate, RewardId } from '../../../../src/core/domain/ids.ts';
import { claimReward } from '../../../../src/core/domain/reward-commands.ts';
import { getRewardClaimPreview } from '../../../../src/core/domain/reward-queries.ts';
import type { SqlDatabase } from '../../../../src/core/persistence/database.ts';
import { getCheckInByIdempotencyKey } from '../../../../src/core/persistence/repositories/check-ins.ts';
import { clockAt, hashing, ToolError, type SyncState } from '../accounts.ts';
import { defineTool, type ToolContext } from './define.ts';
import { date, derivedUuid, id, operationId, sync, timeZone, unwrap } from './schemas.ts';

const delivery = z.enum(['synced', 'pending']).describe(
  'pending: saved on the server and uploaded automatically on the next successful sync.');
const delivered = (state: SyncState): 'synced' | 'pending' => state.status === 'synced' && state.pendingUploads === 0 ? 'synced' : 'pending';

const confirmation = z.object({ confirm: z.boolean().describe('Claim this reward') });

// retries are recognized from data that syncs with the account, not from server-local state:
// a check-in stores its command id as its idempotency key, and a claim's ledger id is derived
// from its operation. a rebuilt replica therefore still finds the original effect after a pull.
export function registerWriteTools(server: McpServer, { accountId, accounts, era }: ToolContext) {
  const commandDeps = (db: SqlDatabase, zone: string) => ({ db, clock: clockAt(zone), ids: { uuid: randomUUID }, hashing });

  defineTool(server, 'create_checkin', {
    description: 'Record a check-in for a habit: one more for a count habit, or done for a daily habit. ' +
      'A daily habit that is already done returns created: false. Never call this to toggle or undo.',
    input: z.object({
      operationId, habitId: id, timeZone,
      date: date.optional().describe('Logical date to record, today or earlier. Defaults to today in the habit\'s day.'),
      occurredAt: z.iso.datetime({ offset: true }).optional()
        .describe('When it happened, for habits that track time. Defaults to now.'),
      amount: z.number().positive().max(1_000_000_000).optional().describe('For habits that track an amount.'),
      note: z.string().max(10_000).optional(),
    }),
    output: z.object({ checkinId: id, habitId: id, date, created: z.boolean(), delivery, sync }),
    annotations: { readOnlyHint: false },
  }, input => accounts.run(accountId, 'write', async (db, _state, syncNow) => {
    const commandId = derivedUuid('create_checkin', input.operationId) as CommandId;
    const previous = await getCheckInByIdempotencyKey(db, commandId);
    let result: { checkInId: CheckInId; logicalDate: LogicalDate; created: boolean };
    if (previous) {
      result = { checkInId: previous.id, logicalDate: previous.logicalDate, created: true };
    } else {
      result = unwrap(await createCheckIn(commandDeps(db, input.timeZone), {
        commandId, boardId: input.habitId as BoardId, source: 'app',
        ...(input.date ? { logicalDate: input.date as LogicalDate } : {}),
        ...(input.occurredAt ? { occurredAtUtc: Date.parse(input.occurredAt) } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      }));
    }
    const target = await db.getFirstAsync<{ board_id: string }>('SELECT board_id FROM check_ins WHERE id = ?', [result.checkInId]);
    if (target && target.board_id !== input.habitId) {
      throw new ToolError('CONFLICT', 'This operationId was already used for a different habit. Use a new operationId.');
    }
    const state = await syncNow();
    return { checkinId: result.checkInId, habitId: input.habitId, date: result.logicalDate, created: result.created,
      delivery: delivered(state), sync: state };
  }));

  defineTool(server, 'undo_checkin', {
    description: 'Undo a check-in that create_checkin made, identified by the operationId of that create_checkin call. ' +
      'Check-ins made in the app cannot be undone here.',
    input: z.object({ operationId: operationId.describe('The operationId that was passed to create_checkin.') }),
    output: z.object({ checkinId: id, undone: z.literal(true), delivery, sync }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, input => accounts.run(accountId, 'write', async (db, _state, syncNow) => {
    const createdBy = derivedUuid('create_checkin', input.operationId) as CommandId;
    const checkIn = await getCheckInByIdempotencyKey(db, createdBy);
    if (!checkIn) throw new ToolError('NOT_FOUND', 'No check-in was created with that operationId.');
    // undoing twice is the same request: the check-in stays removed.
    if (checkIn.deletedAt === null) {
      unwrap(await undoCreatedCheckIn(commandDeps(db, 'UTC'), {
        commandId: derivedUuid('undo_checkin', input.operationId) as CommandId, checkInId: checkIn.id, createdByCommandId: createdBy,
      }));
    }
    const state = await syncNow();
    return { checkinId: checkIn.id, undone: true as const, delivery: delivered(state), sync: state };
  }));

  defineTool(server, 'claim_reward', {
    description: 'Spend coins on a reward. First call preview_reward_claim, tell the user the cost and the balance after, ' +
      'and call this only after the user agrees. Clients that support it also show the user a confirmation.',
    input: z.object({
      operationId, rewardId: id, timeZone,
      rewardVersion: z.string().min(1).max(255).describe('The version from preview_reward_claim or list_rewards.'),
    }),
    output: z.object({ claimId: id, reward: z.object({ id, title: z.string() }), costCoins: z.number().int(), date,
      balance: z.number().int().describe('The coin balance after this claim.'), delivery, sync }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input, ctx) => {
    const claimId = derivedUuid('claim_reward', input.operationId, 'ledger');
    const answer = await confirm(server, era, ctx, () => accounts.run(accountId, 'read', async db => {
      const claimed = await db.getFirstAsync('SELECT 1 FROM coin_ledger WHERE id = ?', [claimId]);
      if (claimed) return null;
      const preview = unwrap(await getRewardClaimPreview({ db, clock: clockAt(input.timeZone) }, input.rewardId as RewardId));
      if (preview.reward.mutationStamp !== input.rewardVersion) {
        throw new ToolError('CONFLICT', 'This reward changed. Preview it again before claiming.');
      }
      if (preview.balanceAfterClaim === null) throw new ToolError('INVALID_INPUT', 'There are not enough coins to claim this reward.');
      return `Claim "${preview.reward.title}" for ${preview.reward.costCoins} coins? ` +
        `Your balance goes from ${preview.balance} to ${preview.balanceAfterClaim}.`;
    }));
    if (answer === 'declined') throw new ToolError('DECLINED', 'The user did not confirm this claim. Nothing was spent.');
    if (answer !== 'confirmed') return answer;
    return accounts.run(accountId, 'write', async (db, _state, syncNow) => {
      const previous = await db.getFirstAsync<{ reward_id: string; reward_title_snapshot: string; delta: number; logical_date: string }>(
        'SELECT reward_id, reward_title_snapshot, delta, logical_date FROM coin_ledger WHERE id = ?', [claimId]);
      let result: { rewardId: string; title: string; costCoins: number; date: string; balance: number };
      if (previous) {
        if (previous.reward_id !== input.rewardId) {
          throw new ToolError('CONFLICT', 'This operationId was already used for a different reward. Use a new operationId.');
        }
        result = { rewardId: previous.reward_id, title: previous.reward_title_snapshot, costCoins: -previous.delta,
          date: previous.logical_date, balance: unwrap(await getCoinTotals({ db, clock: clockAt('UTC') })).balance };
      } else {
        // the command's only generated id is the ledger entry, so a retry reproduces it exactly.
        const claimed = unwrap(await claimReward({ ...commandDeps(db, input.timeZone), ids: { uuid: () => claimId } }, {
          commandId: derivedUuid('claim_reward', input.operationId) as CommandId, rewardId: input.rewardId as RewardId,
          expectedMutationStamp: input.rewardVersion,
        }));
        result = { rewardId: claimed.rewardId, title: claimed.titleSnapshot, costCoins: claimed.costCoins,
          date: claimed.logicalDate, balance: claimed.balance };
      }
      const state = await syncNow();
      return { claimId, reward: { id: result.rewardId, title: result.title }, costCoins: result.costCoins, date: result.date,
        balance: result.balance, delivery: delivered(state), sync: state };
    });
  });
}

// asks the user through mcp elicitation on 2026 protocol clients that support it: the server
// returns an input-required result and the client retries with the answer. the 2025 protocol is
// served statelessly, so nothing can be asked mid-call; those clients rely on the preview step
// and their own approval prompt for tools that are not read-only.
async function confirm(server: McpServer, era: ToolContext['era'], ctx: ServerContext, message: () => Promise<string | null>) {
  if (era !== 'modern' || !server.server.getClientCapabilities()?.elicitation) return 'confirmed';
  const answered = ctx.mcpReq.inputResponses?.confirm;
  if (answered !== undefined) {
    return acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmation)?.confirm === true ? 'confirmed' : 'declined';
  }
  const text = await message();
  // an already completed claim replays without asking again.
  if (text === null) return 'confirmed';
  return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: text, requestedSchema: confirmation }) } });
}
