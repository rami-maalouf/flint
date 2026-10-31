import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fail, privateDir, privateFile } from './common.mjs';

export function acquireRecoveryLock(directory) {
  privateDir(directory);
  const path = join(directory, 'lock.sqlite');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  privateFile(path);
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE');
    return db;
  } catch {
    db?.close();
    fail('recovery lock unavailable');
  }
}

export function releaseRecoveryLock(db) {
  if (!db) return;
  try { db.exec('ROLLBACK'); } finally { db.close(); }
}
