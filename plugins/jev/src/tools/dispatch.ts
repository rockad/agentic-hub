import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  callJevDecision,
  callJevRouter,
  readQuotaView,
  clampTierToSessionCeiling,
  detectScaffoldingTask,
  isFreeTierMechanicalTask,
  isReadOnlySubagent,
  taskNeedsEdit,
  editCapableSubagent,
  activeClaudeSessionModel,
  claudeModelTier,
  sessionBelowOpus,
  type JevHarness,
  topologicalSortStages,
  estimateTierCost,
  defaultEffortForSubagent,
  applyEffortGovernance,
  discoverWorkspaceAgents,
  detectActiveHarness,
  loadJevConfigSync,
  normalizeTier,
  getHarnessModels,
  type CognitiveTier,
  JEV_MODEL,
  FALLBACK_MODEL,
  JEV_INPUT_COST_PER_MILLION,
  FALLBACK_INPUT_COST_PER_MILLION,
  logTelemetry,
  taskFingerprint,
  type SubTask,
  type BatchDispatchPlan
} from '../core/index.js';
import { STAGE_RUBRIC, TIER_CRITERIA, isStageKind } from '../stage-rubric.js';
import { CLAUDE_SUBAGENT_CRITERIA, resolveClaudeSubagentCriteria } from '../../claude/logic.js';

export const dispatchToolDefinition: Tool = {
  name: 'jev_dispatch',
  description: 'Intelligently route a task to the optimal subagent and model tier ("openrouter_free" | "flash_lite" | "flash" | "pro") in a single ~800ms decision call using TypeSafe Jev. "pro" tier models require explicit manual user approval before invocation.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task, prompt, or sub-goal to dispatch' },
      availableSubagents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional candidate subagents (defaults to dynamically discovered workspace agents)'
      }
    },
    required: ['task']
  }
};

export const batchDispatchToolDefinition: Tool = {
  name: 'jev_batch_dispatch',
  description: 'Decompose a multi-task roadmap or list of phases into a parallel DAG execution manifest with optimal tier assignments, dependency tracking, concurrency safety (max 10 for openrouter_free), and boilerplate pre-flight flags. On Claude Code, classify each task with kind (mechanical, settled-edit, judgement) and needsEdit to get the model per stage (haiku, sonnet, opus), Agent() guidance and no read-only persona or free tier for an edit stage.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'Array of task descriptions or phase items to plan and dispatch in parallel',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the task/phase' },
            task: { type: 'string', description: 'The description of the work' },
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional array of task IDs that must complete before this task can start'
            },
            kind: {
              type: 'string',
              enum: ['mechanical', 'settled-edit', 'judgement'],
              description:
                "Optional, Claude Code only: the caller's own classification of the stage, used instead of guessing. mechanical (edit or checklist update) gives haiku, settled-edit (spec or plan edit with a decision already made) gives sonnet, judgement (an error is expensive) gives opus"
            },
            needsEdit: {
              type: 'boolean',
              description:
                'Optional, Claude Code only: the stage edits files, so read-only subagent types (Plan, Explore) are never assigned and the free tier (text only) is not used. When omitted the task wording decides; false overrides the wording'
            }
          },
          required: ['id', 'task']
        }
      },
      availableSubagents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of candidate subagents'
      }
    },
    required: ['tasks']
  }
};

/**
 * Batch tier rule: a keyword rule on whole words (see isFreeTierMechanicalTask).
 * Free tier for scaffolding, boilerplate and formatting work; pro only on explicit phrases.
 */
export function classifyBatchTier(taskText: string): 'openrouter_free' | 'flash' | 'pro' {
  const tLower = (taskText || '').toLowerCase();
  if (isFreeTierMechanicalTask(taskText)) return 'openrouter_free';
  if (tLower.includes('deep reasoning') || tLower.includes('architecture overhaul')) return 'pro';
  return 'flash';
}

/**
 * Execution tool and guidance text per harness. Claude Code gets Agent(...) wording and its own
 * model names; every other harness keeps the Antigravity wording it had before.
 */
