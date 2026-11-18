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
import { withDirLockOrSkip } from '../src/core/dir-lock.js';

/** How long the write guard waits for its lock before failing open. */
const WRITE_GUARD_LOCK_WAIT_MS = 500;

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

/** Words that may precede the command in a segment (`env X=1 git ...`, `sudo git ...`, `then git ...`). */
const COMMAND_PREFIX_WORDS = new Set(['env', 'command', 'exec', 'time', 'sudo', 'nohup', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(']);
/** Prefix words that take options of their own (`env -i git ...`): the option words after them are skipped. */
const PREFIX_WITH_OPTIONS = new Set(['env', 'command', 'exec', 'time', 'sudo', 'nohup']);
/** Options of those prefix words that consume the next word as their value (`sudo -u root git ...`). */
const PREFIX_VALUE_OPTIONS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '-D', '--chdir', '-R', '--chroot', '-T', '-U', '-r', '-t']),
  time: new Set(['-f', '--format', '-o', '--output']),
  exec: new Set(['-a'])
};
const SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** How deep `sh -c`, `eval` and command substitutions are followed. */
const NESTED_MAX_DEPTH = 3;
/** `git commit` options that consume the next word, so a message such as `-m "-a"` is never read as a flag. */
const COMMIT_VALUE_OPTIONS = new Set(['-m', '-F', '-C', '-c', '-t', '-S', '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash']);

/** One `git [global options] <subcommand> [args]` invocation found in a command line. */
export type GitInvocation = {
  subcommand: string;
  /** The directory changes the invocation applies, in order: `env -C <dir>` first, then each `git -C <dir>`. */
  dashC: string[];
  /** The words after the subcommand, up to the end of its segment (quotes already removed). */
  args: string[];
};

function baseName(word: string): string {
  const i = word.lastIndexOf('/');
  return i === -1 ? word : word.slice(i + 1);
}

/**
 * Where the command word of a segment is: past `VAR=` assignments, prefix words (`env`, `sudo`, `time`, `then`, ...)
 * with their options and option values, and leading `(` / `{`. `dirs` collects the directories `env -C <dir>` moves to.
 * Returns null for a segment that is only prefixes.
 */
function commandHead(rawWords: string[]): { words: string[]; i: number; head: string; dirs: string[] } | null {
  let words = rawWords;
  const dirs: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_]\w*=/.test(w)) {
      i++;
    } else if (COMMAND_PREFIX_WORDS.has(w)) {
      i++;
      if (PREFIX_WITH_OPTIONS.has(w)) {
        const valueOpts = PREFIX_VALUE_OPTIONS[w];
        while (i < words.length && words[i].startsWith('-') && words[i].length > 1) {
          const opt = words[i];
          i++;
          if (valueOpts?.has(opt) && i < words.length) {
            if (w === 'env' && (opt === '-C' || opt === '--chdir')) dirs.push(words[i]);
            i++;
          } else if (w === 'env' && opt.startsWith('--chdir=')) {
            dirs.push(opt.slice('--chdir='.length));
          }
        }
      }
    } else if (w.length > 1 && /^[({]+/.test(w)) {
      words = [...words.slice(0, i), w.replace(/^[({]+/, ''), ...words.slice(i + 1)];
    } else {
      break;
    }
  }
  if (i >= words.length) return null;
  return { words, i, head: baseName(words[i]), dirs };
}

/** The command line a segment hands to another shell: `sh -c '<text>'` (the text) or `eval <words>` (joined by spaces, as eval does). */
function nestedCommandText(h: { words: string[]; i: number; head: string }): string | null {
  if (SHELL_WORDS.has(h.head)) {
    const flag = h.words.findIndex((w, j) => j > h.i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    return flag === -1 || flag + 1 >= h.words.length ? null : h.words[flag + 1];
  }
  if (h.head === 'eval') {
    const rest = h.words.slice(h.i + 1).join(' ');
    return rest.length > 0 ? rest : null;
  }
  return null;
}

/**
 * The bodies of `$( ... )`, `<( ... )`, `>( ... )` and backtick command substitutions of a command line, outermost
 * only (a nested one is found when its body is read in turn). Text inside single quotes is data and is skipped; a
 * substitution inside double quotes still runs.
 */
function commandSubstitutions(cmd: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  const closeParen = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < cmd.length) {
      const c = cmd[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === "'") {
        const end = cmd.indexOf("'", j + 1);
        if (end === -1) return -1;
        j = end + 1;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
      j++;
    }
    return -1;
  };
  let inDouble = false;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') {
      i += 2;
    } else if (c === "'" && !inDouble) {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) break;
      i = end + 1;
    } else if (c === '"') {
      inDouble = !inDouble;
      i++;
    } else if ((c === '$' || (!inDouble && (c === '<' || c === '>'))) && cmd[i + 1] === '(') {
      const end = closeParen(i + 2);
      if (end === -1) {
        bodies.push(cmd.slice(i + 2));
        break;
      }
      bodies.push(cmd.slice(i + 2, end));
      i = end + 1;
    } else if (c === '`') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '`') j += cmd[j] === '\\' ? 2 : 1;
      bodies.push(cmd.slice(i + 1, Math.min(j, cmd.length)));
      i = j + 1;
    } else {
      i++;
    }
  }
  return bodies;
}

