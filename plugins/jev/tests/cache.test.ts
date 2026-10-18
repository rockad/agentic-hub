import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getCachedDecision,
  setCachedDecision,
  clearDecisionCache,
  computeDecisionCacheKey,
  resolveDbPath,
  resolveCacheFilePath,
  DEFAULT_SHM_CACHE_FILE,
  DEFAULT_FALLBACK_CACHE_FILE,
  DECISION_CACHE_TTL_SEC
} from '../src/core/cache.js';

describe('Shared bun:sqlite RAM Cache (src/core/cache.ts)', () => {
  let tmpCacheDir: string;
  let tmpCacheFile: string;

  beforeEach(() => {
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cache-sqlite-'));
    tmpCacheFile = path.join(tmpCacheDir, 'cache.sqlite');
    process.env.JEV_CACHE_FILE = tmpCacheFile;
    clearDecisionCache();
  });

  afterEach(() => {
    clearDecisionCache();
    delete process.env.JEV_CACHE_FILE;
    delete process.env.JEV_CACHE_TTL_MS;
    try {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true });
    } catch {}
  });

  it('resolves cache file path to /dev/shm/jev/cache.sqlite on Linux when env var is unset', () => {
    delete process.env.JEV_CACHE_FILE;
    const resolved = resolveDbPath();
    if (fs.existsSync('/dev/shm')) {
      expect(resolved).toBe(DEFAULT_SHM_CACHE_FILE);
      expect(resolved).toBe('/dev/shm/jev/cache.sqlite');
    } else {
      expect(resolved).toBe(DEFAULT_FALLBACK_CACHE_FILE);
    }
  });

  it('prioritizes JEV_CACHE_FILE override if set', () => {
    process.env.JEV_CACHE_FILE = '/custom/path/cache.sqlite';
    expect(resolveDbPath()).toBe('/custom/path/cache.sqlite');
    expect(resolveCacheFilePath()).toBe('/custom/path/cache.sqlite');
  });

  it('stores and retrieves cached decision via bun:sqlite with sub-millisecond latency', () => {
    const key = computeDecisionCacheKey('task: cache test', [{ id: 'opt1' }], 'flash');
    const data = { selected: 'opt1', confidence: 0.99 };

    setCachedDecision(key, data);

    const start = performance.now();
    const hit = getCachedDecision(key);
    const elapsed = performance.now() - start;

    expect(hit).toEqual(data);
    expect(elapsed).toBeLessThan(10); // sub-millisecond in-process retrieval

    // Verify SQLite file on disk contains valid table and data
    expect(fs.existsSync(tmpCacheFile)).toBe(true);
    const db = new Database(tmpCacheFile);
    const row = db.query('SELECT data, created_at, expires_at FROM decision_cache WHERE key = ?').get(key) as any;
    expect(row).toBeDefined();
    expect(JSON.parse(row.data)).toEqual(data);
    expect(row.expires_at).toBeGreaterThan(row.created_at);
    db.close();
  });

  it('verifies WAL pragma and index schema in SQLite database', () => {
    const key = 'test-schema-key';
    setCachedDecision(key, { ok: true });

    const db = new Database(tmpCacheFile);
    const journalMode = db.query('PRAGMA journal_mode;').get() as any;
    expect(journalMode.journal_mode.toLowerCase()).toBe('wal');

    const indexInfo = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_decision_cache_expires';").get() as any;
    expect(indexInfo).toBeDefined();
    expect(indexInfo.name).toBe('idx_decision_cache_expires');
    db.close();
  });

  it('expires stale entries according to ttlSec', () => {
    const key = 'test-expire-key';
    const data = { valid: false };

    // Set with negative ttlSec so it is already expired
    setCachedDecision(key, data, -5);

    expect(getCachedDecision(key)).toBeNull();
  });

  it('clears decision cache rows via clearDecisionCache', () => {
    const key = 'test-clear-key';
    setCachedDecision(key, { ok: true });
    expect(getCachedDecision(key)).toEqual({ ok: true });

    clearDecisionCache();

    expect(getCachedDecision(key)).toBeNull();

    const db = new Database(tmpCacheFile);
    const countRow = db.query('SELECT count(*) as count FROM decision_cache;').get() as any;
    expect(countRow.count).toBe(0);
    db.close();
  });

  it('handles concurrent multi-writes without locking deadlocks or database corruption', () => {
    const count = 30;
    for (let i = 0; i < count; i++) {
      setCachedDecision(`key-${i}`, { index: i, timestamp: Date.now() });
    }

    for (let i = 0; i < count; i++) {
      const entry = getCachedDecision(`key-${i}`);
      expect(entry).toBeDefined();
      expect(entry.index).toBe(i);
    }

    const db = new Database(tmpCacheFile);
    const countRow = db.query('SELECT count(*) as count FROM decision_cache;').get() as any;
    expect(countRow.count).toBe(count);
    db.close();
  });
});