export function buildExecutionGuidance(
  harness: JevHarness,
  isFree: boolean,
  subagent: string,
  concreteModel: string,
  single = false
): { executionTool: 'jev_execute_free' | 'invoke_subagent' | 'Agent'; executionGuidance: string } {
  if (harness === 'claude-code') {
    if (isFree) {
      return {
        executionTool: 'jev_execute_free',
        executionGuidance:
          'CRITICAL QUOTA RULE: Free-tier eligible. Do NOT spawn a paid Agent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 subscription quota); it returns text and cannot edit files.'
      };
    }
    // `self` is not a Claude Code subagent type: the closest real one is general-purpose.
    const type = subagent === 'self' ? 'general-purpose' : subagent;
    const call = `Agent(subagent_type: "${type}", model: "${concreteModel}") or, inside a Workflow, agent({ agentType: "${type}", model: "${concreteModel}" })`;
    return {
      executionTool: 'Agent',
      executionGuidance:
        subagent === 'self'
          ? `Handle it directly in the main session (no delegation). To delegate it instead, use ${call}.`
          : `Delegate via ${call}.`
    };
  }
  if (isFree) {
    return {
      executionTool: 'jev_execute_free',
      executionGuidance:
        `CRITICAL QUOTA RULE: ${single ? 'Jev evaluated this task as free-tier eligible' : 'Free-tier eligible'}. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).`
    };
  }
  return {
    executionTool: 'invoke_subagent',
    executionGuidance: `Delegate to subagent via invoke_subagent(Role: "${subagent}", Model: "${concreteModel}").`
  };
}

/**
 * Extra guidance on Claude Code when the tier is opus and the session is below it: the PreToolUse guard asks
 * the user before the call runs (the tool reports the escalation and never lowers the tier). Empty elsewhere.
 */
export function escalationNote(harness: JevHarness, isPro: boolean, sessionModel: string | null): string {
  if (harness !== 'claude-code' || !isPro || !sessionBelowOpus(sessionModel)) return '';
  // An unknown session model fails the guard open (nothing to compare against), so the promise to ask would be untrue.
  if (claudeModelTier(sessionModel) === null) {
    return ' Opus may be above the session model, but the session model is unknown, so the Jev guard may not ask the user before it runs.';
  }
  return ` Opus is above the session model (${sessionModel}): the Jev guard will ask the user once per call before it runs.`;
}

/** The router's description of the free tier on Claude Code: no Gemini quota, and text only. */
const CLAUDE_FREE_TIER_CRITERIA =
  'Lightweight summaries, drafts, syntax transformations, autonomous free agent tasks via jev_agent_free, and boilerplate ($0 cost, no Claude quota; text only, it cannot edit files)';

/**
 * Whether a stage edits files: the caller's `needsEdit` when given (false overrides the wording), else the
 * wording (taskNeedsEdit, a narrow verb list). One test for the persona and for the free-tier guard.
 */
export function editsFiles(item: { needsEdit?: unknown; task?: string }): boolean {
  return typeof item.needsEdit === 'boolean' ? item.needsEdit : taskNeedsEdit(item.task || '');
}

/** The free tier returns text and cannot edit files: a stage that edits goes one tier up instead. */
export function keepEditsOffFreeTier(tier: string, edits: boolean): string {
  return edits && tier === 'openrouter_free' ? 'flash_lite' : tier;
}

/**
 * The session-model ceiling the clamp compares against. Antigravity's quota file names a Gemini
 * model, which says nothing about a Claude Code session, so in claude-code there is no ceiling
 * here (the Claude hook, which knows the session model, applies its own).
 */
export function ceilingModelForHarness(harness: JevHarness, quotaActiveModel: string | undefined): string | undefined {
  return harness === 'claude-code' ? undefined : quotaActiveModel;
}

/**
 * The `harness` field of a dispatch telemetry line. `logTelemetry` labels every line `antigravity` by
 * default; a dispatch call made from Claude Code says so, so the Claude hook's pre-flight check can
 * tell its own harness's dispatch calls from Antigravity's. Other harnesses keep the existing label.
 */
