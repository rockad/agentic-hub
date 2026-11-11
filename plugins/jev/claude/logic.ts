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
  clampTierToSessionCeiling,
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

/** What the user said in the current turn's prompt about models and cost. */
export type UserIntent = {
  /** Distinct models named as whole words, in order of first appearance. */
  models: NamedModel[];
  /** Set for "minimal viable model", "cheapest", "cheap model" and close variants. */
  cost?: 'minimal';
};

export const NO_INTENT: UserIntent = { models: [] };

/** Only the start of a prompt is scanned, so pasted tables further down cannot set an intent. */
const INTENT_SCAN_CHARS = 1500;
const COST_INTENT = /\b(?:minimal|minimum)\s+viable\b|\bcheapest\b|\bcheap(?:er)?\s+models?\b|\blowest[- ]cost\b/i;
const MODEL_WORD = /\b(haiku|sonnet|opus)\b/gi;
/** A negation just before a model name ("don't use opus", "not an opus agent", "instead of opus") is not a request for it. */
const NEGATED_BEFORE =
  /\b(?:no|not|never|avoid|without|instead\s+of|rather\s+than|don'?t\s+(?:use|run|pick|need|want)|do\s+not\s+(?:use|run|pick|need|want))\s+(?:\w+\s+){0,2}$/i;

/** Pure: read an explicit model name and cost intent from a prompt. Task notifications carry none. */
export function parseUserIntent(prompt: string | undefined | null): UserIntent {
  const text = (prompt || '').trimStart();
  if (!text || text.startsWith('<task-notification')) return { models: [] };
  const scan = text.slice(0, INTENT_SCAN_CHARS);
  const models: NamedModel[] = [];
  for (const m of scan.matchAll(MODEL_WORD)) {
    const before = scan.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (NEGATED_BEFORE.test(before)) continue;
    const name = m[1].toLowerCase() as NamedModel;
    if (!models.includes(name)) models.push(name);
  }
  const intent: UserIntent = { models };
  if (COST_INTENT.test(scan)) intent.cost = 'minimal';
  return intent;
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

/** Jev tier name for a session model, so the shared Antigravity clamp helper can compare against it. */
function sessionCeilingTier(sessionModel: string | null): JevTier | null {
  const rank = modelRank(sessionModel);
  if (rank === null) return null;
  return rank <= 1 ? 'flash_lite' : rank === 2 ? 'flash' : 'pro';
}

export type Resolution = {
  tier: JevTier;
  model: ClaudeModelAlias;
  /** Precedence layer that decided: instruction, then mode guard, then default rule. */
  source: 'user-instruction' | 'mode-guard' | 'default-rule';
  /** Pro tier chosen by Jev, not by the user: ask before delegating on opus. */
  needsApproval: boolean;
  /** Set when the session-model ceiling lowered the recommendation. */
  cappedFrom?: JevTier;
  note: string;
};

/**
 * One precedence order for the model of a delegation:
 *   1. an explicit instruction in the current prompt (a named model, or a cost intent),
 *      clamped by nothing but the user's own words; a named opus satisfies the pro guard;
 *   2. the mode guard (pro is capped at the session model and needs the user's approval);
 *   3. the default rule (Jev's tier mapped to a model alias).
 */
export function resolveModel(args: {
  intent?: UserIntent | null;
  rec: Pick<Dispatch, 'tier'>;
  sessionModel: string | null;
}): Resolution {
  const { intent, rec, sessionModel } = args;
  const named = namedModel(intent);
  if (named) {
    return {
      tier: MODEL_TO_TIER[named],
      model: named,
      source: 'user-instruction',
      needsApproval: false,
      note: `You asked for ${named} (explicit user request).`
    };
  }
  if (intent?.cost === 'minimal') {
    const tier = lowerTier(rec.tier);
    return {
      tier,
      model: TIER_TO_CLAUDE[tier],
      source: 'user-instruction',
      needsApproval: false,
      note: `You asked for the minimal viable model, so the tier is lowered one step to ${tier}.`
    };
  }
  if (rec.tier === 'pro') {
    const ceiling = sessionCeilingTier(sessionModel);
    const clamped = ceiling ? (clampTierToSessionCeiling('pro', ceiling).clampedTier as JevTier) : 'pro';
    if (clamped !== 'pro') {
      return {
        tier: clamped,
        model: TIER_TO_CLAUDE[clamped],
        source: 'mode-guard',
        needsApproval: true,
        cappedFrom: 'pro',
        note:
          `Jev rated this opus-level (pro tier); the session model "${sessionModel}" is the hard ceiling, so the ` +
          `recommendation is capped at ${TIER_TO_CLAUDE[clamped]}. Ask the user before delegating on opus.`
      };
    }
    return { tier: 'pro', model: 'opus', source: 'mode-guard', needsApproval: true, note: '' };
  }
  return { tier: rec.tier, model: TIER_TO_CLAUDE[rec.tier], source: 'default-rule', needsApproval: false, note: '' };
}

/** Short stable id for one user turn, shared by the UserPromptSubmit and PreToolUse log records. */
export function turnId(prompt: string): string {
  return createHash('sha1').update((prompt || '').trim()).digest('hex').slice(0, 12);
}

/** Per-session state written at UserPromptSubmit and read at PreToolUse. */
export type TurnState = {
  turn: string;
  intent: UserIntent;
  rec?: { subagent: string; tier: JevTier; model: ClaudeModelAlias };
  /** Epoch ms of the last pre-flight reminder, so it is not repeated on every Agent call. */
  remindedAt?: number;
};

/** The context line injected before the turn. */
export function buildDirective(
  rec: Dispatch,
  sessionModel: string | null,
  quotaStrategy: string,
  intent?: UserIntent | null
): string {
  const res = resolveModel({ intent, rec, sessionModel });
  const ceiling = sessionModel
    ? `The session model "${sessionModel}" is the hard ceiling: never delegate to a stronger model without explicit user approval.`
    : 'Never delegate to a stronger model than the current session without explicit user approval.';
  const isCustom = !['Explore', 'Plan', 'general-purpose', 'self'].includes(rec.subagent);
  const delegate =
    rec.subagent === 'self'
      ? 'Handle it directly.'
      : isCustom
        ? `Action: Delegate to custom persona via Agent(subagent_type: "${rec.subagent}", model: "${res.model}").`
        : `Delegate to the ${rec.subagent} subagent with model "${res.model}".`;
  const free = 'Consider offloading it to the jev MCP tool jev_execute_free ($0) instead of a paid subagent.';
  let guard: string;
  if (res.source === 'user-instruction') {
    guard = `${res.note} ${res.tier === 'openrouter_free' ? free : delegate}`;
  } else if (res.cappedFrom) {
    // One sentence instead of the ceiling sentence plus the pro sentence: they used to contradict.
    guard = `${res.note} ${delegate}`;
  } else if (res.tier === 'pro') {
    guard = `${ceiling} This task may need the strongest tier: present the cheaper and the stronger option and let the user choose before delegating on opus.`;
  } else {
    guard = `${ceiling} ${res.tier === 'openrouter_free' ? free : delegate}`;
  }
  return (
    `[JEV] cost-tiered recommendation (quota=${quotaStrategy}): subagent="${rec.subagent}", ` +
    `tier="${res.tier}", model="${res.model}", effort="${rec.effort}". ${guard}`
  );
}

export type AgentCall = {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  model?: string;
};

export type AgentDecision = { decision: 'ask'; reason: string } | null;

/**
 * The only gate on an Agent tool call, and it is deterministic: ask when the requested model is
 * stronger than the session's. A missing model or "inherit" runs on the session model and is never
 * stronger, so it passes, and so does a model pinned at or below the session model. A model the user
 * named in the current prompt is their explicit request and never asks.
 *
 * Claude Code shows `ask` as a permission dialog with Yes and No. No is a rejection: the tool call is
 * cancelled and the assistant is told to stop and wait, so the reason must not promise a retry.
 *
 * Jev's tier rating of the task is deliberately not a gate. It is advice (the UserPromptSubmit
 * directive) and telemetry (`recommended_model` in the PreToolUse log). A `pro` rating is not a
 * permission question when the call runs at or below the ceiling; a dialog for it fired on every
 * delegation pinned to the session model (case study 2026-11-11).
 */
export function decideAgentCall(call: AgentCall, sessionModel: string | null, intent?: UserIntent | null): AgentDecision {
  const requested = modelRank(call.model);
  const ceiling = modelRank(sessionModel);
  if (requested === null || ceiling === null || requested <= ceiling) return null;
  if (intent && intent.models.some((m) => modelRank(m) === requested)) return null;
  return {
    decision: 'ask',
    reason:
      `[jev] This delegation asks for model "${call.model}", stronger than the session model "${sessionModel}". ` +
      'Yes runs it on the stronger model. No cancels the delegation and the assistant waits for your instruction; ' +
      'it does not retry on a cheaper model by itself.'
  };
}

/** Keep only characters that are safe in a file name. */
export function safeSessionId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length ? clean : null;
}

/** The dispatch tools whose telemetry lines count as a pre-flight. */
const DISPATCH_TOOLS = new Set(['jev_dispatch', 'jev_batch_dispatch']);

/** Pure: does any telemetry line record a dispatch tool call within `windowMs` of `nowMs`? */
export function hasRecentDispatch(lines: ReadonlyArray<string>, nowMs: number, windowMs: number): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as { tool?: unknown; timestamp?: unknown };
      if (typeof entry.tool !== 'string' || !DISPATCH_TOOLS.has(entry.tool)) continue;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(at) && nowMs - at <= windowMs) return true;
    } catch {
      // skip a malformed line
    }
  }
  return false;
}

/** Window in which an earlier dispatch call counts as the pre-flight for an Agent launch. */
export const PREFLIGHT_WINDOW_MS = 10 * 60 * 1000;

/** The reminder added to an Agent launch when mode is on and no dispatch call preceded it. Never blocks. */
export const PREFLIGHT_REMINDER =
  '[JEV] Mode is on and no jev_dispatch or jev_batch_dispatch call was logged in the last 10 minutes. ' +
  'For a staged plan of several agents, call jev_batch_dispatch first and run jev_judge on the combined diff. ' +
  'Rubric: a mechanical edit or checklist update is haiku, a spec or plan edit with a settled decision is sonnet, ' +
  'a judgement that is expensive to get wrong is opus. The session model stays the ceiling and a model you named wins.';
