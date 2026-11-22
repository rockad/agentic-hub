/**
 * The ONE cost gate of a subagent delegation (2.3.19), shared by both harnesses so they cannot diverge. It replaces the two
 * separate checks (the model ceiling by rank, and the interim effort rule for `xhigh` / `max`) wherever the cost of a call can
 * be computed. The weights are those of `cost-estimate.ts` (`cost = MODEL_WEIGHTS[tier] * EFFORT_WEIGHTS[effort]`, version 1).
 *
 * The rule: a delegation needs approval only when its cost is above the session's own, that is `costRatio > 1`
 * (the cost of the call over the cost of the session's model at the session's effort).
 *
 * - Session opus at high (22.5): sonnet at max (9) passes, opus at xhigh (30) needs approval, opus at high passes.
 * - When the cost cannot be computed (a model with no tier, no known session model, an effort that is not a literal level, a
 *   session whose own cost is 0) the verdict is `fallback`: the caller keeps the rules that existed before 2.3.19 for that call
 *   (the model ceiling by rank, the interim effort rule). It never means "allow".
 * - What the user said in the prompt raises the baseline the call is held to (`allowed`): a model the user named is a model
 *   the call may run on (at the session's effort), an effort the user named is an effort it may run at (on the session's model).
 *
 * Nothing here reads a file, an environment variable or the clock.
 */

import { servedModelExpected, subagentEnumOf, highestEnumWhere, SERVED_BY_ENUM, type SubagentEnum } from './served-model.js';
import {
  DEFAULT_COST_EFFORT,
  EFFORT_WEIGHTS,
  MODEL_WEIGHTS,
  costEffortOf,
  costOf,
  costTierOf,
  effortFromModelId,
  type CostEffort
} from './cost-estimate.js';

/** The effort levels, lowest first. */
export const EFFORT_ORDER: readonly CostEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The position of a level in {@link EFFORT_ORDER}. */
export const effortIndex = (e: CostEffort): number => EFFORT_ORDER.indexOf(e);

/** The effort a model approval recorded before 2.3.19 (it names none) stands for: that model at this effort or lower. */
export const LEGACY_APPROVAL_EFFORT: CostEffort = 'high';

/** The highest effort a "No" option re-invokes at: never above this, whatever fits the cost. */
export const NO_EFFORT_CAP: CostEffort = 'high';

/** The effort an approval stands for: its own when it records one, else {@link LEGACY_APPROVAL_EFFORT}. */
export function approvalEffortOf(approval: { effort?: unknown }): CostEffort {
  return costEffortOf(approval.effort) ?? LEGACY_APPROVAL_EFFORT;
}

/** Does an approval for `approved` cover a call at `needed`? The same level or a lower one, never a higher one. */
export function effortWithin(approved: CostEffort, needed: CostEffort): boolean {
  return effortIndex(approved) >= effortIndex(needed);
}

/** One side of the comparison: a model (any id or alias) and an effort (null when it is not a literal level). */
export type GateSide = { model: unknown; effort: CostEffort | null };

/** What the user's own words allow: a model, and an effort level, the call may use over the session's. */
export type GateAllowance = { model?: unknown; effort?: CostEffort | null };

export type FallbackWhy =
  | 'unknown-model'
  | 'unknown-session-model'
  | 'unknown-effort'
  | 'unknown-session-effort'
  | 'zero-baseline';

export type CostGate =
  /** The cost cannot be computed: keep the pre-2.3.19 rules for this call. */
  | { kind: 'fallback'; why: FallbackWhy }
  | ({ kind: 'pass' } & CostGateFacts)
  | ({
      kind: 'over';
      /** `model`: the call's model weighs more than the baseline model (the model question). `effort`: only the effort pushes it over. */
      cause: 'model' | 'effort';
      /** The highest effort, at most `high`, at which the call's own model stays within the baseline cost (the effort "No" option). */
      noEffort: CostEffort;
      /** The effort a clamp runs the call at: the call's own effort lowered to the highest level that fits on the clamp model. */
      clampEffort: CostEffort;
      /** True when the clamp also changes the model (to the baseline's). */
      clampModel: boolean;
    } & CostGateFacts);

