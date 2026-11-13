import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HookDeps, HookInput } from '../claude/hook.ts';
import type { Dispatch } from '../claude/logic.ts';
import { memoryApprovals } from './elevation-helpers.ts';
import { restoreEnv, snapshotEnv } from './workflow-env.ts';

/** A workspace with a project dir, a hook deps object wired to in-memory stores, and an environment that is restored afterwards. */
export type Rig = {
  tmp: string;
  project: string;
  pins: string;
  d: HookDeps;
  logs: Array<Record<string, unknown>>;
  turns: Map<string, any>;
  approvals: ReturnType<typeof memoryApprovals>;
  mode: { value: string };
  cleanup: () => void;
};

const flash: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };

export function rig(overrides: Partial<HookDeps> = {}, session = 'claude-sonnet-5-5'): Rig {
  const saved = snapshotEnv();
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL']) delete process.env[v];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-wfh-')));
  process.env.HOME = tmp;
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const pins = path.join(tmp, 'pins');
  const logs: Array<Record<string, unknown>> = [];
  const turns = new Map<string, any>();
  const approvals = memoryApprovals();
  const mode = { value: 'on' };
  const d: HookDeps = {
    readMode: async () => mode.value as 'on',
    readSessionModel: () => session,
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flash,
    log: (e) => logs.push(e),
    readTurn: (s) => turns.get(s ?? '') ?? null,
    saveTurn: (s, st) => void turns.set(s ?? '', st),
    approvals,
    now: () => 1_800_000_000_000,
    env: {},
    workflowPinDir: pins,
    ...overrides
  };
  return {
    tmp,
    project,
    pins,
    d,
    logs,
    turns,
    approvals,
    mode,
    cleanup: () => {
      restoreEnv(saved);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** A Workflow PreToolUse input; `toolUseId` null leaves the id out. */
export function wf(toolInput: unknown, r: Rig, extra: Partial<HookInput> = {}, toolUseId: string | null = 'toolu_01ABC'): HookInput {
  return {
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Workflow',
    cwd: r.project,
    tool_input: toolInput as any,
    ...(toolUseId !== null ? { tool_use_id: toolUseId } : {}),
    ...extra
  };
}

export const out = (o: { hookSpecificOutput: Record<string, unknown> } | null): Record<string, any> => (o?.hookSpecificOutput ?? {}) as Record<string, any>;
