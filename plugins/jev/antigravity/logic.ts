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
  type ActiveModelSource,
  type QuotaView
} from '../src/core/governance.js';
import { isRecognisedSubagentModel } from '../src/core/model-tier.js';
import { causeFields, type DenyCause } from '../src/core/deny-cause.js';
import type { JevMode } from '../src/core/config.js';
import { modeBehaviour, telemetryMode } from '../src/core/mode-policy.js';
import { DEFAULT_ANTIGRAVITY_SESSION_MODEL } from '../src/core/session-defaults.js';
import { stopRetryingText } from '../src/core/elevation-text.js';
import { denialPredatesModeChange, type ModeChangeConfigLike } from '../src/core/mode-change.js';
import { privateDir, privateFile, jevHomeDir, PRIVATE_FILE_MODE } from '../src/core/private-fs.js';
import { withDirLockOrSkip } from '../src/core/dir-lock.js';
import { resolveModelUsed, type JevTelemetryEvent, type ModelUsedSource } from '../src/core/telemetry.js';
import { type CostEffort, DEFAULT_COST_EFFORT, antigravityCostFields, antigravityDowngradeSaving, costEffortOf, effortFromModelId } from '../src/core/cost-estimate.js';
import { antigravityEffortFields, callKeyField, joinToken, type EffortFields } from '../src/core/join-keys.js';
import {
  DEFAULT_COST_GATE_MODE,
  antigravityClampModel,
  antigravityCostGate,
  antigravityMarkerModel,
  costComparison,
  parseCostGateMode,
  shadowStateOf,
  type CostGateMode,
  type CostGateShadowState,
  type CostGateState
} from '../src/core/cost-gate.js';
import { ARGON_HOW_SENTENCE, PRO_SERVED_SENTENCE, quotaPoolOfModel, servedModelExpected, servedModelGuidance, servedQuestionPhrase, servedQuotaPool, subagentEnumOf, type QuotaPoolName } from '../src/core/served-model.js';
import { readRegularFile, readRegularFileHead, readRegularFileTail } from '../claude/safe-read.js';
import { antigravityTurnKey, storedClauseFor, type PendingQuestion, type Approval, type ApprovalStore, type ApprovalScope, type ElevationCtx } from './approvals.js';
import {
  ELEVATION_LABELS,
  elevationLabelList,
  parseAnswerLabel,
  type StoredClause,
  type StoredKind
} from '../src/core/elevation-answer.js';

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
  /** Why a `deny` or `ask` held the call (2.3.20); written to the rows as `denyCause` / `askCause`. Chosen by the code path, never by the reason text. */
  cause?: DenyCause;
  permissionOverrides?: string[];
  overwrite?: Record<string, unknown>;
  elevation?: 'approved' | 'instructed' | 'denied' | 'asked' | 'clamped' | 'declined-once' | 'declined-session';
  approvalScope?: ApprovalScope;
  /** What Jev had stored for the model when it denied (2.3.21): `none`, `once-used`, `once-stale` or `effort-below`. */
  stored?: StoredKind;
  /** The scope of the No that lowered this call (`declined-once` / `declined-session`). */
  declineScope?: ApprovalScope;
  /** An answer this call pulled from the transcript and recorded (the hook writes its `elevation_answer` row): what the user said, for which model key, and the effort the stored approval carries. */
  pulledAnswer?: {
    answer: 'yes' | 'no' | null;
    scope: ApprovalScope | null;
    model: string;
    effort: CostEffort | null;
    /** A once answer of an earlier turn: read and dropped, so its row says `recorded: false, reason: "stale"`. */
    stale?: true;
    /** An answer line that is not one of the four labels (free text): read and dropped, so its row says `recorded: false, reason: "label"`. */
    label?: true;
  };
  attemptCount?: number;
  clampedTo?: string;
  /** The effort the cost gate's clamp runs the call at (2.3.19). */
  clampedEffort?: string;
  /** `true` on a dialog-mode `ask` while Antigravity auto-approve is detected: the dialog is approved without being shown. Informational only. */
  autoApproveWarning?: true;
  /** `true`: allowed from an answer read out of the transcript. `'record_failed'`: the answer was there but could not be stored, so nothing was allowed. `'claim_lost'`: it was stored but a parallel pro call claimed it first, so this call was denied. `'mode_changed'`: the pending denial is older than the last mode change, so no answer was read and the call was denied again with a fresh question. */
  pullFallback?: true | 'record_failed' | 'claim_lost' | 'mode_changed';
};

export type AntigravityLogicDeps = {
  approvals?: ApprovalStore;
  sessionModelOverride?: string;
  /** The session record says this is an Orchestrator conversation (the 1.5.14 marker). A legacy Orchestrator id is an Orchestrator session on its own. */
  sessionOrchestrator?: boolean;
  elevationMode?: 'choice' | 'dialog' | 'clamp';
  /** How the cost gate decides (2.3.19): `shadow` (the default; the model rank ceiling decides and the row records what the gate would have done) or `enforce`. JEV_COST_GATE wins. */
  costGateMode?: CostGateMode;
  quotaView?: QuotaView;
  mode?: JevMode;
  /**
   * The Jev config (for the `modeChangedAt` stamp). A pending denial older than the last mode change is never approved from
   * an answer (see `denialPredatesModeChange`). Absent, or with no stamp: no restriction.
   */
  config?: ModeChangeConfigLike;
  now?: () => number;
};

export const ELEVATE_MARKER_PREFIX = '[jev-elevate:';

/** The four options of the question, in order (2.3.21: no timed scope). `no` is this delegation only; `noSession` the rest of the session. */
export const CHOICE_OPTIONS = {
  once: ELEVATION_LABELS.yesOnce,
  session: ELEVATION_LABELS.yesSession,
  no: (ceiling: string) => ELEVATION_LABELS.noOnce(ceiling),
  noSession: ELEVATION_LABELS.noSession
};

/**
 * The deny reason of an `invoke_subagent` call with no explicit `Model` (or `inherit`) under an Orchestrator session (2.3.19: it says
 * what `pro` really is, and how a subagent reaches Argon). An omitted or `inherit` Model is served on the planner, so it is not
 * accepted here; `pro` is Hydrogen at xhigh, so requesting it is no way to a pro-class model.
 */
export const ORCHESTRATOR_EXPLICIT_MODEL_REASON =
  '[jev] Under Orchestrator, set Model explicitly on invoke_subagent: "flash" or "flash_lite" (an omitted or inherit Model runs the subagent on the planner). ' +
  `${PRO_SERVED_SENTENCE} Do not request "pro" to get a pro-class model: it passes when it costs no more than the session, else it needs the [jev-elevate:...] question. ` +
  ARGON_HOW_SENTENCE;


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

/** The tier name a call is run at when the user declines (the session's ceiling tier: `flash` for a flash session), for the line that tells the model. `orchestrator`: an Orchestrator conversation has a flash ceiling. */
export function antigravityCeilingTier(sessionModel: unknown, orchestrator = false): string {
  return rankToTierName(subagentCeilingRank(typeof sessionModel === 'string' && sessionModel ? sessionModel : DEFAULT_ANTIGRAVITY_SESSION_MODEL, orchestrator || isOrchestratorModel(String(sessionModel ?? ''))));
}

export function buildElevationQuestion(opts: {
  typeName: string;
  requestedModel: string;
  ceilingTier: string;
  taskSummary?: string;
  /** What the call really is (`servedQuestionPhrase`): the question says it, so the user decides on the model that runs. */
  servedPhrase?: string;
}): { question: string; options: string[] } {
  const summaryPart = opts.taskSummary ? ` for ${opts.taskSummary}` : '';
  const servedPart = opts.servedPhrase ? ` (${opts.servedPhrase})` : '';
  const question = `${ELEVATE_MARKER_PREFIX}${opts.requestedModel}] Allow subagent '${opts.typeName}' to run on ${opts.requestedModel}${servedPart}${summaryPart} (session ceiling: ${opts.ceilingTier})?`;
  const options = [
    CHOICE_OPTIONS.once,
    CHOICE_OPTIONS.session,
    CHOICE_OPTIONS.no(opts.ceilingTier),
    CHOICE_OPTIONS.noSession
  ];
  return { question, options };
}

export function buildElevationReason(opts: {
  typeName: string;
  requestedModel: string;
  sessionCeilingTier: string;
  taskSummary?: string;
  isOrchestrator?: boolean;
  /** The model the marker names, when it is not the one the call is re-invoked with (the tier-and-effort form of an id, 2.3.19). */
  markerModel?: string;
  /** The cost gate's sentence (2.3.19), when it found the call: "costs 30 vs the session's 22.5 (...)". */
  costNote?: string;
  /** What Jev has stored for the model (2.3.21): the clause the reason ends with (before the stop-retrying sentence). */
  stored?: StoredClause | null;
}): string {
  const servedPhrase = servedQuestionPhrase(opts.requestedModel);
  const q = buildElevationQuestion({
    typeName: opts.typeName,
    requestedModel: opts.markerModel ?? opts.requestedModel,
    ceilingTier: opts.sessionCeilingTier,
    taskSummary: opts.taskSummary,
    servedPhrase
  });

  const noAction = opts.isOrchestrator
    ? `if a No, re-invoke with '${opts.sessionCeilingTier}' or 'flash_lite'`
    : `if a No, re-invoke with '${opts.sessionCeilingTier}' (or inherit)`;
  const served = servedModelGuidance(opts.requestedModel);

  return (
    `[jev] Subagent '${opts.typeName}' requested Model '${opts.requestedModel}', which exceeds session ceiling '${opts.sessionCeilingTier}'${opts.costNote ? ` (it ${opts.costNote})` : ''}, ` +
    `and no approval covers it.${served ? ` ${served}` : ''} Ask the user with ask_question: one question whose text starts with ` +
    `'${ELEVATE_MARKER_PREFIX}${opts.markerModel ?? opts.requestedModel}]', ${servedPhrase ? `followed by a short question that says plainly "${servedPhrase}", ` : ''}with four options in this order: ` +
    `${elevationLabelList(q.options[2])}. ` +
    `If the user approves, re-invoke with '${opts.requestedModel}'; ${noAction}; ` +
    `do not ask in any other form.` +
    (opts.stored ? ` ${opts.stored.text}` : '')
  );
}

