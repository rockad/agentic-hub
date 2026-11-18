#!/usr/bin/env bun
/**
 * PreToolUse Guards for Google Antigravity
 * Enforces commit quality gate and multi-file write transition gate.
 */
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import { readRegularFile, readRegularFileHead, readRegularFileTail } from '../claude/safe-read.js';

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

/**
 * Diff options that keep the output a plain unified diff whatever the user's git config says: `color.ui = always`
 * would put an escape sequence before each `+`, `diff.external` / GIT_EXTERNAL_DIFF would replace the diff with an
 * external program's output, and a textconv driver would rewrite the content.
 */
const PLAIN_DIFF_ARGS = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-textconv'];

/** Untracked-file scan limits (a `git add` on the same command line can stage files `git diff` never shows). */
const UNTRACKED_MAX_FILES = 2000;
const UNTRACKED_FILE_MAX_BYTES = 1024 * 1024;

/** In a whole file (not a diff), an opening or closing conflict-marker line. */
const FILE_CONFLICT_MARKER_RE = /^(<<<<<<< |>>>>>>> )/m;

function runGit(args: string[], cwd: string, timeout: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: Math.max(1, timeout),
    maxBuffer: GIT_DIFF_MAX_BUFFER
  });
}

export type UntrackedScan =
  | { kind: 'clean' }
  | { kind: 'conflict'; file: string }
  | { kind: 'limit'; reason: 'files' | 'bytes' | 'time' };

/**
 * Scan the repository's untracked, non-ignored files for conflict markers, bounded by file count, total bytes and
 * the git timeout. Paths come from the repository root, so a command run in a subdirectory still sees `git add -A`'s
 * whole scope. Symlinks, non-regular, binary (NUL in the first 8 KiB) and oversized files are skipped, matching what
 * `git diff` would show as text. Throws on a git error (the caller fails open and logs).
 */
