/**
 * The model Antigravity actually serves for the `Model` of an `invoke_subagent` call (2.3.19).
 *
 * Verified live on Antigravity 1.5.14 ({@link ANTIGRAVITY_SERVED_VERIFIED_ON}): `Model` is an enum, `inherit | flash_lite | flash |
 * pro`, and the enum is not a quality ladder. Under EVERY parent session the three named values are served as
 *
 * | `Model`      | served model                    | effort |
 * | ------------ | ------------------------------- | ------ |
 * | `flash_lite` | `gemini-3.5-flash-lite`         | none   |
 * | `flash`      | `gemini-4-hydrogen-tiered-high` | high   |
 * | `pro`        | `gemini-4-hydrogen-tiered-xhigh`| xhigh  |
 *
 * so `pro` is Gemini 4 Hydrogen at xhigh, a flash-class model, never Argon, Neon or Opus. `inherit` (or an omitted `Model`) is
 * served on the PARENT's model (plain Argon `gemini-4-argon-high`, plain Neon `gemini-4-neon-xhigh`, plain Opus
 * `claude-opus-5-5-high`; an Orchestrator planner turn, the planner). So the only way to run a subagent on Argon is a session
 * that is itself on Gemini 4 Argon, with `Model` `inherit`.
 *
 * What this file is for: the cost gate and the cost fields price a call by the model it is expected to be SERVED on, not by the
 * name of the enum value (`Model: "pro"` costs as Hydrogen at xhigh, flash weight times 2). It is a table of what was observed,
 * not something Antigravity promises: when a later version serves differently, change the table (and the version above) and
 * the `subagent_served` rows (`requestedModel` against `servedModel`) are the evidence to do it from.
 *
 * Claude Code does not use any of this: it serves the model it is asked for, so its cost is the requested model's.
 *
 * Nothing here reads a file, an environment variable or the clock.
 */

import type { CostEffort } from './cost-estimate.js';
import { MODEL_TIER_RANK, modelTierOf, type ModelTier } from './model-tier.js';

/** The Antigravity version the table below was verified on. */
export const ANTIGRAVITY_SERVED_VERIFIED_ON = '1.5.14';

export type SubagentEnum = 'flash_lite' | 'flash' | 'pro';

/** What a named `Model` value is served as (verified on {@link ANTIGRAVITY_SERVED_VERIFIED_ON}). `effort` null: the id carries none. */
export const SERVED_BY_ENUM: Readonly<Record<SubagentEnum, { servedModel: string; effort: CostEffort | null }>> = {
  flash_lite: { servedModel: 'gemini-3.5-flash-lite', effort: null },
  flash: { servedModel: 'gemini-4-hydrogen-tiered-high', effort: 'high' },
  pro: { servedModel: 'gemini-4-hydrogen-tiered-xhigh', effort: 'xhigh' }
};

/** The enum values, cheapest first. */
export const SUBAGENT_ENUM_ORDER: readonly SubagentEnum[] = ['flash_lite', 'flash', 'pro'];

/** The enum value a `Model` string names (`flash-lite` is `flash_lite`; any case), or null when it is not one (a full id, `inherit`, nothing). */
export function subagentEnumOf(model: unknown): SubagentEnum | null {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (m === 'flash_lite' || m === 'flash-lite') return 'flash_lite';
  if (m === 'flash') return 'flash';
  if (m === 'pro') return 'pro';
  return null;
}

/** A trailing effort level of a model id (the same suffix `effortFromModelId` in cost-estimate.ts reads; kept here so cost-estimate.ts can import this file without a cycle). */
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;
const effortFromModelId = (model: string): CostEffort | null => {
  const m = EFFORT_SUFFIX_RE.exec(model.trim());
  return m ? (m[1].toLowerCase() as CostEffort) : null;
};

const isInherit = (m: unknown): boolean => typeof m !== 'string' || m.trim() === '' || m.trim().toLowerCase() === 'inherit';

export type ServedExpectation = {
  /** `enum`: a named value, served as the table says. `parent`: `inherit` or omitted, served on the parent's model. `as-requested`: not an enum value (a full id), taken as written. */
  kind: 'enum' | 'parent' | 'as-requested';
  /** The model the call is expected to be served on, or null when nothing is known (no parent model for an `inherit`). */
  servedModel: string | null;
  /** The effort it is expected to run at: the table's, else the id's suffix, else null (the caller decides). */
  effort: CostEffort | null;
  /** The tier of {@link servedModel}, or null. */
  tier: ModelTier | null;
};

/**
 * Pure: the model a `Model` value is expected to be served on, under a parent session on `parentModel`.
 * `inherit` or an omitted value is the parent's own model; the three enum values are the table's; anything else is itself.
 */