/**
 * Whether Antigravity is set to approve tool calls without asking: the global permission preset is TURBO
 * (`~/.gemini/config/config.json`, `permissionPreset`) or the CLI tool permission is `always-proceed`
 * (`~/.gemini/antigravity-cli/settings.json`, `toolPermission`). Best effort and read-only: a missing, unreadable,
 * oversized or malformed file counts as "not detected", and it never throws. HOME is read at call time (see
 * `jevHomeDir`) so a hermetic run never reaches the real home. Used for a warning only; it never changes a decision.
 */
export function detectAntigravityAutoApprove(home: string = jevHomeDir()): boolean {
  const flagged = (file: string, key: string, value: string): boolean => {
    try {
      const read = readRegularFile(file, 256 * 1024);
      if (read.kind !== 'ok') return false;
      const parsed: unknown = JSON.parse(read.text);
      return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)[key] === value;
    } catch {
      return false;
    }
  };
  try {
    return (
      flagged(path.join(home, '.gemini', 'config', 'config.json'), 'permissionPreset', 'AGENT_PERMISSION_PRESET_TURBO') ||
      flagged(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'toolPermission', 'always-proceed')
    );
  } catch {
    return false;
  }
}

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

/**
 * How many questions an ask_question call carries (`args.questions`: an array of strings or objects, or one string),
 * or undefined when the payload does not say. Used so a bare answer is never read for one question of several.
 */
export function askQuestionCount(args: unknown): number | undefined {
  const questions = args && typeof args === 'object' ? (args as Record<string, unknown>).questions : undefined;
  if (Array.isArray(questions)) return questions.length;
  return typeof questions === 'string' ? 1 : undefined;
}

export function extractAskAnswer(
  input: AntigravityHookInput | undefined,
  questionIndex = 0,
  maxBytes = TRANSCRIPT_TAIL_WINDOW_BYTES,
  questionCount?: number
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
    // A bare one-line answer (no `A<n>:` prefix) belongs to a lone question. With several questions it could be any of
    // them, so it is nobody's: only question 0 of an ask not known to carry more than one reads it.
    if (questionIndex !== 0 || (typeof questionCount === 'number' && questionCount > 1)) return null;
    const bare = content.trim();
    return bare.includes('\n') ? null : bare;
  }
  return answers.get(questionIndex + 1) ?? null;
}

export async function pollForAskAnswer(
  input: AntigravityHookInput | undefined,
  questionIndex = 0,
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; maxBytes?: number; questionCount?: number }
): Promise<string | null> {
  const maxWaitMs = opts?.maxWaitMs ?? 2000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 150;
  const maxBytes = opts?.maxBytes;
  const questionCount = opts?.questionCount;

  let answer = extractAskAnswer(input, questionIndex, maxBytes, questionCount);
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
    answer = extractAskAnswer(input, questionIndex, maxBytes, questionCount);
    if (answer !== null) return answer;
  }
  return null;
}

/** An answer text without its `A1:` prefix and its `(Recommended)` tag (a prefix as Antigravity writes it, or a suffix). */
export function answerLabel(answerText: string): string {
  return answerText
    .trim()
    .replace(/^A\d+:\s*/, '')
    .replace(/^\(Recommended\)\s+/i, '')
    .replace(/\s+\(Recommended\)$/i, '')
    .trim();
}

/**
 * What an answer says, and for how long (2.3.21). The answer must be EXACTLY one of the four prescribed labels (after the
 * `A1:` prefix and the `(Recommended)` tag are removed): `Yes, once` and `Yes, for this session` approve (`approved`, `scope`),
 * `No, proceed on <model>` (this delegation only, scope `once`) and `No, don't ask again this session` (scope `session`) decline
 * (`declined`, `scope`). Free text ("No, not even once"), a missing answer and anything else say nothing. Substring matching is
 * deliberately not used. The rules are shared with Claude Code: src/core/elevation-answer.ts.
 */
