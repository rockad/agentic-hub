/**
 * Jev downgrade choice, pure part (no I/O). Every delegation (an Agent call) is rated on its own: Jev's router gives a
 * probability for each model tier, the NEEDED tier is the cheapest one whose cumulative probability reaches a threshold,
 * and the hook offers the catalogue steps that are sufficient, strictly below the requested model and strictly cheaper
 * (list price) through one prescribed AskUserQuestion (mode `ask`, the default) or runs the call on the cheapest one
 * (mode `auto`). `hook.ts` wires the store, the router call and the output.
 *
 * Everything here fails open: no catalogue, an unknown id or a malformed state means "no downgrade question".
 */
import { compareVersions, ladder, parseModelId, priceOf, resolveAlias, type CatalogueModel, type CatalogueTier, type ModelPrice } from '../src/core/catalogue.js';
import {
  TIER_TO_CLAUDE,
  compareFamilyFirst,
  modelAlias,
  pinnedLadderModel,
  type AgentCall,
  type ClaudeModelAlias,
  type JevTier,
  type RankContext,
  type UserIntent
} from './logic.js';
import { parseDowngradeMode, parseMinProbability, type DowngradeMode } from '../src/core/downgrade-config.js';
import { ladderDefName } from '../src/refresh/ladder-agents.js';

export type { DowngradeMode };
export { ladderDefName };

/** The marker the downgrade question starts with, and the PostToolUse recorder's pattern for it. */
export const DOWNGRADE_MARKER_RE = /^\s*\[jev-downgrade:([a-z0-9._-]+)\]/;

/** A question is asked at most once per call signature in this window; an answer and a cached rating hold for the same time. */
export const DOWNGRADE_TTL_MS = 10 * 60 * 1000;

const MAX_ENTRIES = 50;

/** The answer that switches the downgrade question off for the rest of the session. */
export const SESSION_OFF_LABEL = "No, and don't ask again this session";

/**
 * The downgrade mode: `JEV_DOWNGRADE` (`ask` | `auto` | `off`) wins, then the configured
 * `models.downgrade.mode`, then `ask`. An invalid value anywhere is ignored.
 */
export function downgradeMode(env: Record<string, string | undefined> | undefined, configured?: unknown): DowngradeMode {
  return parseDowngradeMode(env?.JEV_DOWNGRADE) ?? parseDowngradeMode(configured) ?? 'ask';
}

// ── The rating: probabilities per tier, and the tier a delegation needs ─────────

/** The tiers of Jev's tier question, cheapest first. */
export const TIER_ORDER: readonly JevTier[] = ['openrouter_free', 'flash_lite', 'flash', 'pro'];

export const DEFAULT_MIN_PROBABILITY = 0.6;
export const MIN_PROBABILITY_FLOOR = 0.5;
export const MIN_PROBABILITY_CEIL = 0.95;

/** A tier rating: Jev's choice and a probability per tier (sums to 1). `real` is false for a one-hot stand-in (the API sent no probabilities). */
export type TierRating = { choice: JevTier; p: Record<JevTier, number>; real: boolean };

const isTier = (t: unknown): t is JevTier => typeof t === 'string' && (TIER_ORDER as readonly string[]).includes(t);

/**
 * Pure: read the `recommendedTier` answer of a Decisions API response. The per-choice `probabilities` are kept (negative or
 * non-finite values and keys that are no tier dropped, the rest normalised to sum to one); without usable ones the rating is
 * one-hot on the chosen tier. Null (fail open) when there is no valid chosen tier.
 */
export function parseTierRating(data: unknown): TierRating | null {
  try {
    const answer = (data as { answers?: { recommendedTier?: { choice?: unknown; probabilities?: unknown } } } | null)?.answers?.recommendedTier;
    const choice = answer?.choice;
    if (!isTier(choice)) return null;
    const p: Record<JevTier, number> = { openrouter_free: 0, flash_lite: 0, flash: 0, pro: 0 };
    const raw = answer?.probabilities;
    if (raw && typeof raw === 'object') {
      for (const t of TIER_ORDER) {
        const v = (raw as Record<string, unknown>)[t];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) p[t] = v;
      }
    }
    const sum = TIER_ORDER.reduce((a, t) => a + p[t], 0);
    if (sum > 0) {
      for (const t of TIER_ORDER) p[t] /= sum;
      return { choice, p, real: true };
    }
    return { choice, p: { openrouter_free: 0, flash_lite: 0, flash: 0, pro: 0, [choice]: 1 }, real: false };
  } catch {
    return null;
  }
}

