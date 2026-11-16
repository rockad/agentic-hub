#!/usr/bin/env bun
/**
 * PreToolUse Guards for Google Antigravity
 * Enforces commit quality gate and multi-file write transition gate.
 */
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { execSync } from 'node:child_process';
import {
  readJevMode,
  safeSessionId,
  isOrchestratorModel,
  loadJevConfigSync,
  getAntigravitySessionsDir,
  pruneExpiredSessionModels,
  jevHomeDir,
  jevTelemetryFile,
  privateFile,
  privateDir,
  PRIVATE_FILE_MODE,
  type AntigravitySessionRecord
} from '../src/shared.js';
import { readRegularFile, readRegularFileTail } from '../claude/safe-read.js';

/** Added opening or closing conflict-marker lines only (a diff line starts with `+`). */
export const CONFLICT_MARKER_RE = /^\+(<<<<<<< |>>>>>>> )/m;

/**
 * Whether an added-lines diff carries an unresolved merge conflict. A lone `=======` line is also a Markdown setext
 * heading underline, so it is not a marker by itself: a conflict is reported only when the diff has an added
 * `<<<<<<< ` or `>>>>>>> ` line (a real conflict block always has one, the separator alongside).
 */
export function hasConflictMarkers(diff: string): boolean {
  return CONFLICT_MARKER_RE.test(diff);
}

/** `git` plus any global options, including options that take a value (`git -C repo add`). */
const GIT_PREFIX = String.raw`\bgit\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*`;
const GIT_COMMIT_RE = new RegExp(GIT_PREFIX + String.raw`commit\b`);
const GIT_ADD_RE = new RegExp(GIT_PREFIX + String.raw`add\b`);

const GIT_DIFF_TIMEOUT_MS = 3000;
const GIT_DIFF_MAX_BUFFER = 16 * 1024 * 1024;

function jevConfigDir(): string {
  return process.env.JEV_CONFIG_FILE
    ? path.dirname(process.env.JEV_CONFIG_FILE)
    : path.join(jevHomeDir(), '.config', 'jev');
}

/** One line in antigravity_decisions.jsonl; never throws. */
function appendGuardLog(entry: Record<string, unknown>): void {
  try {
    const dir = jevConfigDir();
    privateDir(dir);
    const file = path.join(dir, 'antigravity_decisions.jsonl');
    fsSync.appendFileSync(file, JSON.stringify({ ...entry, epoch: Math.floor(Date.now() / 1000) }) + '\n', {
      mode: PRIVATE_FILE_MODE
    });
    privateFile(file);
  } catch {
    // logging is best-effort
  }
}

/**
 * Whether a `git commit` command line commits the working tree, not just the index: `-a`, `--all`, `-am` (any short
 * flag cluster containing `a`), or the same command line also runs `git add`. Quoted strings are dropped first so a
 * commit message such as "fix -a flag" is not read as a flag, and only the `git commit ...` segment (up to the next
 * command separator) is searched for flags.
 */
export function commitIncludesWorkingTree(cmd: string): boolean {
  const unquoted = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  if (GIT_ADD_RE.test(unquoted)) return true;
  const m = new RegExp(GIT_PREFIX + String.raw`commit\b([^;&|\n]*)`).exec(unquoted);
  if (!m) return false;
  const flags = m[1];
  return /(?:^|\s)--all(?=\s|=|$)/.test(flags) || /(?:^|\s)-[A-Za-z]*a[A-Za-z]*(?=\s|$)/.test(flags);
}

/**
 * Whether `targetPath` falls under an exempt path. A pattern is matched as path SEGMENTS: `plans/` exempts
 * `plans/x.md` and `a/plans/x.md` but not `src/xplans/x.md`. A pattern with a trailing slash matches directory
 * segments only (not the file name). Backslashes count as separators.
 */
export function isExemptPath(targetPath: string, exemptPaths: string[]): boolean {
  const segs = targetPath.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return false;
  for (const raw of exemptPaths) {
    if (typeof raw !== 'string') continue;
    const pat = raw.replace(/\\/g, '/');
    const dirOnly = pat.endsWith('/');
    const want = pat.split('/').filter((s) => s.length > 0);
    if (want.length === 0) continue;
    const hay = dirOnly ? segs.slice(0, -1) : segs;
    for (let i = 0; i + want.length <= hay.length; i++) {
      if (want.every((w, j) => hay[i + j] === w)) return true;
    }
  }
  return false;
}

export interface PreToolHookInput {
  conversationId?: string;
  sessionId?: string;
  cwd?: string;
  modelName?: string;
  transcriptPath?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

export function parseEpoch(row: any): number {
  if (!row || typeof row !== 'object') return 0;
  if (typeof row.epoch === 'number' && !Number.isNaN(row.epoch) && row.epoch > 0) {
    return row.epoch;
  }
  if (typeof row.timestamp_ms === 'number' && !Number.isNaN(row.timestamp_ms) && row.timestamp_ms > 0) {
    return row.timestamp_ms / 1000;
  }
  if (typeof row.timestamp === 'string') {
    const parsed = Date.parse(row.timestamp);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed / 1000;
    }
  }
  return 0;
}

