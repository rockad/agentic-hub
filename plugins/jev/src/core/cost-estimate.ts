/**
 * The combined cost estimate of a delegation. Since 2.3.19 the same weights decide the cost gate (`cost-gate.ts`); the fields
 * below are still what is written on every `agent_call` row of both harnesses. It is an estimate of what the call REQUESTED, so a
 * denied call carries it too, and so does a row written in on-demand mode.
 *
 *   cost  = W_model[tier] * W_effort[level]
 *   ratio = cost(call) / cost(session)
 *
 * The weights are relative, not prices: a model tier's weight is how many `flash_lite` calls one call of it is worth, and an
 * effort level's weight is its share of the `medium` effort. The table is versioned (`COST_WEIGHTS_VERSION`, written on every
 * row as `costWeightsVersion`): a change of any weight bumps it, so rows written under different tables are never compared.
 *
 * Fields written on a row (see {@link costFields}):
 * - `costEstimate`: the call's cost, or null when its model cannot be placed in a tier;
 * - `sessionCost`: the session's own cost (2.3.19), the figure the cost gate compares against;
 * - `costRatio`: the call's cost over the session's, or null when either is unknown or the session's cost is 0;
 * - `costWeightsVersion`: the version of the table above;
 * - `servedModelExpected` (Antigravity rows only, 2.3.19): the model the call is expected to be SERVED on (`served-model.ts`); the call is priced by it.
 */

import { modelTierOf, type ModelTier } from './model-tier.js';
import { servedModelExpected } from './served-model.js';

/** The version of the weights table below. */
export const COST_WEIGHTS_VERSION = 1;

export type CostTier = ModelTier;
export type CostEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Model weights (version 1): free 0, flash_lite or haiku 1, flash or sonnet 3, pro or opus 15. */
export const MODEL_WEIGHTS: Readonly<Record<CostTier, number>> = { openrouter_free: 0, flash_lite: 1, flash: 3, pro: 15 };

/** Effort weights (version 1). */
export const EFFORT_WEIGHTS: Readonly<Record<CostEffort, number>> = { low: 0.5, medium: 1, high: 1.5, xhigh: 2, max: 3 };

/** The effort a call has when neither it nor the session names one. */
export const DEFAULT_COST_EFFORT: CostEffort = 'medium';

const isEffort = (v: unknown): v is CostEffort => typeof v === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_WEIGHTS, v);

/** `v` as an effort level when it is a literal one (`low` ... `max`, any case), else null (`higher`, `lower`, numbers, objects). */
export function costEffortOf(v: unknown): CostEffort | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return isEffort(s) ? s : null;
}

/** A trailing `-low`, `-medium`, `-high`, `-xhigh` or `-max` on a model id (how Antigravity serves one model at several efforts). */
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

/** The effort an Antigravity model id carries as its suffix, or null when it has none. */
export function effortFromModelId(model: unknown): CostEffort | null {
  const m = typeof model === 'string' ? EFFORT_SUFFIX_RE.exec(model.trim()) : null;
  return m ? (m[1].toLowerCase() as CostEffort) : null;
}

/**
 * The cost tier of a model id or alias, or null when nothing places it. It is `modelTierOf` (src/core/model-tier.ts, the
 * one tier table: free, `flash_lite` or `haiku`, `flash`, `hydrogen` or `sonnet`, and `pro`, `neon`, `argon`, `carbon`,
 * `opus` or `fable`). An effort suffix is ignored.
 */
export function costTierOf(model: unknown): CostTier | null {
  if (typeof model !== 'string') return null;
  return modelTierOf(model.trim().replace(EFFORT_SUFFIX_RE, ''));
}

/** The cost of one model at one effort, or null when the model has no tier. */
export function costOf(model: unknown, effort: CostEffort): number | null {
  const tier = costTierOf(model);
  return tier === null ? null : MODEL_WEIGHTS[tier] * EFFORT_WEIGHTS[effort];
}

export type CostSide = {
  /** The model; absent or `inherit` means the session's. */
  model?: unknown;
  /** The effort when it is known for this side (a literal level); absent means the session's. */
  effort?: unknown;
};

export type CostFields = {
  costEstimate: number | null;
  /** The session's own cost (its model at its effort), or null when its model has no tier (2.3.19). */
  sessionCost: number | null;
  costRatio: number | null;
  costWeightsVersion: number;
};

const isInherit = (m: unknown): boolean => typeof m !== 'string' || m.trim() === '' || m.trim().toLowerCase() === 'inherit';
const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The cost fields of a call against its session. A call with no model, or `inherit`, runs on the session model; a call with
 * no effort takes the session's, else `medium`. Never throws.
 */
export function costFields(call: CostSide, session: CostSide): CostFields {
  try {
    const sessionEffort = costEffortOf(session.effort) ?? DEFAULT_COST_EFFORT;
    const callModel = isInherit(call.model) ? session.model : call.model;
    const callEffort = costEffortOf(call.effort) ?? sessionEffort;
    const cost = costOf(callModel, callEffort);
    const base = costOf(session.model, sessionEffort);
    return {
      costEstimate: cost === null ? null : round(cost),
      sessionCost: base === null ? null : round(base),
      costRatio: cost === null || base === null || base === 0 ? null : round(cost / base),
      costWeightsVersion: COST_WEIGHTS_VERSION
    };
  } catch {
    return { costEstimate: null, sessionCost: null, costRatio: null, costWeightsVersion: COST_WEIGHTS_VERSION };
  }
}

/** The cost fields of an Antigravity call, and the model it is expected to be served on (2.3.19). */
export type AntigravityCostFields = CostFields & {
  /** The model the call is expected to be served on (`served-model.ts`: `pro` is Hydrogen at xhigh, `inherit` the parent's), or null when nothing is known. */
  servedModelExpected: string | null;
};

/**
 * The cost fields of an Antigravity call, priced by the model it is expected to be SERVED on, not by the name of its `Model`
 * enum value (2.3.19, `served-model.ts`, verified on Antigravity 1.5.14): `Model: "pro"` costs as Hydrogen at xhigh (flash weight
 * times 2), `flash` as Hydrogen at high, `flash_lite` as flash-lite, and `inherit` or no model as the parent's own model.
 *
 * The effort of the session is the suffix of its model id (`-low` ... `-xhigh`), else `medium`. The effort of the call is the
 * served model's (the table's, else its id's suffix), else the session's own (a model that carries none runs at the session's,
 * and the cost gate holds the call to the same figure, so `costRatio > 1` is exactly the calls it holds). The requested
 * `Model` is still what the row's `requestedModel` says; `servedModelExpected` is added beside it. Never throws.
 */
export function antigravityCostFields(requestedModel: unknown, sessionModel: unknown): AntigravityCostFields {
  const sessionEffort = effortFromModelId(sessionModel) ?? DEFAULT_COST_EFFORT;
  const served = servedModelExpected(requestedModel, sessionModel);
  const callModel = served.servedModel ?? (isInherit(requestedModel) ? sessionModel : requestedModel);
  const callEffort = served.effort ?? sessionEffort;
  return {
    ...costFields({ model: callModel, effort: callEffort }, { model: sessionModel, effort: sessionEffort }),
    servedModelExpected: served.servedModel
  };
}