export function parseElevationAnswer(answerText?: string | null): { approved: boolean; declined?: boolean; scope?: ApprovalScope } {
  if (!answerText || typeof answerText !== 'string') return { approved: false };
  const parsed = parseAnswerLabel(answerLabel(answerText), 'model');
  if (!parsed) return { approved: false };
  return parsed.answer === 'yes' ? { approved: true, scope: parsed.scope } : { approved: false, declined: true, scope: parsed.scope };
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
 * `answerQuestionIdx` is the question index PostToolUse saw for that row (default: the matched call's own). An answer
 * whose key (`<id>#<q>` or `step:<step_index>#<q>`) is in `consumedKeys` already approved a run and is no answer.
 */
export function pullElevationAnswerFromTranscript(
  transcriptPath: string,
  requestedModel: string,
  deniedAtMs?: number,
  answerStepIdx?: number | null,
  answerQuestionIdx?: number | null,
  consumedKeys: readonly string[] = []
): { approved: boolean; declined?: boolean; scope?: ApprovalScope } | null {
  const r = pullElevationAnswerDetailed(transcriptPath, requestedModel, deniedAtMs, answerStepIdx, answerQuestionIdx, consumedKeys);
  return r ? { approved: r.approved, ...(r.declined ? { declined: true } : {}), ...(r.scope ? { scope: r.scope } : {}) } : null;
}

/** Like `pullElevationAnswerFromTranscript`, plus the consumption key of the answer row that was read (when it has one). */
export function pullElevationAnswerDetailed(
  transcriptPath: string,
  requestedModel: string,
  deniedAtMs?: number,
  answerStepIdx?: number | null,
  answerQuestionIdx?: number | null,
  consumedKeys: readonly string[] = []
): { approved: boolean; declined?: boolean; scope?: ApprovalScope; answerKey?: string; /** The answer line as read, when there is one (a row with an answer line that is not one of the four labels has no scope). */ raw?: string } | null {
  const pulled = pullAskAnswerFromTranscript(transcriptPath, `${ELEVATE_MARKER_PREFIX}${requestedModel.toLowerCase()}]`, {
    deniedAtMs,
    answerStepIdx,
    answerQuestionIdx,
    ...(consumedKeys.length > 0 ? { excludeToolCallIds: new Set(consumedKeys) } : {})
  });
  if (!pulled) return null;
  const answerKey = askAnswerKey(pulled.toolCallId, pulled.questionIndex ?? 0, pulled.answerStep);
  return { ...parseElevationAnswer(pulled.raw), ...(answerKey ? { answerKey } : {}), ...(typeof pulled.raw === 'string' && pulled.raw.trim() ? { raw: pulled.raw } : {}) };
}

/** Bounds for `pullAskAnswerFromTranscript`: an older question never answers a newer denial. */
export type PullAskOptions = {
  /** Ignore steps whose timestamp is more than 5 s before this time (a step with no timestamp is not filtered by time). */
  deniedAtMs?: number;
  /** Ignore question steps whose `step_index` is not greater than this (the step the denial happened at). */
  afterStepIdx?: number;
  /**
   * Ignore a question whose answer was already recorded once. An entry is `<toolCallId>#<questionIndex>` (see
   * `askAnswerKey`: one ask can carry several questions under one tool call id), `step:<answerStep>#<questionIndex>`
   * for a transcript with no tool call ids, or, for an older record, a bare tool call id, which consumes every question
   * of that call.
   */
  excludeToolCallIds?: ReadonlySet<string>;
  /** Decides whether a question (or message) text is the one wanted, in place of "contains the marker text". */
  matches?: (text: string) => boolean;
  /**
   * The `step_index` PostToolUse recorded for the question's own answer row. A question with no tool call id is answered
   * by exactly that GENERIC row. Without it, only a question that was the planner step's single tool call falls back to
   * the first GENERIC row after it.
   */
  answerStepIdx?: number | null;
  /**
   * The question index PostToolUse recorded together with `answerStepIdx`: the answer line read from that row is this
   * question's, whichever of several marker questions of the planner step matched. Ignored for a question with a tool
   * call id (the id already names its own question).
   */
  answerQuestionIdx?: number | null;
};

/**
 * The most recent `ask_question` in the bounded transcript tail whose question carries `markerText` (compared lowercase),
 * and the raw answer text of its result row. Null when there is no such question, or its result row is not in the tail
 * yet (`raw` is null when the row is there but holds no answer for the question). `toolCallId` is the question's own tool
 * call id when the transcript names one, so a caller can record that this answer was consumed. The answer comes only from
 * the user's result row (`A<n>:` lines), never from the question or its options.
 */
export function pullAskAnswerFromTranscript(
  transcriptPath: string,
  markerText: string,
  opts: PullAskOptions = {}
): { raw: string | null; toolCallId?: string; questionIndex?: number; answerStep?: number } | null {
  const deniedAtMs = opts.deniedAtMs;
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

    const marker = markerText.toLowerCase();
    // `matches` decides alone when given (the downgrade flow needs "starts with its own marker"); else the marker may be anywhere.
    const questionMatches = (t: string): boolean => (opts.matches ? opts.matches(t) : t.toLowerCase().includes(marker));

    type AskMatch = {
      stepIndexInArray: number;
      toolCallId?: string;
      markerIndex: number;
      /** How many tool calls the planner step made: 0 for a prose match. */
      toolCallCount: number;
      /** How many questions the matched ask carries (undefined for a prose match). */
      questionCount?: number;
    };

    let latestToolMatch: AskMatch | null = null;
    let latestProseMatch: AskMatch | null = null;

    const isGeneric = (s: Record<string, unknown>): boolean => typeof s.type === 'string' && s.type.toUpperCase() === 'GENERIC';
    // The step_index of the answer row of an id-less question in step `i`: the row PostToolUse recorded, else (a lone
    // ask_question only) the first GENERIC row after the question. Undefined when it cannot be told, so nothing is excluded.
    const idlessAnswerStep = (i: number, toolCallCount: number): number | undefined => {
      if (typeof opts.answerStepIdx === 'number') return opts.answerStepIdx;
      if (toolCallCount !== 1) return undefined;
      const row = steps.slice(i + 1).find(isGeneric);
      return typeof row?.step_index === 'number' ? row.step_index : undefined;
    };
    const isConsumed = (key: string | undefined): boolean => key !== undefined && !!opts.excludeToolCallIds?.has(key);
    // With a recorded row AND question, an id-less question is answered by that row's line, whichever matching question
    // of the transcript it is: the key it is consumed under uses the recorded question index too.
    const recordedQuestion =
      typeof opts.answerStepIdx === 'number' && typeof opts.answerQuestionIdx === 'number' ? opts.answerQuestionIdx : undefined;

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
      let questionCount: number | undefined;

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
                  // The first matching question of a step that is not already consumed wins: two questions of one ask
                  // share the tool call id, so an answer is tracked per question (`<id>#<index>`), and the delegation
                  // next in line reads the earliest open question, not the latest.
                  if (matchedTool) return;
                  const qText =
                    typeof q === 'string'
                      ? q
                      : q && typeof q === 'object'
                        ? (q as Record<string, unknown>).question
                        : '';
                  if (typeof qText === 'string' && questionMatches(qText)) {
                    const callId = typeof rec.id === 'string' ? rec.id : undefined;
                    const keyIdx = callId ? idx : (recordedQuestion ?? idx);
                    if (isConsumed(askAnswerKey(callId, keyIdx, callId ? undefined : idlessAnswerStep(i, toolCalls.length)))) return;
                    matchedTool = true;
                    markerIndex = idx;
                    questionCount = questions.length;
                    if (typeof rec.id === 'string') toolCallId = rec.id;
                  }
                });
              } else if (typeof questions === 'string' && questionMatches(questions)) {
                matchedTool = true;
                markerIndex = 0;
                questionCount = 1;
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
        questionMatches(step.content)
      ) {
        matchedProse = true;
        markerIndex = 0;
        if (typeof step.toolCallId === 'string') toolCallId = step.toolCallId;
        else if (typeof step.tool_call_id === 'string') toolCallId = step.tool_call_id;
      }

      if (matchedTool || matchedProse) {
        // A question the denial cannot have caused, or one whose answer was already recorded, is not this denial's answer.
        const stepIndex = typeof step.step_index === 'number' ? step.step_index : null;
        if (typeof opts.afterStepIdx === 'number' && stepIndex !== null && stepIndex <= opts.afterStepIdx) continue;
        if (toolCallId && opts.excludeToolCallIds?.has(toolCallId)) continue;
        // A prose match has no tool call: only a recorded row can say which answer it would read.
        if (matchedProse && !toolCallId && isConsumed(askAnswerKey(undefined, recordedQuestion ?? 0, idlessAnswerStep(i, 0)))) continue;
      }

      if (matchedTool) {
        latestToolMatch = {
          stepIndexInArray: i,
          toolCallId,
          markerIndex,
          toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
          questionCount
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

    if (latestMatch.toolCallId) {
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC') {
          const stepToolId = step.toolCallId ?? step.tool_call_id;
          if (stepToolId === latestMatch.toolCallId) {
            genericStep = step;
            break;
          }
        }
      }
    }

    // No id: the row PostToolUse recorded for the question (its input.stepIdx), and no other. Rows of parallel tool
    // calls follow the planner step in an order that may be call order or completion order, so position is not used.
    if (!latestMatch.toolCallId && typeof opts.answerStepIdx === 'number') {
      const rows: Array<Record<string, unknown>> = [];
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC' && step.step_index === opts.answerStepIdx) rows.push(step);
      }
      // A duplicated index is ambiguous: fail closed.
      genericStep = rows.length === 1 ? rows[0] : null;
    } else if (!latestMatch.toolCallId && latestMatch.toolCallCount === 1) {
      // The first-GENERIC-after fallback is only for a question that carries no tool call id, was not recorded by
      // PostToolUse, and was the single tool call of its planner step. With an id, a missing matching row means the
      // answer is not in the transcript yet; the next GENERIC step belongs to another tool.
      for (let i = latestMatch.stepIndexInArray + 1; i < steps.length; i++) {
        const step = steps[i];
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : '';
        if (stepType === 'GENERIC') {
          genericStep = step;
          break;
        }
      }
    }

    if (!genericStep || typeof genericStep.content !== 'string') {
      return null;
    }

    // A row the recorded step named is read at the recorded question, not at the matched call's own.
    const questionIndex =
      !latestMatch.toolCallId && typeof opts.answerStepIdx === 'number' && recordedQuestion !== undefined ? recordedQuestion : latestMatch.markerIndex;
    const rawAnswer = extractAskAnswer({ content: genericStep.content }, questionIndex, undefined, latestMatch.questionCount);
    return {
      raw: rawAnswer,
      questionIndex,
      ...(latestMatch.toolCallId ? { toolCallId: latestMatch.toolCallId } : {}),
      ...(typeof genericStep.step_index === 'number' ? { answerStep: genericStep.step_index } : {})
    };
  } catch {
    return null;
  }
}
type ChoiceElevationContext = {
  approvalStore: ApprovalStore | undefined;
  sessionId: string;
  requestedModel: string;
  typeName: string;
  sessionCeilingTier: string;
  isOrchestrator: boolean;
  nowMs: number;
  transcriptPath: string | undefined;
  /** The key of the user turn (`antigravityTurnKey`): the attempt counter's, and the turn a once answer belongs to. */
  promptHash: string;
  signature: string;
  config?: ModeChangeConfigLike;
  /** Builds the whole deny reason from the attempt count and what is stored (the run_workflow guard words the question for a script, not a subagent). */
  reasonOverride?: (attempt: number, stored?: StoredClause | null) => string;
  /** The cost gate's sentence (2.3.19): what the call costs against the session's, written into the deny reason. */
  costNote?: string;
  /** Why the call is held (2.3.20): `tier` (default), `cost` or `orchestrator`, `unverifiable` for a script. */
  cause?: DenyCause;
  /** The model the call was written with, when `requestedModel` (the marker's and the approval's key) is its tier-and-effort form: the deny reason re-invokes with this one. */
  displayModel?: string;
  /** The effort the call runs at, when its model id names none (the cost gate's call effort): what the stored clause compares an approval's effort with. */
  callEffort?: CostEffort;
  /**
   * A call that can be run on another model (an `invoke_subagent`): what a No lowers it to (`allow` + `overwrite: { Model }`, and
   * the effort when the clamp lowers it). Absent (a script, which cannot be clamped): a No is recorded and the script is denied with
   * `declineReason` instead.
   */
  declineClamp?: { model: string; effort?: string };
  declineReason?: (scope: ApprovalScope) => string;
};

/** The decision of a call the user declined (a No, 2.3.21): the clamp (`allow` + `overwrite`) when the call can be run on another model, else a deny that says not to ask again. */
export function declinedDecision(
  ctx: Pick<ChoiceElevationContext, 'declineClamp' | 'declineReason' | 'cause' | 'sessionCeilingTier'>,
  scope: ApprovalScope,
  extra: Partial<AntigravityHookDecision> = {}
): AntigravityHookDecision {
  const elevation = scope === 'session' ? 'declined-session' : 'declined-once';
  if (ctx.declineClamp) {
    return {
      decision: 'allow',
      overwrite: { Model: ctx.declineClamp.model },
      elevation,
      declineScope: scope,
      clampedTo: ctx.declineClamp.model,
      ...(ctx.declineClamp.effort ? { clampedEffort: ctx.declineClamp.effort } : {}),
      ...extra
    };
  }
  return {
    decision: 'deny',
    reason: ctx.declineReason ? ctx.declineReason(scope) : `[jev] The user declined this model ${scope === 'session' ? 'for this session' : 'for this delegation'}; use '${ctx.sessionCeilingTier}' or lower and do not ask again.`,
    cause: ctx.cause ?? 'tier',
    elevation,
    declineScope: scope,
    ...extra
  };
}

/**
 * The approval covering `requested`, claimed, unless a No the user gave (2.3.21) covers it too: within its turn a live once No wins over
 * a standing "Yes, for this session" (the Yes is kept, not spent, and applies again in later turns), so the No is applied by
 * `resolveChoiceElevation`'s own `claimDecline` and the approval is left alone. Only the choice flow reads a No; in the other modes
 * (`dialog`, `clamp`) this is a plain `claim`. An unreadable store reads as no No.
 */
export function claimUnlessDeclined(
  store: ApprovalStore | undefined,
  sessionId: string,
  requested: string,
  nowMs: number,
  effort: CostEffort | undefined,
  ectx: ElevationCtx,
  elevationMode: string = 'choice'
): Approval | null {
  if (!store) return null;
  if (elevationMode === 'choice') {
    try {
      if (store.peekDecline?.(sessionId, requested, nowMs, ectx)) return null;
    } catch {
      // read as no No
    }
  }
  return store.claim(sessionId, requested, nowMs, effort, ectx);
}

/**
 * The choice flow's tail, used by choice mode: a No the user already gave (2.3.21) runs the call on the session model, no
 * question; otherwise count the attempt, pull a late answer from the transcript on every attempt (a Yes allows, a No clamps), otherwise
 * deny with what is stored. It never returns `ask`: under auto-approve a dialog is approved without being shown, so a repeated attempt
 * would run the stronger model unapproved.
 */
