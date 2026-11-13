import * as fs from 'node:fs';
import * as path from 'node:path';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from './private-fs.js';

/**
 * Advisory lock file for the background catalogue refresh.
 *
 * Acquisition is an exclusive create (`wx`), so exactly one process wins. The file holds `{ pid, ts, hb? }`:
 * `ts` is when the lock was taken, `hb` the owner's last heartbeat (see {@link heartbeat}).
 * A lock is stale when its owning process no longer exists, or when both `ts` and `hb` are older than `staleMs`
 * (a live owner that keeps its heartbeat fresh is never taken over, however long it runs). A stale lock is taken
 * over. Nothing here throws: a filesystem failure reads as "lock not acquired".
 *
 * Known limit: two processes taking over the same stale lock at once can both believe they won only if the
 * second removes the first one's fresh file; the takeover re-reads the file and only removes it when it still
 * holds the stale contents, which shrinks that window to a few microseconds. The refresh is idempotent, so the
 * worst case is one duplicate refresh.
 */

type LockInfo = { pid: number; ts: number; hb?: number };

function readLock(lockPath: string): { raw: string; info: LockInfo | null } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.ts === 'number') {
      const hb = typeof parsed.hb === 'number' && Number.isFinite(parsed.hb) ? parsed.hb : undefined;
      return { raw, info: { pid: parsed.pid, ts: parsed.ts, ...(hb !== undefined ? { hb } : {}) } };
    }
  } catch {
    // unreadable content is treated as a stale lock below
  }
  return { raw, info: null };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: the process exists but is not ours
    return err?.code === 'EPERM';
  }
}

function createExclusive(lockPath: string, now: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: now }));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Try to take the lock at `lockPath`. Returns true when this process now holds it.
 * `staleMs` is the age after which an existing lock may be taken over. `now` is injectable for tests.
 */
export function tryLock(lockPath: string, staleMs: number, now: number = Date.now()): boolean {
  try {
    privateDir(path.dirname(lockPath));
    if (createExclusive(lockPath, now)) return true;

    const held = readLock(lockPath);
    if (!held) {
      // vanished between the two calls: one more attempt
      return createExclusive(lockPath, now);
    }
    const stale = !held.info || !pidAlive(held.info.pid) || now - Math.max(held.info.ts, held.info.hb ?? 0) > staleMs;
    if (!stale) return false;

    // Take over only if the file still holds exactly what we judged stale.
    const again = readLock(lockPath);
    if (!again || again.raw !== held.raw) return false;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // someone else removed it; the exclusive create below decides the winner
    }
    return createExclusive(lockPath, now);
  } catch {
    return false;
  }
}

/** Write the lock file through a temp file and a rename, so a reader never sees a half-written lock. */
function writeLockAtomic(lockPath: string, info: LockInfo): boolean {
  const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(info), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    privateFile(tmp);
    fs.renameSync(tmp, lockPath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    return false;
  }
}

/**
 * Hand a lock this process holds to another process (the detached refresh the trigger spawns): the file is
 * rewritten with the new owner's pid, atomically. Returns false on a filesystem failure.
 */
export function handOffLock(lockPath: string, pid: number, now: number = Date.now()): boolean {
  return writeLockAtomic(lockPath, { pid, ts: now });
}

/**
 * Refresh the heartbeat of a lock this process owns, so a long run is not taken over as stale. The rewrite is
 * atomic. Returns true when the heartbeat was written; false (and nothing changed) when the lock is missing or
 * owned by another process. Never throws.
 */
export function heartbeat(lockPath: string, now: number = Date.now()): boolean {
  try {
    const held = readLock(lockPath);
    if (!held?.info || held.info.pid !== process.pid) return false;
    return writeLockAtomic(lockPath, { pid: held.info.pid, ts: held.info.ts, hb: now });
  } catch {
    return false;
  }
}

/** Release the lock when this process owns it. Returns true when a lock file of ours was removed. Never throws. */
export function unlock(lockPath: string): boolean {
  try {
    const held = readLock(lockPath);
    if (!held?.info || held.info.pid !== process.pid) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
