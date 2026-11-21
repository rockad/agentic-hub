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
import { modeBehaviour } from '../src/core/mode-policy.js';

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

/**
 * The global options that point git at the repository a commit really uses: `--git-dir` / `--work-tree` as the
 * command line (or its `GIT_DIR` / `GIT_WORK_TREE`) gave them, already absolute. Git's own rules then apply as they
 * will to the commit: only a git dir means the cwd is the work tree, only a work tree means the repository is found
 * from the cwd.
 */
function gitRepoArgs(repo: { gitDir?: string; workTree?: string }): string[] {
  return [...(repo.gitDir ? [`--git-dir=${repo.gitDir}`] : []), ...(repo.workTree ? [`--work-tree=${repo.workTree}`] : [])];
}

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
 * `git diff` would show as text. Throws on a git error (the caller fails open and logs). With `repo.gitDir` the
 * listing runs as `git --git-dir=<it> [--work-tree=<it>]`, and the scan root is the work tree (or `cwd`, which git
 * treats as the work tree when only a git dir is given).
 */
export function scanUntrackedForConflicts(
  cwd: string,
  deadline: number,
  repo?: { gitDir?: string; workTree?: string }
): UntrackedScan {
  const top = repo?.gitDir
    ? (repo.workTree ?? cwd)
    : runGit(['rev-parse', '--show-toplevel'], cwd, deadline - Date.now()).trim();
  const listing = runGit(
    [...gitRepoArgs(repo ?? {}), 'ls-files', '--others', '--exclude-standard', '-z'],
    top,
    deadline - Date.now()
  );
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

/** What joins a command to its neighbour: `;` (also a newline), `&&`, `||`, a single `|` (`|&`), or a lone `&`. */
type Joint = ';' | '&&' | '||' | '|' | '&';

/**
 * One command of a command line: its words, whether a single `|` connects it to the command before it (`pipe`), and
 * the joints on either side (`before` is empty for the first command, `after` for the last).
 */
type Segment = { words: string[]; pipe: boolean; before?: Joint; after?: Joint };

/**
 * Split a command line into segments (on `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newline, outside quotes), each a list
 * of shell words with quotes removed and backslash escapes applied. `pipe` marks a segment that follows a `|` (a
 * pipeline stage), which is how text piped into a shell is found. A small tokenizer for path resolution only: no
 * expansion, substitution or redirection handling.
 */
function splitSegments(cmd: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  let curPipe = false; // the segment being built follows a `|`
  let curBefore: Joint | undefined; // the joint before the segment being built
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endSegment = (joint?: Joint) => {
    endWord();
    if (words.length > 0) segments.push({ words, pipe: curPipe, ...(curBefore ? { before: curBefore } : {}), ...(joint ? { after: joint } : {}) });
    words = [];
    curPipe = joint === '|';
    curBefore = joint;
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
      endSegment('&&');
      i++;
    } else if (ch === '&' && !inWord && cmd[i - 1] !== '>' && cmd[i - 1] !== '<' && cmd[i + 1] !== '>') {
      endSegment('&'); // a lone `&` puts the command before it in the background: the next one is a new command
    } else if (ch === '|') {
      if (cmd[i + 1] === '|') {
        endSegment('||');
        i++;
      } else {
        endSegment('|');
        if (cmd[i + 1] === '&') i++; // `|&`
      }
    } else if (ch === ';' || ch === '\n') {
      endSegment(';');
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

function splitCommandSegments(cmd: string): string[][] {
  return splitSegments(cmd).map((s) => s.words);
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
  /** `VAR=value` words before the command (`GIT_DIR=x git commit`, `env GIT_DIR=x git commit`), in order. */
  env: Array<[string, string]>;
  /** The last `--git-dir` option (`--git-dir=x` or `--git-dir x`), raw. */
  gitDir?: string;
  /** The last `--work-tree` option, raw. */
  workTree?: string;
};

function baseName(word: string): string {
  const i = word.lastIndexOf('/');
  return i === -1 ? word : word.slice(i + 1);
}

/**
 * Where the command word of a segment is: past `VAR=` assignments, prefix words (`env`, `sudo`, `time`, `then`, ...)
 * with their options and option values, and leading `(` / `{`. `dirs` collects the directories `env -C <dir>` moves to,
 * `assigns` the `VAR=value` words. Returns null for a segment that is only prefixes.
 */
function commandHead(
  rawWords: string[]
): { words: string[]; i: number; head: string; dirs: string[]; assigns: Array<[string, string]> } | null {
  let words = rawWords;
  const dirs: string[] = [];
  const assigns: Array<[string, string]> = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_]\w*=/.test(w)) {
      const eq = w.indexOf('=');
      assigns.push([w.slice(0, eq), w.slice(eq + 1)]);
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
  return { words, i, head: baseName(words[i]), dirs, assigns };
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
  let gitDir: string | undefined;
  let workTree: string | undefined;
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (GIT_VALUE_OPTIONS.has(opt)) {
      const value = i + 1 < words.length ? words[i + 1] : undefined;
      if (value !== undefined) {
        if (opt === '-C') dashC.push(value);
        else if (opt === '--git-dir') gitDir = value;
        else if (opt === '--work-tree') workTree = value;
      }
      i += 2;
    } else {
      if (opt.startsWith('--git-dir=')) gitDir = opt.slice('--git-dir='.length);
      else if (opt.startsWith('--work-tree=')) workTree = opt.slice('--work-tree='.length);
      i++;
    }
  }
  if (i >= words.length) return [];
  return [
    {
      subcommand: words[i],
      dashC,
      args: words.slice(i + 1),
      env: h.assigns,
      ...(gitDir !== undefined ? { gitDir } : {}),
      ...(workTree !== undefined ? { workTree } : {})
    }
  ];
}

/** Whether a shell command (`sh`, `bash -l`, `sh -s`, `sh -`) reads its commands from standard input. */
function shellReadsStdin(h: { words: string[]; i: number; head: string }): boolean {
  if (!SHELL_WORDS.has(h.head)) return false;
  // Redirections (`<<< text`, `< file`, `2>&1`, `>out`) are not arguments of the shell.
  const args: string[] = [];
  const raw = h.words.slice(h.i + 1);
  for (let k = 0; k < raw.length; k++) {
    const w = raw[k];
    if (/^\d*(<<<|<<|<|>>|>)$/.test(w)) k++; // the operator and its operand are separate words
    else if (!/^\d*[<>]/.test(w)) args.push(w);
  }
  if (args.some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w))) return false; // -c: the text is the argument, stdin is data
  if (args.some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w))) return true; // -s: read commands from stdin
  const operand = args.find((w) => !w.startsWith('-') || w === '-');
  return operand === undefined || operand === '-'; // a script file operand is read instead of stdin
}