export type CostGateFacts = {
  callModel: unknown;
  callEffort: CostEffort;
  callCost: number;
  /** The session's own cost (its model at its effort). */
  sessionCost: number;
  /** The cost the call is held to: the session's, or the raised baseline when the user's words allow more. Equals `sessionCost` without an allowance. */
  limit: number;
  /** The model and effort of the baseline, for the reason text. */
  baselineModel: unknown;
  baselineEffort: CostEffort;
  sessionEffort: CostEffort;
  /** `callCost / limit`. */
  ratio: number;
};

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The cost of a model at an effort, or null when the model has no tier. */
function costAt(model: unknown, effort: CostEffort): number | null {
  return costOf(model, effort);
}

/** The highest effort at which `model` costs at most `limit` and is at most `cap`; null when even `low` costs more. */
export function highestEffortWithin(model: unknown, limit: number, cap: CostEffort = 'max'): CostEffort | null {
  let best: CostEffort | null = null;
  for (const e of EFFORT_ORDER) {
    if (effortIndex(e) > effortIndex(cap)) break;
    const c = costAt(model, e);
    if (c !== null && c <= limit) best = e;
  }
  return best;
}

/** The weight of a model's tier, or null when it has none. */
function modelWeight(model: unknown): number | null {
  const tier = costTierOf(model);
  return tier === null ? null : MODEL_WEIGHTS[tier];
}

/**
 * Pure: the verdict for one delegation. `call.effort` and `session.effort` are literal levels or null (null: unknown, so the
 * verdict is a fallback). A call whose model is absent or `inherit` should be passed with the session's model.
 */
export function evaluateCostGate(call: GateSide, session: GateSide, allowed: GateAllowance = {}, floor?: GateSide): CostGate {
  const callWeight = modelWeight(call.model);
  if (callWeight === null) return { kind: 'fallback', why: 'unknown-model' };
  const sessionWeight = modelWeight(session.model);
  if (sessionWeight === null) return { kind: 'fallback', why: 'unknown-session-model' };
  if (session.effort === null) return { kind: 'fallback', why: 'unknown-session-effort' };
  if (call.effort === null) return { kind: 'fallback', why: 'unknown-effort' };

  // The baseline: the session's model at its effort, each raised to what the user's own words allow.
  const allowedWeight = allowed.model === undefined ? null : modelWeight(allowed.model);
  let baselineModel = allowedWeight !== null && allowedWeight > sessionWeight ? allowed.model : session.model;
  const allowedEffort = allowed.effort ?? null;
  let baselineEffort = allowedEffort !== null && effortIndex(allowedEffort) > effortIndex(session.effort) ? allowedEffort : session.effort;
  const sessionCost = (costAt(session.model, session.effort) as number);
  let limit = costAt(baselineModel, baselineEffort) as number;
  // A floor (the session's ceiling alias as it is SERVED, Antigravity): a call that costs no more than that is always let through, so the model the guidance sends an agent back to can never be held itself.
  if (floor && floor.effort !== null) {
    const floorCost = costAt(floor.model, floor.effort);
    if (floorCost !== null && floorCost > limit) {
      limit = floorCost;
      baselineModel = floor.model;
      baselineEffort = floor.effort;
    }
  }
  if (limit === 0) return { kind: 'fallback', why: 'zero-baseline' };
  const callCost = costAt(call.model, call.effort) as number;

  const facts: CostGateFacts = {
    callModel: call.model,
    callEffort: call.effort,
    callCost: round(callCost),
    sessionCost: round(sessionCost),
    limit: round(limit),
    baselineModel,
    baselineEffort,
    sessionEffort: session.effort,
    ratio: round(callCost / limit)
  };
  if (callCost <= limit) return { kind: 'pass', ...facts };

  const baselineWeight = modelWeight(baselineModel) as number;
  const cause: 'model' | 'effort' = callWeight > baselineWeight ? 'model' : 'effort';
  // The clamp model: the baseline model when the model is what is too much, else the call's own.
  const clampTarget = cause === 'model' ? baselineModel : call.model;
  const fits = highestEffortWithin(clampTarget, limit) ?? 'low';
  const clampEffort = effortIndex(call.effort) <= effortIndex(fits) ? call.effort : fits;
  const noFits = highestEffortWithin(call.model, limit, NO_EFFORT_CAP) ?? 'low';
  return { kind: 'over', cause, noEffort: noFits, clampEffort, clampModel: cause === 'model', ...facts };
}

