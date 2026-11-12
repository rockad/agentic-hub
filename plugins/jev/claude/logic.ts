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

export type JevTier = 'openrouter_free' | 'flash_lite' | 'flash' | 'pro';
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable';

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

export const TIER_CRITERIA: Readonly<Record<JevTier, string>> = {
  openrouter_free: 'Lightweight summaries, drafts, syntax transforms, formatting, boilerplate ($0 cost)',
  flash_lite: 'Trivial triage, quick lookups, file moves, formatting',
  flash: 'Standard agentic steps, routine edits, content synthesis, local commands',
  pro: 'Deep reasoning, architecture, complex multi-file refactors, high-stakes writing'
};

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
  for (const cost of text.matchAll(MINIMAL_COST)) {
    const before = text.slice(Math.max(0, cost.index! - 30), cost.index!);
    if (!instructive(text, cost.index!) || NEGATION.test(before) || DESCRIPTIVE_BEFORE.test(before)) continue;
    intent.cost = 'minimal';
    intent.phrase ??= cost[0];
    break;
  }
  return intent;
}

/** The intent as it is stored and logged: the choice only, never the matched words. */
export function storedIntent(intent: UserIntent): UserIntent {
  return { models: [...intent.models], ...(intent.cost ? { cost: intent.cost } : {}) };
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
  intent?: UserIntent | null
): string {
  const advised = applyUserIntent(rec, intent);
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
      : `Jev rates this opus-level; ${limit.replace(/^The/, 'the')} is the hard ceiling, so ask the user before delegating on opus: offer the cheaper option and let the user choose.`;
    return `${head} ${costNote}${pro}`;
  }

  // A paid delegation on a model above the session model: one ceiling sentence, not the hard-ceiling
  // line followed by a "delegate to <stronger model>" action that contradicts it.
  if (advised.tier !== 'openrouter_free' && advised.subagent !== 'self' && exceedsSession(advised.model, sessionModel)) {
    return `${head} ${costNote}Jev rates this ${advised.model}-level; ${limit.replace(/^The/, 'the')} is the hard ceiling, so ask the user before delegating on ${advised.model}: offer a model within the ceiling and let the user choose.`;
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

export type AgentDecision = { decision: 'ask'; reason: string } | null;

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
};

/**
 * Pure: is this Agent call asking for a model stronger than the session's? Null for a call with no
 * model or "inherit" (it runs on the session model), a model at or below the session model, and an
 * unknown or missing session model. A model the user named in the current prompt, or a stronger one, is
 * their explicit request: `instructed`, never `elevating`.
 */
export function classifyElevation(call: AgentCall, sessionModel: string | null, intent?: UserIntent | null): Elevation | null {
  const requested = modelRank(call.model);
  const ceiling = modelRank(sessionModel);
  if (requested === null || ceiling === null || requested <= ceiling || !call.model || !sessionModel) return null;
  // The instruction check is `>=`: a named model covers a weaker request too ("use opus" covers a sonnet call).
  const instructed = !!intent && intent.models.some((m) => (modelRank(m) ?? 0) >= requested);
  // A model with a rank always has an alias (the two tables match), so there is always something to clamp to.
  const sessionAlias = modelAlias(sessionModel);
  if (!sessionAlias) return null;
  return { kind: instructed ? 'instructed' : 'elevating', requested: call.model, sessionModel, sessionAlias };
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
 * The wording of the permission dialog for an elevating call: every one by default, and a repeat in the same
 * prompt under the opt-in clamp (`JEV_ELEVATION=clamp`, see `clampElevation`). It says what each answer does: in Claude Code No cancels the call and stops the turn,
 * and a comment typed with No lets the assistant continue. `clamped` is true only when a clamp ran for the
 * same delegation in this prompt; only then does the reason say that a run on the session model happened.
 */
export function elevationAskReason(e: Elevation, clamped = false): string {
  return (
    `[jev] This delegation asks for model "${e.requested}", stronger than the session model "${e.sessionModel}". ` +
    `Yes runs it on ${e.requested}. No cancels the call and stops the turn; type a comment with No to let the assistant continue (for example "continue on ${e.sessionAlias}").` +
    (clamped ? ` The same delegation already ran on ${e.sessionAlias} earlier in this prompt.` : '')
  );
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
 * The deterministic check on an Agent tool call: is it a model stronger than the session's with no
 * instruction from the user? A missing model or "inherit" runs on the session model and is never
 * stronger, so it passes, and so does a model pinned at or below the session model. A model the user
 * named in the current prompt (or a stronger one) is their explicit request and is not asked about.
 *
 * Every such call asks (the default, as in 2.3.3). Claude Code shows `ask` as a permission dialog with Yes and
 * No. No cancels the call and stops the turn, and a comment typed with No lets the assistant continue, so
 * the reason says what each answer does. Opt-in (`JEV_ELEVATION=clamp`, read by the hook): the first such
 * call of a prompt is clamped to the session model (`clampElevation`) and only a repeat asks.
 *
 * Jev's tier rating of the task is deliberately not a gate. It is advice (the UserPromptSubmit
 * directive) and telemetry (`recommended_model` in the PreToolUse log). A `pro` rating is not a
 * permission question when the call runs at or below the ceiling; a dialog for it fired on every
 * delegation pinned to the session model (case study 2026-11-11).
 */
export function decideAgentCall(call: AgentCall, sessionModel: string | null, intent?: UserIntent | null): AgentDecision {
  const e = classifyElevation(call, sessionModel, intent);
  if (!e || e.kind !== 'elevating') return null;
  return { decision: 'ask', reason: elevationAskReason(e, false) };
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

/** The stage rubric, as the user's standing rule words it: the cheapest model that fits the stage. */
export const STAGE_RUBRIC_TEXT =
  'Stage rubric, cheapest model that fits: mechanical edit or checklist update -> haiku; ' +
  'spec or plan edit with a settled decision -> sonnet; ' +
  'judgement whose error is expensive (a reversal not yet decided, adversarial verification, synthesis across disagreeing sources) -> opus.';

/**
 * The reminder added to a staged delegation when mode is on and no dispatch call preceded it. It names
 * the tool and the rubric and never blocks. It does not describe `kind` or `needsEdit` on the stages:
 * jev_batch_dispatch does not take them in this release.
 */
export function preflightReminder(toolName: string): string {
  return (
    `[JEV] ${toolName} is about to delegate, and no jev_dispatch or jev_batch_dispatch call from Claude Code shows in the last 30 minutes. ` +
    `For staged work, call jev_batch_dispatch with one task per stream first and follow its tiers. ${STAGE_RUBRIC_TEXT} ` +
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
