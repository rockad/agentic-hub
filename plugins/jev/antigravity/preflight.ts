#!/usr/bin/env bun
/**
 * PreInvocation Hook for Google Antigravity
 * Evaluates Jev mode, quota views, and session directives.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import {
  readJevMode,
  readQuotaView,
  writeAntigravitySessionModel,
  isOrchestratorModel,
  clampTierToSessionCeiling,
  defaultEffortForSubagent,
  applyEffortGovernance,
  callJev,
  logJevTelemetry,
  taskFingerprint,
  fetchRecallMemory,
  safeSessionId,
  privateDir,
  privateFile,
  PRIVATE_FILE_MODE,
  jevHomeDir,
  type QuotaView
} from '../src/shared.js';
import { withTimeout } from '../src/core/with-timeout.js';
import { lowQuotaNotice, modeBehaviour, quotaPoolLabel } from '../src/core/mode-policy.js';
import {
  cleanUserInput,
  turnId,
  writeAntigravityTurn,
  commitAntigravityTurn,
  buildAntigravityTelemetryEvent,
  flushPendingServed,
  type AntigravityTurnState
} from './logic.js';

interface PreInvocationInput {
  conversationId?: string;
  workspacePaths?: string[];
  modelName?: string;
  lastUserInput?: string;
  invocationNum?: number;
  initialNumSteps?: number;
}

const SUBAGENT_CRITERIA: Record<string, string> = {
  'code-engineer': 'Software engineering, automation scripting, unit testing, refactoring, and tooling specialist',
  'research': 'Deep research, comprehensive investigations, and information gathering',
  'review': 'Code review, architectural verification, diff inspection, and critique',
  'vault-librarian': 'Obsidian vault organization, note structure, wikilinks, indexing, and filing',
  'ghostwriter': 'Authoring documentation, long-form content, prose, and communication',
  'career-advisor': 'Career strategy, job applications, resume tailoring, and interview prep',
  'inbox-processor': 'Triaging incoming notes, tasks, staging areas, and unstructured text',
  'qa-engineer': 'Test authoring, test execution, bug reproduction, and QA validation',
  'system-operator': 'Infrastructure, host system config, daemons, background services, and environment setups',
  'knowledge-researcher': 'Synthesizing knowledge archives, transcripts, and domain notes',
  'self': 'Direct execution in main session, simple single-file edits, or conversational responses without delegation'
};

const TIER_CRITERIA: Record<string, string> = {
  openrouter_free: 'Lightweight summaries, drafts, syntax transforms, formatting, boilerplate ($0 cost)',
  flash_lite: 'Trivial triage, quick lookups, file moves, formatting',
  flash: 'Standard agentic steps, routine edits, content synthesis, local commands',
  pro: 'Deep reasoning, architecture, complex multi-file refactors, high-stakes writing'
};

export type AutoHealDeps = {
  /** Home directory; the default is HOME at call time (bun fixes os.homedir() at startup). */
  home?: string;
  /** Whether the `agy` CLI is on PATH. */
  hasAgy?: () => boolean;
  /** Runs `agy <args>`. */
  runAgy?: (args: string[]) => void;
};

export function autoHealAgyMcp(mode: string, deps: AutoHealDeps = {}): void {
  try {
    const home = deps.home ?? (process.env.HOME || os.homedir());
    const candidatePaths = [
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json')
    ];
    let mcpConfigPath = '';
    for (const p of candidatePaths) {
      if (fsSync.existsSync(p)) {
        mcpConfigPath = p;
        break;
      }
    }
    if (!mcpConfigPath) return;

    // Check if agy is on PATH
    const hasAgy =
      deps.hasAgy ??
      (() => {
        try {
          execSync('which agy 2>/dev/null || command -v agy 2>/dev/null', { stdio: 'ignore', timeout: 250 });
          return true;
        } catch {
          return false;
        }
      });
    if (!hasAgy()) return;

    const raw = JSON.parse(fsSync.readFileSync(mcpConfigPath, 'utf8'));
    const jevServer = raw?.mcpServers?.jev;
    const isDisabled = jevServer ? jevServer.disabled === true : true;
    const shouldBeDisabled = mode === 'off';
    if (isDisabled !== shouldBeDisabled) {
      const args = ['mcp', shouldBeDisabled ? 'disable' : 'enable', 'jev'];
      const runAgy =
        deps.runAgy ??
        ((a: string[]) => {
          execFileSync('agy', a, { timeout: PREFLIGHT_HEAL_MS, stdio: 'ignore' });
        });
      runAgy(args);
    }
  } catch {
    // fail-open
  }
}