/** The text of an `echo` / `printf` segment, as candidate command lines (raw, and with the two characters backslash-n / backslash-t decoded). */
function literalTextsOf(h: { words: string[]; i: number; head: string }): string[] {
  const args = h.words.slice(h.i + 1);
  let texts: string[];
  if (h.head === 'echo') {
    let k = 0;
    while (k < args.length && /^-[neE]+$/.test(args[k])) k++;
    texts = [args.slice(k).join(' ')];
  } else if (h.head === 'printf') {
    let k = 0;
    if (args[k] === '-v') k += 2; // printf -v var: the output goes to a variable, but the format is still text
    const format = args[k] ?? '';
    const rest = args.slice(k + 1);
    let n = 0;
    const filled = format.replace(/%(%|[-+ #0-9.]*[a-zA-Z])/g, (m, c: string) => (c === '%' ? '%' : (rest[n++] ?? '')));
    texts = [filled, format, rest.join(' ')];
  } else {
    return [];
  }
  const decoded = texts.map((t) => t.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  return [...new Set([...texts, ...decoded])].filter((t) => t.trim().length > 0);
}

/**
 * Command lines a shell segment of a pipeline reads from its input: the literal text of an `echo` / `printf` that
 * precedes it in the same pipeline (`echo 'git commit -m x' | sh`, also through other stages such as `tee`), and a
 * here-string (`sh <<< 'git commit'`). Empty for a segment that is not a shell reading standard input, so
 * `echo "git commit"` on its own, or piped into `cat`, stays data. An echo is attached to the first shell after it only
 * (a second shell in the pipeline reads the first one's output). Known gap: a heredoc body is not tied to its
 * shell, but its lines are separate commands of the line anyway, so they are walked as such.
 */
function pipedShellTexts(segments: Segment[], idx: number): string[] {
  const seg = segments[idx];
  const h = commandHead(seg.words);
  if (!h || !shellReadsStdin(h)) return [];
  const texts: string[] = [];
  const args = seg.words.slice(h.i + 1);
  args.forEach((w, k) => {
    if (w === '<<<' && k + 1 < args.length) texts.push(args[k + 1]);
    else if (w.startsWith('<<<') && w.length > 3) texts.push(w.slice(3));
  });
  // Walk back through the pipeline, but only to the previous shell reading standard input: that shell gets the text
  // before it (or its own output), so each echo / printf is read once, by the first shell after it.
  for (let k = idx; k > 0 && segments[k].pipe; k--) {
    const prev = commandHead(segments[k - 1].words);
    if (prev && shellReadsStdin(prev)) break;
    if (prev && (prev.head === 'echo' || prev.head === 'printf')) texts.push(...literalTextsOf(prev));
  }
  return texts;
}

function invocationsOfCommandLine(cmd: string, depth: number): GitInvocation[] {
  const segments = splitSegments(cmd);
  const own = segments.flatMap((seg, idx) => [
    ...gitInvocationsOfSegment(seg.words, depth),
    ...(depth < NESTED_MAX_DEPTH
      ? pipedShellTexts(segments, idx).flatMap((text) => invocationsOfCommandLine(text, depth + 1))
      : [])
  ]);
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
 * The first `git ... commit` invocation in the command line, or null (`findGitInvocations` lists every one).
 * Detection, the working-tree test and the directory resolution all go through this one walker, so quoting,
 * `-c k=v`, `-C "dir with space"`, `env` / `VAR=` prefixes and `sh -c '...'` behave the same everywhere. Text inside
 * quotes (an `echo "git commit"`) is a word of another command, never a commit, unless that echo / printf is piped
 * into a shell (`echo 'git commit -m x' | sh`), which runs it. Known gap: `git -c alias.ci=commit ci` runs a commit
 * under another name and is not detected.
 */
export function findGitCommit(cmd: string): GitInvocation | null {
  return findGitInvocations(cmd).find((g) => g.subcommand === 'commit') ?? null;
}

/** Whether the command line also runs `git add` (quoted strings ignored). */
export function commandRunsGitAdd(cmd: string): boolean {
  return findGitInvocations(cmd).some((g) => g.subcommand === 'add');
}

/** Whether a `git commit`'s own arguments take the working tree: `-a`, `--all`, `-am` (a short cluster with `a`). */
function commitTakesAll(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
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
 * Whether the `git commit` command line commits the working tree, not just the index: any commit with `-a`, `--all`,
 * `-am` (any short flag cluster containing `a`), or the same command line also runs `git add`. Only a commit's own
 * arguments are searched for flags, and the value of an option such as `-m` is skipped, so a message like
 * "fix -a flag" is not read as a flag. With several commits on the line, any one of them counts.
 */
export function commitIncludesWorkingTree(cmd: string): boolean {
  const invocations = findGitInvocations(cmd);
  if (invocations.some((g) => g.subcommand === 'add')) return true;
  return invocations.some((g) => g.subcommand === 'commit' && commitTakesAll(g.args));
}

/** One place a `git commit` of the command line may run, and how the gate must look at it. */
export type CommitTarget = {
  /** The directory the commit runs in, after `env -C` / `git -C`. */
  cwd: string;
  /** `--git-dir` / `GIT_DIR`, absolute (resolved against `cwd`). The checks run `git --git-dir=<it>`. */
  gitDir?: string;
  /** `--work-tree` / `GIT_WORK_TREE`, absolute. With a `gitDir` the checks run `git --work-tree=<it>` too. */
  workTree?: string;
  /** The commit itself takes the working tree (`-a`, `--all`, `-am`). */
  all: boolean;
};

/** Where the commits of a command line run, and which directory changes could not be followed exactly. */
export type CommitPlan = {
  targets: CommitTarget[];
  /**
   * Why a directory change before a commit could not be resolved exactly (`popd`, `cd-`, `stack-index`, `bare-pushd`,
   * `pushd-n`, `bare-cd`, `expansion`, `missing-dir`). The walker then keeps both the directory before the change and
   * the one it would otherwise use as targets; the gate logs `unresolved_cd` so a miss is visible.
   */
  reasons: string[];
};

/** One possible shell state while walking a command line. */
type WalkState = {
  cwd: string;
  /** `$OLDPWD`: where the last exact `cd` came from. Unknown (undefined) until this line has done one. */
  prev?: string;
  /** The `pushd` stack below `cwd`, top first, as `dirs` would list it. Starts empty: an earlier call's stack is unknown. */
  stack: string[];
  /** `GIT_DIR` / `GIT_WORK_TREE` exported earlier in the line (raw: resolved against the commit's directory). */
  gitDir?: string;
  workTree?: string;
  /** Literal `NAME=value` assignments seen earlier in the line, for `cd "$NAME"`. */
  vars: Record<string, string>;
};

/** More states than this (many subshell branches) are not tracked: the first ones are kept. */
const MAX_WALK_STATES = 64;

const stateKey = (s: WalkState) => JSON.stringify([s.cwd, s.prev, s.stack, s.gitDir, s.workTree, s.vars]);
const uniqueStates = (xs: WalkState[]): WalkState[] => {
  const seen = new Set<string>();
  const out: WalkState[] = [];
  for (const s of xs) {
    const k = stateKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out.slice(0, MAX_WALK_STATES);
};
const uniqueStrings = (xs: string[]) => [...new Set(xs)];

function expandHome(p: string): string {
  return p === '~' ? jevHomeDir() : p.startsWith('~/') ? path.join(jevHomeDir(), p.slice(2)) : p;
}

/** `p` resolved against `from` (with `~` expanded) when it is an existing directory, else null. */
function existingDir(from: string, p: string): string | null {
  const candidate = path.resolve(from, expandHome(p));
  try {
    return fsSync.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * A word with `$NAME` / `${NAME}` replaced from what the line itself assigned (and `$PWD`, `$OLDPWD`, `$HOME`), or
 * null when it still holds an expansion that cannot be resolved here (`$(...)`, a backtick, an unknown variable).
 */
function expandWord(word: string, s: WalkState): string | null {
  if (!/[$`]/.test(word)) return word;
  if (word.includes('`')) return null;
  let ok = true;
  const out = word.replace(/\$(?:\{(\w+)\}|(\w+))/g, (m: string, braced?: string, plain?: string) => {
    const name = (braced ?? plain) as string;
    const v =
      name === 'PWD' ? s.cwd : name === 'OLDPWD' ? s.prev : name === 'HOME' ? jevHomeDir() : Object.hasOwn(s.vars, name) ? s.vars[name] : undefined;
    if (v === undefined) {
      ok = false;
      return m;
    }
    return v;
  });
  return ok && !out.includes('$') ? out : null;
}

/**
 * Where a `cd`-like move to `dir` from `from` may end up: exactly one directory (`exact`), or, when the target cannot
 * be resolved here (an expansion, a glob, `~user`) or does not exist yet, the directory before it and, if the target
 * word names a real directory literally, that one too.
 */
function dirCandidates(from: string, dir: string, s: WalkState, reasons: Set<string>): { dirs: string[]; exact: boolean } {
  const expanded = expandWord(dir, s);
  if (expanded === null) {
    reasons.add('expansion');
    const literal = existingDir(from, dir);
    return { dirs: literal && literal !== from ? [from, literal] : [from], exact: false };
  }
  const hit = existingDir(from, expanded);
  if (hit) return { dirs: [hit], exact: true };
  reasons.add(/[*?[{]|^~[^/]/.test(expanded) ? 'expansion' : 'missing-dir');
  return { dirs: [from], exact: false };
}

/** The operand of `cd` / `pushd` / `popd`: the first word that is not an option (`-P`, `-n`, ...); `-`, `+2` and `-2` count. */
function dirOperand(args: string[]): string | undefined {
  let afterDashes = false;
  for (const w of args) {
    if (!afterDashes && w === '--') {
      afterDashes = true;
      continue;
    }
    if (!afterDashes && w.startsWith('-') && w.length > 1 && !/^-\d+$/.test(w)) continue;
    return w;
  }
  return undefined;
}

/**
 * What `cd`, `pushd` or `popd` does to one state: usually exactly one state; two when the step cannot be resolved
 * (the directory before it is kept next to whatever the literal word names, and `reasons` records why). `cd -` and
 * `popd` are exact once this line has done the `cd` / `pushd` they undo; with nothing to undo (the previous directory
 * or the stack comes from an earlier command the hook cannot see) the directory before it is kept.
 */
function applyDirCommand(s: WalkState, head: string, args: string[], reasons: Set<string>): WalkState[] {
  const flagN = args.includes('-n');
  const operand = dirOperand(args);
  const isIndex = operand !== undefined && /^[+-]\d+$/.test(operand);
  const moved = (cwd: string, push: boolean): WalkState => ({ ...s, cwd, prev: s.cwd, stack: push ? [s.cwd, ...s.stack] : s.stack });
  if (head === 'popd') {
    if (isIndex) {
      reasons.add('stack-index');
      return [s];
    }
    if (s.stack.length === 0) {
      reasons.add('popd');
      return [s];
    }
    if (flagN) return [{ ...s, stack: s.stack.slice(1) }];
    return [{ ...s, cwd: s.stack[0], prev: s.cwd, stack: s.stack.slice(1) }];
  }
  if (isIndex) {
    reasons.add('stack-index');
    return [s];
  }
  if (operand === undefined) {
    if (head === 'pushd') {
      // `pushd` with no operand swaps the top two directories.
      if (flagN || s.stack.length === 0) {
        reasons.add('bare-pushd');
        return [s];
      }
      return [{ ...s, cwd: s.stack[0], prev: s.cwd, stack: [s.cwd, ...s.stack.slice(1)] }];
    }
    // A bare `cd` goes to the shell's $HOME, which the hook cannot see for certain: keep both.
    reasons.add('bare-cd');
    const home = existingDir(s.cwd, '~');
    return home && home !== s.cwd ? [s, moved(home, false)] : [s];
  }
  if (head === 'cd' && operand === '-') {
    if (s.prev === undefined) {
      reasons.add('cd-');
      return [s];
    }
    return [moved(s.prev, false)];
  }
  const c = dirCandidates(s.cwd, operand, s, reasons);
  if (head === 'pushd' && flagN) {
    // `pushd -n dir` stacks the directory without changing to it.
    reasons.add('pushd-n');
    return [s, ...c.dirs.filter((d) => d !== s.cwd).map((d) => moved(d, true))];
  }
  if (c.exact) return [moved(c.dirs[0], head === 'pushd')];
  return c.dirs.map((d) => (d === s.cwd ? s : moved(d, head === 'pushd')));
}

/** `NAME=value` applied to a state: a variable for later `cd "$NAME"`, and for `GIT_DIR` / `GIT_WORK_TREE` the exported one when `exported`. */
function applyAssign(s: WalkState, name: string, raw: string, exported: boolean, reasons: Set<string>): WalkState {
  const value = expandWord(raw, s);
  const { [name]: _old, ...others } = s.vars;
  if (value === null) {
    reasons.add('expansion');
    return { ...s, vars: others };
  }
  const next: WalkState = { ...s, vars: { ...others, [name]: value } };
  if (exported && name === 'GIT_DIR') next.gitDir = value;
  if (exported && name === 'GIT_WORK_TREE') next.workTree = value;
  return next;
}

/** The `NAME=value` words of a segment that is only assignments (`D=dirty`, `(D=dirty`), else null. */
function bareAssignments(raw: string[]): Array<[string, string]> | null {
  const words = [raw[0].replace(/^[({]+/, ''), ...raw.slice(1)].filter((w) => w.length > 0);
  if (words.length === 0 || !words.every((w) => /^[A-Za-z_]\w*=/.test(w))) return null;
  return words.map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]);
}

/** The commit targets of one `git commit` invocation, one or more per state (see `CommitTarget`). */
function commitTargets(inv: GitInvocation, states: WalkState[], reasons: Set<string>): CommitTarget[] {
  const out: CommitTarget[] = [];
  const all = commitTakesAll(inv.args);
  for (const s of states) {
    let cwds = [s.cwd];
    for (const d of inv.dashC) cwds = uniqueStrings(cwds.flatMap((c) => dirCandidates(c, d, s, reasons).dirs));
    // The option wins over a `VAR=` prefix, which wins over an earlier export.
    const pick = (flag: string | undefined, name: string, exported: string | undefined): string | undefined => {
      const prefix = [...inv.env].reverse().find(([n]) => n === name)?.[1];
      const raw = flag ?? prefix;
      if (raw === undefined) return exported;
      const expanded = expandWord(raw, s);
      if (expanded === null) reasons.add('expansion');
      return expanded ?? exported;
    };
    const gitDirRaw = pick(inv.gitDir, 'GIT_DIR', s.gitDir);
    const workTreeRaw = pick(inv.workTree, 'GIT_WORK_TREE', s.workTree);
    for (const cwd of cwds) {
      const gitDir = gitDirRaw !== undefined ? path.resolve(cwd, expandHome(gitDirRaw)) : undefined;
      const workTree = workTreeRaw !== undefined ? path.resolve(cwd, expandHome(workTreeRaw)) : undefined;
      out.push({ cwd, ...(gitDir ? { gitDir } : {}), ...(workTree ? { workTree } : {}), all });
      // A work tree alone (no git dir): git finds the repository from the cwd, but the files are in the work tree,
      // so that directory is checked as well (conservative).
      if (workTree && !gitDir && existingDir(cwd, workTree)) out.push({ cwd: workTree, all });
    }
  }
  return out;
}

type Walk = { commits: CommitTarget[]; reasons: string[]; end: string; /** The states the line ends in. */ states: WalkState[] };

/**
 * Where every `git ... commit` of a command line runs. Walks the segments with a set of possible shell states that
 * starts at `starts` (cwd, the previous directory, the `pushd` stack, exported `GIT_DIR` / `GIT_WORK_TREE`, assigned
 * variables):
 * - `cd`, `pushd` and `popd` move the states; `cd -` and `popd` are exact once the line has done the `cd` / `pushd`
 *   they undo, `cd "$D"` is followed for a `D=` the line assigned (and `$PWD`, `$OLDPWD`, `$HOME`).
 * - A step that cannot be resolved exactly (`popd` with nothing pushed, `cd -` with no previous directory, a bare
 *   `cd`, an expansion, a missing directory) keeps the directory before it as well as the one it would otherwise
 *   use, and is reported in `reasons`.
 * - Every commit found is a target, not only the first: it applies its own `env -C` / `-C <dir>` in order, each
 *   relative to the previous as git does, plus `--git-dir` / `--work-tree` and `GIT_DIR` / `GIT_WORK_TREE`.
 * - `sh -c '...'`, `eval ...`, `$( ... )` bodies and text piped into a shell are walked the same way from the states
 *   they start in. `eval` runs in the current shell, so where its text leaves the shell is where the line goes on;
 *   `sh -c` and piped shells are child processes and do not move it.
 * - A state change (`cd`, `pushd`, `popd`, `export`, an assignment) follows the shell: a backgrounded command (`&`) and a
 *   non-last pipeline stage are subshells and change nothing; the last pipeline stage, a `( ... )` subshell and a
 *   `cd` after `||` keep the states without it too; a `cd` after `&&` does too once the commit is reached any way
 *   but `&&` straight after it (`false && cd dir; git commit`). The last three are reported as `pipeline` or
 *   `conditional`. A `-C` on any other segment (an earlier `git add -C ...`) does not move a commit.
 * Without a commit, `end` is the first state's directory.
 */
function walkCommandLine(cmd: string, starts: WalkState[], depth: number): Walk {
  const reasons = new Set<string>(); // unresolved steps so far
  const commitReasons = new Set<string>(); // the unresolved steps seen up to a commit
  const commits: CommitTarget[] = [];
  const addCommit = (t: CommitTarget) => {
    if (!commits.some((c) => JSON.stringify(c) === JSON.stringify(t))) commits.push(t);
  };
  const takeWalk = (r: Walk) => {
    if (r.commits.length === 0) return;
    r.commits.forEach(addCommit);
    r.reasons.forEach((x) => commitReasons.add(x));
    reasons.forEach((x) => commitReasons.add(x));
  };
  // A substitution body runs in its own subshell: its cd moves its own commit, and the segment splitter below would
  // cut it in two at the `&&`, so the bodies are walked whole first and their targets are added as well.
  const subWalks: Walk[] = [];
  if (depth < NESTED_MAX_DEPTH) {
    for (const body of commandSubstitutions(cmd)) subWalks.push(walkCommandLine(body, starts, depth + 1));
  }
  let states = uniqueStates(starts);
  // States from before a `cd` that follows `&&`: the commit only runs in them if it is reached some other way than
  // by `&&` straight after the cd (`false && cd dir; git commit`).
  let skipped: WalkState[] = [];
  const segments = splitSegments(cmd);
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const raw = seg.words;
    const subshell = raw[0].startsWith('(');
    if (skipped.length > 0 && seg.before !== '&&') {
      states = uniqueStates([...states, ...skipped]);
      skipped = [];
      reasons.add('conditional');
    }
    /**
     * A command that changes the shell's state (`cd`, `pushd`, `popd`, `export`, an assignment, `eval`), as the shell
     * runs it: not at all when it is backgrounded (`&`) or a pipeline stage before the last (a subshell); next to the
     * states before it when it is the last stage of a pipeline (zsh runs it in the current shell, bash in a subshell)
     * or sits in `( ... )`, or follows `||`; and, after `&&`, as an extra way in only for what is not chained with
     * `&&` straight after it.
     */
    const merge = (next: WalkState[]) => {
      if (seg.after === '&' || seg.after === '|') return;
      if (seg.before === '|') {
        reasons.add('pipeline');
        states = uniqueStates([...next, ...states]);
      } else if (seg.before === '||') {
        reasons.add('conditional');
        states = uniqueStates([...next, ...states]);
      } else if (seg.before === '&&') {
        skipped = uniqueStates([...skipped, ...states]);
        states = uniqueStates(subshell ? [...next, ...states] : next);
      } else {
        states = uniqueStates(subshell ? [...next, ...states] : next);
      }
    };
    const bare = bareAssignments(raw);
    if (bare) {
      merge(states.map((s) => bare.reduce((acc, [n, v]) => applyAssign(acc, n, v, false, reasons), s)));
      continue;
    }
    const h = commandHead(raw);
    if (!h) continue;
    const texts: string[] = [];
    const nested = depth < NESTED_MAX_DEPTH ? nestedCommandText(h) : null;
    if (nested !== null) texts.push(nested);
    if (depth < NESTED_MAX_DEPTH) texts.push(...pipedShellTexts(segments, idx));
    if (texts.length > 0) {
      const walks = texts.map((text) => walkCommandLine(text, states, depth + 1));
      walks.forEach(takeWalk);
      // `eval` runs in the current shell: where its text leaves the shell is where the line goes on. `sh -c` and a
      // piped shell are child processes and leave it where it was.
      if (h.head === 'eval' && nested !== null) merge(walks[0].states);
      continue;
    }
    const commit = gitInvocationsOfSegment(raw, depth).find((g) => g.subcommand === 'commit');
    if (commit) {
      commitTargets(commit, states, reasons).forEach(addCommit);
      reasons.forEach((x) => commitReasons.add(x));
      continue;
    }
    const args = h.words.slice(h.i + 1);
    if (h.head === 'cd' || h.head === 'pushd' || h.head === 'popd') {
      merge(states.flatMap((s) => applyDirCommand(s, h.head, args, reasons)));
    } else if (h.head === 'export') {
      merge(
        states.map((s) =>
          args.reduce((acc, w) => {
            const eq = w.indexOf('=');
            if (eq > 0) return applyAssign(acc, w.slice(0, eq), w.slice(eq + 1), true, reasons);
            // `export NAME` on a variable the line already assigned
            if (acc.vars[w] !== undefined && w === 'GIT_DIR') return { ...acc, gitDir: acc.vars[w] };
            if (acc.vars[w] !== undefined && w === 'GIT_WORK_TREE') return { ...acc, workTree: acc.vars[w] };
            return acc;
          }, s)
        )
      );
    } else if (h.head === 'unset') {
      merge(
        states.map((s) => {
          const vars = { ...s.vars };
          for (const w of args) delete vars[w];
          return {
            ...s,
            vars,
            ...(args.includes('GIT_DIR') ? { gitDir: undefined } : {}),
            ...(args.includes('GIT_WORK_TREE') ? { workTree: undefined } : {})
          };
        })
      );
    }
  }
  if (skipped.length > 0) {
    states = uniqueStates([...states, ...skipped]);
    reasons.add('conditional');
  }
  subWalks.forEach(takeWalk);
  return { commits, reasons: [...commitReasons], end: states[0]?.cwd ?? starts[0].cwd, states };
}

const initialState = (baseCwd: string): WalkState => ({ cwd: baseCwd, stack: [], vars: {} });

/**
 * Every place a `git ... commit` of the command line may run (Antigravity sets `input.cwd` to the workspace root), see
 * `walkCommandLine`, with the directory changes that could not be resolved exactly. Never empty and fail-safe: any
 * error or a line the walker finds no commit in yields the base directory.
 */
export function resolveGitCommitPlan(cmd: string, baseCwd: string): CommitPlan {
  try {
    const r = walkCommandLine(cmd, [initialState(baseCwd)], 0);
    if (r.commits.length > 0) return { targets: r.commits, reasons: r.reasons };
  } catch {
    // fall through to the base directory
  }
  return { targets: [{ cwd: baseCwd, all: commitIncludesWorkingTree(cmd) }], reasons: [] };
}

/**
 * The directory a `git ... commit` command runs in; see `walkCommandLine`. Without a commit it is the cwd the command
 * line leaves behind. Fail-safe: any error or odd input yields `baseCwd`.
 */
export function resolveGitCwd(cmd: string, baseCwd: string): string {
  try {
    const r = walkCommandLine(cmd, [initialState(baseCwd)], 0);
    return r.commits.length > 0 ? r.commits[0].cwd : r.end;
  } catch {
    return baseCwd;
  }
}

/**
 * Every directory a `git ... commit` of the command line may run in: normally one, more when there are several
 * commits, or when a `cd` inside a subshell or an unresolved step leaves it unclear. Never empty; falls back to
 * `[baseCwd]`.
 */
export function resolveGitCommitDirs(cmd: string, baseCwd: string): string[] {
  return uniqueStrings(resolveGitCommitPlan(cmd, baseCwd).targets.map((t) => t.cwd));
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
  if (!modeBehaviour(mode).decisions) {
    return { decision: 'allow' };
  }

  const toolName = input.toolCall?.name || '';
  const args = input.toolCall?.args || {};

  // 2. run_command commit gate
  if (toolName === 'run_command') {
    const cmd = String(args.CommandLine ?? args.command ?? '');
    if (findGitCommit(cmd)) {
      // Every commit of the line is checked, in every directory it may run in (a `cd` inside a `( ... )` subshell, an
      // unresolved `cd` / `popd`, a second commit, `--git-dir` / `GIT_DIR` can each add one).
      const plan = resolveGitCommitPlan(cmd, input.cwd || process.cwd());
      const runsAdd = commandRunsGitAdd(cmd);
      const deadline = Date.now() + GIT_DIFF_TIMEOUT_MS;
      const sid = safeSessionId(input.conversationId || input.sessionId || '') || null;
      // A directory change that could not be followed exactly is not a denial, but it must be visible: both the
      // directory before it and the one the walker would otherwise use were checked.
      if (plan.reasons.length > 0) {
        appendGuardLog({ event: 'commit_gate', session_id: sid, outcome: 'unresolved_cd', reasons: plan.reasons });
      }
      for (const target of plan.targets) {
        // `git commit -a/--all/-am`, or a command line that also runs `git add`, commits more than the index now
        // holds, so the diff is taken against HEAD instead of --cached.
        const includesWorkingTree = target.all || runsAdd;
        const repo = gitRepoArgs(target);
        try {
          const diff = runGit([...repo, ...PLAIN_DIFF_ARGS, includesWorkingTree ? 'HEAD' : '--cached'], target.cwd, GIT_DIFF_TIMEOUT_MS);
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
        if (runsAdd) {
          try {
            const scan = scanUntrackedForConflicts(target.workTree ?? target.cwd, deadline, target.gitDir ? target : undefined);
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
            if (parsed.orchestrator === true || isOrchestratorModel(parsed.model)) {
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
