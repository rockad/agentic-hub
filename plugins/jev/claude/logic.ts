/**
 * Claude Code adapter for Jev: the decision logic, kept free of I/O so it can be
 * tested offline. `hook.ts` wires it to stdin/stdout and the real Jev calls.
 *
 * Mirrors the OpenCode V2 plugin (opencode/plugin.ts): advise a subagent, model
 * and effort before each turn, and ask the user before a delegation would run on
 * a stronger model than the session's own. A Jev failure never fails a turn.
 */
import { defaultEffortForSubagent, applyEffortGovernance, type ThinkingEffort } from '../src/shared.js';

export type JevTier = 'openrouter_free' | 'flash_lite' | 'flash' | 'pro';
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable';

/** Claude Code's built-in subagents (plus `self` for doing the work directly). */
export const CLAUDE_SUBAGENT_CRITERIA: Readonly<Record<string, string>> = {
  Explore: 'Read-only codebase exploration: find files, search code, answer questions about the codebase',
  'general-purpose': 'General multi-step tasks, research, and implementation work',
  Plan: 'Designing an implementation plan before writing code',
  self: 'Direct answer or edit in the main session without delegation'
};

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
export function parseDispatch(data: unknown, task: string, quotaStrategy: string): Dispatch | null {
  const answers = (data as { answers?: Record<string, { choice?: unknown; confidence?: unknown }> } | null)?.answers;
  if (!answers) return null;
  const sa = answers.recommendedSubagent;
  const tierAnswer = answers.recommendedTier;
  const tierChoice = tierAnswer?.choice;
  const saChoice = sa?.choice;
  const tier: JevTier =
    typeof tierChoice === 'string' && tierChoice in TIER_CRITERIA ? (tierChoice as JevTier) : 'flash';
  const subagent =
    typeof saChoice === 'string' && saChoice in CLAUDE_SUBAGENT_CRITERIA ? saChoice : 'self';
  const confidence = Math.min(
    typeof sa?.confidence === 'number' ? sa.confidence : 0.9,
    typeof tierAnswer?.confidence === 'number' ? tierAnswer.confidence : 0.9
  );
  const effort = applyEffortGovernance(defaultEffortForSubagent(subagent, task), quotaStrategy, tier);
  return { subagent, tier, model: TIER_TO_CLAUDE[tier], effort, confidence };
}

/** The questions sent to Jev for one turn. */
export function dispatchQuestions(): Record<string, unknown> {
  return {
    recommendedSubagent: {
      type: 'choice',
      instructions: 'Select the best Claude Code subagent for this task (or self for direct work)',
      criteria: CLAUDE_SUBAGENT_CRITERIA
    },
    recommendedTier: {
      type: 'choice',
      instructions: 'Determine the required model tier from cognitive load and complexity',
      criteria: TIER_CRITERIA
    }
  };
}

/** The context line injected before the turn. */
export function buildDirective(rec: Dispatch, sessionModel: string | null, quotaStrategy: string): string {
  const ceiling = sessionModel
    ? `The session model "${sessionModel}" is the hard ceiling: never delegate to a stronger model without explicit user approval.`
    : 'Never delegate to a stronger model than the current session without explicit user approval.';
  const action =
    rec.tier === 'pro'
      ? 'This task may need the strongest tier: present the cheaper and the stronger option and let the user choose before delegating on opus.'
      : rec.tier === 'openrouter_free'
        ? 'Consider offloading it to the jev MCP tool jev_execute_free ($0) instead of a paid subagent.'
        : rec.subagent === 'self'
          ? 'Handle it directly.'
          : `Delegate to the ${rec.subagent} subagent with model "${rec.model}".`;
  return (
    `[JEV] cost-tiered recommendation (quota=${quotaStrategy}): subagent="${rec.subagent}", ` +
    `tier="${rec.tier}", model="${rec.model}", effort="${rec.effort}". ${ceiling} ${action}`
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
 * Deterministic guard for an Agent tool call: ask when the requested model is
 * stronger than the session's. A missing model or "inherit" runs on the session
 * model and is never stronger, so it passes.
 */
export function decideAgentCall(call: AgentCall, sessionModel: string | null): AgentDecision {
  const requested = modelRank(call.model);
  const ceiling = modelRank(sessionModel);
  if (requested === null || ceiling === null || requested <= ceiling) return null;
  return {
    decision: 'ask',
    reason:
      `[jev] This delegation asks for model "${call.model}", stronger than the session model "${sessionModel}". ` +
      'Approve to run it on the stronger model, or deny and re-run it on the session model or a cheaper one.'
  };
}

/** Second guard, when Jev is reachable: the task itself needs the pro tier. */
export function decideByTier(call: AgentCall, rec: Dispatch | null): AgentDecision {
  if (!rec || rec.tier !== 'pro') return null;
  const task = (call.description || call.prompt || '').slice(0, 120);
  return {
    decision: 'ask',
    reason:
      `[jev] Jev recommends the pro tier (opus) for this delegation: "${task}". ` +
      'Approve to proceed, or deny and run it on sonnet.'
  };
}

/** Keep only characters that are safe in a file name. */
export function safeSessionId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length ? clean : null;
}