/**
 * Pure: the cheapest tier whose cumulative probability (of it and every cheaper tier) reaches `minProbability`. A tie at the
 * threshold goes to the cheaper tier (a small tolerance keeps floating-point sums from flipping it). A rating whose
 * probabilities never reach the threshold needs its chosen tier.
 */
export function neededTier(rating: TierRating, minProbability: number): { tier: JevTier; cumulative: number } {
  let cumulative = 0;
  for (const t of TIER_ORDER) {
    cumulative += rating.p[t];
    if (cumulative + 1e-9 >= minProbability) return { tier: t, cumulative: Math.min(1, cumulative) };
  }
  return { tier: rating.choice, cumulative: Math.min(1, cumulative) };
}

/**
 * The threshold: `JEV_DOWNGRADE_MIN_PROBABILITY`, then the configured `models.downgrade.minProbability`, then 0.6. A number
 * outside 0.5..0.95 is clamped; anything that is not a number is ignored (the next source applies).
 */
export function resolveMinProbability(env: Record<string, string | undefined> | undefined, configured?: unknown): number {
  const n = parseMinProbability(env?.JEV_DOWNGRADE_MIN_PROBABILITY) ?? parseMinProbability(configured) ?? DEFAULT_MIN_PROBABILITY;
  return Math.min(MIN_PROBABILITY_CEIL, Math.max(MIN_PROBABILITY_FLOOR, n));
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** One answer option of the question: its label, and how to run the delegation when it is picked. */
export type DowngradeOption = { label: string; model?: string; subagentType?: string };

export type DowngradePlan = {
  /** The model the delegation would run on: its own `model`, or the session model for a call with none. */
  requested: string;
  /** What "No, keep" relaunches with: the requested model, or the session alias for a call that had none. */
  keep: string;
  /** True when the call named no model (it runs on the session model). */
  inherited: boolean;
  neededTier: JevTier;
  /** The alias of the needed tier: the marker names it. */
  neededAlias: ClaudeModelAlias;
  /** Cumulative probability of the needed tier and the cheaper ones. */
  cumulative: number;
  /** False when the API gave no probabilities (the rating is one-hot, so no percentage is shown). */
  real: boolean;
  /** The Yes options, cheapest first (one or two). */
  yes: DowngradeOption[];
  /** Ladder steps that would be offered but need a definition (`jev-ladder-<id>`) which is not among the discovered subagents. */
  hiddenVia: string[];
  /** The Yes options, then `No, keep <requested>` and the session-off answer: at most four. */
  options: DowngradeOption[];
  /** "haiku $0.1/$0.5 vs sonnet $2/$10 per 1M, list price", when both prices are known. */
  priceNote: string | null;
};

type Step = { id: string; alias: ClaudeModelAlias | null; family: string; version: number[]; tierIdx: number; model: CatalogueModel | null };

const ALIASES: readonly ClaudeModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'];
const CATALOGUE_TIERS: readonly CatalogueTier[] = ['free', 'cheap', 'standard', 'deep'];
/** Catalogue tiers and Jev tiers line up one to one by position (free, cheap, standard, deep / openrouter_free, flash_lite, flash, pro). */
const FAMILY_TIER_IDX: Record<ClaudeModelAlias, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };

/** The ladder's steps. With a catalogue: its ids with their tier (an alias-expressible id carries its alias); without: the four aliases. */
function ladderSteps(ctx: RankContext | null | undefined): Step[] {
  if (!ctx) return ALIASES.map((a) => ({ id: a, alias: a, family: a, version: [], tierIdx: FAMILY_TIER_IDX[a], model: null }));
  const steps: Step[] = [];
  const seen = new Set<string>();
  CATALOGUE_TIERS.forEach((tier, tierIdx) => {
    for (const id of ladder(ctx.cat, tier, ctx.overrides)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const model = ctx.cat.models.find((m) => m.id === id) ?? null;
      const family = parseModelId(id)?.family ?? '';
      const alias = ALIASES.includes(family as ClaudeModelAlias) && resolveAlias(ctx.cat, family, ctx.overrides) === id ? (family as ClaudeModelAlias) : null;
      steps.push({ id, alias, family, version: model?.version ?? [], tierIdx, model });
    }
  });
  return steps;
}