/**
 * Timing budget of the PreInvocation hook (hooks.json allows 5 s for the whole process). Every wait is listed here with
 * its worst case; the sum of the sequential ones plus the one overall deadline keeps the hook under 4 s.
 *
 * Synchronous waits (they block the event loop, so they cannot overlap anything):
 *   - MCP auto-heal: `which agy` (250 ms cap) + `agy mcp enable|disable jev` (PREFLIGHT_HEAL_MS), 1000 ms at most, and
 *     only when the server's state differs from the mode (a mode change), never on a steady-state turn
 *   - pending-served flush: lock wait PREFLIGHT_LOCK_WAIT_MS + 200 ms of work (PENDING_SERVED_BUDGET_MS) = 450 ms
 *   - turn-state commit: lock wait PREFLIGHT_LOCK_WAIT_MS = 250 ms
 *   - quota-state, session-model and config reads: local files, no wait
 * Asynchronous waits (each clipped to what is left of the deadline):
 *   - the decisions router call: PREFLIGHT_ROUTER_MS (1500 ms), mode `on` only
 *   - the Recall memory read: PREFLIGHT_MEMORY_MS (1000 ms; two 800 ms fetches before), mode `on` only, started at the
 *     same time as everything else so it overlaps the router call instead of following it
 *   - telemetry writes: queued, not awaited one by one; the final flush waits PREFLIGHT_TELEMETRY_FLUSH_MS (500 ms)
 * Worst case: 1000 + 450 + 1500 + 250 + 500 = 3700 ms. PREFLIGHT_DEADLINE_MS (3500 ms) is the backstop: when it passes,
 * the hook prints what it has (the quota text and the mode directive; never a half-written one) and returns, and the
 * late step is skipped and logged as `preflight_skipped` in antigravity_decisions.jsonl.
 */
export const PREFLIGHT_DEADLINE_MS = 3500;
export const PREFLIGHT_ROUTER_MS = 1500;
export const PREFLIGHT_MEMORY_MS = 1000;
export const PREFLIGHT_TELEMETRY_FLUSH_MS = 500;
export const PREFLIGHT_LOCK_WAIT_MS = 250;
export const PREFLIGHT_HEAL_MS = 750;
/** Time to keep after the router call for the turn commit and the output; the router is not started with less. */
const PREFLIGHT_ROUTER_RESERVE_MS = 300;
const PREFLIGHT_MIN_ROUTER_MS = 400;
const PREFLIGHT_MIN_MEMORY_MS = 100;

export type PreflightDeps = {
  /** MCP auto-heal; the only thing mode `off` runs. */
  autoHeal?: (mode: string) => void;
  /** The Decisions API call; stubbed in tests so no network is touched. */
  callJev?: typeof callJev;
  /** The Recall memory read (`fetchRecallMemory`); stubbed in tests so no network is touched. Never called when the mode has no memory context. */
  fetchMemory?: typeof fetchRecallMemory;
  /** Overall deadline in ms (default {@link PREFLIGHT_DEADLINE_MS}); tests shorten it. */
  deadlineMs?: number;
};

type Bounded<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' };

