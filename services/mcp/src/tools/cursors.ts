import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { canonicalJson } from '../operations/records';
import { ToolError } from './errors';

export type CursorBinding = { accountId: string; clientId: string; tool: string; filters: unknown };
export class CursorCodec {
  private readonly key: Buffer;
  constructor(key: Uint8Array, private readonly now = Date.now) {
    if (key.byteLength !== 32) throw new Error('A 256-bit external cursor key is required.');
    this.key = Buffer.from(key);
  }
  encode(binding: CursorBinding, position: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(binding)));
    const body = Buffer.concat([cipher.update(JSON.stringify({ expiresAt: this.now() + 86_400_000, position })), cipher.final()]);
    const cursor = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    if (cursor.length > 4096) throw new ToolError('UNAVAILABLE', 'The ordering key exceeds the supported continuation size.', true);
    return cursor;
  }
  decode<T>(binding: CursorBinding, cursor: string, schema: z.ZodType<T>): T {
    try {
      if (!/^[A-Za-z0-9_-]{39,4096}$/.test(cursor)) throw new Error();
      const data = Buffer.from(cursor, 'base64url');
      if (data.toString('base64url') !== cursor) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(canonicalJson(binding))); decipher.setAuthTag(data.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
      if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= this.now()) throw new Error();
      return schema.parse(payload.position);
    } catch { throw new ToolError('INVALID_INPUT', 'The continuation is invalid or expired. Restart this listing.'); }
  }
}