export function resolveChoiceElevation(ctx: ChoiceElevationContext): AntigravityHookDecision {
  const { approvalStore, sessionId, requestedModel, typeName, sessionCeilingTier, isOrchestrator, nowMs, promptHash, signature } = ctx;
  const ectx: ElevationCtx = { turn: promptHash, config: ctx.config ?? null };
  // A No already on record: this delegation (the next launch of the turn) or the rest of the session. A subagent call is clamped; a script
  // cannot be, so it is denied without the question. Either way a `once` No is spent by this launch (the next one of the turn is asked
  // about again, not denied silently for the rest of the turn); a session No stands.
  try {
    const no = approvalStore?.claimDecline?.(sessionId, requestedModel, nowMs, ectx);
    if (no) return declinedDecision(ctx, no.scope);
  } catch {
    // An unreadable store: the call is denied below, as for a first attempt.
  }
  const count = approvalStore?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
  let pullFallback: 'record_failed' | 'claim_lost' | 'mode_changed' | undefined;
  let stalePulled: AntigravityHookDecision['pulledAnswer'] | undefined;
  if (approvalStore && ctx.transcriptPath && typeof approvalStore.wasDeniedRecently === 'function') {
    const deniedAtMs = approvalStore.wasDeniedRecently(sessionId, requestedModel, nowMs);
    // A question-pending note (2.3.21: PostToolUse saw an unprompted question answered but its row was not in the transcript yet) stands in
    // for the denial's own recorded answer row: the same row is read, at the step and question the note recorded. A note voided by a mode
    // change is not found; a note outlives a denial for the model (the row may still land), and a row the denial itself recorded wins over it.
    let pending: PendingQuestion | null = null;
    try {
      pending = approvalStore.getPendingQuestion?.(sessionId, requestedModel, ctx.config) ?? null;
      if (pending && typeof deniedAtMs === 'number' && (approvalStore.getAnswerStep?.(sessionId, requestedModel, nowMs) ?? null) !== null) pending = null;
    } catch {
      pending = null;
    }
    // The answer was read: the note is done (an answer row is consumed once, so it is not read again whatever happens to the note).
    const clearPending = (): void => {
      if (!pending) return;
      try {
        approvalStore.clearPendingQuestion?.(sessionId, requestedModel);
      } catch {
        // a stale note is harmless: the consumed answer row is not read twice
      }
    };
    if (!pending && typeof deniedAtMs === 'number' && denialPredatesModeChange(deniedAtMs, ctx.config, 'antigravity')) {
      // The mode changed after this denial (on, then on-demand or off, then on again): an answer to it may have been
      // given where nothing is recorded, so it is not read. The denial below is issued afresh, with a fresh question.
      pullFallback = 'mode_changed';
    } else if (typeof deniedAtMs === 'number' || pending) {
      // The answer row PostToolUse recorded for the question; without it only a lone ask_question can be read.
      let answerStepIdx: number | null = null;
      let answerQuestionIdx: number | null = null;
      let consumedKeys: string[] = [];
      // The turn the answer was given in: a pulled `once` answer belongs to it, not to the turn of the launch that pulls it.
      let answerTurn: string | null = null;
      try {
        answerTurn = pending ? (pending.turn ?? null) : (approvalStore.getAnswerTurn?.(sessionId, requestedModel, nowMs) ?? null);
        answerStepIdx = pending ? pending.stepIdx : (approvalStore.getAnswerStep?.(sessionId, requestedModel, nowMs) ?? null);
        answerQuestionIdx = pending ? (pending.questionIdx ?? null) : (approvalStore.getAnswerQuestion?.(sessionId, requestedModel, nowMs) ?? null);
        consumedKeys = approvalStore.getConsumedAnswers?.(sessionId) ?? [];
      } catch {
        // An unreadable store: record() below re-checks the consumed answers under its lock and throws too.
        answerStepIdx = null;
        answerQuestionIdx = null;
        consumedKeys = [];
      }
      const pull = pullElevationAnswerDetailed(
        ctx.transcriptPath,
        requestedModel,
        // A note has no denial time to bound the read by (the question may be older than anything Jev did); the recorded step pins the row.
        pending ? undefined : typeof deniedAtMs === 'number' ? deniedAtMs : undefined,
        answerStepIdx,
        answerQuestionIdx,
        consumedKeys
      );
      if (pull && pull.scope === 'once' && (pull.approved || pull.declined) && answerTurn !== null && answerTurn !== promptHash) {
        // A once answer given in an earlier turn than this launch's: it was dropped when that turn ended (a new user message), so it is read and
        // consumed but never applied. Its one `elevation_answer` row says so, and the call goes on to the denial below with a fresh question.
        try {
          approvalStore.consumeAnswers?.(sessionId, pull.answerKey ? [pull.answerKey] : []);
        } catch {
          // the row may be read once more: it is stale again
        }
        clearPending();
        stalePulled = { answer: pull.approved ? 'yes' : 'no', scope: 'once', model: requestedModel, effort: null, stale: true };
      } else if (pull && pull.raw && !pull.approved && !pull.declined) {
        // The row holds an answer that is not one of the four labels (free text via Other): it is read and consumed (never read again), the
        // note is cleared, and its one `elevation_answer` row says `recorded: false, reason: "label"`. The call goes on to the denial below.
        try {
          approvalStore.consumeAnswers?.(sessionId, pull.answerKey ? [pull.answerKey] : []);
        } catch {
          // the row may be read once more: it is a wrong label again
        }
        clearPending();
        stalePulled = { answer: null, scope: null, model: requestedModel, effort: null, label: true };
      } else if (pull?.approved && pull.scope) {
        // Allow only when the approval was really stored AND claimed by this call: a failed record (a lock timeout
        // throws) would leave the denial in place and let the same answer be pulled again, and a lost claim means a
        // parallel pro call took the "once" approval, so this one is denied (one answer, one run). The record
        // refuses an answer row that already approved a run. recordAndClaim does both under one lock, so there is
        // no gap; a store without it falls back to record then claim, and only a claim that returns an approval
        // allows.
        const pulled = { model: requestedModel, scope: pull.scope, created_at: nowMs, ...(pull.scope === 'once' ? { turn: promptHash } : {}) };
        const keys = pull.answerKey ? [pull.answerKey] : undefined;
        let stored = false;
        let claimed = false;
        let storedModel = requestedModel;
        try {
          if (typeof approvalStore.recordAndClaim === 'function') {
            const res = approvalStore.recordAndClaim(sessionId, pulled, keys, ectx);
            stored = res.stored === true;
            claimed = stored && res.approval !== null;
            if (res.approval) storedModel = res.approval.model;
          } else {
            stored = approvalStore.record(sessionId, pulled, keys, ctx.config) === true;
            claimed = stored && approvalStore.claim(sessionId, requestedModel, nowMs, undefined, ectx) !== null;
          }
        } catch {
          stored = false;
          claimed = false;
        }
        if (stored) clearPending();
        if (claimed) {
          return {
            decision: 'allow',
            elevation: 'approved',
            approvalScope: pull.scope,
            pullFallback: true,
            pulledAnswer: { answer: 'yes', scope: pull.scope, model: requestedModel, effort: effortFromModelId(storedModel) }
          };
        }
        pullFallback = stored ? 'claim_lost' : 'record_failed';
      } else if (pull?.declined && pull.scope) {
        // A No pulled from the transcript: recorded and, for a call that can be clamped, applied to this call at once (a once No is spent).
        const decline = { model: requestedModel, scope: pull.scope, created_at: nowMs, ...(pull.scope === 'once' ? { turn: promptHash } : {}) };
        const keys = pull.answerKey ? [pull.answerKey] : undefined;
        let applied = false;
        try {
          if (ctx.declineClamp && typeof approvalStore.recordDeclineAndClaim === 'function') {
            const res = approvalStore.recordDeclineAndClaim(sessionId, decline, keys, ectx);
            applied = res.stored === true && res.decline !== null;
          } else if (typeof approvalStore.recordDecline === 'function') {
            applied = approvalStore.recordDecline(sessionId, decline, keys) === true && !ctx.declineClamp;
          }
        } catch {
          applied = false;
        }
        if (applied) clearPending();
        if (applied) return declinedDecision(ctx, pull.scope, { pullFallback: true, pulledAnswer: { answer: 'no', scope: pull.scope, model: requestedModel, effort: null } });
        pullFallback = 'record_failed';
      }
    }
  }

  // What is stored for the model, read before the denial is noted (the clause says what Jev has, not what this deny writes).
  const snapshot = approvalStore?.snapshot?.(sessionId);
  const clause = snapshot ? storedClauseFor(snapshot, requestedModel, ctx.callEffort, ectx) : null;
  approvalStore?.deny(sessionId, requestedModel, nowMs);
  // Choice mode never returns `ask`: under Antigravity auto-approve a dialog is approved without being shown, so a
  // repeated attempt would run the stronger model unapproved. From the third attempt the reason says plainly to stop.
  let reason: string;
  if (ctx.reasonOverride) {
    reason = ctx.reasonOverride(count, clause);
  } else {
    const baseReason = buildElevationReason({
      typeName,
      requestedModel: ctx.displayModel ?? requestedModel,
      markerModel: requestedModel,
      sessionCeilingTier,
      isOrchestrator,
      costNote: ctx.costNote,
      stored: clause
    });
    const stop = stopRetryingText(count, requestedModel, sessionCeilingTier, 'ask_question');
    reason = stop ? `${baseReason} ${stop}` : baseReason;
  }
  return {
    decision: 'deny',
    reason,
    cause: ctx.cause ?? 'tier',
    elevation: 'denied',
    attemptCount: count,
    ...(clause ? { stored: clause.stored } : {}),
    ...(pullFallback ? { pullFallback } : {}),
    ...(stalePulled ? { pulledAnswer: stalePulled } : {})
  };
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
  const sessionModel = deps.sessionModelOverride || input.modelName || DEFAULT_ANTIGRAVITY_SESSION_MODEL;
  const mode: JevMode = deps.mode ?? 'on';

  // A mode without decisions (on-demand; the hook never calls this for off) makes none: every invoke_subagent passes
  // before any check (no deny, no ask, no overwrite, no approvals read or recorded, no attempt counted). The hook still
  // writes the agent_call telemetry row for it.
  if (!modeBehaviour(mode).decisions) {
    return { decision: 'pass' };
  }

  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);

  // 1. Reject openrouter_free and invalid model values
  if (isExplicit && requestedModel) {
    const reqLower = requestedModel.toLowerCase();
    if (reqLower.includes('free') || reqLower.includes('openrouter')) {
      return {
        decision: 'deny',
        reason: '[jev] Antigravity invoke_subagent does not support openrouter/free models directly. Use jev_execute_free or jev_agent_free for autonomous free-tier tasks.',
        cause: 'unranked'
      };
    }
    if (!isRecognisedSubagentModel(reqLower)) {
      return {
        decision: 'deny',
        reason: `[jev] Unrecognized model '${requestedModel}' on invoke_subagent. Choose one of: inherit, flash_lite, flash, pro.`,
        cause: 'unranked'
      };
    }
  }

  // 2. Orchestrator omitted/inherit rule
  const isOrchestrator = deps.sessionOrchestrator === true || isOrchestratorModel(sessionModel);
  let effectiveTier: string;

  if (!isExplicit || !requestedModel) {
    if (isOrchestrator) {
      return {
        decision: 'deny',
        reason: ORCHESTRATOR_EXPLICIT_MODEL_REASON,
        cause: 'orchestrator'
      };
    }
    effectiveTier = rankToTierName(subagentCeilingRank(sessionModel, isOrchestrator));
  } else {
    effectiveTier = requestedModel;
  }

  // 3. Quota check (BEFORE any approval or override!)
  if (deps.quotaView) {
    // The pool the call draws is the pool of the model it is SERVED on (2.3.20): an enum value by its served model (`pro` is served on
    // Gemini 4 Hydrogen, so it draws the Gemini pool), a full id by its family, an omitted or `inherit` Model the parent's pool.
    const pool = poolForTier(deps.quotaView, !isExplicit || !requestedModel ? 'inherit' : requestedModel, sessionModel);
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

    if (pool.strategy === 'free_only') {
      return {
        decision: 'deny',
        reason: `[jev] ${poolLabel} quota is critically low${pct}. All paid tiers ('${effectiveTier}') are blocked. Offload to openrouter/free via jev_execute_free or jev_agent_free.`,
        cause: 'quota'
      };
    }
    if (pool.strategy === 'conserve' && modelTierRank(effectiveTier) > 1) {
      return {
        decision: 'deny',
        reason: `[jev] ${poolLabel} quota is in conserve mode${pct}. Subagents above flash_lite are blocked. Re-invoke with Model: "flash_lite" or use jev_execute_free.`,
        cause: 'quota'
      };
    }
  }

  // If Model is omitted/inherit and passed Step 3 quota check on non-Orchestrator:
  if (!isExplicit || !requestedModel) {
    return { decision: 'pass' };
  }

  // 4. Cost gate / Elevation (2.3.19). Where the cost of the call can be computed it decides: the call needs approval only
  // when it costs more than the session's own model at the session's effort (the effort is the suffix of each model id). Where
  // it cannot (a model with no tier) the model ceiling by rank decides, as before.
  const sessionCeilingRank = subagentCeilingRank(sessionModel, isOrchestrator);
  const sessionCeilingTier = rankToTierName(sessionCeilingRank);
  const requestedRank = modelTierRank(requestedModel);
  const args = input.toolCall?.args || {};
  const typeName = String(args.TypeName || args.Role || 'subagent');
  // The user's own words (a model they named) raise what the call is held to; the gate is also computed without them to see
  // whether it was them that let the call through.
  const named = isExplicitProOverride(input.lastUserInput, requestedModel);
  const gate0 = antigravityCostGate(requestedModel, sessionCeilingTier, sessionModel);
  // Shadow (the default): the rank ceiling decides, the gate is only computed for the row. Enforce: the gate decides.
  const gateMode = costGateModeOf(deps);
  const gateOn = gateMode === 'enforce' && gate0.kind !== 'fallback';
  // The tier check: a stronger model always asks (2.3.19). A full id whose tier is above the session's ceiling is an elevation
  // whatever its effort and whatever the gate says, so `gemini-4-argon-low` under the Orchestrator's flash ceiling asks even when
  // the planner runs at max. An enum value (`pro`, `flash`) is priced by the model it is served on and stays with the gate.
  const tierAbove = gateOn && subagentEnumOf(requestedModel) === null && requestedRank > sessionCeilingRank;

  if (gateOn ? gate0.kind === 'pass' && !tierAbove : requestedRank <= sessionCeilingRank) {
    return { decision: 'pass' };
  }

  // Requested model exceeds what the session is held to: ELEVATION. With the user's own words the baseline is raised to the
  // model they named: the call is let through as instructed unless its effort still pushes it over.
  const gate = gateOn && named ? antigravityCostGate(requestedModel, sessionCeilingTier, sessionModel, { model: requestedModel }) : gate0;
  const overGate = gateOn && gate.kind === 'over' ? gate : null;
  // What the marker and the approval carry: the tier and effort form when the gate is over, and for a tier ask the gate let through.
  const markerGate = overGate ?? (tierAbove && gate.kind === 'pass' ? gate : null);
  const gateNote = overGate ? { costNote: costComparison(overGate, (m) => String(m ?? 'the session model')) } : {};
  // Why the call is held (2.3.20), from the path that held it: the enforced cost gate (and not the tier check, which stands before it
  // for a full id) is `cost`; otherwise the rank ceiling, which under an Orchestrator conversation is the Orchestrator's flash ceiling.
  const heldBy: DenyCause = overGate && !tierAbove ? 'cost' : isOrchestrator ? 'orchestrator' : 'tier';

  // Check explicit override in user prompt
  if (named && !overGate) {
    return { decision: 'allow', elevation: 'instructed' };
  }

  // Check covering approval. The turn a once answer belongs to is the user turn this call is in (`antigravityTurnKey`).
  const markerModel = antigravityMarkerModel(requestedModel, markerGate);
  const promptHash = antigravityTurnKey(input.lastUserInput);
  const ectx: ElevationCtx = { turn: promptHash, config: deps.config ?? null };
  const callEffort = subagentEnumOf(requestedModel) === null ? markerGate?.callEffort : undefined;
  const elevationMode = deps.elevationMode || (process.env.JEV_ELEVATION === 'dialog' || process.env.JEV_ELEVATION === 'clamp' ? process.env.JEV_ELEVATION : 'choice');
  // In choice mode a live No (2.3.21) is looked at before the approvals: a once No wins over a session Yes within its turn.
  const approval = claimUnlessDeclined(approvalStore, sessionId, markerModel, nowMs, callEffort, ectx, elevationMode);
  if (approval) {
    return {
      decision: 'allow',
      elevation: 'approved',
      approvalScope: approval.scope
    };
  }

  if (elevationMode === 'dialog') {
    // The decision stays `ask`; when Antigravity auto-approves, that ask is approved without a dialog, so say so.
    return {
      decision: 'ask',
      reason: `[jev] Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'${overGate ? ` (it ${gateNote.costNote})` : ''}. Approve to run on ${requestedModel}, or cancel.${servedModelGuidance(requestedModel) ? ` ${servedModelGuidance(requestedModel)}` : ''}`,
      cause: heldBy,
      elevation: 'asked',
      ...(detectAntigravityAutoApprove() ? { autoApproveWarning: true as const } : {})
    };
  }

  const signature = `${typeName}:${requestedModel}`;
  // What the cost gate's clamp (and a No) lowers the call to: the ceiling model when the model is what is too much, and the effort lowered to the highest level that fits.
  const clampModel = overGate ? antigravityClampModel(requestedModel, overGate, sessionCeilingTier) : sessionCeilingTier;

  if (elevationMode === 'clamp') {
    // Every attempt is clamped, never asked: under auto-approve an `ask` is approved without a dialog. With the cost gate the clamp
    // is the most expensive (model, effort) that keeps the call within the session's cost: the ceiling model when the model is what
    // is too much, and the effort lowered to the highest level that fits.
    const count = approvalStore?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
    return {
      decision: 'allow',
      overwrite: { Model: clampModel },
      elevation: 'clamped',
      clampedTo: clampModel,
      ...(overGate ? { clampedEffort: overGate.clampEffort } : {}),
      attemptCount: count
    };
  }

  // Choice mode (default).
  return resolveChoiceElevation({
    approvalStore,
    sessionId,
    requestedModel: markerModel,
    // The call is re-invoked with the model it was written with; the marker and the approval carry the tier and effort form.
    displayModel: requestedModel,
    typeName,
    sessionCeilingTier,
    isOrchestrator,
    nowMs,
    transcriptPath: input.transcriptPath,
    promptHash,
    signature,
    config: deps.config,
    cause: heldBy,
    ...(callEffort ? { callEffort } : {}),
    // A No the user gave runs the call on the session model (the same clamp as `JEV_ELEVATION=clamp`), without a question.
    declineClamp: { model: clampModel, ...(overGate ? { effort: overGate.clampEffort } : {}) },
    ...(overGate ? { costNote: gateNote.costNote } : {})
  });
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
  clock: () => number = Date.now,
  lockWaitMs = PENDING_SERVED_LOCK_WAIT_MS
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
              ...callKeyField(item.toolCallId),
              child_conversation_id: childConvId,
              requested_model: item.requestedModel ?? null,
              served_model: servedModel,
              ...quotaPoolField(item.requestedModel, servedModel, null),
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
              ...callKeyField(item.toolCallId),
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
      { waitMs: lockWaitMs }
    );
  } catch {
    // fail-open
  }
}