/** The catalogue entry a requested model names (an alias resolves to the newest id of its family; a `[1m]` suffix is ignored). */
function catalogueEntry(ctx: RankContext | null | undefined, model: string): CatalogueModel | null {
  try {
    if (!ctx) return null;
    const bare = model.replace(/\[[^\]]*\]\s*$/, '').trim();
    const parsed = parseModelId(bare);
    if (!parsed) return null;
    const id = parsed.alias ? resolveAlias(ctx.cat, parsed.family, ctx.overrides) : bare;
    return ctx.cat.models.find((m) => m.id === id) ?? null;
  } catch {
    return null;
  }
}

/** The discovered subagent named for this ladder step (plain or `<plugin>:<name>`), or null. */
function findDefinition(id: string, defs: readonly string[]): string | null {
  const name = ladderDefName(id);
  return defs.find((d) => d === name) ?? defs.find((d) => d.endsWith(`:${name}`)) ?? null;
}

/** Model-supplied text reaches the reason: keep only safe characters and a bounded length. */
function safeText(text: unknown, max = 60): string {
  return typeof text === 'string' ? text.replace(/[^A-Za-z0-9:_.\/-]/g, '').slice(0, max) : '';
}

/**
 * Pure: the model an Agent call would run on, for the downgrade question. An explicit `model` is itself; no `model` (or
 * `inherit`) is the SESSION model, which must be rankable. Null (not evaluated) for a model nothing ranks, an unknown
 * session model, and a call whose `subagent_type` is a ladder definition (it already pins a model by name).
 */
export function delegationRequest(
  call: AgentCall,
  sessionModel: string | null | undefined,
  ctx?: RankContext | null
): { model: string; inherited: boolean } | null {
  try {
    const own = typeof call.model === 'string' ? call.model.trim() : '';
    if (own && own.toLowerCase() !== 'inherit') return modelAlias(own) ? { model: own, inherited: false } : null;
    if (pinnedLadderModel(call.subagent_type, ctx)) return null;
    return sessionModel && modelAlias(sessionModel) ? { model: sessionModel, inherited: true } : null;
  } catch {
    return null;
  }
}

/** Whether the user's own words name the requested model or a stronger one: their instruction outranks the advice. */
export function instructedModel(intent: UserIntent | null | undefined, requested: string, ctx?: RankContext | null): boolean {
  return !!intent?.models.some((m) => (compareFamilyFirst(m, requested, ctx) ?? -1) >= 0);
}

const money = (n: number): string => `$${+n.toFixed(2)}`;
const priceText = (name: string, p: ModelPrice): string => `${name} ${money(p.inputPerM)}/${money(p.outputPerM)}`;

/**
 * Pure: should this delegation be offered a cheaper model, given its tier rating? Null when it should not (no needed
 * tier below the requested model, a model nothing ranks, or an instruction naming the model).
 *
 * The needed tier comes from the rating (`neededTier`). Candidates are the catalogue's ladder steps that are sufficient
 * (their tier is at or above the needed one), strictly below the requested model (family first) AND strictly cheaper by
 * list price. A step or requested model with no price is not offered, except the alias of the needed tier, which is offered
 * by the family rank alone (so the feature still works with no price data, or no catalogue). A step that an older, dearer-or-equal
 * version of the same family would only duplicate is dropped.
 *
 * `defs` are the discovered subagent names. A ladder step that the Agent tool cannot name (a version inside an alias,
 * `claude-sonnet-5` while `sonnet` is `claude-sonnet-5-5`) is offered only for a `general-purpose` call (or none) and only when
 * its `jev-ladder-<id>` definition is in `defs`, because a definition replaces the subagent type. Any other subagent type is
 * evaluated at alias level only.
 */
export type PlanArgs = {
  call: AgentCall;
  sessionModel: string | null | undefined;
  rating: TierRating;
  minProbability?: number;
  intent?: UserIntent | null;
  ctx?: RankContext | null;
  defs?: readonly string[];
};

