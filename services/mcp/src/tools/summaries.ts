import { contracts, metadataSchema, type PublicOperation, type ToolName } from './contracts';

export const SUMMARY_BYTES = 8192;
const named = (row: { id: string; title: string }) => `${JSON.stringify(row.title)} (${row.id})`;
function page(label: string, rows: readonly string[], next = false): string {
  return `${rows.length} ${label} returned${next ? '; more results available' : ''}.${rows.length ? ' ' + rows.slice(0, 5).join('; ') : ''}${rows.length > 5 ? '; additional items are in the structured result.' : ''}`;
}
function operation(row: PublicOperation): string {
  const prefix = `Operation ${row.operationId}: ${row.tool}; state ${row.state}; delivery ${row.delivery}.`;
  const result = row.result;
  if (!result) return prefix + (row.error ? ` ${row.error.code}: ${row.error.message}` : ' No committed result is available.');
  if ('created' in result) return `${prefix} ${result.created ? 'Created' : 'Reused existing'} check-in ${result.checkinId} for habit ${result.habitId} on ${result.logicalDate}.`;
  if ('undone' in result) return `${prefix} Check-in ${result.checkinId}: ${result.undone ? 'undone' : 'no undo effect'}.`;
  return `${prefix} Reward ${JSON.stringify(result.rewardTitle)} (${result.rewardId}) cost ${result.costCoins} coins; balance after claim ${result.balanceAfterClaim}; ledger entry ${result.ledgerEntryId}.`;
}
function details(name: ToolName, raw: unknown): string {
  switch (name) {
    case 'list_habits': {
      const { data } = contracts[name].output.parse(raw);
      return page('habits', data.items.map(named), data.nextCursor !== null);
    }
    case 'get_habit': {
      const { data } = contracts[name].output.parse(raw);
      return `Habit ${named(data)}: ${data.kind}; ${data.archivedAt === null ? 'active' : 'archived'}; day starts at minute ${data.startOfDayMinute}.`;
    }
    case 'get_today': {
      const { data } = contracts[name].output.parse(raw);
      return page('habits for today', data.items.map(row => `${named(row.habit)}: logical date ${row.logicalDate}${row.daily ? '; checked ' + row.daily.checkedToday : ''}`));
    }
    case 'list_stacks': {
      const { data } = contracts[name].output.parse(raw);
      return page('stacks', data.items.map(row => `root ${row.rootId}: ${row.members.length} members; current run ${row.currentRun.complete ? 'complete' : 'incomplete'}`), data.nextCursor !== null);
    }
    case 'get_stack': {
      const { data } = contracts[name].output.parse(raw);
      return `Stack root ${data.rootId}: ${data.members.length} members; ${data.currentRun.checkedRequiredCount}/${data.currentRun.requiredCount} required checked on ${data.currentRun.logicalDate}; current streak ${data.currentStreak}; longest streak ${data.longestStreak}.`;
    }
    case 'get_checkin_history': {
      const { data } = contracts[name].output.parse(raw);
      return page('check-ins', data.items.map(row => `${row.id}: habit ${row.habitId}, ${row.logicalDate}${row.amount === null ? '' : ', amount ' + row.amount}`), data.nextCursor !== null);
    }
    case 'get_coin_balance': {
      const { data } = contracts[name].output.parse(raw);
      return `Coin balance ${data.balance}; earned ${data.earned}; spent ${data.spent}.`;
    }
    case 'get_coin_history': {
      const { data } = contracts[name].output.parse(raw);
      return page('coin entries', data.items.map(row => `${row.id}: ${row.kind}, ${row.delta} coins on ${row.logicalDate}`), data.nextCursor !== null);
    }
    case 'list_rewards': {
      const { data } = contracts[name].output.parse(raw);
      return page('rewards', data.items.map(row => `${named(row)}: ${row.costCoins} coins`), data.nextCursor !== null);
    }
    case 'get_reward_claim_preview': {
      const { data } = contracts[name].output.parse(raw);
      const url = Buffer.byteLength(data.confirmationUrl) <= 6000 ? data.confirmationUrl : 'the confirmationUrl in the structured result';
      return `Reward ${named(data.reward)} costs ${data.reward.costCoins} coins. Current balance ${data.balance}; ${data.balanceAfterClaim === null ? 'insufficient funds' : 'balance after claim ' + data.balanceAfterClaim}. Operation ${data.operationId}. No coins spent or reserved. Confirmation details: ${url}. ${data.balanceAfterClaim === null ? 'Approval is unavailable.' : 'Open that URL to approve this exact cost before claiming.'}`;
    }
    case 'get_sync_status': {
      const { data } = contracts[name].output.parse(raw);
      return `Writes ${data.writeFenced ? 'fenced' : 'eligible'}; delivery ${data.deliveryPaused ? 'paused' : 'not paused'}; reconnect ${data.reconnectRequired ? 'required' : 'not required'}${data.recoveryReason ? '; recovery ' + data.recoveryReason : ''}.`;
    }
    case 'get_operation': case 'create_checkin': case 'undo_checkin': case 'claim_reward':
      return operation(contracts[name].output.parse(raw).data);
  }
}

export function summarizeResult(name: ToolName, raw: unknown): string {
  const meta = metadataSchema.parse((raw as { meta: unknown }).meta);
  const result = `${details(name, raw)} Observation ${meta.observedAtUtc}; sync ${meta.syncStatus}; queued deliveries ${meta.pendingLocalDeliveries}${meta.usedCached ? '; cached observation' : ''}.`;
  if (Buffer.byteLength(result) <= SUMMARY_BYTES) return result;
  let bounded = '', bytes = 0;
  for (const character of result) {
    const length = Buffer.byteLength(character);
    if (bytes + length > SUMMARY_BYTES - 3) break;
    bounded += character; bytes += length;
  }
  return bounded + '...';
}
