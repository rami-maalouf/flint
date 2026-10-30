import type { Session } from 'snapback4/auth';
import type { Hashing } from '../../core/domain/ports.ts';
import type { SqlDatabase } from '../../core/persistence/database.ts';
import { SyncTransportError } from '../../core/sync/transport.ts';

export async function bindBackendAccount(
  core: { db: SqlDatabase; hashing: Hashing }, url: string, session: Session,
): Promise<void> {
  const identity = JSON.stringify([url.replace(/\/+$/, ''), session.principal]);
  const bytes = await core.hashing.sha256(new TextEncoder().encode(identity));
  const digest = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  await core.db.withExclusiveTransactionAsync(async tx => {
    const row = await tx.getFirstAsync<{ account_digest: string }>(
      'SELECT account_digest FROM sync_account_bindings WHERE provider = ?', ['snapback4'],
    );
    if (row && row.account_digest !== digest) {
      throw new SyncTransportError('signed_out', 'This device belongs to a different account. Sign in to the account originally used here.');
    }
    if (!row) await tx.runAsync('INSERT INTO sync_account_bindings (provider, account_digest) VALUES (?, ?)', ['snapback4', digest]);
  });
}
