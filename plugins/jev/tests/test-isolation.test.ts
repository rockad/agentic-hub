/**
 * The test run must never share state with the machine it runs on. The router's decision cache is a machine-wide file
 * (/dev/shm/jev/cache.sqlite) unless JEV_CACHE_FILE is set; a rating cached there by a real run answered a test's router
 * call without a key and failed the "missing key fails open" tests (v2.3.17 review F3). tests/setup-home.ts points it at
 * the temporary home.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import { DEFAULT_SHM_CACHE_FILE, resolveDbPath, setCachedDecision } from '../src/core/cache.ts';

describe('test isolation', () => {
  it('the decision cache of a test run is a private file inside the temporary home, not the machine-wide one', () => {
    const file = process.env.JEV_CACHE_FILE ?? '';
    expect(file).not.toBe('');
    expect(file.startsWith(process.env.HOME ?? '\0')).toBe(true);
    expect(resolveDbPath()).toBe(file);
    expect(resolveDbPath()).not.toBe(DEFAULT_SHM_CACHE_FILE);
  });

  it('a decision cached by a test lands in that private file', () => {
    const file = process.env.JEV_CACHE_FILE!;
    setCachedDecision('isolation-probe-key', { answers: {} } as never);
    expect(fs.existsSync(file)).toBe(true);
  });
});