export function telemetryHarness(): { harness?: 'claude-code' } {
  return detectActiveHarness() === 'claude-code' ? { harness: 'claude-code' } : {};
}

/**
 * On Claude Code a read-only persona (Plan, Explore) never owns an editing task: it gets general-purpose.
 * Outside Claude Code (Antigravity, OpenCode, the CLI) the persona stays as the router chose it.
 */
export function resolveEditCapableSubagent(harness: JevHarness, subagent: string, taskText: string): string {
  if (harness !== 'claude-code') return subagent;
  return editCapableSubagent(subagent, taskText, 'general-purpose');
}

export async function handleDispatchTool(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const start = performance.now();
  const { task, availableSubagents } = (args || {}) as {
    task: string;
    availableSubagents?: string[];
  };

  if (!task) {
    throw new Error('jev_dispatch requires a non-empty "task" string');
  }

  let subagentCriteria: Record<string, string> = {};
  if (Array.isArray(availableSubagents) && availableSubagents.length > 0) {
    const discovered = await discoverWorkspaceAgents(process.cwd(), detectActiveHarness());
    for (const sa of availableSubagents) {
      subagentCriteria[sa] = discovered[sa] || `Agent specialized in ${sa.replace(/[-_]/g, ' ')}`;
    }
  } else {
    subagentCriteria = await discoverWorkspaceAgents(process.cwd(), detectActiveHarness());
  }

  if (
    Object.keys(subagentCriteria).length === 0 ||
    (Object.keys(subagentCriteria).length <= 2 && subagentCriteria.self && subagentCriteria.none)
  ) {
    subagentCriteria.self = 'Generalist tasks, direct code changes, orchestrator execution';
  }

  const harness = detectActiveHarness();
  const isClaude = harness === 'claude-code';
  // On Claude Code the router sees the stage rubric and a free tier described without Gemini (5.3, 5.11).
  const tierCriteria: Record<string, string> = isClaude
    ? { ...TIER_CRITERIA, openrouter_free: CLAUDE_FREE_TIER_CRITERIA }
    : {
        openrouter_free: 'Lightweight summaries, drafts, syntax transformations, autonomous free agent tasks via jev_agent_free, and boilerplate ($0 cost, 0 Gemini quota)',
        flash_lite: 'Trivial triage, fast simple lookups, file moves, quick formatting',
        flash: 'Standard agentic steps, routine edits, content synthesis, local commands',
        pro: 'Deep reasoning, architectural planning, complex multi-file refactoring, high-stakes writing'
      };

  let recommendedSubagent = 'self';
  let recommendedTier = 'flash';
  let confidence = 0.95;
  let subagentProbabilities: Record<string, number> = {};
  let tierProbabilities: Record<string, number> = {};
  let modelUsed = JEV_MODEL;
  let fallbackUsed = false;
  let promptTokens = 0;
  let costUsd = 0;

  // Tier 1: Single decision call with both questions
  try {
    const data = await callJevDecision(`Task: ${task}`, {
      recommendedSubagent: {
        type: 'choice',
        instructions: 'Select the best specialized subagent for this task',
        criteria: subagentCriteria
      },
      recommendedTier: {
        type: 'choice',
        instructions: 'Determine the required model tier based on cognitive load and task complexity',
        criteria: tierCriteria
      }
    });

    const saAnswer = data.answers?.recommendedSubagent;
    const tierAnswer = data.answers?.recommendedTier;

    recommendedSubagent = saAnswer?.choice || 'self';
    recommendedTier = tierAnswer?.choice || 'flash';
    subagentProbabilities = saAnswer?.probabilities || {};
    tierProbabilities = tierAnswer?.probabilities || {};
    confidence = Math.min(saAnswer?.confidence ?? 0.95, tierAnswer?.confidence ?? 0.95);

    promptTokens = data.usage?.input_tokens ?? 0;
    costUsd = typeof data.usage?.cost === 'number'
      ? data.usage.cost
      : (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
    modelUsed = data.model || JEV_MODEL;
  } catch (primaryErr: any) {
    console.error(`[jev warn] Tier 1 dispatch failed: ${primaryErr.message}. Triggering Tier 2 (${FALLBACK_MODEL})...`);

    // Tier 2: Fallback Model
    try {
      const fallbackData = await callJevRouter(`Task: ${task}`, {
        recommendedSubagent: {
          type: 'choice',
          instructions: 'Select the best specialized subagent for this task',
          criteria: subagentCriteria
        },
        recommendedTier: {
          type: 'choice',
          instructions: 'Determine the required model tier based on cognitive load and task complexity',
          criteria: tierCriteria
        }
      });

      fallbackUsed = true;
      modelUsed = fallbackData.model || FALLBACK_MODEL;
      promptTokens = fallbackData.usage?.prompt_tokens ?? fallbackData.usage?.input_tokens ?? 0;
      costUsd = (promptTokens / 1_000_000) * FALLBACK_INPUT_COST_PER_MILLION;

      const saAnswer = fallbackData.answers?.recommendedSubagent;
      const tierAnswer = fallbackData.answers?.recommendedTier;

      recommendedSubagent = saAnswer?.choice || 'self';
      recommendedTier = tierAnswer?.choice || 'flash';
      subagentProbabilities = saAnswer?.probabilities || {};
      tierProbabilities = tierAnswer?.probabilities || {};
      confidence = Math.min(saAnswer?.confidence ?? 0.85, tierAnswer?.confidence ?? 0.85);
    } catch (fallbackErr: any) {
      const latencyMs = Math.round(performance.now() - start);
      await logTelemetry({ tool: 'jev_dispatch', ...telemetryHarness(), status: 'error', error: String(fallbackErr), latencyMs });
      throw new Error(
        `jev_dispatch: all dispatch tiers failed. Tier 1 (Jev Decisions API) and Tier 2 (${FALLBACK_MODEL}) both unavailable. ` +
        `Last error: ${fallbackErr.message}. Ensure OPENROUTER_API_KEY is set and valid in mcp_config.json.`
      );
    }
  }

  const latencyMs = Math.round(performance.now() - start);
  const telemetry = {
    modelUsed,
    fallbackUsed,
    latencyMs,
    promptTokens,
    costUsd: Number(costUsd.toFixed(8)),
    costFormatted: `$${costUsd.toFixed(6)}`
  };

  const quotaView = await readQuotaView();
  recommendedSubagent = resolveEditCapableSubagent(harness, recommendedSubagent, task);
  const rawEffort = defaultEffortForSubagent(recommendedSubagent, task);
  const recommendedEffort = applyEffortGovernance(rawEffort, quotaView.strategy, recommendedTier);

  // Phase 5: Session Model Ceiling Clamping. On Claude Code the ceiling is the Claude session's own model,
  // not Antigravity's quota file, and it is reported rather than clamped (5.11): the guard asks before an
  // escalation runs. An unknown session model reads as the top tier.
  const claudeModel = isClaude ? activeClaudeSessionModel() : null;
  const clamped = clampTierToSessionCeiling(recommendedTier, ceilingModelForHarness(harness, quotaView.active_model), task);
  const ceilingClamping = isClaude ? { ...clamped, ceilingTier: claudeModelTier(claudeModel) ?? 'pro' } : clamped;
  // The free tier returns text and cannot edit files: on Claude Code a task worded as an edit goes one tier up.
  const effectiveTier = isClaude ? keepEditsOffFreeTier(ceilingClamping.clampedTier, editsFiles({ task })) : ceilingClamping.clampedTier;
  const cognitiveTier = normalizeTier(effectiveTier);
  const harnessModels = getHarnessModels();
  const concreteModel = harnessModels[cognitiveTier] || effectiveTier;
  const isPro = effectiveTier === 'pro' || cognitiveTier === 'deep';

  const isFree = cognitiveTier === 'free' || effectiveTier === 'openrouter_free';
  const guidance = buildExecutionGuidance(harness, isFree, recommendedSubagent, concreteModel, true);
  const executionTool = guidance.executionTool;
  const executionGuidance = isFree ? guidance.executionGuidance : guidance.executionGuidance + escalationNote(harness, isPro, claudeModel);

  const scaffoldingCheck = detectScaffoldingTask(task);
  const result = {
    recommendedSubagent,
    recommendedTier: effectiveTier,
    cognitiveTier,
    concreteModel,
    rawRecommendedTier: recommendedTier,
    executionTool,
    executionGuidance,
    sessionCeilingTier: ceilingClamping.ceilingTier,
    wasClampedByCeiling: ceilingClamping.wasClamped,
    ...(isClaude ? { activeSessionModel: claudeModel ?? 'unknown' } : {}),
    scaffoldFirst: scaffoldingCheck.scaffoldFirst,
    boilerplateType: scaffoldingCheck.boilerplateType,
    recommendedEffort,
    requiresUserApproval: isPro,
    ...(isPro
      ? {
          approvalReason:
            'Pro tier model recommended for deep reasoning. Explicit manual user approval required before proceeding.'
        }
      : {}),
    delegationRecommended: recommendedSubagent !== 'none',
    confidence,
    subagentProbabilities,
    tierProbabilities,
    telemetry
  };

  await logTelemetry({
    tool: 'jev_dispatch',
    ...telemetryHarness(),
    // Metadata only: the prompt text never reaches the telemetry file.
    ...taskFingerprint(task),
    ...result
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

export function matchSubagentByKeywords(
  taskText: string,
  workspaceAgents: Record<string, string>
): string {
  const tLower = taskText.toLowerCase();
  const taskTokens = tLower.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const taskTokenSet = new Set(taskTokens);

  let bestAgent = 'self';
  let bestScore = 0;

  for (const [agentKey, desc] of Object.entries(workspaceAgents)) {
    if (agentKey === 'none') continue;
    let score = 0;

    // Check direct normalized key match (hyphens, underscores, spaces)
    const keyNorm = agentKey.toLowerCase().replace(/[-_]+/g, ' ');
    if (tLower.includes(keyNorm)) {
      score += 10;
    }

    // Split agentKey into tokens
    const keyTokens = agentKey.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
    for (const kt of keyTokens) {
      if (taskTokenSet.has(kt)) {
        score += 4;
      }
    }

    // Description tokens match
    const descTokens = (desc || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 3);
    for (const dt of descTokens) {
      if (taskTokenSet.has(dt)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestAgent = agentKey;
    }
  }

  return bestScore > 0 ? bestAgent : 'self';
}

export async function handleBatchDispatchTool(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const start = performance.now();
  const { tasks, availableSubagents } = (args || {}) as {
    tasks: Array<{ id: string; task: string; dependencies?: string[]; kind?: string; needsEdit?: boolean }>;
    availableSubagents?: string[];
  };

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('jev_batch_dispatch requires a non-empty "tasks" array');
  }

  const quotaView = await readQuotaView();
  const activeHarness = detectActiveHarness();
  const isClaude = activeHarness === 'claude-code';
  const claudeModel = isClaude ? activeClaudeSessionModel() : null;
  const cfg = loadJevConfigSync();
  const routingStrategy = cfg.routing?.strategy || 'router';

  let workspaceAgents: Record<string, string> = {};
  if (Array.isArray(availableSubagents) && availableSubagents.length > 0) {
    const discovered = await discoverWorkspaceAgents(process.cwd(), activeHarness);
    for (const sa of availableSubagents) {
      workspaceAgents[sa] = discovered[sa] || `Agent specialized in ${sa.replace(/[-_]/g, ' ')}`;
    }
  } else if (isClaude) {
    // The real Claude Code subagent types: built-ins plus custom agents by their kebab-case name.
    workspaceAgents = await resolveClaudeSubagentCriteria(process.cwd());
  } else {
    workspaceAgents = await discoverWorkspaceAgents(process.cwd(), activeHarness);
  }

  if (
    Object.keys(workspaceAgents).length === 0 ||
    (Object.keys(workspaceAgents).length <= 2 && workspaceAgents.self && workspaceAgents.none)
  ) {
    workspaceAgents.self = 'Generalist tasks, direct code changes, orchestrator execution';
  }

  // Candidate subagents for a task. On Claude Code a stage that edits files never gets a read-only type
  // (Plan, Explore); the caller's `needsEdit` wins when given, otherwise the wording decides (editsFiles).
  const candidatesFor = (item: { needsEdit?: unknown; task?: string }): Record<string, string> => {
    if (!isClaude || !editsFiles(item)) return workspaceAgents;
    const editable = Object.fromEntries(Object.entries(workspaceAgents).filter(([name]) => !isReadOnlySubagent(name)));
    return Object.keys(editable).length > 0 ? editable : { 'general-purpose': CLAUDE_SUBAGENT_CRITERIA['general-purpose'] };
  };
  // Keyword pick among the candidates. When the candidates were narrowed to editing-capable types and none
  // scores, `self` is not one of them: take the first candidate (general-purpose) instead.
  const byKeywords = (item: { task?: string }, candidates: Record<string, string>): string => {
    const pick = matchSubagentByKeywords(item.task || '', candidates);
    return isClaude && candidates !== workspaceAgents && !(pick in candidates) ? Object.keys(candidates)[0] : pick;
  };
  // On Claude Code the tier of a stage with no `kind` is asked of the router, with the stage rubric as criteria.
  const routerTiers: Record<string, string> = {};

  // Pre-route subagents via Decisions API in 'router' mode, or keyword fallback
  const subagentAssignments: Record<string, string> = {};
  if (routingStrategy === 'router') {
    try {
      const questions: Record<string, any> = {};
      for (const item of tasks) {
        questions[`sa_${item.id}`] = {
          type: 'choice',
          instructions: `Select the best specialized subagent for the task: ${item.task}`,
          criteria: candidatesFor(item)
        };
        if (isClaude && !isStageKind(item.kind)) {
          questions[`tier_${item.id}`] = {
            type: 'choice',
            instructions: `Determine the cheapest Claude model tier that fits this stage, using the rubric in the criteria: ${item.task}`,
            criteria: { ...TIER_CRITERIA, openrouter_free: CLAUDE_FREE_TIER_CRITERIA }
          };
        }
      }
      const data = await callJevDecision(`Batch routing for ${tasks.length} tasks`, questions);
      for (const item of tasks) {
        const candidates = candidatesFor(item);
        const choice = data.answers?.[`sa_${item.id}`]?.choice;
        if (choice && choice !== 'none' && candidates[choice]) {
          subagentAssignments[item.id] = choice;
        } else {
          subagentAssignments[item.id] = byKeywords(item, candidates);
        }
        const tierChoice = data.answers?.[`tier_${item.id}`]?.choice;
        if (typeof tierChoice === 'string' && Object.hasOwn(TIER_CRITERIA, tierChoice)) routerTiers[item.id] = tierChoice;
      }
    } catch {
      // Fall back to keyword scoring on network / timeout error
      for (const item of tasks) {
        subagentAssignments[item.id] = byKeywords(item, candidatesFor(item));
      }
    }
  } else {
    for (const item of tasks) {
      subagentAssignments[item.id] = byKeywords(item, candidatesFor(item));
    }
  }

  const plannedTasks: SubTask[] = [];
  let freeTierCount = 0;
  let totalEstimatedCost = 0;
  let anyProRequested = false;

  for (const item of tasks) {
    const taskText = item.task || '';
    const deps = Array.isArray(item.dependencies) ? item.dependencies : [];
    const scaffolding = detectScaffoldingTask(taskText);

    const kind = isStageKind(item.kind) ? item.kind : undefined;
    let subagent = subagentAssignments[item.id] || 'self';
    let rawTier: string;
    let tierSource: SubTask['tierSource'];
    if (isClaude) {
      // A read-only type cannot carry out an edit stage, whatever routed it there.
      if (editsFiles(item) && isReadOnlySubagent(subagent)) subagent = 'general-purpose';
      // The caller's classification first, then the router's answer under the stage rubric, then whole words.
      if (kind) {
        rawTier = STAGE_RUBRIC[kind].tier;
        tierSource = 'kind';
      } else if (routerTiers[item.id]) {
        rawTier = routerTiers[item.id];
        tierSource = 'router';
      } else {
        rawTier = classifyBatchTier(taskText);
        tierSource = 'keyword';
      }
      // The free tier returns text and cannot edit files: the same test as the persona (editsFiles) decides.
      rawTier = keepEditsOffFreeTier(rawTier, editsFiles(item));
    } else {
      subagent = resolveEditCapableSubagent(activeHarness, subagent, taskText);
      rawTier = classifyBatchTier(taskText);
    }

    const ceilingModel = ceilingModelForHarness(activeHarness, quotaView.active_model);
    const clamped = clampTierToSessionCeiling(rawTier, ceilingModel, taskText);
    const tier = clamped.clampedTier;
    const cognitiveTier = normalizeTier(tier);
    const harnessModels = getHarnessModels();
    const concreteModel = harnessModels[cognitiveTier] || tier;

    if (tier === 'openrouter_free' || cognitiveTier === 'free') {
      freeTierCount++;
    }

    const taskCost = estimateTierCost(tier);
    totalEstimatedCost += taskCost;

    const requiresApproval = (tier === 'pro' || cognitiveTier === 'deep');
    if (requiresApproval) {
      anyProRequested = true;
    }

    const isTaskFree = tier === 'openrouter_free' || cognitiveTier === 'free';
    const guidance = buildExecutionGuidance(activeHarness, isTaskFree, subagent, concreteModel);
    const executionTool = guidance.executionTool;
    const executionGuidance = isTaskFree ? guidance.executionGuidance : guidance.executionGuidance + escalationNote(activeHarness, requiresApproval, claudeModel);

    const rawEffort = defaultEffortForSubagent(subagent, taskText);
    const taskEffort = applyEffortGovernance(rawEffort, quotaView.strategy, tier);

    plannedTasks.push({
      taskId: item.id,
      task: taskText,
      subagent,
      tier,
      cognitiveTier,
      concreteModel,
      executionTool,
      executionGuidance,
      dependencies: deps,
      canRunParallel: deps.length === 0,
      scaffoldFirst: scaffolding.scaffoldFirst,
      boilerplateType: scaffolding.boilerplateType,
      effort: taskEffort,
      requiresUserApproval: requiresApproval,
      estimatedCostUsd: taskCost,
      // Claude Code only: the caller's own fields echoed when given, and what set the tier.
      ...(isClaude ? { ...(kind ? { kind } : {}), ...(typeof item.needsEdit === 'boolean' ? { needsEdit: item.needsEdit } : {}), tierSource } : {})
    });
  }

  // The free-tier cap comes from config (`tiers.free.concurrencyCap`); 10 stays the default (OpenRouter's 20 RPM).
  const configuredCap = cfg.tiers?.free?.concurrencyCap;
  const freeCap = typeof configuredCap === 'number' && configuredCap > 0 ? Math.floor(configuredCap) : 10;
  const concurrencyCap = Math.min(freeCap, Math.max(1, freeTierCount));
  const stages = topologicalSortStages(plannedTasks);

  const manifest: BatchDispatchPlan = {
    planName: 'Multi-Subagent Parallel DAG Execution Manifest',
    totalTasks: plannedTasks.length,
    freeTierTasks: freeTierCount,
    activeSessionModel: (isClaude ? claudeModel : ceilingModelForHarness(activeHarness, quotaView.active_model)) || 'unknown',
    maxConcurrentFreeWorkers: concurrencyCap,
    tasks: plannedTasks,
    stages,
    parallelExecutionOrder: stages.map(stage => stage.map(t => t.taskId)),
    estimatedCostUsd: Number(totalEstimatedCost.toFixed(6)),
    requiresUserApproval: anyProRequested
  };

  const latencyMs = Math.round(performance.now() - start);
  await logTelemetry({
    tool: 'jev_batch_dispatch',
    ...telemetryHarness(),
    taskCount: plannedTasks.length,
    estimatedCostUsd: manifest.estimatedCostUsd,
    requiresUserApproval: anyProRequested,
    latencyMs
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(manifest, null, 2)
    }]
  };
}
