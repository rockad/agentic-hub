/**
 * Claude Code adapter for Jev: the decision logic, kept free of I/O so it can be
 * tested offline. `hook.ts` wires it to stdin/stdout and the real Jev calls.
 *
 * Mirrors the OpenCode V2 plugin (opencode/plugin.ts): advise a subagent, model
 * and effort before each turn, and ask the user before a delegation would run on
 * a stronger model than the session's own. A Jev failure never fails a turn.
 */
import { createHash } from 'node:crypto';
import {
  defaultEffortForSubagent,
  applyEffortGovernance,
  discoverWorkspaceAgents,
  editCapableSubagent,
  type ThinkingEffort
} from '../src/shared.js';
import { STOP_RETRYING_FROM_ATTEMPT, stopRetryingText } from '../src/core/elevation-text.js';
import type { DenyCause } from '../src/core/deny-cause.js';
import { denialPredatesModeChange, type ModeChangeConfigLike } from '../src/core/mode-change.js';
import { compareModels, parseModelId, resolveAlias, type Catalogue, type ModelOverrides } from '../src/core/catalogue.js';
import { EFFORT_LEVELS, effortCovers, type EffortLevel } from './agent-definitions.js';
import { approvalEffortOf, costComparison, effortIndex, effortWithin, type CostGate, type CostGateFacts } from '../src/core/cost-gate.js';
import { costEffortOf } from '../src/core/cost-estimate.js';
import {
  ELEVATION_LABELS,
  cappedEffort,
  elevationLabelList,
  markOnceUsed,
  onceLive,
  parseAnswerLabel,
  storedClause,
  type AnswerKind,
  type AnswerScope,
  type OnceUsed,
  type ParsedAnswer,
  type StoredClause
} from '../src/core/elevation-answer.js';

import { STAGE_RUBRIC_TEXT, TIER_CRITERIA, type ClaudeModelAlias, type JevTier } from '../src/stage-rubric.js';

export type { ClaudeModelAlias, JevTier };
export { STAGE_RUBRIC_TEXT, TIER_CRITERIA };

/** Claude Code's built-in subagents (plus `self` for doing the work directly). */
export const CLAUDE_SUBAGENT_CRITERIA: Readonly<Record<string, string>> = {
  Explore: 'Read-only codebase exploration: find files, search code, answer questions about the codebase',
  'general-purpose': 'General multi-step tasks, research, and implementation work',
  Plan: 'Designing an implementation plan before writing code',
  self: 'Direct answer or edit in the main session without delegation'
};

/**
 * Discovery registers a display name ("Code Engineer") next to its kebab alias ("code-engineer");
 * only the alias is a real subagent_type, so the display name is dropped when its alias is present.
 * Built-ins keep their names, and a file-name alias such as `code_engineer` is kept. Mutates and returns `criteria`.
 */
export function dropDisplayNameAliases(criteria: Record<string, string>): Record<string, string> {
  for (const name of Object.keys(criteria)) {
    if (name in CLAUDE_SUBAGENT_CRITERIA) continue;
    const kebab = name.toLowerCase().replace(/[\s_]+/g, '-');
    if (kebab !== name && /[\sA-Z]/.test(name) && kebab in criteria) delete criteria[name];
  }
  return criteria;
}

/**
 * Resolve Claude subagent criteria dynamically by discovering custom workspace agents
 * and merging them with the Claude built-ins.
 */
export async function resolveClaudeSubagentCriteria(workspaceDir?: string): Promise<Record<string, string>> {
  const discovered = await discoverWorkspaceAgents(workspaceDir);
  const criteria: Record<string, string> = { ...CLAUDE_SUBAGENT_CRITERIA };
  for (const [name, desc] of Object.entries(discovered)) {
    if (name === 'none') continue;
    criteria[name] = desc;
  }
  dropDisplayNameAliases(criteria);
  criteria.Explore = CLAUDE_SUBAGENT_CRITERIA.Explore;
  criteria['general-purpose'] = CLAUDE_SUBAGENT_CRITERIA['general-purpose'];
  criteria.Plan = CLAUDE_SUBAGENT_CRITERIA.Plan;
  criteria.self = CLAUDE_SUBAGENT_CRITERIA.self;
  return criteria;
}

/** Jev tiers mapped onto Claude model aliases accepted by the Agent tool's `model` field. */
export const TIER_TO_CLAUDE: Readonly<Record<JevTier, ClaudeModelAlias>> = {
  openrouter_free: 'haiku',
  flash_lite: 'haiku',
  flash: 'sonnet',
  pro: 'opus'
};

const MODEL_RANK: ReadonlyArray<readonly [RegExp, number]> = [
  [/haiku/i, 1],
  [/sonnet/i, 2],
  [/opus/i, 3],
  [/fable/i, 4]
];

/** Relative strength of a Claude model id or alias; null when unknown or "inherit". */
export function modelRank(model: string | undefined | null): number | null {
  if (!model) return null;
  const hit = MODEL_RANK.find(([pattern]) => pattern.test(model));
  return hit ? hit[1] : null;
}

/**
 * What the hook reads from the model catalogue to compare models: the catalogue itself (read from its cache
 * file, never the network) and the user's overrides. Absent or null everywhere means "family regex only".
 */
export type RankContext = { cat: Catalogue; overrides?: ModelOverrides };

/**
 * Whether the catalogue knows `id`: a bare alias it can resolve to a usable id, or an id it lists (not
 * `needs-review`, unless an override gives it a tier). A catalogue that does not know an id says nothing about it.
 */
export function catalogueKnows(ctx: RankContext | null | undefined, id: string | undefined | null): boolean {
  if (!ctx || !id) return false;
  const parsed = parseModelId(id);
  if (!parsed) return false;
  if (parsed.alias) return resolveAlias(ctx.cat, parsed.family, ctx.overrides) !== null;
  const entry = ctx.cat.models.find((m) => m.id === id);
  return !!entry && (entry.status !== 'needs-review' || !!ctx.overrides?.[entry.id]?.tier);
}

/**
 * Pure: order two Claude models. Negative when `a` is weaker than `b`, positive when stronger, 0 when equal.
 * With a usable catalogue that knows both ids the comparison is the catalogue's (tier, then version, then overrides;
 * an alias is the newest id of its family). Otherwise it falls back to the family-only regex rank. Null when either
 * id has no rank at all (unknown or "inherit"): the caller treats it as unranked. Never throws.
 */
export function compareClaudeModels(
  a: string | undefined | null,
  b: string | undefined | null,
  ctx?: RankContext | null
): number | null {
  try {
    if (!a || !b) return null;
    if (catalogueKnows(ctx, a) && catalogueKnows(ctx, b)) {
      const r = compareModels(a, b, ctx!.cat, ctx!.overrides);
      if (r !== null) return Math.sign(r);
    }
    const ra = modelRank(a);
    const rb = modelRank(b);
    return ra === null || rb === null ? null : Math.sign(ra - rb);
  } catch {
    return null;
  }
}

/** Whether the user's overrides give `id` (or the id an alias resolves to) a tier of its own, which can move it across families. */
function hasTierOverride(ctx: RankContext | null | undefined, id: string): boolean {
  try {
    const overrides = ctx?.overrides;
    if (!overrides) return false;
    const parsed = parseModelId(id);
    const concrete = parsed?.alias && ctx ? (resolveAlias(ctx.cat, parsed.family, overrides) ?? id) : id;
    return overrides[concrete]?.tier !== undefined || overrides[id]?.tier !== undefined;
  } catch {
    return false;
  }
}

/**
 * Pure: the order used to decide whether one model is stronger than another for a permission (an elevation, an
 * approval). The family ladder (haiku < sonnet < opus < fable) decides across families, whatever the catalogue says:
 * the catalogue files opus and fable in one tier and orders them by version, which would put opus 5.5 above fable
 * 5.2. The catalogue only refines what the family rank cannot see: versions inside one family, and an id the user's
 * overrides moved to another tier. Same contract as `compareClaudeModels` (null when either id is unranked).
 */
export function compareFamilyFirst(
  a: string | undefined | null,
  b: string | undefined | null,
  ctx?: RankContext | null
): number | null {
  const ra = modelRank(a);
  const rb = modelRank(b);
  if (ra !== null && rb !== null && ra !== rb && !hasTierOverride(ctx, a as string) && !hasTierOverride(ctx, b as string)) {
    return Math.sign(ra - rb);
  }
  return compareClaudeModels(a, b, ctx);
}

export type Dispatch = {
  subagent: string;
  tier: JevTier;
  model: ClaudeModelAlias;
  effort: ThinkingEffort;
  confidence: number;
  /** The tier Jev returned, kept when the user's instruction changed `tier`. */
  routerTier?: JevTier;
  /** What set `tier` and `model`: absent for the router, else the user's instruction. */
  by?: 'instruction-model' | 'instruction-cost';
  /** The model the user named when the one-step cap kept the tier short of it. */
  asked?: NamedModel;
};

/** Turn a Jev decision response into a dispatch, validating every choice against the offered keys. */
export function parseDispatch(
  data: unknown,
  task: string,
  quotaStrategy: string,
  criteria: Record<string, string> = CLAUDE_SUBAGENT_CRITERIA
): Dispatch | null {
  const answers = (data as { answers?: Record<string, { choice?: unknown; confidence?: unknown }> } | null)?.answers;
  if (!answers) return null;
  const sa = answers.recommendedSubagent;
  const tierAnswer = answers.recommendedTier;
  const tierChoice = tierAnswer?.choice;
  const saChoice = sa?.choice;
  const tier: JevTier =
    typeof tierChoice === 'string' && tierChoice in TIER_CRITERIA ? (tierChoice as JevTier) : 'flash';
  const chosen =
    typeof saChoice === 'string' && saChoice in criteria ? saChoice : 'self';
  // Plan and Explore cannot edit files: a task that edits goes to general-purpose instead.
  const subagent = editCapableSubagent(chosen, task, 'general-purpose');
  const confidence = Math.min(
    typeof sa?.confidence === 'number' ? sa.confidence : 0.9,
    typeof tierAnswer?.confidence === 'number' ? tierAnswer.confidence : 0.9
  );
  const effort = applyEffortGovernance(defaultEffortForSubagent(subagent, task), quotaStrategy, tier);
  return { subagent, tier, model: TIER_TO_CLAUDE[tier], effort, confidence };
}

/** The questions sent to Jev for one turn. */
export function dispatchQuestions(criteria: Record<string, string> = CLAUDE_SUBAGENT_CRITERIA): Record<string, unknown> {
  return {
    recommendedSubagent: {
      type: 'choice',
      instructions: 'Select the best Claude Code subagent for this task (or self for direct work)',
      criteria
    },
    recommendedTier: {
      type: 'choice',
      instructions: 'Determine the required model tier from cognitive load and complexity',
      criteria: TIER_CRITERIA
    }
  };
}

// ── User intent and precedence ───────────────────────────────────────────────

export type NamedModel = 'haiku' | 'sonnet' | 'opus';

/** What the user said in the current turn's prompt about models and cost (case study 5.1). */
export type UserIntent = {
  /** Distinct models named in an imperative, in order of first appearance. Two or more is ambiguous. */
  models: NamedModel[];
  /** Set for "minimal viable model", "cheapest", "as cheap as possible" and close variants. */
  cost?: 'minimal';
  /** The words that matched, for the "You asked for ..." text. Never logged or stored. */
  phrase?: string;
  /** The highest of `xhigh` / `max` the user asked for as an effort ("use max effort"); it covers a delegation at that level or below. */
  effort?: EffortLevel;
};

export const NO_INTENT: UserIntent = { models: [] };

/** Longest prefix of a prompt that is scanned for an instruction (a model named further down is prose or a paste). */
export const INTENT_SCAN_CHARS = 1500;

// An imperative that selects a model. Prose that merely mentions a model ("sonnet is cheaper than
// opus", "compare with opus") does not match: a verb of choosing must come right before the name.
// "with sonnet" counts only as a clause opener ("With sonnet, please") or after a verb that sets
// the work going ("run it with sonnet", "go with haiku"), never as "compare with opus". A full id
// ("use claude-opus-5-5") names its family.
const MODEL_IMPERATIVE =
  /\b(?:(?:use|using|run|launch|spawn|start|delegate(?:\s+(?:it|this|that|them))?\s+to|dispatch(?:\s+(?:it|this|that|them))?\s+to|go\s+with|switch\s+to|want|prefer|choose|pick|select)|(?:(?:do|run|launch|start|proceed|go)\s+(?:it|this|that|them|these)?\s*with)|(?<=^|[.!?\n,;:]\s*)with)\s+(?:an?\s+|the\s+|only\s+)?(?:claude-)?(haiku|sonnet|opus)(?:-\d+(?:-\d+)?)?(?:-\d{8})?\b/gi;
