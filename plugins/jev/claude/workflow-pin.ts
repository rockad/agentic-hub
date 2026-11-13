/**
 * Content binding for the Workflow guard (script TOCTOU). Ported from cognitive-engine's workflow-pin.ts (same
 * owner), adapted to agentic-hub's hook: state under `~/.config/jev`, the decisions log of claude/hook.ts, the
 * mode read of the hook.
 *
 * The PreToolUse hook analyses the workflow text it reads; Claude Code reads the file again to run it, and the
 * hook cannot hold the file still in between. What it can do, and does:
 * - re-analyse the CURRENT content on every call, so a scriptPath that was edited since an earlier call (or a
 *   resume of it) is judged on what it says now, never on an earlier verdict;
 * - bind each decision to the sha256 of the text it analysed: the ask text, the decisions log and a pin all
 *   carry the hashes, never the text;
 * - pin those hashes under the call's `tool_use_id`, and let a PostToolUse recorder re-hash the files after the
 *   run and report any drift (a `workflow_changed` audit event and a user-visible message). There is deliberately
 *   no prompt on a hash difference: the run already happened.
 *
 * Limits: the drift check is detection after the fact, not prevention; a file swapped and put back inside the
 * window is not seen; an inline `script` has no file to re-check; what Claude Code runs on a `resumeFromRunId`
 * (the file or a saved copy of the earlier run) is not observable here.
 *
 * Nothing in this module says anything unless the guard ran: with Jev off the hook returns before it evaluates
 * anything, so no pin exists. A pin written while Jev was on is consumed without any stdout if Jev was switched
 * off before the run ended, but drift is still written to the log: the decision was made while Jev was on, and a
 * model that can call jev_set_mode must not be able to erase the evidence.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIVATE_FILE_MODE, privateDir, privateFile } from '../src/core/private-fs.js';
import { safeSessionId } from './logic.js';
import { MAX_SCRIPT_BYTES, type ScriptFact } from './workflow-guard.js';

export interface WorkflowPin {
  tool_use_id: string;
  session_id?: string;
  decision: 'allow' | 'ask';
  at: string;
  scripts: ScriptFact[];
}

export const PIN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function pinFile(dir: string, toolUseId: unknown): string | null {
  const id = safeSessionId(toolUseId);
  return id ? path.join(dir, `${id}.json`) : null;
}

/** Write the pin for a Workflow call. Best effort: false when there is no usable tool_use_id or the write failed. */
export function writeWorkflowPin(dir: string, toolUseId: unknown, sessionId: unknown, decision: WorkflowPin['decision'], scripts: ScriptFact[]): boolean {
  const file = pinFile(dir, toolUseId);
  if (!file || typeof toolUseId !== 'string') return false;
  try {
    privateDir(dir);
    const pin: WorkflowPin = { tool_use_id: toolUseId, ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}), decision, at: new Date().toISOString(), scripts };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pin), { mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, file);
    privateFile(file);
    return true;
  } catch {
    return false;
  }
}

function readPin(dir: string, toolUseId: unknown): WorkflowPin | null {
  const file = pinFile(dir, toolUseId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.scripts) ? (parsed as WorkflowPin) : null;
  } catch {
    return null;
  }
}

function dropPin(dir: string, toolUseId: unknown): void {
  const file = pinFile(dir, toolUseId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing to drop
  }
}

/** Delete pins not touched for two weeks (a run that never reached PostToolUse). Best effort. */
export function pruneWorkflowPins(dir: string, now = Date.now(), maxAgeMs = PIN_MAX_AGE_MS): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true });
      } catch {
        // skip
      }
    }
  } catch {
    // no pin dir yet
  }
}

/** sha256 of a file's current content, or null when it is gone, unreadable or over the analysis size limit. */
function currentHash(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_SCRIPT_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
  } catch {
    return null;
  }
}

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
 * throws. Silent (`no-pin`) when the guard did not run for this call. When Jev has been switched off since (`off`,
 * the pin dropped) there is no stdout, but drift is still logged.
 */
export async function recordWorkflowPostToolUse(input: unknown, deps: PinDeps): Promise<PostToolUseResult> {
  try {
    const i = input as { tool_name?: unknown; tool_use_id?: unknown } | null;
    if (i?.tool_name !== 'Workflow') return { status: 'ignored' };
    const pin = readPin(deps.dir, i.tool_use_id);
    if (!pin) return { status: 'no-pin' };
    dropPin(deps.dir, i.tool_use_id);
    const off = (await deps.readMode()) !== 'on';
    const drift: Array<{ file: string; analysed: string; current: string | null }> = [];
    for (const s of pin.scripts) {
      if (typeof s?.label !== 'string' || !path.isAbsolute(s.label)) continue; // inline: no file to re-check
      const current = currentHash(s.label);
      if (current !== s.sha256) drift.push({ file: s.label, analysed: s.sha256, current });
    }
    if (drift.length === 0) return { status: off ? 'off' : 'unchanged' };
    for (const d of drift) {
      deps.log({
        hook: 'PostToolUse',
        event: 'workflow_changed',
        tool_name: 'Workflow',
        tool_use_id: pin.tool_use_id,
        session_id: pin.session_id,
        file: d.file,
        analysed_sha256: d.analysed,
        current_sha256: d.current,
        decision: pin.decision
      });
    }
    if (off) return { status: 'off' };
    const lines = drift.map((d) => `- ${d.file}: analysed sha256:${d.analysed.slice(0, 16)}, now ${d.current ? `sha256:${d.current.slice(0, 16)}` : 'missing or unreadable'}`);
    const message =
      `[jev] A workflow file changed between the guard's analysis (${pin.decision}) and the end of the run, so what ran may not be what was checked:\n${lines.join('\n')}\n` +
      'Review the file, and re-run the workflow if it should be checked again.';
    return { status: 'changed', output: JSON.stringify({ systemMessage: message }) };
  } catch {
    return { status: 'error' };
  }
}