/**
 * The key an answered question is recorded under: `<toolCallId>#<questionIndex>`. One `ask_question` can carry several
 * questions under one tool call id, so consuming the whole call would hide the other questions' answers from the
 * delegations they belong to.
 *
 * Real Antigravity transcripts carry no tool call id: then the key is `step:<answerStep>#<questionIndex>`, where
 * `answerStep` is the `step_index` of the ask's own answer row (what PostToolUse reports as `stepIdx`), so one answer
 * cannot be consumed twice or by another question. Undefined when there is neither an id nor a row.
 */
export function askAnswerKey(toolCallId: string | undefined, questionIndex: number, answerStep?: number | null): string | undefined {
  if (toolCallId) return `${toolCallId}#${questionIndex}`;
  return typeof answerStep === 'number' && Number.isInteger(answerStep) && answerStep >= 0 ? `step:${answerStep}#${questionIndex}` : undefined;
}

/**
 * Like {@link pollForAskAnswer} for an ask with several questions: ONE bounded wait for the result row, shared by all of
 * them, then every question's own `A<n>` line is read from what the transcript holds at that moment. `questionIndexes`
 * are read in order and the answers returned in the same order (`null` for an index with no answer line). N questions
 * cost one wait window, not N, so the hook stays inside its timeout however many questions the assistant packs into
 * one ask.
 */
