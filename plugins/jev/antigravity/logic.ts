import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isExplicitProOverride,
  modelTierRank,
  rankToTierName,
  isOrchestratorModel,
  subagentCeilingRank,
  poolForTier,
  safeSessionId,
  type QuotaView
} from '../src/core/governance.js';
import type { JevMode } from '../src/core/config.js';
import { privateDir, privateFile, jevHomeDir, PRIVATE_FILE_MODE } from '../src/core/private-fs.js';
import { withDirLockOrSkip } from '../src/core/dir-lock.js';
import { readRegularFileHead, readRegularFileTail } from '../claude/safe-read.js';
import type { ApprovalStore, ApprovalScope } from './approvals.js';

export type AntigravityHookInput = {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  hookEventName?: string;
  stepIdx?: number;
  cwd?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  content?: string;
};

export type AntigravityHookDecision = {
  /**
   * `pass` is Jev's own value, never printed: the hook has nothing to decide, so it prints `{}` and Antigravity applies
   * its normal permission check. `allow` is printed only where Jev deliberately approves (an approved elevation, an
   * instructed model, a clamp with `overwrite`), because the docs define it as "Automatically allow the tool execution".
   */
  decision: 'pass' | 'allow' | 'deny' | 'ask' | 'force_ask';
  reason?: string;
  permissionOverrides?: string[];
  overwrite?: Record<string, unknown>;
  elevation?: 'approved' | 'instructed' | 'denied' | 'asked' | 'clamped';
  approvalScope?: ApprovalScope;
  attemptCount?: number;
  clampedTo?: string;
  /** `true`: allowed from an answer read out of the transcript. `'record_failed'`: the answer was there but could not be stored, so nothing was allowed. */
  pullFallback?: true | 'record_failed';
};

export type AntigravityLogicDeps = {
  approvals?: ApprovalStore;
  sessionModelOverride?: string;
  elevationMode?: 'choice' | 'dialog' | 'clamp';
  quotaView?: QuotaView;
  mode?: JevMode;
  now?: () => number;
};

export const ELEVATE_MARKER_PREFIX = '[jev-elevate:';

export const CHOICE_OPTIONS = {
  once: 'Yes, once',
  fiveMin: 'Yes, for the next 5 minutes',
  session: 'Yes, for this session',
  no: (ceiling: string) => `No, proceed on ${ceiling}`
};

// Moved to src/core/governance.ts (the dispatch ceiling clamp shares it); re-exported so existing imports keep working.
export { isExplicitProOverride };

/**
 * Extract the requested subagent model from toolCall.args.
 *
 * NOTE on schemas:
 * - Antigravity 1.5.8 sends a flat object with `Model` (e.g. `{"TypeName": "...", "Prompt": "...", "Model": "flash_lite"}`).
 *   This is the verified, real schema recorded in `tests/fixtures/agy-invoke-subagent.json`.
 * - `args.Subagents[]` / `args.subagents[]` and lowercase `model` keys are defensive fallbacks for backward compatibility
 *   with older schemas and case-tolerance.
 *
 * When multiple models are named across flat arguments and arrays, all non-inherit explicit models are collected
 * and the highest-ranked one is returned so that nested elevations are never masked by an earlier lower-tier entry
 * or an `args.Model === "inherit"`.
 */
export function extractSubagentModel(args?: Record<string, unknown>): { requestedModel: string | null; isExplicit: boolean } {
  if (!args || typeof args !== 'object') {
    return { requestedModel: null, isExplicit: false };
  }

  const candidates: string[] = [];

  const addCandidate = (val: unknown) => {
    if (typeof val === 'string') {
      const trimmed = val.trim().toLowerCase();
      if (trimmed.length > 0 && trimmed !== 'inherit') {
        candidates.push(trimmed);
      }
    }
  };

  // 1. Flat model keys (Model is the real agy 1.5.8 schema; model is a defensive lowercase fallback)
  addCandidate(args.Model);
  addCandidate(args.model);

  // 2. Subagent array keys (defensive backwards-compatibility fallbacks)
  const subArrays = [args.Subagents, args.subagents];
  for (const arr of subArrays) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          addCandidate(rec.Model);
          addCandidate(rec.model);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { requestedModel: null, isExplicit: false };
  }

  // Sort descending by model tier rank and pick highest
  candidates.sort((a, b) => modelTierRank(b) - modelTierRank(a));
  return { requestedModel: candidates[0], isExplicit: true };
}

export function buildElevationQuestion(opts: {
  typeName: string;
  requestedModel: string;
  ceilingTier: string;
  taskSummary?: string;
}): { question: string; options: string[] } {
  const summaryPart = opts.taskSummary ? ` for ${opts.taskSummary}` : '';
  const question = `${ELEVATE_MARKER_PREFIX}${opts.requestedModel}] Allow subagent '${opts.typeName}' to run on ${opts.requestedModel}${summaryPart} (session ceiling: ${opts.ceilingTier})?`;
  const options = [
    CHOICE_OPTIONS.once,
    CHOICE_OPTIONS.fiveMin,
    CHOICE_OPTIONS.session,
    CHOICE_OPTIONS.no(opts.ceilingTier)
  ];
  return { question, options };
}

