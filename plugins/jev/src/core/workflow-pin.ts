/**
 * Content binding for the workflow guards (script TOCTOU), shared by Claude Code (`Workflow`) and Antigravity
 * (`run_workflow`). The harness adapters own the analysis and the decision; this module owns the pin store and the
 * drift check, so both harnesses bind a decision to the script it analysed in the same way.
 *
 * The PreToolUse hook analyses the workflow text it reads; the harness reads the file again to run it, and the hook
 * cannot hold the file still in between. What it can do, and does:
 * - re-analyse the CURRENT content on every call, so a script path that was edited since an earlier call (or a resume of
 *   it) is judged on what it says now, never on an earlier verdict;
 * - bind each decision to the sha256 of the text it analysed: the ask text, the decisions log and a pin all carry the
 *   hashes, never the text;
 * - pin those hashes under the call's id, and let a PostToolUse recorder re-hash the files after the run and report any
 *   drift (a `workflow_changed` audit event, and a user-visible message where the harness has a channel for it). There
 *   is deliberately no prompt on a hash difference: the run already happened. A pin whose files drifted is kept and marked
 *   `drifted` (with the files and both hashes) until it is pruned, as the audit record; an unchanged one is dropped;
 * - NEVER read a pin as a verdict: PreToolUse does not read the pin store at all, so a call (a re-invocation, a resume, the
 *   same tool call id) is always analysed from the file on disk as it is now and gets the normal verdict. Only the PostToolUse
 *   recorder reads pins.
 *
 * Limits: the drift check is detection after the fact, not prevention; a file swapped and put back inside the window is
 * not seen; an inline script has no file to re-check.
 *
 * Nothing in this module says anything unless the guard ran: with Jev off the hook returns before it evaluates anything,
 * so no pin exists. A pin written while Jev was on is consumed without any stdout if Jev was switched off before the run
 * ended, but drift is still written to the log: the decision was made while Jev was on, and a model that can call
 * jev_set_mode must not be able to erase the evidence.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIVATE_FILE_MODE, privateDir, privateFile } from './private-fs.js';
import { modeBehaviour } from './mode-policy.js';
import { safeSessionId } from '../../claude/logic.js';
import { readRegularFile } from './safe-read.js';

/** Largest script (inline or file) a workflow guard will analyse. Bigger is unverifiable. */
export const MAX_SCRIPT_BYTES = 512 * 1024;

/** What the analysis read: bind a decision to this exact text. Never carries the text itself. */
export interface ScriptFact {
  /** `<inline>`, or the resolved file path. */
  label: string;
  sha256: string;
  bytes: number;
}

export interface WorkflowPin {
  tool_use_id: string;
  session_id?: string;
  decision: 'allow' | 'ask';
  at: string;
  scripts: ScriptFact[];
  /** Set by the PostToolUse recorder when a file's content differs from the analysed one; the pin is then kept, not dropped. */
  drifted?: boolean;
  drifted_at?: string;
  /** The drifted files with both hashes (`current` null: gone or unreadable). */
  drift?: Array<{ file: string; analysed: string; current: string | null }>;
}

export const PIN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A pin file is a few hundred bytes per script; a bigger one is not one of ours. */
const PIN_MAX_BYTES = 4 * 1024 * 1024;

function pinFile(dir: string, toolUseId: unknown): string | null {
  const id = safeSessionId(toolUseId);
  return id ? path.join(dir, `${id}.json`) : null;
}

/** The sha256 (hex) and byte length of one analysed script text. */
export function scriptFact(label: string, text: string): ScriptFact {
  return { label, sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}

/** Write the pin for a workflow call. Best effort: false when there is no usable tool call id or the write failed. */
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
    const read = readRegularFile(file, PIN_MAX_BYTES);
    if (read.kind !== 'ok') return null;
    const parsed = JSON.parse(read.text);
    return Array.isArray(parsed?.scripts) ? (parsed as WorkflowPin) : null;
  } catch {
    return null;
  }
}