// `--model opus` is an instruction only in an imperative clause ("run with --model opus"), never in prose about the flag.
const MODEL_FLAG = /(?<![\w-])--model(?:=|\s+)(?:claude-)?(haiku|sonnet|opus)(?:-\d+(?:-\d+)?)?(?:-\d{8})?\b/gi;
const FLAG_VERB = /\b(?:use|using|run|launch|start|spawn|invoke|execute|pass|call|go)\b[^.!?\n]{0,40}$/i;
const ANY_MODEL = /\b(?:claude-)?(haiku|sonnet|opus)\b/gi;
// A negator within a couple of words before the instruction: "do not use opus", "not opus", "instead of",
// "without". Anywhere further back ("I have no idea, use opus") it is a different clause.
const NEGATION = /\b(?:don'?t|do\s+not|never|not|no|without|avoid|stop|instead\s+of|rather\s+than)\s+(?:[\w'-]+\s+){0,2}$/i;
// A second model named after the first only replaces it ("use sonnet instead of opus", "opus over sonnet").
const REPLACED = /\b(?:over|instead\s+of|rather\s+than)\s+(?:[\w'-]+\s+){0,2}$/i;
// A statement about what someone will do, not an instruction to do it ("I will use opus", "the agent can use haiku").
const STATEMENT_SUBJECT =
  /\b(?:i|we|you|he|she|they|it|agent|assistant|claude)\s*(?:'ll|'d|\s+(?:will|would|shall|can|could|might|may|did|does|had|has|have|am\s+going\s+to|are\s+going\s+to|is\s+going\s+to|was\s+going\s+to|'m\s+going\s+to))\s+(?:\w+\s+){0,1}$/i;
// A subject right before the verb makes it a description, not a command ("We use haiku for the classifier",
// "Users who use opus see errors", "When I switch to sonnet it breaks"). "You" is left out: "you use opus" can be an order.
const DIRECT_SUBJECT = /\b(?:i|we|they|users?|people|folks|everyone|who|that|which|team)\s+$/i;
// A noun or pronoun plus a modal of obligation before the verb ("the agent should use opus only for judges").
const MODAL_SUBJECT =
  /\b(?:we|they|users?|people|who|he|she|it|agent|agents|assistant|claude|team)\s+(?:\w+\s+){0,1}(?:should|must|needs?\s+to|has\s+to|have\s+to|ought\s+to)\s+$/i;
// A verb that voices the user's own wish ("I want opus", "I'd prefer sonnet") stays an instruction after "I".
const WISH_VERB = /^(?:want|prefer|choose|pick|select)$/i;
// A line a speaker label or a quote marker says was said by someone else (a pasted log or reply).
const PASTED_LINE = /^\s*(?:>|(?:[-*]\s*)?(?:agent|assistant|claude|ai|bot|model|jev|system|tool|log|output|stdout|stderr)\s*[:>])/i;
// A sentence that asks or supposes rather than instructs.
const NON_INSTRUCTION_SENTENCE = /^\W*(?:if|should|what|why|how|when|whenever)\s/i;
// "This is the cheapest fix": a cost word after a copula or a comparison describes something, it does not ask for it.
const DESCRIPTIVE_BEFORE = /\b(?:is|was|are|were|be|been|being|as|than|it's|that's|this's)\s+(?:the\s+|a\s+|an\s+)?$/i;
// Literary uses of the two model names that are poetic forms: "a haiku about spring", "use haiku format", "sonnet 130".
const LITERARY_TAIL = /^(?:[-\s]*(?:about|by|format|formats|style|styled|poem|poems|poetry|form|stanza|stanzas|syllable|syllables|contest|collection|sequence|cycle|writing|verse)\b|\s+\d{2,}\b(?!\.\d))/i;
// An imperative that selects an effort level above the interim threshold ("use max effort", "run it at xhigh effort",
// "set the effort to max"). Same discipline as a model instruction: a verb of choosing right before it, nothing in prose.
const EFFORT_IMPERATIVE =
  /\b(?:(?:use|using|run|launch|spawn|start|go|set|want|prefer|choose|pick|select|switch\s+to)|(?:(?:do|run|launch|start|proceed|go)\s+(?:it|this|that|them|these)?\s*(?:with|at|on))|(?<=^|[.!?\n,;:]\s*)(?:with|at))\s+(?:an?\s+|the\s+|only\s+)?(?:(?:(x-?high|max(?:imum)?)\s+(?:reasoning\s+|thinking\s+)?effort)|(?:(?:reasoning\s+|thinking\s+)?effort\s+(?:level\s+)?(?:to\s+|of\s+|at\s+|=\s*|:\s*)?(x-?high|max(?:imum)?)))\b/gi;
const EFFORT_FLAG = /(?<![\w-])--effort(?:=|\s+)(x-?high|max(?:imum)?)\b/gi;
const effortLevelOf = (word: string): EffortLevel => (word.toLowerCase().startsWith('max') ? 'max' : 'xhigh');
const MINIMAL_COST =
  /\b(?:minimal|minimum)[\s-]+viable\b(?![\s-]+products?\b)|\b(?:minimal|minimum|smallest|lowest)[\s-]+(?:cost|tier|model)\b|\bcheapest\b|\bleast\s+expensive\b|\bas\s+cheap(?:ly)?\s+as\b|\bcheap(?:er)?\s+models?\b|\blowest[- ]cost\b/gi;

/** The typographic apostrophes and single quotes as ASCII "'", one character for one, so every index stays where it was. */
export function normalizeApostrophes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

/** Blank out `re` matches with spaces, keeping every index and newline where it was. */
function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The prompt with what is not the user's own instruction blanked out, index for index: fenced code
 * blocks, inline code spans and quoted strings ("..." and '...': a quote after a letter is an
 * apostrophe, not an opening quote).
 */
function withoutQuotedText(text: string): string {
  let out = blank(text, /(```|~~~)[\s\S]*?(?:\1|$)/g);
  out = blank(out, /`[^`\n]*`/g);
  out = blank(out, /"[^"\n]{0,300}"|“[^”\n]{0,300}”/g);
  return blank(out, /(?<![\w])'[^'\n]{1,300}'(?![\w])/g);
}

/** The sentence around `index`: from after the previous sentence end or newline to the next one, terminator included. */
function sentenceAround(text: string, index: number): string {
  const before = text.slice(0, index);
  let start = 0;
  for (const b of before.matchAll(/[.!?]+\s|\n/g)) start = b.index! + b[0].length;
  const rest = text.slice(index);
  const end = /[.!?]+(?=\s|$)|\n/.exec(rest);
  return text.slice(start, end ? index + end.index + end[0].length : text.length);
}

/** Whether a match at `index` is the user's own instruction, going by where it sits: not in a question, a supposition or a pasted line. */
function instructive(text: string, index: number): boolean {
  const sentence = sentenceAround(text, index).trim();
  if (sentence.endsWith('?') || NON_INSTRUCTION_SENTENCE.test(sentence)) return false;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  if (PASTED_LINE.test(text.slice(lineStart, index + 1))) return false;
  return true;
}

/**
 * Pure: read an explicit model or cost instruction from the prompt. Conservative by design: imperative
 * patterns only; nothing inside code, a quotation or a pasted line; nothing in a question or a
 * supposition; a negated or contradictory mention yields nothing, and two different models in one
 * clause are ambiguous (`models` then holds both and `namedModel` is null). Task notifications carry none.
 */
export function parseUserIntent(prompt: string | undefined | null): UserIntent {
  // A typographic apostrophe (U+2018, U+2019, U+02BC) is an apostrophe: "Don’t use opus" is the same negation as "Don't".
  const text = withoutQuotedText(normalizeApostrophes((prompt ?? '').trimStart().slice(0, INTENT_SCAN_CHARS)));
  const named = new Map<NamedModel, string>();
  const candidates = [
    ...[...text.matchAll(MODEL_IMPERATIVE)].map((m) => ({ m, flag: false })),
    ...[...text.matchAll(MODEL_FLAG)].map((m) => ({ m, flag: true }))
  ];
  for (const { m, flag } of candidates) {
    const at = m.index!;
    const family = m[1].toLowerCase() as NamedModel;
    const after = text.slice(at + m[0].length);
    if (!instructive(text, at)) continue;
    if (NEGATION.test(text.slice(Math.max(0, at - 30), at))) continue;
    const lead = text.slice(Math.max(0, at - 40), at);
    if (STATEMENT_SUBJECT.test(lead) || MODAL_SUBJECT.test(lead)) continue;
    if (!WISH_VERB.test(m[0].trim().split(/\s+/)[0]) && DIRECT_SUBJECT.test(lead)) continue;
    if (flag && !FLAG_VERB.test(text.slice(Math.max(0, at - 60), at))) continue;
    if ((family === 'haiku' || family === 'sonnet') && LITERARY_TAIL.test(after)) continue;
    named.set(family, m[0].trim());
    // Another model named later in the same clause ("use opus or sonnet", "sonnet for A and opus for B") leaves the choice open.
    const clause = /^[^.!?;\n]{0,80}/.exec(after)![0];
    for (const other of clause.matchAll(ANY_MODEL)) {
      const o = other[1].toLowerCase() as NamedModel;
      if (o === family) continue;
      const otherLead = text.slice(Math.max(0, at + m[0].length + other.index! - 30), at + m[0].length + other.index!);
      if (NEGATION.test(otherLead) || REPLACED.test(otherLead)) continue;
      named.set(o, other[0].trim());
    }
  }
  const intent: UserIntent = { models: [...named.keys()] };
  if (named.size === 1) intent.phrase = [...named.values()][0];
  const effort = parseEffortIntent(text);
  if (effort) intent.effort = effort;
  for (const cost of text.matchAll(MINIMAL_COST)) {
    const before = text.slice(Math.max(0, cost.index! - 30), cost.index!);
    if (!instructive(text, cost.index!) || NEGATION.test(before) || DESCRIPTIVE_BEFORE.test(before)) continue;
    intent.cost = 'minimal';
    intent.phrase ??= cost[0];
    break;
  }
  return intent;
}

/**
 * The effort level (`xhigh` or `max`; the higher when both are named) the prompt instructs, from text already stripped of
 * quotes and code. The same filters as a model instruction: a question, a supposition, a pasted line, a negation or a
 * description ("the agent will use max effort") is not an instruction.
 */
function parseEffortIntent(text: string): EffortLevel | null {
  const candidates = [
    ...[...text.matchAll(EFFORT_IMPERATIVE)].map((m) => ({ m, level: effortLevelOf(m[1] ?? m[2]), flag: false })),
    ...[...text.matchAll(EFFORT_FLAG)].map((m) => ({ m, level: effortLevelOf(m[1]), flag: true }))
  ];
  let best: EffortLevel | null = null;
  for (const { m, level, flag } of candidates) {
    const at = m.index!;
    if (!instructive(text, at)) continue;
    if (NEGATION.test(text.slice(Math.max(0, at - 30), at))) continue;
    const lead = text.slice(Math.max(0, at - 40), at);
    if (STATEMENT_SUBJECT.test(lead) || MODAL_SUBJECT.test(lead)) continue;
    if (!WISH_VERB.test(m[0].trim().split(/\s+/)[0]) && DIRECT_SUBJECT.test(lead)) continue;
    if (flag && !FLAG_VERB.test(text.slice(Math.max(0, at - 60), at))) continue;
    if (!best || EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(best)) best = level;
  }
  return best;
}

/** Does the user's own instruction in this prompt cover a delegation at `level` ("use max effort" covers xhigh and max)? */
export function instructedEffort(intent: UserIntent | null | undefined, level: EffortLevel): boolean {
  return !!intent && effortCovers(intent.effort, level);
}

/** The intent as it is stored and logged: the choice only, never the matched words. */
export function storedIntent(intent: UserIntent): UserIntent {
  return { models: [...intent.models], ...(intent.cost ? { cost: intent.cost } : {}), ...(intent.effort ? { effort: intent.effort } : {}) };
}

/** The model the user named, only when they named exactly one (two names are a split, not an order). */
export function namedModel(intent: UserIntent | undefined | null): NamedModel | null {
  return intent && intent.models.length === 1 ? intent.models[0] : null;
}

const MODEL_TO_TIER: Readonly<Record<NamedModel, JevTier>> = {
  haiku: 'flash_lite',
  sonnet: 'flash',
  opus: 'pro'
};

/** A cost intent lowers the tier by one step, never below flash_lite; the free tier stays free. */
export function lowerTier(tier: JevTier): JevTier {
  if (tier === 'pro') return 'flash';
  if (tier === 'flash') return 'flash_lite';
  return tier;
}

const TIER_ORDER: readonly JevTier[] = ['openrouter_free', 'flash_lite', 'flash', 'pro'];

/** A recommendation as far as the resolution needs it: the tier, plus whatever else the caller has. */
type RecLike = Pick<Dispatch, 'tier'> & Partial<Dispatch>;

/**
 * Apply the user's own words to Jev's recommendation, moving the tier by at most ONE step from the
 * router's (a parser that misreads a prompt then costs one tier, not three). A named model moves the
 * tier one step towards that model's tier; a minimal-cost request lowers it one step, never below
 * `flash_lite`. When both are present the named model wins and the cost request is ignored, so the
 * effect is capped at one instruction. Returns the input unchanged when there is nothing to apply.
 */
export function applyUserIntent<T extends RecLike>(rec: T, intent: UserIntent | null | undefined): T {
  const named = namedModel(intent);
  if (named) {
    const wanted = MODEL_TO_TIER[named];
    const from = TIER_ORDER.indexOf(rec.routerTier ?? rec.tier);
    const to = TIER_ORDER.indexOf(wanted);
    const tier = TIER_ORDER[Math.max(from - 1, Math.min(from + 1, to))];
    const { asked: _dropped, ...rest } = rec;
    return {
      ...rest,
      tier,
      model: tier === wanted ? named : TIER_TO_CLAUDE[tier],
      routerTier: rec.routerTier ?? rec.tier,
      by: 'instruction-model',
      ...(tier === wanted ? {} : { asked: named })
    } as T;
  }
  if (intent?.cost === 'minimal') {
    // Measured from the router's tier, so applying the same intent twice gives the same result.
    const base = rec.routerTier ?? rec.tier;
    const tier = lowerTier(base);
    if (tier === base) return { ...rec, by: 'instruction-cost' };
    return { ...rec, tier, model: TIER_TO_CLAUDE[tier], routerTier: base, by: 'instruction-cost' };
  }
  return rec;
}

// ── Precedence (5.9) ────────────────────────────────────────────────────────

/**
 * Which rule decided the model, in this order:
 *   1. the user's own words in this turn ("use opus", "minimal viable model");
 *   2. the Jev guard: the opus tier needs the user's approval when the session model is below opus
 *      (an explicit request for opus satisfies it);
 *   3. the standing rule (sonnet by default, escalate only where a wrong judgement is expensive).
 *      Jev cannot read the user's CLAUDE.md, so this layer is the router's own tier.
 */
export type AppliedRule = 'instruction' | 'guard' | 'standing';

export const RULE_LABEL: Readonly<Record<AppliedRule, string>> = {
  instruction: 'rule: per your instruction',
  guard: 'rule: per the Jev guard',
  standing: 'rule: per standing rule'
};

/** Whether the session model is opus or stronger, so an opus delegation is within the ceiling. Unknown counts as no. */
function sessionAllowsOpus(sessionModel: string | null): boolean {
  const rank = modelRank(sessionModel);
  return rank !== null && rank >= (modelRank('opus') as number);
}

/**
 * Whether `model` is stronger than the session model, so the Claude Code guard would ask about it.
 * An unknown session model counts as "stronger" for opus only: a cheaper model is not called an
 * escalation on no evidence.
 */
function exceedsSession(model: string, sessionModel: string | null): boolean {
  const wanted = modelRank(model);
  if (wanted === null) return false;
  const session = modelRank(sessionModel);
  if (session === null) return model === 'opus';
  return wanted > session;
}

/** A pro rating capped at the session model (2.3.2 behaviour); an unknown session model leaves it alone. */
function capToSession<T extends RecLike>(rec: T, sessionModel: string | null): T {
  const rank = modelRank(sessionModel);
  if (rec.tier !== 'pro' || rank === null || rank >= (modelRank('opus') as number)) return rec;
  const tier: JevTier = rank <= 1 ? 'flash_lite' : 'flash';
  return { ...rec, tier, model: TIER_TO_CLAUDE[tier] };
}

/** The rule that decided an already-resolved recommendation. */
export function appliedRule(rec: Pick<Dispatch, 'tier' | 'by'>, sessionModel: string | null): AppliedRule {
  if (rec.by) return 'instruction';
  return rec.tier === 'pro' && !sessionAllowsOpus(sessionModel) ? 'guard' : 'standing';
}

export type Resolution = {
  tier: JevTier;
  model: ClaudeModelAlias;
  /** Precedence layer that decided: instruction, then mode guard, then default (standing) rule. */
  source: 'user-instruction' | 'mode-guard' | 'default-rule';
  rule: AppliedRule;
  /** The user has to approve before the model is used: only the guard rule asks. */
  needsApproval: boolean;
  /** The recommendation to advise, after the user's instruction was applied. */
  advised: Dispatch;
};

const RULE_SOURCE: Readonly<Record<AppliedRule, Resolution['source']>> = {
  instruction: 'user-instruction',
  guard: 'mode-guard',
  standing: 'default-rule'
};

/**
 * One precedence order for the model of a delegation (see AppliedRule). The user's own instruction is
 * stored at UserPromptSubmit and read by the PreToolUse guard, which passes the model the user named
 * unchanged: that instruction is the approval. Under the guard rule (a pro rating on a session below
 * opus) the advised model stays capped at the session model, as in 2.3.2, and `needsApproval` is true.
 * 2.3.4 adds the elevation clamp at PreToolUse but keeps the cap: an opus header made the assistant call
 * for opus straight after a clamp.
 */
export function resolveModel(args: {
  intent?: UserIntent | null;
  rec: RecLike;
  sessionModel: string | null;
}): Resolution {
  const { intent, rec, sessionModel } = args;
  const applied = applyUserIntent(rec, intent) as Dispatch;
  const rule = appliedRule(applied, sessionModel);
  const advised = rule === 'guard' ? capToSession(applied, sessionModel) : applied;
  return {
    tier: advised.tier,
    model: advised.model ?? TIER_TO_CLAUDE[advised.tier],
    source: RULE_SOURCE[rule],
    rule,
    needsApproval: rule === 'guard',
    advised
  };
}

/** Short stable id for one user turn, shared by the UserPromptSubmit and PreToolUse log records. */
export function turnId(prompt: string): string {
  return createHash('sha1').update((prompt || '').trim()).digest('hex').slice(0, 12);
}

/** Per-session state written at UserPromptSubmit and read at PreToolUse. */
export type TurnState = {
  turn: string;
  /** The host's id of the prompt this state was written for (2.3.4); PreToolUse ignores the stored instruction when its own prompt id differs. */
  promptId?: string;
  intent: UserIntent;
  /** What was advised for this turn, after the user's instruction was applied. */
  rec?: { subagent: string; tier: JevTier; model: ClaudeModelAlias; by?: Dispatch['by'] };
  /** The effort Jev suggested for this turn (advisory; the downgrade question and the log name it). Kept beside `rec`, not in it. */
  recEffort?: ThinkingEffort;
  /** The Jev mode the turn started in: a state stored under another mode is stale (a mode flip mid-turn). */
  mode?: string;
  /** ISO time the marker was written. */
  at?: string;
  /** The prompt named a workflow or workstreams: staged work, where one tuple per turn is not enough. */
  staged?: boolean;
  /** Epoch ms of the last pre-flight reminder, so it is not repeated on every Agent call. */
  remindedAt?: number;
};

/**
 * The context line injected before the turn. One sentence says what limits the model: the hard
 * ceiling (the session model) when the delegation is within it, and otherwise one ask or approval
 * sentence, never the ceiling line next to a delegation above it (case study 5.2).
 */
export function buildDirective(
  rec: Dispatch,
  sessionModel: string | null,
  quotaStrategy: string,
  intent?: UserIntent | null,
  elevation: ElevationMode = 'choice'
): string {
  const body = directiveBody(rec, sessionModel, quotaStrategy, intent, elevation);
  // The stage rubric helps on a turn that delegates paid work and is noise on the rest (5.3).
  const advised = applyUserIntent(rec, intent);
  const delegates = advised.subagent !== 'self' && advised.tier !== 'openrouter_free' && advised.by !== 'instruction-model';
  return delegates ? `${body} ${STAGE_RUBRIC_TEXT}` : body;
}

function directiveBody(
  rec: Dispatch,
  sessionModel: string | null,
  quotaStrategy: string,
  intent?: UserIntent | null,
  elevation: ElevationMode = 'choice'
): string {
  const advised = applyUserIntent(rec, intent);
  // Where a delegation above the session model needs the user's say, the choice flow prescribes the question
  // (marker and four options) so the assistant asks before its first Agent call; other modes keep the 2.3.4 wording.
  const askAbove = (model: string, fallback: string): string => {
    if (elevation !== 'choice') return fallback;
    const alias = modelAlias(sessionModel);
    return `${elevationChoiceDirective(model, sessionModel, alias)}; let the user choose.`;
  };
  // The head shows the model Jev advises: for a pro rating on a session below opus it is capped at the
  // session model (as in 2.3.2) while the sentences below still report the opus-level rating and the ask.
  const { advised: shown, rule } = resolveModel({ intent, rec, sessionModel });
  const head =
    `[JEV] cost-tiered recommendation (quota=${quotaStrategy}; ${RULE_LABEL[rule]}): ` +
    `subagent="${shown.subagent}", tier="${shown.tier}", model="${shown.model}", effort="${shown.effort}".`;
  const limit = `The session model${sessionModel ? ` "${sessionModel}"` : ''}`;
  const ceiling = sessionModel
    ? `${limit} is the hard ceiling: never delegate to a stronger model without explicit user approval.`
    : 'Never delegate to a stronger model than the current session without explicit user approval.';
  const subagent = advised.subagent === 'self' ? 'general-purpose' : advised.subagent;

  if (advised.by === 'instruction-model') {
    const phrase = intent?.phrase ?? advised.model;
    const asked = advised.asked
      ? `You asked for ${advised.asked} (explicit user request: "${phrase}"), but Jev moves at most one tier step from its own recommendation (${advised.routerTier}): delegate to ${subagent} with model "${advised.model}".`
      : `You asked for ${advised.model} (explicit user request: "${phrase}"): delegate to ${subagent} with model "${advised.model}".`;
    if (!exceedsSession(advised.model, sessionModel)) return `${head} ${ceiling} ${asked}`;
    // Above the session model. The PreToolUse guard passes a call whose model is the one the user named, or
    // weaker than it (the stored intent), with no clamp and no dialog: the user's own instruction is the
    // approval. That covers the model the one-step cap advised when it is below the one named.
    return `${head} ${asked} The user's own instruction is the approval for a model above the session model: the Jev guard passes it without clamping or asking; do not ask separately.`;
  }

  const costNote =
    advised.by === 'instruction-cost' && advised.routerTier && advised.routerTier !== advised.tier
      ? `You asked for the minimal viable model (explicit user request: "${intent?.phrase ?? 'minimal viable'}"): Jev lowered the tier from ${advised.routerTier} to ${advised.tier}. `
      : '';
  const isCustom = !['Explore', 'Plan', 'general-purpose', 'self'].includes(advised.subagent);

  if (advised.tier === 'pro') {
    // One sentence, never the ceiling line plus an ask line that contradict each other.
    const pro = sessionAllowsOpus(sessionModel)
      ? `Jev rates this opus-level and the session model "${sessionModel}" allows it: delegate to ${subagent} with model "opus".`
      : `Jev rates this opus-level; ${limit.replace(/^The/, 'the')} is the hard ceiling, so ${askAbove('opus', 'ask the user before delegating on opus: offer the cheaper option and let the user choose.')}`;
    return `${head} ${costNote}${pro}`;
  }

  // A paid delegation on a model above the session model: one ceiling sentence, not the hard-ceiling
  // line followed by a "delegate to <stronger model>" action that contradicts it.
  if (advised.tier !== 'openrouter_free' && advised.subagent !== 'self' && exceedsSession(advised.model, sessionModel)) {
    return `${head} ${costNote}Jev rates this ${advised.model}-level; ${limit.replace(/^The/, 'the')} is the hard ceiling, so ${askAbove(advised.model, `ask the user before delegating on ${advised.model}: offer a model within the ceiling and let the user choose.`)}`;
  }

  const action =
    advised.tier === 'openrouter_free'
      ? 'Consider offloading it to the jev MCP tool jev_execute_free ($0) instead of a paid subagent.'
      : advised.subagent === 'self'
        ? 'Handle it directly.'
        : isCustom
          ? `Action: Delegate to custom persona via Agent(subagent_type: "${advised.subagent}", model: "${advised.model}").`
          : `Delegate to the ${advised.subagent} subagent with model "${advised.model}".`;
  return `${head} ${costNote}${ceiling} ${action}`;
}

export type AgentCall = {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  model?: string;
};

/** The decision of a gate on an Agent / Task / Workflow call. `cause` (2.3.20) is why it was held, chosen by the path that produced it (never from the text); it is written to the rows as `denyCause` / `askCause`. */
export type AgentDecision = { decision: 'ask' | 'deny'; reason: string; cause?: DenyCause } | null;

/** The Claude alias for a model id or alias (`claude-sonnet-5` gives `sonnet`); null when unknown or "inherit". */
export function modelAlias(model: string | undefined | null): ClaudeModelAlias | null {
  if (!model) return null;
  const hit = MODEL_ALIASES.find(([pattern]) => pattern.test(model));
  return hit ? hit[1] : null;
}

const MODEL_ALIASES: ReadonlyArray<readonly [RegExp, ClaudeModelAlias]> = [
  [/haiku/i, 'haiku'],
  [/sonnet/i, 'sonnet'],
  [/opus/i, 'opus'],
  [/fable/i, 'fable']
];

/** What an Agent call's model means against the session model. */
export type Elevation = {
  /** `instructed`: above the session model, but the user named that model or a stronger one in this prompt. `elevating`: above it, no instruction. */
  kind: 'elevating' | 'instructed';
  requested: string;
  sessionModel: string;
  /** The alias the call is clamped to: the session model's own. */
  sessionAlias: ClaudeModelAlias;
  /**
   * Set only when a model catalogue is in use and neither it nor the family table knows the requested id: Jev
   * cannot rank it, so the guard stops it (choice and clamp: a deny with guidance; dialog: the permission dialog) instead of letting it pass.
   */
  unranked?: true;
  /**
   * Where the requested model came from when it is not the call's own `model` (the definition behind the subagent
   * type, a subagent-model environment variable, a ladder pin): a parenthesised sentence the reasons carry.
   */
  sourceNote?: string;
};

/** A ladder definition name (`jev-ladder-<id>`, also as `<plugin>:jev-ladder-<id>`); see `ladderDefName` in the ladder-agents command. */
const LADDER_DEF_NAME = /(?:^|:)jev-ladder-([a-z0-9][a-z0-9-]*)$/i;

const defNameOf = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Pure: the model id a ladder definition pins, read from its `subagent_type`; null for any other type. The id is the
 * catalogue's own when one of its ids makes that definition name, else the name's suffix when it ranks as a Claude
 * model; a suffix that is no model (`jev-ladder-notes`) is not a ladder definition.
 */
export function pinnedLadderModel(subagentType: unknown, ctx?: RankContext | null): string | null {
  if (typeof subagentType !== 'string') return null;
  const suffix = LADDER_DEF_NAME.exec(subagentType.trim())?.[1]?.toLowerCase();
  if (!suffix) return null;
  try {
    const hit = ctx?.cat.models.find((m) => defNameOf(m.id) === suffix);
    if (hit) return hit.id;
  } catch {
    // a broken catalogue reads as none
  }
  return modelRank(suffix) !== null ? suffix : null;
}

/**
 * Pure: is this Agent call asking for a model stronger than the session's? Null for a call with no
 * model or "inherit" (it runs on the session model), a model at or below the session model, and an
 * unknown or missing session model. A model the user named in the current prompt, or a stronger one, is
 * their explicit request: `instructed`, never `elevating`.
 *
 * A call with no `model` whose `subagent_type` is a ladder definition (`jev-ladder-<id>`, optionally plugin-qualified)
 * runs the model that definition pins, so that id is the requested model (`pinnedLadderModel`).
 *
 * The family ladder (haiku < sonnet < opus < fable) decides across families (`compareFamilyFirst`); with a usable
 * catalogue (`ctx`) its tier, version and overrides refine same-family steps and overridden ids, falling back to
 * the family regex for an id the catalogue does not know. A requested id that nothing knows is unranked: with a
 * catalogue the call is `elevating` with `unranked` set (the guard asks); without one it passes, as before.
 * Two models of one family (a version step inside one alias) are not an elevation: the Agent tool cannot name a
 * version, so there is nothing a clamp or an answer could change per call.
 */
export function classifyElevation(
  call: AgentCall,
  sessionModel: string | null,
  intent?: UserIntent | null,
  ctx?: RankContext | null
): Elevation | null {
  // A call with no model of its own may still run a model: a ladder definition pins one in its name.
  const model = call.model || pinnedLadderModel(call.subagent_type, ctx);
  if (!model || !sessionModel) return null;
  // A model with a rank always has an alias (the two tables match), so there is always something to clamp to.
  const sessionAlias = modelAlias(sessionModel);
  if (!sessionAlias) return null;
  const sessionKnown = modelRank(sessionModel) !== null || catalogueKnows(ctx, sessionModel);
  if (!sessionKnown) return null;
  const requestedAlias = modelAlias(model);
  const requestedKnown = requestedAlias !== null || catalogueKnows(ctx, model);
  if (!requestedKnown) {
    // Nothing ranks it. "inherit" runs on the session model and passes; anything else is a model Jev cannot judge.
    if (!ctx || model.trim().toLowerCase() === 'inherit') return null;
    return { kind: 'elevating', requested: model, sessionModel, sessionAlias, unranked: true };
  }
  if (requestedAlias === sessionAlias) return null;
  const cmp = compareFamilyFirst(model, sessionModel, ctx);
  if (cmp === null || cmp <= 0) return null;
  // The instruction check is `>=`: a named model covers a weaker request too ("use opus" covers a sonnet call).
  const instructed = !!intent && intent.models.some((m) => (compareFamilyFirst(m, model, ctx) ?? -1) >= 0);
  return { kind: instructed ? 'instructed' : 'elevating', requested: model, sessionModel, sessionAlias };
}

/**
 * Pure: a stable signature of what a delegation is (subagent type and description), hashed, so the
 * clamp marker can say "the same delegation" without storing task text.
 */
export function callSignature(call: Record<string, unknown>): string {
  const part = (v: unknown): string => (typeof v === 'string' ? v : '');
  return createHash('sha1').update(`${part(call.subagent_type)}\u0000${part(call.description)}`).digest('hex').slice(0, 16);
}

/**
 * Pure: is the alias the clamp would use remapped for this session? `ANTHROPIC_DEFAULT_<ALIAS>_MODEL`
 * makes Claude Code resolve "sonnet" to some other model, so clamping to the alias would not run on the
 * session model. The hook then asks instead of clamping.
 */
export function aliasRemapped(alias: string, env: Record<string, string | undefined> | undefined): boolean {
  return !!env && !!env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
}

/**
 * The wording of the permission dialog for an elevating call (`JEV_ELEVATION=dialog`, the only mode that asks). It says what each answer does: in Claude Code No cancels
 * the call and stops the turn, and a comment typed with No lets the assistant continue.
 */
export function elevationAskReason(e: Elevation, gate?: OverGate): string {
  if (e.unranked) {
    return (
      `[jev] This delegation asks for model "${e.requested}"${e.sourceNote ?? ''}, which Jev's model catalogue does not know, so Jev cannot tell whether it is stronger than the session model "${e.sessionModel}". ` +
      `Yes runs it on ${e.requested}. No cancels the call and stops the turn; type a comment with No to let the assistant continue (for example "continue on ${e.sessionAlias}").`
    );
  }
  const cost = gate ? ` It ${gateCostSentence(gate)}.` : '';
  return (
    `[jev] This delegation asks for model "${e.requested}"${e.sourceNote ?? ''}, stronger than the session model "${e.sessionModel}".${cost} ` +
    `Yes runs it on ${e.requested}. No cancels the call and stops the turn; type a comment with No to let the assistant continue (for example "continue on ${e.sessionAlias}").`
  );
}

/** The dialog text (`JEV_ELEVATION=dialog`) of a delegation that is over the cost gate only because of its effort. */
export function effortAskReason(gate: OverGate): string {
  return `[jev] This delegation ${gateCostSentence(gate)}, because of its effort. Yes runs it as it is. No cancels the call and stops the turn.`;
}

/** Model-supplied text that reaches a deny reason: only characters a model id can carry, clipped. */
export function safeModelText(model: unknown): string {
  const clean = typeof model === 'string' ? model.replace(/[^A-Za-z0-9._:/@[\]-]/g, '').slice(0, 60) : '';
  return clean || 'unknown';
}

/**
 * The deny reason for a model Jev cannot rank (choice and clamp modes: they never ask, a harness that auto-approves would
 * approve a dialog unseen). A model the call itself wrote is fixed by omitting it; one a definition, ladder pin or
 * environment variable supplied is overridden by an explicit model on the call. From the third attempt of the same
 * delegation it also says to stop retrying (`stopRetryingText`).
 */
export function elevationUnrankedDenyReason(e: Elevation, attempt?: number | null): string {
  const stop = stopRetryingText(attempt, safeModelText(e.requested), e.sessionAlias, 'AskUserQuestion');
  const fix = e.sourceNote
    ? 're-invoke with an explicit model on the call (opus, sonnet or haiku, or inherit), which overrides it'
    : 're-invoke with opus, sonnet or haiku, or omit model / inherit';
  return `[jev] Jev cannot rank '${safeModelText(e.requested)}' (not in the catalogue, unknown family)${e.sourceNote ?? ''}; ${fix}.` + (stop ? ` ${stop}` : '');
}

/** The deny reason for a clamp that cannot run: the session alias is remapped, so the session model cannot be named. */
export function elevationRemappedDenyReason(e: Elevation, attempt?: number | null): string {
  const alias = safeModelText(e.sessionAlias);
  const stop = stopRetryingText(attempt, safeModelText(e.requested), e.sessionAlias, 'AskUserQuestion');
  return (
    `[jev] "${safeModelText(e.requested)}"${e.sourceNote ?? ''} is stronger than the session model "${e.sessionModel}" and the user did not ask for it: ` +
    `the session alias '${alias}' is remapped by ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL, so Jev cannot clamp to it; ` +
    `re-invoke with an explicit model at or below the session model (or inherit).` +
    (stop ? ` ${stop}` : '')
  );
}

/**
 * The deny reason for an agent definition Jev cannot read or that two files claim (choice and clamp modes). It names the
 * definition by subagent type only (the reader's text may quote the file) and says what cannot loop: an explicit model on the
 * call does not depend on the definition.
 */
export function unreadableDefinitionDenyReason(subagentType: unknown, sessionModel: string, attempt?: number | null): string {
  const alias = modelAlias(sessionModel) ?? 'inherit';
  const stop = stopRetryingText(attempt, `the "${safeTypeName(subagentType)}" definition`, alias, 'AskUserQuestion');
  return (
    `[jev] The agent definition for "${safeTypeName(subagentType)}" is unreadable or ambiguous, so Jev cannot tell which model this delegation runs on ` +
    `(session model "${sessionModel}"). Re-invoke with an explicit model on the call (for example "${alias}", or "inherit"); ` +
    `an explicit model on the call does not depend on the definition.` +
    (stop ? ` ${stop}` : '')
  );
}

/** How an elevating Agent call is handled. `choice` is the default; `dialog` is the 2.3.4 permission dialog; `clamp` is the 2.3.4 opt-in. */
export type ElevationMode = 'choice' | 'dialog' | 'clamp';

/** The value of `JEV_ELEVATION`: `dialog` and `clamp` are exact; anything else, including unset, means `choice`. */
export function elevationMode(env: Record<string, string | undefined> | undefined): ElevationMode {
  const v = env?.JEV_ELEVATION;
  return v === 'dialog' || v === 'clamp' ? v : 'choice';
}

/**
 * Claude Code's permission modes (the `permission_mode` field of every hook input) in which a hook `ask` is answered without
 * showing the user a dialog: `bypassPermissions` skips permission prompts altogether, and `auto` hands them to a classifier.
 * The others still show it or never approve it: `default` and `plan` show it, `acceptEdits` approves file edits only (an
 * Agent call still prompts), `dontAsk` denies whatever is not pre-approved. Used for a warning only (`auto_approve_warning`
 * on the decision row of a dialog-mode `ask`); it never changes a decision. An unknown or missing value is not auto-approve.
 */
const AUTO_APPROVE_PERMISSION_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'auto']);
export function isAutoApprovePermissionMode(permissionMode: unknown): boolean {
  return typeof permissionMode === 'string' && AUTO_APPROVE_PERMISSION_MODES.has(permissionMode);
}

/** The marker the choice question starts with, and the PostToolUse recorder's pattern for it. */
export const ELEVATE_MARKER_RE = /^\s*\[jev-elevate:(sonnet|opus|haiku|fable)(?::(low|medium|high|xhigh|max))?\]/;

/**
 * Option labels of the choice question, in order (2.3.21: exactly four, no timed scope). `no` names the session model's alias and
 * stands for this delegation only; `noSession` is the No for the rest of the session. The shared rules: src/core/elevation-answer.ts.
 */
export const CHOICE_LABELS = {
  once: ELEVATION_LABELS.yesOnce,
  session: ELEVATION_LABELS.yesSession,
  no: (sessionAlias: string): string => ELEVATION_LABELS.noOnce(sessionAlias),
  noSession: ELEVATION_LABELS.noSession
} as const;

/** A subagent type is model-supplied text that reaches the deny reason: keep only safe characters. */
export function safeTypeName(type: unknown): string {
  const clean = typeof type === 'string' ? type.replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 60) : '';
  return clean || 'general-purpose';
}

/**
 * The deny reason of the choice flow. A PreToolUse `deny` does not stop the turn: the assistant receives this
 * text, keeps working, and is told to ask the user the one prescribed question. The recorder
 * (`parseElevationAnswer`) reads the user's real answer from the harness, not from the assistant's text.
 *
 * The choice flow never ends in a permission dialog (a harness that auto-approves would approve it without showing it), so
 * from the third attempt of the same delegation (`attempt`) the reason also says to stop retrying (the text Antigravity
 * shares, see `stopRetryingText`).
 */
export function elevationChoiceReason(e: Elevation, subagentType?: unknown, attempt?: number | null, gate?: OverGate, stored?: StoredClause | null): string {
  const alias = modelAlias(e.requested) ?? e.requested;
  const l = CHOICE_LABELS;
  const stop = stopRetryingText(attempt, alias, e.sessionAlias, 'AskUserQuestion');
  const markerEffort = gate ? gateMarkerEffort(gate) : null;
  const marker = `[jev-elevate:${alias}${markerEffort ? `:${markerEffort}` : ''}]`;
  const why = gate ? `: this delegation ${gateCostSentence(gate)}` : '';
  // No: back on the session model, and at an effort that fits when the call's own is above it.
  const lowered = gate && gate.clampEffort !== gate.callEffort ? ` at effort: "${gate.clampEffort}"` : '';
  return (
    `[jev] "${alias}"${e.sourceNote ?? ''} is stronger than the session model "${e.sessionModel}" and the user has not approved it${why}. ` +
    `Ask the user with AskUserQuestion, one question, whose text STARTS with the marker ${marker} followed by a short question ` +
    `naming the subagent_type (${safeTypeName(subagentType)}), the requested model${gate ? ' and effort' : ''}, the session model and a 10-word task summary; ` +
    `exactly four options in this order and with these labels: ${elevationLabelList(l.no(e.sessionAlias))}. ` +
    `If the user picks a Yes, launch the delegation again with the same model${gate ? ' and effort' : ''}; if a No, launch it on ${e.sessionAlias}${lowered} (or do the work directly); ` +
    `If AskUserQuestion is not available, launch the delegation on ${e.sessionAlias}${lowered} now and do not stop; ` +
    `do not ask in any other form.` +
    (stored ? ` ${stored.text}` : '') +
    (stop ? ` ${stop}` : '')
  );
}

/**
 * The question to ask BEFORE the first Agent call, used by the UserPromptSubmit directive when the rating is
 * above the session model. Same marker and four options as the deny reason.
 */
export function elevationChoiceDirective(model: string, sessionModel: string | null, sessionAlias: string | null): string {
  const l = CHOICE_LABELS;
  const alias = modelAlias(model) ?? model;
  const no = sessionAlias ?? 'the session model';
  return (
    `ask the user before delegating on ${alias}, with AskUserQuestion: one question whose text STARTS with [jev-elevate:${alias}] followed by a short ` +
    `question naming the subagent_type, the model, the session model${sessionModel ? ` "${sessionModel}"` : ''} and a 10-word task summary; ` +
    `exactly four options in this order: ${elevationLabelList(l.no(no))}. ` +
    `On a Yes launch it on ${alias}; on a No launch it on ${no} (or do the work directly)`
  );
}

export type ApprovalScope = AnswerScope;

/**
 * What the user approved: a model, for the turn it was answered in (`once`, bound to `turn`) or the session. There is no clock (2.3.21).
 * A record from before 2.3.21 with the `5min` scope is dropped when read; its `expires_at` is ignored.
 */
export type Approval = {
  model: ClaudeModelAlias;
  scope: ApprovalScope;
  created_at: number;
  /** The effort the approval was given at (2.3.19): it covers that model at this effort or lower, never above what Jev prescribed. Absent: at most `high`. */
  effort?: EffortLevel;
  /** A `once` approval's turn: the prompt id (else the stored turn and its time) it was answered in. It is live only in that turn. */
  turn?: string;
};

/** A No: this delegation only (`once`, bound to `turn`: the next launch of that model or a stronger one runs on the session model) or the rest of the session. */
export type Decline = { model: ClaudeModelAlias; scope: ApprovalScope; created_at: number; turn?: string };

/** A No to the effort question: launches at `level` run at `noEffort`, once (this turn) or for the session. */
export type EffortDecline = { level: EffortLevel; noEffort: EffortLevel; scope: ApprovalScope; created_at: number; turn?: string };

/**
 * The per-session approvals file: the approvals, and the denied-attempt counter of one prompt. `count` is every
 * denied attempt of the prompt, `counts` the same per delegation signature (`callSignature`), `at` the epoch ms of
 * the last one. A file written before `counts` and `at` existed has neither.
 * `denied` maps a model alias to the epoch ms Jev last prescribed the choice question for it (a deny, or the turn
 * directive). Since 2.3.21 it has no expiry: it is the record of what Jev prescribed (with `deniedEffort`, the effort cap), not a
 * gate on the answer.
 */
export type ApprovalState = {
  approvals: Approval[];
  /** Effort approvals (`[jev-elevate-effort:<level>]`), apart from the model approvals; same scopes, same lock, same file. */
  effortApprovals?: EffortApproval[];
  /** An effort level to the epoch ms Jev last prescribed the effort question for it (no expiry). */
  effortDenied?: Record<string, number>;
  /** The model the effort question named, per effort level (the marker's `:<model>`): a bare answer is recorded for that model, never for any model. Absent: the question named none. */
  effortDeniedModel?: Record<string, ClaudeModelAlias>;
  /** The level the effort question's own No ran at, per effort level (`No, run at <level>`: the cost gate's, else `high`). A session No ("don't ask again") names no level, so it lowers to this one. */
  effortDeniedNo?: Record<string, EffortLevel>;
  denied?: Record<string, number>;
  /** The effort the model question was prescribed with, per model alias (2.3.19, no expiry): an answer cannot approve a higher effort than the question named. */
  deniedEffort?: Record<string, EffortLevel>;
  attempts?: { prompt: string; count: number; counts?: Record<string, number>; at?: number };
  /** The No answers to the model question (2.3.21). */
  declines?: Decline[];
  /** The No answers to the effort question (2.3.21). */
  effortDeclines?: EffortDecline[];
  /** The once approvals a launch used in the turn (model alias), so a later deny can say so. Only the current turn's marks are kept. */
  onceUsed?: OnceUsed[];
  /** The same for the effort once approvals (key: the level). */
  effortOnceUsed?: OnceUsed[];
};

/**
 * What an approval is read against: the turn a `once` must belong to, and the config for the `modeChangedAt` stamp (an approval,
 * a decline or a prescription older than the last mode change counts for nothing).
 */
export type ElevationCtx = { turn?: string; config?: ModeChangeConfigLike | null };

/** What the user approved for the effort of a delegation: a level (`xhigh` or `max`; `max` covers both), for one turn or the session. */
export type EffortApproval = {
  level: EffortLevel;
  scope: ApprovalScope;
  created_at: number;
  /** The model the effort was approved for (2.3.19): it covers that model, and a weaker one, at this level or lower. Absent: any model. */
  model?: ClaudeModelAlias;
  /** A `once` approval's turn, as for {@link Approval}. */
  turn?: string;
};

/** Most approvals (and declines) one file keeps. */
const ANSWERS_CAP = 24;

const voided = (createdAt: number, ectx?: ElevationCtx | null): boolean => denialPredatesModeChange(createdAt, ectx?.config, 'claude-code');
/** A stored answer that counts now: a session one, or a once of this turn; and not from before the last mode change. */
const usable = (a: { scope: ApprovalScope; turn?: string; created_at: number }, ectx?: ElevationCtx | null): boolean =>
  onceLive(a, ectx?.turn) && !voided(a.created_at, ectx);

/** The marker question of a PostToolUse payload for AskUserQuestion, read as far as it goes: which question it is, whether its marker parses, and the user's label. */
export type MarkerRead =
  | { kind: AnswerKind; marker: 'bad'; label: string | null }
  | { kind: 'model'; marker: 'ok'; model: ClaudeModelAlias; effort?: EffortLevel; label: string | null }
  | { kind: 'effort'; marker: 'ok'; level: EffortLevel; model?: ClaudeModelAlias; label: string | null };

const ANY_MARKER_RE = /^\s*\[jev-elevate(-effort)?:/i;

/**
 * Pure: the elevation or effort question of a PostToolUse payload for AskUserQuestion, or null when it is no such question. The
 * answer is `tool_response.answers[question]` and nothing else (`tool_input` is what the assistant sent, so it never counts);
 * `label` is null when there is no answer. Any question that starts with the marker prefix is one (the marker is not a secret);
 * `marker: 'bad'` says its marker names no known model or level.
 */
export function readMarkerAnswer(input: unknown): MarkerRead | null {
  try {
    const i = input as { tool_name?: unknown; tool_input?: any; tool_response?: any } | null;
    if (!i || typeof i !== 'object') return null;
    if (i.tool_name !== undefined && i.tool_name !== 'AskUserQuestion') return null;
    const question = i.tool_input?.questions?.[0]?.question;
    if (typeof question !== 'string') return null;
    const any = ANY_MARKER_RE.exec(question);
    if (!any) return null;
    const answer = i.tool_response?.answers?.[question];
    const label = typeof answer === 'string' ? answer.trim() : null;
    const kind: AnswerKind = any[1] ? 'effort' : 'model';
    if (kind === 'model') {
      const m = ELEVATE_MARKER_RE.exec(question);
      return m ? { kind, marker: 'ok', model: m[1] as ClaudeModelAlias, ...(m[2] ? { effort: m[2] as EffortLevel } : {}), label } : { kind, marker: 'bad', label };
    }
    const m = EFFORT_MARKER_RE.exec(question);
    return m ? { kind, marker: 'ok', level: m[1] as EffortLevel, ...(m[2] ? { model: m[2] as ClaudeModelAlias } : {}), label } : { kind, marker: 'bad', label };
  } catch {
    return null;
  }
}

/** The model question of a PostToolUse payload with a well-formed marker and an answer. */
function readElevationAnswer(input: unknown): { model: ClaudeModelAlias; label: string; effort?: EffortLevel } | null {
  const r = readMarkerAnswer(input);
  if (!r || r.kind !== 'model' || r.marker !== 'ok' || r.label === null) return null;
  return { model: r.model, label: r.label, ...(r.effort ? { effort: r.effort } : {}) };
}

/**
 * Pure: true when a PostToolUse payload for AskUserQuestion is the elevation question (the marker) answered with one of its No
 * options (`No, proceed on <alias>`, `No, don't ask again this session`). Another label, a missing answer and malformed input give false.
 * It lets the hook treat the user's decision to stay on the session model as final for the downgrade question too.
 */
export function parseElevationDecline(input: unknown): boolean {
  return elevationDeclinedModel(input) !== null;
}

/** Pure: the model alias of the elevation question that was answered with one of its No options, or null (see `parseElevationDecline`). */
export function elevationDeclinedModel(input: unknown): ClaudeModelAlias | null {
  const answer = readElevationAnswer(input);
  const parsed = answer ? parseAnswerLabel(answer.label, 'model') : null;
  return answer && parsed?.answer === 'no' ? answer.model : null;
}

/**
 * Pure: the approval a PostToolUse payload for AskUserQuestion carries, or null. Only a question that starts with
 * the marker counts (any such question, whoever wrote it); the answer is `tool_response.answers[question]` and nothing else,
 * and must be one of the exact Yes labels. A once is bound to `turn`. A No, another label, a missing answer and malformed input give null.
 * The effort is the marker's; `recordApproval` holds it to what Jev prescribed.
 */
export function parseElevationAnswer(input: unknown, nowMs: number, turn?: string): Approval | null {
  try {
    const read = readElevationAnswer(input);
    if (!read) return null;
    const parsed = parseAnswerLabel(read.label, 'model');
    if (!parsed || parsed.answer !== 'yes') return null;
    return {
      model: read.model,
      scope: parsed.scope,
      created_at: nowMs,
      ...(parsed.scope === 'once' && turn !== undefined ? { turn } : {}),
      ...(read.effort ? { effort: read.effort } : {})
    };
  } catch {
    return null;
  }
}

const SCOPE_PREFERENCE: Readonly<Record<ApprovalScope, number>> = { session: 0, once: 1 };

/** Pure: read a state object of unknown shape into a clean one (a corrupt file gives an empty state). A `5min` record from before 2.3.21 is dropped. */
export function normalizeApprovalState(raw: unknown): ApprovalState {
  const r = raw as { approvals?: unknown; attempts?: unknown; denied?: unknown } | null;
  const scopeOk = (s: unknown): s is ApprovalScope => s === 'once' || s === 'session';
  const turnOf = (x: { turn?: unknown }): { turn?: string } => (typeof x.turn === 'string' && x.turn ? { turn: x.turn } : {});
  const approvals = Array.isArray(r?.approvals)
    ? (r!.approvals as unknown[]).filter((a): a is Approval => {
        const x = a as Partial<Approval> | null;
        return !!x && typeof x.model === 'string' && modelRank(x.model) !== null && scopeOk(x.scope) && typeof x.created_at === 'number';
      }).map((a) => {
        const effort = costEffortOf((a as { effort?: unknown }).effort);
        return { model: a.model, scope: a.scope, created_at: a.created_at, ...turnOf(a), ...(effort ? { effort } : {}) } as Approval;
      })
    : [];
  const at = (r as { attempts?: { prompt?: unknown; count?: unknown; counts?: unknown; at?: unknown } } | null)?.attempts;
  const perSignature =
    at?.counts && typeof at.counts === 'object' && !Array.isArray(at.counts)
      ? Object.fromEntries(Object.entries(at.counts).filter(([, n]) => typeof n === 'number' && Number.isFinite(n)))
      : undefined;
  const attempts =
    at && typeof at.prompt === 'string' && typeof at.count === 'number'
      ? {
          prompt: at.prompt,
          count: at.count,
          ...(perSignature ? { counts: perSignature as Record<string, number> } : {}),
          ...(typeof at.at === 'number' ? { at: at.at } : {})
        }
      : undefined;
  const denied =
    r?.denied && typeof r.denied === 'object' && !Array.isArray(r.denied)
      ? Object.fromEntries(Object.entries(r.denied).filter(([m, t]) => modelRank(m) !== null && typeof t === 'number' && Number.isFinite(t)))
      : undefined;
  const effortApprovals = Array.isArray((r as { effortApprovals?: unknown } | null)?.effortApprovals)
    ? ((r as { effortApprovals: unknown[] }).effortApprovals).filter((a): a is EffortApproval => {
        const x = a as Partial<EffortApproval> | null;
        return !!x && EFFORT_LEVELS.includes(x.level as EffortLevel) && scopeOk(x.scope) && typeof x.created_at === 'number';
      }).map((a) => {
        const model = (a as { model?: unknown }).model;
        return {
          level: a.level,
          scope: a.scope,
          created_at: a.created_at,
          ...turnOf(a),
          ...(typeof model === 'string' && modelRank(model) !== null ? { model: model as ClaudeModelAlias } : {})
        } as EffortApproval;
      })
    : [];
  const declines = Array.isArray((r as { declines?: unknown } | null)?.declines)
    ? ((r as { declines: unknown[] }).declines).filter((d): d is Decline => {
        const x = d as Partial<Decline> | null;
        return !!x && typeof x.model === 'string' && modelRank(x.model) !== null && scopeOk(x.scope) && typeof x.created_at === 'number';
      }).map((d) => ({ model: d.model, scope: d.scope, created_at: d.created_at, ...turnOf(d) }) as Decline)
    : [];
  const effortDeclines = Array.isArray((r as { effortDeclines?: unknown } | null)?.effortDeclines)
    ? ((r as { effortDeclines: unknown[] }).effortDeclines).filter((d): d is EffortDecline => {
        const x = d as Partial<EffortDecline> | null;
        return !!x && EFFORT_LEVELS.includes(x.level as EffortLevel) && EFFORT_LEVELS.includes(x.noEffort as EffortLevel) && scopeOk(x.scope) && typeof x.created_at === 'number';
      }).map((d) => ({ level: d.level, noEffort: d.noEffort, scope: d.scope, created_at: d.created_at, ...turnOf(d) }) as EffortDecline)
    : [];
  const usedOf = (v: unknown): OnceUsed[] =>
    Array.isArray(v) ? v.filter((u): u is OnceUsed => !!u && typeof (u as OnceUsed).key === 'string' && typeof (u as OnceUsed).turn === 'string').map((u) => ({ key: u.key, turn: u.turn })) : [];
  const onceUsed = usedOf((r as { onceUsed?: unknown } | null)?.onceUsed);
  const effortOnceUsed = usedOf((r as { effortOnceUsed?: unknown } | null)?.effortOnceUsed);
  const rawEffortDenied = (r as { effortDenied?: unknown } | null)?.effortDenied;
  const effortDenied =
    rawEffortDenied && typeof rawEffortDenied === 'object' && !Array.isArray(rawEffortDenied)
      ? Object.fromEntries(Object.entries(rawEffortDenied).filter(([l, t]) => EFFORT_LEVELS.includes(l as EffortLevel) && typeof t === 'number' && Number.isFinite(t)))
      : undefined;
  const rawEffortDeniedModel = (r as { effortDeniedModel?: unknown } | null)?.effortDeniedModel;
  const effortDeniedModel =
    rawEffortDeniedModel && typeof rawEffortDeniedModel === 'object' && !Array.isArray(rawEffortDeniedModel)
      ? Object.fromEntries(Object.entries(rawEffortDeniedModel).filter(([l, m]) => EFFORT_LEVELS.includes(l as EffortLevel) && typeof m === 'string' && modelRank(m) !== null))
      : undefined;
  const rawEffortDeniedNo = (r as { effortDeniedNo?: unknown } | null)?.effortDeniedNo;
  const effortDeniedNo =
    rawEffortDeniedNo && typeof rawEffortDeniedNo === 'object' && !Array.isArray(rawEffortDeniedNo)
      ? Object.fromEntries(Object.entries(rawEffortDeniedNo).filter(([l, n]) => EFFORT_LEVELS.includes(l as EffortLevel) && EFFORT_LEVELS.includes(n as EffortLevel)))
      : undefined;
  const rawDeniedEffort = (r as { deniedEffort?: unknown } | null)?.deniedEffort;
  const deniedEffort =
    rawDeniedEffort && typeof rawDeniedEffort === 'object' && !Array.isArray(rawDeniedEffort)
      ? Object.fromEntries(Object.entries(rawDeniedEffort).filter(([m, l]) => modelRank(m) !== null && costEffortOf(l) !== null))
      : undefined;
  return {
    approvals,
    ...(deniedEffort && Object.keys(deniedEffort).length ? { deniedEffort: deniedEffort as Record<string, EffortLevel> } : {}),
    ...(effortApprovals.length ? { effortApprovals } : {}),
    ...(effortDenied && Object.keys(effortDenied).length ? { effortDenied: effortDenied as Record<string, number> } : {}),
    ...(effortDeniedModel && Object.keys(effortDeniedModel).length ? { effortDeniedModel: effortDeniedModel as Record<string, ClaudeModelAlias> } : {}),
    ...(effortDeniedNo && Object.keys(effortDeniedNo).length ? { effortDeniedNo: effortDeniedNo as Record<string, EffortLevel> } : {}),
    ...(declines.length ? { declines } : {}),
    ...(effortDeclines.length ? { effortDeclines } : {}),
    ...(onceUsed.length ? { onceUsed } : {}),
    ...(effortOnceUsed.length ? { effortOnceUsed } : {}),
    ...(attempts ? { attempts } : {}),
    ...(denied && Object.keys(denied).length ? { denied: denied as Record<string, number> } : {})
  };
}

/**
 * Pure: add an approval. A new `once` replaces the once approvals of other turns (they are never live again); the file keeps
 * at most {@link ANSWERS_CAP} approvals.
 */
export function addApproval(state: ApprovalState, approval: Approval, _nowMs?: number): ApprovalState {
  const keep = state.approvals.filter((a) => !(approval.scope === 'once' && a.scope === 'once' && a.turn !== approval.turn));
  return { ...state, approvals: [...keep, approval].slice(-ANSWERS_CAP) };
}

/**
 * Pure: note that the choice question was prescribed for `model` now. There is no expiry (2.3.21): the note is the record of what
 * Jev prescribed, and with `effort` (2.3.19: the question named an effort) the effort is noted too, so an answer cannot approve a
 * higher one. A later prescription for the same model replaces the earlier one.
 */
export function noteDenied(state: ApprovalState, model: string, nowMs: number, effort?: EffortLevel): ApprovalState {
  const key = modelAlias(model) ?? model;
  const { [key]: _old, ...otherEfforts } = state.deniedEffort ?? {};
  const deniedEffort = { ...otherEfforts, ...(effort ? { [key]: effort } : {}) };
  const { deniedEffort: _drop, ...rest } = state;
  return { ...rest, denied: { ...(state.denied ?? {}), [key]: nowMs }, ...(Object.keys(deniedEffort).length ? { deniedEffort } : {}) };
}

/**
 * Pure: when Jev last prescribed the choice question for `model` or a stronger one (epoch ms), or null when it has no note of one.
 * It lets a caller tell an answer to a question from before the last mode change.
 */
export function lastDeniedAtMs(state: ApprovalState, model: string): number | null {
  const want = modelRank(model);
  if (want === null) return null;
  const times = Object.entries(state.denied ?? {})
    .filter(([m]) => (modelRank(m) ?? -1) >= want)
    .map(([, t]) => t);
  return times.length ? Math.max(...times) : null;
}

/** Pure: the effort Jev prescribed for `model` (its own question's, kept without expiry), unless the prescription predates the last mode change. */
export function prescribedEffort(state: ApprovalState, model: string, config?: ModeChangeConfigLike | null): EffortLevel | undefined {
  const key = modelAlias(model) ?? model;
  const at = state.denied?.[key];
  if (at === undefined || voided(at, { config })) return undefined;
  return state.deniedEffort?.[key];
}

/**
 * Pure: the state with the user's Yes added (2.3.21: no window, no denial needed). The effort an approval carries is the one its
 * marker named, held to the effort Jev prescribed for the model; with none on record (a question asked before any denial, or a
 * prescription from before the last mode change) it carries none, which stands for at most `high`. A Yes for a model also drops
 * the declines it contradicts (a decline of that model or a weaker one). `approval` is what was stored.
 */
export function recordApproval(
  state: ApprovalState,
  approval: Approval,
  nowMs: number,
  config?: ModeChangeConfigLike | null
): { state: ApprovalState; approval: Approval } {
  const { effort: _marker, ...rest } = approval;
  const effort = cappedEffort(approval.effort, prescribedEffort(state, approval.model, config));
  const stored: Approval = effort ? { ...rest, effort } : rest;
  const rank = modelRank(stored.model) ?? 0;
  const declines = (state.declines ?? []).filter((d) => (modelRank(d.model) ?? Infinity) > rank);
  const { declines: _d, ...base } = state;
  return { state: addApproval({ ...base, ...(declines.length ? { declines } : {}) }, stored, nowMs), approval: stored };
}

/**
 * Pure: find the approval that covers `requested` (an approved model covers itself and anything below it) and
 * consume it when it is a `once` (marking it used in this turn). A session approval is preferred over a `once`, so a once is not
 * spent when something wider already covers the call. An approval that is not live is ignored: a `once` of another turn, and
 * anything from before the last mode change (`ectx`).
 *
 * With `effort` (2.3.19) the approval must also cover that effort: it was given at that effort or a higher one (an approval
 * with no effort stands for `high`). A call at an effort above the approval's is not covered, whatever its model.
 */
export function claimApproval(
  state: ApprovalState,
  requested: string,
  nowMs: number,
  ctx?: RankContext | null,
  effort?: EffortLevel,
  ectx?: ElevationCtx | null
): { state: ApprovalState; approval: Approval | null } {
  void nowMs;
  const want = modelRank(requested);
  const hit =
    want === null
      ? null
      : state.approvals
          .filter((a) => usable(a, ectx))
          .filter((a) => (compareFamilyFirst(a.model, requested, ctx) ?? -1) >= 0)
          .filter((a) => effort === undefined || effortWithin(approvalEffortOf(a), effort))
          .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, approval: null };
  if (hit.scope !== 'once') return { state, approval: hit };
  return { state: { ...state, approvals: state.approvals.filter((a) => a !== hit), onceUsed: markOnceUsed(state.onceUsed, hit.model, ectx?.turn) }, approval: hit };
}

/**
 * Pure: the state with a No to the model question added. A session No drops the approvals it contradicts (of that model or a stronger
 * one) and replaces earlier declines of the same model. A once No ("this delegation only") never withdraws the user's standing
 * "Yes, for this session": it drops only the unused once approvals it contradicts, so the session Yes is back in force at the next prompt.
 */
export function recordDecline(state: ApprovalState, decline: Decline): ApprovalState {
  const rank = modelRank(decline.model) ?? 0;
  const approvals = state.approvals.filter((a) => (modelRank(a.model) ?? -1) < rank || (decline.scope === 'once' && a.scope === 'session'));
  const declines = (state.declines ?? []).filter((d) => !(decline.scope === 'session' && d.model === decline.model) && !(decline.scope === 'once' && d.scope === 'once' && d.turn !== decline.turn));
  return { ...state, approvals, declines: [...declines, decline].slice(-ANSWERS_CAP) };
}

/**
 * Pure: the No that covers `requested` (a decline of a model covers itself and anything stronger), a session one before a `once` of
 * this turn, and consume the once. An approval of the same call is never looked at here: a Yes drops the declines it contradicts and
 * a No the approvals, so the two never overlap.
 */
export function claimDecline(
  state: ApprovalState,
  requested: string,
  ctx?: RankContext | null,
  ectx?: ElevationCtx | null
): { state: ApprovalState; decline: Decline | null } {
  const want = modelRank(requested);
  const hit =
    want === null
      ? null
      : (state.declines ?? [])
          .filter((d) => usable(d, ectx))
          .filter((d) => (compareFamilyFirst(requested, d.model, ctx) ?? -1) >= 0)
          .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, decline: null };
  if (hit.scope !== 'once') return { state, decline: hit };
  const declines = (state.declines ?? []).filter((d) => d !== hit);
  const { declines: _d, ...rest } = state;
  return { state: { ...rest, ...(declines.length ? { declines } : {}) }, decline: hit };
}

/** The clause a model deny reason adds: what Jev has stored for `requested` (see `storedClause`). Pure. */
export function elevationStoredClause(
  state: ApprovalState,
  requested: string,
  ctx?: RankContext | null,
  needEffort?: EffortLevel,
  ectx?: ElevationCtx | null
): StoredClause {
  const covering = state.approvals
    .filter((a) => !voided(a.created_at, ectx) && (compareFamilyFirst(a.model, requested, ctx) ?? -1) >= 0)
    .map((a) => ({ scope: a.scope, ...(a.turn !== undefined ? { turn: a.turn } : {}), effort: approvalEffortOf(a) }));
  const onceUsedThisTurn = (state.onceUsed ?? []).some((u) => ectx?.turn !== undefined && u.turn === ectx.turn && (compareFamilyFirst(u.key, requested, ctx) ?? -1) >= 0);
  return storedClause({
    kind: 'model',
    subject: modelAlias(requested) ?? requested,
    covering,
    turn: ectx?.turn,
    ...(needEffort ? { neededEffort: needEffort } : {}),
    onceUsedThisTurn
  });
}

// ── Effort approvals: the same question, scopes and rules as an elevation, for a level above the interim threshold ──

/** The marker the effort question starts with, and the PostToolUse recorder's pattern for it. */
export const EFFORT_MARKER_RE = /^\s*\[jev-elevate-effort:(low|medium|high|xhigh|max)(?::(sonnet|opus|haiku|fable))?\]/;

/** The last option of the effort question when no cost gate names a level: it re-invokes the delegation at `high`, an effort that passes. */
export const EFFORT_NO_LABEL = ELEVATION_LABELS.noEffort('high');
/** The effort a No re-invokes at. */
export const EFFORT_FALLBACK = 'high';

/** The effort question of a PostToolUse payload with a well-formed marker and an answer. */
function readEffortAnswer(input: unknown): { level: EffortLevel; label: string; model?: ClaudeModelAlias } | null {
  const r = readMarkerAnswer(input);
  if (!r || r.kind !== 'effort' || r.marker !== 'ok' || r.label === null) return null;
  return { level: r.level, label: r.label, ...(r.model ? { model: r.model } : {}) };
}

/** Pure: the effort approval a PostToolUse payload carries (a Yes to the effort question), or null; a No, any other label and anything else give null. A once is bound to `turn`. */
export function parseEffortAnswer(input: unknown, nowMs: number, turn?: string): EffortApproval | null {
  const read = readEffortAnswer(input);
  if (!read) return null;
  const parsed = parseAnswerLabel(read.label, 'effort');
  if (!parsed || parsed.answer !== 'yes') return null;
  return {
    level: read.level,
    scope: parsed.scope,
    created_at: nowMs,
    ...(parsed.scope === 'once' && turn !== undefined ? { turn } : {}),
    ...(read.model ? { model: read.model } : {})
  };
}

/** Pure: the No a PostToolUse payload for the effort question carries (`No, run at <level>`, or the session No, which names the level the question's own No would have), or null. */
export function parseEffortDecline(input: unknown, nowMs: number, turn?: string): EffortDecline | null {
  const read = readEffortAnswer(input);
  if (!read) return null;
  const parsed: ParsedAnswer | null = parseAnswerLabel(read.label, 'effort');
  if (!parsed || parsed.answer !== 'no') return null;
  const named = parsed.noTarget ? costEffortOf(parsed.noTarget) : null;
  // The session No names no level: lowering goes to `high`, the level every No of the effort question stands for at most.
  const noEffort = (parsed.scope === 'once' ? named : (named ?? (EFFORT_FALLBACK as EffortLevel))) as EffortLevel | null;
  if (!noEffort) return null;
  return { level: read.level, noEffort, scope: parsed.scope, created_at: nowMs, ...(parsed.scope === 'once' && turn !== undefined ? { turn } : {}) };
}

/**
 * Pure: note that the effort question was prescribed for `level` now (no expiry), with the model its marker named and the level its own No
 * runs at (`noEffort`: a session No, which names no level, lowers to it).
 */
export function noteEffortDenied(state: ApprovalState, level: EffortLevel, nowMs: number, model?: string, noEffort?: EffortLevel): ApprovalState {
  const alias = model !== undefined ? modelAlias(model) : null;
  // The model the question named, per level: replaced for this one (none when the question named none).
  const models = Object.fromEntries(Object.entries(state.effortDeniedModel ?? {}).filter(([l]) => l !== level));
  const { effortDeniedModel: _drop, ...rest } = state;
  const effortDeniedModel = { ...models, ...(alias ? { [level]: alias } : {}) };
  const { effortDeniedNo: _no, ...restNo } = rest;
  const nos = { ...Object.fromEntries(Object.entries(state.effortDeniedNo ?? {}).filter(([l]) => l !== level)), ...(noEffort ? { [level]: noEffort } : {}) };
  return {
    ...restNo,
    effortDenied: { ...(state.effortDenied ?? {}), [level]: nowMs },
    ...(Object.keys(effortDeniedModel).length ? { effortDeniedModel } : {}),
    ...(Object.keys(nos).length ? { effortDeniedNo: nos as Record<string, EffortLevel> } : {})
  };
}

/**
 * Pure: the state with the user's Yes to the effort question added (2.3.21: no window, no denial needed). The level is held to the
 * highest level Jev prescribed the effort question for (no expiry; a prescription from before the last mode change does not
 * count); with none on record it is held to `high`. When the prescribed question named a model, an answer is recorded for THAT model:
 * a bare marker never becomes an approval for any model, and a marker naming a stronger one is held to the prescribed one. A question
 * that named none (a record from before 2.3.19, or the interim rule) leaves the answer as it is.
 */
export function recordEffortApproval(
  state: ApprovalState,
  approval: EffortApproval,
  nowMs: number,
  config?: ModeChangeConfigLike | null
): { state: ApprovalState; approval: EffortApproval } {
  void nowMs;
  const prescriptions = Object.entries(state.effortDenied ?? {}).filter(([, t]) => !voided(t, { config }));
  const highest = prescriptions.map(([l]) => l as EffortLevel).sort((a, b) => effortIndex(b) - effortIndex(a))[0];
  const cap: EffortLevel = highest ?? (EFFORT_FALLBACK as EffortLevel);
  const level = effortIndex(approval.level) <= effortIndex(cap) ? approval.level : cap;
  // Looked up with the CAPPED level: a marker naming a higher level than any prescription must still find the prescription the cap
  // came from, or the stored approval would keep a bare marker's "no model" and cover every model.
  const latest = prescriptions.filter(([l]) => effortCovers(l, level)).sort((a, b) => b[1] - a[1])[0];
  const prescribed = latest ? state.effortDeniedModel?.[latest[0]] : undefined;
  const { model: _m, ...rest } = approval;
  const model = prescribed
    ? approval.model && (modelRank(approval.model) ?? Infinity) <= (modelRank(prescribed) ?? -1) ? approval.model : prescribed
    : approval.model;
  const stored: EffortApproval = { ...rest, level, ...(model ? { model } : {}) };
  const keep = (state.effortApprovals ?? []).filter((a) => !(stored.scope === 'once' && a.scope === 'once' && a.turn !== stored.turn));
  const declines = (state.effortDeclines ?? []).filter((d) => !(effortCovers(stored.level, d.level)));
  const { effortDeclines: _ed, ...base } = state;
  return { state: { ...base, effortApprovals: [...keep, stored].slice(-ANSWERS_CAP), ...(declines.length ? { effortDeclines: declines } : {}) }, approval: stored };
}

/**
 * Pure: the effort approval that covers `level` (a higher approved level covers a lower one), a standing one before a `once`,
 * which is consumed (and marked used in this turn). An approval that is not live is ignored (see `claimApproval`). With `model`
 * (2.3.19) an approval that names a model must be for that model or a stronger one; an approval that names none (a record from
 * before 2.3.19) covers any model. The caller always passes the call's model alias: without one (or one that cannot be ranked) an
 * approval that names a model does not cover the call.
 */
export function claimEffortApproval(
  state: ApprovalState,
  level: EffortLevel,
  nowMs: number,
  model?: string,
  ectx?: ElevationCtx | null
): { state: ApprovalState; approval: EffortApproval | null } {
  void nowMs;
  const wantRank = model === undefined ? null : modelRank(model);
  // A model-scoped approval covers only a model it can be compared with: a call whose model is not known (or not passed) is not covered by one.
  const hit = (state.effortApprovals ?? [])
    .filter((a) => usable(a, ectx))
    .filter((a) => effortCovers(a.level, level))
    .filter((a) => !a.model || (wantRank !== null && (modelRank(a.model) ?? -1) >= wantRank))
    .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, approval: null };
  if (hit.scope !== 'once') return { state, approval: hit };
  const effortApprovals = (state.effortApprovals ?? []).filter((a) => a !== hit);
  const { effortApprovals: _drop, ...rest } = state;
  return { state: { ...rest, ...(effortApprovals.length ? { effortApprovals } : {}), effortOnceUsed: markOnceUsed(state.effortOnceUsed, hit.level, ectx?.turn) }, approval: hit };
}

/**
 * Pure: the decline as it is stored. A session No ("don't ask again") names no level, so it lowers to the level the question's own No
 * ran at (the cost gate's `No, run at <level>`, which can be below `high`), as noted when Jev prescribed the question; with none on
 * record (or from before the last mode change) it is `high`. A once No names its level in its label and is kept as it is.
 */
export function resolveEffortDecline(state: ApprovalState, decline: EffortDecline, config?: ModeChangeConfigLike | null): EffortDecline {
  if (decline.scope !== 'session') return decline;
  const at = state.effortDenied?.[decline.level];
  const noted = at !== undefined && !voided(at, { config }) ? state.effortDeniedNo?.[decline.level] : undefined;
  return noted ? { ...decline, noEffort: noted } : decline;
}

/** Pure: the state with a No to the effort question added; a session No replaces earlier declines of the same level and drops that level's approvals, a once No only the unused once approvals (see `recordDecline`). */
export function recordEffortDecline(state: ApprovalState, decline: EffortDecline): ApprovalState {
  const approvals = (state.effortApprovals ?? []).filter((a) => a.level !== decline.level || (decline.scope === 'once' && a.scope === 'session'));
  const declines = (state.effortDeclines ?? []).filter((d) => !(decline.scope === 'session' && d.level === decline.level) && !(decline.scope === 'once' && d.scope === 'once' && d.turn !== decline.turn));
  const { effortApprovals: _a, ...rest } = state;
  return { ...rest, ...(approvals.length ? { effortApprovals: approvals } : {}), effortDeclines: [...declines, decline].slice(-ANSWERS_CAP) };
}

/** Pure: the No that covers `level` exactly (a session one before a `once` of this turn), consuming the once. */
export function claimEffortDecline(state: ApprovalState, level: EffortLevel, ectx?: ElevationCtx | null): { state: ApprovalState; decline: EffortDecline | null } {
  const hit = (state.effortDeclines ?? [])
    .filter((d) => usable(d, ectx))
    .filter((d) => d.level === level)
    .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, decline: null };
  if (hit.scope !== 'once') return { state, decline: hit };
  const effortDeclines = (state.effortDeclines ?? []).filter((d) => d !== hit);
  const { effortDeclines: _d, ...rest } = state;
  return { state: { ...rest, ...(effortDeclines.length ? { effortDeclines } : {}) }, decline: hit };
}

/** The clause an effort deny reason adds: what Jev has stored for the effort `level` (and `model`, when the call names one). Pure. */
export function effortStoredClause(state: ApprovalState, level: EffortLevel, model?: string, ectx?: ElevationCtx | null): StoredClause {
  const wantRank = model === undefined ? null : modelRank(model);
  const matches = (a: EffortApproval): boolean => !a.model || (wantRank !== null && (modelRank(a.model) ?? -1) >= wantRank);
  const covering = (state.effortApprovals ?? [])
    .filter((a) => !voided(a.created_at, ectx) && matches(a))
    .map((a) => ({ scope: a.scope, ...(a.turn !== undefined ? { turn: a.turn } : {}), effort: a.level as EffortLevel }));
  const onceUsedThisTurn = (state.effortOnceUsed ?? []).some((u) => ectx?.turn !== undefined && u.turn === ectx.turn && effortCovers(u.key, level));
  return storedClause({ kind: 'effort', subject: level, covering, turn: ectx?.turn, neededEffort: level, onceUsedThisTurn });
}

/**
 * Pure: consume, in one step, every approval a call needs (`model`: the covering model approval, `effort`: the covering effort
 * approval; `decline` / `effortDecline`: the No that lowers the call), or none of them. A `once` is spent only when everything wanted
 * is still there, so a call that cannot go ahead never spends one of its answers (one answer, one run). Null when any wanted answer
 * is gone (a parallel call spent it, or it is not live any more): nothing is consumed then.
 */
export function consumeApprovals(
  state: ApprovalState,
  wants: {
    model?: { requested: string; ctx?: RankContext | null; effort?: EffortLevel };
    effort?: EffortLevel;
    effortModel?: string;
    decline?: { requested: string; ctx?: RankContext | null };
    effortDecline?: { level: EffortLevel };
  },
  nowMs: number,
  ectx?: ElevationCtx | null
): { state: ApprovalState; model: Approval | null; effort: EffortApproval | null; decline: Decline | null; effortDecline: EffortDecline | null } | null {
  let next = state;
  let model: Approval | null = null;
  let effort: EffortApproval | null = null;
  let decline: Decline | null = null;
  let effortDecline: EffortDecline | null = null;
  if (wants.model) {
    const c = claimApproval(next, wants.model.requested, nowMs, wants.model.ctx, wants.model.effort, ectx);
    if (!c.approval) return null;
    next = c.state;
    model = c.approval;
  }
  if (wants.decline) {
    const c = claimDecline(next, wants.decline.requested, wants.decline.ctx, ectx);
    if (!c.decline) return null;
    next = c.state;
    decline = c.decline;
  }
  if (wants.effort) {
    const c = claimEffortApproval(next, wants.effort, nowMs, wants.effortModel, ectx);
    if (!c.approval) return null;
    next = c.state;
    effort = c.approval;
  }
  if (wants.effortDecline) {
    const c = claimEffortDecline(next, wants.effortDecline.level, ectx);
    if (!c.decline) return null;
    next = c.state;
    effortDecline = c.decline;
  }
  return { state: next, model, effort, decline, effortDecline };
}

/** The cost gate verdict that needs approval (the `over` arm of `CostGate`). */
export type OverGate = Extract<CostGate, { kind: 'over' }>;

/** A model id as a reason text writes it: its alias when it has one. */
export const gateModelLabel = (m: unknown): string => (typeof m === 'string' ? (modelAlias(m) ?? safeModelText(m)) : 'the session model');

/** The cost sentence of a reason: "costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)". */
export const gateCostSentence = (g: CostGateFacts): string => costComparison(g, gateModelLabel);

/** The effort part of the model question's marker: only an effort above `high` is written (a bare marker stands for at most `high`, as before 2.3.19). */
export const gateMarkerEffort = (g: Pick<CostGateFacts, 'callEffort'>): EffortLevel | null => (effortIndex(g.callEffort) > effortIndex('high') ? g.callEffort : null);

/**
 * The deny reason of the effort flow: the same prescribed-question shape as the elevation choice, with the marker
 * `[jev-elevate-effort:<level>]` and a No that re-invokes at a lower effort. Without a cost gate (the cost cannot be computed:
 * the interim rule, `xhigh` and `max`) `interim` is the finding's own wording and a No re-invokes at `high`. With one
 * (2.3.19) the reason states the cost, the marker names the model (`[jev-elevate-effort:<level>:<model>]`) and a No runs at the
 * highest effort that keeps the cost within the session's (at most `high`). From the third attempt of the same delegation it
 * also says to stop retrying (`stopRetryingText`).
 */
export function effortChoiceReason(level: EffortLevel, interim: string, subagentType?: unknown, attempt?: number | null, gate?: OverGate, stored?: StoredClause | null): string {
  const fallback = gate ? gate.noEffort : EFFORT_FALLBACK;
  const no = gate ? ELEVATION_LABELS.noEffort(gate.noEffort) : EFFORT_NO_LABEL;
  const stop = stopRetryingText(attempt, level, fallback, 'AskUserQuestion', 'effort');
  const alias = gate ? modelAlias(typeof gate.callModel === 'string' ? gate.callModel : null) : null;
  const marker = `[jev-elevate-effort:${level}${alias ? `:${alias}` : ''}]`;
  const head = gate ? `This delegation ${gateCostSentence(gate)}, because of its effort.` : interim;
  return (
    `[jev] ${head} The user has not approved it. ` +
    `Ask the user with AskUserQuestion, one question, whose text STARTS with the marker ${marker} followed by a short question ` +
    `naming the subagent_type (${safeTypeName(subagentType)}), the requested effort, and a 10-word task summary; ` +
    `exactly four options in this order and with these labels: ${elevationLabelList(no)}. ` +
    `If the user picks a Yes, launch the delegation again with the same effort; if a No, launch it with effort: "${fallback}" (or do the work directly); ` +
    `If AskUserQuestion is not available, launch the delegation with effort: "${fallback}" now and do not stop; ` +
    `do not ask in any other form.` +
    (stored ? ` ${stored.text}` : '') +
    (stop ? ` ${stop}` : '')
  );
}


/** All denied attempts of one prompt, over every delegation, after which every attempt counts as a repeat (the stop-retrying text) whatever the signatures say. */
export const ATTEMPT_TOTAL_CAP = 20;

/**
 * A prompt key that is not the host's prompt id (a stored turn without a timestamp, or none at all) cannot tell two
 * prompts apart, so its counter also expires after this long without an attempt.
 */
export const ATTEMPT_FALLBACK_WINDOW_MS = 5 * 60 * 1000;

/**
 * Pure: count one denied elevating attempt of delegation `signature` in `prompt`, and return the count of that
 * delegation (a different prompt starts again at one). Counting per delegation means three different workstreams
 * that are each denied, answered and retried are three first attempts, not a third attempt; only the same
 * delegation ignored again and again (or `ATTEMPT_TOTAL_CAP` denials of the prompt) gets the stop-retrying text.
 *
 * With `windowMs` (the key is a fallback, not the host's prompt id) a counter whose last attempt is older than the
 * window starts again, so two prompts with the same text do not share one.
 */
export function bumpAttempts(
  state: ApprovalState,
  prompt: string,
  signature = '',
  nowMs?: number,
  windowMs?: number
): { state: ApprovalState; count: number } {
  const prev = state.attempts;
  const stale = windowMs !== undefined && nowMs !== undefined && prev?.at !== undefined && nowMs - prev.at > windowMs;
  const same = !!prev && prev.prompt === prompt && !stale;
  const total = same ? prev.count + 1 : 1;
  const counts = same ? { ...(prev.counts ?? {}) } : {};
  const mine = (counts[signature] ?? 0) + 1;
  if (signature in counts || Object.keys(counts).length < ATTEMPT_TOTAL_CAP) counts[signature] = mine;
  const count = total > ATTEMPT_TOTAL_CAP ? Math.max(mine, STOP_RETRYING_FROM_ATTEMPT) : mine;
  return { state: { ...state, attempts: { prompt, count: total, counts, ...(nowMs !== undefined ? { at: nowMs } : {}) } }, count };
}

/** The note the assistant gets with a clamped call: what Jev did, and what to do next (report, ask in chat, no re-call). */
export function elevationClampContext(e: Elevation): string {
  return (
    `[jev] Jev ran this delegation on ${e.sessionAlias} instead of ${e.requested}, because ${e.requested} is stronger than the session model ` +
    `"${e.sessionModel}" and the user did not ask for it in this prompt. Do not call it again on your own. Report the result, and if ` +
    `${e.requested} is really needed, ask the user in chat; a reply naming ${e.requested} passes without another prompt.`
  );
}

/**
 * The PreToolUse output that runs the call on the session model with no dialog: `allow` plus the whole
 * original tool input with `model` replaced (`updatedInput` replaces the input, so every original field is
 * copied) plus the note for the assistant.
 */
export function clampElevation(call: Record<string, unknown>, e: Elevation): { hookSpecificOutput: Record<string, unknown> } {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[jev] Elevation clamped: ${e.requested} to ${e.sessionAlias} (the session model).`,
      updatedInput: { ...call, model: e.sessionAlias },
      additionalContext: elevationClampContext(e)
    }
  };
}

/**
 * The clamp of the cost gate (`JEV_ELEVATION=clamp`, 2.3.19): the most expensive (model, effort) that keeps the call within the
 * cost it is held to. When the model is what is too much the call runs on the session's model (`sessionAlias`); the effort is
 * lowered to the highest level that fits and is written on the call only when it differs from the effort the call would have
 * had. Same output shape as {@link clampElevation}: `allow` plus the whole original input with `model` and `effort` replaced.
 */
export function clampOverGate(
  call: Record<string, unknown>,
  gate: OverGate,
  sessionAlias: ClaudeModelAlias | null
): { hookSpecificOutput: Record<string, unknown>; model: string | null; effort: EffortLevel } {
  const model = gate.clampModel ? sessionAlias : null;
  const effortChanged = gate.clampEffort !== gate.callEffort;
  const callLabel = gateModelLabel(gate.callModel);
  const to = `${model ?? callLabel} at ${gate.clampEffort}`;
  const updatedInput: Record<string, unknown> = { ...call, ...(model ? { model } : {}), ...(effortChanged ? { effort: gate.clampEffort } : {}) };
  return {
    model,
    effort: gate.clampEffort,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[jev] Cost gate clamped: ${callLabel} at ${gate.callEffort} to ${to} (${gateCostSentence(gate)}).`,
      updatedInput,
      additionalContext:
        `[jev] Jev ran this delegation on ${to} instead of ${callLabel} at ${gate.callEffort}, because it ${gateCostSentence(gate)} and the user did not ask for it in this prompt. ` +
        `Do not call it again on your own. Report the result, and if ${callLabel} at ${gate.callEffort} is really needed, ask the user in chat; a reply naming it passes without another prompt.`
    }
  };
}