export function buildElevationReason(opts: {
  typeName: string;
  requestedModel: string;
  sessionCeilingTier: string;
  taskSummary?: string;
  isOrchestrator?: boolean;
}): string {
  const q = buildElevationQuestion({
    typeName: opts.typeName,
    requestedModel: opts.requestedModel,
    ceilingTier: opts.sessionCeilingTier,
    taskSummary: opts.taskSummary
  });

  const noAction = opts.isOrchestrator
    ? `if No, re-invoke with '${opts.sessionCeilingTier}' or 'flash_lite'`
    : `if No, re-invoke with '${opts.sessionCeilingTier}' (or inherit)`;

  return (
    `[jev] Subagent '${opts.typeName}' requested Model '${opts.requestedModel}', which exceeds session ceiling '${opts.sessionCeilingTier}', ` +
    `and no approval covers it (note: Antigravity has so far served 'pro' subagents on flash). Ask the user with ask_question: one question whose text starts with ` +
    `'${ELEVATE_MARKER_PREFIX}${opts.requestedModel}]', with four options in this order: ` +
    `'${q.options[0]}', '${q.options[1]}', '${q.options[2]}', '${q.options[3]}'. ` +
    `If the user approves, re-invoke with '${opts.requestedModel}'; ${noAction}; ` +
    `do not ask in any other form.`
  );
}

/** The prescribed approving labels and the scope each records. `No, proceed on <model>` and anything else record nothing. */
const SCOPE_BY_LABEL = new Map<string, ApprovalScope>([
  [CHOICE_OPTIONS.once, 'once'],
  [CHOICE_OPTIONS.fiveMin, '5min'],
  [CHOICE_OPTIONS.session, 'session']
]);

/**
 * The answer to the elevation question, read from the PostToolUse `content` field or the session transcript step.
 * Antigravity's real ask_question PostToolUse payload does not send `content` directly on stdin; instead it passes
 * `transcriptPath` and `stepIdx`. The step in the transcript reports the user's choice as:
 *
 *   Created At: ...\nCompleted At: ...\nA1: <chosen option or typed text>\nA2: User Skipped
 *
 * (recorded transcripts; one `A<n>:` line per question, `(Recommended)` kept as part of the option text). The rest of
 * the payload is never read: `toolCall.args` holds the question and the option list the assistant wrote, so reading it
 * would approve from the options alone.
 *
 * `questionIndex` picks the answer of that question (A1 is index 0). Null when there is no `content` string, no such
 * answer line, or a content with no `A<n>:` line that is more than one line.
 */
/**
 * Tail window size for reading transcripts in PostToolUse for ask_question.
 * Transcripts larger than this have only their last N bytes read.
 */
export const TRANSCRIPT_TAIL_WINDOW_BYTES = 1024 * 1024; // 1 MB
export const MAX_TRANSCRIPT_READ_BYTES = TRANSCRIPT_TAIL_WINDOW_BYTES;

export function extractAskAnswer(
  input: AntigravityHookInput | undefined,
  questionIndex = 0,
  maxBytes = TRANSCRIPT_TAIL_WINDOW_BYTES
): string | null {
  let content = input?.content;
  if ((!content || typeof content !== 'string') && input?.transcriptPath && typeof input?.stepIdx === 'number') {
    try {
      const read = readRegularFileTail(input.transcriptPath, maxBytes);
      if (read.kind === 'ok') {
        let text = read.text;
        // Drop the first partial line when the window does not start at byte 0
        if (read.truncated) {
          const firstNewline = text.indexOf('\n');
          text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
        }
        const lines = text.trim().split(/\r?\n/);
        let matchCount = 0;
        let matchedStep: Record<string, unknown> | null = null;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const step = JSON.parse(line);
            if (typeof step === 'object' && step !== null && step.step_index === input.stepIdx) {
              matchCount++;
              matchedStep = step as Record<string, unknown>;
            }
          } catch {
            // ignore unparseable or partial line
          }
        }
        // Right step & fail closed:
        // Must match exactly one step (no duplicate indices), and that step must be a GENERIC tool response step
        if (matchCount === 1 && matchedStep && matchedStep.type === 'GENERIC') {
          const stepToolId = matchedStep.toolCallId ?? matchedStep.tool_call_id;
          const inputToolId = input.toolCall?.id;
          if (typeof stepToolId === 'string' && inputToolId && stepToolId !== inputToolId) {
            return null;
          }
          if (typeof matchedStep.content === 'string') {
            content = matchedStep.content;
          }
        }
      }
    } catch {
      // return null on error
    }
  }

  if (typeof content !== 'string' || content.trim() === '') return null;
  const answers = new Map<number, string>();
  let current: number | null = null;
  for (const line of content.split(/\r?\n/)) {
    const m = /^A(\d+):[ \t]?(.*)$/.exec(line);
    if (m) {
      current = Number(m[1]);
      answers.set(current, m[2]);
    } else if (current !== null) {
      answers.set(current, `${answers.get(current)}\n${line}`);
    }
  }
  if (answers.size === 0) {
    const bare = content.trim();
    return bare.includes('\n') ? null : bare;
  }
  return answers.get(questionIndex + 1) ?? null;
}

