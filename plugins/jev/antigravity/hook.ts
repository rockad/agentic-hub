#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readJevMode,
  readQuotaView,
  privateDir,
  privateFile,
  PRIVATE_FILE_MODE,
  type JevMode
} from '../src/shared.js';
import { taskFingerprint } from '../src/core/telemetry.js';
import { ceilingModelForHarness } from '../src/tools/dispatch.js';
import {
  evaluateAntigravitySubagentCall,
  extractAskAnswer,
  extractSubagentModel,
  parseElevationAnswer,
  ELEVATE_MARKER_PREFIX,
  type AntigravityHookInput
} from './logic.js';
import { createAntigravityApprovalStore } from './approvals.js';

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
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(file, line, { mode: PRIVATE_FILE_MODE });
    privateFile(file);
  } catch {
    // fail open on logging failure
  }
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
    if (mode !== 'on') {
      passThrough(event);
    }

    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const approvals = createAntigravityApprovalStore(sessionsDir);

    if (event === 'post-tool-use') {
      const toolName = input?.toolCall?.name;
      if (toolName === 'ask_question') {
        const conversationId = input.conversationId || 'default-session';
        const questions = input.toolCall?.args?.questions;
        let elevateModel: string | undefined;
        // Which question carries the marker, so its own answer line (A1 = first question) is the one read.
        let markerIndex = 0;

        if (Array.isArray(questions)) {
          questions.forEach((q, index) => {
            const qText = typeof q === 'string' ? q : q?.question;
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

        // The model comes from the question's marker; the answer ONLY from the `content` field that carries the user's
        // choice, matched against the prescribed labels exactly. Never the payload as a whole, never toolCall.args.
        const parsed = parseElevationAnswer(extractAskAnswer(input, markerIndex));
        const targetModel = elevateModel;

        if (parsed.approved && parsed.scope && targetModel) {
          approvals.record(conversationId, {
            model: targetModel,
            scope: parsed.scope,
            created_at: Date.now()
          });
        }
      }
      console.log('{}');
      process.exit(0);
    }

    // PreToolUse
    let activeModel: string | undefined;
    try {
      const quotaView = await readQuotaView();
      activeModel = ceilingModelForHarness('antigravity', quotaView?.active_model);
    } catch {
      // ignore
    }
    if (!activeModel && input.modelName) {
      activeModel = input.modelName;
    }

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: activeModel
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
