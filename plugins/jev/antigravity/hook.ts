#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readJevMode,
  readQuotaView,
  writeAntigravitySessionModel,
  privateDir,
  privateFile,
  PRIVATE_FILE_MODE,
  type JevMode,
  type QuotaView
} from '../src/shared.js';
import { taskFingerprint } from '../src/core/telemetry.js';
import { ceilingModelForHarness } from '../src/tools/dispatch.js';
import {
  evaluateAntigravitySubagentCall,
  extractAskAnswer,
  extractSubagentModel,
  parseElevationAnswer,
  pollForAskAnswer,
  extractChildConversationId,
  findServedModelFromTranscript,
  TRANSCRIPT_TAIL_WINDOW_BYTES,
  ELEVATE_MARKER_PREFIX,
  type AntigravityHookInput
} from './logic.js';
import { readRegularFileTail } from '../claude/safe-read.js';
import { createAntigravityApprovalStore, type ApprovalScope } from './approvals.js';

function getJevDir(): string {
  return process.env.JEV_CONFIG_FILE
    ? path.dirname(process.env.JEV_CONFIG_FILE)
    : path.join(os.homedir(), '.config', 'jev');
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
    // No API keys are loaded here: the hook makes no network call.
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

    const mode: JevMode = await readJevMode('antigravity');
    if (mode === 'off') {
      passThrough(event);
    }

    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const approvals = createAntigravityApprovalStore(sessionsDir);

    if (event === 'post-tool-use') {
      const toolName = input?.toolCall?.name;
      if (toolName === 'ask_question') {
        const conversationId = input.conversationId || 'default-session';
        const contentOnStdin = typeof input.content === 'string' && input.content.trim().length > 0;
        const transcriptReadable = isTranscriptReadable(input.transcriptPath);

        let markerFound = false;
        let rowFound = false;
        let parsed: { approved: boolean; scope: ApprovalScope | null } = { approved: false, scope: null };
        let outcome: 'recorded' | 'no_marker' | 'no_row' | 'rejected' | 'not_denied' | 'error' = 'error';

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

          // Bounded wait (~150 ms polls, <= 2 s) for the answer row if content is not on stdin and transcriptPath + stepIdx are given
          const rawAnswer = await pollForAskAnswer(input, markerIndex);
          rowFound = rawAnswer !== null;

          const parsedResult = parseElevationAnswer(rawAnswer);
          parsed = {
            approved: parsedResult.approved,
            scope: parsedResult.scope ?? null
          };

          if (!markerFound || !elevateModel) {
            outcome = 'no_marker';
          } else if (!rowFound) {
            outcome = 'no_row';
          } else if (!parsed.approved || !parsed.scope) {
            outcome = 'rejected';
          } else {
            const recorded = approvals.record(conversationId, {
              model: elevateModel,
              scope: parsed.scope,
              created_at: Date.now()
            });
            outcome = recorded ? 'recorded' : 'not_denied';
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
        const childConvId = extractChildConversationId(contentToSearch);
        const { requestedModel } = extractSubagentModel(input.toolCall?.args);
        let servedModel: string | null = null;
        if (childConvId) {
          try {
            servedModel = findServedModelFromTranscript(childConvId);
          } catch {
            // best-effort
          }
        }
        appendDecisionLog({
          event: 'subagent_served',
          harness: 'antigravity',
          session_id: conversationId,
          child_conversation_id: childConvId || null,
          requested_model: requestedModel || null,
          served_model: servedModel || null
        });

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

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: activeModel,
      quotaView,
      mode
    });

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
      prompt_hash: promptHash
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
