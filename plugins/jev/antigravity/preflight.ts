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
  type QuotaView
} from '../src/shared.js';

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

function withTimeout<T>(
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

function cleanUserInput(raw: string): string {
  if (!raw) return '';
  let text = raw;
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<\/?USER_REQUEST>/gi, '');
  return text.trim();
}

export function autoHealAgyMcp(mode: string): void {
  try {
    const candidatePaths = [
      path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json')
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
    try {
      execSync('which agy 2>/dev/null || command -v agy 2>/dev/null', { stdio: 'ignore' });
    } catch {
      return;
    }

    const raw = JSON.parse(fsSync.readFileSync(mcpConfigPath, 'utf8'));
    const jevServer = raw?.mcpServers?.jev;
    const isDisabled = jevServer ? jevServer.disabled === true : true;
    const shouldBeDisabled = mode === 'off';
    if (isDisabled !== shouldBeDisabled) {
      execFileSync('agy', ['mcp', shouldBeDisabled ? 'disable' : 'enable', 'jev'], { timeout: 1500, stdio: 'ignore' });
    }
  } catch {
    // fail-open
  }
}

export async function runPreflight(inputJson?: string): Promise<void> {
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
    const modelName = hookInput?.modelName || null;
    const cleanTask = cleanUserInput(rawUserInput);

    // 1. Mode resolution: readJevMode('antigravity') only
    const mode = await readJevMode('antigravity');

    // 2. Auto-heal agy MCP
    autoHealAgyMcp(mode);

    // 3. Persist live modelName
    if (modelName && modelName.trim().length > 0 && conversationId) {
      writeAntigravitySessionModel(conversationId, modelName.trim());
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
    const poolLabel = routinePool.pool === '3p' ? `3p (${quota.active_model ?? 'non-Gemini'})` : 'Gemini';

    // When mode is off: emit quota emergency/conserve if applicable, else exit 0
    if (mode === 'off') {
      if (poolStrategy === 'free_only') {
        const msg = `[QUOTA EMERGENCY (Jev OFF): ${poolLabel} quota is critically low (<10% remaining: ${pct}%). Subagents are locked out. Use local CLI tools or run \`jev on\` to enable free-tier offloading via Jev.]`;
        console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: msg }] }));
        return;
      }
      if (poolStrategy === 'conserve') {
        const msg = `[QUOTA CONSERVE (Jev OFF): ${poolLabel} quota is at or below conserve threshold (${pct}% remaining). Clamp all subagents strictly to Model: "flash_lite" (Pro tier is strictly prohibited). Run \`jev on\` if you want to enable free-tier offloading via Jev.]`;
        console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: msg }] }));
        return;
      }
      console.log(JSON.stringify({}));
      return;
    }

    // Directives
    const parts: string[] = [];

    // Quota directive
    if (poolStrategy === 'free_only') {
      parts.push(`[QUOTA EMERGENCY: ${poolLabel} quota is critically low (<10% remaining: ${pct}%). Subagents are locked out. ALL generation, drafting, and boilerplate MUST be offloaded to free models via jev_execute_free or jev_agent_free.]`);
    } else if (poolStrategy === 'conserve') {
      const fivePct = routinePool.five_hour !== null && routinePool.five_hour !== undefined ? `${Math.round(routinePool.five_hour * 100)}%` : 'n/a';
      const weeklyPct = routinePool.weekly !== null && routinePool.weekly !== undefined ? `${Math.round(routinePool.weekly * 100)}%` : 'n/a';
      parts.push(`[QUOTA CONSERVE: ${poolLabel} quota is limited (${pct}% remaining, 5h: ${fivePct}, weekly: ${weeklyPct}). All subagents are throttled strictly to Model: "flash_lite" (Pro tier prohibited). Offload routine generation, boilerplate, formatting, and draft text to free models via jev_execute_free or jev_agent_free.]`);
    }

    // Argon-exhausted warning for Orchestrator
    if (isOrchestrator && quota.variant === 'argon') {
      const frontier = quota.pools?.frontier;
      const isArgonExhausted = frontier && (frontier.strategy === 'free_only' || frontier.min_remaining === 0);
      if (isArgonExhausted) {
        const resetAt = quota.buckets['gemini-argon-wtu-weekly']?.reset_at;
        const resetAtStr = typeof resetAt === 'number'
          ? new Date(resetAt * 1000).toISOString()
          : 'weekly reset';
        parts.push(`[ARGON EXHAUSTED WARNING: Orchestrator (Argon) frontier quota is exhausted (0% remaining until ${resetAtStr}). Orchestrator (Argon) will refuse turns. Switch model to Gemini 4 Hydrogen via /model (Antigravity will re-run the refused request automatically after /model).]`);
      }
    }

    // Mode directive
    if (mode === 'on') {
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
      const shouldDispatch =
        cleanTask.length >= 8 &&
        !isPlanReview &&
        !isJevCmd &&
        (invocationNum === 1 || invocationNum === undefined);

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
              callJev(
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

            const { taskLen, taskHash } = taskFingerprint(cleanTask);
            await logJevTelemetry({
              harness: 'antigravity',
              toolOrHook: 'PreInvocation',
              sessionId: conversationId ?? null,
              taskLen,
              taskHash,
              recommendedSubagent,
              recommendedTier,
              effort
            });

            const preflightLine = `[JEV PRE-FLIGHT] cost-tiered recommendation (quota=${poolStrategy}, model=${activeModel}): subagent="${recommendedSubagent}", tier="${recommendedTier}", effort="${effort}".`;
            modeDirective = `${preflightLine}\n\n${modeDirective}`;
          }
        } catch {
          // preflight dispatch is best-effort
        }
      }

      parts.push(modeDirective);
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
