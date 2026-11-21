/**
 * One tier table (2.3.18): costTierOf, modelTierRank, normalizeTier and the Antigravity subagent-model check are all views
 * of modelTierOf (src/core/model-tier.ts), so they agree on every id of the Antigravity 1.5.14 catalogue.
 */
import { describe, it, expect } from 'bun:test';
import { costTierOf, costFields, antigravityCostFields, effortFromModelId, MODEL_WEIGHTS } from '../src/core/cost-estimate.ts';
import { modelTierRank, rankToTierName } from '../src/core/governance.ts';
import { normalizeTier, type CognitiveTier } from '../src/core/config.ts';
import { isRecognisedSubagentModel, modelTierOf, modelFamilyOf, type ModelTier } from '../src/core/model-tier.ts';

const EFFORTS3 = ['low', 'medium', 'high'] as const;
const withEfforts = (stem: string, efforts: readonly string[] = EFFORTS3): string[] => efforts.map((e) => `${stem}-${e}`);

/** The full Antigravity 1.5.14 catalogue and the tier each id belongs to (null: no tier, an unknown id). */
const CATALOGUE: Array<[string, ModelTier | null]> = [
  ...withEfforts('gemini-4-neon', ['low', 'medium', 'high', 'xhigh']).map((m): [string, ModelTier] => [m, 'pro']),
  ...withEfforts('gemini-4-argon').map((m): [string, ModelTier] => [m, 'pro']),
  ...withEfforts('gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']).map((m): [string, ModelTier] => [m, 'flash']),
  ...withEfforts('gemini-3.8-flash').map((m): [string, ModelTier] => [m, 'flash']),
  ...withEfforts('claude-opus-5-5').map((m): [string, ModelTier] => [m, 'pro']),
  ...withEfforts('claude-sonnet-5-5').map((m): [string, ModelTier] => [m, 'flash']),
  ['gpt-oss-120b-medium', null],
  ...withEfforts('gemini-4-carbon').map((m): [string, ModelTier] => [m, 'pro'])
];

const RANK: Record<ModelTier, number> = { openrouter_free: 0, flash_lite: 1, flash: 2, pro: 3 };
const COGNITIVE: Record<ModelTier, CognitiveTier> = { openrouter_free: 'free', flash_lite: 'cheap', flash: 'standard', pro: 'deep' };

describe('the catalogue', () => {
  it('has every 1.5.14 id (24 of them)', () => {
    // neon 4, argon 3, hydrogen 4, gemini-3.8-flash 3, opus 3, sonnet 3, gpt-oss 1, carbon 3
    expect(CATALOGUE.length).toBe(24);
  });
});

describe('all four functions agree over the catalogue', () => {
  for (const [id, tier] of CATALOGUE) {
    it(id, () => {
      expect(modelTierOf(id)).toBe(tier);
      expect(costTierOf(id)).toBe(tier);
      if (tier) {
        expect(modelTierRank(id)).toBe(RANK[tier]);
        expect(rankToTierName(modelTierRank(id))).toBe(tier);
        expect(normalizeTier(id)).toBe(COGNITIVE[tier]);
        expect(isRecognisedSubagentModel(id)).toBe(true);
      } else {
        // An unknown id behaves as it did before 2.3.18: no cost tier, rank flash, cognitive tier standard, not recognised.
        expect(modelTierRank(id)).toBe(2);
        expect(normalizeTier(id)).toBe('standard');
        expect(isRecognisedSubagentModel(id)).toBe(false);
      }
    });
  }
});