export async function pollForAskAnswers(
  input: AntigravityHookInput | undefined,
  questionIndexes: number[],
  opts?: { maxWaitMs?: number; pollIntervalMs?: number; maxBytes?: number; questionCount?: number }
): Promise<Array<string | null>> {
  const readAll = (): Array<string | null> => questionIndexes.map((i) => extractAskAnswer(input, i, opts?.maxBytes, opts?.questionCount));
  const anyAnswer = (list: Array<string | null>) => list.some((a) => a !== null);

  let answers = readAll();
  if (anyAnswer(answers)) return answers;

  const contentOnStdin = typeof input?.content === 'string' && input.content.trim().length > 0;
  if (contentOnStdin || !input?.transcriptPath || typeof input?.stepIdx !== 'number') return answers;

  const maxWaitMs = opts?.maxWaitMs ?? 2000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 150;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const remaining = maxWaitMs - (Date.now() - startTime);
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    answers = readAll();
    if (anyAnswer(answers)) return answers;
  }
  return answers;
}

/**
 * Where a telemetry row's session model came from: `hook` (the model the hook input reported), `session-record` (the
 * stored record's sticky session model, the Orchestrator planner, kept for a turn that reported another id), or the
 * quota view's own source.
 */
export type AntigravitySessionModelSource = 'hook' | 'session-record' | ActiveModelSource;

export function resolveAntigravitySessionModel(
  inputModelName?: string | null,
  quotaView?: Pick<QuotaView, 'active_model' | 'activeModelSource'> | null,
  /** The id the turn itself reported. When it differs from `inputModelName`, that one is the stored sticky model, not raw hook input. */
  turnModel?: string | null
): { sessionModel: string | null; sessionModelSource: AntigravitySessionModelSource | null } {
  const hookModel = typeof inputModelName === 'string' ? inputModelName.trim() : '';
  if (hookModel.length > 0) {
    const reported = typeof turnModel === 'string' ? turnModel.trim() : '';
    const sticky = reported.length > 0 && reported !== hookModel;
    return { sessionModel: hookModel, sessionModelSource: sticky ? 'session-record' : 'hook' };
  }
  const quotaModel = typeof quotaView?.active_model === 'string' ? quotaView.active_model.trim() : '';
  if (quotaModel.length > 0) {
    return {
      sessionModel: quotaModel,
      sessionModelSource: quotaView?.activeModelSource ?? 'quota-state'
    };
  }
  return { sessionModel: null, sessionModelSource: null };
}

/** Strip host metadata wrappers from Antigravity's `lastUserInput` before hashing or dispatching. */
export function cleanUserInput(raw: string): string {
  if (!raw) return '';
  let text = raw;
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<\/?USER_REQUEST>/gi, '');
  return text.trim();
}

/** Short stable id for one user turn, shared between PreInvocation and PreToolUse telemetry. */
export function turnId(prompt: string): string {
  return createHash('sha1').update(cleanUserInput(prompt).trim()).digest('hex').slice(0, 12);
}

export type AntigravityTurnState = {
  turn: string;
  recommendedTier?: string;
  recommendedSubagent?: string;
  effort?: string;
  at: string;
};

function turnStateFile(sessionsDir: string, sessionId: string): string | null {
  const safe = safeSessionId(sessionId);
  if (!safe) return null;
  return path.join(sessionsDir, `${safe}.turn.json`);
}

export function readAntigravityTurn(
  sessionsDir: string,
  sessionId: string | undefined | null
): AntigravityTurnState | null {
  if (!sessionId) return null;
  const file = turnStateFile(sessionsDir, sessionId);
  if (!file) return null;
  try {
    const read = readRegularFile(file, 64 * 1024);
    if (read.kind !== 'ok') return null;
    const parsed = JSON.parse(read.text);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.turn !== 'string' || parsed.turn.length === 0) {
      return null;
    }
    return {
      turn: parsed.turn,
      ...(typeof parsed.recommendedTier === 'string' && parsed.recommendedTier.length > 0
        ? { recommendedTier: parsed.recommendedTier }
        : {}),
      ...(typeof parsed.recommendedSubagent === 'string' && parsed.recommendedSubagent.length > 0
        ? { recommendedSubagent: parsed.recommendedSubagent }
        : {}),
      ...(typeof parsed.effort === 'string' && parsed.effort.length > 0 ? { effort: parsed.effort } : {}),
      at: typeof parsed.at === 'string' ? parsed.at : ''
    };
  } catch {
    return null;
  }
}

export function writeAntigravityTurn(
  sessionsDir: string,
  sessionId: string | undefined | null,
  state: AntigravityTurnState
): void {
  if (!sessionId) return;
  const file = turnStateFile(sessionsDir, sessionId);
  if (!file) return;
  try {
    privateDir(sessionsDir);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: PRIVATE_FILE_MODE });
    privateFile(tmp);
    fs.renameSync(tmp, file);
    privateFile(file);
  } catch {
    // best-effort; never crash the hook
  }
}

/** How long a hook waits for the turn lock before it skips the turn-state update (fail open, never block the tool call). */
export const TURN_LOCK_WAIT_MS = 500;
/** The most calls one turn's pending list keeps (the newest win). */
export const PENDING_RECOMMENDATION_MAX_CALLS = 20;
/** A pending call older than this is dropped: the pre-flight is not coming for it. */
export const PENDING_RECOMMENDATION_TTL_MS = 10 * 60_000;

/**
 * An `agent_call` that was written before its turn's recommendation existed. It holds what a late
 * `agent_call_recommendation` row needs to stand alone (the decision and the models), never prompt text.
 */
export type PendingRecommendationCall = {
  /** The key this call is tracked under here (see {@link antigravityCallKey}): the tool call id, else a step or one-off key. */
  callKey: string;
  /** The host's tool call id, when it is a short token (2.3.20): what the late row writes as `callKey`. Absent when the call had none, or a malformed one. */
  callId?: string;
  /** Epoch ms the call was recorded. */
  at: number;
  decision: string;
  requestedModel: string | null;
  /** Absent on a denied call (it did not run). */
  modelUsed?: string;
  modelUsedSource?: ModelUsedSource;
  toolName: string;
  taskSummary?: string;
  sessionModel: string | null;
  sessionModelSource: string | null;
};

/** The lock that guards one conversation's turn state and its pending-call list (one lock for both, so check-and-record is atomic). */
function turnLock(sessionsDir: string, sessionId: string): string | null {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(sessionsDir, `${safe}.turn.lock`) : null;
}

function turnPendingFile(sessionsDir: string, sessionId: string): string | null {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(sessionsDir, `${safe}.turn-pending.json`) : null;
}

