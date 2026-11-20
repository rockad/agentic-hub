/**
 * Static guard for the Antigravity `run_workflow` tool (Jev mode `on`), at parity with the Claude Code Workflow guard
 * (claude/workflow-guard.ts).
 *
 * The agents a workflow script launches never pass through PreToolUse[invoke_subagent], so a script that says
 * `agent(..., model="pro")` would bypass the model ceiling. The hook does see the `run_workflow` call itself, so it reads
 * the script (the inline `Script`, or the `ScriptPath` file) and analyses it statically. The scripts are Python, so the
 * analysis is a small deterministic tokenizer in pure TypeScript (no `python3` is ever run on the script text): comments
 * and string literals are skipped when locating `agent(...)` call sites, every call is inspected wherever it sits (a
 * nested `async def` passed by reference to `parallel(items, helper)` included, because every token of the file is
 * visited, not just the top level), and anything the analysis cannot prove is `unverifiable`.
 *
 * What the analysis proves (the `agent` signature is `agent(prompt, schema, role, type_name="self", workspace="inherit",
 * model=None)`):
 * - `model` is read from the keyword `model=` or from the positional slot 5. A single plain string literal (or `None`)
 *   is understood; a literal is ranked against the session ceiling exactly as an `invoke_subagent` `Model` is, so a model
 *   above it is an ELEVATION (a choice question can answer it) and anything else is `unverifiable` (only a dialog, or a
 *   fix to the script, can answer it).
 * - When `model` is absent or `inherit`, the call runs on the session model: allowed, except under an Orchestrator
 *   session, where an omitted/`inherit` model is not safe (Decision 2 of the plan, as for `invoke_subagent`), and when
 *   `type_name` names a definition other than `self`, whose `model:` is then the model the call runs on.
 *
 * Fail-closed (unverifiable) idioms, from the plan's Q3 and the Claude guard:
 * - a `model` that is not a single plain string literal: a variable, an expression, an f-string, a concatenation, a
 *   conditional, bytes;
 * - `**kwargs` or `*args` inside an `agent(...)` call;
 * - any use of the name `agent` other than a direct call (aliasing, `parallel(items, agent)`, `.agent(...)`, `def agent`,
 *   `import ... as agent`, a decorator, a keyword argument named `agent`);
 * - `exec`, `eval`, `compile`, `importlib`, `runpy`, `pkgutil`, `zipimport`, `__import__`, `globals`, `locals`, `vars`, `__builtins__`, `builtins` (a name
 *   after a `.` is an attribute and is not one of these: `re.compile` is fine);
 * - an f-string whose text names one of those or `agent`;
 * - a `type_name` that is not a string literal while `model` is absent, a definition that cannot be found, a model
 *   that is `openrouter`/`free` or that no tier recognises, a script that cannot be tokenized, an unreadable,
 *   non-regular, oversized or missing `ScriptPath`, and a `run_workflow` input with neither `Script` nor `ScriptPath`.
 *
 * - a LOCAL import: an `import` or `from ... import` whose top-level name is a sibling `<name>.py` file or a `<name>/` package
 *   directory next to the script (a `ScriptPath`) or under its `Cwd`, and any relative import (`from . import x`, `from .m import y`).
 *   The imported file may launch agents the analysis never sees, so it is unverifiable ("inline the agent() calls or remove the
 *   local import"). The standard library and installed packages stay allowed: only a sibling file or directory is checked.
 *
 * Limits (not a sandbox, a fail-closed filter): a local file is not followed (see above), and a module that is neither a sibling
 * nor reachable from the script's own directory or Cwd (a `sys.path` change, a `.pth` file) is not noticed; a script cannot be re-checked between the analysis and the harness's own read of it (every decision is bound
 * to the sha256 of the text analysed, and a PostToolUse recorder reports drift, see workflow-pin.ts); the run's actual
 * served model is not observable here.
 *
 * The result separates `elevations` from `unverifiable` sites; `evaluateAntigravityWorkflowCall` turns them into a hook
 * decision with the mode semantics of src/core/mode-policy.ts:
 * - `off`: the hook never gets here (nothing runs, nothing is written);
 * - `on-demand`: no decision at all, no analysis, no pin; the call passes and one decisions-log row records it;
 * - `on`, choice and clamp (`JEV_ELEVATION` unset or `clamp`): never `ask`. An elevation takes the `[jev-elevate:<tier>]`
 *   question flow (a covering approval allows, otherwise a deny that prescribes the question; the third attempt says to
 *   stop retrying); a script cannot be clamped, so clamp behaves as choice. Anything unverifiable is a deny with what to
 *   change, by position and reason, never script text;
 * - `on`, dialog (`JEV_ELEVATION=dialog`): anything found opens the permission dialog (`ask`), listing every site.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isExplicitProOverride,
  isOrchestratorModel,
  modelTierRank,
  rankToTierName,
  subagentCeilingRank
} from '../src/core/governance.js';
import { jevHomeDir } from '../src/core/private-fs.js';
import { modeBehaviour } from '../src/core/mode-policy.js';
import type { JevMode } from '../src/core/config.js';
import type { ModeChangeConfigLike } from '../src/core/mode-change.js';
import { readRegularFile } from '../src/core/safe-read.js';
import { MAX_SCRIPT_BYTES, scriptFact, writeWorkflowPin, type ScriptFact } from '../src/core/workflow-pin.js';
import {
  CHOICE_OPTIONS,
  ELEVATE_MARKER_PREFIX,
  detectAntigravityAutoApprove,
  resolveChoiceElevation,
  type AntigravityHookDecision,
  type AntigravityHookInput
} from './logic.js';
import type { ApprovalStore } from './approvals.js';
import { stopRetryingText } from '../src/core/elevation-text.js';
import { safeSessionId } from '../src/core/governance.js';
import { DEFAULT_ANTIGRAVITY_SESSION_MODEL } from '../src/core/session-defaults.js';

export { MAX_SCRIPT_BYTES };

/** The first 16 hex of the digest of a text (a stable key, never the text). */
const digest16 = (text: string, algo: 'sha1' | 'sha256'): string => crypto.createHash(algo).update(text).digest('hex').slice(0, 16);

