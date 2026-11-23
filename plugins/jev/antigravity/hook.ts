#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readJevMode,
  readQuotaView,
  safeSessionId,
  recordAntigravitySession,
  resolveAntigravityTurnModel,
  privateDir,
  privateFile,
  jevHomeDir,
  PRIVATE_FILE_MODE,
  type JevMode,
  type QuotaView
} from '../src/shared.js';
import { logJevTelemetry, taskFingerprint } from '../src/core/telemetry.js';
import { checkEgress, egressContextDirs } from '../src/core/egress.js';
import { loadDowngradeMinProbability, loadDowngradeMode } from '../src/core/downgrade-config.js';
import { withTimeout } from '../src/core/with-timeout.js';
import { isModeOff, modeBehaviour, telemetryMode } from '../src/core/mode-policy.js';
import { getCostGateMode, loadJevConfigSync } from '../src/core/config.js';
import { denialPredatesModeChange, modeChangedAtMs } from '../src/core/mode-change.js';
import { ceilingModelForHarness } from '../src/tools/dispatch.js';
import {
  evaluateAntigravitySubagentCall,
  antigravityCostGateState,
  antigravityCostGateShadowState,
  extractSubagentModel,
  parseElevationAnswer,
  pollForAskAnswer,
  pollForAskAnswers,
  answerLabel,
  askAnswerKey,
  askQuestionCount,
  extractChildConversationId,
  findServedModelFromTranscript,
  recordPendingServed,
  flushPendingServed,
  readAntigravityTurn,
  buildAntigravityTelemetryEvent,
  antigravityCallKey,
  antigravityCeilingTier,
  antigravityCallId,
  antigravityEffortFor,
  quotaPoolField,
  subagentQuotaPool,
  claimTurnRecommendation,
  pendingCallFromEvent,
  cleanUserInput,
  turnId,
  TRANSCRIPT_TAIL_WINDOW_BYTES,
  ELEVATE_MARKER_PREFIX,
  type AntigravityHookDecision,
  type AntigravityHookInput
} from './logic.js';
import { readRegularFileTail } from '../claude/safe-read.js';
import { antigravityTurnKey, createAntigravityApprovalStore, createAntigravityDowngradeStore, type ApprovalScope } from './approvals.js';
import { queueAnswerNotice } from './answer-notice.js';
import {
  ELEVATION_LABELS,
  elevationAnswerFields,
  notRecordedLine,
  parseAnswerLabel,
  recordedNoLine,
  recordedYesLine,
  type NotRecordedReason
} from '../src/core/elevation-answer.js';
import { effortFromModelId, type CostEffort } from '../src/core/cost-estimate.js';
import { applyAntigravityDowngrade, findDowngradeQuestions, liveRateTask, parseDowngradeAnswer } from './downgrade.js';
import { RUN_WORKFLOW_TOOL, evaluateAntigravityWorkflowCall } from './workflow-guard.js';
import { antigravityWorkflowPinDir, pruneWorkflowPins, recordRunWorkflowPostToolUse } from './workflow-pin.js';
import { antigravityCostFields, antigravityDowngradeSaving } from '../src/core/cost-estimate.js';
import { queueServedNotice } from './served-notice.js';
import { callKeyField } from '../src/core/join-keys.js';
import { causeFields } from '../src/core/deny-cause.js';

function getJevDir(): string {
  return process.env.JEV_CONFIG_FILE
    ? path.dirname(process.env.JEV_CONFIG_FILE)
    : path.join(jevHomeDir(), '.config', 'jev');
}

function getDecisionsLogPath(): string {
  return path.join(getJevDir(), 'antigravity_decisions.jsonl');
}

function appendDecisionLog(entry: Record<string, unknown>): void {
  try {
    const dir = getJevDir();
    privateDir(dir);
    const file = getDecisionsLogPath();
    const line = JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
      epoch: Math.floor(Date.now() / 1000)
    }) + '\n';
    fs.appendFileSync(file, line, { mode: PRIVATE_FILE_MODE });
    privateFile(file);
  } catch {
    // fail open on logging failure
  }
}

function safelyPrune(dir: string): void {
  try {
    pruneWorkflowPins(dir);
  } catch {
    // best-effort
  }
}

/**
 * The `elevation_answer` row of an answer a PreToolUse pulled from the transcript and recorded (2.3.21): the decisions log and telemetry, as
 * the PostToolUse recorder writes them (no line for the assistant: the call it is deciding already reflects the answer).
 */
function pulledAnswerFields(pa: NonNullable<AntigravityHookDecision['pulledAnswer']>): Record<string, unknown> {
  return elevationAnswerFields({ kind: 'model', model: pa.model, effort: pa.effort, answer: pa.answer, scope: pa.scope, recorded: true });
}