export function planDowngrade(args: PlanArgs): DowngradePlan | null {
  return evaluatePlan(args).plan;
}

/**
 * `planDowngrade` plus the ladder steps that would be offered but wait for a definition: with no other candidate the plan is
 * null while `hiddenVia` is not, which tells the caller that discovering the subagents may still produce an offer.
 */
export function evaluatePlan(args: PlanArgs): { plan: DowngradePlan | null; hiddenVia: string[] } {
  const none = { plan: null, hiddenVia: [] as string[] };
  try {
    const { call, rating, intent, ctx } = args;
    const defs = args.defs ?? [];
    const req = delegationRequest(call, args.sessionModel, ctx);
    if (!req) return none;
    if (instructedModel(intent, req.model, ctx)) return none;
    const { tier, cumulative } = neededTier(rating, args.minProbability ?? DEFAULT_MIN_PROBABILITY);
    const neededAlias = TIER_TO_CLAUDE[tier];
    const neededIdx = TIER_ORDER.indexOf(tier);
    const reqEntry = catalogueEntry(ctx, req.model);
    const reqPrice = priceOf(reqEntry);
    const generalPurpose = !call.subagent_type || call.subagent_type === 'general-purpose';

    type Cand = { step: Step; price: number | null };
    const cands: Cand[] = [];
    for (const step of ladderSteps(ctx)) {
      const below = compareFamilyFirst(step.alias ?? step.id, req.model, ctx);
      if (below === null || below >= 0) continue;
      if (step.tierIdx < neededIdx) continue;
      const price = priceOf(step.model);
      if (price !== null && reqPrice !== null) {
        if (!(price < reqPrice)) continue;
      } else if (step.alias !== neededAlias) {
        continue;
      }
      cands.push({ step, price });
    }
    // Cheapest first; a tie goes to the newer version, then to the step the Agent tool can name.
    cands.sort(
      (a, b) =>
        (a.price ?? Infinity) - (b.price ?? Infinity) ||
        compareVersions(b.step.version, a.step.version) ||
        Number(b.step.alias !== null) - Number(a.step.alias !== null)
    );
    const kept = cands.filter(
      (c) =>
        !cands.some(
          (o) =>
            o !== c &&
            o.step.family === c.step.family &&
            o.price !== null &&
            c.price !== null &&
            o.price <= c.price &&
            compareVersions(o.step.version, c.step.version) > 0
        )
    );

    const yes: DowngradeOption[] = [];
    const yesCands: Cand[] = [];
    const hiddenVia: string[] = [];
    for (const c of kept) {
      if (yes.length >= 2) break;
      if (c.step.alias) {
        yes.push({ label: `Yes, ${c.step.alias}`, model: c.step.alias });
        yesCands.push(c);
        continue;
      }
      if (!generalPurpose) continue;
      const def = findDefinition(c.step.id, defs);
      if (def) {
        yes.push({ label: `Yes, ${c.step.id} via ${def}`, subagentType: def });
        yesCands.push(c);
      } else {
        hiddenVia.push(c.step.id);
      }
    }
    if (yes.length === 0) return { plan: null, hiddenVia };

    const keepName =
      req.inherited || !/^[A-Za-z0-9._-]{1,60}$/.test(req.model) ? (modelAlias(req.model) as ClaudeModelAlias) : req.model;
    const first = yesCands[0];
    const firstPrice = first.step.model?.price;
    const priceNote =
      firstPrice && reqEntry?.price && priceOf(first.step.model) !== null && reqPrice !== null
        ? `${priceText(first.step.alias ?? first.step.id, firstPrice)} vs ${priceText(keepName, reqEntry.price)} per 1M, list price`
        : null;
    const plan: DowngradePlan = {
      requested: req.model,
      keep: keepName,
      inherited: req.inherited,
      neededTier: tier,
      neededAlias,
      cumulative,
      real: rating.real,
      yes,
      hiddenVia,
      options: [...yes, { label: `No, keep ${keepName}`, model: keepName }, { label: SESSION_OFF_LABEL, model: keepName }],
      priceNote
    };
    return { plan, hiddenVia };
  } catch {
    return none;
  }
}

/**
 * Pure: could ANY rating make this delegation offer a cheaper model? False when even the most permissive one (a task that
 * needs nothing) finds no candidate, so the router need not be asked at all (a call already on the cheapest model).
 */
