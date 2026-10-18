import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadJevConfigSync,
  detectActiveHarness,
  findProjectConfigFile,
  normalizeTier,
  getHarnessConfig,
  getHarnessModels,
  getFreeModelsPool,
  getJevTimeouts,
  getCacheConfig,
  clearConfigCacheForTesting,
  deepMergeWithArrayReplacement,
  DEFAULT_JEV_CONFIG,
  type JevHarness,
  type CognitiveTier
} from '../src/core/config.js';

describe('Jev Multi-Level Configuration Engine (v2 Schema & Cascading Loader)', () => {
  let tmpUserDir: string;
  let tmpUserConfigFile: string;
  let tmpProjectDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-user-test-'));
    tmpUserConfigFile = path.join(tmpUserDir, 'config.json');
    process.env.JEV_CONFIG_FILE = tmpUserConfigFile;

    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-proj-test-'));
    clearConfigCacheForTesting();
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(tmpProjectDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Array Merge Semantics (Pure Replacement)', () => {
    it('completely replaces target array with source array without appending', () => {
      const target = {
        models: { a: '1', b: '2' },
        pool: ['model-1', 'model-2', 'model-3']
      };
      const source = {
        models: { b: 'updated' },
        pool: ['custom-only']
      };

      const merged = deepMergeWithArrayReplacement(target, source);
      expect(merged.models).toEqual({ a: '1', b: 'updated' });
      expect(merged.pool).toEqual(['custom-only']);
      expect(merged.pool.length).toBe(1);
    });

    it('inherits target array when source array is omitted', () => {
      const target = {
        pool: ['model-1', 'model-2']
      };
      const source = {
        otherField: 'val'
      };

      const merged = deepMergeWithArrayReplacement(target, source);
      expect(merged.pool).toEqual(['model-1', 'model-2']);
    });
  });

  describe('Harness Auto-Detection (detectActiveHarness)', () => {
    it('detects explicit JEV_HARNESS override with highest priority', () => {
      process.env.JEV_HARNESS = 'claude-code';
      process.env.ANTIGRAVITY_CLI = 'true';
      expect(detectActiveHarness()).toBe('claude-code');

      process.env.JEV_HARNESS = 'opencode';
      expect(detectActiveHarness()).toBe('opencode');
    });

    it('detects Antigravity from ANTIGRAVITY_CLI or GEMINI_CLI', () => {
      delete process.env.JEV_HARNESS;
      process.env.ANTIGRAVITY_CLI = '1';
      expect(detectActiveHarness()).toBe('antigravity');

      delete process.env.ANTIGRAVITY_CLI;
      process.env.GEMINI_CLI = '1';
      expect(detectActiveHarness()).toBe('antigravity');
    });

    it('detects Claude Code from CLAUDE_CODE or CLAUDE_PROJECT_DIR', () => {
      delete process.env.JEV_HARNESS;
      delete process.env.ANTIGRAVITY_CLI;
      delete process.env.GEMINI_CLI;
      process.env.CLAUDE_CODE = '1';
      expect(detectActiveHarness()).toBe('claude-code');
    });

    it('detects OpenCode from OPENCODE_SESSION or OPENCODE_HOME', () => {
      delete process.env.JEV_HARNESS;
      delete process.env.ANTIGRAVITY_CLI;
      delete process.env.GEMINI_CLI;
      delete process.env.CLAUDE_CODE;
      process.env.OPENCODE_SESSION = 'sess_123';
      expect(detectActiveHarness()).toBe('opencode');
    });

    it('falls back to "cli" when no harness environment signals are present', () => {
      delete process.env.JEV_HARNESS;
      delete process.env.ANTIGRAVITY_CLI;
      delete process.env.GEMINI_CLI;
      delete process.env.CLAUDE_CODE;
      delete process.env.CLAUDE_PROJECT_DIR;
      delete process.env.OPENCODE_SESSION;
      delete process.env.OPENCODE_HOME;
      delete process.env.CORTEX_SESSION;
      expect(detectActiveHarness()).toBe('cli');
    });
  });

  describe('Project Config Discovery (findProjectConfigFile)', () => {
    it('discovers primary .agents/jev.json in project root', () => {
      const agentsDir = path.join(tmpProjectDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const targetFile = path.join(agentsDir, 'jev.json');
      fs.writeFileSync(targetFile, JSON.stringify({ version: 2 }));

      const found = findProjectConfigFile(tmpProjectDir);
      expect(found).toBe(targetFile);
    });

    it('discovers fallback .jev.json in project root when .agents/jev.json is absent', () => {
      const targetFile = path.join(tmpProjectDir, '.jev.json');
      fs.writeFileSync(targetFile, JSON.stringify({ version: 2 }));

      const found = findProjectConfigFile(tmpProjectDir);
      expect(found).toBe(targetFile);
    });

    it('prioritizes .agents/jev.json over .jev.json if both exist', () => {
      const agentsDir = path.join(tmpProjectDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const primaryFile = path.join(agentsDir, 'jev.json');
      fs.writeFileSync(primaryFile, JSON.stringify({ version: 2, primary: true }));
      fs.writeFileSync(path.join(tmpProjectDir, '.jev.json'), JSON.stringify({ version: 2, primary: false }));

      const found = findProjectConfigFile(tmpProjectDir);
      expect(found).toBe(primaryFile);
    });

    it('searches upward from deep subdirectories to find root project config', () => {
      const agentsDir = path.join(tmpProjectDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const targetFile = path.join(agentsDir, 'jev.json');
      fs.writeFileSync(targetFile, JSON.stringify({ version: 2 }));

      const deepSubdir = path.join(tmpProjectDir, 'src', 'components', 'utils');
      fs.mkdirSync(deepSubdir, { recursive: true });

      const found = findProjectConfigFile(deepSubdir);
      expect(found).toBe(targetFile);
    });

    it('returns null if no project configuration exists in the directory tree', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-empty-'));
      try {
        const found = findProjectConfigFile(emptyDir);
        expect(found).toBeNull();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('Cognitive Tier Normalization (normalizeTier)', () => {
    it('normalizes free variants to "free"', () => {
      expect(normalizeTier('free')).toBe('free');
      expect(normalizeTier('openrouter_free')).toBe('free');
      expect(normalizeTier('OPENROUTER_FREE')).toBe('free');
      expect(normalizeTier('google/gemma-4-31b-it:free')).toBe('free');
    });

    it('normalizes cheap / lite variants to "cheap"', () => {
      expect(normalizeTier('cheap')).toBe('cheap');
      expect(normalizeTier('flash_lite')).toBe('cheap');
      expect(normalizeTier('haiku')).toBe('cheap');
      expect(normalizeTier('claude-3-5-haiku')).toBe('cheap');
      expect(normalizeTier('gemini-2.5-flash-lite')).toBe('cheap');
    });

    it('normalizes standard / flash variants to "standard"', () => {
      expect(normalizeTier('standard')).toBe('standard');
      expect(normalizeTier('flash')).toBe('standard');
      expect(normalizeTier('sonnet')).toBe('standard');
      expect(normalizeTier('claude-3-7-sonnet')).toBe('standard');
    });

    it('normalizes deep / pro / opus variants to "deep"', () => {
      expect(normalizeTier('deep')).toBe('deep');
      expect(normalizeTier('pro')).toBe('deep');
      expect(normalizeTier('opus')).toBe('deep');
      expect(normalizeTier('claude-3-opus')).toBe('deep');
      expect(normalizeTier('gemini-1.5-pro')).toBe('deep');
      expect(normalizeTier('expensive')).toBe('deep');
    });

    it('falls back to "standard" for unrecognized tier names', () => {
      expect(normalizeTier('custom_unknown_tier')).toBe('standard');
    });
  });

  describe('Cascading Precedence & Overrides (System -> User -> Project -> Level 5 Env)', () => {
    it('Level 1: System Defaults are populated correctly', () => {
      // Clear user config file to isolate defaults
      delete process.env.JEV_CONFIG_FILE;
      clearConfigCacheForTesting();

      const cfg = loadJevConfigSync(tmpProjectDir, true);
      expect(cfg.version).toBe(2);
      expect(cfg.tiers).toBeDefined();
      expect(cfg.tiers?.free.concurrencyCap).toBe(10);
      expect(cfg.tiers?.deep.requiresApproval).toBe(true);

      const agyModels = getHarnessModels('antigravity');
      expect(agyModels.cheap).toBe('flash_lite');
      expect(agyModels.standard).toBe('flash');
      expect(agyModels.deep).toBe('pro');

      const ccModels = getHarnessModels('claude-code');
      expect(ccModels.cheap).toBe('haiku');
      expect(ccModels.standard).toBe('sonnet');
      expect(ccModels.deep).toBe('opus');

      const openCodeModels = getHarnessModels('opencode');
      expect(openCodeModels.cheap).toBe('google/gemini-2.5-flash-lite');
      expect(openCodeModels.deep).toBe('anthropic/claude-3-7-sonnet');
    });

    it('Level 2: User Config (~/.config/jev/config.json) overrides system defaults', () => {
      fs.writeFileSync(
        tmpUserConfigFile,
        JSON.stringify({
          version: 2,
          timeouts: {
            decisionMs: 4200
          },
          harnesses: {
            antigravity: {
              models: {
                deep: 'gemini-3.1-pro-preview'
              }
            }
          }
        })
      );
      clearConfigCacheForTesting();

      const timeouts = getJevTimeouts('antigravity', tmpProjectDir);
      expect(timeouts.decisionMs).toBe(4200);
      expect(timeouts.fallbackMs).toBe(5000); // inherited from system default

      const agyModels = getHarnessModels('antigravity', tmpProjectDir);
      expect(agyModels.deep).toBe('gemini-3.1-pro-preview'); // overridden by user config
      expect(agyModels.cheap).toBe('flash_lite'); // inherited from system default
    });

    it('Level 3: Project Config (.agents/jev.json) overrides user config and system defaults', () => {
      fs.writeFileSync(
        tmpUserConfigFile,
        JSON.stringify({
          version: 2,
          timeouts: { decisionMs: 4000 }
        })
      );

      const agentsDir = path.join(tmpProjectDir, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'jev.json'),
        JSON.stringify({
          version: 2,
          timeouts: { decisionMs: 2500 },
          harnesses: {
            antigravity: {
              freePool: ['custom/repo-free-model:free'],
              models: {
                standard: 'custom-flash-override'
              }
            }
          }
        })
      );
      clearConfigCacheForTesting();

      const timeouts = getJevTimeouts('antigravity', tmpProjectDir);
      expect(timeouts.decisionMs).toBe(2500); // Project overrides user 4000

      const agyModels = getHarnessModels('antigravity', tmpProjectDir);
      expect(agyModels.standard).toBe('custom-flash-override');

      const pool = getFreeModelsPool('antigravity', tmpProjectDir);
      expect(pool).toEqual(['custom/repo-free-model:free']);
      expect(pool.length).toBe(1);
    });

    it('Level 5: Environment variables override project and user config at runtime', () => {
      fs.writeFileSync(
        tmpUserConfigFile,
        JSON.stringify({
          version: 2,
          timeouts: { decisionMs: 4000 }
        })
      );

      process.env.JEV_TIMEOUT_MS = '9999';
      process.env.JEV_FREE_MODEL = 'my-env-free-model:free';
      process.env.JEV_FREE_MODELS_POOL = 'pool1:free, pool2:free';
      clearConfigCacheForTesting();

      const timeouts = getJevTimeouts('antigravity', tmpProjectDir);
      expect(timeouts.decisionMs).toBe(9999);

      const agyModels = getHarnessModels('antigravity', tmpProjectDir);
      expect(agyModels.free).toBe('my-env-free-model:free');

      const pool = getFreeModelsPool('antigravity', tmpProjectDir);
      expect(pool).toEqual(['pool1:free', 'pool2:free']);
    });
  });

  describe('Cache Configuration Resolution (getCacheConfig)', () => {
    it('resolves default RAM tmpfs and disk fallback paths', () => {
      const cacheCfg = getCacheConfig(tmpProjectDir);
      expect(cacheCfg.ttlSec).toBe(300);
      expect(cacheCfg.shmPath).toBe('/dev/shm/jev/cache.sqlite');
      expect(cacheCfg.fallbackPath).toContain('.config/jev/cache.sqlite');
    });

    it('honors JEV_CACHE_TTL_MS environment variable', () => {
      process.env.JEV_CACHE_TTL_MS = '60000'; // 60 seconds
      clearConfigCacheForTesting();

      const cacheCfg = getCacheConfig(tmpProjectDir);
      expect(cacheCfg.ttlSec).toBe(60);
    });
  });
});