/**
 * The PreToolUse output of a call the user declined (2.3.21): the model question's No (`scope` `once`: the next launch of this turn;
 * `session`: every later launch, silently) runs the delegation on the session model with no question and no deny. Same shape as the
 * clamp (`allow` plus the whole original input with `model` replaced, and the effort lowered when the enforced cost gate holds the
 * call, see {@link clampOverGate}), with its own note for the assistant.
 */
export function clampDeclinedModel(
  call: Record<string, unknown>,
  e: Elevation,
  scope: ApprovalScope,
  gate?: OverGate | null
): { hookSpecificOutput: Record<string, unknown>; effort?: EffortLevel } {
  const base = gate ? clampOverGate(call, gate, e.sessionAlias) : clampElevation(call, e);
  const effort = gate ? (base as ReturnType<typeof clampOverGate>).effort : undefined;
  const when = scope === 'session' ? 'for this session' : 'for this delegation';
  return {
    ...(effort ? { effort } : {}),
    hookSpecificOutput: {
      ...base.hookSpecificOutput,
      permissionDecisionReason: `[jev] The user declined ${e.requested} ${when}: ran on ${e.sessionAlias} (the session model).`,
      additionalContext:
        `[jev] Jev ran this delegation on ${e.sessionAlias} instead of ${e.requested}, because the user declined ${e.requested} ${when}. ` +
        `Do not ask the user about ${e.requested} again${scope === 'session' ? ' in this session' : ' for this delegation'}; report the result.`
    }
  };
}