/** The tool name the hook matches. */
export const RUN_WORKFLOW_TOOL = 'run_workflow';

/** At most this many sites are listed in a deny or ask text (the log carries only the count). */
const MAX_LISTED = 12;

export interface CallSite {
  /** Where the script came from: `<inline>`, or the file path. */
  file: string;
  line: number;
  /** 1-based column. */
  col: number;
  reason: string;
  /** `elevation`: a literal model above the ceiling (a choice question can answer it). `unverifiable`: everything else. */
  kind: 'elevation' | 'unverifiable';
  /** On an `elevation` site: the model as written, and its tier. */
  requested?: string;
  tier?: 'flash_lite' | 'flash' | 'pro';
  rank?: number;
}

export interface WorkflowDecision {
  /** `ask` when any site was found, an elevation or not; `allow` otherwise. */
  decision: 'allow' | 'ask';
  sites: CallSite[];
  elevations: CallSite[];
  unverifiable: CallSite[];
  /** Every literal model that was ranked, in script order, de-duplicated. */
  models: string[];
  /** True when a model above the ceiling passed because the user named it in the prompt. */
  instructed: boolean;
  /** The strongest elevation (by tier rank), absent when there is none. */
  highest?: CallSite;
  /** The sha256 of every script text that was analysed, for allow and ask alike. */
  scripts: ScriptFact[];
}

/** Where agent definitions (`type_name` other than `self`) are looked up. */
export interface DefinitionResolver {
  /** The `model:` of the definition named `typeName`: `found: false` when there is none; `model: null` when it sets none. */
  definition(typeName: string): { found: boolean; model: string | null };
}

export const NO_DEFINITIONS: DefinitionResolver = { definition: () => ({ found: false, model: null }) };

/** Definitions in `<dir>/.agents/agents/<name>.md` for each directory, then `~/.agents/agents/<name>.md` (the same lookup order as Jev's subagent discovery). */
export function fsDefinitionResolver(dirs: readonly string[], home: string = jevHomeDir()): DefinitionResolver {
  return {
    definition: (typeName) => {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(typeName)) return { found: false, model: null };
      for (const base of [...dirs.map((d) => path.join(d, '.agents', 'agents')), path.join(home, '.agents', 'agents')]) {
        const file = path.join(base, `${typeName}.md`);
        let read;
        try {
          if (!fs.existsSync(file)) continue;
          read = readRegularFile(file, 256 * 1024);
        } catch {
          continue;
        }
        if (read.kind !== 'ok') return { found: true, model: '<unreadable>' };
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read.text);
        const m = front ? /^model:\s*['"]?([^'"\r\n#]+?)['"]?\s*(?:#.*)?$/m.exec(front[1]) : null;
        return { found: true, model: m ? m[1].trim() : null };
      }
      return { found: false, model: null };
    }
  };
}

// --- Tokenizer ------------------------------------------------------------------------------------------------------

type Tok = {
  t: 'name' | 'str' | 'num' | 'op';
  v: string;
  line: number;
  col: number;
  /** A string token: the prefix letters (lowercase), and its text between the quotes (escapes untouched). */
  prefix?: string;
  body?: string;
};

class PyParseError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(message);
  }
}

const STRING_PREFIX = /^(?:r|u|b|f|br|rb|fr|rf)$/i;
const THREE_OPS = new Set(['**=', '//=', '>>=', '<<=', '...']);
const TWO_OPS = new Set(['**', '==', '!=', '<=', '>=', '->', ':=', '//', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '@=']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) > 127;
}

/** Tokenize Python source: comments dropped, string literals one token each, newlines and indentation not tokens. Throws PyParseError on a literal that never ends. */
export function tokenizePython(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  const col = () => i - lineStart + 1;
  const newline = () => {
    line++;
    lineStart = i + 1;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      newline();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\r' ? 3 : 2;
      line++;
      lineStart = i;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const startLine = line;
    const startCol = col();
    // A string, possibly with a prefix: the identifier branch hands over when the identifier is a prefix followed by a quote.
    let prefix = '';
    let strAt = -1;
    if (c === '"' || c === "'") {
      strAt = i;
    } else if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      if (j < n && (src[j] === '"' || src[j] === "'") && STRING_PREFIX.test(word)) {
        prefix = word.toLowerCase();
        strAt = j;
      } else {
        toks.push({ t: 'name', v: word, line: startLine, col: startCol });
        i = j;
        continue;
      }
    }
    if (strAt >= 0) {
      const q = src[strAt];
      const triple = src[strAt + 1] === q && src[strAt + 2] === q;
      let j = strAt + (triple ? 3 : 1);
      const bodyStart = j;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          // An escape (also in a raw string, for the purpose of finding the end): the next character is not a terminator.
          if (src[j + 1] === '\n') {
            line++;
            lineStart = j + 2;
          }
          j += 2;
          continue;
        }
        if (ch === '\n') {
          if (!triple) break; // a single-quoted string cannot span a line
          line++;
          lineStart = j + 1;
          j++;
          continue;
        }
        if (ch === q && (!triple || (src[j + 1] === q && src[j + 2] === q))) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) throw new PyParseError('a string literal is never closed', startLine, startCol);
      const body = src.slice(bodyStart, j);
      toks.push({ t: 'str', v: src.slice(i, j + (triple ? 3 : 1)), line: startLine, col: startCol, prefix, body });
      i = j + (triple ? 3 : 1);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), line: startLine, col: startCol });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const op = THREE_OPS.has(three) ? three : TWO_OPS.has(two) ? two : c;
    toks.push({ t: 'op', v: op, line: startLine, col: startCol });
    i += op.length;
  }
  return toks;
}