export async function pollForAskAnswer(
  input: AntigravityHookInput | undefined,
  questionIndex = 0,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; maxBytes?: number }
): Promise<string | null> {
  const maxWaitMs = opts?.maxWaitMs ?? 2000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 150;
  const maxBytes = opts?.maxBytes;

  let answer = extractAskAnswer(input, questionIndex, maxBytes);
  if (answer !== null) return answer;

  const contentOnStdin = typeof input?.content === 'string' && input.content.trim().length > 0;
  if (contentOnStdin || !input?.transcriptPath || typeof input?.stepIdx !== 'number') {
    return null;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const elapsed = Date.now() - startTime;
    const remaining = maxWaitMs - elapsed;
    if (remaining <= 0) break;
    const delay = Math.min(pollIntervalMs, remaining);
    await new Promise((resolve) => setTimeout(resolve, delay));
    answer = extractAskAnswer(input, questionIndex, maxBytes);
    if (answer !== null) return answer;
  }
  return null;
}

/** An answer text without its `A1:` prefix and its `(Recommended)` tag (a prefix as Antigravity writes it, or a suffix). */
function answerLabel(answerText: string): string {
  return answerText
    .trim()
    .replace(/^A\d+:\s*/, '')
    .replace(/^\(Recommended\)\s+/i, '')
    .replace(/\s+\(Recommended\)$/i, '')
    .trim();
}

/**
 * Whether an answer approves, and for how long. The answer must be EXACTLY one of the prescribed labels (after the
 * `A1:` prefix and the `(Recommended)` tag are removed): `Yes, once`, `Yes, for the next 5 minutes`,
 * `Yes, for this session`. `No, proceed on <model>`, free text ("No, not even once"), a missing answer and anything
 * else approve nothing. Substring matching is deliberately not used.
 */
export function parseElevationAnswer(answerText?: string | null): { approved: boolean; scope?: ApprovalScope } {
  if (!answerText || typeof answerText !== 'string') return { approved: false };
  const scope = SCOPE_BY_LABEL.get(answerLabel(answerText));
  return scope ? { approved: true, scope } : { approved: false };
}

/**
 * The answer to the latest `[jev-elevate:<model>]` question in the transcript, or null when there is none yet.
 *
 * Which GENERIC row is the question's own answer (real transcripts carry no tool call ids):
 * 1. A tool call id on the question, when there is one: the GENERIC row with the same id (and no other row).
 * 2. `answerStepIdx`, the step_index PostToolUse recorded for the question's own row: exactly that GENERIC row after
 *    the question, and no other. A row that is not written yet is no answer.
 * 3. Neither: the first GENERIC row after the question, but only when the question was the planner step's single tool
 *    call. With several tool calls (run in parallel) the rows may come in completion order, so there is no answer.
 *
 * `answerQuestionIdx` is the question index PostToolUse saw (default: the matched call's own). An answer whose key
 * (`<id>#<q>` or `step:<step_index>#<q>`) is in `consumedKeys` already approved a run and is no answer.
 */
export function pullElevationAnswerFromTranscript(
  transcriptPath: string,
  requestedModel: string,
  deniedAtMs?: number,
  answerStepIdx?: number | null,
  answerQuestionIdx?: number | null,
  consumedKeys: readonly string[] = []
): { approved: boolean; scope?: ApprovalScope } | null {
  const r = pullElevationAnswerDetailed(
    transcriptPath,
    requestedModel,
    deniedAtMs,
    answerStepIdx,
    answerQuestionIdx,
    consumedKeys
  );
  return r ? { approved: r.approved, ...(r.scope ? { scope: r.scope } : {}) } : null;
}

