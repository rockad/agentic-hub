#!/usr/bin/env bun
/**
 * Claude Code hook entry point for Jev. Registered in hooks/hooks.json:
 *
 *   session-start | post-model-switch  remember the session model (the ceiling)
 *   user-prompt-submit                 advise subagent / model / effort via additionalContext
 *   pre-tool-use (matcher "Agent|Task|Workflow")
 *                                      Agent delegation above the ceiling: asks (permission dialog), a model the user
 *                                      named passes (nothing else asks); opt-in JEV_ELEVATION=clamp runs the first one
 *                                      in a prompt on the session model instead (allow + updatedInput), a repeat asks,
 *                                      log the call next to the last recommendation, and remind once before staged
 *                                      work when no dispatch call preceded it (whether Claude Code fires this hook
 *                                      for the agents a Workflow launches is UNVERIFIED)
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
  AGENT_WINDOW_MS,
  NO_INTENT,
  PREFLIGHT_WINDOW_MS,
  STAGED_AGENT_CALLS,
  buildDirective,
  aliasRemapped,
  callSignature,
  classifyElevation,
  clampElevation,
  dispatchQuestions,
  elevationAskReason,
  envNotice,
  hasRecentDispatch,
  isHostInjectedPrompt,
  isNonTaskPrompt,
  isStagedPrompt,
  isStatusTurn,
  parseDispatch,
  parseUserIntent,
  preflightReminder,
  resolveClaudeSubagentCriteria,
  resolveModel,
  safeSessionId,
  storedIntent,
  trimTask,
  turnId,
  type AgentCall,
  type AgentDecision,
  type Dispatch,
  type TurnState
} from './logic.js';

const JEV_DIR = path.join(os.homedir(), '.config', 'jev');
const SESSIONS_DIR = path.join(JEV_DIR, 'claude-sessions');
const DECISIONS_LOG = path.join(JEV_DIR, 'claude_decisions.jsonl');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Owner-only modes for what the hook creates under `~/.config/jev`; an existing directory or file keeps its mode. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Create `dir` (and parents) owner-only, and tighten it when it already existed with looser modes. Never throws. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // best-effort: not our file, or a filesystem without modes
  }
}

/** Tighten a state or log file to owner-only after a write: `mode` on write applies only when the file is created. Never throws. */
function privateFile(file: string): void {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // best-effort
  }
}
/** Well inside Claude Code's 30 s UserPromptSubmit budget; a slow Jev must not stall the prompt. */
const JEV_HOOK_TIMEOUT_MS = 1500;