export function servedModelExpected(requested: unknown, parentModel: unknown): ServedExpectation {
  if (isInherit(requested)) {
    const parent = typeof parentModel === 'string' && parentModel.trim() !== '' ? parentModel.trim() : null;
    return { kind: 'parent', servedModel: parent, effort: parent === null ? null : effortFromModelId(parent), tier: parent === null ? null : modelTierOf(parent) };
  }
  const e = subagentEnumOf(requested);
  if (e !== null) {
    const row = SERVED_BY_ENUM[e];
    return { kind: 'enum', servedModel: row.servedModel, effort: row.effort, tier: modelTierOf(row.servedModel) };
  }
  const as = String(requested).trim();
  return { kind: 'as-requested', servedModel: as, effort: effortFromModelId(as), tier: modelTierOf(as) };
}

/** The tier a `Model` value NAMES (what the agent asked for in the words of the enum): `pro` is `pro`, even though it is served as flash class. */
export function requestedTierOf(requested: unknown): ModelTier | null {
  const e = subagentEnumOf(requested);
  return e === null ? modelTierOf(requested) : e;
}

/** The enum value whose served cost fits: the most expensive of `candidates` for which `fits` holds, else null. */
export function highestEnumWhere(fits: (e: SubagentEnum) => boolean): SubagentEnum | null {
  let best: SubagentEnum | null = null;
  for (const e of SUBAGENT_ENUM_ORDER) if (fits(e)) best = e;
  return best;
}

/** `gemini-4-hydrogen-tiered-xhigh` as a person says it: `Gemini 4 Hydrogen (xhigh)`. Any other id is returned as written. */
export function servedModelLabel(model: string): string {
  const m = /^gemini-4-(hydrogen|argon|neon|carbon)(?:-tiered)?(?:-(low|medium|high|xhigh|max))?$/i.exec(model.trim());
  if (!m) return model;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const effort = m[2] ? m[2].toLowerCase() : null;
  return `Gemini 4 ${family}${effort ? ` (${effort})` : ''}`;
}

/** The family class word of a tier, for a sentence: `flash class`. */
const classOf = (tier: ModelTier | null): string => (tier === null ? 'unranked' : `${tier === 'openrouter_free' ? 'free' : tier} class`);

/** The one sentence every Antigravity text uses to say what `pro` really is. */
export const PRO_SERVED_SENTENCE = `Model "pro" runs on Gemini 4 Hydrogen (xhigh), a flash-class model, not on Argon, Neon or Opus.`;

/** The one sentence that says how to get a subagent on Argon. */
export const ARGON_HOW_SENTENCE = `A subagent on Argon needs the session itself on Gemini 4 Argon, with Model "inherit".`;

/**
 * What an Antigravity text says about the model a named `Model` really gets: the served model and its class, then, for `pro`,
 * how to reach Argon instead. Empty for a value that is not an enum value (a full id is served as written).
 */
export function servedModelGuidance(requested: unknown): string {
  const e = subagentEnumOf(requested);
  if (e === null) return '';
  const row = SERVED_BY_ENUM[e];
  const tier = modelTierOf(row.servedModel);
  const base = `Model "${e}" is served on ${servedModelLabel(row.servedModel)}, ${classOf(tier)}.`;
  return e === 'pro' ? `${PRO_SERVED_SENTENCE} ${ARGON_HOW_SENTENCE}` : base;
}

export type ServedBelowRequested = {
  requested: string;
  requestedTier: ModelTier;
  servedModel: string;
  servedTier: ModelTier;
};

/**
 * Pure: whether the model a subagent was SERVED on is of a lower tier than the one its `Model` named. Null when it is not (equal
 * or higher), when `Model` was `inherit` or omitted (the parent's model was asked for and is what is served), or when either tier
 * cannot be placed.
 */
export function servedBelowRequested(requested: unknown, servedModel: unknown): ServedBelowRequested | null {
  if (isInherit(requested) || typeof servedModel !== 'string' || servedModel.trim() === '') return null;
  const asked = requestedTierOf(requested);
  const got = modelTierOf(servedModel);
  if (asked === null || got === null) return null;
  if (MODEL_TIER_RANK[got] >= MODEL_TIER_RANK[asked]) return null;
  return { requested: String(requested).trim().toLowerCase(), requestedTier: asked, servedModel: servedModel.trim(), servedTier: got };
}

/**
 * The one short line the user sees when a subagent was served below what its `Model` named, for example
 * `[jev] Subagent asked for pro, served on gemini-4-hydrogen-tiered-xhigh (flash class). For Argon, run the session on Gemini 4 Argon and use Model: inherit.`
 */
export function servedBelowNotice(b: ServedBelowRequested): string {
  const how = b.requestedTier === 'pro' ? ' For Argon, run the session on Gemini 4 Argon and use Model: inherit.' : '';
  return `[jev] Subagent asked for ${b.requested}, served on ${b.servedModel} (${classOf(b.servedTier)}).${how}`;
}

/**
 * The short phrase the elevation question carries so the user decides on what the call really is: `Model "pro" is served on
 * Gemini 4 Hydrogen (xhigh), flash class`. Empty for a value that is not an enum value.
 */
export function servedQuestionPhrase(requested: unknown): string {
  const e = subagentEnumOf(requested);
  if (e === null) return '';
  const row = SERVED_BY_ENUM[e];
  return `Model "${e}" is served on ${servedModelLabel(row.servedModel)}, ${classOf(modelTierOf(row.servedModel))}`;
}
