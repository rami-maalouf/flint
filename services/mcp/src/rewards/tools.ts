import type { RewardId } from '../../../../src/core/domain/ids';
import type { AccountActors } from '../accounts/actor';
import type { AuthContext } from '../auth/context';
import { getRewardClaimPreview } from '../core';
import { contracts, hasToolScope, validateResult } from '../tools/contracts';
import { domainValue, ToolError } from '../tools/errors';
import type { ApprovedClaimNormalizer } from '../tools/normalize';
import { RewardQuoteStore } from './quotes';

export class RewardPreviewTools {
  constructor(private readonly options: { accounts: Pick<AccountActors, 'withAccount'>; quotes: RewardQuoteStore }) {}

  async invoke(raw: unknown, context: AuthContext) {
    const contract = contracts.get_reward_claim_preview;
    if (!hasToolScope(contract, context.scopes)) throw new ToolError('FORBIDDEN', 'This connection cannot preview rewards.');
    const parsed = contract.input.safeParse(raw);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', 'The reward preview arguments are invalid.');
    const input = parsed.data;
    const result = await this.options.accounts.withAccount(context, { timeZone: input.timeZone }, async runtime => {
      const preview = domainValue(await getRewardClaimPreview(runtime, input.rewardId as RewardId));
      await context.assertActive();
      const reward = preview.reward;
      return this.options.quotes.issue(context, input, { balance: preview.balance, balanceAfterClaim: preview.balanceAfterClaim,
        reward: { id: reward.id, title: reward.title, costCoins: reward.costCoins, symbol: reward.symbol,
          accentHex: reward.accentHex, mutationStamp: reward.mutationStamp, archivedAt: reward.archivedAt } });
    });
    validateResult('get_reward_claim_preview', result); return result;
  }
}

// confirmation is checked only for first admission. journal receipt replay never reevaluates an edited reward.
export function approvedClaimNormalizer(quotes: RewardQuoteStore): ApprovedClaimNormalizer {
  return async (request, frozen) => {
    const quote = quotes.admit(request.input.confirmationToken, { accountId: frozen.context.accountId,
      clientId: frozen.context.clientId, operationId: request.input.operationId });
    const reward = await frozen.read.getFirstAsync<{ mutation_stamp: string; cost_coins: number; archived_at: number | null }>(
      'SELECT mutation_stamp, cost_coins, archived_at FROM rewards WHERE id = ? AND deleted_at IS NULL', [quote.reward.id]);
    if (!reward || reward.archived_at !== null || reward.mutation_stamp !== quote.reward.mutationStamp || reward.cost_coins !== quote.reward.costCoins) {
      throw new ToolError('CONFIRMATION_REQUIRED', 'This reward changed. Request and approve a new preview.');
    }
    return { timeZone: quote.timeZone, command: { tool: 'claim_reward', input: { commandId: frozen.commandId,
      rewardId: quote.reward.id as RewardId, expectedMutationStamp: quote.reward.mutationStamp } } };
  };
}