// --- Analysis -------------------------------------------------------------------------------------------------------

const AGENT_SIGNATURE_MODEL_SLOT = 5;
const AGENT_SIGNATURE_TYPE_NAME_SLOT = 3;
/** Names the analysis cannot see through. Matched as bare names, never after a `.` (`re.compile` is an attribute). */
/** `runpy`, `pkgutil` and `zipimport` load and run code by name or path, like `importlib`: the code they run cannot be seen. */
const RESTRICTED_NAMES = new Set([
  'exec', 'eval', 'compile', 'importlib', '__import__', 'globals', 'locals', 'vars', '__builtins__', 'builtins', 'runpy', 'pkgutil', 'zipimport'
]);
const FSTRING_RESTRICTED = /\b(?:agent|exec|eval|compile|importlib|__import__|globals|locals|vars|__builtins__|builtins|runpy|pkgutil|zipimport)\b/;

export interface AnalysisContext {
  /** The session model (the ceiling is derived from it). */
  sessionModel: string;
  /** What the user said in this turn (a model named there passes). */
  lastUserInput?: string;
  /** Where `type_name` definitions are looked up. */
  definitions?: DefinitionResolver;
  /** Collects every literal model that was ranked, and whether one passed by instruction. */
  seen: { models: string[]; instructed: boolean };
  /** The directories a local import is looked for in: the script's own directory (a `ScriptPath`) and its `Cwd`. Empty or absent: no import is local. */
  localModuleDirs?: readonly string[];
}

/**
 * The top-level names of the Python standard library: `sys.stdlib_module_names` of CPython 3.12.13 (the 3.12 list; a later
 * release only adds and removes a few). A namespace directory (a `<name>/` with no `__init__.py`) never shadows a stdlib
 * module, because a regular module found later on the path wins over a namespace portion, so such a directory is local only
 * for a name that is NOT in this list. Regenerate with `python3.12 -c "import sys; print(sorted(sys.stdlib_module_names))"`.
 */
const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([
  '__future__', '_abc', '_aix_support', '_ast', '_asyncio', '_bisect', '_blake2', '_bz2', '_codecs', '_codecs_cn',
  '_codecs_hk', '_codecs_iso2022', '_codecs_jp', '_codecs_kr', '_codecs_tw', '_collections', '_collections_abc',
  '_compat_pickle', '_compression', '_contextvars', '_crypt', '_csv', '_ctypes', '_curses', '_curses_panel',
  '_datetime', '_dbm', '_decimal', '_elementtree', '_frozen_importlib', '_frozen_importlib_external', '_functools',
  '_gdbm', '_hashlib', '_heapq', '_imp', '_io', '_json', '_locale', '_lsprof', '_lzma', '_markupbase', '_md5',
  '_msi', '_multibytecodec', '_multiprocessing', '_opcode', '_operator', '_osx_support', '_overlapped', '_pickle',
  '_posixshmem', '_posixsubprocess', '_py_abc', '_pydatetime', '_pydecimal', '_pyio', '_pylong', '_queue', '_random',
  '_scproxy', '_sha1', '_sha2', '_sha3', '_signal', '_sitebuiltins', '_socket', '_sqlite3', '_sre', '_ssl', '_stat',
  '_statistics', '_string', '_strptime', '_struct', '_symtable', '_thread', '_threading_local', '_tkinter',
  '_tokenize', '_tracemalloc', '_typing', '_uuid', '_warnings', '_weakref', '_weakrefset', '_winapi', '_wmi',
  '_zoneinfo', 'abc', 'aifc', 'antigravity', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'audioop', 'base64',
  'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib',
  'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal',
  'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl',
  'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass',
  'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib',
  'imghdr', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder',
  'msilib', 'msvcrt', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'nt', 'ntpath', 'nturl2path', 'numbers',
  'opcode', 'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile', 'sre_constants',
  'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'this',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc',
  'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv',
  'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
  'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

/** File names of a compiled or source module the import machinery loads for `name`: `<name>.py|pyw|pyc|so|pyd`, `<name>.cpython-*.so`, `<name>.abi3.so`, `<name>.*.pyd`. */
function isModuleFile(entry: string, name: string): boolean {
  if (!entry.startsWith(`${name}.`)) return false;
  const ext = entry.slice(name.length + 1);
  if (['py', 'pyw', 'pyc', 'so', 'pyd'].includes(ext)) return true;
  // `<name>.cpython-312-x86_64-linux-gnu.so`, `<name>.abi3.so`, `<name>.cp312-win_amd64.pyd`: a tag, then the extension.
  return /^[A-Za-z0-9_.-]+\.(so|pyd)$/.test(ext);
}

/**
 * Is `name` a sibling module the import machinery would load from one of `dirs`? A source or compiled file (see
 * `isModuleFile`), a package directory (`<name>/__init__.py`, `.pyc` or extension), or a namespace directory (no
 * `__init__`) for a name that is not a standard library module (see `PYTHON_STDLIB_MODULES`). Never throws.
 */
function isLocalModule(name: string, dirs: readonly string[]): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      try {
        const isFile = e.isFile() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isFile());
        if (isFile && isModuleFile(e.name, name)) return true;
        if (e.name !== name) continue;
        const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory());
        if (!isDir) continue;
        const inner = fs.readdirSync(path.join(dir, name));
        const regular = inner.some((f) => f === '__init__.py' || f === '__init__.pyc' || (f.startsWith('__init__.') && /\.(so|pyd)$/.test(f)));
        if (regular || !PYTHON_STDLIB_MODULES.has(name)) return true;
      } catch {
        // unreadable entry: not a module we can name
      }
    }
  }
  return false;
}