/** Mark the pin `drifted` and keep it (best effort; the audit event is already in the decisions log). */
function markPinDrifted(dir: string, toolUseId: unknown, pin: WorkflowPin, drift: DriftedFile[]): void {
  const file = pinFile(dir, toolUseId);
  if (!file) return;
  try {
    const marked: WorkflowPin = { ...pin, drifted: true, drifted_at: new Date().toISOString(), drift };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marked), { mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, file);
    privateFile(file);
  } catch {
    // the log has it
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
  const read = readRegularFile(file, MAX_SCRIPT_BYTES); // a FIFO at the path is unreadable here, never a hang
  return read.kind === 'ok' ? crypto.createHash('sha256').update(read.text).digest('hex') : null;
}

export interface DriftedFile {
  file: string;
  analysed: string;
  current: string | null;
}

export interface DriftCheckResult {
  status: 'unchanged' | 'changed' | 'no-pin' | 'off' | 'error';
  /** The pin that was consumed, present on `changed`, `unchanged` and `off` when Jev was on-demand (and the pin dropped). */
  pin?: WorkflowPin;
  /** The files whose content differs from the analysed one; present only on `changed` (the decisions log already has them). */
  drift?: DriftedFile[];
  /** True when the mode speaks (`on`): the caller may show the drift to the user. */
  speaks?: boolean;
}

export interface DriftDeps {
  /** The pin directory. */
  dir: string;
  /** The Jev mode for the harness right now. */
  readMode: () => Promise<string> | string;
  /** The decisions log. */
  log: (entry: Record<string, unknown>) => void;
}

/**
 * PostToolUse for a workflow call: re-hash every file the PreToolUse analysis read and compare. Drops the pin when nothing
 * changed; when a file drifted, logs one `workflow_changed` event per drifted file and keeps the pin, marked `drifted`. Never throws. Silent (`no-pin`) when the guard did not run for this call.
 * When Jev has been switched to on-demand since (`status: 'off'`) drift is still logged and `speaks` is
 * false. When it has been switched off nothing is dropped or logged (mode off writes nothing; the orphaned pin is pruned
 * by the next call made while Jev is not off).
 *
 * `toolName` is the harness's name for the tool (`Workflow`, `run_workflow`); it goes on the log entry.
 */
export async function checkWorkflowDrift(toolUseId: unknown, toolName: string, deps: DriftDeps, extraLog: Record<string, unknown> = {}): Promise<DriftCheckResult> {
  try {
    const pin = readPin(deps.dir, toolUseId);
    if (!pin || pin.drifted) return { status: 'no-pin' }; // none, or already reported (and kept as the record)
    const mode = await deps.readMode();
    // Off writes nothing: the pin is not dropped (the next prune takes it) and no drift is logged.
    if (!modeBehaviour(mode).telemetry) return { status: 'off' };
    // Mode on only speaks (stdout); on-demand logs the drift silently.
    const speaks = modeBehaviour(mode).decisions;
    const drift: DriftedFile[] = [];
    for (const s of pin.scripts) {
      if (typeof s?.label !== 'string' || !path.isAbsolute(s.label)) continue; // inline: no file to re-check
      const current = currentHash(s.label);
      if (current !== s.sha256) drift.push({ file: s.label, analysed: s.sha256, current });
    }
    if (drift.length === 0) {
      dropPin(deps.dir, toolUseId);
      return { status: speaks ? 'unchanged' : 'off', pin };
    }
    markPinDrifted(deps.dir, toolUseId, pin, drift);
    for (const d of drift) {
      deps.log({
        hook: 'PostToolUse',
        event: 'workflow_changed',
        ...extraLog,
        tool_name: toolName,
        tool_use_id: pin.tool_use_id,
        session_id: pin.session_id,
        file: d.file,
        analysed_sha256: d.analysed,
        current_sha256: d.current,
        decision: pin.decision
      });
    }
    return speaks ? { status: 'changed', pin, drift, speaks } : { status: 'off', pin, drift, speaks };
  } catch {
    return { status: 'error' };
  }
}
