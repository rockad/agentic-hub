#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readJevMode,
  readQuotaView,
  safeSessionId,
  writeAntigravitySessionModel,
  privateDir,
  privateFile,
  jevHomeDir,
  PRIVATE_FILE_MODE,
  type JevMode,
  type QuotaView
} from '../src/shared.js';
import { taskFingerprint } from '../src/core/telemetry.js';
import { checkEgress, egressContextDirs } from '../src/core/egress.js';
import { loadDowngradeMinProbability, loadDowngradeMode } from '../src/core/downgrade-config.js';
import { ceilingModelForHarness } from '../src/tools/dispatch.js';
import {
  evaluateAntigravitySubagentCall,
  extractSubagentModel,
  parseElevationAnswer,
  pollForAskAnswer,
  pollForAskAnswers,
  askAnswerKey,
  extractChildConversationId,
  findServedModelFromTranscript,
  recordPendingServed,
  flushPendingServed,
  TRANSCRIPT_TAIL_WINDOW_BYTES,
  ELEVATE_MARKER_PREFIX,
  type AntigravityHookInput
} from './logic.js';
import { readRegularFileTail } from '../claude/safe-read.js';
import { createAntigravityApprovalStore, createAntigravityDowngradeStore, type ApprovalScope } from './approvals.js';
import { applyAntigravityDowngrade, findDowngradeQuestions, liveRateTask, parseDowngradeAnswer } from './downgrade.js';

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