/** Race `fn` against `ms`; the signal is aborted on timeout. Never rejects, never waits longer than `ms`. */
async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<Bounded<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: 'timeout' });
    }, Math.max(0, ms));
  });
  const work: Promise<Bounded<T>> = (async () => {
    try {
      return { ok: true as const, value: await fn(controller.signal) };
    } catch {
      return { ok: false as const, reason: 'error' as const };
    }
  })();
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runPreflight(inputJson?: string, deps: PreflightDeps = {}): Promise<void> {
  const autoHeal = deps.autoHeal ?? ((m: string) => autoHealAgyMcp(m));
  const callJevFn = deps.callJev ?? callJev;
  const fetchMemoryFn = deps.fetchMemory ?? fetchRecallMemory;

  // One overall deadline for the whole hook. `parts` is what gets printed; `emit` prints it once, from the normal path or
  // from the deadline, whichever comes first.
  const deadlineAt = Date.now() + (deps.deadlineMs ?? PREFLIGHT_DEADLINE_MS);
  const remaining = () => deadlineAt - Date.now();
  const parts: string[] = [];
  let emitted = false;
  const emit = () => {
    if (emitted) return;
    emitted = true;
    console.log(parts.length ? JSON.stringify({ injectSteps: [{ ephemeralMessage: parts.join('\n\n') }] }) : JSON.stringify({}));
  };
  let activeMode: string = 'off';
  /** A step that was late or skipped; mode `off` never gets here (it writes nothing). Fail open, one row per step. */
  const logSkipped = (step: string, reason: string) => {
    if (activeMode === 'off') return;
    try {
      const jevDir = process.env.JEV_CONFIG_FILE
        ? path.dirname(process.env.JEV_CONFIG_FILE)
        : path.join(jevHomeDir(), '.config', 'jev');
      privateDir(jevDir);
      const logFile = path.join(jevDir, 'antigravity_decisions.jsonl');
      fsSync.appendFileSync(
        logFile,
        JSON.stringify({
          event: 'preflight_skipped',
          step,
          reason,
          elapsed_ms: Math.max(0, (deps.deadlineMs ?? PREFLIGHT_DEADLINE_MS) - remaining()),
          timestamp: new Date().toISOString(),
          epoch: Math.floor(Date.now() / 1000)
        }) + '\n',
        { mode: PRIVATE_FILE_MODE }
      );
      privateFile(logFile);
    } catch {
      // fail open
    }
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      if (!emitted) logSkipped('rest-of-preflight', 'deadline');
      emit();
      resolve();
    }, Math.max(0, remaining()));
  });

  const body = async (): Promise<void> => {
    try {
      let hookInput: PreInvocationInput | null = null;
      if (inputJson && inputJson.trim().length > 0) {
        try {
          hookInput = JSON.parse(inputJson);
        } catch {
          hookInput = null;
        }
      }

      const conversationId = hookInput?.conversationId || undefined;
      const safeId = conversationId ? safeSessionId(conversationId) : undefined;
      const invocationNum = hookInput?.invocationNum;
      const rawUserInput = hookInput?.lastUserInput || '';
      const modelName =
        typeof hookInput?.modelName === 'string' && hookInput.modelName.trim().length > 0
          ? hookInput.modelName.trim()
          : null;
      const cleanTask = cleanUserInput(rawUserInput);

      // 1. Mode resolution: readJevMode('antigravity') only
      const mode = await readJevMode('antigravity');
      activeMode = mode;

      // 2. Auto-heal agy MCP
      autoHeal(mode);

      // Mode off: nothing else runs and nothing is written (no session model file, no quota read, no injection,
      // no telemetry). The auto-heal above is the only side effect.
      if (mode === 'off') {
        emit();
        return;
      }

      const behaviour = modeBehaviour(mode);

      // HOME at call time, not os.homedir(): bun fixes os.homedir() at startup (same rule as autoHealAgyMcp).
      const home = jevHomeDir();
      const jevDir = process.env.JEV_CONFIG_FILE
        ? path.dirname(process.env.JEV_CONFIG_FILE)
        : path.join(home, '.config', 'jev');
      const sessionsDir = path.join(jevDir, 'antigravity-sessions');
      const pendingTelemetry: Promise<unknown>[] = [];

      // Cross-harness memory: a Recall call and a context block, so mode `on` only (`modeBehaviour(mode).memoryContext`).
      // On-demand makes no Recall call and injects no block. It is independent of everything below, so it starts now and
      // overlaps the router call; the result is read at the end.
      let memoryRead: Promise<Bounded<any>> | null = null;
      if (behaviour.memoryContext) {
        const memoryMs = Math.min(PREFLIGHT_MEMORY_MS, remaining() - PREFLIGHT_ROUTER_RESERVE_MS);
        if (memoryMs < PREFLIGHT_MIN_MEMORY_MS) {
          logSkipped('memory', 'deadline');
        } else {
          const wsPath = hookInput?.workspacePaths?.[0] || process.cwd();
          const ws = path.basename(wsPath) || 'default';
          memoryRead = bounded(() => fetchMemoryFn(ws), memoryMs);
        }
      }

      try {
        // 3. Persist live modelName & flush any deferred subagent_served entries
        // The session model is what the store holds after the write: an Orchestrator conversation keeps its planner id
        // when an execution turn reports the worker id. Telemetry rows below keep the reported `modelName`.
        let sessionModel: string | null = modelName;
        if (modelName && conversationId) {
          sessionModel = writeAntigravitySessionModel(conversationId, modelName) ?? modelName;
        }
        if (conversationId) {
          flushPendingServed(
            sessionsDir,
            conversationId,
            (entry) => {
              try {
                privateDir(jevDir);
                const logFile = path.join(jevDir, 'antigravity_decisions.jsonl');
                const line = JSON.stringify({
                  ...entry,
                  timestamp: new Date().toISOString(),
                  epoch: Math.floor(Date.now() / 1000)
                }) + '\n';
                fsSync.appendFileSync(logFile, line, { mode: PRIVATE_FILE_MODE });
                privateFile(logFile);
              } catch {
                // fail open
              }
              if (entry.event === 'subagent_served' && entry.child_conversation_id && entry.served_model) {
                pendingTelemetry.push(
                  logJevTelemetry(
                    buildAntigravityTelemetryEvent({
                      kind: 'subagent_served',
                      conversationId: typeof entry.session_id === 'string' ? entry.session_id : (safeId ?? null),
                      inputModelName: modelName,
                      childConversationId: String(entry.child_conversation_id),
                      requestedModel: typeof entry.requested_model === 'string' ? entry.requested_model : null,
                      servedModel: String(entry.served_model),
                      backfilled: entry.backfilled === true
                    })
                  )
                );
              }
            },
            home,
            Date.now(),
            Date.now,
            PREFLIGHT_LOCK_WAIT_MS
          );
        }

        // 4. Read quota view with conversationId
        const quota: QuotaView = await readQuotaView({ conversationId });

        // 5. Determine pool and evaluatePoolStrategy
        const isOrchestrator = isOrchestratorModel(sessionModel || quota.active_model);
        const routinePool = isOrchestrator
          ? (quota.pools?.execution ?? quota.active)
          : quota.active;

        const poolStrategy = routinePool.strategy;
        const remainingFraction = routinePool.min_remaining ?? 1;
        const pct = (remainingFraction * 100).toFixed(1);
        const poolLabel = quotaPoolLabel(routinePool, quota.active_model);

        // Quota text. Mode `on`: the full directives (advice). A mode without routing advice (on-demand): the one-line
        // informational notice, only for a low or exhausted pool (the shared text, the same in every harness).
        if (behaviour.quotaNotice === 'low-only') {
          const notice = lowQuotaNotice({ label: poolLabel, strategy: poolStrategy, minRemaining: routinePool.min_remaining });
          if (notice) parts.push(notice);
        } else if (poolStrategy === 'free_only') {
          parts.push(`[QUOTA EMERGENCY: ${poolLabel} pool strategy is free_only (${pct}% remaining). Subagents are locked out. ALL generation, drafting, and boilerplate MUST be offloaded to free models via jev_execute_free or jev_agent_free.]`);
        } else if (poolStrategy === 'conserve') {
          const fivePct = routinePool.five_hour !== null && routinePool.five_hour !== undefined ? `${Math.round(routinePool.five_hour * 100)}%` : 'n/a';
          const weeklyPct = routinePool.weekly !== null && routinePool.weekly !== undefined ? `${Math.round(routinePool.weekly * 100)}%` : 'n/a';
          parts.push(`[QUOTA CONSERVE: ${poolLabel} pool strategy is conserve (${pct}% remaining, 5h: ${fivePct}, weekly: ${weeklyPct}). All subagents are throttled strictly to Model: "flash_lite" (Pro tier prohibited). Offload routine generation, boilerplate, formatting, and draft text to free models via jev_execute_free or jev_agent_free.]`);
        }

        // Argon-exhausted frontier pool for the Orchestrator. Mode `on`: the full warning (with the model-switch advice).
        // A mode without routing advice (on-demand): the same shared one-line notice as for every other low pool (one line
        // per low pool, no advice).
        if (isOrchestrator && quota.variant === 'argon') {
          const frontier = quota.pools?.frontier;
          const isArgonExhausted = frontier && (frontier.strategy === 'free_only' || frontier.min_remaining === 0);
          if (isArgonExhausted && behaviour.quotaNotice === 'low-only') {
            const notice = lowQuotaNotice({ label: 'Argon', strategy: frontier.strategy, minRemaining: frontier.min_remaining });
            if (notice) parts.push(notice);
          } else if (isArgonExhausted && behaviour.quotaNotice === 'always') {
            const resetAt = quota.buckets['gemini-argon-wtu-weekly']?.reset_at;
            const resetAtStr = typeof resetAt === 'number'
              ? new Date(resetAt * 1000).toISOString()
              : 'weekly reset';
            // The number is the actual remaining value: only a pool at exactly 0 says "0% remaining"; a free_only pool with some
            // remaining says "exhausted" without one.
            const remainingNote = frontier?.min_remaining === 0 ? '0% remaining ' : '';
            parts.push(`[ARGON EXHAUSTED WARNING: Orchestrator (Argon) frontier quota is exhausted (${remainingNote}until ${resetAtStr}). Orchestrator (Argon) will refuse turns. Switch model to Gemini 4 Hydrogen via /model (Antigravity will re-run the refused request automatically after /model).]`);
          }
        }

        // Routing advice (mode `on` only): the router call, the pre-flight line and the directive.
        if (behaviour.routingAdvice) {
          const sessionHint = safeId ? `Session ID: ${safeId} (pass as conversationId to jev_dispatch, jev_batch_dispatch, jev_quota, jev_select_model).` : '';

          let modeDirective = '';
          if (isOrchestrator) {
            modeDirective = `[JEV MODE: ON - ORCHESTRATOR ENFORCEMENT]
${sessionHint}
- Orchestrator Role & Ceiling: Subagents have a hard flash ceiling (subagentCeilingRank = 2). Set Model explicitly on invoke_subagent ("flash" or "flash_lite", never "inherit"). Pro elevation requires [jev-elevate:pro].
- Planner Phase: For single-stream refactors <= 6 files, plan and execute in-context. For multi-stream refactors, call jev_batch_dispatch(kind, needsEdit, conversationId) to decompose and delegate in parallel.
- Executor Phase: Offload mechanical transformations, boilerplate, and summaries to jev_execute_free ($0.00 cost). Always verify changes with jev_judge.`;
          } else {
            modeDirective = `[JEV MODE: ON - AGGRESSIVE ENFORCEMENT]
${sessionHint}
1. Pre-Flight Decision Flow: Run jev_select_model or jev_dispatch before starting complex tasks or spawning subagents. Pass conversationId="${safeId || ''}".
2. Free-Tier Offloading: Offload boilerplate generation, markdown formatting, draft summaries, and commit messages to jev_execute_free at $0.00 cost (0 Gemini quota).
3. Quality Gates: Verify diffs and multi-step changes with jev_judge before completing turns.
4. Subagent Tier Guard: Use flash_lite or flash for subagents. Pro tier (pro) strictly requires explicit manual user approval via ask_question.
5. Post-Approval Transition Gate: Upon plan approval or /grill-me completion, IMMEDIATELY call jev_batch_dispatch and manage_subagents(Action: "list") to decompose and delegate parallel subagents. Do NOT edit >=3 files sequentially in the main orchestrator context without dispatching first.`;
          }

          // The base directive is in place before the router call, so the deadline can print it when the call is late.
          const directiveIndex = parts.push(modeDirective) - 1;

          // Live Pre-flight dispatch when input is present
          const isPlanReview = /\[plan review\]/i.test(cleanTask);
          const isJevCmd = cleanTask.startsWith('/jev');
          const isFirstInvocation = invocationNum === 1 || invocationNum === undefined;
          const shouldDispatch =
            cleanTask.length >= 8 &&
            !isPlanReview &&
            !isJevCmd &&
            isFirstInvocation;

          let turnStateToWrite: AntigravityTurnState | null =
            cleanTask.length > 0 && isFirstInvocation
              ? { turn: turnId(cleanTask), at: new Date().toISOString() }
              : null;

          let stateWritten = false;
          if (shouldDispatch) {
            try {
              const questions = {
                recommendedSubagent: {
                  type: 'choice',
                  instructions: 'Select the best specialized subagent for this task (or self for direct work in main session)',
                  criteria: SUBAGENT_CRITERIA
                },
                recommendedTier: {
                  type: 'choice',
                  instructions: 'Determine the required model tier from cognitive load and complexity',
                  criteria: TIER_CRITERIA
                }
              };

              const routerMs = Math.min(PREFLIGHT_ROUTER_MS, remaining() - PREFLIGHT_ROUTER_RESERVE_MS);
              let dispatchData: Awaited<ReturnType<typeof callJev>> | null = null;
              if (routerMs < PREFLIGHT_MIN_ROUTER_MS) {
                logSkipped('router', 'deadline');
              } else {
                const routed = await bounded(
                  (signal) =>
                    callJevFn(
                      `Task: ${cleanTask}\n\nQuota strategy for this machine: ${poolStrategy}.`,
                      questions,
                      signal
                    ),
                  routerMs
                );
                if (routed.ok) dispatchData = routed.value;
                else logSkipped('router', routed.reason);
              }

              if (dispatchData?.answers) {
                const saChoice = dispatchData.answers.recommendedSubagent?.choice;
                const rawSubagent = typeof saChoice === 'string' && saChoice in SUBAGENT_CRITERIA ? saChoice : 'self';

                const tierChoice = dispatchData.answers.recommendedTier?.choice;
                const rawTier = typeof tierChoice === 'string' && tierChoice in TIER_CRITERIA ? tierChoice : 'flash';

                const activeModel = sessionModel || quota.active_model || 'gemini-pro';
                const { clampedTier } = clampTierToSessionCeiling(rawTier, activeModel, cleanTask);
                const recommendedTier = clampedTier;
                const recommendedSubagent = rawSubagent;

                const rawEffort = defaultEffortForSubagent(recommendedSubagent, cleanTask);
                const effort = applyEffortGovernance(rawEffort, poolStrategy, recommendedTier);

                const currentTurn = turnId(cleanTask);
                turnStateToWrite = {
                  turn: currentTurn,
                  recommendedTier,
                  recommendedSubagent,
                  effort,
                  at: new Date().toISOString()
                };

                // The turn's state first (under the turn lock), so a call that arrives from now on finds the recommendation, then
                // the PreInvocation row, then one late row for each call of this turn that was written before it existed.
                const lateCalls = conversationId
                  ? commitAntigravityTurn(sessionsDir, conversationId, turnStateToWrite, PREFLIGHT_LOCK_WAIT_MS)
                  : [];
                stateWritten = true;

                // The rows are queued in order and flushed with the other telemetry at the end, not awaited here: a slow
                // disk must not delay the directive.
                const { taskLen, taskHash } = taskFingerprint(cleanTask);
                pendingTelemetry.push(
                  (async () => {
                    await logJevTelemetry(
                      buildAntigravityTelemetryEvent({
                        kind: 'pre_invocation',
                        conversationId: safeId ?? null,
                        inputModelName: modelName,
                        quotaView: quota,
                        lastUserInput: cleanTask,
                        recommendedSubagent,
                        recommendedTier,
                        effort,
                        taskLen,
                        taskHash,
                        quotaStrategy: poolStrategy
                      })
                    );
                    for (const call of lateCalls) {
                      await logJevTelemetry(
                        buildAntigravityTelemetryEvent({
                          kind: 'agent_call_recommendation',
                          conversationId: safeId ?? null,
                          turn: currentTurn,
                          recommendedTier,
                          call
                        })
                      );
                    }
                  })()
                );

                const preflightLine = `[JEV PRE-FLIGHT] cost-tiered recommendation (quota=${poolStrategy}, model=${activeModel}): subagent="${recommendedSubagent}", tier="${recommendedTier}", effort="${effort}".`;
                parts[directiveIndex] = `${preflightLine}\n\n${modeDirective}`;
              }
            } catch {
              // preflight dispatch is best-effort
            }
          }

          if (turnStateToWrite && conversationId && !stateWritten) {
            writeAntigravityTurn(sessionsDir, conversationId, turnStateToWrite);
          }
        } else if (behaviour.telemetry) {
          // No routing advice (on-demand): no router call, no turn state, no directive. The prompt telemetry row is still
          // written, on the same prompts the dispatch would run for, with the session model and the quota strategy only
          // (no recommendation fields).
          const isPlanReview = /\[plan review\]/i.test(cleanTask);
          const isJevCmd = cleanTask.startsWith('/jev');
          const isFirstInvocation = invocationNum === 1 || invocationNum === undefined;
          if (cleanTask.length >= 8 && !isPlanReview && !isJevCmd && isFirstInvocation) {
            const { taskLen, taskHash } = taskFingerprint(cleanTask);
            pendingTelemetry.push(
              logJevTelemetry(
                buildAntigravityTelemetryEvent({
                  kind: 'pre_invocation',
                  conversationId: safeId ?? null,
                  inputModelName: modelName,
                  quotaView: quota,
                  lastUserInput: cleanTask,
                  taskLen,
                  taskHash,
                  quotaStrategy: poolStrategy
                })
              )
            );
          }
        }

        // The memory read started above; take what it has (it is bounded by its own budget).
        if (memoryRead) {
          const read = await memoryRead;
          if (read.ok) {
            const memory = read.value;
            if (memory && memory.lastHarness === 'opencode' && memory.activeGoal) {
              parts.push(
                `[CROSS-HARNESS MEMORY from OpenCode (${memory.updatedAt || 'recent'})]\n` +
                `Active Goal: ${memory.activeGoal}\n` +
                `Next Action: ${memory.nextAction || 'none'}\n` +
                `Current Milestone: ${memory.currentMilestone || 'none'}\n` +
                `(Synced via Recall)`
              );
            }
          } else if (read.reason === 'timeout') {
            logSkipped('memory', 'timeout');
          }
        }

        emit();
      } finally {
        // Printed above already; the flush only keeps the process alive for the queued rows, within what is left.
        if (pendingTelemetry.length > 0) {
          const flushMs = Math.min(PREFLIGHT_TELEMETRY_FLUSH_MS, Math.max(remaining(), 100));
          await withTimeout(Promise.allSettled(pendingTelemetry), flushMs);
        }
      }
    } catch {
      if (!emitted) {
        parts.length = 0;
        emit();
      }
    }
  };

  try {
    await Promise.race([body(), deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  // Defensive: the body always emits, but a hook must never print nothing.
  emit();
}

// Entry point when executed as standalone script
if (import.meta.main) {
  let stdinData = '';
  if (!process.stdin.isTTY) {
    stdinData = await Bun.stdin.text();
  }
  await runPreflight(stdinData);
  process.exit(0);
}
