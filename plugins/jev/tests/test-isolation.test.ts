/**
 * The test run must never share state with the machine it runs on. The router's decision cache is a machine-wide file
 * (/dev/shm/jev/cache.sqlite) unless JEV_CACHE_FILE is set; a rating cached there by a real run answered a test's router
 * call without a key and failed the "missing key fails open" tests (v2.3.17 review F3). tests/setup-home.ts points it at
 * the temporary home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureSecretsLoaded, openRouterKey, secretsFiles } from '../src/core/client.ts';
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

describe('test isolation: the secrets loader (#76 review B4)', () => {
  const PROBE = 'JEV_B4_PROBE_VALUE';
  let tmp = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-secrets-'));
    for (const k of ['HOME', 'JEV_SECRETS_FILES', PROBE]) saved[k] = process.env[k];
    delete process.env[PROBE];
    fs.mkdirSync(path.join(tmp, '.config', 'zsh'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.config', 'zsh', 'secrets.env'), `export ${PROBE}=from-secrets-env\n`);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the secrets files of HOME at call time (bun fixes os.homedir() at startup, plain `bun test` cannot move it)', () => {
    process.env.HOME = tmp;
    delete process.env.JEV_SECRETS_FILES;
    ensureSecretsLoaded();
    expect(process.env[PROBE]).toBe('from-secrets-env');
  });

  it('a HOME without secrets files loads nothing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-secrets-empty-'));
    try {
      process.env.HOME = empty;
      delete process.env.JEV_SECRETS_FILES;
      ensureSecretsLoaded();
      expect(process.env[PROBE]).toBeUndefined();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('JEV_SECRETS_FILES replaces the default list: only the listed files are read, even when HOME holds a key', () => {
    process.env.HOME = tmp; // would load the probe
    const other = path.join(tmp, 'other.env');
    fs.writeFileSync(other, 'JEV_B4_OTHER=from-other\n');
    process.env.JEV_SECRETS_FILES = other;
    delete process.env.JEV_B4_OTHER;
    ensureSecretsLoaded();
    expect(process.env[PROBE]).toBeUndefined();
    expect(process.env.JEV_B4_OTHER).toBe('from-other');
    delete process.env.JEV_B4_OTHER;
    process.env.JEV_SECRETS_FILES = path.join(tmp, 'does-not-exist.env');
    ensureSecretsLoaded();
    expect(process.env[PROBE]).toBeUndefined();
  });

  it('under the test preload no secrets file outside the temporary home is on the list, and no API key is reachable', () => {
    for (const k of ['HOME', 'JEV_SECRETS_FILES']) process.env[k] = saved[k];
    const files = secretsFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f.startsWith(process.env.HOME ?? '\0')).toBe(true);
    const keys = { a: process.env.JEV_OPENROUTER_API_KEY, b: process.env.OPENROUTER_API_KEY };
    delete process.env.JEV_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => openRouterKey()).toThrow();
    } finally {
      if (keys.a !== undefined) process.env.JEV_OPENROUTER_API_KEY = keys.a;
      if (keys.b !== undefined) process.env.OPENROUTER_API_KEY = keys.b;
    }
  });
});
