import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './private-fs.js';

/**
 * A short-lived advisory lock for a read-modify-write on a small state file, shared by every Jev hook that does one
 * (the Antigravity approval store, the pending-served list, the write-guard streak, and what builds on them).
 *
 * The lock is a directory taken with an exclusive `mkdir` (atomic across processes). The holder writes a unique token
 * file inside it. A lock older than `staleMs` belongs to a dead (or very slow) process and is broken by renaming it
 * away, so a holder that outlives the limit cannot delete the next holder's lock: on release the directory is removed
 * only while its token is still this holder's.
 */

export const DIR_LOCK_WAIT_MS = 2000;
export const DIR_LOCK_STALE_MS = 3000;

/** Thrown when the lock could not be had in time. `lock` is the lock's file name, so a log says which state was busy. */
export class DirLockTimeoutError extends Error {
  readonly lock: string;
  constructor(lock: string) {
    const name = path.basename(lock);
    super(`dir lock timeout: ${name}`);
    this.name = 'DirLockTimeoutError';
    this.lock = name;
  }
}

export function isDirLockTimeout(err: unknown): err is DirLockTimeoutError {
  return err instanceof DirLockTimeoutError;
}

/**
 * Run `fn` while holding the lock directory `lock`. Throws {@link DirLockTimeoutError} (naming the lock) when it cannot
 * be had within `waitMs`; any other filesystem error is rethrown. `fn`'s own errors propagate after the lock is released.
 */
export function withDirLock<T>(lock: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const { waitMs = DIR_LOCK_WAIT_MS, staleMs = DIR_LOCK_STALE_MS } = opts;
  const token = `${process.pid}-${randomUUID()}`;
  const tokenFile = path.join(lock, 'owner');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: PRIVATE_DIR_MODE });
      try {
        fs.writeFileSync(tokenFile, token, { mode: PRIVATE_FILE_MODE });
      } catch (err) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          const broken = `${lock}.stale-${token}`;
          fs.renameSync(lock, broken);
          fs.rmSync(broken, { recursive: true, force: true });
        }
      } catch {
        // the holder just released it, or another waiter broke it first
      }
      if (Date.now() > deadline) throw new DirLockTimeoutError(lock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(tokenFile, 'utf8') === token) fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // the lock was broken and taken over: it is not ours to remove
    }
  }
}

/**
 * Like {@link withDirLock}, but a lock timeout is not an error: `onTimeout` is called with the error and `undefined`
 * is returned, so a caller that fails open can skip its update (and log) in one place.
 */
export function withDirLockOrSkip<T>(
  lock: string,
  fn: () => T,
  onTimeout: (err: DirLockTimeoutError) => void,
  opts: { waitMs?: number; staleMs?: number } = {}
): T | undefined {
  try {
    return withDirLock(lock, fn, opts);
  } catch (err) {
    if (isDirLockTimeout(err)) {
      onTimeout(err);
      return undefined;
    }
    throw err;
  }
}