/**
 * The git invocations one segment runs (several when it is `sh -c '...'` or `eval ...`), in order. A segment whose
 * command word is some other wrapper (`timeout 60 git commit`, `nice -n 5 git ...`, `xargs git ...`, `flock f git ...`)
 * is searched for a later `git` word, so detection is never narrower than a plain text match was: only the
 * directory resolution and flag parsing are structural.
 */
function gitInvocationsOfSegment(rawWords: string[], depth = 0): GitInvocation[] {
  const h = commandHead(rawWords);
  if (!h) return [];
  const { words } = h;
  let i = h.i;

  const nested = depth < NESTED_MAX_DEPTH ? nestedCommandText(h) : null;
  if (nested !== null) return invocationsOfCommandLine(nested, depth + 1);
  if (SHELL_WORDS.has(h.head) || h.head === 'eval') return [];

  if (h.head !== 'git') {
    const j = words.findIndex((w, k) => k > i && baseName(w) === 'git');
    if (j === -1) return [];
    i = j;
  }

  i++;
  const dashC: string[] = [...h.dirs];
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (GIT_VALUE_OPTIONS.has(opt)) {
      if (opt === '-C' && i + 1 < words.length) dashC.push(words[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  if (i >= words.length) return [];
  return [{ subcommand: words[i], dashC, args: words.slice(i + 1) }];
}

function invocationsOfCommandLine(cmd: string, depth: number): GitInvocation[] {
  const own = splitCommandSegments(cmd).flatMap((words) => gitInvocationsOfSegment(words, depth));
  if (depth >= NESTED_MAX_DEPTH) return own;
  return [...own, ...commandSubstitutions(cmd).flatMap((body) => invocationsOfCommandLine(body, depth + 1))];
}

/** Every git invocation in the command line, in order (quoted text is data, not a command). */
export function findGitInvocations(cmd: string): GitInvocation[] {
  try {
    return invocationsOfCommandLine(cmd, 0);
  } catch {
    return [];
  }
}

/**
 * The first `git ... commit` invocation in the command line, or null. Detection, the working-tree test and the
 * directory resolution all go through this one walker, so quoting, `-c k=v`, `-C "dir with space"`, `env` /
 * `VAR=` prefixes and `sh -c '...'` behave the same everywhere. Text inside quotes (an `echo "git commit"`) is a
 * word of another command, never a commit.
 */
export function findGitCommit(cmd: string): GitInvocation | null {
  return findGitInvocations(cmd).find((g) => g.subcommand === 'commit') ?? null;
}

/** Whether the command line also runs `git add` (quoted strings ignored). */
export function commandRunsGitAdd(cmd: string): boolean {
  return findGitInvocations(cmd).some((g) => g.subcommand === 'add');
}

/**
 * Whether a `git commit` command line commits the working tree, not just the index: `-a`, `--all`, `-am` (any short
 * flag cluster containing `a`), or the same command line also runs `git add`. Only the commit's own arguments are
 * searched for flags, and the value of an option such as `-m` is skipped, so a message like "fix -a flag" is not
 * read as a flag.
 */
export function commitIncludesWorkingTree(cmd: string): boolean {
  const invocations = findGitInvocations(cmd);
  if (invocations.some((g) => g.subcommand === 'add')) return true;
  const commit = invocations.find((g) => g.subcommand === 'commit');
  if (!commit) return false;
  for (let i = 0; i < commit.args.length; i++) {
    const a = commit.args[i];
    if (a === '--') break;
    if (a === '--all') return true;
    if (COMMIT_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]*a[A-Za-z]*$/.test(a)) return true;
  }
  return false;
}

/**
 * Where a command line's first `git ... commit` runs. Walks the segments with a running cwd that starts at `baseCwd`:
 * `cd <dir>` / `pushd <dir>` move it (when the directory exists), and the commit applies its own `env -C` / `-C <dir>`
 * options in order, each relative to the previous, as git does. `sh -c '...'`, `eval ...` and `$( ... )` bodies are
 * walked the same way from the cwd they start in, so a `cd` inside them moves their commit. A `cd` inside a `( ... )`
 * subshell may have ended before the commit, so `cwds` then also lists the directory without it. A `-C` on any other
 * segment (an earlier `git add -C ...`) does not move the commit. Without a commit, `end` is the running cwd.
 */
function walkCommandLine(cmd: string, baseCwd: string, depth: number): { found: boolean; cwds: string[]; end: string } {
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
  const unique = (xs: string[]) => [...new Set(xs)];
  // A substitution body runs in its own subshell: its cd moves its own commit, and the segment splitter below would
  // cut it in two at the `&&`, so the bodies are walked whole first and their directories are checked as well.
  const subDirs: string[] = [];
  if (depth < NESTED_MAX_DEPTH) {
    for (const body of commandSubstitutions(cmd)) {
      const r = walkCommandLine(body, baseCwd, depth + 1);
      if (r.found) subDirs.push(...r.cwds);
    }
  }
  let cwd = baseCwd;
  let outer = baseCwd; // the cwd without the cds that were opened inside a `( ... )` subshell
  for (const raw of splitCommandSegments(cmd)) {
    const subshell = raw[0].startsWith('(');
    const h = commandHead(raw);
    if (!h) continue;
    const nested = depth < NESTED_MAX_DEPTH ? nestedCommandText(h) : null;
    if (nested !== null) {
      const starts = unique([cwd, outer]);
      const hits = starts.map((s) => walkCommandLine(nested, s, depth + 1)).filter((r) => r.found);
      if (hits.length > 0) return { found: true, cwds: unique([...hits.flatMap((r) => r.cwds), ...subDirs]), end: cwd };
      continue;
    }
    const commit = gitInvocationsOfSegment(raw, depth).find((g) => g.subcommand === 'commit');
    if (commit) {
      const cwds = unique([...[cwd, outer].map((s) => commit.dashC.reduce(step, s)), ...subDirs]);
      return { found: true, cwds, end: cwd };
    }
    if (h.head === 'cd' || h.head === 'pushd') {
      const arg = h.words.slice(h.i + 1).find((w) => w !== '--' && !(w.startsWith('-') && w.length > 1));
      if (arg !== undefined && arg !== '-' && !/^[+-]\d+$/.test(arg)) {
        cwd = step(cwd, arg);
        if (!subshell) outer = step(outer, arg);
      }
    }
  }
  if (subDirs.length > 0) return { found: true, cwds: unique(subDirs), end: cwd };
  return { found: false, cwds: [], end: cwd };
}

/**
 * The directory a `git ... commit` command runs in (Antigravity sets `input.cwd` to the workspace root); see
 * `walkCommandLine`. Without a commit it is the cwd the command line leaves behind. Fail-safe: any error or odd
 * input yields `baseCwd`.
 */
export function resolveGitCwd(cmd: string, baseCwd: string): string {
  try {
    const r = walkCommandLine(cmd, baseCwd, 0);
    return r.found ? r.cwds[0] : r.end;
  } catch {
    return baseCwd;
  }
}

/**
 * Every directory the first `git ... commit` of the command line may run in: normally one, and more when a `cd` inside
 * a subshell leaves it unclear whether the commit saw it. Never empty; falls back to `[baseCwd]`.
 */
export function resolveGitCommitDirs(cmd: string, baseCwd: string): string[] {
  try {
    const r = walkCommandLine(cmd, baseCwd, 0);
    return r.found && r.cwds.length > 0 ? r.cwds : [baseCwd];
  } catch {
    return [baseCwd];
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

/**
 * The form of a write target that is counted and checked against the exempt paths: `path.resolve(cwd, target)`, so
 * `src/a.ts`, `./src/a.ts`, `src/../src/a.ts` and `<cwd>/src/a.ts` are one file. A target inside the workspace is
 * kept relative to it (so a workspace that sits under a directory named `plans` does not exempt everything in it);
 * one outside stays absolute.
 */
export function normalizeWriteTarget(targetPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, targetPath);
  const rel = path.relative(cwd, resolved);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : resolved;
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
    if (findGitCommit(cmd)) {
      // `git commit -a/--all/-am`, or a command line that also runs `git add`, commits more than the index now holds,
      // so the diff is taken against HEAD instead of --cached.
      const includesWorkingTree = commitIncludesWorkingTree(cmd);
      // Normally one directory; a `cd` inside a `( ... )` subshell can leave two, and every one is checked.
      const cwds = resolveGitCommitDirs(cmd, input.cwd || process.cwd());
      const deadline = Date.now() + GIT_DIFF_TIMEOUT_MS;
      const sid = safeSessionId(input.conversationId || input.sessionId || '') || null;
      for (const cwd of cwds) {
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
              appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'untracked_limit', reason: scan.reason });
            }
          } catch {
            appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'git_error', stage: 'untracked' });
          }
        }
      }
    }
    return { decision: 'allow' };
  }

  // 3. Multi-file write guard
  const writeTools = ['write_file', 'edit_file', 'write_to_file', 'replace_file_content'];
  if (writeTools.includes(toolName)) {
    const rawTarget = String(args.Path ?? args.TargetFile ?? args.path ?? args.targetFile ?? '');

    // No target path: nothing to count (an empty string is never recorded as a file).
    if (rawTarget.trim().length === 0) {
      return { decision: 'allow' };
    }
    const targetPath = normalizeWriteTarget(rawTarget, input.cwd || process.cwd());

    // Check exempt paths
    const cfg = loadJevConfigSync();
    const writeGuardCfg = cfg.harnesses?.antigravity?.writeGuard;
    const exemptPaths = writeGuardCfg?.exemptPaths || ['plans/', '/brain/', '.agents/memory/', '.agents/rules/'];
    if (isExemptPath(targetPath, exemptPaths)) {
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

    // Track files in the session write guard file. The read, the count and the write happen under one lock, so
    // parallel tool calls neither lose a recorded file nor each see the same count. On a lock timeout the guard
    // fails open (this edit is allowed and not counted) and leaves one trace line.
    const guardFile = path.join(sessionsDir, `${convId}.write-guard.json`);
        const locked = withDirLockOrSkip(
      guardFile.replace(/\.json$/, '.lock'),
      (): { decision: 'allow' } | { decision: 'deny'; reason: string } => {
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
      },
      (err) => appendGuardLog({ event: 'write_guard', session_id: convId, outcome: 'lock_timeout', lock: err.lock }),
      { waitMs: WRITE_GUARD_LOCK_WAIT_MS }
    );
    return locked ?? { decision: 'allow' };
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