describe('the aliases agree too', () => {
  const ALIASES: Array<[string, ModelTier]> = [
    ['pro', 'pro'],
    ['opus', 'pro'],
    ['fable', 'pro'],
    ['neon', 'pro'],
    ['argon', 'pro'],
    ['carbon', 'pro'],
    ['Orchestrator (Argon)', 'pro'],
    ['gemini-pro-orchestrator-g1-pro', 'pro'],
    ['flash', 'flash'],
    ['sonnet', 'flash'],
    ['hydrogen', 'flash'],
    ['Gemini 4 Hydrogen (Medium)', 'flash'],
    ['gemini-flash-worker-agy', 'flash'],
    ['flash_lite', 'flash_lite'],
    ['flash-lite', 'flash_lite'],
    ['haiku', 'flash_lite'],
    ['claude-haiku-4-5', 'flash_lite'],
    ['free', 'openrouter_free'],
    ['openrouter_free', 'openrouter_free'],
    ['openrouter/free', 'openrouter_free'],
    ['google/gemma-4-31b-it:free', 'openrouter_free']
  ];
  for (const [id, tier] of ALIASES) {
    it(id, () => {
      expect(costTierOf(id)).toBe(tier);
      expect(modelTierRank(id)).toBe(RANK[tier]);
      expect(normalizeTier(id)).toBe(COGNITIVE[tier]);
    });
  }

  it('the tier aliases keep their old ranks', () => {
    expect(modelTierRank('cheap')).toBe(2);
    expect(modelTierRank('standard')).toBe(2);
    expect(modelTierRank('expensive')).toBe(3);
    expect(modelTierRank('deep')).toBe(3);
    expect(modelTierRank('')).toBe(2);
    expect(normalizeTier('cheap')).toBe('cheap');
    expect(normalizeTier('lite')).toBe('cheap');
    expect(normalizeTier('deep')).toBe('deep');
    expect(normalizeTier('expensive')).toBe('deep');
    expect(normalizeTier('standard')).toBe('standard');
    expect(normalizeTier('')).toBe('standard');
  });
});

describe('word boundaries', () => {
  it('"pro", "free", "argon", "neon" and "carbon" inside other words place nothing', () => {
    for (const id of ['provider', 'professional', 'jargon', 'Argonaut', 'neonate', 'carbonara', 'carefree', 'freeform', 'improve']) {
      expect(modelTierOf(id)).toBeNull();
      expect(costTierOf(id)).toBeNull();
      expect(modelTierRank(id)).toBe(2);
      expect(normalizeTier(id)).toBe('standard');
    }
  });

  it('as whole words they do place', () => {
    expect(costTierOf('gemini-3.1-pro-preview')).toBe('pro');
    expect(costTierOf('gemini pro (high)')).toBe('pro');
    expect(costTierOf('gemini-4-carbon')).toBe('pro');
    expect(costTierOf('a/b:free')).toBe('openrouter_free');
  });

  it('distinctive Claude names still match as substrings (opusplan, sonnet[1m], dated ids)', () => {
    expect(costTierOf('opusplan')).toBe('pro');
    expect(costTierOf('sonnet[1m]')).toBe('flash');
    expect(costTierOf('claude-3-5-haiku-20241022')).toBe('flash_lite');
    expect(modelTierRank('opus[1m]')).toBe(3);
  });

  it('families', () => {
    expect(modelFamilyOf('gemini-4-neon-high')).toBe('neon');
    expect(modelFamilyOf('claude-opus-5-5-low')).toBe('opus');
    expect(modelFamilyOf('Gemini 4 Hydrogen (Medium)')).toBe('hydrogen');
    expect(modelFamilyOf('gpt-oss-120b-medium')).toBeNull();
    expect(modelFamilyOf(42)).toBeNull();
  });
});

describe('cost estimate for the 1.5.14 ids', () => {
  it('max is an effort suffix', () => {
    expect(effortFromModelId('gemini-4-neon-max')).toBe('max');
    expect(effortFromModelId('gemini-4-neon-xhigh')).toBe('xhigh');
    expect(costTierOf('gemini-4-neon-max')).toBe('pro');
  });

  it('costEstimate and costRatio are not null for argon, hydrogen and neon (T26)', () => {
    for (const id of ['gemini-4-argon-high', 'gemini-4-hydrogen-medium', 'gemini-4-neon-xhigh', 'gemini-4-carbon-low']) {
      const f = antigravityCostFields(id, 'gemini-3.8-flash-medium');
      expect(f.costEstimate).not.toBeNull();
      expect(f.costRatio).not.toBeNull();
    }
    expect(antigravityCostFields('gemini-4-argon-medium', 'gemini-4-hydrogen-medium').costRatio).toBe(MODEL_WEIGHTS.pro / MODEL_WEIGHTS.flash);
    // a session on one of them has a ratio for an ordinary flash call too
    expect(antigravityCostFields('flash', 'gemini-4-argon-high').costRatio).not.toBeNull();
    expect(costFields({ model: 'gemini-4-hydrogen-high' }, { model: 'gemini-4-hydrogen-high' }).costRatio).toBe(1);
  });

  it('an unknown id still has no estimate', () => {
    expect(antigravityCostFields('gpt-oss-120b-medium', 'gemini-4-hydrogen-medium').costEstimate).toBeNull();
  });
});
