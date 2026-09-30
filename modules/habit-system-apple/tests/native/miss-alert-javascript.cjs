const { Database } = require('bun:sqlite');
const { reconcileMissAlerts } = require('../../../../src/core/domain/miss-alert-reconciliation.ts');

// the actual typescript reconciler competes with the swift runner on the same file.
async function main() {
  const [path, instant, zone, mode] = process.argv.slice(2);
  const connection = new Database(path, { create: false, strict: true });
  connection.run('PRAGMA foreign_keys = ON');
  connection.run('PRAGMA busy_timeout = 5000');
  const transaction = async (sql, work) => {
    connection.run(sql);
    try {
      const result = await work(db);
      connection.run('COMMIT');
      return result;
    } catch (cause) {
      connection.run('ROLLBACK');
      throw cause;
    }
  };
  const db = {
    runAsync: async (sql, params = []) => ({ changes: connection.query(sql).run(...params).changes }),
    getAllAsync: async (sql, params = []) => connection.query(sql).all(...params),
    getFirstAsync: async (sql, params = []) => connection.query(sql).get(...params),
    execAsync: async sql => { connection.run(sql); },
    withExclusiveTransactionAsync: work => transaction('BEGIN EXCLUSIVE', work),
    withTransactionAsync: work => transaction('BEGIN', work),
    closeAsync: async () => { connection.close(); },
  };
  let calls = 0;
  const scheduler = {
    authorization: async () => 'granted', pendingRequests: async () => [], presentedIdentifiers: async () => [],
    cancel: async () => ({ kind: 'cancelled' }), refreshPending: async () => ({ kind: 'unchanged' }),
    schedule: async () => {
      calls += 1;
      if (mode === 'hold') {
        process.stdout.write(JSON.stringify({ ready: true }) + '\n');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('test release timed out')), 10000);
          process.stdin.once('data', () => { clearTimeout(timer); process.stdin.pause(); resolve(); });
          process.stdin.resume();
        });
      }
      return { kind: 'accepted' };
    },
  };
  const result = await reconcileMissAlerts({ db, scheduler,
    clock: { nowUtcMs: () => Number(instant), timeZoneId: () => zone } },
  { isCurrent: () => true, isForeground: () => false });
  process.stdout.write(JSON.stringify({ result, calls, rows: await db.getAllAsync('SELECT * FROM miss_alerts') }) + '\n');
  await db.closeAsync();
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