export function anyCheaperStep(
  call: AgentCall,
  sessionModel: string | null | undefined,
  intent: UserIntent | null | undefined,
  ctx?: RankContext | null
): boolean {
  const free: TierRating = { choice: 'openrouter_free', p: { openrouter_free: 1, flash_lite: 0, flash: 0, pro: 0 }, real: false };
  // every ladder definition counts as present: a step that is only hidden could still be offered once the subagents are discovered
  const defs = ctx ? ctx.cat.models.map((m) => ladderDefName(m.id)) : [];
  return planDowngrade({ call, sessionModel, rating: free, intent, ctx, defs }) !== null;
}

function effortSentence(suggested?: string | null, session?: string | null): string {
  if (suggested && session) return `Jev suggests ${suggested} effort; session effort is ${session}`;
  if (suggested) return `Jev suggests ${suggested} effort`;
  return '';
}

/**
 * The deny reason of the downgrade question. A PreToolUse `deny` does not stop the turn: the assistant gets this text,
 * keeps working and is told to ask the one prescribed question. Under 900 characters: the second Yes option goes first,
 * then the hidden-step hint, then the price line, when a long subagent name would push it over.
 */
export function downgradeReason(
  plan: DowngradePlan,
  subagentType?: unknown,
  effort: { suggested?: string | null; session?: string | null } = {}
): string {
  const type = safeText(subagentType) || 'general-purpose';
  const req = safeText(plan.keep) || 'the requested model';
  const say = effortSentence(effort.suggested, effort.session);
  // The percentage is cumulative (the needed tier and every cheaper one), so the tier reads "or cheaper".
  const evidence = `Jev rates this ${plan.neededTier}${plan.neededTier === 'openrouter_free' ? '' : ' or cheaper'}${plan.real ? `, ${Math.round(plan.cumulative * 100)}%` : ''}`;
  const build = (yes: DowngradeOption[], withHint: boolean, withPrice: boolean): string => {
    const cands = yes.map((o) => o.label.replace(/^Yes, /, '')).join(', ');
    const options = [...yes, ...plan.options.slice(plan.yes.length)].map((o) => `'${o.label}'`).join(', ');
    const stating = [evidence, withPrice ? plan.priceNote : null, say].filter(Boolean).join('; ');
    const hint =
      withHint && plan.hiddenVia.length > 0
        ? ` To offer ${plan.hiddenVia.slice(0, 2).join(', ')} as well, tell the user to run: bun scripts/jev-models.ts ladder-agents --dir ~/.claude/agents.`
        : '';
    return (
      `[jev] "${req}" is more than this delegation needs, and the user did not ask for ${req}. ` +
      `Ask the user with AskUserQuestion, one question whose text STARTS with the marker [jev-downgrade:${plan.neededAlias}] followed by a short question ` +
      `naming the subagent_type (${type}), the requested model (${req}) and the cheaper candidates (${cands}), and stating: ${stating}; ` +
      `at most four options in this order: ${options}. ` +
      `Then launch the delegation again with the chosen model${yes.some((a) => a.subagentType) ? ' (an option with "via" is a subagent_type, with no model)' : ''}; ` +
      `on either No keep ${req}; do not stop and do not ask in any other form.${hint}`
    );
  };
  for (const [yes, hint, price] of [
    [plan.yes, true, true],
    [plan.yes.slice(0, 1), true, true],
    [plan.yes.slice(0, 1), false, true],
    [plan.yes.slice(0, 1), false, false]
  ] as const) {
    const text = build(yes, hint, price);
    if (text.length < 900) return text;
  }
  return build(plan.yes.slice(0, 1), false, false).slice(0, 897) + '...';
}

/**
 * Pure: the plan without the Yes options that would run on a remapped alias (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL` makes
 * `model: "haiku"` land on a model Jev did not rate). Only an option that names an alias is checked; a ladder step
 * through a `jev-ladder-<id>` definition sets no alias. Null when no Yes option remains. The price line described the
 * first Yes option, so it goes when that one is dropped.
 */
