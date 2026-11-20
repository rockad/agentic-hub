/**
 * Content binding for the Claude Code Workflow guard (script TOCTOU). The pin store and the drift check are shared with
 * Antigravity's `run_workflow` guard and live in src/core/workflow-pin.ts (see there for the design and its limits);
 * this module is the Claude Code adapter: the `Workflow` PostToolUse input shape and the user-visible drift message.
 *
 * Claude-specific limit: what Claude Code runs on a `resumeFromRunId` (the file or a saved copy of the earlier run) is
 * not observable here.
 */
import { checkWorkflowDrift } from '../src/core/workflow-pin.js';

export { PIN_MAX_AGE_MS, pruneWorkflowPins, writeWorkflowPin, type WorkflowPin } from '../src/core/workflow-pin.js';

export interface PostToolUseResult {
  status: 'unchanged' | 'changed' | 'no-pin' | 'off' | 'ignored' | 'error';
  /** JSON for the hook's stdout; present only on drift while Jev is on. */
  output?: string;
}

export interface PinDeps {
  /** The pin directory. */
  dir: string;
  /** The Jev mode for Claude Code right now. */
  readMode: () => Promise<string> | string;
  /** The decisions log. */
  log: (entry: Record<string, unknown>) => void;
}

/**
 * PostToolUse for Workflow: re-hash every file the PreToolUse analysis read and compare. Consumes the pin. Never
 * throws. Silent (`no-pin`) when the guard did not run for this call. When Jev has been switched to on-demand since (`off`,
 * the pin dropped) there is no stdout, but drift is still logged. When it has been switched off, nothing is dropped
 * or logged (mode off writes nothing; the orphaned pin is pruned by the next call made while Jev is not off).
 */
export async function recordWorkflowPostToolUse(input: unknown, deps: PinDeps): Promise<PostToolUseResult> {
  try {
    const i = input as { tool_name?: unknown; tool_use_id?: unknown } | null;
    if (i?.tool_name !== 'Workflow') return { status: 'ignored' };
    const r = await checkWorkflowDrift(i.tool_use_id, 'Workflow', deps);
    if (r.status !== 'changed' || !r.pin || !r.drift) return { status: r.status };
    const lines = r.drift.map((d) => `- ${d.file}: analysed sha256:${d.analysed.slice(0, 16)}, now ${d.current ? `sha256:${d.current.slice(0, 16)}` : 'missing or unreadable'}`);
    const message =
      `[jev] A workflow file changed between the guard's analysis (${r.pin.decision}) and the end of the run, so what ran may not be what was checked:\n${lines.join('\n')}\n` +
      'Review the file, and re-run the workflow if it should be checked again.';
    return { status: 'changed', output: JSON.stringify({ systemMessage: message }) };
  } catch {
    return { status: 'error' };
  }
}