/** Like `pullElevationAnswerFromTranscript`, plus the consumption key of the answer row that was read. */
export function pullElevationAnswerDetailed(
  transcriptPath: string,
  requestedModel: string,
  deniedAtMs?: number,
  answerStepIdx?: number | null,
  answerQuestionIdx?: number | null,
  consumedKeys: readonly string[] = []
): { approved: boolean; scope?: ApprovalScope; answerKey?: string } | null {
  try {
    const read = readRegularFileTail(transcriptPath, TRANSCRIPT_TAIL_WINDOW_BYTES);
    if (read.kind !== 'ok') return null;

    let text = read.text;
    if (read.truncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    const lines = text.trim().split(/\r?\n/);
    const steps: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') {
          steps.push(obj as Record<string, unknown>);
        }
      } catch {
        // ignore unparseable line
      }
    }

    const marker = `${ELEVATE_MARKER_PREFIX}${requestedModel.toLowerCase()}]`.toLowerCase();

    type AskMatch = {
      stepIndexInArray: number;
      toolCallId?: string;
      markerIndex: number;
      /** How many tool calls the planner step made: 0 for a prose match. */
      toolCallCount: number;
    };

    let latestToolMatch: AskMatch | null = null;
    let latestProseMatch: AskMatch | null = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      const rawTime =
        typeof step.created_at === 'string'
          ? step.created_at
          : typeof step.createdAt === 'string'
            ? step.createdAt
            : null;
      if (typeof deniedAtMs === 'number' && rawTime) {
        const t = Date.parse(rawTime);
        if (!Number.isNaN(t) && t < deniedAtMs - 5000) {
          continue;
        }
      }

      let matchedTool = false;
      let matchedProse = false;
      let toolCallId: string | undefined;
      let markerIndex = 0;

      const toolCalls = Array.isArray(step.tool_calls)
        ? step.tool_calls
        : Array.isArray(step.toolCalls)
          ? step.toolCalls
          : null;

      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === 'object') {
            const rec = tc as Record<string, unknown>;
            if (rec.name === 'ask_question') {
              const args = rec.args && typeof rec.args === 'object' ? (rec.args as Record<string, unknown>) : undefined;
              const questions = args?.questions;
              if (Array.isArray(questions)) {
                questions.forEach((q, idx) => {
                  const qText =
                    typeof q === 'string'
                      ? q
                      : q && typeof q === 'object'
                        ? (q as Record<string, unknown>).question
                        : '';
                  if (typeof qText === 'string' && qText.toLowerCase().includes(marker)) {
                    matchedTool = true;
                    markerIndex = idx;
                    if (typeof rec.id === 'string') toolCallId = rec.id;
                  }
                });
              } else if (typeof questions === 'string' && questions.toLowerCase().includes(marker)) {
                matchedTool = true;
                markerIndex = 0;
                if (typeof rec.id === 'string') toolCallId = rec.id;
              }
            }
          }
        }
      }

      const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
      if (
        !matchedTool &&
        (stepType === 'PLANNER_RESPONSE' || stepType === '') &&
        !hasToolCalls &&
        typeof step.content === 'string' &&
        step.content.toLowerCase().includes(marker)
      ) {
        matchedProse = true;
        markerIndex = 0;
        if (typeof step.toolCallId === 'string') toolCallId = step.toolCallId;
        else if (typeof step.tool_call_id === 'string') toolCallId = step.tool_call_id;
      }

      if (matchedTool) {
        latestToolMatch = {
          stepIndexInArray: i,
          toolCallId,
          markerIndex,
          toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0
        };
      } else if (matchedProse) {
        latestProseMatch = {
          stepIndexInArray: i,
          toolCallId,
          markerIndex,
          toolCallCount: 0
        };
      }
    }

    const latestMatch = latestToolMatch ?? latestProseMatch;
    if (!latestMatch) return null;

    let genericStep: Record<string, unknown> | null = null;
    let genericIndex = -1;

    if (latestMatch.toolCallId) {
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC') {
          const stepToolId = step.toolCallId ?? step.tool_call_id;
          if (stepToolId === latestMatch.toolCallId) {
            genericStep = step;
            genericIndex = i;
            break;
          }
        }
      }
    }

    // No id: the row PostToolUse recorded for the question (its input.stepIdx), and no other. Rows of parallel tool
    // calls follow the planner step in an order that may be call order or completion order, so position is not used.
    if (!latestMatch.toolCallId && typeof answerStepIdx === 'number') {
      const rows: Array<{ step: Record<string, unknown>; index: number }> = [];
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC' && step.step_index === answerStepIdx) rows.push({ step, index: i });
      }
      // A duplicated index is ambiguous: fail closed.
      genericStep = rows.length === 1 ? rows[0].step : null;
      genericIndex = rows.length === 1 ? rows[0].index : -1;
    } else if (!latestMatch.toolCallId && latestMatch.toolCallCount === 1) {
      // The first-GENERIC-after fallback is only for a question that carries no tool call id, was not recorded by
      // PostToolUse, and was the single tool call of its planner step. With an id, a missing matching row means the
      // answer is not in the transcript yet; the next GENERIC step belongs to another tool.
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC') {
          genericStep = step;
          genericIndex = i;
          break;
        }
      }
    }

    if (!genericStep || typeof genericStep.content !== 'string') {
      return null;
    }

    // The question the user answered is the one PostToolUse saw, when it recorded one (several asks in one planner
    // step may carry the marker); otherwise the matched call's own.
    const questionIdx = typeof answerQuestionIdx === 'number' && !latestMatch.toolCallId ? answerQuestionIdx : latestMatch.markerIndex;
    // Consumption key of the answer row: the tool call id when there is one, else the row's step_index.
    const rowKey = latestMatch.toolCallId
      ? latestMatch.toolCallId
      : typeof genericStep.step_index === 'number'
        ? `step:${genericStep.step_index}`
        : `pos:${genericIndex}`;
    const answerKey = `${rowKey}#${questionIdx}`;
    if (consumedKeys.includes(answerKey)) return null;

    const rawAnswer = extractAskAnswer({ content: genericStep.content }, questionIdx);
    return { ...parseElevationAnswer(rawAnswer), answerKey };
  } catch {
    return null;
  }
}

