import { z } from 'zod';
import type { AccountActors } from '../accounts/actor';
import { OperationRuntimeError } from '../accounts/operations';
import type { AuthContext } from '../auth/context';
import { JournalError, type JournalOperation, type MutationRequest } from '../operations/journal';
import { contracts, hasToolScope, operationSchema, validateResult, type Metadata, type PublicOperation } from './contracts';
import { domainValue, publicError, ToolError } from './errors';

export const mutationToolNames = ['create_checkin', 'undo_checkin', 'get_operation'] as const;
export type MutationToolName = typeof mutationToolNames[number] | 'claim_reward';
const created = z.object({ checkInId: z.string(), logicalDate: z.string(), created: z.boolean() });
const claimed = z.object({ ledgerEntryId: z.string(), rewardId: z.string(), titleSnapshot: z.string(),
  costCoins: z.number(), logicalDate: z.string(), balance: z.number() });

function failure(cause: unknown): never {
  if (cause instanceof JournalError) {
    throw new ToolError(cause.code, cause.code === 'IDEMPOTENCY_CONFLICT'
      ? 'This operation id belongs to different arguments or another tool.' : 'The operation requires review or recovery.', cause.code === 'OPERATION_PENDING');
  }
  if (cause instanceof OperationRuntimeError) throw new ToolError(cause.code, 'This connection cannot complete the operation safely.', cause.code !== 'FORBIDDEN');
  throw cause;
}

export function publicOperation(operation: JournalOperation): PublicOperation {
  let result: PublicOperation['result'] = null, error: PublicOperation['error'] = null;
  if (operation.result?.ok) {
    if (operation.intent.command.tool === 'create_checkin') {
      const value = created.parse(operation.result.value);
      result = { checkinId: value.checkInId, habitId: operation.intent.command.input.boardId,
        logicalDate: value.logicalDate, created: value.created };
    } else if (operation.intent.command.tool === 'undo_checkin') {
      result = { checkinId: operation.intent.command.input.checkInId, undone: true };
    } else {
      const value = claimed.parse(operation.result.value);
      result = { ledgerEntryId: value.ledgerEntryId, rewardId: value.rewardId, rewardTitle: value.titleSnapshot,
        costCoins: value.costCoins, logicalDate: value.logicalDate, balanceAfterClaim: value.balance };
    }
  } else if (operation.result) {
    try { domainValue(operation.result); } catch (cause) { error = publicError(cause); }
  }
  return operationSchema.parse({ operationId: operation.intent.operationId, tool: operation.intent.tool,
    state: operation.state, delivery: operation.delivery, result, error });
}

export class MutationTools {
  readonly toolNames: readonly MutationToolName[];
  constructor(private readonly options: { accounts: Pick<AccountActors, 'runOperation' | 'lookupOperation'>; rewardClaims?: boolean }) {
    this.toolNames = Object.freeze([...mutationToolNames, ...(options.rewardClaims ? ['claim_reward' as const] : [])]);
  }

  async invoke(name: MutationToolName, raw: unknown, context: AuthContext): Promise<{ data: PublicOperation; meta: Metadata }> {
    if (!this.toolNames.includes(name)) throw new ToolError('NOT_FOUND', 'The requested tool is unavailable.');
    const contract = contracts[name];
    if (!hasToolScope(contract, context.scopes)) throw new ToolError('FORBIDDEN', 'This connection lacks permission for this tool.');
    const parsed = contract.input.safeParse(raw);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', 'The tool arguments are invalid.');
    try {
      if (name === 'get_operation') {
        const input = contracts.get_operation.input.parse(parsed.data);
        const response = await this.options.accounts.lookupOperation(context, input.operationId.toLowerCase());
        if (!response.data) throw new ToolError('NOT_FOUND', 'The requested operation is unavailable.');
        if (!hasToolScope(contracts[response.data.intent.tool], context.scopes)) throw new ToolError('FORBIDDEN', 'Original operation permissions are required.');
        const result = { data: publicOperation(response.data), meta: response.meta };
        validateResult(name, result); return result;
      }
      const request: MutationRequest = name === 'create_checkin'
        ? { clientId: context.clientId, tool: name, input: contracts.create_checkin.input.parse(parsed.data) }
        : name === 'undo_checkin'
          ? { clientId: context.clientId, tool: name, input: contracts.undo_checkin.input.parse(parsed.data) }
          : { clientId: context.clientId, tool: name, input: contracts.claim_reward.input.parse(parsed.data) };
      const response = await this.options.accounts.runOperation(context, request);
      const result = { data: publicOperation(response.data), meta: response.meta };
      validateResult(name, result); return result;
    } catch (cause) { return failure(cause); }
  }
}
