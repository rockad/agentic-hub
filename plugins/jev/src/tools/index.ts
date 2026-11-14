import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { routeToolDefinition, routeInputSchema, handleRouteTool } from './route.js';
import { judgeToolDefinition, judgeInputSchema, handleJudgeTool } from './judge.js';
import { scoreToolDefinition, scoreInputSchema, handleScoreTool } from './score.js';
import {
  dispatchToolDefinition,
  batchDispatchToolDefinition,
  dispatchInputSchema,
  batchDispatchInputSchema,
  dispatchInputIssues,
  batchDispatchInputIssues,
  handleDispatchTool,
  handleBatchDispatchTool
} from './dispatch.js';
import {
  agentFreeToolDefinition,
  executeFreeToolDefinition,
  executeFreeGuardedToolDefinition,
  agentFreeInputSchema,
  executeFreeInputSchema,
  executeFreeGuardedInputSchema,
  handleAgentFreeTool,
  handleExecuteFreeTool,
  handleExecuteFreeGuardedTool
} from './execute-free.js';
import {
  setModeToolDefinition,
  getModeToolDefinition,
  setModeInputSchema,
  getModeInputSchema,
  handleSetModeTool,
  handleGetModeTool,
  getModeDetails,
  readCurrentMode,
  writeModeState,
  type ModeDetails
} from './mode.js';
import {
  quotaToolDefinition,
  selectModelToolDefinition,
  quotaInputSchema,
  selectModelInputSchema,
  handleQuotaTool,
  handleSelectModelTool
} from './quota.js';
import type { StrictInputSchema } from './schema.js';

export * from './route.js';
export * from './judge.js';
export * from './score.js';
export * from './dispatch.js';
export * from './execute-free.js';
export * from './mode.js';
export * from './quota.js';

export type ToolHandler = (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

export const allTools: Tool[] = [
  routeToolDefinition,
  judgeToolDefinition,
  scoreToolDefinition,
  dispatchToolDefinition,
  batchDispatchToolDefinition,
  agentFreeToolDefinition,
  executeFreeToolDefinition,
  executeFreeGuardedToolDefinition,
  setModeToolDefinition,
  getModeToolDefinition,
  quotaToolDefinition,
  selectModelToolDefinition
];

export const toolHandlers: Record<string, ToolHandler> = {
  jev_route: handleRouteTool,
  jev_judge: handleJudgeTool,
  jev_score: handleScoreTool,
  jev_dispatch: handleDispatchTool,
  jev_batch_dispatch: handleBatchDispatchTool,
  jev_agent_free: handleAgentFreeTool,
  jev_execute_free: handleExecuteFreeTool,
  jev_execute_free_guarded: handleExecuteFreeGuardedTool,
  jev_set_mode: handleSetModeTool,
  jev_get_mode: handleGetModeTool,
  jev_quota: handleQuotaTool,
  jev_select_model: handleSelectModelTool
};

/**
 * The input schema of every tool, by name: strict zod objects, the same ones the advertised JSON schemas in
 * `allTools` are derived from. `validateToolInput` (validate.ts) refuses a call that does not match one before the
 * handler runs. A tool with no entry here cannot be called (tests/tool-contract.test.ts keeps the three tables,
 * `allTools`, `toolHandlers` and this one, in step).
 */
export const toolInputSchemas: Record<string, StrictInputSchema> = {
  jev_route: routeInputSchema,
  jev_judge: judgeInputSchema,
  jev_score: scoreInputSchema,
  jev_dispatch: dispatchInputSchema,
  jev_batch_dispatch: batchDispatchInputSchema,
  jev_agent_free: agentFreeInputSchema,
  jev_execute_free: executeFreeInputSchema,
  jev_execute_free_guarded: executeFreeGuardedInputSchema,
  jev_set_mode: setModeInputSchema,
  jev_get_mode: getModeInputSchema,
  jev_quota: quotaInputSchema,
  jev_select_model: selectModelInputSchema
} as Record<string, StrictInputSchema>;

/**
 * Checks on meaning that a schema cannot express, run after the schema passes. Each returns one line per problem.
 * Only the dispatch tools have them.
 */
export const toolInputChecks: Record<string, (input: any) => string[]> = {
  jev_dispatch: dispatchInputIssues,
  jev_batch_dispatch: batchDispatchInputIssues
};