export function evaluateAntigravitySubagentCall(
  input: AntigravityHookInput,
  deps: AntigravityLogicDeps = {}
): AntigravityHookDecision {
  const toolName = input?.toolCall?.name || '';
  if (toolName !== 'invoke_subagent') {
    return { decision: 'pass' };
  }

  const sessionId = safeSessionId(input.conversationId) || 'default-session';
  // An id that was sent but has nothing safe in it means no stored state (not the shared default-session file).
  const rawId = input.conversationId;
  const approvalStore = typeof rawId === 'string' && rawId.length > 0 && !safeSessionId(rawId) ? undefined : deps.approvals;
  const nowMs = (deps.now ?? Date.now)();
  const sessionModel = deps.sessionModelOverride || input.modelName || 'gemini-3.8-flash-low';
  const mode: JevMode = deps.mode ?? 'on';

  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);

  // 1. Reject openrouter_free and invalid model values
  if (isExplicit && requestedModel) {
    const reqLower = requestedModel.toLowerCase();
    if (reqLower.includes('free') || reqLower.includes('openrouter')) {
      return {
        decision: 'deny',
        reason: '[jev] Antigravity invoke_subagent does not support openrouter/free models directly. Use jev_execute_free or jev_agent_free for autonomous free-tier tasks.'
      };
    }
    const isRecognized =
      /^(?:flash_lite|flash-lite|flash|pro)$/i.test(reqLower) ||
      /^(?:gemini|claude|hydrogen|argon)/i.test(reqLower);
    if (!isRecognized) {
      return {
        decision: 'deny',
        reason: `[jev] Unrecognized model '${requestedModel}' on invoke_subagent. Choose one of: inherit, flash_lite, flash, pro.`
      };
    }
  }

  // 2. Orchestrator omitted/inherit rule
  const isOrchestrator = isOrchestratorModel(sessionModel);
  let effectiveTier: string;

  if (!isExplicit || !requestedModel) {
    if (isOrchestrator) {
      if (mode === 'on-demand') {
        // On-demand never denies after step 1: the native dialog lets the user decide.
        return {
          decision: 'ask',
          reason: `[jev] Under Orchestrator, Model was omitted or inherit on invoke_subagent: the subagent would run on the session default (tier '${rankToTierName(modelTierRank(sessionModel ?? ''))}'), against a subagent ceiling of '${rankToTierName(subagentCeilingRank(sessionModel))}'. Approve to proceed, or cancel and re-invoke with Model "flash" or "flash_lite".`
        };
      }
      return {
        decision: 'deny',
        reason: '[jev] Under Orchestrator, set Model explicitly on invoke_subagent: "flash" or "flash_lite" (or "pro" with [jev-elevate:pro]).'
      };
    }
    effectiveTier = rankToTierName(subagentCeilingRank(sessionModel));
  } else {
    effectiveTier = requestedModel;
  }

  // 3. Quota check (BEFORE any approval or override!)
  if (deps.quotaView) {
    const pool = poolForTier(deps.quotaView, effectiveTier);
    let poolLabel = 'Gemini';
    if (deps.quotaView.pools) {
      if (pool === deps.quotaView.pools.frontier) {
        const variant = deps.quotaView.variant || 'argon';
        poolLabel = variant === 'argon' ? 'Argon (pools.frontier)' : 'Carbon (pools.frontier)';
      } else {
        poolLabel = 'Gemini (pools.execution)';
      }
    } else if (pool.pool === '3p') {
      poolLabel = '3p';
    }

    const pct = typeof pool.min_remaining === 'number' ? ` (${Math.round(pool.min_remaining * 100)}% remaining)` : '';

    if (mode === 'on') {
      if (pool.strategy === 'free_only') {
        return {
          decision: 'deny',
          reason: `[jev] ${poolLabel} quota is critically low${pct}. All paid tiers ('${effectiveTier}') are blocked. Offload to openrouter/free via jev_execute_free or jev_agent_free.`
        };
      }
      if (pool.strategy === 'conserve') {
        if (modelTierRank(effectiveTier) > 1) {
          return {
            decision: 'deny',
            reason: `[jev] ${poolLabel} quota is in conserve mode${pct}. Subagents above flash_lite are blocked. Re-invoke with Model: "flash_lite" or use jev_execute_free.`
          };
        }
      }
    } else if (mode === 'on-demand') {
      if ((pool.strategy === 'free_only' || pool.strategy === 'conserve') && modelTierRank(effectiveTier) > 1) {
        return {
          decision: 'ask',
          reason: `[jev] ${poolLabel} quota is in ${pool.strategy}${pct}: subagent requested '${effectiveTier}'. Approve to proceed, or cancel to conserve quota.`
        };
      }
      // Healthy pool: fall through to the ceiling check below (on-demand asks above the ceiling).
    }
  }

  // If Model is omitted/inherit and passed Step 3 quota check on non-Orchestrator:
  if (!isExplicit || !requestedModel) {
    return { decision: 'pass' };
  }

  // 4. Ceiling / Elevation
  const sessionCeilingRank = subagentCeilingRank(sessionModel);
  const sessionCeilingTier = rankToTierName(sessionCeilingRank);
  const requestedRank = modelTierRank(requestedModel);

  if (requestedRank <= sessionCeilingRank) {
    return { decision: 'pass' };
  }

  // Requested model exceeds session ceiling: ELEVATION
  const args = input.toolCall?.args || {};
  const typeName = String(args.TypeName || args.Role || 'subagent');

  // On-demand: the native dialog decides. No approvals are read or recorded and no attempt is counted.
  if (mode === 'on-demand') {
    return {
      decision: 'ask',
      reason: `[jev] Subagent '${typeName}' requested Model '${requestedModel}' (tier '${rankToTierName(requestedRank)}'), above the session ceiling '${sessionCeilingTier}'. Approve to run on ${requestedModel}, or cancel.`,
      elevation: 'asked'
    };
  }

  // Check explicit override in user prompt
  if (isExplicitProOverride(input.lastUserInput, requestedModel)) {
    return { decision: 'allow', elevation: 'instructed' };
  }

  // Check covering approval
  const approval = approvalStore?.claim(sessionId, requestedModel, nowMs);
  if (approval) {
    return {
      decision: 'allow',
      elevation: 'approved',
      approvalScope: approval.scope
    };
  }

  const elevationMode = deps.elevationMode || (process.env.JEV_ELEVATION === 'dialog' || process.env.JEV_ELEVATION === 'clamp' ? process.env.JEV_ELEVATION : 'choice');

  if (elevationMode === 'dialog') {
    return {
      decision: 'ask',
      reason: `[jev] Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'. Approve to run on ${requestedModel}, or cancel.`,
      elevation: 'asked'
    };
  }

  const promptHash = input.lastUserInput
    ? createHash('sha256').update(input.lastUserInput).digest('hex').slice(0, 16)
    : 'no-prompt';
  const signature = `${typeName}:${requestedModel}`;

  if (elevationMode === 'clamp') {
    const count = approvalStore?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
    if (count === 1) {
      return {
        decision: 'allow',
        overwrite: { Model: sessionCeilingTier },
        elevation: 'clamped',
        clampedTo: sessionCeilingTier
      };
    }
    return {
      decision: 'ask',
      reason: `[jev] Repeated elevation attempt: Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'.`,
      elevation: 'asked',
      attemptCount: count
    };
  }

  // Choice mode (default):
  const count = approvalStore?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
  let pullFallback: 'record_failed' | undefined;
  if (count <= 2) {
    if (approvalStore && input.transcriptPath && typeof approvalStore.wasDeniedRecently === 'function') {
      const deniedAtMs = approvalStore.wasDeniedRecently(sessionId, requestedModel, nowMs);
      if (typeof deniedAtMs === 'number') {
        // The answer row PostToolUse recorded for the question; without it only a lone ask_question can be read.
        let answerStepIdx: number | null = null;
        let answerQuestionIdx: number | null = null;
        let consumedKeys: string[] = [];
        try {
          answerStepIdx = approvalStore.getAnswerStep?.(sessionId, requestedModel, nowMs) ?? null;
          answerQuestionIdx = approvalStore.getAnswerQuestion?.(sessionId, requestedModel, nowMs) ?? null;
          consumedKeys = approvalStore.getConsumedAnswers?.(sessionId) ?? [];
        } catch {
          // An unreadable store: record() below re-checks the consumed answers under its lock and throws too.
          answerStepIdx = null;
          answerQuestionIdx = null;
          consumedKeys = [];
        }
        const pull = pullElevationAnswerDetailed(
          input.transcriptPath,
          requestedModel,
          deniedAtMs,
          answerStepIdx,
          answerQuestionIdx,
          consumedKeys
        );
        if (pull?.approved && pull.scope) {
          // Allow only when the approval was really stored (and then claimed): a failed record (a lock timeout
          // throws) would leave the denial in place and let the same answer be pulled again. The record refuses an
          // answer row that already approved a run.
          let stored = false;
          try {
            stored =
              approvalStore.record(
                sessionId,
                { model: requestedModel, scope: pull.scope, created_at: nowMs },
                pull.answerKey ? [pull.answerKey] : undefined
              ) === true;
          } catch {
            stored = false;
          }
          if (stored) {
            approvalStore.claim(sessionId, requestedModel, nowMs);
            return {
              decision: 'allow',
              elevation: 'approved',
              approvalScope: pull.scope,
              pullFallback: true
            };
          }
          pullFallback = 'record_failed';
        }
      }
    }

    approvalStore?.deny(sessionId, requestedModel, nowMs);
    const reason = buildElevationReason({
      typeName,
      requestedModel,
      sessionCeilingTier,
      isOrchestrator
    });
    return {
      decision: 'deny',
      reason,
      elevation: 'denied',
      attemptCount: count,
      ...(pullFallback ? { pullFallback } : {})
    };
  }

  // Attempt >= 3: Dialog Backstop
  return {
    decision: 'ask',
    reason: `[jev] Elevation backstop (attempt ${count}): Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'. Approve to run on ${requestedModel}, or cancel to proceed on ${sessionCeilingTier}.`,
    elevation: 'asked',
    attemptCount: count
  };
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The child conversation id in an invoke_subagent tool result. Never returns `parentConversationId`: a result that
 * mentions only the parent's own id yields null, so the served-model lookup can never read the parent's transcript.
 * An id behind an explicit label (`conversationId`, `child_conversation_id`, ...) wins over a bare UUID.
 */
