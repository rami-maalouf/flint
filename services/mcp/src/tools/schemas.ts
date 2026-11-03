import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Board, Reward } from '../../../../src/core/domain/entities.ts';
import type { DomainResult } from '../../../../src/core/domain/result.ts';
import { ToolError } from '../accounts.ts';

export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'expected a UUID');

export const operationId = z.uuid().describe(
  'A new random UUID for this action. Reuse the same value only to retry this exact action after an unclear result.');

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'expected a calendar date as YYYY-MM-DD');

export const timeZone = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'expected an IANA time zone such as Europe/Paris').describe('The user\'s IANA time zone, such as America/New_York.');

export const limit = z.number().int().min(1).max(100).optional();
export const cursor = z.string().max(2048).optional().describe('The nextCursor from the previous page.');

export const instant = (value: number | null) => value === null ? null : new Date(value).toISOString();

export const habit = z.object({
  id, title: z.string(), kind: z.enum(['count', 'daily']),
  tracksAmount: z.boolean(), amountUnit: z.string().nullable(), defaultAmount: z.number(),
  tracksTime: z.boolean(), dayStartsAtMinute: z.number().int(), earnsCoins: z.boolean(), coinCapPerDay: z.number().int(),
  archived: z.boolean(),
});
export function toHabit(board: Board): z.infer<typeof habit> {
  return {
    id: board.id, title: board.title, kind: board.kind, tracksAmount: board.tracksAmount, amountUnit: board.amountUnit,
    defaultAmount: board.quickAmount, tracksTime: board.tracksTime, dayStartsAtMinute: board.startOfDayMinute,
    earnsCoins: board.earnsCoins, coinCapPerDay: board.coinCapPerDay, archived: board.archivedAt !== null,
  };
}

export const reward = z.object({
  id, title: z.string(), costCoins: z.number().int(), archived: z.boolean(),
  version: z.string().describe('Pass this to claim_reward so the claim fails if the reward changed after the user saw it.'),
});
export function toReward(row: Reward): z.infer<typeof reward> {
  return { id: row.id, title: row.title, costCoins: row.costCoins, archived: row.archivedAt !== null, version: row.mutationStamp };
}

export const sync = z.object({
  status: z.enum(['synced', 'offline', 'needs_attention']),
  lastSyncedAt: z.string().nullable(),
  pendingUploads: z.number().int(),
});

// cursors only position a listing inside the caller's own account data, so they need
// no secrecy; they are opaque to discourage clients from building them by hand.
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}
export function decodeCursor<T>(value: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (value === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ToolError('INVALID_INPUT', 'The cursor is invalid. Start the listing again without a cursor.');
  }
}

// product messages are written for people, so they pass through unchanged.
export function unwrap<T>(result: DomainResult<T>): T {
  if (result.ok) return result.value;
  const { code, message } = result.error;
  if (code === 'not_found') throw new ToolError('NOT_FOUND', message);
  if (code === 'validation') throw new ToolError('INVALID_INPUT', message);
  if (code === 'archived' || code === 'conflict') throw new ToolError('CONFLICT', message);
  if (code === 'permission_denied') throw new ToolError('FORBIDDEN', message);
  throw new ToolError('UNAVAILABLE', 'Flint could not complete this request. Try again shortly.');
}

// a stable uuid v4 shape derived from an operation, so a retry maps to the same command
// and the same stored records even after this server's replica is rebuilt from sync.
export function derivedUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(['flint-mcp/v1', ...parts])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
