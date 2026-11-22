import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fetchWithTimeout } from './client.js';
import { PRIVATE_FILE_MODE, privateDir, privateFile, jevHomeDir } from './private-fs.js';
import { telemetryMode, type TelemetryMode } from './mode-policy.js';

/** Directory of the Antigravity telemetry files, resolved from HOME at call time. */
export function telemetryDir(): string {
  return path.join(jevHomeDir(), '.gemini', 'antigravity-cli');
}

/** The file `logJevTelemetry` appends to: `JEV_TELEMETRY_FILE` when set, else under HOME. Resolved at call time. */
export function jevTelemetryFile(): string {
  return process.env.JEV_TELEMETRY_FILE || path.join(telemetryDir(), 'jev_telemetry.jsonl');
}

/** The file `logTelemetry` (MCP tools) appends to, resolved from HOME at call time. */
export function telemetryFile(): string {
  return path.join(telemetryDir(), 'jev_telemetry.jsonl');
}

export interface JevTelemetryEvent {
  timestamp?: string;
  harness: 'antigravity' | 'claude' | 'cli';
  toolOrHook: string;
  /**
   * The Jev mode the hook acted under (2.3.19): `on` or `on-demand`, the value its `modeBehaviour` was computed from, so a
   * dashboard can split by mode. `off` writes nothing, so it never appears; a row written before 2.3.19 has no field.
   */
  mode?: TelemetryMode;
  sessionId?: string | null;
  taskSummary?: string;
  tierRecommended?: string;
  /** The model the session itself runs on (the baseline), on every record that knows it; null when it is not known. */
  sessionModel?: string | null;
  /** Where `sessionModel` was read from (hook input, stored file, transcript, quota state); null when not known. */
  sessionModelSource?: string | null;
  /** True (2.3.19, Claude Code `agent_call` only) when the session model was not known and Jev held the session as `sonnet` (`sessionModelSource` is then `assumed`); absent otherwise. */
  sessionModelAssumed?: boolean;
  /** The model the turn itself ran on, written only when it differs from `sessionModel` (an executor turn of an Antigravity Orchestrator conversation, whose `sessionModel` is the sticky planner). */
  turnModel?: string;
  /**
   * The model an Agent / subagent call is expected to run on (PreToolUse `agent_call` only, never on a prompt record):
   * the clamp's, else the applied downgrade's, else the one the call named, else the session model.
   */
  modelUsed?: string;
  /** Why `modelUsed` is what it is: 'clamped' | 'downgraded' | 'requested' | 'inherited' (see {@link resolveModelUsed}). */
  modelUsedSource?: ModelUsedSource;
  /** The model Jev recommended (UserPromptSubmit and PreToolUse). */
  modelRecommended?: string;
  /** Short id of the user turn, shared by the prompt and the Agent calls it caused. */
  turn?: string;
  latencyMs?: number;
  /**
   * A row that carries a downgrade suggestion or application (`downgrade` is `asked` or `applied`): the cost the downgrade saves,
   * the requested (model, effort) minus the target at the same effort (`downgradeCostSaving`); null when either cost is unknown.
   */
  costSaving?: number | null;
  costUsd?: number;
  tokensSaved?: number;
  quotaStrategy?: string;
  [key: string]: unknown;
}

/** Where the model an Agent / subagent call ran on came from; see {@link resolveModelUsed}. */
export type ModelUsedSource = 'clamped' | 'downgraded' | 'requested' | 'inherited';

/**
 * The model an Agent / subagent call is expected to run on, and why, shared by the Claude Code and Antigravity hooks so
 * both harnesses write the same value rules:
 *
 *   modelUsed = clampedTo ?? downgradedTo ?? requested ?? sessionModel
 *
 * `downgradedTo` is only passed when a downgrade was actually applied. A call that named no model (or the literal
 * `inherit`) is `inherited`: it runs on the session model. When the session model is unknown too, `modelUsed` is absent
 * and the source is still `inherited`, so the record says the call named nothing instead of guessing.
 */
export function resolveModelUsed(input: {
  clampedTo?: unknown;
  downgradedTo?: unknown;
  requested?: unknown;
  sessionModel?: unknown;
}): { modelUsed?: string; modelUsedSource: ModelUsedSource } {
  const name = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  const clamped = name(input.clampedTo);
  if (clamped) return { modelUsed: clamped, modelUsedSource: 'clamped' };
  const downgraded = name(input.downgradedTo);
  if (downgraded) return { modelUsed: downgraded, modelUsedSource: 'downgraded' };
  const requested = name(input.requested);
  if (requested && requested.toLowerCase() !== 'inherit') return { modelUsed: requested, modelUsedSource: 'requested' };
  const session = name(input.sessionModel);
  return session ? { modelUsed: session, modelUsedSource: 'inherited' } : { modelUsedSource: 'inherited' };
}

/**
 * What a telemetry line may say about a task instead of the task itself: its length and the first 12 hex of
 * its sha256. The hash is stable, so repeated tasks can be counted without keeping their text.
 */
export function taskFingerprint(task: string): { taskLen: number; taskHash: string } {
  return { taskLen: task.length, taskHash: createHash('sha256').update(task).digest('hex').slice(0, 12) };
}

/** Append one line to the telemetry file, owner-only: the directory 0700 and the file 0600, tightened even when they pre-exist. */
async function appendPrivate(file: string, line: string): Promise<void> {
  privateDir(path.dirname(file));
  await fs.appendFile(file, line, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  privateFile(file);
}

export async function logJevTelemetry(entry: JevTelemetryEvent): Promise<void> {
  try {
    // `mode` is only ever `on` or `on-demand`: any other value (off writes nothing) is dropped, not written.
    const mode = telemetryMode(entry.mode);
    const payload = {
      timestamp: entry.timestamp || new Date().toISOString(),
      ...entry,
      mode
    };
    await appendPrivate(jevTelemetryFile(), JSON.stringify(payload) + '\n');
  } catch {
    // telemetry is best-effort
  }
}

/**
 * Non-blocking append to local telemetry log (used by MCP tools)
 */
export async function logTelemetry(entry: Record<string, unknown>): Promise<void> {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      // Integer Unix seconds beside the ISO string, so a `jq` filter can compare times without GNU `date -d`.
      epoch: Math.floor(Date.now() / 1000),
      harness: 'antigravity',
      ...entry
    };
    await appendPrivate(telemetryFile(), JSON.stringify(payload) + '\n');
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Shared Recall / durable session memory reader across harnesses.
 */
export async function fetchRecallMemory(workspace = path.basename(process.cwd()) || 'default'): Promise<any> {
  const tryReadRecall = async (identifier: string) => {
    try {
      const res = await fetchWithTimeout('http://127.0.0.1:8110/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_note',
            arguments: {
              identifier,
              output_format: 'json',
              include_frontmatter: true
            }
          }
        })
      }, 800);
      if (res.ok) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            const parsed = JSON.parse(line.slice(6));
            const fm = parsed?.result?.structuredContent?.result?.frontmatter;
            if (fm && fm.activeGoal) {
              return fm;
            }
          }
        }
      }
    } catch {
      // fallback
    }
    return null;
  };

  const remote = (await tryReadRecall(`session-memory:${workspace}`)) || (await tryReadRecall(`session-handoff:${workspace}`));
  if (remote) return remote;

  for (const file of ['memory.json', 'handoff.json']) {
    try {
      const filePath = path.join(jevHomeDir(), 'projects', workspace, '.agents', file);
      if (fsSync.existsSync(filePath)) {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // try next
    }
  }

  return null;
}
