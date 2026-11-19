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
          execSync('which agy 2>/dev/null || command -v agy 2>/dev/null', { stdio: 'ignore' });
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
          execFileSync('agy', a, { timeout: 1500, stdio: 'ignore' });
        });
      runAgy(args);
    }
  } catch {
    // fail-open
  }
}

export type PreflightDeps = {
  /** MCP auto-heal; the only thing mode `off` runs. */
  autoHeal?: (mode: string) => void;
  /** The Decisions API call; stubbed in tests so no network is touched. */
  callJev?: typeof callJev;
};

export async function runPreflight(inputJson?: string, deps: PreflightDeps = {}): Promise<void> {
  const autoHeal = deps.autoHeal ?? ((m: string) => autoHealAgyMcp(m));
  const callJevFn = deps.callJev ?? callJev;
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

    // 2. Auto-heal agy MCP
    autoHeal(mode);

    // Mode off: nothing else runs and nothing is written (no session model file, no quota read, no injection,
    // no telemetry). The auto-heal above is the only side effect.
    if (mode === 'off') {
      console.log(JSON.stringify({}));
      return;
    }

    // HOME at call time, not os.homedir(): bun fixes os.homedir() at startup (same rule as autoHealAgyMcp).
    const home = jevHomeDir();
    const jevDir = process.env.JEV_CONFIG_FILE
      ? path.dirname(process.env.JEV_CONFIG_FILE)
      : path.join(home, '.config', 'jev');
    const sessionsDir = path.join(jevDir, 'antigravity-sessions');
    const pendingTelemetry: Promise<unknown>[] = [];

    try {
      // 3. Persist live modelName & flush any deferred subagent_served entries
      if (modelName && conversationId) {
        writeAntigravitySessionModel(conversationId, modelName);
      }
      if (conversationId) {
        flushPendingServed(sessionsDir, conversationId, (entry) => {
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
        }, home);
      }

      // 4. Read quota view with conversationId
      const quota: QuotaView = await readQuotaView({ conversationId });

      // 5. Determine pool and evaluatePoolStrategy
      const isOrchestrator = isOrchestratorModel(modelName || quota.active_model);
      const routinePool = isOrchestrator
        ? (quota.pools?.execution ?? quota.active)
        : quota.active;

      const poolStrategy = routinePool.strategy;
      const remaining = routinePool.min_remaining ?? 1;
      const pct = (remaining * 100).toFixed(1);
      const poolLabel = quotaPoolLabel(routinePool, quota.active_model);
      const behaviour = modeBehaviour(mode);

      // Directives
      const parts: string[] = [];

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

            const dispatchData = await withTimeout(
              (signal) =>
                callJevFn(
                  `Task: ${cleanTask}\n\nQuota strategy for this machine: ${poolStrategy}.`,
                  questions,
                  signal
                ),
              1500
            );

            if (dispatchData?.answers) {
              const saChoice = dispatchData.answers.recommendedSubagent?.choice;
              const rawSubagent = typeof saChoice === 'string' && saChoice in SUBAGENT_CRITERIA ? saChoice : 'self';

              const tierChoice = dispatchData.answers.recommendedTier?.choice;
              const rawTier = typeof tierChoice === 'string' && tierChoice in TIER_CRITERIA ? tierChoice : 'flash';

              const activeModel = modelName || quota.active_model || 'gemini-pro';
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
              const lateCalls = conversationId ? commitAntigravityTurn(sessionsDir, conversationId, turnStateToWrite) : [];
              stateWritten = true;

              const { taskLen, taskHash } = taskFingerprint(cleanTask);
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

              const preflightLine = `[JEV PRE-FLIGHT] cost-tiered recommendation (quota=${poolStrategy}, model=${activeModel}): subagent="${recommendedSubagent}", tier="${recommendedTier}", effort="${effort}".`;
              modeDirective = `${preflightLine}\n\n${modeDirective}`;
            }
          } catch {
            // preflight dispatch is best-effort
          }
        }

        if (turnStateToWrite && conversationId && !stateWritten) {
          writeAntigravityTurn(sessionsDir, conversationId, turnStateToWrite);
        }

        parts.push(modeDirective);
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

      // Check cross-harness memory
      try {
        const wsPath = hookInput?.workspacePaths?.[0] || process.cwd();
        const ws = path.basename(wsPath) || 'default';
        const memory = await fetchRecallMemory(ws);
        if (memory && memory.lastHarness === 'opencode' && memory.activeGoal) {
          parts.push(
            `[CROSS-HARNESS MEMORY from OpenCode (${memory.updatedAt || 'recent'})]\n` +
            `Active Goal: ${memory.activeGoal}\n` +
            `Next Action: ${memory.nextAction || 'none'}\n` +
            `Current Milestone: ${memory.currentMilestone || 'none'}\n` +
            `(Synced via Recall)`
          );
        }
      } catch {
        // ignore
      }

      if (!parts.length) {
        console.log(JSON.stringify({}));
        return;
      }

      const message = parts.join('\n\n');
      console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: message }] }));
    } finally {
      if (pendingTelemetry.length > 0) {
        await withTimeout(Promise.allSettled(pendingTelemetry), 1000);
      }
    }
  } catch {
    console.log(JSON.stringify({}));
  }
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
