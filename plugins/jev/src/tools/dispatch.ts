import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  callJevDecision,
  callJevRouter,
  readQuotaView,
  clampTierToSessionCeiling,
  detectScaffoldingTask,
  isFreeTierMechanicalTask,
  editCapableSubagent,
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
  type SubTask,
  type BatchDispatchPlan
} from '../core/index.js';

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
  description: 'Decompose a multi-task roadmap or list of phases into a parallel DAG execution manifest with optimal tier assignments, dependency tracking, concurrency safety (max 10 for openrouter_free), and boilerplate pre-flight flags.',
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
          'CRITICAL QUOTA RULE: Free-tier eligible. Do NOT spawn a paid Agent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 subscription quota).'
      };
    }
    return {
      executionTool: 'Agent',
      executionGuidance:
        subagent === 'self'
          ? 'Handle it directly in the main session (no delegation).'
          : `Delegate via Agent(subagent_type: "${subagent}", model: "${concreteModel}").`
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
 * The session-model ceiling the clamp compares against. Antigravity's quota file names a Gemini
 * model, which says nothing about a Claude Code session, so in claude-code there is no ceiling
 * here (the Claude hook, which knows the session model, applies its own).
 */
export function ceilingModelForHarness(harness: JevHarness, quotaActiveModel: string | undefined): string | undefined {
  return harness === 'claude-code' ? undefined : quotaActiveModel;
}

/** Read-only personas (Plan, Explore) never own an editing task; Claude Code gets general-purpose. */
export function resolveEditCapableSubagent(harness: JevHarness, subagent: string, taskText: string): string {
  return editCapableSubagent(subagent, taskText, harness === 'claude-code' ? 'general-purpose' : 'self');
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

  const tierCriteria: Record<string, string> = {
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
      await logTelemetry({ tool: 'jev_dispatch', status: 'error', error: String(fallbackErr), latencyMs });
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
  const harness = detectActiveHarness();
  recommendedSubagent = resolveEditCapableSubagent(harness, recommendedSubagent, task);
  const rawEffort = defaultEffortForSubagent(recommendedSubagent, task);
  const recommendedEffort = applyEffortGovernance(rawEffort, quotaView.strategy, recommendedTier);

  // Phase 5: Session Model Ceiling Clamping
  const ceilingClamping = clampTierToSessionCeiling(
    recommendedTier,
    ceilingModelForHarness(harness, quotaView.active_model),
    task
  );
  const effectiveTier = ceilingClamping.clampedTier;
  const cognitiveTier = normalizeTier(effectiveTier);
  const harnessModels = getHarnessModels();
  const concreteModel = harnessModels[cognitiveTier] || effectiveTier;
  const isPro = effectiveTier === 'pro' || cognitiveTier === 'deep';

  const isFree = cognitiveTier === 'free' || effectiveTier === 'openrouter_free';
  const { executionTool, executionGuidance } = buildExecutionGuidance(harness, isFree, recommendedSubagent, concreteModel, true);

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
    task: task.slice(0, 100),
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
    tasks: Array<{ id: string; task: string; dependencies?: string[] }>;
    availableSubagents?: string[];
  };

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('jev_batch_dispatch requires a non-empty "tasks" array');
  }

  const quotaView = await readQuotaView();
  const activeHarness = detectActiveHarness();
  const cfg = loadJevConfigSync();
  const routingStrategy = cfg.routing?.strategy || 'router';

  let workspaceAgents: Record<string, string> = {};
  if (Array.isArray(availableSubagents) && availableSubagents.length > 0) {
    const discovered = await discoverWorkspaceAgents(process.cwd(), activeHarness);
    for (const sa of availableSubagents) {
      workspaceAgents[sa] = discovered[sa] || `Agent specialized in ${sa.replace(/[-_]/g, ' ')}`;
    }
  } else {
    workspaceAgents = await discoverWorkspaceAgents(process.cwd(), activeHarness);
  }

  if (
    Object.keys(workspaceAgents).length === 0 ||
    (Object.keys(workspaceAgents).length <= 2 && workspaceAgents.self && workspaceAgents.none)
  ) {
    workspaceAgents.self = 'Generalist tasks, direct code changes, orchestrator execution';
  }

  // Pre-route subagents via Decisions API in 'router' mode, or keyword fallback
  const subagentAssignments: Record<string, string> = {};
  if (routingStrategy === 'router') {
    try {
      const questions: Record<string, any> = {};
      for (const item of tasks) {
        questions[`sa_${item.id}`] = {
          type: 'choice',
          instructions: `Select the best specialized subagent for the task: ${item.task}`,
          criteria: workspaceAgents
        };
      }
      const data = await callJevDecision(`Batch routing for ${tasks.length} tasks`, questions);
      for (const item of tasks) {
        const choice = data.answers?.[`sa_${item.id}`]?.choice;
        if (choice && choice !== 'none' && workspaceAgents[choice]) {
          subagentAssignments[item.id] = choice;
        } else {
          subagentAssignments[item.id] = matchSubagentByKeywords(item.task || '', workspaceAgents);
        }
      }
    } catch {
      // Fall back to keyword scoring on network / timeout error
      for (const item of tasks) {
        subagentAssignments[item.id] = matchSubagentByKeywords(item.task || '', workspaceAgents);
      }
    }
  } else {
    for (const item of tasks) {
      subagentAssignments[item.id] = matchSubagentByKeywords(item.task || '', workspaceAgents);
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

    const subagent = resolveEditCapableSubagent(activeHarness, subagentAssignments[item.id] || 'self', taskText);

    const rawTier = classifyBatchTier(taskText);

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
    const { executionTool, executionGuidance } = buildExecutionGuidance(activeHarness, isTaskFree, subagent, concreteModel);

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
      estimatedCostUsd: taskCost
    });
  }

  const concurrencyCap = Math.min(10, Math.max(1, freeTierCount));
  const stages = topologicalSortStages(plannedTasks);

  const manifest: BatchDispatchPlan = {
    planName: 'Multi-Subagent Parallel DAG Execution Manifest',
    totalTasks: plannedTasks.length,
    freeTierTasks: freeTierCount,
    activeSessionModel: ceilingModelForHarness(activeHarness, quotaView.active_model) || 'unknown',
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
