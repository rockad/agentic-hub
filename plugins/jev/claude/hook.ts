#!/usr/bin/env bun
/**
 * Claude Code hook entry point for Jev. Registered in hooks/hooks.json:
 *
 *   session-start | post-model-switch  remember the session model (the ceiling)
 *   user-prompt-submit                 advise subagent / model / effort via additionalContext
 *   pre-tool-use (matcher "Agent")     ask before a delegation runs above the ceiling
 *
 * Active only in Jev mode "on" (~/.config/jev/mode.json). Every path is
 * best-effort: on any error the hook prints nothing and exits 0, so Claude Code
 * carries on as if Jev were not installed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callJev, readJevMode, readQuotaView, loadEnvFile, fetchRecallMemory, logJevTelemetry, type JevMode } from '../src/shared.js';
import {
  buildDirective,
  decideAgentCall,
  decideByTier,
  dispatchQuestions,
  parseDispatch,
  safeSessionId,
  type AgentCall,
  type Dispatch
} from './logic.js';

const JEV_DIR = path.join(os.homedir(), '.config', 'jev');
const SESSIONS_DIR = path.join(JEV_DIR, 'claude-sessions');
const DECISIONS_LOG = path.join(JEV_DIR, 'claude_decisions.jsonl');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Well inside Claude Code's 30 s UserPromptSubmit budget; a slow Jev must not stall the prompt. */
const JEV_HOOK_TIMEOUT_MS = 1500;

export type HookInput = {
  session_id?: string;
  prompt?: string;
  model?: string;
  to_model?: string;
  tool_name?: string;
  tool_input?: AgentCall;
};

export type HookOutput = { hookSpecificOutput: Record<string, unknown> } | null;

export type HookDeps = {
  readMode: () => Promise<JevMode>;
  readSessionModel: (sessionId: string | null) => string | null;
  readQuotaStrategy: () => Promise<string>;
  dispatch: (task: string, quotaStrategy: string) => Promise<Dispatch | null>;
  log: (entry: Record<string, unknown>) => void;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

export async function onUserPromptSubmit(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  if ((await deps.readMode()) !== 'on') return null;
  const task = (input.prompt || '').trim();
  if (task.length < 8) return null;
  const sessionId = safeSessionId(input.session_id);
  const quotaStrategy = await deps.readQuotaStrategy();
  const rec = await deps.dispatch(task, quotaStrategy);
  if (!rec) return null;
  const sessionModel = deps.readSessionModel(sessionId);
  deps.log({ hook: 'UserPromptSubmit', session: sessionId, ...rec, quota: quotaStrategy, sessionModel });

  let additionalContext = buildDirective(rec, sessionModel, quotaStrategy);
  try {
    const memory = await withTimeout(fetchRecallMemory(), 600);
    if (memory && memory.activeGoal) {
      additionalContext += `\n\n[CROSS-HARNESS MEMORY]\nActive Goal: ${memory.activeGoal}\nCurrent Milestone: ${memory.currentMilestone || 'none'}\nNext Action: ${memory.nextAction || 'none'}`;
    }
  } catch {
    // best-effort
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  };
}

export async function onPreToolUse(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;
  if ((await deps.readMode()) !== 'on') return null;
  const call = input.tool_input || {};
  const sessionId = safeSessionId(input.session_id);
  const sessionModel = deps.readSessionModel(sessionId);
  // The deterministic ceiling check first: it needs no network.
  let verdict = decideAgentCall(call, sessionModel);
  if (!verdict) {
    const task = (call.prompt || call.description || '').trim();
    const rec = task.length >= 8 ? await deps.dispatch(task, await deps.readQuotaStrategy()) : null;
    verdict = decideByTier(call, rec);
  }
  if (!verdict) return null;
  deps.log({ hook: 'PreToolUse', session: sessionId, model: call.model ?? null, sessionModel, reason: verdict.reason });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason
    }
  };
}

/** SessionStart and PostModelSwitch: store the session model; nothing is printed. */
export function onModelKnown(input: HookInput): void {
  const sessionId = safeSessionId(input.session_id);
  const model = input.to_model || input.model;
  if (!sessionId || !model) return;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sessionId}.json`),
    JSON.stringify({ model, updated_at: new Date().toISOString() }) + '\n'
  );
  pruneOldSessions();
}

function pruneOldSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    const file = path.join(SESSIONS_DIR, name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

function readSessionModel(sessionId: string | null): string | null {
  if (!sessionId) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), 'utf8'));
    return typeof raw.model === 'string' ? raw.model : null;
  } catch {
    return null;
  }
}

async function liveDispatch(task: string, quotaStrategy: string): Promise<Dispatch | null> {
  try {
    const data = await withTimeout(
      callJev(`Task: ${task}\n\nQuota strategy for this machine: ${quotaStrategy}.`, dispatchQuestions()),
      JEV_HOOK_TIMEOUT_MS
    );
    return data ? parseDispatch(data, task, quotaStrategy) : null;
  } catch {
    return null;
  }
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(JEV_DIR, { recursive: true });
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
    void logJevTelemetry({
      harness: 'claude',
      toolOrHook: String(entry.hook || 'hook'),
      sessionId: typeof entry.session === 'string' ? entry.session : null,
      taskSummary: typeof entry.subagent === 'string' ? `subagent: ${entry.subagent}` : undefined,
      tierRecommended: typeof entry.tier === 'string' ? entry.tier : undefined,
      modelUsed: typeof entry.model === 'string' ? entry.model : undefined,
      quotaStrategy: typeof entry.quota === 'string' ? entry.quota : undefined
    });
  } catch {
    // logging is best-effort
  }
}

const liveDeps: HookDeps = {
  readMode: () => readJevMode('claude-code'),
  readSessionModel,
  readQuotaStrategy: async () => {
    try {
      return (await readQuotaView()).strategy;
    } catch {
      return 'unknown';
    }
  },
  dispatch: liveDispatch,
  log: appendLog
};

async function main(event: string | undefined): Promise<void> {
  // The key is picked up the same way the MCP server and the OpenCode plugin do.
  loadEnvFile(path.join(JEV_DIR, 'env'));
  loadEnvFile(path.resolve(import.meta.dir, '..', '.env'));
  const input = JSON.parse((await Bun.stdin.text()) || '{}') as HookInput;
  const output =
    event === 'user-prompt-submit' ? await onUserPromptSubmit(input, liveDeps)
    : event === 'pre-tool-use' ? await onPreToolUse(input, liveDeps)
    : null;
  if (event === 'session-start' || event === 'post-model-switch') onModelKnown(input);
  if (output) process.stdout.write(JSON.stringify(output));
}

if (import.meta.main) {
  try {
    await main(process.argv[2]);
  } catch {
    // never fail the host turn on Jev
  }
  process.exit(0);
}
