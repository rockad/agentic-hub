import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  modelTierRank,
  clampTierToSessionCeiling
} from '../src/core/governance.js';
import {
  detectActiveHarness,
  getHarnessModels,
  clearConfigCacheForTesting
} from '../src/core/config.js';

describe('Governance & Harness Model Tier Ranking (Argon, Fable, Antigravity)', () => {
  const originalEnv = { ...process.env };

  const HARNESS_ENV_VARS = [
    'JEV_HARNESS',
    'ANTIGRAVITY_AGENT',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_LS_VERSION',
    'ANTIGRAVITY_CONVERSATION_ID',
    'ANTIGRAVITY_PROJECT_ID',
    'ANTIGRAVITY_CLI',
    'GEMINI_CLI',
    'CLAUDE_CODE',
    'CLAUDECODE',
    'CLAUDE_PROJECT_DIR',
    'OPENCODE_SESSION',
    'OPENCODE_HOME',
    'CORTEX_SESSION'
  ];

  beforeEach(() => {
    for (const v of HARNESS_ENV_VARS) {
      delete process.env[v];
    }
    clearConfigCacheForTesting();
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env = { ...originalEnv };
  });

  describe('modelTierRank with Argon and Fable models', () => {
    it('ranks Gemini 4 Argon (Medium) and (High) as Tier 3 (pro)', () => {
      expect(modelTierRank('Gemini 4 Argon (Medium)')).toBe(3);
      expect(modelTierRank('Gemini 4 Argon (High)')).toBe(3);
      expect(modelTierRank('gemini-argon')).toBe(3);
    });

    it('ranks Fable models as Tier 3 (pro)', () => {
      expect(modelTierRank('fable')).toBe(3);
      expect(modelTierRank('claude-fable-5-1')).toBe(3);
    });

    it('ranks deep / pro / opus / expensive models as Tier 3', () => {
      expect(modelTierRank('pro')).toBe(3);
      expect(modelTierRank('opus')).toBe(3);
      expect(modelTierRank('deep')).toBe(3);
      expect(modelTierRank('expensive')).toBe(3);
    });

    it('preserves flash (2), flash_lite (1), and openrouter_free (0) rankings', () => {
      expect(modelTierRank('openrouter_free')).toBe(0);
      expect(modelTierRank('free')).toBe(0);
      expect(modelTierRank('flash_lite')).toBe(1);
      expect(modelTierRank('flash-lite')).toBe(1);
      expect(modelTierRank('flash')).toBe(2);
      expect(modelTierRank('standard')).toBe(2);
    });
  });

  describe('clampTierToSessionCeiling with Argon session model', () => {
    it('permits pro tier when activeModel is Gemini 4 Argon (Medium)', () => {
      const res = clampTierToSessionCeiling('pro', 'Gemini 4 Argon (Medium)');
      expect(res.wasClamped).toBe(false);
      expect(res.clampedTier).toBe('pro');
      expect(res.ceilingTier).toBe('pro');
    });

    it('permits flash tier when activeModel is Gemini 4 Argon (Medium)', () => {
      const res = clampTierToSessionCeiling('flash', 'Gemini 4 Argon (Medium)');
      expect(res.wasClamped).toBe(false);
      expect(res.clampedTier).toBe('flash');
      expect(res.ceilingTier).toBe('pro');
    });

    it('clamps pro tier to flash when activeModel is Gemini 2.5 Flash without explicit override', () => {
      const res = clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'Port CLI tool');
      expect(res.wasClamped).toBe(true);
      expect(res.clampedTier).toBe('flash');
      expect(res.ceilingTier).toBe('flash');
    });

    it('honours explicit pro override mentioning argon in prompt', () => {
      const res = clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'Deep reasoning task using argon');
      expect(res.wasClamped).toBe(false);
      expect(res.clampedTier).toBe('pro');
      expect(res.ceilingTier).toBe('flash');
    });
  });

  describe('detectActiveHarness & getHarnessModels with Antigravity environment', () => {
    it('returns antigravity when ANTIGRAVITY_AGENT=1 and resolves Antigravity models', () => {
      process.env.ANTIGRAVITY_AGENT = '1';

      expect(detectActiveHarness()).toBe('antigravity');
      expect(getHarnessModels()).toEqual({
        free: 'openrouter/free',
        cheap: 'flash_lite',
        standard: 'flash',
        deep: 'pro'
      });
    });

    it('returns antigravity when ANTIGRAVITY_APP_DATA_DIR is set and resolves Antigravity models', () => {
      process.env.ANTIGRAVITY_APP_DATA_DIR = '/home/rockad/.gemini/antigravity-cli';

      expect(detectActiveHarness()).toBe('antigravity');
      expect(getHarnessModels()).toEqual({
        free: 'openrouter/free',
        cheap: 'flash_lite',
        standard: 'flash',
        deep: 'pro'
      });
    });
  });
});
