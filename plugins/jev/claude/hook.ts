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
import {
  callJev,
  readJevMode,
  readQuotaView,
  loadEnvFile,
  fetchRecallMemory,
  logJevTelemetry,
  checkEgress,
  egressContextDirs,
  TELEMETRY_FILE,
  type JevMode,
  type JevTelemetryEvent
} from '../src/shared.js';
import {
  NO_INTENT,
  PREFLIGHT_REMINDER,
  PREFLIGHT_WINDOW_MS,
  buildDirective,
  decideAgentCall,
  decideByTier,
  dispatchQuestions,
  hasRecentDispatch,
  parseDispatch,
  parseUserIntent,
  resolveClaudeSubagentCriteria,
  safeSessionId,
  turnId,
  type AgentCall,
  type Dispatch,
  type TurnState
} from './logic.js';

const JEV_DIR = path.join(os.homedir(), '.config', 'jev');
const SESSIONS_DIR = path.join(JEV_DIR, 'claude-sessions');
const DECISIONS_LOG = path.join(JEV_DIR, 'claude_decisions.jsonl');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Well inside Claude Code's 30 s UserPromptSubmit budget; a slow Jev must not stall the prompt. */
const JEV_HOOK_TIMEOUT_MS = 1500;

export type HookInput = {
  session_id?: string;
  cwd?: string;
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
  dispatch: (task: string, quotaStrategy: string, criteria?: Record<string, string>) => Promise<Dispatch | null>;
  log: (entry: Record<string, unknown>) => void;
  /** Egress policy for the hook's working directory; absent means no policy. */
  egressAllowed?: (cwd: string | undefined) => boolean;
  /** The current turn's state (user intent, last recommendation), written at UserPromptSubmit. */
  readTurn?: (sessionId: string | null) => TurnState | null;
  saveTurn?: (sessionId: string | null, state: TurnState) => void;
  /** Whether a jev_dispatch or jev_batch_dispatch call was logged within the window; absent skips the reminder. */
  recentDispatch?: (windowMs: number) => boolean;
  now?: () => number;
};

export function withTimeout<T>(
  pOrFn: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  externalController?: AbortController
): Promise<T | null> {
  const controller = externalController || new AbortController();
  let timer: any;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, ms);
  });
  const promise = typeof pOrFn === 'function' ? pOrFn(controller.signal) : pOrFn;
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function onUserPromptSubmit(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  if ((await deps.readMode()) !== 'on') return null;
  const task = (input.prompt || '').trim();
  const sessionId = safeSessionId(input.session_id);
  // The user's own words about a model or cost are stored first, so the Agent guard of this
  // turn can honour them even when the prompt is short or Jev is unreachable.
  const intent = parseUserIntent(task);
  const turn = turnId(task);
  safely(() => deps.saveTurn?.(sessionId, { turn, intent }));
  if (task.length < 8) return null;
  if (deps.egressAllowed && !deps.egressAllowed(input.cwd)) {
    deps.log({ hook: 'UserPromptSubmit', session: sessionId, egress: 'blocked' });
    return null;
  }
  const quotaStrategy = await deps.readQuotaStrategy();
  const criteria = await resolveClaudeSubagentCriteria();
  const rec = await deps.dispatch(task, quotaStrategy, criteria);
  if (!rec) return null;
  const sessionModel = deps.readSessionModel(sessionId);
  safely(() =>
    deps.saveTurn?.(sessionId, { turn, intent, rec: { subagent: rec.subagent, tier: rec.tier, model: rec.model } })
  );
  deps.log({
    hook: 'UserPromptSubmit',
    session: sessionId,
    turn,
    ...rec,
    recommended_model: rec.model,
    user_intent: intent,
    quota: quotaStrategy,
    sessionModel
  });

  let additionalContext = buildDirective(rec, sessionModel, quotaStrategy, intent);
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
  const state = safely(() => deps.readTurn?.(sessionId)) ?? null;
  // What the user said in this turn's prompt (a named model, a cost intent) outranks the guard.
  const intent = state?.intent ?? NO_INTENT;
  // The deterministic ceiling check first: it needs no network.
  let verdict = decideAgentCall(call, sessionModel, intent);
  let rec: Dispatch | null = null;
  if (!verdict) {
    const task = (call.prompt || call.description || '').trim();
    // The egress policy gates only the network advice; the ceiling check above always runs.
    const egressOk = !deps.egressAllowed || deps.egressAllowed(input.cwd);
    if (!egressOk) deps.log({ hook: 'PreToolUse', session: sessionId, egress: 'blocked' });
    rec =
      task.length >= 8 && egressOk
        ? await deps.dispatch(task, await deps.readQuotaStrategy(), await resolveClaudeSubagentCriteria())
        : null;
    verdict = decideByTier(call, rec, intent);
  }

  // Pre-flight reminder: only when the dispatch check is available, at most once per window, never blocks.
  const now = (deps.now ?? Date.now)();
  let reminder: string | null = null;
  const remindedRecently = state?.remindedAt !== undefined && now - state.remindedAt < PREFLIGHT_WINDOW_MS;
  if (deps.recentDispatch && !remindedRecently && !(safely(() => deps.recentDispatch!(PREFLIGHT_WINDOW_MS)) ?? true)) {
    reminder = PREFLIGHT_REMINDER;
    safely(() => deps.saveTurn?.(sessionId, { turn: state?.turn ?? '', intent, rec: state?.rec, remindedAt: now }));
  }

  // Recommended versus used, joined by the turn id of the prompt that started this turn.
  const recommended = rec ?? state?.rec ?? null;
  deps.log({
    hook: 'PreToolUse',
    session: sessionId,
    turn: state?.turn ?? null,
    subagent_type: call.subagent_type,
    model: call.model ?? null,
    requested_model: call.model ?? null,
    tier: recommended?.tier ?? null,
    recommended_model: recommended?.model ?? null,
    sessionModel,
    reason: verdict?.reason ?? null,
    preflight_reminder: reminder !== null
  });
  if (!verdict && !reminder) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(verdict ? { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } : {}),
      ...(reminder ? { additionalContext: reminder } : {})
    }
  };
}