async function main() {
  const event = (process.argv[2] || 'pre-tool-use').toLowerCase();

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
    if (mode === 'off') {
      passThrough(event);
    }

    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const approvals = noSession ? undefined : createAntigravityApprovalStore(sessionsDir);
    const downgrades = createAntigravityDowngradeStore(sessionsDir);
    flushPendingServed(sessionsDir, input.conversationId, appendDecisionLog, jevHomeDir());

    if (event === 'post-tool-use') {
      const toolName = input?.toolCall?.name;
      if (toolName === 'ask_question') {
        const conversationId = noSession ? null : input.conversationId || 'default-session';
        const contentOnStdin = typeof input.content === 'string' && input.content.trim().length > 0;
        const transcriptReadable = isTranscriptReadable(input.transcriptPath);

        let markerFound = false;
        let rowFound = false;
        let answerStepRecorded = false;
        let parsed: { approved: boolean; scope: ApprovalScope | null } = { approved: false, scope: null };
        let outcome: 'recorded' | 'not_elevation' | 'no_row' | 'rejected' | 'not_denied' | 'no_session' | 'error' = 'error';

        // A downgrade question (`[jev-downgrade:flash_lite:<sig8>]` or the plain marker, text starts with the marker) is
        // recorded by its own branch, EVERY such question of the call (each answer line belongs to its own delegation).
        // An elevation marker wins when a call carries both: the elevation flow is the one that must never miss an answer.
        const downgradeQuestions = findDowngradeQuestions(input.toolCall?.args?.questions);
        const carriesElevation = JSON.stringify(input.toolCall?.args?.questions ?? '').includes(ELEVATE_MARKER_PREFIX);
        if (downgradeQuestions.length > 0 && !carriesElevation) {
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
              downgradeQuestions.map((q) => q.index)
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
          console.log('{}');
          process.exit(0);
        }

        try {
          const questions = input.toolCall?.args?.questions;
          let elevateModel: string | undefined;
          // Which question carries the marker, so its own answer line (A1 = first question) is the one read.
          let markerIndex = 0;

          if (Array.isArray(questions)) {
            questions.forEach((q, index) => {
              const qText = typeof q === 'string' ? q : (q && typeof q === 'object' ? (q as Record<string, unknown>).question : '');
              if (typeof qText === 'string' && qText.includes(ELEVATE_MARKER_PREFIX)) {
                const m = qText.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
                if (m) {
                  elevateModel = m[1].toLowerCase();
                  markerIndex = index;
                }
              }
            });
          } else if (typeof questions === 'string' && questions.includes(ELEVATE_MARKER_PREFIX)) {
            const m = questions.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
            if (m) elevateModel = m[1].toLowerCase();
          }

          markerFound = typeof elevateModel === 'string';

          // Record where the answer row is, before waiting for it and whatever the answer turns out to be: the row's
          // step_index is this call's own stepIdx, even when the row is not written yet. The PreToolUse pull reads only
          // that row (real transcripts carry no tool call ids, and parallel tool calls make position unreliable).
          if (markerFound && elevateModel && approvals && conversationId && typeof input.stepIdx === 'number') {
            try {
              answerStepRecorded = approvals.noteAnswerStep?.(conversationId, elevateModel, input.stepIdx, Date.now(), markerIndex) === true;
            } catch {
              answerStepRecorded = false;
            }
          }

          // Only an elevation question is worth waiting for: a bounded wait (~150 ms polls, <= 2 s) for the answer row
          // when content is not on stdin and transcriptPath + stepIdx are given. Any other question returns at once.
          const rawAnswer = markerFound ? await pollForAskAnswer(input, markerIndex) : null;
          rowFound = rawAnswer !== null;

          const parsedResult = parseElevationAnswer(rawAnswer);
          parsed = {
            approved: parsedResult.approved,
            scope: parsedResult.scope ?? null
          };

          if (!markerFound || !elevateModel) {
            outcome = 'not_elevation';
          } else if (!rowFound) {
            outcome = 'no_row';
          } else if (!parsed.approved || !parsed.scope) {
            outcome = 'rejected';
          } else {
            if (!approvals || !conversationId) {
              outcome = 'no_session';
            } else {
              // The answer row this approval comes from is consumed with it (by step and, when present, by tool call
              // id): the same row cannot approve a later denial, whichever hook reads it.
              const consumedKeys: string[] = [];
              if (typeof input.stepIdx === 'number') consumedKeys.push(`step:${input.stepIdx}#${markerIndex}`);
              if (typeof input.toolCall?.id === 'string' && input.toolCall.id) consumedKeys.push(`${input.toolCall.id}#${markerIndex}`);
              const recorded = approvals.record(
                conversationId,
                { model: elevateModel, scope: parsed.scope, created_at: Date.now() },
                consumedKeys.length > 0 ? consumedKeys : undefined
              );
              outcome = recorded ? 'recorded' : 'not_denied';
            }
          }
        } catch {
          outcome = 'error';
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
            child_conversation_id: childConvId || null,
            requested_model: requestedModel || null,
            served_model: servedModel || null
          });
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

        console.log('{}');
        process.exit(0);
      }
      console.log('{}');
      process.exit(0);
    }

    // PreToolUse
    const trimmedModel =
      typeof input.modelName === 'string' && input.modelName.trim().length > 0
        ? input.modelName.trim()
        : undefined;

    if (trimmedModel && input.conversationId) {
      writeAntigravitySessionModel(input.conversationId, trimmedModel);
    }

    let activeModel: string | undefined;
    let quotaView: QuotaView | undefined;
    try {
      quotaView = await readQuotaView({ conversationId: input.conversationId });
      const rawModel = trimmedModel || quotaView?.active_model;
      activeModel = ceilingModelForHarness('antigravity', rawModel);
    } catch {
      // ignore
    }
    if (!activeModel && trimmedModel) {
      activeModel = ceilingModelForHarness('antigravity', trimmedModel);
    }

    let decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: activeModel,
      quotaView,
      mode
    });

    // The downgrade choice runs only on a call the checks above passed (never on a deny, an ask or an elevation), and
    // fails open: its log carries the `downgrade*` fields of the row below.
    let downgradeLog: Record<string, unknown> = {};
    if (decision.decision === 'pass') {
      const downgraded = await applyAntigravityDowngrade(input, decision, {
        store: downgrades,
        jevMode: mode,
        sessionModel: activeModel,
        env: process.env,
        downgradeConfig: loadDowngradeMode,
        downgradeMinProbability: loadDowngradeMinProbability,
        rateTask: liveRateTask,
        egressAllowed: (cwd) => checkEgress(egressContextDirs([cwd, ...(input.workspacePaths ?? [])])).allowed
      });
      decision = downgraded.decision;
      downgradeLog = downgraded.log;
    }

    const { requestedModel } = extractSubagentModel(input.toolCall?.args);
    const lastUserPrompt = input.lastUserInput || '';
    // Length and the first 12 hex of the sha256, the same fingerprint the telemetry lines carry (never the prompt).
    const fingerprint = taskFingerprint(lastUserPrompt);
    const promptLength = fingerprint.taskLen;
    const promptHash = promptLength > 0 ? fingerprint.taskHash : null;

    appendDecisionLog({
      event: 'agent_call',
      harness: 'antigravity',
      session_id: input.conversationId || null,
      tool_name: input.toolCall?.name || 'invoke_subagent',
      requested_model: requestedModel,
      session_model: activeModel || null,
      decision: decision.decision,
      elevation: decision.elevation || null,
      approval_scope: decision.approvalScope || null,
      attempt_count: decision.attemptCount || null,
      clamped_to: decision.clampedTo || null,
      reason: decision.reason || null,
      prompt_length: promptLength,
      prompt_hash: promptHash,
      ...(decision.pullFallback ? { pull_fallback: decision.pullFallback } : {}),
      ...downgradeLog
    });

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
    passThrough(event);
  }
}

main();
