/**
 * Content binding for the Antigravity `run_workflow` guard (script TOCTOU). The pin store and the drift check are shared
 * with the Claude Code Workflow guard and live in src/core/workflow-pin.ts (see there for the design and its limits);
 * this module is the Antigravity adapter.
 *
 * PreToolUse (antigravity/workflow-guard.ts) pins the sha256 of every script it analysed under `toolCall.id` in
 * `<jev dir>/antigravity-workflow-pins/` (directory 0700, files 0600, pruned after 14 days), whenever the call is allowed
 * or asked. PostToolUse on `run_workflow` re-hashes the files after the run and logs one `workflow_changed` event per file
 * that differs to `antigravity_decisions.jsonl` (with `harness: "antigravity"`, the analysed and the current sha256, never
 * script text). There is no prompt on a difference (the run already happened) and no approval is invalidated by it. The
 * hook prints `{}` as always: no user-visible drift message is sent because the PostToolUse output channel for a message
 * is not verified on Antigravity; the log is the evidence.
 *
 * Modes: with Jev off nothing is read, dropped or logged (the orphaned pin is pruned by a later call made while Jev is
 * not off); on-demand makes no decisions, so the guard never ran and there is no pin, but a pin written while Jev was on
 * is still consumed and its drift logged.
 */
import * as path from 'node:path';
import { checkWorkflowDrift, pruneWorkflowPins, type DriftCheckResult, type DriftDeps } from '../src/core/workflow-pin.js';
import { RUN_WORKFLOW_TOOL } from './workflow-guard.js';
import type { AntigravityHookInput } from './logic.js';
import { callKeyField } from '../src/core/join-keys.js';

export { pruneWorkflowPins };

/** `<jev dir>/antigravity-workflow-pins`. */
export function antigravityWorkflowPinDir(jevDir: string): string {
  return path.join(jevDir, 'antigravity-workflow-pins');
}

/** PostToolUse for `run_workflow`: compare the files' hashes with the pinned ones and log any drift. Consumes the pin. Never throws. */
export async function recordRunWorkflowPostToolUse(input: AntigravityHookInput, deps: DriftDeps): Promise<DriftCheckResult> {
  try {
    if (input?.toolCall?.name !== RUN_WORKFLOW_TOOL) return { status: 'no-pin' };
    return await checkWorkflowDrift(input.toolCall.id, RUN_WORKFLOW_TOOL, deps, { harness: 'antigravity', ...callKeyField(input.toolCall.id) });
  } catch {
    return { status: 'error' };
  }
}