function readPendingList(file: string): { turn: string; calls: PendingRecommendationCall[] } | null {
  try {
    const read = readRegularFile(file, 256 * 1024);
    if (read.kind !== 'ok') return null;
    const parsed = JSON.parse(read.text);
    if (!parsed || typeof parsed.turn !== 'string' || !Array.isArray(parsed.calls)) return null;
    const calls = parsed.calls.filter(
      (c: unknown): c is PendingRecommendationCall =>
        !!c && typeof (c as PendingRecommendationCall).callKey === 'string' && typeof (c as PendingRecommendationCall).at === 'number'
    );
    return { turn: parsed.turn, calls };
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(tmp);
  fs.renameSync(tmp, file);
  privateFile(file);
}

/**
 * The PreToolUse side of the recommendation join, atomic with the pre-flight's write. Under the turn lock: when the
 * state already holds this turn's recommendation it is returned (and nothing is recorded); otherwise the call is put on
 * the turn's pending list (bounded to {@link PENDING_RECOMMENDATION_MAX_CALLS}, expiring after
 * {@link PENDING_RECOMMENDATION_TTL_MS}, replaced when another turn's list is there) so the pre-flight can write the late
 * row. A lock timeout or any error skips the record (fail open): the caller still gets whatever an unlocked read found.
 */
export function claimTurnRecommendation(
  sessionsDir: string,
  sessionId: string | undefined | null,
  turn: string,
  call: PendingRecommendationCall
): { turnState: AntigravityTurnState | null; recorded: boolean } {
  const matching = (s: AntigravityTurnState | null) => (s && s.turn === turn && s.recommendedTier ? s : null);
  if (!sessionId) return { turnState: null, recorded: false };
  const lock = turnLock(sessionsDir, sessionId);
  const pendingFile = turnPendingFile(sessionsDir, sessionId);
  if (!lock || !pendingFile) return { turnState: null, recorded: false };
  try {
    privateDir(sessionsDir);
    const res = withDirLockOrSkip(
      lock,
      () => {
        const state = matching(readAntigravityTurn(sessionsDir, sessionId));
        if (state) return { turnState: state, recorded: false };
        const existing = readPendingList(pendingFile);
        const kept = (existing && existing.turn === turn ? existing.calls : [])
          .filter((c) => call.at - c.at <= PENDING_RECOMMENDATION_TTL_MS && c.callKey !== call.callKey)
          .slice(-(PENDING_RECOMMENDATION_MAX_CALLS - 1));
        kept.push(call);
        writeJsonAtomic(pendingFile, { turn, calls: kept });
        return { turnState: null, recorded: true };
      },
      () => {
        // lock busy: fall through to the unlocked read below
      },
      { waitMs: TURN_LOCK_WAIT_MS }
    );
    if (res) return res;
  } catch {
    // fail open
  }
  return { turnState: matching(readAntigravityTurn(sessionsDir, sessionId)), recorded: false };
}

/**
 * The pre-flight side: store the turn's state (with its recommendation) and hand back, clearing them, the calls of the
 * SAME turn that were written without one, so the caller can append a late row for each. Under the turn lock. A lock
 * timeout writes the state unlocked and returns none (fail open: those calls keep `recommendationPending` and get no
 * late row).
 */
export function commitAntigravityTurn(
  sessionsDir: string,
  sessionId: string | undefined | null,
  state: AntigravityTurnState,
  lockWaitMs = TURN_LOCK_WAIT_MS
): PendingRecommendationCall[] {
  if (!sessionId) return [];
  const lock = turnLock(sessionsDir, sessionId);
  const file = turnStateFile(sessionsDir, sessionId);
  const pendingFile = turnPendingFile(sessionsDir, sessionId);
  if (!lock || !file || !pendingFile) return [];
  try {
    privateDir(sessionsDir);
    const taken = withDirLockOrSkip(
      lock,
      () => {
        writeJsonAtomic(file, state);
        if (!state.recommendedTier) return [];
        const existing = readPendingList(pendingFile);
        if (!existing || existing.turn !== state.turn) return [];
        fs.rmSync(pendingFile, { force: true });
        const now = Date.now();
        return existing.calls.filter((c) => now - c.at <= PENDING_RECOMMENDATION_TTL_MS);
      },
      () => {
        // lock busy: written unlocked below
      },
      { waitMs: lockWaitMs }
    );
    if (taken) return taken;
  } catch {
    // fall through to the plain write
  }
  writeAntigravityTurn(sessionsDir, sessionId, state);
  return [];
}

export type AntigravityModelUsedSource = ModelUsedSource;

export type AntigravityTelemetryInput = AntigravityTelemetryMode &
  (
  | {
      /** An answer to the elevation question (2.3.21): the fields are `elevationAnswerFields` (what was asked and answered, whether it was stored, the effort cap, the reason when not). */
      kind: 'elevation_answer';
      conversationId?: string | null;
      /** The turn id (`turnId` of the cleaned last user input), the join to the `agent_call` rows of the same prompt. */
      turn?: string | null;
      callKey?: string | null;
      fields: Record<string, unknown>;
    }
  | {
      kind: 'pre_invocation';
      conversationId?: string | null;
      inputModelName?: string | null;
      /** The id the turn ran on when it differs from `inputModelName` (the sticky session model); written as `turnModel`. */
      turnModel?: string | null;
      quotaView?: Pick<QuotaView, 'active_model' | 'activeModelSource' | 'strategy' | 'active'> | null;
      lastUserInput?: string | null;
      /** Absent on the row of a mode without routing advice (on-demand): no recommendation fields are written. */
      recommendedSubagent?: string;
      recommendedTier?: string;
      effort?: string;
      taskLen?: number;
      taskHash?: string;
      quotaStrategy?: string;
    }
  | {
      kind: 'agent_call';
      conversationId?: string | null;
      inputModelName?: string | null;
      /** The id the turn ran on when it differs from `inputModelName` (the sticky session model); written as `turnModel`. */
      turnModel?: string | null;
      quotaView?: Pick<QuotaView, 'active_model' | 'activeModelSource' | 'strategy' | 'active'> | null;
      lastUserInput?: string | null;
      toolName?: string;
      args?: Record<string, unknown>;
      turnState?: AntigravityTurnState | null;
      decision: AntigravityHookDecision;
      downgradeLog?: Record<string, unknown>;
      /** What the cost gate did (2.3.19), see `antigravityCostGateState`; absent in a mode without decisions. */
      costGate?: CostGateState;
      /** What the cost gate would have done, in shadow mode (2.3.19); absent in enforce and in a mode without decisions. */
      costGateShadow?: CostGateShadowState;
      quotaStrategy?: string;
      /** The host's tool call id (2.3.20; the caller passes the validated one, see {@link antigravityCallId}): written as `callKey`, and repeated by a late `agent_call_recommendation` row. Omitted when the call had none. */
      callKey?: string;
      /** Jev is on and the turn's recommendation was not known yet: the row says so, and a late row may follow. */
      recommendationPending?: boolean;
    }
  | {
      /** The late row the pre-flight appends for an `agent_call` written before the recommendation existed. */
      kind: 'agent_call_recommendation';
      conversationId?: string | null;
      turn: string;
      recommendedTier: string;
      call: PendingRecommendationCall;
    }
  | {
      kind: 'subagent_served';
      conversationId?: string | null;
      /** The session model from the hook input (PostToolUse, or the hook that flushed a backfill); absent when not known. */
      inputModelName?: string | null;
      /** The id the turn ran on when it differs from `inputModelName` (the sticky session model); written as `turnModel`. */
      turnModel?: string | null;
      quotaView?: Pick<QuotaView, 'active_model' | 'activeModelSource'> | null;
      childConversationId?: string | null;
      /** The host's tool call id of the `invoke_subagent` call (2.3.20), written as `callKey`: the join to its `agent_call` row. */
      callKey?: string | null;
      requestedModel?: string | null;
      servedModel?: string | null;
      backfilled?: boolean;
    }
  );

/** The `mode` every Antigravity telemetry row carries (2.3.19): the mode the hook acted under (`on` or `on-demand`; off writes nothing). */
type AntigravityTelemetryMode = { mode?: string | null };

/**
 * The `quotaPool` of an `agent_call` / `subagent_served` row (2.3.20): `gemini`, `argon` or `3p`. The model the call was actually served on
 * when it is known (a `subagent_served` row), else the one it is expected to be served on (`servedQuotaPool`: an enum value by its
 * served model, a full id by its family, `inherit` or nothing the parent's).
 */
export function subagentQuotaPool(requested: unknown, served: unknown, parentModel: unknown): QuotaPoolName {
  return quotaPoolOfModel(served) ?? servedQuotaPool(requested, parentModel);
}

/**
 * `{ quotaPool }` for a decisions-log row, or nothing when the pool cannot be told: no served model, and the call named no model of
 * its own (it runs on the parent's) while the parent is not known either.
 */
export function quotaPoolField(requested: unknown, served: unknown, parentModel: unknown): { quotaPool?: QuotaPoolName } {
  const named = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'inherit';
  if (!named(served) && !named(requested) && !named(parentModel)) return {};
  return { quotaPool: subagentQuotaPool(requested, served, parentModel) };
}

/** `turnModel` on a telemetry row: only when the turn ran on another model than the (sticky) session model. */
function turnModelField(sessionModel: string | null, turnModel: string | null | undefined): { turnModel?: string } {
  const t = typeof turnModel === 'string' ? turnModel.trim() : '';
  return t.length > 0 && t !== sessionModel ? { turnModel: t } : {};
}

/**
 * The telemetry row of an Antigravity hook event. Every row carries `mode` (2.3.19): `on` or `on-demand`, the mode the hook acted
 * under (`params.mode`, through `telemetryMode`); a row for any other value (off writes nothing) carries none.
 */
export function buildAntigravityTelemetryEvent(params: AntigravityTelemetryInput): JevTelemetryEvent {
  const mode = telemetryMode(params.mode);
  const event = buildAntigravityEventBody(params);
  return mode ? { ...event, mode } : event;
}

function buildAntigravityEventBody(params: AntigravityTelemetryInput): JevTelemetryEvent {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

  if (params.kind === 'elevation_answer') {
    return {
      harness: 'antigravity',
      toolOrHook: 'PostToolUse',
      sessionId: params.conversationId ?? null,
      ...(params.turn ? { turn: params.turn } : {}),
      ...callKeyField(params.callKey),
      ...params.fields
    };
  }

  if (params.kind === 'pre_invocation') {
    const { sessionModel, sessionModelSource } = resolveAntigravitySessionModel(params.inputModelName, params.quotaView, params.turnModel);
    const cleaned = cleanUserInput(params.lastUserInput || '');
    const turn = cleaned.length > 0 ? turnId(cleaned) : undefined;
    const quotaStrategy = params.quotaStrategy ?? params.quotaView?.active?.strategy ?? params.quotaView?.strategy;
    return {
      harness: 'antigravity',
      toolOrHook: 'PreInvocation',
      sessionId: params.conversationId ?? null,
      ...(turn ? { turn } : {}),
      ...(typeof params.taskLen === 'number' ? { taskLen: params.taskLen } : {}),
      ...(params.taskHash ? { taskHash: params.taskHash } : {}),
      sessionModel,
      sessionModelSource,
      ...turnModelField(sessionModel, params.turnModel),
      ...(params.recommendedSubagent ? { recommendedSubagent: params.recommendedSubagent } : {}),
      ...(params.recommendedTier ? { recommendedTier: params.recommendedTier, modelRecommended: params.recommendedTier } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(quotaStrategy ? { quotaStrategy } : {})
    };
  }

  if (params.kind === 'agent_call_recommendation') {
    const c = params.call;
    return {
      harness: 'antigravity',
      toolOrHook: 'PreToolUse',
      event: 'agent_call_recommendation',
      sessionId: params.conversationId ?? null,
      turn: params.turn,
      ...callKeyField(c.callId),
      toolName: c.toolName,
      ...(c.taskSummary ? { taskSummary: c.taskSummary } : {}),
      sessionModel: c.sessionModel,
      sessionModelSource: c.sessionModelSource,
      modelRecommended: params.recommendedTier,
      recommendedTier: params.recommendedTier,
      recommendationLate: true,
      decision: c.decision,
      requestedModel: c.requestedModel,
      ...(c.modelUsed ? { modelUsed: c.modelUsed } : {}),
      ...(c.modelUsed && c.modelUsedSource ? { modelUsedSource: c.modelUsedSource } : {})
    };
  }

  if (params.kind === 'subagent_served') {
    const { sessionModel, sessionModelSource } = resolveAntigravitySessionModel(params.inputModelName, params.quotaView, params.turnModel);
    return {
      harness: 'antigravity',
      toolOrHook: 'PostToolUse',
      event: 'subagent_served',
      sessionId: params.conversationId ?? null,
      sessionModel,
      sessionModelSource,
      ...turnModelField(sessionModel, params.turnModel),
      ...callKeyField(params.callKey),
      // Child conversations write their own usage rows with `session_id` equal to this: the join to measured usage.
      childConversationId: params.childConversationId ?? null,
      requestedModel: params.requestedModel ?? null,
      servedModel: params.servedModel ?? null,
      quotaPool: subagentQuotaPool(params.requestedModel, params.servedModel, sessionModel),
      backfilled: Boolean(params.backfilled)
    };
  }

  const { sessionModel, sessionModelSource } = resolveAntigravitySessionModel(params.inputModelName, params.quotaView, params.turnModel);
  const cleaned = cleanUserInput(params.lastUserInput || '');
  const currentTurn = cleaned.length > 0 ? turnId(cleaned) : undefined;
  const matchedRecommendedTier =
    currentTurn && params.turnState && params.turnState.turn === currentTurn && params.turnState.recommendedTier
      ? params.turnState.recommendedTier
      : undefined;

  const { requestedModel } = extractSubagentModel(params.args);
  const rawType = params.args?.TypeName ?? params.args?.typeName ?? params.args?.Role ?? params.args?.role;
  const subagentType = str(rawType);

  // The same value rules as the Claude Code hook (resolveModelUsed): clamp, else applied downgrade, else the model the
  // call named, else the session model.
  const downgradedTo =
    params.downgradeLog?.downgrade === 'applied'
      ? (str(params.downgradeLog.downgrade_to) ??
         str(params.decision.overwrite?.Model) ??
         str(params.decision.overwrite?.model))
      : undefined;
  // A denied call never ran: no modelUsed and no modelUsedSource (requestedModel stays). Every call that goes ahead keeps
  // them, and so does a native ask, where the run may or may not happen.
  const used: { modelUsed?: string; modelUsedSource?: ModelUsedSource } =
    params.decision.decision === 'deny'
      ? {}
      : resolveModelUsed({
          clampedTo: params.decision.clampedTo,
          downgradedTo,
          requested: requestedModel,
          sessionModel
        });
  const { modelUsed, modelUsedSource } = used;

  const downgrade = str(params.downgradeLog?.downgrade);
  const quotaStrategy = params.quotaStrategy ?? params.quotaView?.active?.strategy ?? params.quotaView?.strategy;

  return {
    harness: 'antigravity',
    toolOrHook: 'PreToolUse',
    event: 'agent_call',
    sessionId: params.conversationId ?? null,
    ...(currentTurn ? { turn: currentTurn } : {}),
    toolName: params.toolName || 'invoke_subagent',
    ...(subagentType ? { taskSummary: `subagent: ${subagentType}` } : {}),
    sessionModel,
    sessionModelSource,
    ...turnModelField(sessionModel, params.turnModel),
    ...(matchedRecommendedTier
      ? { modelRecommended: matchedRecommendedTier, recommendedTier: matchedRecommendedTier }
      : {}),
    ...(modelUsed ? { modelUsed } : {}),
    ...(modelUsedSource ? { modelUsedSource } : {}),
    // The host's tool call id (2.3.20), the join to the call's other rows and to measured usage; omitted when the call carried none.
    ...callKeyField(params.callKey),
    ...(!matchedRecommendedTier && params.recommendationPending ? { recommendationPending: true } : {}),
    requestedModel: requestedModel ?? null,
    decision: params.decision.decision,
    // Why a deny or a dialog ask held the call (2.3.20): `denyCause` / `askCause`.
    ...causeFields(params.decision.decision, params.decision.cause),
    ...(params.decision.elevation ? { elevation: params.decision.elevation } : {}),
    // The quota pool the call is expected to draw (2.3.20): by the model it is served on, not by the enum value's name.
    quotaPool: subagentQuotaPool(requestedModel, null, sessionModel),
    ...(downgrade ? { downgrade } : {}),
    // The combined cost estimate (telemetry only; see src/core/cost-estimate.ts): what the call requested, a denied call too.
    ...antigravityCostFields(requestedModel, sessionModel),
    // Where the effort came from (2.3.20), see `antigravityEffortFor`.
    ...antigravityEffortFor(requestedModel, sessionModel, params.decision.clampedEffort),
    // What a suggested or applied downgrade saves (2.3.19), priced by the served models; absent on a row without one.
    ...(downgrade === 'asked' || downgrade === 'applied'
      ? { costSaving: antigravityDowngradeSaving(requestedModel, params.downgradeLog?.downgrade_to, sessionModel) }
      : {}),
    ...(params.costGate ? { cost_gate: params.costGate } : {}),
    ...(params.costGateShadow ? { cost_gate_shadow: params.costGateShadow } : {}),
    ...(quotaStrategy ? { quotaStrategy } : {})
  };
}

/**
 * The effort fields of an `agent_call` row (2.3.20): `effortSource` and, when a literal level was named, `effortRequested`. The
 * effort of an Antigravity call is the suffix of the model id it is served on (the enum values have a fixed served effort, see
 * {@link antigravityEffortFields} for the mapping). `clampedEffort` is the effort the cost-gate clamp lowered the call to: when it
 * differs from the call's own the source is `clamped`, and `effortRequested` the level it asked for.
 */
export function antigravityEffortFor(requestedModel: unknown, sessionModel: unknown, clampedEffort?: unknown): EffortFields {
  const served = servedModelExpected(requestedModel, sessionModel);
  const clamped = costEffortOf(clampedEffort);
  const callEffort = served.effort ?? effortFromModelId(sessionModel) ?? DEFAULT_COST_EFFORT;
  return antigravityEffortFields({
    // `inherit` or an omitted `Model` is served on the parent's model: its suffix is the session's effort, inherited, not named by the call.
    servedEffort: served.kind === 'parent' ? null : served.effort,
    sessionModel,
    clampedFrom: clamped !== null && clamped !== callEffort ? callEffort : undefined
  });
}

/**
 * The host's tool call id as a join token (2.3.20): the `callKey` the rows of this call carry. Undefined when the input has no id
 * or a malformed one (the rows then carry no `callKey`).
 */
export function antigravityCallId(input: Pick<AntigravityHookInput, 'toolCall'>): string | undefined {
  return joinToken(input.toolCall?.id);
}

/**
 * The key a call is tracked under inside the hook (the pending-recommendation list and the `step:` fallbacks): the tool call
 * id, else `step:<stepIdx>` (real transcripts often carry no tool call ids), else a one-off `call:<time>-<random>`. The rows carry
 * `callKey` only when it is the host's id (see {@link antigravityCallId}); this key matches a late `agent_call_recommendation`
 * to the call it belongs to.
 */
export function antigravityCallKey(input: Pick<AntigravityHookInput, 'toolCall' | 'stepIdx'>): string {
  const id = input.toolCall?.id;
  if (typeof id === 'string' && id.trim().length > 0) return id.trim().slice(0, 120);
  if (typeof input.stepIdx === 'number' && Number.isFinite(input.stepIdx)) return `step:${input.stepIdx}`;
  return `call:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What a pending-recommendation entry keeps of an `agent_call` telemetry row (models and decision, no text). */
export function pendingCallFromEvent(ev: JevTelemetryEvent, callKey: string, at: number = Date.now()): PendingRecommendationCall {
  const s = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
  return {
    callKey,
    ...(joinToken(ev.callKey) ? { callId: joinToken(ev.callKey) } : {}),
    at,
    decision: s(ev.decision as unknown, 20) ?? 'pass',
    requestedModel: s(ev.requestedModel as unknown) ?? null,
    ...(s(ev.modelUsed) ? { modelUsed: s(ev.modelUsed) } : {}),
    ...(s(ev.modelUsed) && ev.modelUsedSource ? { modelUsedSource: ev.modelUsedSource } : {}),
    toolName: s(ev.toolName as unknown, 60) ?? 'invoke_subagent',
    ...(s(ev.taskSummary) ? { taskSummary: s(ev.taskSummary) } : {}),
    sessionModel: s(ev.sessionModel) ?? null,
    sessionModelSource: s(ev.sessionModelSource) ?? null
  };
}

/**
 * The `cost_gate` value of an `invoke_subagent` row (2.3.19), from the decision the guard reached: `pass` (the call costs no more
 * than the session's, or the user's own words let it through), `denied` (held: a deny or the dialog's ask), `approved` (it went
 * ahead on a covering approval), `clamped` (the call was lowered to fit) or `fallback` (the cost could not be computed, so the
 * model ceiling by rank decided). Pure and recomputed from the same inputs the guard used, so the decision object itself stays
 * what it was.
 */
export function antigravityCostGateState(
  input: AntigravityHookInput,
  decision: Pick<AntigravityHookDecision, 'decision' | 'elevation'>,
  deps: { sessionModel?: string; sessionOrchestrator?: boolean }
): CostGateState {
  const sessionModel = deps.sessionModel || input.modelName || DEFAULT_ANTIGRAVITY_SESSION_MODEL;
  const orchestrator = deps.sessionOrchestrator === true || isOrchestratorModel(sessionModel);
  const ceilingTier = rankToTierName(subagentCeilingRank(sessionModel, orchestrator));
  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);
  // No model of its own: the call runs on the session's, which is exactly what it is held to.
  if (!isExplicit || !requestedModel) return 'pass';
  const gate = antigravityCostGate(requestedModel, ceilingTier, sessionModel);
  if (gate.kind === 'fallback') return 'fallback';
  if (gate.kind === 'pass') return 'pass';
  if (decision.elevation === 'approved') return 'approved';
  if (decision.elevation === 'clamped') return 'clamped';
  if (decision.elevation === 'instructed') return 'pass';
  return decision.decision === 'pass' || decision.decision === 'allow' ? 'pass' : 'denied';
}

/**
 * The `cost_gate_shadow` value of an `invoke_subagent` row in shadow mode (2.3.19): what the cost gate would have done with the
 * call, whatever the rank ceiling decided. `pass` (it costs no more than the session's, or the user's own words let it through),
 * `denied`, `clamped` (under `JEV_ELEVATION=clamp`) or `fallback` (the cost could not be computed). Pure.
 */
export function antigravityCostGateShadowState(
  input: AntigravityHookInput,
  deps: { sessionModel?: string; sessionOrchestrator?: boolean; elevationMode?: 'choice' | 'dialog' | 'clamp' }
): CostGateShadowState {
  const sessionModel = deps.sessionModel || input.modelName || DEFAULT_ANTIGRAVITY_SESSION_MODEL;
  const orchestrator = deps.sessionOrchestrator === true || isOrchestratorModel(sessionModel);
  const ceilingTier = rankToTierName(subagentCeilingRank(sessionModel, orchestrator));
  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);
  if (!isExplicit || !requestedModel) return 'pass';
  const named = isExplicitProOverride(input.lastUserInput, requestedModel);
  const gate = antigravityCostGate(requestedModel, ceilingTier, sessionModel, named ? { model: requestedModel } : {});
  const elevation = deps.elevationMode || (process.env.JEV_ELEVATION === 'dialog' || process.env.JEV_ELEVATION === 'clamp' ? process.env.JEV_ELEVATION : 'choice');
  return shadowStateOf(gate, elevation);
}

/** How the cost gate decides for this call: `JEV_COST_GATE`, else the configured mode, else `shadow`. */
export function costGateModeOf(deps: { costGateMode?: CostGateMode }): CostGateMode {
  return parseCostGateMode(process.env.JEV_COST_GATE) ?? deps.costGateMode ?? DEFAULT_COST_GATE_MODE;
}