export function scanUntrackedForConflicts(cwd: string, deadline: number): UntrackedScan {
  const top = runGit(['rev-parse', '--show-toplevel'], cwd, deadline - Date.now()).trim();
  const listing = runGit(['ls-files', '--others', '--exclude-standard', '-z'], top, deadline - Date.now());
  const files = listing.split('\0').filter((f) => f.length > 0);
  if (files.length > UNTRACKED_MAX_FILES) return { kind: 'limit', reason: 'files' };
  let total = 0;
  for (const rel of files) {
    if (Date.now() > deadline) return { kind: 'limit', reason: 'time' };
    const abs = path.join(top, rel);
    try {
      if (!fsSync.lstatSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const read = readRegularFileHead(abs, UNTRACKED_FILE_MAX_BYTES);
    if (read.kind !== 'ok' || read.truncated) continue;
    total += read.size;
    if (total > GIT_DIFF_MAX_BUFFER) return { kind: 'limit', reason: 'bytes' };
    if (read.text.slice(0, 8192).includes('\0')) continue;
    if (FILE_CONFLICT_MARKER_RE.test(read.text)) return { kind: 'conflict', file: rel };
  }
  return { kind: 'clean' };
}

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
function dropQuoted(cmd: string): string {
  return cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** Whether the command line also runs `git add` (quoted strings ignored). */
export function commandRunsGitAdd(cmd: string): boolean {
  return GIT_ADD_RE.test(dropQuoted(cmd));
}

export function commitIncludesWorkingTree(cmd: string): boolean {
  const unquoted = dropQuoted(cmd);
  if (GIT_ADD_RE.test(unquoted)) return true;
  const m = new RegExp(GIT_PREFIX + String.raw`commit\b([^;&|\n]*)`).exec(unquoted);
  if (!m) return false;
  const flags = m[1];
  return /(?:^|\s)--all(?=\s|=|$)/.test(flags) || /(?:^|\s)-[A-Za-z]*a[A-Za-z]*(?=\s|$)/.test(flags);
}

/**
 * Split a command line into segments (on `&&`, `||`, `;`, `|`, newline, outside quotes), each a list of shell words
 * with quotes removed and backslash escapes applied. A small tokenizer for path resolution only: no expansion,
 * substitution or redirection handling.
 */
function splitCommandSegments(cmd: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'") {
      inWord = true;
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) {
        cur += cmd.slice(i + 1);
        break;
      }
      cur += cmd.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      inWord = true;
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length && /["\\$`]/.test(cmd[i + 1])) i++;
        cur += cmd[i];
        i++;
      }
    } else if (ch === '\\' && i + 1 < cmd.length) {
      inWord = true;
      cur += cmd[i + 1];
      i++;
    } else if (ch === '&' && cmd[i + 1] === '&') {
      endSegment();
      i++;
    } else if (ch === '|' || ch === ';' || ch === '\n') {
      endSegment();
      if (ch === '|' && cmd[i + 1] === '|') i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else {
      inWord = true;
      cur += ch;
    }
  }
  endSegment();
  return segments;
}

/** Git global options that consume the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

/**
 * For a segment that runs `git [global options] commit`, the `-C <dir>` values in order; otherwise null. Leading
 * `VAR=value`, `env`, `command`, `exec` and `time` words are skipped.
 */
function gitCommitDashC(words: string[]): string[] | null {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || ['env', 'command', 'exec', 'time'].includes(words[i]))) i++;
  if (words[i] !== 'git') return null;
  i++;
  const dirs: string[] = [];
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (GIT_VALUE_OPTIONS.has(opt)) {
      if (opt === '-C' && i + 1 < words.length) dirs.push(words[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  return words[i] === 'commit' ? dirs : null;
}

/**
 * Resolve the directory a `git ... commit` command runs in (Antigravity sets `input.cwd` to the workspace root).
 * Walks the command's segments with a running cwd that starts at `baseCwd`: `cd <dir>` / `pushd <dir>` move it (when
 * the directory exists), and the first `git ... commit` segment applies its own `-C <dir>` options in order, each
 * relative to the previous, as git does. A `-C` on any other segment (an earlier `git add -C ...`) does not move the
 * commit. With no commit segment the running cwd is returned. Fail-safe: any error or odd input yields `baseCwd`.
 */
export function resolveGitCwd(cmd: string, baseCwd: string): string {
  try {
    const expandHome = (p: string) =>
      p === '~' ? jevHomeDir() : p.startsWith('~/') ? path.join(jevHomeDir(), p.slice(2)) : p;
    const step = (from: string, dir: string): string => {
      const candidate = path.resolve(from, expandHome(dir));
      try {
        return fsSync.statSync(candidate).isDirectory() ? candidate : from;
      } catch {
        return from;
      }
    };
    let cwd = baseCwd;
    for (const words of splitCommandSegments(cmd)) {
      const dashC = gitCommitDashC(words);
      if (dashC) {
        for (const dir of dashC) cwd = step(cwd, dir);
        return cwd;
      }
      if (words[0] === 'cd' || words[0] === 'pushd') {
        const arg = words.slice(1).find((w) => w !== '--' && !(w.startsWith('-') && w.length > 1));
        if (arg !== undefined && arg !== '-' && !/^[+-]\d+$/.test(arg)) cwd = step(cwd, arg);
      }
    }
    return cwd;
  } catch {
    return baseCwd;
  }
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
      const cwd = resolveGitCwd(cmd, input.cwd || process.cwd());
      const deadline = Date.now() + GIT_DIFF_TIMEOUT_MS;
      const sid = safeSessionId(input.conversationId || input.sessionId || '') || null;
      try {
        const diff = runGit([...PLAIN_DIFF_ARGS, includesWorkingTree ? 'HEAD' : '--cached'], cwd, GIT_DIFF_TIMEOUT_MS);
        if (hasConflictMarkers(diff)) {
          appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'deny', mode: includesWorkingTree ? 'working_tree' : 'staged' });
          return {
            decision: 'deny',
            reason: `[jev] Pre-Commit Gate: Detected unresolved merge conflict markers in the ${includesWorkingTree ? 'working-tree' : 'staged'} diff. Resolve conflicts before committing.`
          };
        }
      } catch {
        // Fail open on any git error (no repository, no HEAD yet, timeout, oversized diff), and leave a trace.
        appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'git_error' });
      }
      // The hook runs before the command, so a file the same line `git add`s may still be untracked, and no diff
      // shows untracked files: scan them directly. Runs even when the diff failed (a repository with no HEAD yet).
      if (commandRunsGitAdd(cmd)) {
        try {
          const scan = scanUntrackedForConflicts(cwd, deadline);
          if (scan.kind === 'conflict') {
            appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'deny', mode: 'untracked' });
            return {
              decision: 'deny',
              reason: `[jev] Pre-Commit Gate: Detected unresolved merge conflict markers in the untracked file ${scan.file}, which this command may add. Resolve conflicts before committing.`
            };
          }
          if (scan.kind === 'limit') {
            appendGuardLog({ event: 'commit_gate', outcome: 'untracked_limit', reason: scan.reason });
          }
        } catch {
          appendGuardLog({ event: 'commit_gate', outcome: 'git_error', stage: 'untracked' });
        }
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
      appendGuardLog({ event: 'write_guard', session_id: convId, outcome: 'deny', count: guardData.files.length, limit });
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