/** `30`, `22.5`: a cost as the reason text writes it. */
export const costText = (n: number): string => (Number.isInteger(n) ? String(n) : String(round(n)));

/**
 * The cost sentence a deny reason, an ask or a clamp note carries: "costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)".
 * `label` turns a model id into the word the reader knows (an alias); it defaults to the id as written.
 */
export function costComparison(g: CostGateFacts, label: (model: unknown) => string = (m) => String(m ?? 'the session model')): string {
  const baseline = g.limit === g.sessionCost ? "the session's" : 'the allowed';
  return `costs ${costText(g.callCost)} vs ${baseline} ${costText(g.limit)} (${label(g.callModel)} at ${g.callEffort} vs ${label(g.baselineModel)} at ${g.baselineEffort})`;
}

/** The `cost_gate` value of a row. */
export type CostGateState = 'pass' | 'denied' | 'approved' | 'clamped' | 'fallback';

/** The effort of a call: a literal level on the call, else the level it falls back to (a definition's, else the session's), else null. */
export function effortOfCall(...candidates: unknown[]): CostEffort | null {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    return costEffortOf(c); // present but not a literal level ("higher", a number): unknown
  }
  return null;
}

export { DEFAULT_COST_EFFORT, EFFORT_WEIGHTS };

/**
 * The cost gate of an Antigravity `invoke_subagent` call (2.3.19). Antigravity carries the effort in the model id (a
 * `-low`, `-medium`, `-high`, `-xhigh` or `-max` suffix), so each side's effort is its id's suffix, else `medium` for the session.
 * The session side is held at the ceiling tier the hook derived from the session model (the Orchestrator's `flash` ceiling
 * included) at the session id's effort.
 *
 * The CALL side is priced by the model it is expected to be served on (`served-model.ts`, verified on Antigravity 1.5.14), not by
 * the name of the `Model` it wrote: `pro` costs as Hydrogen at xhigh (flash weight times 2), `flash` as Hydrogen at high, `flash_lite`
 * as flash-lite at the session's effort, and any other id as itself at its suffix (else the session's effort). So `pro` no longer
 * exceeds a session that is itself at xhigh on a flash ceiling, and never needs a pro-class budget. A call that names an enum value is also
 * always let through when it costs no more than the ceiling alias as it is served (the model "No" sends the agent back to).
 * `allowed` raises the baseline to what the user's own words allow (a named model).
 */
export function antigravityCostGate(requestedModel: unknown, ceilingTier: string, sessionModel: unknown, allowed: GateAllowance = {}): CostGate {
  const sessionEffort = effortFromModelId(sessionModel) ?? DEFAULT_COST_EFFORT;
  const served = servedModelExpected(requestedModel, sessionModel);
  // A call whose served model carries no effort runs at the session's (as a Claude call with no effort does); the telemetry
  // estimate counts it the same way (see `antigravityCostFields`).
  const callEffort = served.effort ?? sessionEffort;
  // For a call that names an enum value, the ceiling alias as it is SERVED is the floor of what the call may cost: it is the model the "No"
  // option and the guidance send the agent back to, so it must pass (a flash ceiling on a low-effort session would otherwise hold `flash`,
  // which is served at high). A full id (any effort) is held to the session's own cost as before.
  const ceiling = served.kind === 'enum' && subagentEnumOf(ceilingTier) !== null ? servedModelExpected(ceilingTier, null) : null;
  const floor = ceiling && ceiling.servedModel ? { model: ceiling.servedModel, effort: ceiling.effort ?? sessionEffort } : undefined;
  return evaluateCostGate({ model: served.servedModel ?? requestedModel, effort: callEffort }, { model: ceilingTier, effort: sessionEffort }, allowed, floor);
}