const clip = (s: string, max = 48): string => {
  const one = s.replace(/[\r\n\t]+/g, ' ');
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

type Arg = { start: number; end: number; keyword: string | null; positional: number | null; star: boolean };

/** The arguments of the call whose `(` is at `open`: token ranges split at depth-1 commas. Returns null when the parentheses never balance. */
function parseArgs(toks: Tok[], open: number): { args: Arg[]; close: number } | null {
  let depth = 0;
  let start = open + 1;
  const ranges: Array<[number, number]> = [];
  for (let k = open; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      depth--;
      if (depth === 0) {
        if (k > start) ranges.push([start, k]);
        return { args: classify(toks, ranges), close: k };
      }
      if (depth < 0) return null;
    } else if (t.v === ',' && depth === 1) {
      ranges.push([start, k]);
      start = k + 1;
    }
  }
  return null;
}

function classify(toks: Tok[], ranges: Array<[number, number]>): Arg[] {
  const args: Arg[] = [];
  let positional = 0;
  for (const [start, end] of ranges) {
    if (end <= start) continue; // a trailing comma
    const first = toks[start];
    if (first.t === 'op' && (first.v === '**' || first.v === '*')) {
      args.push({ start, end, keyword: null, positional: null, star: true });
    } else if (first.t === 'name' && toks[start + 1]?.t === 'op' && toks[start + 1].v === '=' && end > start + 2) {
      args.push({ start: start + 2, end, keyword: first.v, positional: null, star: false });
    } else {
      args.push({ start, end, keyword: null, positional: positional++, star: false });
    }
  }
  return args;
}

/** The expression's tokens with redundant outer parentheses removed. */
function unwrap(toks: Tok[], start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (e - s >= 2 && toks[s].t === 'op' && toks[s].v === '(' && toks[e - 1].t === 'op' && toks[e - 1].v === ')') {
    // The opening parenthesis must close at the last token, not earlier.
    let depth = 0;
    let closesAt = -1;
    for (let k = s; k < e; k++) {
      const t = toks[k];
      if (t.t !== 'op') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        depth--;
        if (depth === 0) {
          closesAt = k;
          break;
        }
      }
    }
    if (closesAt !== e - 1) break;
    s++;
    e--;
  }
  return [s, e];
}

type Value = { kind: 'absent' } | { kind: 'literal'; text: string } | { kind: 'dynamic'; why: string };

function valueOf(toks: Tok[], arg: Arg | undefined): Value {
  if (!arg) return { kind: 'absent' };
  const [s, e] = unwrap(toks, arg.start, arg.end);
  if (e - s === 1) {
    const t = toks[s];
    if (t.t === 'name' && t.v === 'None') return { kind: 'absent' };
    if (t.t === 'str') {
      if (t.prefix?.includes('f')) return { kind: 'dynamic', why: 'an f-string' };
      if (t.prefix?.includes('b')) return { kind: 'dynamic', why: 'a bytes literal' };
      if ((t.body ?? '').includes('\\')) return { kind: 'dynamic', why: 'a string literal with an escape' };
      return { kind: 'literal', text: (t.body ?? '').trim() };
    }
  }
  if (e - s === 0) return { kind: 'dynamic', why: 'an empty expression' };
  if (toks.slice(s, e).every((t) => t.t === 'str')) return { kind: 'dynamic', why: 'a string concatenation' };
  if (e - s === 1 && toks[s].t === 'name') return { kind: 'dynamic', why: `the variable \`${clip(toks[s].v)}\`` };
  return { kind: 'dynamic', why: 'an expression' };
}

function recognisedModel(model: string): boolean {
  return /^(?:flash_lite|flash-lite|flash|pro)$/i.test(model) || /^(?:gemini|claude|hydrogen|argon)/i.test(model);
}

