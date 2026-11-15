import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isExplicitProOverride, modelTierRank, rankToTierName } from '../src/core/governance.js';
import { readRegularFile, readRegularFileTail } from '../claude/safe-read.js';
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
};

export type AntigravityLogicDeps = {
  approvals?: ApprovalStore;
  sessionModelOverride?: string;
  elevationMode?: 'choice' | 'dialog' | 'clamp';
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
}): string {
  const q = buildElevationQuestion({
    typeName: opts.typeName,
    requestedModel: opts.requestedModel,
    ceilingTier: opts.sessionCeilingTier,
    taskSummary: opts.taskSummary
  });

  return (
    `[jev] Subagent '${opts.typeName}' requested Model '${opts.requestedModel}', which exceeds session ceiling '${opts.sessionCeilingTier}', ` +
    `and no approval covers it. Ask the user with ask_question: one question whose text starts with ` +
    `'${ELEVATE_MARKER_PREFIX}${opts.requestedModel}]', with four options in this order: ` +
    `'${q.options[0]}', '${q.options[1]}', '${q.options[2]}', '${q.options[3]}'. ` +
    `If the user approves, re-invoke with '${opts.requestedModel}'; if No, re-invoke with '${opts.sessionCeilingTier}' (or inherit); ` +
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

export function evaluateAntigravitySubagentCall(
  input: AntigravityHookInput,
  deps: AntigravityLogicDeps = {}
): AntigravityHookDecision {
  const toolName = input?.toolCall?.name || '';
  if (toolName !== 'invoke_subagent') {
    return { decision: 'pass' };
  }

  const sessionId = input.conversationId || 'default-session';
  const nowMs = (deps.now ?? Date.now)();
  const sessionModel = deps.sessionModelOverride || input.modelName || 'gemini-3.8-flash-low';
  const sessionCeilingRank = modelTierRank(sessionModel);
  const sessionCeilingTier = rankToTierName(sessionCeilingRank);

  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);

  // If Model is omitted or inherit, it resolves to session model (proved by control) -> nothing to decide (pass)
  if (!isExplicit || !requestedModel) {
    return { decision: 'pass' };
  }

  const requestedRank = modelTierRank(requestedModel);
  if (requestedRank <= sessionCeilingRank) {
    return { decision: 'pass' };
  }

  // Requested model exceeds session ceiling: ELEVATION
  const args = input.toolCall?.args || {};
  const typeName = String(args.TypeName || args.Role || 'subagent');

  // Check explicit override in user prompt
  if (isExplicitProOverride(input.lastUserInput, requestedModel)) {
    return { decision: 'allow', elevation: 'instructed' };
  }

  // Check covering approval
  const approval = deps.approvals?.claim(sessionId, requestedModel, nowMs);
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
    const count = deps.approvals?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
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
  const count = deps.approvals?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
  if (count <= 2) {
    deps.approvals?.deny(sessionId, requestedModel, nowMs);
    const reason = buildElevationReason({
      typeName,
      requestedModel,
      sessionCeilingTier
    });
    return {
      decision: 'deny',
      reason,
      elevation: 'denied',
      attemptCount: count
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