/** The PreToolUse output of a call whose effort the user declined (2.3.21): `allow` plus the whole original input with `effort` lowered to the No level. */
export function clampDeclinedEffort(
  call: Record<string, unknown>,
  decline: Pick<EffortDecline, 'level' | 'noEffort' | 'scope'>
): { hookSpecificOutput: Record<string, unknown> } {
  const when = decline.scope === 'session' ? 'for this session' : 'for this delegation';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[jev] The user declined effort ${decline.level} ${when}: ran at ${decline.noEffort}.`,
      updatedInput: { ...call, effort: decline.noEffort },
      additionalContext:
        `[jev] Jev ran this delegation at effort ${decline.noEffort} instead of ${decline.level}, because the user declined ${decline.level} ${when}. ` +
        `Do not ask the user about it again${decline.scope === 'session' ? ' in this session' : ' for this delegation'}; report the result.`
    }
  };
}

/**
 * The deny reason of a Workflow whose script holds a model (or an effort) the user declined (2.3.21): a script cannot be run on
 * another model, so it is denied, but without the question: the user already said No, so the reason says to edit the script.
 */
export function workflowDeclinedReason(what: string, sessionAlias: string, scope: ApprovalScope): string {
  const when = scope === 'session' ? 'for this session' : 'for this delegation';
  return `[jev] The user declined ${what} ${when}. Do not ask again: edit the workflow script so no agent() call uses it (use ${sessionAlias} or a weaker model, or omit it), then run it.`;
}

/**
 * The deterministic check on an Agent tool call: is it a model stronger than the session's with no
 * instruction from the user? A missing model or "inherit" runs on the session model and is never
 * stronger, so it passes, and so does a model pinned at or below the session model. A model the user
 * named in the current prompt (or a stronger one) is their explicit request and is not asked about.
 *
 * Every such call asks here (the 2.3.3 behaviour, now `JEV_ELEVATION=dialog`). Claude Code shows `ask` as a permission
 * dialog with Yes and No. No cancels the call and stops the turn, and a comment typed with No lets the assistant
 * continue, so the reason says what each answer does. The hook itself does not call this: its default is the choice flow
 * (a deny) and the opt-in `JEV_ELEVATION=clamp` clamps every such call to the session model (`clampElevation`).
 *
 * Jev's tier rating of the task is deliberately not a gate. It is advice (the UserPromptSubmit
 * directive) and telemetry (`recommended_model` in the PreToolUse log). A `pro` rating is not a
 * permission question when the call runs at or below the ceiling; a dialog for it fired on every
 * delegation pinned to the session model (case study 2026-11-11).
 */
export function decideAgentCall(call: AgentCall, sessionModel: string | null, intent?: UserIntent | null): AgentDecision {
  const e = classifyElevation(call, sessionModel, intent);
  if (!e || e.kind !== 'elevating') return null;
  return { decision: 'ask', reason: elevationAskReason(e), cause: e.unranked ? 'unranked' : 'tier' };
}

/**
 * Warn-only notice for settings that change what a recommendation means: an `ANTHROPIC_DEFAULT_*_MODEL`
 * variable remaps a model alias (the advice says "opus", Claude Code runs something else) and
 * `CLAUDE_CODE_EFFORT_LEVEL` overrides the effort the advice names. Names only, never values.
 * It is logged, never shown to the user and never blocks. Undefined when nothing is set.
 */
export function envNotice(env: Record<string, string | undefined>): string | undefined {
  const remaps = ['HAIKU', 'SONNET', 'OPUS'].map((m) => `ANTHROPIC_DEFAULT_${m}_MODEL`).filter((k) => env[k]);
  const notes = [
    ...(remaps.length ? [`${remaps.join(', ')} remaps the model alias`] : []),
    ...(env.CLAUDE_CODE_EFFORT_LEVEL ? ['CLAUDE_CODE_EFFORT_LEVEL overrides the advised effort'] : [])
  ];
  return notes.length ? notes.join('; ') : undefined;
}

/** Keep only characters that are safe in a file name. */
export function safeSessionId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length ? clean : null;
}

/** The dispatch tools whose telemetry lines count as a pre-flight. */
const DISPATCH_TOOLS = new Set(['jev_dispatch', 'jev_batch_dispatch']);

/**
 * Pure: does any telemetry line record a successful dispatch tool call from Claude Code within
 * `windowMs` of `nowMs`? The tools record no session id, so this is by time and harness: with two
 * Claude sessions open, a dispatch in one silences the reminder in the other. A false "yes" only
 * costs a missed reminder, never a blocked call. A failed call (`status: 'error'`) gave no tiers
 * to follow, so it does not count.
 */
export function hasRecentDispatch(lines: ReadonlyArray<string>, nowMs: number, windowMs: number): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as { tool?: unknown; timestamp?: unknown; harness?: unknown; status?: unknown; error?: unknown };
      if (typeof entry.tool !== 'string' || !DISPATCH_TOOLS.has(entry.tool)) continue;
      if (entry.harness !== 'claude-code') continue;
      if (entry.status === 'error' || entry.error !== undefined) continue;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(at) && nowMs - at <= windowMs && at <= nowMs + 60_000) return true;
    } catch {
      // skip a malformed line
    }
  }
  return false;
}

/** Window in which an earlier dispatch call counts as the pre-flight for an Agent launch. */
export const PREFLIGHT_WINDOW_MS = 30 * 60 * 1000;

/** Agent calls and reminders are counted over this window. */
export const AGENT_WINDOW_MS = 10 * 60 * 1000;

/** Agent calls already made in the window before a further one counts as part of a staged plan (the third call). */
export const STAGED_AGENT_CALLS = 2;

/**
 * The reminder added to the turn context when the prompt names a workflow or workstreams. The router sees
 * one prompt and returns one tuple; a plan with several streams needs one tier per stream, which
 * `jev_batch_dispatch` returns from the caller's own classification (`kind`, `needsEdit`) and the stage rubric.
 */
export const STAGE_PLAN_REMINDER =
  'This looks like staged work. Before launching it, call jev_batch_dispatch with one task per stream ' +
  '(kind: mechanical | settled-edit | judgement; needsEdit: true when the stream edits files) and follow its tiers per stream, ' +
  'not the single recommendation above.';

/**
 * The reminder added to a staged delegation when mode is on and no dispatch call preceded it. It names
 * the tool, the `kind` and `needsEdit` fields of the stages, and the rubric, and never blocks.
 */
export function preflightReminder(toolName: string): string {
  return (
    `[JEV] ${toolName} is about to delegate, and no jev_dispatch or jev_batch_dispatch call from Claude Code shows in the last 30 minutes. ` +
    `For staged work, call jev_batch_dispatch with one task per stream first (kind: mechanical | settled-edit | judgement; needsEdit: true when the stream edits files) and follow its tiers. ${STAGE_RUBRIC_TEXT} ` +
    "The session model stays the ceiling, and a model you named is used within one tier step of Jev's recommendation. This is a reminder, not a block."
  );
}

export const PREFLIGHT_REMINDER = preflightReminder('Agent');

// ── Turns that need no advice (5.5) ──────────────────────────────────────────

/** The part of a prompt sent to Jev: pasted material must not dominate the decision. */
export const TASK_TRIM_CHARS = 2000;
/** A prompt this long is a paste, not a task: no advice at all. */
export const PASTE_SKIP_CHARS = 20_000;

/** Prompts the host injects on the user's behalf, never a task of the user's. */
const SYSTEM_TURN = /^\s*<(?:task-notification|local-command-[a-z]+|bash-(?:input|stdout|stderr)|system-reminder)\b/i;

/** True for a turn the host injected on the user's behalf (a task notification, a local command): not a new user turn. */
export function isHostInjectedPrompt(prompt: string): boolean {
  return SYSTEM_TURN.test(prompt);
}

/** True for a prompt that carries no delegation intent by its shape alone, before any Jev call. */
export function isNonTaskPrompt(prompt: string): boolean {
  return isHostInjectedPrompt(prompt) || prompt.length > PASTE_SKIP_CHARS;
}

/**
 * Generous on purpose: the cost of a missed hint is small, but the cost of a wrong silence is a
 * task that gets no advice. Anything that reads like work counts.
 */
const WORK_VERB =
  /\b(?:write|edit|fix|add|create|implement|refactor|run\s+(?:the|a|an|it|this|that|all|my|each|every|bun|npm|make|git)|build|port|update|delete|remove|rename|change|move|review|check|test|find|search|read|explain|plan|design|commit|push|open|start|fold|launch|spawn|delegate|proceed|go ahead|deploy|install|analy[sz]e|summari[sz]e|investigate|debug|migrate|draft|document|list|show|look|verify|clean|merge|rewrite|generate|convert|set up|workflow|workstreams?)\b/i;

/**
 * A status or acknowledgement turn: Jev says `self` on a cheap tier and the prompt holds no verb of
 * work ("A3 completed the run", "thanks, looks good"). The user's explicit instruction always counts.
 * It needs Jev's recommendation, so the call to Jev has already been made when this is asked.
 */
export function isStatusTurn(rec: Pick<Dispatch, 'subagent' | 'tier'>, task: string, intent: UserIntent = NO_INTENT): boolean {
  if (intent.models.length > 0 || intent.cost) return false;
  const cheap = rec.tier === 'flash_lite' || rec.tier === 'openrouter_free';
  return rec.subagent === 'self' && cheap && !WORK_VERB.test(task);
}

/** What goes to Jev: the head of the prompt only. */
export function trimTask(task: string): string {
  return task.length > TASK_TRIM_CHARS ? task.slice(0, TASK_TRIM_CHARS) : task;
}

/** A prompt that names a workflow or workstreams: staged work, where one tuple per turn is not enough. */
export function isStagedPrompt(prompt: string): boolean {
  return /\bwork-?flows?\b|\bwork-?streams?\b/i.test(prompt);
}