export function computeLastDispatchEpoch(
  convId: string,
  telemetryFile: string,
  decisionsFile: string
): number {
  if (!convId) return 0;
  let maxEpoch = 0;

  // 1. Scan jev_telemetry.jsonl
  try {
    const read = readRegularFileTail(telemetryFile, 256 * 1024);
    if (read.kind === 'ok') {
      let text = read.text;
      if (read.truncated) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }
      for (const line of text.trim().split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const tool = typeof row.tool === 'string' ? row.tool : '';
          const toolOrHook = typeof row.toolOrHook === 'string' ? row.toolOrHook : '';
          const sid = typeof row.sessionId === 'string' ? row.sessionId : '';

          if (
            ['jev_batch_dispatch', 'jev_dispatch', 'jev_select_model'].includes(tool) &&
            toolOrHook !== 'PreInvocation' &&
            sid === convId
          ) {
            const epoch = parseEpoch(row);
            if (epoch > maxEpoch) maxEpoch = epoch;
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  } catch {
    // best-effort
  }

  // 2. Scan antigravity_decisions.jsonl
  try {
    const read = readRegularFileTail(decisionsFile, 256 * 1024);
    if (read.kind === 'ok') {
      let text = read.text;
      if (read.truncated) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }
      for (const line of text.trim().split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const sid = typeof row.session_id === 'string' ? row.session_id : '';
          const toolName = typeof row.tool_name === 'string' ? row.tool_name : '';
          const decision = typeof row.decision === 'string' ? row.decision : '';

          if (
            sid === convId &&
            toolName === 'invoke_subagent' &&
            (decision === 'pass' || decision === 'allow')
          ) {
            const epoch = parseEpoch(row);
            if (epoch > maxEpoch) maxEpoch = epoch;
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  } catch {
    // best-effort
  }

  return maxEpoch;
}

export async function evaluatePreToolGuards(input: PreToolHookInput): Promise<{
  decision: 'allow' | 'deny';
  reason?: string;
}> {
  // 1. Mode resolution: readJevMode('antigravity') only
  const mode = await readJevMode('antigravity');
  if (mode !== 'on') {
    return { decision: 'allow' };
  }

  const toolName = input.toolCall?.name || '';
  const args = input.toolCall?.args || {};

  // 2. run_command commit gate
  if (toolName === 'run_command') {
    const cmd = String(args.CommandLine ?? args.command ?? '');
    if (GIT_COMMIT_RE.test(cmd)) {
      // `git commit -a/--all/-am`, or a command line that also runs `git add`, commits more than the index now holds,
      // so the diff is taken against HEAD instead of --cached.
      const includesWorkingTree = commitIncludesWorkingTree(cmd);
      try {
        const cwd = input.cwd || process.cwd();
        const diff = execSync(includesWorkingTree ? 'git diff HEAD' : 'git diff --cached', {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: GIT_DIFF_TIMEOUT_MS,
          maxBuffer: GIT_DIFF_MAX_BUFFER
        });
        if (hasConflictMarkers(diff)) {
          return {
            decision: 'deny',
            reason: `[jev] Pre-Commit Gate: Detected unresolved merge conflict markers in the ${includesWorkingTree ? 'working-tree' : 'staged'} diff. Resolve conflicts before committing.`
          };
        }
      } catch {
        // Fail open on any git error (no repository, no HEAD yet, timeout, oversized diff), and leave a trace.
        appendGuardLog({ event: 'commit_gate', outcome: 'git_error' });
      }
    }
    return { decision: 'allow' };
  }

  // 3. Multi-file write guard
  const writeTools = ['write_file', 'edit_file', 'write_to_file', 'replace_file_content'];
  if (writeTools.includes(toolName)) {
    const targetPath = String(args.Path ?? args.TargetFile ?? args.path ?? args.targetFile ?? '');

    // Check exempt paths
    const cfg = loadJevConfigSync();
    const writeGuardCfg = cfg.harnesses?.antigravity?.writeGuard;
    const exemptPaths = writeGuardCfg?.exemptPaths || ['plans/', '/brain/', '.agents/memory/', '.agents/rules/'];
    if (isExemptPath(targetPath, exemptPaths)) {
      return { decision: 'allow' };
    }

    // No target path: nothing to count (an empty string is never recorded as a file).
    if (targetPath.trim().length === 0) {
      return { decision: 'allow' };
    }

    const rawConvId = input.conversationId || input.sessionId || '';
    const convId = safeSessionId(rawConvId) || '';

    // No conversation id: there is no per-session streak to keep (a shared `default` file would mix sessions), so
    // pass through and leave one trace line.
    if (!convId) {
      appendGuardLog({ event: 'write_guard', outcome: 'no_conversation_id' });
      return { decision: 'allow' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const jevDir = jevConfigDir();

    const telemetryFile = jevTelemetryFile();
    const decisionsFile = path.join(jevDir, 'antigravity_decisions.jsonl');

    const lastDispatchEpoch = computeLastDispatchEpoch(convId, telemetryFile, decisionsFile);

    // If within 15 minutes (900 seconds) of last dispatch: pass through
    if (nowSec - lastDispatchEpoch < 900) {
      return { decision: 'allow' };
    }

    // Detect Orchestrator
    const sessionsDir = getAntigravitySessionsDir();
    let isOrchestrator = isOrchestratorModel(input.modelName);
    if (!isOrchestrator) {
      const sessionFile = path.join(sessionsDir, `${convId}.model.json`);
      try {
        const read = readRegularFile(sessionFile, 64 * 1024);
        if (read.kind === 'ok') {
          const parsed = JSON.parse(read.text) as AntigravitySessionRecord;
          if (parsed && typeof parsed.model === 'string' && nowSec - parsed.updated_at <= 7200) {
            if (isOrchestratorModel(parsed.model)) {
              isOrchestrator = true;
            }
          }
        }
      } catch {
        // ignore
      }
    }
    if (!isOrchestrator && input.transcriptPath) {
      try {
        const transcriptRead = readRegularFileTail(input.transcriptPath, 256 * 1024);
        if (transcriptRead.kind === 'ok' && transcriptRead.text.includes('exit_plan_mode')) {
          isOrchestrator = true;
        }
      } catch {
        // ignore
      }
    }

    // Determine limits
    const maxFilesOrchestrator = writeGuardCfg?.maxFilesOrchestrator ?? 6;
    const maxFiles = writeGuardCfg?.maxFiles ?? 3;
    const limit = isOrchestrator ? maxFilesOrchestrator : maxFiles;

    // Track files in session write guard file
    const guardFile = path.join(sessionsDir, `${convId}.write-guard.json`);
    let guardData: { last_dispatch_ts: number; files: string[] } = {
      last_dispatch_ts: 0,
      files: []
    };

    try {
      if (fsSync.existsSync(guardFile)) {
        const read = readRegularFile(guardFile, 64 * 1024);
        if (read.kind === 'ok') {
          const parsed = JSON.parse(read.text);
          if (parsed && typeof parsed === 'object') {
            guardData = {
              last_dispatch_ts: typeof parsed.last_dispatch_ts === 'number' ? parsed.last_dispatch_ts : 0,
              files: Array.isArray(parsed.files) ? parsed.files.map(String) : []
            };
          }
        }
      }
    } catch {
      // ignore
    }

    // Reset files if dispatch epoch changed
    if (guardData.last_dispatch_ts !== lastDispatchEpoch) {
      guardData = {
        last_dispatch_ts: lastDispatchEpoch,
        files: []
      };
    }

    // If target file already recorded in streak: pass through
    if (guardData.files.includes(targetPath)) {
      return { decision: 'allow' };
    }

    // Check limit
    if (guardData.files.length >= limit) {
      return {
        decision: 'deny',
        reason: `[jev] Post-Approval Transition Gate: You are editing multiple files (>= ${limit}) without a recent jev_dispatch, jev_batch_dispatch, or subagent delegation in the last 15 minutes. Call jev_batch_dispatch (or jev_dispatch) and delegate parallel workstreams first.`
      };
    }

    // Record file
    guardData.files.push(targetPath);
    try {
      privateDir(sessionsDir);
      // Same throttled prune (and stamp) as the *.model.json files: stale streak files do not pile up.
      pruneExpiredSessionModels(sessionsDir, nowSec);
      const tmpFile = `${guardFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fsSync.writeFileSync(tmpFile, JSON.stringify(guardData, null, 2) + '\n', { mode: PRIVATE_FILE_MODE });
      privateFile(tmpFile);
      fsSync.renameSync(tmpFile, guardFile);
      privateFile(guardFile);
    } catch {
      // ignore
    }

    return { decision: 'allow' };
  }

  return { decision: 'allow' };
}

// Standalone execution entry point
if (import.meta.main) {
  try {
    let inputData = '';
    if (!process.stdin.isTTY) {
      inputData = await Bun.stdin.text();
    }
    let input: PreToolHookInput = {};
    if (inputData.trim().length > 0) {
      try {
        input = JSON.parse(inputData);
      } catch {
        // malformed stdin: pass-through with empty stdout
        process.exit(0);
      }
    }

    const res = await evaluatePreToolGuards(input);
    if (res.decision === 'deny') {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: res.reason
      }));
      process.exit(0);
    }

    // Pass-through: 0 stdout bytes
    process.exit(0);
  } catch {
    // Fail-open: empty stdout
    process.exit(0);
  }
}
