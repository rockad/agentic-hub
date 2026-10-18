import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  callJevDecision,
  callJevRouter,
  readQuotaView,
  clampTierToSessionCeiling,
  detectScaffoldingTask,
  topologicalSortStages,
  estimateTierCost,
  defaultEffortForSubagent,
  applyEffortGovernance,
  discoverWorkspaceAgents,
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

export async function handleDispatchTool(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const start = performance.now();
  const { task, availableSubagents } = (args || {}) as {
    task: string;
    availableSubagents?: string[];
  };

  if (!task) {
    throw new Error('jev_dispatch requires a non-empty "task" string');
  }

  const defaultSubagentCriteria: Record<string, string> = {
    code_engineer: 'Software engineering, writing/refactoring code, automation scripts, tests, MCP servers',
    research: 'Broad web exploration, documentation gathering, deep analysis',
    general_assistant: 'General multi-domain coordination, task execution, planning',
    review: 'Quality gate review, code/diff verification, sanity checking',
    self: 'Direct clone of parent execution or current session',
    none: 'Direct answer without subagent delegation'
  };

  let subagentCriteria: Record<string, string> = {};
  if (Array.isArray(availableSubagents) && availableSubagents.length > 0) {
    for (const sa of availableSubagents) {
      subagentCriteria[sa] = defaultSubagentCriteria[sa] || sa;
    }
  } else {
    subagentCriteria = await discoverWorkspaceAgents();
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
  const rawEffort = defaultEffortForSubagent(recommendedSubagent, task);
  const recommendedEffort = applyEffortGovernance(rawEffort, quotaView.strategy, recommendedTier);

  // Phase 5: Session Model Ceiling Clamping
  const ceilingClamping = clampTierToSessionCeiling(recommendedTier, quotaView.active_model, task);
  const effectiveTier = ceilingClamping.clampedTier;
  const isPro = effectiveTier === 'pro';

  const isFree = effectiveTier === 'openrouter_free';
  const executionTool = isFree ? 'jev_execute_free' : 'invoke_subagent';
  const executionGuidance = isFree
    ? 'CRITICAL QUOTA RULE: Jev evaluated this task as free-tier eligible. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).'
    : `Delegate to subagent via invoke_subagent(Role: "${recommendedSubagent}", Model: "${effectiveTier}").`;

  const scaffoldingCheck = detectScaffoldingTask(task);
  const result = {
    recommendedSubagent,
    recommendedTier: effectiveTier,
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
  const workspaceAgents = await discoverWorkspaceAgents();
  const availableKeys = Object.keys(workspaceAgents);
  const plannedTasks: SubTask[] = [];
  let freeTierCount = 0;
  let totalEstimatedCost = 0;
  let anyProRequested = false;

  for (const item of tasks) {
    const taskText = item.task || '';
    const deps = Array.isArray(item.dependencies) ? item.dependencies : [];
    const scaffolding = detectScaffoldingTask(taskText);

    let subagent = availableKeys.includes('code_engineer') ? 'code_engineer' : 'self';
    const tLower = taskText.toLowerCase();
    if (tLower.includes('career') || tLower.includes('job') || tLower.includes('cv') || tLower.includes('resume')) {
      subagent = availableKeys.includes('career_advisor') ? 'career_advisor' : subagent;
    } else if (tLower.includes('vault') || tLower.includes('obsidian') || tLower.includes('note')) {
      subagent = availableKeys.includes('vault_librarian') ? 'vault_librarian' : subagent;
    } else if (tLower.includes('writing') || tLower.includes('cover letter') || tLower.includes('ghost') || tLower.includes('article')) {
      subagent = availableKeys.includes('ghostwriter') ? 'ghostwriter' : subagent;
    } else if (tLower.includes('qa') || tLower.includes('test') || tLower.includes('fuzz') || tLower.includes('suite')) {
      subagent = availableKeys.includes('qa_engineer') ? 'qa_engineer' : subagent;
    } else if (tLower.includes('inbox') || tLower.includes('triage') || tLower.includes('staging')) {
      subagent = availableKeys.includes('inbox_processor') ? 'inbox_processor' : subagent;
    } else if (tLower.includes('system') || tLower.includes('infra') || tLower.includes('daemon') || tLower.includes('docker') || tLower.includes('operator')) {
      subagent = availableKeys.includes('system_operator') ? 'system_operator' : subagent;
    } else if (tLower.includes('research') || tLower.includes('search') || tLower.includes('investigate')) {
      subagent = availableKeys.includes('knowledge_researcher') ? 'knowledge_researcher' : (availableKeys.includes('research') ? 'research' : subagent);
    } else if (tLower.includes('review') || tLower.includes('audit') || tLower.includes('gate')) {
      subagent = availableKeys.includes('review') ? 'review' : (availableKeys.includes('qa_engineer') ? 'qa_engineer' : subagent);
    }

    let rawTier = 'flash';
    if (tLower.includes('scaffold') || tLower.includes('format') || tLower.includes('boilerplate')) {
      rawTier = 'openrouter_free';
    } else if (tLower.includes('deep reasoning') || tLower.includes('architecture overhaul')) {
      rawTier = 'pro';
    }

    const clamped = clampTierToSessionCeiling(rawTier, quotaView.active_model, taskText);
    const tier = clamped.clampedTier;

    if (tier === 'openrouter_free') {
      freeTierCount++;
    }

    const taskCost = estimateTierCost(tier);
    totalEstimatedCost += taskCost;

    const requiresApproval = (tier === 'pro');
    if (requiresApproval) {
      anyProRequested = true;
    }

    const isTaskFree = tier === 'openrouter_free';
    const executionTool = isTaskFree ? 'jev_execute_free' : 'invoke_subagent';
    const executionGuidance = isTaskFree
      ? 'CRITICAL QUOTA RULE: Free-tier eligible. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).'
      : `Delegate to subagent via invoke_subagent(Role: "${subagent}", Model: "${tier}").`;

    const rawEffort = defaultEffortForSubagent(subagent, taskText);
    const taskEffort = applyEffortGovernance(rawEffort, quotaView.strategy, tier);

    plannedTasks.push({
      taskId: item.id,
      task: taskText,
      subagent,
      tier,
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
    activeSessionModel: quotaView.active_model || 'unknown',
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
