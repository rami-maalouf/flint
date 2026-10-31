import type { DomainResult } from '../../../../src/core/domain/result';
import { errorSchema } from './contracts';
import type { z } from 'zod';

export type PublicError = z.infer<typeof errorSchema>;
export class ToolError extends Error {
  constructor(readonly code: PublicError['code'], message: string, readonly retryable = false) { super(message); }
}
export function domainValue<T>(result: DomainResult<T>): T {
  if (result.ok) return result.value;
  const code = result.error.code;
  if (code === 'not_found') throw new ToolError('NOT_FOUND', 'The requested item is unavailable.');
  if (code === 'validation') throw new ToolError('INVALID_INPUT', 'The request does not match the product rules.');
  if (code === 'permission_denied') throw new ToolError('FORBIDDEN', 'This connection cannot perform that action.');
  if (code === 'archived' || code === 'conflict') throw new ToolError('CONFLICT', 'The item has changed or is archived.');
  throw new ToolError('UNAVAILABLE', 'The account data could not be loaded safely.', true);
}
export function publicError(cause: unknown): PublicError {
  if (cause instanceof ToolError) return { code: cause.code, message: cause.message, retryable: cause.retryable };
  // preserve only the shared, validated account error contract, never arbitrary error messages.
  if (cause instanceof Error && 'code' in cause && 'retryable' in cause) {
    const parsed = errorSchema.safeParse({ code: cause.code,
      message: 'The account request could not be completed.', retryable: cause.retryable });
    if (parsed.success) return parsed.data;
  }
  return { code: 'UNAVAILABLE', message: 'The request could not be completed safely.', retryable: true };
}