export function extractChildConversationId(content?: string | null, parentConversationId?: string | null): string | null {
  if (!content || typeof content !== 'string') return null;
  const parent = typeof parentConversationId === 'string' ? parentConversationId.toLowerCase() : null;
  const isParent = (id: string) => parent !== null && id.toLowerCase() === parent;

  const labelled = new RegExp(
    `(?:conversation_?id|conversation id|child_?conversation_?id|session_?id|session id)["':\\s=]+(${UUID_SOURCE})`,
    'gi'
  );
  for (const m of content.matchAll(labelled)) {
    if (!isParent(m[1])) return m[1];
  }

  for (const m of content.matchAll(new RegExp(`(${UUID_SOURCE})`, 'gi'))) {
    if (!isParent(m[1])) return m[1];
  }

  return null;
}

/** Head window read for the served model: the first row that names a model is near the start of a transcript. */
export const TRANSCRIPT_HEAD_WINDOW_BYTES = 256 * 1024;

/** The model of the FIRST transcript row that carries one (bounded head read), or null. */
export function findServedModelFromTranscript(
  childConvId: string,
  homedir = jevHomeDir()
): string | null {
  if (!new RegExp(`^${UUID_SOURCE}$`, 'i').test(childConvId)) {
    return null;
  }
  const brainDir = path.join(homedir, '.gemini', 'antigravity-cli', 'brain', childConvId);
  const candidates = [
    path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl'),
    path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(brainDir, 'transcript.jsonl')
  ];

  for (const candidate of candidates) {
    try {
      const read = readRegularFileHead(candidate, TRANSCRIPT_HEAD_WINDOW_BYTES);
      if (read.kind !== 'ok') continue;
      let text = read.text;
      if (read.truncated) {
        // The window ends mid-file: its last line may be partial.
        const lastNewline = text.lastIndexOf('\n');
        text = lastNewline === -1 ? '' : text.slice(0, lastNewline);
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          if (step && typeof step === 'object') {
            const m =
              typeof step.model === 'string'
                ? step.model
                : typeof step.modelName === 'string'
                  ? step.modelName
                  : typeof step.model_name === 'string'
                    ? step.model_name
                    : null;
            if (m && m.trim().length > 0) {
              return m.trim();
            }
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export type PendingServedRecord = {
  stepIdx?: number;
  toolCallId?: string;
  requestedModel: string | null;
  transcriptPath?: string;
  childConvId?: string | null;
  createdAt: number;
  /** Failed backfill attempts so far; the item is dropped (and logged as gave_up) at the cap. */
  attempts?: number;
};

const PENDING_SERVED_TTL_MS = 3600 * 1000;
const PENDING_SERVED_MAX_ITEMS = 20;
/** A child that never writes a model row is retried this many times, then dropped. */
const PENDING_SERVED_MAX_ATTEMPTS = 10;
/** Items examined per flush (oldest first); the rest wait for a later hook call. */
const PENDING_SERVED_MAX_PER_FLUSH = 3;
/** Stop starting new items once a flush has run this long. */
const PENDING_SERVED_BUDGET_MS = 200;

export function readStepContentFromTranscript(
  transcriptPath: string,
  stepIdx?: number,
  toolCallId?: string
): string | null {
  if (!transcriptPath || typeof stepIdx !== 'number') return null;
  try {
    const read = readRegularFileTail(transcriptPath, TRANSCRIPT_TAIL_WINDOW_BYTES);
    if (read.kind !== 'ok') return null;
    let text = read.text;
    if (read.truncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    for (const line of text.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line);
        if (step && typeof step === 'object' && step.step_index === stepIdx) {
          const stepToolId = step.toolCallId ?? step.tool_call_id;
          if (typeof stepToolId === 'string' && toolCallId && stepToolId !== toolCallId) {
            continue;
          }
          if (typeof step.content === 'string') return step.content;
          if (step.content && typeof step.content === 'object') return JSON.stringify(step.content);
          if (typeof step.response === 'string') return step.response;
          if (typeof step.result === 'string') return step.result;
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function pendingServedFile(sessionsDir: string, sessionId: string): string | null {
  const safe = safeSessionId(sessionId);
  if (!safe) return null;
  return path.join(sessionsDir, `${safe}.pending-served.json`);
}

/** How long a hook waits for the pending-served lock before skipping its update (fail open, never block the tool call). */
export const PENDING_SERVED_LOCK_WAIT_MS = 500;

/** The lock directory that guards one session's pending-served file. */
function pendingServedLock(file: string): string {
  return file.replace(/\.json$/, '.lock');
}

/**
 * Add one entry to the session's pending-served list. The read-modify-write runs under a directory lock, so two hooks
 * recording at once lose nothing. On a lock timeout the entry is skipped (fail open) and `logFn` gets one
 * `lock_timeout` row.
 */
export function recordPendingServed(
  sessionsDir: string,
  sessionId: string,
  entry: PendingServedRecord,
  logFn?: (entry: Record<string, unknown>) => void
): void {
  try {
    const file = pendingServedFile(sessionsDir, sessionId);
    if (!file) return;
    privateDir(sessionsDir);
    withDirLockOrSkip(
      pendingServedLock(file),
      () => {
        let existing: PendingServedRecord[] = [];
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(raw)) existing = raw;
        } catch {
          // fresh
        }
        const now = entry.createdAt;
        const kept = existing
          .filter((e) => e && typeof e.createdAt === 'number' && now - e.createdAt <= PENDING_SERVED_TTL_MS)
          .slice(-(PENDING_SERVED_MAX_ITEMS - 1));
        kept.push(entry);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(kept) + '\n', { mode: PRIVATE_FILE_MODE });
        privateFile(tmp);
        fs.renameSync(tmp, file);
        privateFile(file);
      },
      (err) => {
        try {
          logFn?.({ event: 'lock_timeout', state: 'pending-served', op: 'record', session_id: sessionId, lock: err.lock });
        } catch {
          // logging is best-effort
        }
      },
      { waitMs: PENDING_SERVED_LOCK_WAIT_MS }
    );
  } catch {
    // best-effort
  }
}

export function flushPendingServed(
  sessionsDir: string,
  sessionId: string | undefined | null,
  logFn: (entry: Record<string, unknown>) => void,
  homedir = jevHomeDir(),
  nowMs = Date.now(),
  clock: () => number = Date.now
): void {
  if (!sessionId) return;
  const file = pendingServedFile(sessionsDir, sessionId);
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    // The whole read-modify-write runs under the lock (the work is bounded by the per-flush item and time caps), so a
    // hook recording a new entry at the same time is neither lost nor overwritten. A lock timeout skips this flush.
    withDirLockOrSkip(
      pendingServedLock(file),
      () => {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(raw) || raw.length === 0) return;
        const remaining: PendingServedRecord[] = [];
        let changed = false;
        let processed = 0;
        const startedAt = clock();

        // Oldest first; the sort is stable, so equal timestamps keep their stored order.
        const items = (raw as PendingServedRecord[]).slice().sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0));
        for (const item of items) {
          if (!item || typeof item.createdAt !== 'number' || nowMs - item.createdAt > PENDING_SERVED_TTL_MS) {
            changed = true;
            continue;
          }
          // Bounded work per hook call: past the item cap or the time budget, keep the rest for a later flush.
          if (processed >= PENDING_SERVED_MAX_PER_FLUSH || clock() - startedAt > PENDING_SERVED_BUDGET_MS) {
            remaining.push(item);
            continue;
          }
          processed++;
          let childConvId = item.childConvId ?? null;
          if (!childConvId && item.transcriptPath) {
            const content = readStepContentFromTranscript(item.transcriptPath, item.stepIdx, item.toolCallId);
            if (content) {
              childConvId = extractChildConversationId(content, sessionId);
            }
          }
          let servedModel: string | null = null;
          if (childConvId) {
            servedModel = findServedModelFromTranscript(childConvId, homedir);
          }
          if (childConvId && servedModel) {
            logFn({
              event: 'subagent_served',
              harness: 'antigravity',
              session_id: sessionId,
              child_conversation_id: childConvId,
              requested_model: item.requestedModel ?? null,
              served_model: servedModel,
              backfilled: true
            });
            changed = true;
            continue;
          }
          item.childConvId = childConvId;
          item.attempts = (typeof item.attempts === 'number' ? item.attempts : 0) + 1;
          changed = true;
          if (item.attempts >= PENDING_SERVED_MAX_ATTEMPTS) {
            // Never resolved: log it once so the row is not silently lost, then drop it.
            logFn({
              event: 'subagent_served',
              harness: 'antigravity',
              session_id: sessionId,
              child_conversation_id: childConvId,
              requested_model: item.requestedModel ?? null,
              served_model: null,
              backfill: 'gave_up'
            });
            continue;
          }
          remaining.push(item);
        }

        if (changed) {
          if (remaining.length === 0) {
            fs.unlinkSync(file);
          } else {
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(remaining) + '\n', { mode: PRIVATE_FILE_MODE });
            privateFile(tmp);
            fs.renameSync(tmp, file);
            privateFile(file);
          }
        }
      },
      (err) => {
        try {
          logFn({ event: 'lock_timeout', state: 'pending-served', op: 'flush', session_id: sessionId, lock: err.lock });
        } catch {
          // logging is best-effort
        }
      },
      { waitMs: PENDING_SERVED_LOCK_WAIT_MS }
    );
  } catch {
    // fail-open
  }
}