export type HookInput = {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  model?: string;
  to_model?: string;
  tool_name?: string;
  /** The whole Agent input: `updatedInput` replaces it, so a clamp copies every field. */
  tool_input?: AgentCall & Record<string, unknown>;
  /** One id per user prompt; the clamp is once per prompt. */
  prompt_id?: string;
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
  /** Drop the stored turn, for a turn that runs with Jev off: what was stored before is no longer this turn's. */
  forgetTurn?: (sessionId: string | null) => void;
  /** Whether a successful jev_dispatch or jev_batch_dispatch call from Claude Code was logged within the window; absent skips the reminder. */
  recentDispatch?: (windowMs: number) => boolean;
  /** This session's recent `agent_call` records in the decisions log, and whether one already carried a reminder. */
  recentAgentCalls?: (sessionId: string | null) => { count: number; reminded: boolean };
  /**
   * Atomically claim the one clamp of a prompt: `first` is true for the first caller with this key (session id
   * plus prompt id) and false for every later one, which also gets the signature the first caller stored (the
   * delegation that was clamped). Absent or throwing means the state is unavailable, and the call then asks
   * (the 2.3.3 behaviour) instead of clamping.
   */
  claimClamp?: (sessionId: string, promptKey: string, signature: string) => { first: boolean; signature?: string };
  now?: () => number;
  /** The environment to check for remapped model aliases and an effort override; absent skips the notice. */
  env?: Record<string, string | undefined>;
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
  const sessionId = safeSessionId(input.session_id);
  if ((await deps.readMode()) !== 'on') {
    // This turn runs without the advisor: nothing stored for an earlier turn may speak for it.
    safely(() => deps.forgetTurn?.(sessionId));
    return null;
  }
  const task = (input.prompt || '').trim();
  // A host-injected turn (a task notification, a local command) is not a new user turn: it keeps the
  // marker of the prompt it belongs to, asks Jev nothing and gets no advice.
  if (isHostInjectedPrompt(task)) return null;
  // The user's own words about a model or cost are stored first, before anything can return early, so
  // the Agent guard of this turn can honour them even when the prompt is short or Jev is unreachable,
  // and never reads an earlier turn's state.
  const intent = parseUserIntent(task);
  const turn = turnId(task);
  const promptIdField = typeof input.prompt_id === 'string' && input.prompt_id ? { promptId: input.prompt_id } : {};
  safely(() =>
    deps.saveTurn?.(sessionId, { turn, ...promptIdField, mode: 'on', intent: storedIntent(intent), at: new Date().toISOString() })
  );
  if (task.length < 8) return null;
  // A pasted blob carries no task: no advice and no Jev call.
  if (isNonTaskPrompt(task)) return null;
  if (deps.egressAllowed && !deps.egressAllowed(input.cwd)) {
    deps.log({ hook: 'UserPromptSubmit', session: sessionId, session_id: sessionId, egress: 'blocked' });
    return null;
  }
  const quotaStrategy = await deps.readQuotaStrategy();
  const criteria = await resolveClaudeSubagentCriteria();
  const rec = await deps.dispatch(trimTask(task), quotaStrategy, criteria);
  if (!rec) return null;
  // A status turn ("A3 completed the run") gets no line. An instruction in the prompt always does. The check
  // needs the recommendation, so a status turn has already sent its trimmed text to Jev by here.
  if (isStatusTurn(rec, task, intent)) return null;
  const sessionModel = deps.readSessionModel(sessionId);
  const { advised, rule } = resolveModel({ intent, rec, sessionModel });
  const staged = isStagedPrompt(task);
  safely(() =>
    deps.saveTurn?.(sessionId, {
      turn,
      ...promptIdField,
      mode: 'on',
      intent: storedIntent(intent),
      rec: { subagent: advised.subagent, tier: advised.tier, model: advised.model, ...(advised.by ? { by: advised.by } : {}) },
      ...(staged ? { staged: true } : {}),
      at: new Date().toISOString()
    })
  );
  deps.log({
    hook: 'UserPromptSubmit',
    // `session` is the 2.3.2 key and stays for existing readers; `session_id` is the key the case study
    // and the other Jev harnesses use. Both hold the same value.
    session: sessionId,
    session_id: sessionId,
    turn,
    subagent: advised.subagent,
    tier: advised.tier,
    effort: advised.effort,
    confidence: advised.confidence,
    ...(advised.routerTier ? { routerTier: advised.routerTier } : {}),
    ...(advised.by ? { by: advised.by } : {}),
    recommended_model: advised.model,
    rule,
    user_intent: storedIntent(intent),
    quota: quotaStrategy,
    sessionModel,
    ...(deps.env ? { env_notice: envNotice(deps.env) } : {})
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
  const tool = input.tool_name;
  if (tool !== 'Agent' && tool !== 'Task' && tool !== 'Workflow') return null;
  const mode = await deps.readMode();
  if (mode !== 'on') return null;
  const call = input.tool_input || {};
  const sessionId = safeSessionId(input.session_id);
  const sessionModel = deps.readSessionModel(sessionId);
  // A turn stored under another mode is stale: its advice and intent are not this turn's. In the live hook a
  // turn that ran with Jev off is already dropped by forgetTurn, so this check is a second line of defence
  // for a state written under another mode (and for injected stores); a state with no `mode` is accepted.
  const stored = safely(() => deps.readTurn?.(sessionId)) ?? null;
  const state = stored && (stored.mode === undefined || stored.mode === mode) ? stored : null;
  // What the user said in this turn's prompt (a named model, a cost intent) outranks the guard.
  // A stored instruction belongs to the prompt it was written for: when both ids are known and differ (a
  // host-injected turn, a later prompt that did not reach UserPromptSubmit), it is not an instruction now.
  // An id missing on either side keeps the old behaviour (the marker alone).
  const intentIsStale =
    typeof input.prompt_id === 'string' && !!input.prompt_id && !!state?.promptId && input.prompt_id !== state.promptId;
  const intent = intentIsStale ? NO_INTENT : (state?.intent ?? NO_INTENT);
  // The one gate is the deterministic ceiling check: a model stronger than the session's. It needs no
  // network and sends no task text anywhere. Jev's tier rating is not a gate (see decideAgentCall): it
  // reached the assistant at UserPromptSubmit, and it is logged below next to the model the call used.
  // A Workflow carries no model of its own, so it is never gated.
  const elevation = tool === 'Workflow' ? null : classifyElevation(call, sessionModel, intent);
  // An elevating call (a model stronger than the session's, no instruction naming it) asks: a permission dialog
  // on every such call, as in 2.3.3. Opt-in clamp (env JEV_ELEVATION=clamp, no config key): the first one per
  // prompt runs on the session model (allow + updatedInput, no dialog) and only a repeat in the same prompt asks.
  // An instructed call passes.
  let clamp: ReturnType<typeof clampElevation> | null = null;
  let verdict: AgentDecision = null;
  let elevationState: 'clamped' | 'asked' | 'instructed' | null = elevation?.kind === 'instructed' ? 'instructed' : null;
  let clampSkipped: string | null = null;
  const clampMode = (deps.env ?? process.env).JEV_ELEVATION === 'clamp';
  if (elevation?.kind === 'elevating' && !clampMode) {
    verdict = { decision: 'ask', reason: elevationAskReason(elevation) };
    elevationState = 'asked';
  } else if (elevation?.kind === 'elevating') {
    const promptKey = (typeof input.prompt_id === 'string' && safeSessionId(input.prompt_id)) || state?.turn || null;
    const signature = callSignature(call as Record<string, unknown>);
    let clampedEarlier = false;
    if (aliasRemapped(elevation.sessionAlias, deps.env)) {
      // The alias the clamp would set is remapped (ANTHROPIC_DEFAULT_<ALIAS>_MODEL): it would not run on the session model.
      clampSkipped = 'alias-remapped';
    } else if (sessionId && promptKey) {
      // Anything that stops us proving this is the first call of the prompt (no id, no state, a failing store) asks.
      const claim = safely(() => deps.claimClamp?.(sessionId, promptKey, signature));
      if (claim?.first) clamp = clampElevation(call as Record<string, unknown>, elevation);
      else clampedEarlier = !!claim && claim.signature === signature;
    }
    if (clamp) elevationState = 'clamped';
    else {
      verdict = { decision: 'ask', reason: elevationAskReason(elevation, clampedEarlier) };
      elevationState = 'asked';
    }
  }

  // Pre-flight reminder: only when the dispatch check is available, for staged work (a Workflow, the third
  // agent call in the window, or a turn whose prompt named a workflow), at most once, never blocks.
  const now = (deps.now ?? Date.now)();
  const recent = safely(() => deps.recentAgentCalls?.(sessionId)) ?? { count: 0, reminded: false };
  const staged = tool === 'Workflow' || recent.count >= STAGED_AGENT_CALLS || state?.staged === true;
  const remindedRecently = recent.reminded || (state?.remindedAt !== undefined && now - state.remindedAt < AGENT_WINDOW_MS);
  let reminder: string | null = null;
  if (
    staged &&
    deps.recentDispatch &&
    !remindedRecently &&
    !(safely(() => deps.recentDispatch!(PREFLIGHT_WINDOW_MS)) ?? true)
  ) {
    reminder = preflightReminder(tool);
    if (state) safely(() => deps.saveTurn?.(sessionId, { ...state, remindedAt: now }));
  }

  // Recommended versus used, joined by the turn id of the prompt that started this turn. The
  // recommendation is the one made for the user's prompt, not a score of the delegation brief.
  const recommended = state?.rec ?? null;
  deps.log({
    hook: 'PreToolUse',
    event: 'agent_call',
    session: sessionId,
    session_id: sessionId,
    tool_name: tool,
    turn: state?.turn ?? null,
    subagent_type: typeof call.subagent_type === 'string' ? call.subagent_type : null,
    model: call.model ?? null,
    requested_model: typeof call.model === 'string' ? call.model : null,
    tier: recommended?.tier ?? null,
    recommended_model: recommended?.model ?? null,
    user_intent: state?.intent ?? null,
    sessionModel,
    reason: verdict?.reason ?? (clamp ? String(clamp.hookSpecificOutput.permissionDecisionReason) : null),
    ...(elevationState ? { elevation: elevationState } : {}),
    ...(clampSkipped ? { clamp_skipped: clampSkipped } : {}),
    ...(intentIsStale ? { intent_stale: true } : {}),
    ...(clamp && elevation ? { clamped_from: elevation.requested, clamped_to: elevation.sessionAlias } : {}),
    preflight_reminder: reminder !== null
  });
  if (clamp) {
    const out = clamp.hookSpecificOutput;
    return { hookSpecificOutput: { ...out, additionalContext: reminder ? `${out.additionalContext}\n\n${reminder}` : out.additionalContext } };
  }
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
  privateDir(SESSIONS_DIR);
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ model, updated_at: new Date().toISOString() }) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(file);
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
  privateDir(SESSIONS_DIR);
  fs.writeFileSync(turnFile(sessionId), JSON.stringify(state) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(turnFile(sessionId));
}

/**
 * The one clamp of a prompt, claimed with an exclusive create (`wx`) so two Agent calls fired in parallel
 * cannot both be "first". One marker file per session; its content is the signature of the delegation that was
 * clamped, so a later call can tell whether it is that same delegation. A claim for another prompt id removes
 * the old marker; markers that are left are pruned after 7 days at SessionStart. Throws when the store cannot
 * be written; the caller treats that as "ask".
 */
function claimClamp(sessionId: string, promptKey: string, signature: string): { first: boolean; signature?: string } {
  privateDir(SESSIONS_DIR);
  const prefix = `${sessionId}.clamp-`;
  const mine = `${prefix}${promptKey}`;
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    if (name.startsWith(prefix) && name !== mine) fs.rmSync(path.join(SESSIONS_DIR, name), { force: true });
  }
  try {
    const file = path.join(SESSIONS_DIR, mine);
    fs.writeFileSync(file, signature, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    privateFile(file);
    return { first: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // The first caller may still be writing: an empty marker means "unknown", which says nothing about the signature.
    const stored = fs.readFileSync(path.join(SESSIONS_DIR, mine), 'utf8').trim();
    return { first: false, ...(stored ? { signature: stored } : {}) };
  }
}

function forgetTurn(sessionId: string | null): void {
  if (!sessionId) return;
  fs.rmSync(turnFile(sessionId), { force: true });
}

/**
 * True when the shared telemetry file holds a dispatch call inside the window. The file has no
 * session id, so this is a machine-wide check; it errs towards "dispatched" when unreadable.
 */
function recentDispatch(windowMs: number): boolean {
  try {
    if (!fs.existsSync(TELEMETRY_FILE)) return false;
    return hasRecentDispatch(tailLines(TELEMETRY_FILE), Date.now(), windowMs);
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
    sessionId: str(entry.session_id) ?? str(entry.session) ?? null,
    taskSummary: str(entry.subagent) ? `subagent: ${entry.subagent}` : str(entry.subagent_type) ? `subagent: ${entry.subagent_type}` : undefined,
    tierRecommended: str(entry.tier),
    turn: str(entry.turn),
    ...(isPrompt
      ? {
          modelRecommended: str(entry.recommended_model) ?? str(entry.model),
          // Deprecated alias kept for one release (case study 5.7): same value as modelRecommended.
          modelUsed: str(entry.recommended_model) ?? str(entry.model)
        }
      : { modelUsed: str(entry.clamped_to) ?? str(entry.requested_model) ?? str(entry.model), modelRecommended: str(entry.recommended_model) }),
    quotaStrategy: str(entry.quota)
  };
}

/** Telemetry appends in flight: the process must wait for them before it exits, or the lines are lost. */
const pendingLogs: Promise<unknown>[] = [];

/** How long the process waits for the pending telemetry appends before it exits anyway. */
export const LOG_FLUSH_TIMEOUT_MS = 1000;

/** Register an append that the process must wait for before it exits. */
export function trackPendingLog(p: Promise<unknown>): void {
  pendingLogs.push(p);
}

/** Wait for every telemetry append started so far. Never throws and never waits longer than the budget. */
export async function flushPendingLogs(ms: number = LOG_FLUSH_TIMEOUT_MS): Promise<void> {
  try {
    await withTimeout(Promise.allSettled(pendingLogs.splice(0)), ms);
  } catch {
    // best-effort
  }
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    // Never prompt text: an entry holds the recommendation, model names, a tier and a prompt hash only.
    privateDir(JEV_DIR);
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', { mode: PRIVATE_FILE_MODE });
    privateFile(DECISIONS_LOG);
    trackPendingLog(logJevTelemetry(telemetryEvent(entry)));
  } catch {
    // logging is best-effort
  }
}

/** The parsed JSON lines in the last 256 KiB of a file. Unreadable or missing: none. Never throws. */
function tailLines(file: string): string[] {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const lines = buf.toString('utf8').split('\n');
      if (length < size) lines.shift(); // cut mid-record
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** The session's `agent_call` records in the decisions log within the agent window, and whether one carried a reminder. */
function recentAgentCalls(sessionId: string | null): { count: number; reminded: boolean } {
  if (!sessionId) return { count: 0, reminded: false };
  const now = Date.now();
  let count = 0;
  let reminded = false;
  for (const line of tailLines(DECISIONS_LOG)) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      if (e.event !== 'agent_call' || e.session_id !== sessionId || !Number.isFinite(at) || now - at > AGENT_WINDOW_MS) continue;
      count++;
      if (e.preflight_reminder === true) reminded = true;
    } catch {
      // skip a malformed line
    }
  }
  return { count, reminded };
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
  forgetTurn,
  claimClamp,
  recentDispatch,
  recentAgentCalls,
  env: process.env,
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
  // process.exit would drop the async telemetry appends still in flight.
  await flushPendingLogs();
  process.exit(0);
}
