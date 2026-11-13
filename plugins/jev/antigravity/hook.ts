#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readJevMode,
  readQuotaView,
  loadEnvFile,
  privateDir,
  privateFile,
  PRIVATE_FILE_MODE,
  type JevMode
} from '../src/shared.js';
import { ceilingModelForHarness } from '../src/tools/dispatch.js';
import {
  evaluateAntigravitySubagentCall,
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

async function main() {
  const event = (process.argv[2] || 'pre-tool-use').toLowerCase();

  try {
    const jevDir = getJevDir();
    loadEnvFile(path.join(jevDir, 'env'));
    loadEnvFile(path.resolve(import.meta.dir, '..', '.env'));

    const rawStdin = await Bun.stdin.text();
    let input: AntigravityHookInput = {};
    if (rawStdin && rawStdin.trim().length > 0) {
      try {
        input = JSON.parse(rawStdin);
      } catch {
        // malformed stdin
        if (event === 'pre-tool-use') {
          console.log(JSON.stringify({ decision: 'allow' }));
        } else {
          console.log('{}');
        }
        process.exit(0);
      }
    }

    const mode: JevMode = await readJevMode('antigravity');
    if (mode !== 'on') {
      if (event === 'pre-tool-use') {
        console.log(JSON.stringify({ decision: 'allow' }));
      } else {
        console.log('{}');
      }
      process.exit(0);
    }

    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const approvals = createAntigravityApprovalStore(sessionsDir);

    if (event === 'post-tool-use') {
      const toolName = input?.toolCall?.name;
      if (toolName === 'ask_question') {
        const conversationId = input.conversationId || 'default-session';
        const questions = input.toolCall?.args?.questions;
        let elevateModel: string | undefined;

        if (Array.isArray(questions)) {
          for (const q of questions) {
            const qText = typeof q === 'string' ? q : q?.question;
            if (typeof qText === 'string' && qText.includes(ELEVATE_MARKER_PREFIX)) {
              const m = qText.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
              if (m) elevateModel = m[1].toLowerCase();
            }
          }
        } else if (typeof questions === 'string' && questions.includes(ELEVATE_MARKER_PREFIX)) {
          const m = questions.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
          if (m) elevateModel = m[1].toLowerCase();
        }

        const answerText = input.content || JSON.stringify(input);
        const parsed = parseElevationAnswer(answerText);
        const targetModel = parsed.model || elevateModel;

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
    const promptLength = lastUserPrompt.length;
    const promptHash = promptLength > 0
      ? createHash('sha256').update(lastUserPrompt).digest('hex')
      : null;

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
    // Fail-open: never block an Antigravity session on hook failure
    if (event === 'pre-tool-use') {
      console.log(JSON.stringify({ decision: 'allow' }));
    } else {
      console.log('{}');
    }
    process.exit(0);
  }
}

main();