/** Analyse one script's text. Pushes the facts it read into `facts`. Never throws. */
export function analyzePythonScript(script: string, label: string, ctx: AnalysisContext, facts: ScriptFact[]): CallSite[] {
  const sites: CallSite[] = [];
  const bytes = Buffer.byteLength(script);
  if (bytes > MAX_SCRIPT_BYTES) {
    return [{ file: label, line: 1, col: 1, reason: `script is over the ${MAX_SCRIPT_BYTES} byte limit`, kind: 'unverifiable' }];
  }
  facts.push(scriptFact(label, script));
  let toks: Tok[];
  try {
    toks = tokenizePython(script);
  } catch (err) {
    const e = err as PyParseError;
    return [{ file: label, line: e.line ?? 1, col: e.col ?? 1, reason: `the script could not be tokenized (${e.message})`, kind: 'unverifiable' }];
  }
  const site = (t: Tok, reason: string): void => {
    sites.push({ file: label, line: t.line, col: t.col, reason, kind: 'unverifiable' });
  };
  const sessionRank = subagentCeilingRank(ctx.sessionModel);
  const ceilingTier = rankToTierName(sessionRank);
  const orchestrator = isOrchestratorModel(ctx.sessionModel);

  /** Rank one literal model for the call at `at`. */
  const rankLiteral = (model: string, at: Tok, source: string): void => {
    const m = model.toLowerCase();
    if (m === '' || m === 'inherit') {
      inheritOrchestrator(at, source);
      return;
    }
    if (m.includes('free') || m.includes('openrouter')) {
      site(at, `${source} model '${clip(model)}' is not an Antigravity subagent model (use jev_execute_free or jev_agent_free for free-tier work)`);
      return;
    }
    if (!recognisedModel(m)) {
      site(at, `${source} model '${clip(model)}' is not a model Jev can rank (use inherit, flash_lite, flash or pro)`);
      return;
    }
    ctx.seen.models.push(clip(m));
    const rank = modelTierRank(m);
    if (rank <= sessionRank) return;
    if (isExplicitProOverride(ctx.lastUserInput, m)) {
      ctx.seen.instructed = true;
      return;
    }
    sites.push({
      file: label,
      line: at.line,
      col: at.col,
      reason: `${source} model '${clip(model)}' is above the session ceiling '${ceilingTier}'`,
      kind: 'elevation',
      requested: m,
      tier: rankToTierName(rank) as 'flash_lite' | 'flash' | 'pro',
      rank
    });
  };
  const inheritOrchestrator = (at: Tok, source: string): void => {
    if (orchestrator) site(at, `${source} has no explicit model under an Orchestrator session (set model to "flash" or "flash_lite")`);
  };

  const localDirs = ctx.localModuleDirs ?? [];
  /** The first token of a statement: first on its line, or right after `;` or `:` (a one-line `if x: import y`). */
  const statementStart = (i: number): boolean => {
    const prev = toks[i - 1];
    return !prev || prev.line < toks[i].line || (prev.t === 'op' && (prev.v === ';' || prev.v === ':'));
  };
  /** An `import` or `from ... import` at `i` whose module is a sibling file or package, or relative: one unverifiable site. */
  const checkImport = (i: number): void => {
    const t = toks[i];
    const tops: string[] = [];
    let relative = false;
    if (t.v === 'from') {
      let j = i + 1;
      while (toks[j]?.t === 'op' && (toks[j].v === '.' || toks[j].v === '...')) {
        relative = true;
        j++;
      }
      if (toks[j]?.t === 'name' && toks[j].v !== 'import') tops.push(toks[j].v);
      while (toks[j]?.t === 'name' && toks[j].v !== 'import') {
        j++;
        if (toks[j]?.t === 'op' && toks[j].v === '.') j++;
        else break;
      }
      if (!(toks[j]?.t === 'name' && toks[j].v === 'import')) return; // not an import statement (`yield from`, `raise ... from`)
    } else {
      let j = i + 1;
      for (;;) {
        if (toks[j]?.t !== 'name') break;
        tops.push(toks[j].v);
        j++;
        while (toks[j]?.t === 'op' && toks[j].v === '.' && toks[j + 1]?.t === 'name') j += 2;
        if (toks[j]?.t === 'name' && toks[j].v === 'as') j += 2;
        if (toks[j]?.t === 'op' && toks[j].v === ',') j++;
        else break;
      }
    }
    const local = relative ? 'a relative' : tops.find((n) => isLocalModule(n, localDirs));
    if (!local) return;
    site(
      t,
      relative
        ? 'a relative import brings in a local file the analysis cannot see (inline the agent() calls or remove the local import)'
        : `the import of '${clip(local as string)}' brings in a sibling file or package (next to the script or under its Cwd) the analysis cannot see (inline the agent() calls or remove the local import)`
    );
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'name' && (t.v === 'import' || t.v === 'from') && !(toks[i - 1]?.t === 'op' && toks[i - 1].v === '.') && statementStart(i)) checkImport(i);
    if (t.t === 'str') {
      if (t.prefix?.includes('f') && FSTRING_RESTRICTED.test(t.body ?? '') && (t.body ?? '').includes('{')) {
        site(t, 'an f-string expression names agent, exec, eval, compile, importlib or a similar escape');
      }
      continue;
    }
    if (t.t !== 'name') continue;
    const prev = toks[i - 1];
    const afterDot = prev?.t === 'op' && prev.v === '.';
    if (RESTRICTED_NAMES.has(t.v) && !afterDot) {
      site(t, `\`${t.v}\` is not analysable`);
      continue;
    }
    if (t.v !== 'agent') continue;
    const next = toks[i + 1];
    const direct = next?.t === 'op' && next.v === '(' && !afterDot && !(prev?.t === 'name' && (prev.v === 'def' || prev.v === 'class'));
    if (!direct) {
      site(t, 'agent is used other than as a direct call agent(...) (aliasing, a reference, an attribute, a definition or an import)');
      continue;
    }
    const parsed = parseArgs(toks, i + 1);
    if (!parsed) {
      site(t, 'the parentheses of this agent(...) call never balance');
      continue;
    }
    const { args } = parsed;
    if (args.some((a) => a.star)) {
      site(t, 'agent(...) is called with *args or **kwargs, so its model cannot be known');
      continue;
    }
    const models = args.filter((a) => a.keyword === 'model' || a.positional === AGENT_SIGNATURE_MODEL_SLOT);
    if (models.length > 1) {
      site(t, 'agent(...) names its model more than once');
      continue;
    }
    const modelArg = models[0];
    const typeArgs = args.filter((a) => a.keyword === 'type_name' || a.positional === AGENT_SIGNATURE_TYPE_NAME_SLOT);
    const mv = valueOf(toks, modelArg);
    if (mv.kind === 'dynamic') {
      site(t, `agent(...) model is ${mv.why}, not a string literal`);
      continue;
    }
    if (mv.kind === 'literal') {
      rankLiteral(mv.text, t, 'agent(...)');
      continue;
    }
    // No model: the call runs on the session model, unless type_name names a definition with a model of its own.
    if (typeArgs.length > 1) {
      site(t, 'agent(...) names its type_name more than once');
      continue;
    }
    const tv = valueOf(toks, typeArgs[0]);
    if (tv.kind === 'dynamic') {
      site(t, `agent(...) has no model and its type_name is ${tv.why}, so the model it runs on cannot be known`);
      continue;
    }
    const typeName = tv.kind === 'literal' ? tv.text : 'self';
    if (typeName === 'self' || typeName === '') {
      inheritOrchestrator(t, 'agent(...)');
      continue;
    }
    const def = (ctx.definitions ?? NO_DEFINITIONS).definition(typeName);
    if (!def.found) {
      site(t, `agent(...) has no model and its type_name '${clip(typeName)}' has no definition Jev can read (set model explicitly)`);
    } else if (def.model === '<unreadable>') {
      site(t, `agent(...) has no model and the definition of type_name '${clip(typeName)}' is unreadable`);
    } else if (def.model === null) {
      inheritOrchestrator(t, `agent(...) of type_name '${clip(typeName)}'`);
    } else {
      rankLiteral(def.model, t, `the definition of type_name '${clip(typeName)}'`);
    }
  }
  return sites;
}

