import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withDirLock, withDirLockOrSkip, DirLockTimeoutError, isDirLockTimeout } from '../src/core/dir-lock.ts';
import { recordPendingServed, flushPendingServed } from '../antigravity/logic.ts';
import { evaluatePreToolGuards } from '../antigravity/guards.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dir-lock-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('withDirLock', () => {
  it('runs fn, returns its value and removes the lock', () => {
    const lock = path.join(dir, 'a.lock');
    expect(withDirLock(lock, () => 42)).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases the lock when fn throws, and rethrows', () => {
    const lock = path.join(dir, 'a.lock');
    expect(() =>
      withDirLock(lock, () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('times out on a fresh lock held by someone else, and the error names the lock', () => {
    const lock = path.join(dir, 'abc.downgrade.lock');
    fs.mkdirSync(lock);
    let caught: unknown;
    try {
      withDirLock(lock, () => 1, { waitMs: 30 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DirLockTimeoutError);
    expect(isDirLockTimeout(caught)).toBe(true);
    expect((caught as Error).message).toContain('abc.downgrade.lock');
    expect((caught as DirLockTimeoutError).lock).toBe('abc.downgrade.lock');
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('breaks a stale lock', () => {
    const lock = path.join(dir, 'a.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'dead-process');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(withDirLock(lock, () => 'got it')).toBe('got it');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a holder whose lock was broken does not remove the next holder\'s lock', () => {
    const lock = path.join(dir, 'a.lock');
    withDirLock(lock, () => {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), 'someone-else');
    });
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('withDirLockOrSkip returns undefined and calls onTimeout instead of throwing', () => {
    const lock = path.join(dir, 'b.lock');
    fs.mkdirSync(lock);
    const seen: string[] = [];
    const out = withDirLockOrSkip(lock, () => 'ran', (e) => seen.push(e.lock), { waitMs: 20 });
    expect(out).toBeUndefined();
    expect(seen).toEqual(['b.lock']);
    expect(withDirLockOrSkip(path.join(dir, 'c.lock'), () => 'ran', () => {})).toBe('ran');
  });

  it('withDirLockOrSkip rethrows an error from fn', () => {
    expect(() =>
      withDirLockOrSkip(path.join(dir, 'd.lock'), () => {
        throw new Error('inner');
      }, () => {})
    ).toThrow('inner');
  });
});

describe('fail open on a held lock (A5)', () => {
  const SESSION = '00000000-0000-4000-8000-00000000a502';

  it('recordPendingServed skips the update and logs one lock_timeout row', () => {
    const lock = path.join(dir, `${SESSION}.pending-served.lock`);
    fs.mkdirSync(lock);
    const rows: Array<Record<string, unknown>> = [];
    recordPendingServed(dir, SESSION, { stepIdx: 1, requestedModel: 'flash', createdAt: Date.now() }, (r) => rows.push(r));
    expect(fs.existsSync(path.join(dir, `${SESSION}.pending-served.json`))).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'lock_timeout', op: 'record', lock: `${SESSION}.pending-served.lock` });
  });

  it('flushPendingServed skips and leaves the file untouched on a held lock', () => {
    const file = path.join(dir, `${SESSION}.pending-served.json`);
    const original = JSON.stringify([{ requestedModel: 'flash', childConvId: null, createdAt: Date.now() }]) + '\n';
    fs.writeFileSync(file, original);
    fs.mkdirSync(path.join(dir, `${SESSION}.pending-served.lock`));
    const rows: Array<Record<string, unknown>> = [];
    flushPendingServed(dir, SESSION, (r) => rows.push(r));
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(rows.map((r) => r.event)).toEqual(['lock_timeout']);
  });

  it('the write guard allows the edit and logs lock_timeout when its lock is held', async () => {
    clearConfigCacheForTesting();
    const origHome = process.env.HOME;
    const origCfg = process.env.JEV_CONFIG_FILE;
    const cfgDir = path.join(dir, '.config', 'jev');
    fs.mkdirSync(path.join(cfgDir, 'antigravity-sessions'), { recursive: true });
    process.env.HOME = dir;
    process.env.JEV_CONFIG_FILE = path.join(cfgDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' }, harnesses: { antigravity: { writeGuard: { maxFiles: 0 } } } }));
    try {
      fs.mkdirSync(path.join(cfgDir, 'antigravity-sessions', `${SESSION}.write-guard.lock`));
      const res = await evaluatePreToolGuards({
        conversationId: SESSION,
        modelName: 'gemini-3.8-flash-low',
        toolCall: { name: 'edit_file', args: { Path: 'src/x.ts' } }
      });
      expect(res.decision).toBe('allow');
      const rows = fs
        .readFileSync(path.join(cfgDir, 'antigravity_decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows.filter((r) => r.outcome === 'lock_timeout')).toHaveLength(1);
      expect(fs.existsSync(path.join(cfgDir, 'antigravity-sessions', `${SESSION}.write-guard.json`))).toBe(false);
    } finally {
      clearConfigCacheForTesting();
      process.env.HOME = origHome;
      if (origCfg === undefined) delete process.env.JEV_CONFIG_FILE;
      else process.env.JEV_CONFIG_FILE = origCfg;
    }
  });
});
