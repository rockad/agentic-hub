import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryLock, unlock } from '../src/core/lock.js';

describe('lock helper', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-lock-'));
    lockPath = path.join(dir, 'sub', 'refresh.lock');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a free lock, creating the parent directory, owner-only, with pid and timestamp', () => {
    expect(tryLock(lockPath, 60_000, 1000)).toBe(true);
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(info).toEqual({ pid: process.pid, ts: 1000 });
    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(lockPath)).mode & 0o777).toBe(0o700);
  });

  it('is exclusive: a second attempt on a fresh lock fails and leaves it untouched', () => {
    expect(tryLock(lockPath, 60_000, 1000)).toBe(true);
    expect(tryLock(lockPath, 60_000, 2000)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ts).toBe(1000);
  });

  it('takes over a lock older than staleMs', () => {
    expect(tryLock(lockPath, 5000, 1000)).toBe(true);
    expect(tryLock(lockPath, 5000, 5500)).toBe(false);
    expect(tryLock(lockPath, 5000, 6001)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ts).toBe(6001);
  });

  it('takes over a fresh lock whose owner process is gone', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, ts: 1000 }));
    expect(tryLock(lockPath, 60_000, 1001)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('treats a garbage lock file as stale', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'not json');
    expect(tryLock(lockPath, 60_000, 1000)).toBe(true);
  });

  it('unlock removes our lock and allows re-acquisition', () => {
    expect(tryLock(lockPath, 60_000, 1000)).toBe(true);
    expect(unlock(lockPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(tryLock(lockPath, 60_000, 1001)).toBe(true);
  });

  it('unlock leaves a lock owned by another process and a missing lock alone, without throwing', () => {
    expect(unlock(lockPath)).toBe(false);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, ts: 1000 }));
    expect(unlock(lockPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('never throws when the path is unusable', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    expect(tryLock(path.join(blocker, 'nested', 'refresh.lock'), 1000)).toBe(false);
    expect(unlock(path.join(blocker, 'nested', 'refresh.lock'))).toBe(false);
  });
});