export function dropRemappedOptions(plan: DowngradePlan, remapped: (alias: string) => boolean): DowngradePlan | null {
  const yes = plan.yes.filter((o) => !(typeof o.model === 'string' && remapped(o.model)));
  if (yes.length === plan.yes.length) return plan;
  if (yes.length === 0) return null;
  return { ...plan, yes, options: [...yes, ...plan.options.slice(plan.yes.length)], priceNote: yes[0] === plan.yes[0] ? plan.priceNote : null };
}

/** The option `auto` applies: the cheapest Yes that sets a model alias (a version through a definition cannot be applied by rewriting `model`). */
export function autoOption(plan: DowngradePlan): (DowngradeOption & { model: string }) | null {
  const o = plan.yes.find((y) => typeof y.model === 'string');
  return o ? (o as DowngradeOption & { model: string }) : null;
}

/**
 * The PreToolUse output of mode `auto`: `allow` plus the whole original tool input with `model` replaced by the cheapest
 * alias option (`updatedInput` replaces the input, so every original field is copied) plus a note for the assistant.
 * Null when no option sets an alias.
 */
export function applyDowngrade(call: Record<string, unknown>, plan: DowngradePlan): { hookSpecificOutput: Record<string, unknown> } | null {
  const option = autoOption(plan);
  if (!option) return null;
  const req = safeText(plan.keep) || 'the requested model';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[jev] Downgrade applied: ${req} to ${option.model} (Jev rates this delegation ${plan.neededTier}).`,
      updatedInput: { ...call, model: option.model },
      additionalContext:
        `[jev] Jev ran this delegation on ${option.model} instead of ${req}, because Jev rates the task ${plan.neededTier} and the user did not ask for ${req}. ` +
        `Report the result; if ${req} is really needed, ask the user in chat (a reply naming ${req} passes).`
    }
  };
}

// ── State: asked and answered, ratings, session-off; per session ────────────

/** One question asked or answered. `signature` is null for an answer that no recorded question matched (it covers that `from` for the window). */
export type DowngradeEntry = {
  kind: 'downgrade';
  /** The needed alias the question was about; `*` for an answer that covers every delegation (a No to the elevation question). */
  from: string;
  answered: boolean;
  signature: string | null;
  chosen?: string;
  asked_at?: number;
  expires_at: number;
};

/** A tier rating kept for one call signature, so a retry does not call the router again. */
export type StoredRating = { signature: string; choice: JevTier; p: [number, number, number, number]; real: boolean; expires_at: number };

export type DowngradeState = {
  entries: DowngradeEntry[];
  ratings?: StoredRating[];
  /** Set by the fourth answer: nothing is evaluated for the rest of the session. */
  off?: { at: number };
};
export type DowngradeClaim = 'first' | 'asked' | 'answered';

/** Pure: read a state object of unknown shape into a clean one (a corrupt file gives an empty state; an old file has entries only). */
export function normalizeDowngradeState(raw: unknown): DowngradeState {
  const r = raw as { entries?: unknown; ratings?: unknown; off?: unknown } | null;
  const list = r?.entries;
  const entries = Array.isArray(list)
    ? list.filter((e): e is DowngradeEntry => {
        const x = e as Partial<DowngradeEntry> | null;
        return (
          !!x &&
          x.kind === 'downgrade' &&
          typeof x.from === 'string' &&
          typeof x.answered === 'boolean' &&
          (x.signature === null || typeof x.signature === 'string') &&
          typeof x.expires_at === 'number' &&
          Number.isFinite(x.expires_at)
        );
      })
    : [];
  const ratings = Array.isArray(r?.ratings)
    ? (r!.ratings as unknown[]).filter((e): e is StoredRating => {
        const x = e as Partial<StoredRating> | null;
        return (
          !!x &&
          typeof x.signature === 'string' &&
          isTier(x.choice) &&
          Array.isArray(x.p) &&
          x.p.length === 4 &&
          x.p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) &&
          typeof x.real === 'boolean' &&
          typeof x.expires_at === 'number' &&
          Number.isFinite(x.expires_at)
        );
      })
    : [];
  const at = (r?.off as { at?: unknown } | null | undefined)?.at;
  return {
    entries,
    ...(ratings.length > 0 ? { ratings } : {}),
    ...(typeof at === 'number' && Number.isFinite(at) ? { off: { at } } : {})
  };
}

const live = (state: DowngradeState, nowMs: number): DowngradeEntry[] => state.entries.filter((e) => e.expires_at > nowMs);
const liveRatings = (state: DowngradeState, nowMs: number): StoredRating[] => (state.ratings ?? []).filter((e) => e.expires_at > nowMs);
const withRatings = (state: DowngradeState, entries: DowngradeEntry[], nowMs: number): DowngradeState => {
  const ratings = liveRatings(state, nowMs);
  return { entries, ...(ratings.length > 0 ? { ratings } : {}), ...(state.off ? { off: state.off } : {}) };
};

/** Whether the user switched the downgrade question off for this session (the fourth answer). */
export function downgradeOff(state: DowngradeState): boolean {
  return !!state.off;
}

/** Pure: keep the rating of a call signature for the window (a second rating of the same signature replaces the first). */
export function rememberRating(state: DowngradeState, signature: string, rating: TierRating, nowMs: number): DowngradeState {
  const p = TIER_ORDER.map((t) => rating.p[t]) as [number, number, number, number];
  const stored: StoredRating = { signature, choice: rating.choice, p, real: rating.real, expires_at: nowMs + DOWNGRADE_TTL_MS };
  const ratings = [...liveRatings(state, nowMs).filter((r) => r.signature !== signature), stored].slice(-MAX_ENTRIES);
  return { entries: live(state, nowMs), ratings, ...(state.off ? { off: state.off } : {}) };
}

/** Pure: the rating kept for this call signature, or null (none, or older than the window). */
export function findRating(state: DowngradeState, signature: string, nowMs: number): TierRating | null {
  const r = liveRatings(state, nowMs).find((x) => x.signature === signature);
  if (!r) return null;
  const p = { openrouter_free: r.p[0], flash_lite: r.p[1], flash: r.p[2], pro: r.p[3] };
  return { choice: r.choice, p, real: r.real };
}

const answeredFor = (e: DowngradeEntry, signature: string): boolean => e.answered && (e.signature === signature || (e.signature === null && e.from === '*'));

/**
 * Pure, read-only: what is on record for a call before it is rated. `off` is the session switch; `answered` is an answer
 * for this signature (or a No to the elevation question, which covers every delegation for the window); `asked` is a
 * question for this signature that was not answered; `rating` is a rating kept within the window.
 */
export function peekDowngrade(
  state: DowngradeState,
  signature: string,
  nowMs: number
): { off: boolean; answered: boolean; asked: boolean; rating: TierRating | null } {
  const entries = live(state, nowMs);
  const answered = entries.some((e) => answeredFor(e, signature));
  return {
    off: downgradeOff(state),
    answered,
    asked: !answered && entries.some((e) => !e.answered && e.signature === signature),
    rating: findRating(state, signature, nowMs)
  };
}

/**
 * Pure: what the hook does with a call whose signature is `signature` and whose needed alias is `from`.
 *   `answered`  the user answered a downgrade question for this signature (or for this alias, with no signature on
 *               record, or for every delegation): let it through.
 *   `asked`     a question for this signature was already asked in the window and not answered: ask no second time.
 *   `first`     nothing on record: ask. With `record` the question is written down so the next call finds it.
 * Expired entries are dropped.
 */
export function claimDowngrade(
  state: DowngradeState,
  signature: string,
  from: string,
  nowMs: number,
  record: boolean
): { state: DowngradeState; result: DowngradeClaim } {
  const entries = live(state, nowMs);
  if (entries.some((e) => answeredFor(e, signature) || (e.answered && e.signature === null && e.from === from))) {
    return { state: withRatings(state, entries, nowMs), result: 'answered' };
  }
  if (entries.some((e) => !e.answered && e.signature === signature)) return { state: withRatings(state, entries, nowMs), result: 'asked' };
  if (!record) return { state: withRatings(state, entries, nowMs), result: 'first' };
  const added: DowngradeEntry = { kind: 'downgrade', from, answered: false, signature, asked_at: nowMs, expires_at: nowMs + DOWNGRADE_TTL_MS };
  return { state: withRatings(state, [...entries, added].slice(-MAX_ENTRIES), nowMs), result: 'first' };
}

/** What is stored for a No to the elevation question that answered the downgrade question too (see `onPostToolUse`). */
export const ELEVATION_DECLINED = 'elevation declined';

const MODEL = '(haiku|sonnet|opus|fable|claude-(?:haiku|sonnet|opus|fable)(?:-\\d{1,3}){0,3})';
const PRESCRIBED: ReadonlyArray<{ re: RegExp; label: (m: RegExpExecArray) => string }> = [
  { re: new RegExp(`^(Yes, )?${MODEL}$`), label: (m) => `${m[1] ?? ''}${m[2]}` },
  { re: new RegExp(`^No, keep ${MODEL}$`), label: (m) => `No, keep ${m[1]}` },
  // `<id> via <definition>`: the definition name is not kept (it is any text the user could have typed)
  { re: new RegExp(`^(Yes, )?${MODEL} via (?:[a-z0-9-]+:)?jev-ladder-claude-[a-z0-9-]{1,40}$`), label: (m) => `${m[1] ?? ''}${m[2]} via ladder` },
  { re: /^No, and don['’]t ask again this session$/, label: () => 'session off' }
];
const SESSION_OFF_STORED = 'session off';

/**
 * Pure: the only part of an answer the state keeps. A prescribed label (`Yes, <alias>`, `<alias>`, `No, keep <model>`,
 * `<id> via <definition>`, the session-off answer) is kept in a normalised form that names the model and nothing else;
 * anything else, an "Other" free-text answer in particular, is stored as `other`. The text itself never reaches the
 * file: it can hold task content, and nothing reads it back (an answer of any kind just marks the question answered).
 */
export function prescribedChoice(answer: string): string {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (text === ELEVATION_DECLINED) return ELEVATION_DECLINED;
  for (const { re, label } of PRESCRIBED) {
    const m = re.exec(text);
    if (m) return label(m);
  }
  return 'other';
}

/**
 * Pure: record the user's answer to a downgrade question about the needed alias `from`. Every pending question of that
 * alias is marked answered (Yes variants and No alike: the retried call must not be asked again). With no pending question
 * the answer is kept without a signature and covers that alias (`*`: every delegation) for the window. The session-off
 * answer also sets the session's off entry, which holds until the session ends.
 */
export function answerDowngrade(state: DowngradeState, from: string, chosen: string, nowMs: number): DowngradeState {
  const entries = live(state, nowMs);
  const label = prescribedChoice(chosen);
  let matched = false;
  const next = entries.map((e) => {
    if (e.answered || e.from !== from) return e;
    matched = true;
    return { ...e, answered: true, chosen: label, expires_at: nowMs + DOWNGRADE_TTL_MS };
  });
  if (!matched) {
    next.push({ kind: 'downgrade', from, answered: true, signature: null, chosen: label, expires_at: nowMs + DOWNGRADE_TTL_MS });
  }
  const base = withRatings(state, next.slice(-MAX_ENTRIES), nowMs);
  return label === SESSION_OFF_STORED ? { ...base, off: state.off ?? { at: nowMs } } : base;
}

/**
 * Pure: the needed alias and the answer label of a PostToolUse payload for AskUserQuestion whose question starts
 * with `[jev-downgrade:<alias>]`, or null. The answer is `tool_response.answers[question]` only (the user's
 * answer; `tool_input` is the model's own text and never counts). Any label counts (Yes or No); a missing answer and malformed input give null.
 */
export function parseDowngradeAnswer(input: unknown): { from: string; label: string } | null {
  try {
    const i = input as { tool_name?: unknown; tool_input?: any; tool_response?: any } | null;
    if (!i || typeof i !== 'object') return null;
    if (i.tool_name !== undefined && i.tool_name !== 'AskUserQuestion') return null;
    const question = i.tool_input?.questions?.[0]?.question;
    if (typeof question !== 'string') return null;
    const m = DOWNGRADE_MARKER_RE.exec(question);
    if (!m) return null;
    const answer = i.tool_response?.answers?.[question];
    if (typeof answer !== 'string' || !answer.trim()) return null;
    return { from: m[1], label: answer.trim() };
  } catch {
    return null;
  }
}

/** The effort level in a hook's `effort` field: a plain string, or an object holding one (`level` or `value`). Null when unknown. */
export function readEffort(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? ((value as Record<string, unknown>).level ?? (value as Record<string, unknown>).value ?? (value as Record<string, unknown>).name)
        : null;
  return typeof raw === 'string' && /^[A-Za-z]{2,12}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}