/** A model id without its effort suffix (`gemini-3-pro-high` gives `gemini-3-pro`). */
export const stripEffortSuffix = (model: string): string => model.replace(/-(low|medium|high|xhigh|max)$/i, '');

/** The cost of an enum value as the gate prices it, at a session effort. */
function enumCost(e: SubagentEnum, sessionEffort: CostEffort): number {
  const row = SERVED_BY_ENUM[e];
  return (costOf(row.servedModel, row.effort ?? sessionEffort) as number);
}

/** The most expensive enum value (`flash_lite`, `flash`, `pro`) whose served cost is within `limit`; `flash_lite` when none is (the floor). */
export function highestEnumWithin(limit: number, sessionEffort: CostEffort): SubagentEnum {
  return highestEnumWhere((e) => enumCost(e, sessionEffort) <= limit) ?? 'flash_lite';
}

/**
 * The model string a clamp sets on an Antigravity call (it must be a model `invoke_subagent` accepts). For a named `Model` value
 * (an enum value) it is the most expensive enum value whose served cost fits the session's (`pro` is served as Hydrogen at xhigh and
 * `flash` as Hydrogen at high: an enum value carries no effort of its own to lower, so the value itself is what is lowered), at
 * the lowest `flash_lite`. For a full id it is the ceiling tier when the model is what is too much (an alias carries no effort, so the call
 * runs at the effort the session does), else the call's own id with the lowered effort as its suffix (a full id such as
 * `gemini-3.5-pro-xhigh` becomes `gemini-3.5-pro-high`).
 */
export function antigravityClampModel(requestedModel: string, gate: Extract<CostGate, { kind: 'over' }>, ceilingTier: string): string {
  if (subagentEnumOf(requestedModel) !== null) return highestEnumWithin(gate.limit, gate.sessionEffort);
  return gate.clampModel ? ceilingTier : `${stripEffortSuffix(requestedModel)}-${gate.clampEffort}`;
}

/**
 * The model the Antigravity question's marker names (`[jev-elevate:<model>]`) and the approval is stored under (2.3.19): the
 * model as the call wrote it, unless the effort has to be said. Antigravity carries the effort in the model id (a full id such
 * as `gemini-3.5-pro-xhigh`, which a marker cannot hold: its pattern takes `[a-z0-9_-]` only, no dots), so a call that names an
 * effort in its id, or whose effort is above `high` (a bare model stands for at most `high`), is written as the tier and the
 * effort: `pro-xhigh`. That form is only the marker's and the approval's key: the call itself is re-invoked with the model it
 * was written with.
 */
export function antigravityMarkerModel(requestedModel: string, gate: Extract<CostGate, { kind: 'over' }> | null): string {
  if (!gate) return requestedModel;
  // An enum value carries its effort in what it IS (`pro` is Hydrogen at xhigh), so its marker and its approval are the plain value: an approval of `pro` covers `pro`.
  if (subagentEnumOf(requestedModel) !== null) return requestedModel;
  const named = effortFromModelId(requestedModel) !== null;
  if (!named && effortIndex(gate.callEffort) <= effortIndex(NO_EFFORT_CAP)) return requestedModel;
  const tier = costTierOf(requestedModel);
  return tier === 'pro' || tier === 'flash' || tier === 'flash_lite' ? `${tier}-${gate.callEffort}` : requestedModel;
}
