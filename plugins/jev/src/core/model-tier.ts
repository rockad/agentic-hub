/**
 * The one place a model id or alias is placed in a tier (2.3.18). `costTierOf` (cost-estimate.ts), `modelTierRank`
 * (governance.ts) and `normalizeTier` (config.ts) are views of {@link modelTierOf}. The Antigravity subagent-model check
 * (`isRecognisedSubagentModel`) is a separate prefix pattern (the aliases, or an id starting with a known family name),
 * not built on the table; a test (tests/model-tier-table.test.ts) asserts that it agrees with {@link modelTierOf} over the
 * whole Antigravity 1.5.14 catalogue, which is what keeps the two together, so a new family has to be added to both.
 *
 * The table:
 *
 * | tier              | ids and words                                                                                   |
 * | ----------------- | ----------------------------------------------------------------------------------------------- |
 * | `openrouter_free` | the whole word `free` (`openrouter/free`, `openrouter_free`, `<model>:free`, `free`)             |
 * | `flash_lite`      | `flash_lite` / `flash-lite` / `flash lite`, `haiku`                                              |
 * | `flash`           | `flash`, `hydrogen`, `sonnet`                                                                    |
 * | `pro`             | the whole words `pro`, `neon`, `argon`, `carbon`; `opus`, `fable`                                |
 *
 * Matching rules (checked in the order of the table, first hit wins):
 * - `opus`, `sonnet`, `haiku`, `fable`, `hydrogen` and `flash` are distinctive enough to match as substrings, which is how
 *   they always matched (`opusplan`, `sonnet[1m]`, `claude-3-5-haiku-20241022` keep their tier, so Claude Code ids do not move).
 * - `pro`, `free`, `neon`, `argon` and `carbon` match only as whole words (the id is split on anything that is not a letter
 *   or a digit), so `jargon`, `provider`, `professional`, `carefree` and `neonate` are not placed by them.
 * - An effort suffix (`-low`, `-medium`, `-high`, `-xhigh`, `-max`) is just another word and never decides the tier.
 *
 * Unknown ids (for example `gpt-oss-120b-medium`) have no tier: {@link modelTierOf} returns null. The consumers then
 * behave as before 2.3.18: `costTierOf` is null (no cost estimate), `modelTierRank` is 2 (flash), `normalizeTier` is
 * `standard`, and the subagent-model check does not recognise the id.
 */

export type ModelTier = 'openrouter_free' | 'flash_lite' | 'flash' | 'pro';

/** The lowercase words of an id: split on anything that is not a letter or a digit (so `gemini-4-neon-high` has `neon`). */
export function modelWords(model: string): string[] {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** The model families the tier table and the Orchestrator roles are built from. */
export type ModelFamily = 'neon' | 'argon' | 'carbon' | 'opus' | 'fable' | 'hydrogen' | 'sonnet' | 'haiku' | 'flash' | 'pro';

/** The first family an id names, or null. Distinctive names match as substrings, the short ones as whole words. */
export function modelFamilyOf(model: unknown): ModelFamily | null {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  const words = modelWords(id);
  const has = (w: string): boolean => words.includes(w);
  // Order matters only where one id could name two families; `flash_lite` is a flash-family id placed one tier lower below.
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('hydrogen')) return 'hydrogen';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('flash')) return 'flash';
  if (id.includes('opus')) return 'opus';
  if (id.includes('fable')) return 'fable';
  if (has('neon')) return 'neon';
  if (has('argon')) return 'argon';
  if (has('carbon')) return 'carbon';
  if (has('pro')) return 'pro';
  return null;
}

const FREE_WORD = 'free';
const FLASH_LITE_RE = /flash[-_ ]?lite/;

/** The tier of a model id or alias, or null when nothing places it (see the table in the file header). */
export function modelTierOf(model: unknown): ModelTier | null {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (modelWords(id).includes(FREE_WORD)) return 'openrouter_free';
  if (FLASH_LITE_RE.test(id) || id.includes('haiku')) return 'flash_lite';
  const family = modelFamilyOf(id);
  if (family === null) return null;
  switch (family) {
    case 'haiku':
      return 'flash_lite';
    case 'hydrogen':
    case 'sonnet':
    case 'flash':
      return 'flash';
    default:
      return 'pro';
  }
}

export const MODEL_TIER_RANK: Readonly<Record<ModelTier, number>> = { openrouter_free: 0, flash_lite: 1, flash: 2, pro: 3 };

/**
 * The rank of a model id, or of a tier alias (`cheap` and `standard` are 2, `expensive` and `deep` are 3). An id nothing
 * places ranks 2 (flash), as it always did.
 */
export function modelRankOf(tierOrModel: string): number {
  const t = (tierOrModel || '').toLowerCase();
  const tier = modelTierOf(t);
  if (tier !== null) return MODEL_TIER_RANK[tier];
  const words = modelWords(t);
  if (words.includes('cheap') || words.includes('standard')) return 2;
  if (words.includes('expensive') || t === 'deep') return 3;
  return 2;
}

/**
 * Is this id a model the Antigravity subagent `Model` field (and a workflow script literal) can name and Jev can rank: the
 * aliases `flash_lite`, `flash-lite`, `flash` and `pro`, or an id of the `gemini`, `claude`, `hydrogen`, `argon`, `neon`
 * or `carbon` families. Every id of the Antigravity 1.5.14 catalogue that has a tier is recognised, and `gpt-oss-120b-*`
 * (no tier) is not.
 */
export function isRecognisedSubagentModel(model: string): boolean {
  return /^(?:flash_lite|flash-lite|flash|pro)$/i.test(model) || /^(?:gemini|claude|hydrogen|argon|neon|carbon)/i.test(model);
}