function isTranscriptReadable(transcriptPath?: string): boolean {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;
  let fd: number | null = null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile()) return false;
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const fst = fs.fstatSync(fd);
    return fst.isFile();
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function getStepContent(input: AntigravityHookInput): string | null {
  if (typeof input.content === 'string' && input.content.length > 0) {
    return input.content;
  }
  if (!input.transcriptPath || typeof input.stepIdx !== 'number') return null;
  try {
    const read = readRegularFileTail(input.transcriptPath, TRANSCRIPT_TAIL_WINDOW_BYTES);
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
        if (step && typeof step === 'object' && step.step_index === input.stepIdx) {
          if (typeof step.content === 'string') return step.content;
          if (step.content && typeof step.content === 'object') return JSON.stringify(step.content);
          if (typeof step.response === 'string') return step.response;
          if (typeof step.result === 'string') return step.result;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Antigravity PreToolUse pass-through semantics (empirically confirmed via live control):
 * - Printing `{}` with no `decision` field is treated by Antigravity as a DENIAL (`tool call denied by pre-tool hook:`).
 * - Exiting 0 with empty stdout is the true pass-through: Antigravity proceeds normally without errors or warnings.
 * - An explicit `"decision": "allow"` is printed ONLY when Jev deliberately approves (approved elevation, instructed, or clamped rewrite),
 *   because Antigravity documents `allow` as "Automatically allow the tool execution" (bypassing normal permission checks).
 * - For PostToolUse, `hooks.md` explicitly specifies `{}` as expected stdout.
 */
function passThrough(event: string): void {
  if (event === 'post-tool-use') {
    console.log('{}');
  }
  process.exit(0);
}

/**
 * The session model and the turn model a telemetry row carries for a turn that reported `modelName`: the sticky session
 * model of the conversation (the planner, for an executor turn of an Orchestrator conversation) and, when the turn ran on
 * another id, that id. Read-only; a hook path that already wrote the record passes its own result instead.
 */
function stickyTurn(conversationId: string | undefined, modelName: string | undefined): { inputModelName: string | undefined; turnModel?: string } {
  try {
    const r = resolveAntigravityTurnModel(conversationId, modelName);
    return { inputModelName: r.model ?? undefined, ...(r.turnModel ? { turnModel: r.turnModel } : {}) };
  } catch {
    return { inputModelName: modelName };
  }
}

async function main() {
  const event = (process.argv[2] || 'pre-tool-use').toLowerCase();
  const pendingTelemetry: Promise<unknown>[] = [];
  const trackTelemetry = (p: Promise<unknown>): void => {
    pendingTelemetry.push(p);
  };
  const flushTelemetry = async (): Promise<void> => {
    if (pendingTelemetry.length === 0) return;
    try {
      await withTimeout(Promise.allSettled(pendingTelemetry.splice(0)), 1000);
    } catch {
      // best-effort
    }
  };

  try {
    // The only network call this hook can make is the downgrade rating at PreToolUse (one router call, 1.5 s, fail-open);
    // the key is loaded the way the MCP server loads it, on import of the shared client.
    const jevDir = getJevDir();

    const rawStdin = await Bun.stdin.text();
    let input: AntigravityHookInput = {};
    if (rawStdin && rawStdin.trim().length > 0) {
      try {
        input = JSON.parse(rawStdin);
      } catch {
        // malformed stdin
        passThrough(event);
      }
    }

    // The conversation id arrives on stdin and becomes part of file names: normalise it once, here, so every path
    // below (approvals, pending-served, session model, log rows) sees the same safe id or none.
    // An id that was sent but has nothing safe in it (`///`, `@@@`) means no stored state for this call: it must not
    // fall back to the shared default-session file, or two unrelated conversations would share approvals.
    let noSession = false;
    if (input.conversationId !== undefined) {
      const safe = safeSessionId(input.conversationId);
      noSession = safe === null && String(input.conversationId).length > 0;
      input.conversationId = safe ?? undefined;
    }

    const mode: JevMode = await readJevMode('antigravity');
    if (isModeOff(mode)) {
      passThrough(event);
    }
    // The config carries the `modeChangedAt` stamp: a denial or question from before the last mode change is never approved.
    const jevConfig = loadJevConfigSync();

    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const approvals = noSession ? undefined : createAntigravityApprovalStore(sessionsDir);
    const downgrades = createAntigravityDowngradeStore(sessionsDir);
    flushPendingServed(
      sessionsDir,
      input.conversationId,
      (entry) => {
        appendDecisionLog(entry);
        // A late backfill of a served model: queue the "served below requested" notice (mode on only).
        if (entry.event === 'subagent_served' && entry.served_model) queueServedNotice(sessionsDir, input.conversationId, entry.requested_model, entry.served_model, mode);
        if (entry.event === 'subagent_served' && entry.child_conversation_id && entry.served_model) {
          trackTelemetry(
            logJevTelemetry(
              buildAntigravityTelemetryEvent({
                mode,
                kind: 'subagent_served',
                conversationId: typeof entry.session_id === 'string' ? entry.session_id : input.conversationId,
                ...stickyTurn(input.conversationId, input.modelName),
                childConversationId: String(entry.child_conversation_id),
                callKey: typeof entry.callKey === 'string' ? entry.callKey : undefined,
                requestedModel: typeof entry.requested_model === 'string' ? entry.requested_model : null,
                servedModel: String(entry.served_model),
                backfilled: entry.backfilled === true
              })
            )
          );
        }
      },
      jevHomeDir()
    );

    if (event === 'post-tool-use') {
      const toolName = input?.toolCall?.name;
      if (toolName === 'ask_question') {
        // Answers feed approvals and downgrade choices, which are decisions: a mode without decisions (on-demand) records
        // none, so a stale denial from an earlier mode `on` cannot be approved from an answer given now. An elevation answer
        // is still read there, to write its `elevation_answer` row (`recorded: false`, reason `mode`) and tell the assistant.
        const decisions = modeBehaviour(mode).decisions;
        const conversationId = noSession ? null : input.conversationId || 'default-session';
        const contentOnStdin = typeof input.content === 'string' && input.content.trim().length > 0;
        const transcriptReadable = isTranscriptReadable(input.transcriptPath);

        let markerFound = false;
        let rowFound = false;
        let answerStepRecorded = false;
        let parsed: { approved: boolean; declined?: boolean; scope: ApprovalScope | null } = { approved: false, scope: null };
        let outcome: 'recorded' | 'not_elevation' | 'no_row' | 'rejected' | 'consumed' | 'mode' | 'no_session' | 'error' = 'error';

        // A downgrade question (`[jev-downgrade:flash_lite:<sig8>]` or the plain marker, text starts with the marker) is
        // recorded by its own branch, EVERY such question of the call (each answer line belongs to its own delegation).
        // An elevation marker wins when a call carries both: the elevation flow is the one that must never miss an answer.
        const downgradeQuestions = findDowngradeQuestions(input.toolCall?.args?.questions);
        const carriesElevation = JSON.stringify(input.toolCall?.args?.questions ?? '').includes(ELEVATE_MARKER_PREFIX);
        if (!decisions && !carriesElevation) {
          await flushTelemetry();
          console.log('{}');
          process.exit(0);
        }
        if (downgradeQuestions.length > 0 && !carriesElevation) {
          // A question asked before the last mode change is dropped first: an answer to it records nothing.
          if (conversationId && modeChangedAtMs(jevConfig, 'antigravity') !== null) {
            try {
              downgrades.voidStale?.(conversationId, (askedAt) => denialPredatesModeChange(askedAt, jevConfig, 'antigravity'));
            } catch {
              // fail-open: the answer is then matched as before
            }
          }
          let dRow = false;
          let dStepRecorded = false;
          let dChoice: 'yes' | 'keep' | 'off' | null = null;
          type DowngradeOutcome = 'recorded' | 'no_row' | 'rejected' | 'not_asked' | 'error';
          let dOutcome: DowngradeOutcome = 'error';
          let dOutcomes: DowngradeOutcome[] = [];
          try {
            const results: Array<{ row: boolean; choice: 'yes' | 'keep' | 'off' | null; outcome: DowngradeOutcome }> = [];
            // Record where the answer row is against every pending question of this ask, before waiting for it and
            // whatever the outcome (no_row included): the row's step_index is this call's own stepIdx. The PreToolUse
            // pull reads only that row (real transcripts carry no tool call ids; parallel tools make position unreliable).
            if (conversationId && typeof input.stepIdx === 'number') {
              for (const q of downgradeQuestions) {
                try {
                  if (downgrades.noteAnswerStep?.(conversationId, input.stepIdx, Date.now(), q.sig, q.index)) dStepRecorded = true;
                } catch {
                  // fail-open: the pull then reads a lone ask_question only
                }
              }
            }
            // One bounded wait for the result row, shared by every question of the ask; each answer line is then read
            // from that one row (N questions must not cost N wait windows: the hook has a timeout).
            const rawAnswers = await pollForAskAnswers(
              input,
              downgradeQuestions.map((q) => q.index),
              { questionCount: askQuestionCount(input.toolCall?.args) }
            );
            downgradeQuestions.forEach((q, n) => {
              const rawAnswer = rawAnswers[n] ?? null;
              const row = rawAnswer !== null;
              const choice = parseDowngradeAnswer(rawAnswer);
              let outcome: DowngradeOutcome;
              try {
                if (!row) outcome = 'no_row';
                else if (!choice) outcome = 'rejected';
                else if (!conversationId) outcome = 'not_asked';
                else {
                  // Consumed per question, not per tool call: the other questions of this ask are still open.
                  const askId = askAnswerKey(input.toolCall?.id, q.index, input.stepIdx);
                  outcome = downgrades.answer(conversationId, choice, askId, Date.now(), q.sig) ? 'recorded' : 'not_asked';
                }
              } catch {
                outcome = 'error';
              }
              results.push({ row, choice, outcome });
            });
            const shown = results.find((r) => r.outcome === 'recorded') ?? results[0];
            dRow = results.some((r) => r.row);
            dChoice = shown.choice;
            dOutcome = shown.outcome;
            dOutcomes = results.map((r) => r.outcome);
          } catch {
            dOutcome = 'error';
          }
          appendDecisionLog({
            event: 'ask_answer',
            marker: 'downgrade',
            session_id: conversationId,
            stepIdx: input.stepIdx ?? null,
            content_on_stdin: contentOnStdin,
            transcript_readable: transcriptReadable,
            marker_found: true,
            row_found: dRow,
            answer_step_recorded: dStepRecorded,
            parsed: { choice: dChoice },
            ...(downgradeQuestions.length > 1 ? { downgrade_questions: downgradeQuestions.length, outcomes: dOutcomes } : {}),
            outcome: dOutcome
          });
          await flushTelemetry();
          console.log('{}');
          process.exit(0);
        }

        // What the user answered, for the `elevation_answer` row and the line the assistant is told (set once the answer row is read).
        let answerFacts: { reason?: NotRecordedReason; answer: 'yes' | 'no' | null; scope: ApprovalScope | null; effort: CostEffort | null; model: string | null } | null = null;
        try {
          const questions = input.toolCall?.args?.questions;
          let elevateModel: string | undefined;
          // Which question carries the marker, so its own answer line (A1 = first question) is the one read.
          let markerIndex = 0;
          // The first question that carries the marker prefix even when its marker does not parse (a malformed marker).
          let prefixIndex = -1;

          if (Array.isArray(questions)) {
            questions.forEach((q, index) => {
              // The first marker question wins, as in the transcript pull (the earliest open question of the ask).
              if (elevateModel !== undefined) return;
              const qText = typeof q === 'string' ? q : (q && typeof q === 'object' ? (q as Record<string, unknown>).question : '');
              if (typeof qText === 'string' && qText.includes(ELEVATE_MARKER_PREFIX)) {
                if (prefixIndex < 0) prefixIndex = index;
                const m = qText.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
                if (m) {
                  elevateModel = m[1].toLowerCase();
                  markerIndex = index;
                }
              }
            });
          } else if (typeof questions === 'string' && questions.includes(ELEVATE_MARKER_PREFIX)) {
            prefixIndex = 0;
            const m = questions.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
            if (m) elevateModel = m[1].toLowerCase();
          }

          markerFound = typeof elevateModel === 'string';
          const malformed = !markerFound && prefixIndex >= 0;

          // Record where the answer row is, before waiting for it and whatever the answer turns out to be: the row's
          // step_index is this call's own stepIdx, even when the row is not written yet. The PreToolUse pull reads only
          // that row (real transcripts carry no tool call ids, and parallel tool calls make position unreliable).
          if (decisions && markerFound && elevateModel && approvals && conversationId && typeof input.stepIdx === 'number') {
            try {
              answerStepRecorded = approvals.noteAnswerStep?.(conversationId, elevateModel, input.stepIdx, Date.now(), markerIndex) === true;
            } catch {
              answerStepRecorded = false;
            }
          }

          // Only an elevation question is worth waiting for: a bounded wait (~150 ms polls, <= 2 s) for the answer row
          // when content is not on stdin and transcriptPath + stepIdx are given. Any other question returns at once.
          const rawAnswer = markerFound || malformed ? await pollForAskAnswer(input, markerFound ? markerIndex : prefixIndex, { questionCount: askQuestionCount(input.toolCall?.args) }) : null;
          rowFound = rawAnswer !== null;

          const parsedResult = parseElevationAnswer(rawAnswer);
          parsed = {
            approved: parsedResult.approved,
            ...(parsedResult.declined ? { declined: true } : {}),
            scope: parsedResult.scope ?? null
          };
          const answered = parsedResult.approved ? 'yes' : parsedResult.declined ? 'no' : null;

          if (!markerFound && !malformed) {
            outcome = 'not_elevation';
          } else if (!rowFound) {
            // The answer row is not in the transcript yet: a later PreToolUse may still pull it (and writes the recorded row then), but when
            // none does the answer must not leave no trace, so this one says it was not read.
            outcome = 'no_row';
            answerFacts = { reason: 'unread', answer: null, scope: null, effort: null, model: elevateModel ?? null };
          } else if (malformed) {
            // The question's marker does not parse: nothing can be stored, and the assistant is told how to ask it again.
            outcome = 'rejected';
            answerFacts = { reason: 'marker', answer: answered, scope: parsedResult.scope ?? null, effort: null, model: null };
          } else if (!answered || !parsedResult.scope) {
            outcome = 'rejected';
            answerFacts = { reason: 'label', answer: null, scope: null, effort: null, model: elevateModel ?? null };
          } else if (!decisions) {
            outcome = 'mode';
            answerFacts = { reason: 'mode', answer: answered, scope: parsedResult.scope, effort: null, model: elevateModel ?? null };
          } else if (!approvals || !conversationId || !elevateModel) {
            outcome = 'no_session';
            answerFacts = { reason: 'write', answer: answered, scope: parsedResult.scope, effort: null, model: elevateModel ?? null };
          } else {
            // The answer row this approval comes from is consumed with it (by step and, when present, by tool call
            // id): the same row cannot approve a later denial, whichever hook reads it.
            const consumedKeys: string[] = [];
            if (typeof input.stepIdx === 'number') consumedKeys.push(`step:${input.stepIdx}#${markerIndex}`);
            if (typeof input.toolCall?.id === 'string' && input.toolCall.id) consumedKeys.push(`${input.toolCall.id}#${markerIndex}`);
            const keys = consumedKeys.length > 0 ? consumedKeys : undefined;
            const turnKey = antigravityTurnKey(input.lastUserInput);
            // An answer counts whether or not Jev denied anything first, and whenever it was given (2.3.21: no window); a once is bound to this turn.
            if (answered === 'yes') {
              const stored = approvals.recordWithResult
                ? approvals.recordWithResult(conversationId, { model: elevateModel, scope: parsedResult.scope, created_at: Date.now(), ...(parsedResult.scope === 'once' ? { turn: turnKey } : {}) }, keys, jevConfig)
                : approvals.record(conversationId, { model: elevateModel, scope: parsedResult.scope, created_at: Date.now(), ...(parsedResult.scope === 'once' ? { turn: turnKey } : {}) }, keys, jevConfig)
                  ? { model: elevateModel }
                  : null;
              outcome = stored ? 'recorded' : 'consumed';
              answerFacts = stored ? { answer: 'yes', scope: parsedResult.scope, effort: effortFromModelId(stored.model), model: elevateModel } : null;
            } else {
              const done = approvals.recordDecline?.(conversationId, { model: elevateModel, scope: parsedResult.scope, created_at: Date.now(), ...(parsedResult.scope === 'once' ? { turn: turnKey } : {}) }, keys);
              if (done === undefined) throw new Error('no decline store');
              outcome = done ? 'recorded' : 'consumed';
              answerFacts = done ? { answer: 'no', scope: parsedResult.scope, effort: null, model: elevateModel } : null; // the launches run on the session ceiling whatever the label's text names
            }
          }
        } catch {
          outcome = 'error';
          if (markerFound || rowFound) answerFacts = { reason: 'write', answer: parsed.approved ? 'yes' : parsed.declined ? 'no' : null, scope: parsed.scope, effort: null, model: null };
        }

        // The `elevation_answer` row (2.3.21), one per marker answer read: the decisions log and telemetry. Then the one line for the assistant,
        // queued for the next pre-invocation (the PostToolUse output of Antigravity is `{}` only).
        if (answerFacts) {
          const facts = answerFacts;
          const recorded = !facts.reason;
          const fields = elevationAnswerFields({
            kind: 'model',
            model: facts.model,
            effort: recorded ? facts.effort : null,
            answer: facts.answer,
            scope: facts.scope,
            recorded,
            ...(facts.reason ? { reason: facts.reason } : {})
          });
          const cleaned = cleanUserInput(input.lastUserInput || '');
          const turn = cleaned.length > 0 ? turnId(cleaned) : null;
          appendDecisionLog({
            harness: 'antigravity',
            ...fields,
            session_id: conversationId,
            turn,
            ...callKeyField(input.toolCall?.id),
            ...(telemetryMode(mode) ? { mode: telemetryMode(mode) } : {})
          });
          trackTelemetry(
            logJevTelemetry(
              buildAntigravityTelemetryEvent({ mode, kind: 'elevation_answer', conversationId, turn, callKey: input.toolCall?.id, fields })
            )
          );
          const line = recorded
            ? facts.answer === 'yes'
              ? recordedYesLine({ kind: 'model', subject: facts.model ?? '', scope: facts.scope as ApprovalScope, effort: facts.effort })
              : recordedNoLine({ kind: 'model', subject: facts.model ?? '', scope: facts.scope as ApprovalScope, target: antigravityCeilingTier(input.modelName) })
            : notRecordedLine(facts.reason as NotRecordedReason, 'model', '[jev-elevate:<model>]', ELEVATION_LABELS.noOnce('<session ceiling>'));
          if (conversationId) queueAnswerNotice(sessionsDir, conversationId, line, mode);
        }

        appendDecisionLog({
          event: 'ask_answer',
          session_id: conversationId,
          stepIdx: input.stepIdx ?? null,
          content_on_stdin: contentOnStdin,
          transcript_readable: transcriptReadable,
          marker_found: markerFound,
          row_found: rowFound,
          answer_step_recorded: answerStepRecorded,
          parsed,
          outcome
        });

        await flushTelemetry();
        console.log('{}');
        process.exit(0);
      } else if (toolName === RUN_WORKFLOW_TOOL) {
        // The drift recorder: re-hashes the script files the PreToolUse guard analysed and logs `workflow_changed` when one
        // differs. No prompt and nothing printed beyond the empty object; mode off never gets here, on-demand logs silently.
        await recordRunWorkflowPostToolUse(input, { dir: antigravityWorkflowPinDir(jevDir), readMode: () => mode, log: appendDecisionLog });
        await flushTelemetry();
        console.log('{}');
        process.exit(0);
      } else if (toolName === 'invoke_subagent') {
        const conversationId = input.conversationId || null;
        let contentToSearch = typeof input.content === 'string' ? input.content : '';
        if (!contentToSearch && input.transcriptPath && typeof input.stepIdx === 'number') {
          contentToSearch = getStepContent(input) ?? '';
        }
        const childConvId = extractChildConversationId(contentToSearch, conversationId);
        const { requestedModel } = extractSubagentModel(input.toolCall?.args);
        let servedModel: string | null = null;
        if (childConvId) {
          try {
            servedModel = findServedModelFromTranscript(childConvId, jevHomeDir());
          } catch {
            // best-effort
          }
        }
        if ((childConvId && servedModel) || !conversationId || !input.transcriptPath || typeof input.stepIdx !== 'number') {
          appendDecisionLog({
            event: 'subagent_served',
            harness: 'antigravity',
            session_id: conversationId,
            // The host's tool call id (2.3.20): the same in this PostToolUse as in the call's PreToolUse `agent_call` row.
            ...callKeyField(input.toolCall?.id),
            child_conversation_id: childConvId || null,
            requested_model: requestedModel || null,
            served_model: servedModel || null,
            ...quotaPoolField(requestedModel, servedModel, input.modelName)
          });
          // Telemetry only for a served model that was found, as the backfill paths do; the decisions-log row above
          // stays as the audit trail for a call where nothing could be read.
          if (childConvId && servedModel) {
            queueServedNotice(sessionsDir, conversationId, requestedModel, servedModel, mode);
            trackTelemetry(
              logJevTelemetry(
                buildAntigravityTelemetryEvent({
                  mode,
                  kind: 'subagent_served',
                  conversationId,
                  ...stickyTurn(input.conversationId, input.modelName),
                  childConversationId: childConvId,
                  callKey: input.toolCall?.id,
                  requestedModel: requestedModel || null,
                  servedModel,
                  backfilled: false
                })
              )
            );
          }
        } else {
          recordPendingServed(sessionsDir, conversationId, {
            stepIdx: input.stepIdx,
            toolCallId: input.toolCall?.id,
            requestedModel: requestedModel || null,
            transcriptPath: input.transcriptPath,
            childConvId: childConvId || null,
            createdAt: Date.now()
          }, appendDecisionLog);
        }

        await flushTelemetry();
        console.log('{}');
        process.exit(0);
      }
      await flushTelemetry();
      console.log('{}');
      process.exit(0);
    }

    // PreToolUse
    const trimmedModel =
      typeof input.modelName === 'string' && input.modelName.trim().length > 0
        ? input.modelName.trim()
        : undefined;

    // The session model: what the store holds after this write. An Orchestrator conversation keeps its planner id when
    // an execution turn reports the worker id (`turn_model` in the record, and `inputModelName` in the telemetry rows,
    // still carry the model the turn ran on).
    let sessionModel = trimmedModel;
    // Whether the conversation is an Orchestrator one: the 1.5.14 annotation marker (kept in the record once detected; a plain conversation on a family id looks for it on each call) or a legacy id.
    let sessionOrchestrator = false;
    if (trimmedModel && input.conversationId) {
      const recorded = recordAntigravitySession(input.conversationId, trimmedModel, undefined, undefined, {
        artifactDirectoryPath: input.artifactDirectoryPath,
        trackTelemetry
      });
      sessionModel = recorded?.model ?? trimmedModel;
      sessionOrchestrator = recorded?.orchestrator ?? false;
    }

    let activeModel: string | undefined;
    let quotaView: QuotaView | undefined;
    try {
      quotaView = await readQuotaView({ conversationId: input.conversationId });
      // No model name on this call: the stored record (read by the quota view) still says whether this is an Orchestrator conversation.
      if (!trimmedModel && quotaView?.orchestrator === true) sessionOrchestrator = true;
      const rawModel = sessionModel || quotaView?.active_model;
      activeModel = ceilingModelForHarness('antigravity', rawModel);
    } catch {
      // ignore
    }
    if (!activeModel && sessionModel) {
      activeModel = ceilingModelForHarness('antigravity', sessionModel);
    }

    // The row of an answer this call pulled from the transcript and recorded (the PostToolUse recorder did not see its row in time).
    const writePulledAnswerRow = (pa: NonNullable<AntigravityHookDecision['pulledAnswer']>): void => {
      const fields = pulledAnswerFields(pa);
      const cleaned = cleanUserInput(input.lastUserInput || '');
      const turn = cleaned.length > 0 ? turnId(cleaned) : null;
      appendDecisionLog({
        harness: 'antigravity',
        ...fields,
        session_id: input.conversationId || null,
        turn,
        ...callKeyField(input.toolCall?.id),
        ...(telemetryMode(mode) ? { mode: telemetryMode(mode) } : {})
      });
      trackTelemetry(
        logJevTelemetry(buildAntigravityTelemetryEvent({ mode, kind: 'elevation_answer', conversationId: input.conversationId, turn, callKey: input.toolCall?.id, fields }))
      );
    };

    // The cost gate ships in shadow mode: the rank ceiling decides and the rows say what the gate would have done. JEV_COST_GATE wins.
    const costGateMode = getCostGateMode('antigravity');
    // run_workflow: the agents a script launches never reach this hook, so the script itself is analysed (workflow-guard.ts).
    // A mode without decisions (on-demand) passes it untouched: no analysis, no pin, one decisions-log row.
    if (input.toolCall?.name === RUN_WORKFLOW_TOOL) {
      const pinDir = antigravityWorkflowPinDir(jevDir);
      const w = evaluateAntigravityWorkflowCall(input, {
        mode,
        sessionModel: activeModel,
        sessionOrchestrator,
        approvals,
        config: jevConfig,
        costGateMode,
        pinDir
      });
      const wf = w.decision;
      const wfPrompt = taskFingerprint(input.lastUserInput || '');
      // Never the script and never the reason text (it carries script-supplied literals): counts, hashes and decision fields.
      appendDecisionLog({
        event: 'workflow_call',
        harness: 'antigravity',
        session_id: input.conversationId || null,
        call_key: antigravityCallKey(input),
        // The host's tool call id (2.3.20), the join to the call's other rows; omitted when the call has none (`call_key` keeps its fallbacks).
        ...callKeyField(input.toolCall?.id),
        tool_name: RUN_WORKFLOW_TOOL,
        session_model: activeModel || null,
        ...(trimmedModel && trimmedModel !== activeModel ? { turn_model: trimmedModel } : {}),
        decision: wf.decision,
        ...causeFields(wf.decision, wf.cause),
        elevation: wf.elevation || null,
        approval_scope: wf.approvalScope || null,
        ...(wf.stored ? { stored: wf.stored } : {}),
        ...(wf.declineScope ? { decline_scope: wf.declineScope } : {}),
        attempt_count: wf.attemptCount || null,
        prompt_length: wfPrompt.taskLen,
        prompt_hash: wfPrompt.taskLen > 0 ? wfPrompt.taskHash : null,
        ...(wf.pullFallback ? { pull_fallback: wf.pullFallback } : {}),
        ...(wf.autoApproveWarning ? { auto_approve_warning: true } : {}),
        ...w.log
      });
      if (wf.pulledAnswer) writePulledAnswerRow(wf.pulledAnswer);
      if (modeBehaviour(mode).decisions) safelyPrune(pinDir);
      await flushTelemetry();
      if (wf.decision === 'pass') {
        passThrough(event);
      }
      const wfOut: Record<string, unknown> = { decision: wf.decision };
      if (wf.reason) wfOut.reason = wf.reason;
      console.log(JSON.stringify(wfOut));
      process.exit(0);
    }

    const gateDecision = evaluateAntigravitySubagentCall(input, {
      costGateMode,
      approvals,
      sessionModelOverride: activeModel,
      sessionOrchestrator,
      quotaView,
      mode,
      config: jevConfig
    });
    let decision = gateDecision;
    const costGateState = antigravityCostGateState(input, gateDecision, { sessionModel: activeModel, sessionOrchestrator });
    const costGateShadow = antigravityCostGateShadowState(input, { sessionModel: activeModel, sessionOrchestrator });
    // enforce: `cost_gate` (what the gate did); shadow: `cost_gate_shadow` (what it would have done). A mode without decisions writes neither.
    const costGateFields = (key: 'cost_gate' | 'costGate'): Record<string, unknown> =>
      !modeBehaviour(mode).decisions
        ? {}
        : costGateMode === 'enforce'
          ? { [key]: costGateState }
          : { [key === 'costGate' ? 'costGateShadow' : 'cost_gate_shadow']: costGateShadow };

    // The downgrade choice runs only on a call the checks above passed (never on a deny, an ask or an elevation), and
    // fails open: its log carries the `downgrade*` fields of the row below.
    let downgradeLog: Record<string, unknown> = {};
    // A mode without decisions (on-demand) does not even look at it: no downgrade or downgrade_skip field on the row.
    if (decision.decision === 'pass' && modeBehaviour(mode).decisions) {
      const downgraded = await applyAntigravityDowngrade(input, decision, {
        store: downgrades,
        jevMode: mode,
        config: jevConfig,
        sessionModel: activeModel,
        sessionOrchestrator,
        env: process.env,
        downgradeConfig: loadDowngradeMode,
        downgradeMinProbability: loadDowngradeMinProbability,
        rateTask: liveRateTask,
        egressAllowed: (cwd) => checkEgress(egressContextDirs([cwd, ...(input.workspacePaths ?? [])])).allowed
      });
      // The downgrade answers a call the cost gate passed: its decision keeps the gate's state for the log and the telemetry row.
      decision = downgraded.decision;
      downgradeLog = downgraded.log;
    }

    const { requestedModel } = extractSubagentModel(input.toolCall?.args);
    const lastUserPrompt = input.lastUserInput || '';
    // Length and the first 12 hex of the sha256, the same fingerprint the telemetry lines carry (never the prompt).
    const fingerprint = taskFingerprint(lastUserPrompt);
    const promptLength = fingerprint.taskLen;
    const promptHash = promptLength > 0 ? fingerprint.taskHash : null;

    const callKey = antigravityCallKey(input);
    // An agent_call row is the record of an invoke_subagent call and of nothing else: any other tool name that reaches
    // this hook (a missing name included) writes no row and no telemetry.
    const isSubagentCall = input.toolCall?.name === 'invoke_subagent';
    if (isSubagentCall) appendDecisionLog({
      event: 'agent_call',
      harness: 'antigravity',
      session_id: input.conversationId || null,
      call_key: callKey,
      // The host's tool call id (2.3.20), the join to the call's PostToolUse `subagent_served` row; omitted when the call has none.
      ...callKeyField(input.toolCall?.id),
      tool_name: 'invoke_subagent',
      requested_model: requestedModel,
      // The quota pool the call is expected to draw (2.3.20): by the model it is served on.
      quotaPool: subagentQuotaPool(requestedModel, null, activeModel),
      session_model: activeModel || null,
      ...(trimmedModel && trimmedModel !== activeModel ? { turn_model: trimmedModel } : {}),
      decision: decision.decision,
      // Why a deny or a dialog ask held the call (2.3.20): `denyCause` / `askCause`.
      ...causeFields(decision.decision, decision.cause),
      elevation: decision.elevation || null,
      approval_scope: decision.approvalScope || null,
      ...(decision.stored ? { stored: decision.stored } : {}),
      ...(decision.declineScope ? { decline_scope: decision.declineScope } : {}),
      attempt_count: decision.attemptCount || null,
      clamped_to: decision.clampedTo || null,
      ...(decision.clampedEffort ? { clamped_effort: decision.clampedEffort } : {}),
      // What the cost gate did (2.3.19); a mode without decisions (on-demand) decides nothing, so it writes none.
      ...costGateFields('cost_gate'),
      reason: decision.reason || null,
      prompt_length: promptLength,
      prompt_hash: promptHash,
      ...(decision.pullFallback ? { pull_fallback: decision.pullFallback } : {}),
      ...(decision.autoApproveWarning ? { auto_approve_warning: true } : {}),
      ...downgradeLog,
      // What a suggested or applied downgrade saves (2.3.19), priced by the served models.
      ...(downgradeLog.downgrade === 'asked' || downgradeLog.downgrade === 'applied'
        ? { costSaving: antigravityDowngradeSaving(requestedModel, downgradeLog.downgrade_to, activeModel) }
        : {}),
      // Telemetry only: an estimate of what the call requested (a denied call too); nothing reads it back.
      ...antigravityCostFields(requestedModel, activeModel),
      // Where the effort came from (2.3.20).
      ...antigravityEffortFor(requestedModel, activeModel, decision.clampedEffort)
    });

    if (isSubagentCall && decision.pulledAnswer) writePulledAnswerRow(decision.pulledAnswer);

    if (isSubagentCall && modeBehaviour(mode).telemetry) {
      const cleaned = cleanUserInput(input.lastUserInput || '');
      const turn = cleaned.length > 0 ? turnId(cleaned) : undefined;
      const build = (turnState: ReturnType<typeof readAntigravityTurn>, recommendationPending: boolean) =>
        buildAntigravityTelemetryEvent({
          mode,
          kind: 'agent_call',
          conversationId: input.conversationId,
          // The sticky session model (the planner, for an executor turn of an Orchestrator conversation), and the id the turn ran on.
          inputModelName: sessionModel,
          turnModel: trimmedModel,
          quotaView,
          lastUserInput: input.lastUserInput,
          toolName: 'invoke_subagent',
          args: input.toolCall?.args,
          turnState,
          decision,
          downgradeLog,
          ...costGateFields('costGate'),
          callKey: antigravityCallId(input),
          recommendationPending
        });
      // A mode without routing advice (on-demand) makes no recommendation, so no turn state speaks for this call.
      const advice = modeBehaviour(mode).routingAdvice;
      let event = build(advice ? readAntigravityTurn(sessionsDir, input.conversationId) : null, false);
      // No recommendation for this turn yet. Only a mode with routing advice (`on`) runs the pre-flight that makes one, and it may still be running
      // (hooks of one turn are not serialised): record the call under the turn lock, atomically with a re-check of the
      // state, so the pre-flight can append a late `agent_call_recommendation` row when it finishes. Mark the row either way.
      if (!event.recommendedTier && advice) {
        const pendingEvent = build(null, true);
        const claim = turn
          ? claimTurnRecommendation(sessionsDir, input.conversationId, turn, pendingCallFromEvent(pendingEvent, callKey))
          : { turnState: null, recorded: false };
        event = claim.turnState ? build(claim.turnState, false) : pendingEvent;
      }
      trackTelemetry(logJevTelemetry(event));
    }

    await flushTelemetry();

    if (decision.decision === 'pass') {
      passThrough(event);
    }

    const output: Record<string, unknown> = {
      decision: decision.decision
    };
    if (decision.reason) {
      output.reason = decision.reason;
    }
    if (decision.overwrite) {
      output.overwrite = decision.overwrite;
    }
    if (decision.permissionOverrides) {
      output.permissionOverrides = decision.permissionOverrides;
    }

    console.log(JSON.stringify(output));
    process.exit(0);
  } catch {
    // Fail-open: never block an Antigravity session on hook failure, and never approve on its behalf either
    await flushTelemetry();
    passThrough(event);
  }
}

main();