/** The script texts a `run_workflow` call names, with the casing the real tool uses (`Script`, `ScriptPath`, `Cwd`) and the lowercase fallbacks. */
function pickString(args: Record<string, unknown>, keys: string[]): { present: boolean; value: string | null } {
  for (const k of keys) {
    if (args[k] !== undefined) return { present: true, value: typeof args[k] === 'string' && args[k] !== '' ? (args[k] as string) : null };
  }
  return { present: false, value: null };
}

export interface WorkflowInputContext {
  /** The hook's working directory (a relative ScriptPath is resolved against `Cwd`, then this, then the first workspace path). */
  cwd?: string;
  workspacePaths?: string[];
}

/**
 * Decide a `run_workflow` call from its args. Understood: `{Script}`, `{ScriptPath, Cwd?, Args?}`, and the lowercase /
 * snake_case spellings. Every present source is analysed. An input with none of them (or the wrong types) is unverifiable.
 * Never throws.
 */
export function evaluateWorkflowInput(args: unknown, where: WorkflowInputContext, ctx: Omit<AnalysisContext, 'seen'>): WorkflowDecision {
  const scripts: ScriptFact[] = [];
  const seen = { models: [] as string[], instructed: false };
  const g: AnalysisContext = { ...ctx, seen };
  const finish = (sites: CallSite[]): WorkflowDecision => {
    const elevations = sites.filter((s) => s.kind === 'elevation');
    const unverifiable = sites.filter((s) => s.kind === 'unverifiable');
    const highest = [...elevations].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0];
    return {
      decision: sites.length === 0 ? 'allow' : 'ask',
      sites,
      elevations,
      unverifiable,
      models: [...new Set(seen.models)],
      instructed: seen.instructed,
      ...(highest ? { highest } : {}),
      scripts
    };
  };
  const shape = (reason: string): WorkflowDecision => finish([{ file: '<tool_input>', line: 0, col: 0, reason, kind: 'unverifiable' }]);

  if (!args || typeof args !== 'object' || Array.isArray(args)) return shape('run_workflow args are not an object');
  const a = args as Record<string, unknown>;
  const inline = pickString(a, ['Script', 'script']);
  const file = pickString(a, ['ScriptPath', 'script_path', 'scriptPath']);
  if (!inline.present && !file.present) return shape('run_workflow args have neither Script nor ScriptPath');
  if (inline.present && inline.value === null) return shape('run_workflow Script is not a non-empty string');
  if (file.present && file.value === null) return shape('run_workflow ScriptPath is not a non-empty string');

  const sites: CallSite[] = [];
  try {
    const cwdArg = pickString(a, ['Cwd', 'cwd']).value;
    if (inline.value !== null) {
      // An inline script has no directory of its own: a local import is looked for under its Cwd (else the hook's).
      const inlineBase = cwdArg ?? where.cwd ?? where.workspacePaths?.[0];
      sites.push(...analyzePythonScript(inline.value, '<inline>', { ...g, localModuleDirs: inlineBase ? [path.resolve(inlineBase)] : [] }, scripts));
    }
    if (file.value !== null) {
      const base = cwdArg ?? where.cwd ?? where.workspacePaths?.[0] ?? process.cwd();
      const resolved = path.resolve(base, file.value);
      const read = readRegularFile(resolved, MAX_SCRIPT_BYTES);
      // The script's own directory first, then its Cwd.
      if (read.kind === 'ok') sites.push(...analyzePythonScript(read.text, resolved, { ...g, localModuleDirs: [path.dirname(resolved), path.resolve(base)] }, scripts));
      else if (read.kind === 'too-large') sites.push({ file: resolved, line: 0, col: 0, reason: `${read.size} bytes, over the ${MAX_SCRIPT_BYTES} byte limit`, kind: 'unverifiable' });
      else if (read.kind === 'not-regular') sites.push({ file: resolved, line: 0, col: 0, reason: 'not a regular file (missing, a directory or a FIFO)', kind: 'unverifiable' });
      else sites.push({ file: resolved, line: 0, col: 0, reason: `cannot be read (${clip(read.message, 80)})`, kind: 'unverifiable' });
    }
  } catch (err) {
    sites.push({ file: '<guard>', line: 0, col: 0, reason: `workflow analysis failed (${err instanceof Error ? clip(err.message, 80) : 'error'})`, kind: 'unverifiable' });
  }
  return finish(sites);
}