/** Run a best-effort side effect or read; a failure never reaches the host turn. */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
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

function turnFile(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.turn.json`);
}

function readTurn(sessionId: string | null): TurnState | null {
  if (!sessionId) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(turnFile(sessionId), 'utf8'));
    return raw && typeof raw.turn === 'string' && raw.intent && Array.isArray(raw.intent.models) ? (raw as TurnState) : null;
  } catch {
    return null;
  }
}

function saveTurn(sessionId: string | null, state: TurnState): void {
  if (!sessionId) return;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(turnFile(sessionId), JSON.stringify(state) + '\n');
}

/**
 * True when the shared telemetry file holds a dispatch call inside the window. The file has no
 * session id, so this is a machine-wide check; it errs towards "dispatched" when unreadable.
 */
function recentDispatch(windowMs: number): boolean {
  try {
    if (!fs.existsSync(TELEMETRY_FILE)) return false;
    const size = fs.statSync(TELEMETRY_FILE).size;
    const length = Math.min(size, 256 * 1024);
    const fd = fs.openSync(TELEMETRY_FILE, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return hasRecentDispatch(buf.toString('utf8').split('\n'), Date.now(), windowMs);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

async function liveDispatch(task: string, quotaStrategy: string, criteria?: Record<string, string>): Promise<Dispatch | null> {
  try {
    const data = await withTimeout(
      (signal) =>
        callJev(
          `Task: ${task}\n\nQuota strategy for this machine: ${quotaStrategy}.`,
          dispatchQuestions(criteria),
          signal
        ),
      JEV_HOOK_TIMEOUT_MS
    );
    return data ? parseDispatch(data, task, quotaStrategy, criteria) : null;
  } catch {
    return null;
  }
}

/**
 * Telemetry record for one decisions-log entry. On UserPromptSubmit the model is the
 * recommended one (`modelRecommended`, which replaces the old, misleading `modelUsed`);
 * on PreToolUse it is the model the delegation requested (`modelUsed`) next to the
 * recommended one. Both carry the `turn` id so the two can be joined.
 */
export function telemetryEvent(entry: Record<string, unknown>): JevTelemetryEvent {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const isPrompt = entry.hook === 'UserPromptSubmit';
  return {
    harness: 'claude',
    toolOrHook: String(entry.hook || 'hook'),
    sessionId: typeof entry.session === 'string' ? entry.session : null,
    taskSummary: typeof entry.subagent === 'string' ? `subagent: ${entry.subagent}` : undefined,
    tierRecommended: str(entry.tier),
    turn: str(entry.turn),
    ...(isPrompt
      ? {
          modelRecommended: str(entry.recommended_model) ?? str(entry.model),
          // Deprecated alias kept for one release (case study 5.7): same value as modelRecommended.
          modelUsed: str(entry.recommended_model) ?? str(entry.model)
        }
      : { modelUsed: str(entry.requested_model) ?? str(entry.model), modelRecommended: str(entry.recommended_model) }),
    quotaStrategy: str(entry.quota)
  };
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(JEV_DIR, { recursive: true });
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
    void logJevTelemetry(telemetryEvent(entry));
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
  log: appendLog,
  readTurn,
  saveTurn,
  recentDispatch,
  egressAllowed: (cwd) => checkEgress(egressContextDirs([cwd])).allowed
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