// --- Texts ----------------------------------------------------------------------------------------------------------

function siteLines(sites: readonly CallSite[]): string {
  const shown = sites.slice(0, MAX_LISTED).map((s) => `- ${s.file}:${s.line}:${s.col} ${s.reason}`);
  if (sites.length > MAX_LISTED) shown.push(`- and ${sites.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/** The ids the question names: the first three script hashes, `sha256:<12hex>`. Never script text. */
export function scriptIds(scripts: readonly ScriptFact[]): string {
  return scripts.slice(0, 3).map((s) => `sha256:${s.sha256.slice(0, 12)}`).join(', ') || 'unhashed';
}

/** A stable signature of a workflow call for the attempt counter: the hashes of the analysed texts, never the text. */
export function workflowSignature(scripts: readonly ScriptFact[]): string {
  return `wf:${digest16(scripts.map((s) => `${s.label}\u0000${s.sha256}\u0000`).join(''), 'sha1')}`;
}

/** The deny reason for a script the analysis cannot clear (choice and clamp; only dialog mode asks): the sites by position and reason, and what to change. No script text. */
export function workflowUnverifiableReason(d: Pick<WorkflowDecision, 'sites' | 'unverifiable'>, sessionModel: string, scripts: readonly ScriptFact[]): string {
  return (
    `[jev] This run_workflow script (${scriptIds(scripts)}) cannot be cleared against the session model '${sessionModel}': ` +
    `${d.sites.length} site(s) Jev cannot verify (${d.unverifiable.length} unverifiable):\n${siteLines(d.sites)}\n` +
    'Change the script so every agent(...) call names a literal model (a plain string such as "flash", "flash_lite" or "pro", no variables, f-strings, expressions, *args or **kwargs) ' +
    'at or below the session ceiling, or inherits it (not under an Orchestrator), and so that agent is only ever called directly, and so that it imports no local file ' +
    '(inline the agent(...) calls or remove the local import; the standard library and installed packages are fine); then call run_workflow again. ' +
    'Do not ask the user about this: it is fixed in the script.'
  );
}

/** The deny reason of the choice flow for a script: the same marker and four options as an invoke_subagent elevation, naming the script by its hash. */
export function workflowChoiceReason(top: CallSite, ceilingTier: string, scripts: readonly ScriptFact[], attempt: number): string {
  const tier = top.tier ?? 'pro';
  const ids = scriptIds(scripts);
  const o = CHOICE_OPTIONS;
  const stop = stopRetryingText(attempt, tier, ceilingTier, 'ask_question', 'model');
  return (
    `[jev] This run_workflow script (${ids}) has agent(...) calls on model '${tier}', above session ceiling '${ceilingTier}', and no approval covers it. ` +
    `Ask the user with ask_question: one question whose text starts with '${ELEVATE_MARKER_PREFIX}${tier}]' followed by a short question naming the script (${ids}), ` +
    `the strongest requested model and the session ceiling, with four options in this order: '${o.once}', '${o.fiveMin}', '${o.session}', '${o.no(ceilingTier)}'. ` +
    `If the user approves, call run_workflow again unchanged; if No, change the agent(...) calls to '${ceilingTier}' (or 'flash_lite') and call it again, or do the work directly; ` +
    'do not ask in any other form.' +
    (stop ? ` ${stop}` : '')
  );
}

function workflowDialogReason(d: WorkflowDecision, ceilingTier: string, scripts: readonly ScriptFact[]): string {
  return (
    `[jev] This run_workflow script (${scriptIds(scripts)}) launches agents Jev cannot clear against session ceiling '${ceilingTier}':\n${siteLines(d.sites)}\n` +
    'Approve to run it as it is, or cancel.'
  );
}

// --- The hook decision ----------------------------------------------------------------------------------------------

export interface WorkflowCallDeps {
  mode: JevMode;
  /** The session model (from the hook's session sync); the ceiling is derived from it. */
  sessionModel?: string;
  approvals?: ApprovalStore;
  config?: ModeChangeConfigLike;
  now?: () => number;
  /** The pin directory (script hashes keyed by toolCall.id, for the drift recorder); absent means no pin is written. */
  pinDir?: string;
  /** `JEV_ELEVATION`: `dialog` asks, anything else (`choice`, `clamp`, unset) never asks. */
  elevationMode?: 'choice' | 'dialog' | 'clamp';
  definitions?: DefinitionResolver;
}

export interface WorkflowCallResult {
  decision: AntigravityHookDecision;
  /** `workflow_guard`, `workflow_models`, `workflow_scripts` and the counts: never script text. */
  log: Record<string, unknown>;
}

/** `JEV_ELEVATION` as the Antigravity guards read it. */
export function antigravityElevationMode(env: Readonly<Record<string, string | undefined>> = process.env): 'choice' | 'dialog' | 'clamp' {
  return env.JEV_ELEVATION === 'dialog' || env.JEV_ELEVATION === 'clamp' ? env.JEV_ELEVATION : 'choice';
}

/**
 * The guard's verdict for one PreToolUse `run_workflow` call. A mode without decisions passes untouched (no analysis, no
 * pin). An internal error fails open (`workflow_guard: "error"`), never a block; a script the analysis cannot understand
 * is not an internal error: it is unverifiable.
 */
export function evaluateAntigravityWorkflowCall(input: AntigravityHookInput, deps: WorkflowCallDeps): WorkflowCallResult {
  const pass: WorkflowCallResult = { decision: { decision: 'pass' }, log: {} };
  if (input?.toolCall?.name !== RUN_WORKFLOW_TOOL) return pass;
  if (!modeBehaviour(deps.mode).decisions) return { decision: { decision: 'pass' }, log: { workflow_guard: 'skipped' } };
  try {
    const sessionId = safeSessionId(input.conversationId) || 'default-session';
    const rawId = input.conversationId;
    // An id that was sent but has nothing safe in it means no stored state (not the shared default-session file).
    const approvals = typeof rawId === 'string' && rawId.length > 0 && !safeSessionId(rawId) ? undefined : deps.approvals;
    const nowMs = (deps.now ?? Date.now)();
    const sessionModel = deps.sessionModel || input.modelName || DEFAULT_ANTIGRAVITY_SESSION_MODEL;
    const ceilingTier = rankToTierName(subagentCeilingRank(sessionModel));
    const d = evaluateWorkflowInput(
      input.toolCall?.args,
      { cwd: input.cwd, workspacePaths: input.workspacePaths },
      {
        sessionModel,
        lastUserInput: input.lastUserInput,
        definitions: deps.definitions ?? fsDefinitionResolver([input.cwd, ...(input.workspacePaths ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0))
      }
    );
    const base = {
      workflow_models: d.models,
      workflow_scripts: d.scripts.map((s) => ({ label: s.label, sha256: s.sha256, bytes: s.bytes }))
    };
    const toolCallId = input.toolCall?.id;
    const pin = (decision: 'allow' | 'ask'): void => {
      if (deps.pinDir && toolCallId) writeWorkflowPin(deps.pinDir, toolCallId, input.conversationId, decision, d.scripts);
    };
    const finish = (guard: string, decision: AntigravityHookDecision, extra: Record<string, unknown> = {}): WorkflowCallResult => ({
      decision,
      log: { workflow_guard: guard, ...base, ...extra }
    });

    if (d.decision === 'allow') {
      pin('allow');
      return d.instructed ? finish('passed-instructed', { decision: 'allow', elevation: 'instructed' }) : finish('allow', { decision: 'pass' });
    }

    const elevationMode = deps.elevationMode ?? antigravityElevationMode();
    // Dialog mode keeps its dialog for everything the guard found. Choice and clamp never ask (a harness that auto-approves
    // would approve it unseen): a script cannot be clamped, so an elevation takes the choice flow in both, and anything the
    // analysis cannot prove is denied with what to fix.
    if (elevationMode === 'dialog') {
      pin('ask');
      return finish(
        'asked',
        {
          decision: 'ask',
          reason: workflowDialogReason(d, ceilingTier, d.scripts),
          elevation: 'asked',
          ...(detectAntigravityAutoApprove() ? { autoApproveWarning: true as const } : {})
        },
        { workflow_reasons: d.sites.length }
      );
    }

    const top = d.highest;
    if (d.unverifiable.length > 0 || !top || !top.tier) {
      return finish('denied-unverifiable', { decision: 'deny', reason: workflowUnverifiableReason(d, sessionModel, d.scripts), elevation: 'denied' }, { workflow_reasons: d.sites.length });
    }

    // The tier name stands for the model in the marker and in the approval store: the marker regex takes [a-z0-9_-] only,
    // and an approval of a tier covers every model of that tier or below.
    const claimed = approvals?.claim(sessionId, top.tier, nowMs) ?? null;
    if (claimed) {
      pin('allow');
      return finish('allow', { decision: 'allow', elevation: 'approved', approvalScope: claimed.scope }, { workflow_highest: top.tier });
    }
    const promptHash = input.lastUserInput ? digest16(input.lastUserInput, 'sha256') : 'no-prompt';
    const choice = resolveChoiceElevation({
      approvalStore: approvals,
      sessionId,
      requestedModel: top.tier,
      typeName: 'run_workflow',
      sessionCeilingTier: ceilingTier,
      isOrchestrator: isOrchestratorModel(sessionModel),
      nowMs,
      transcriptPath: input.transcriptPath,
      promptHash,
      signature: workflowSignature(d.scripts),
      config: deps.config,
      reasonOverride: (attempt) => workflowChoiceReason(top, ceilingTier, d.scripts, attempt)
    });
    if (choice.decision === 'allow') pin('allow');
    return finish(choice.decision === 'allow' ? 'allow' : 'denied', choice, { workflow_highest: top.tier });
  } catch {
    return { decision: { decision: 'pass' }, log: { workflow_guard: 'error' } };
  }
}
