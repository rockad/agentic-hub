/**
 * Subagent definition lookup for the Workflow guard: the `model:` and `effort:` a `.claude/agents/<name>.md`
 * file sets, read strictly. Lookup order, nearest first (the design is cognitive-engine's, same owner):
 *   1. `.claude/agents` in the hook cwd and each parent up to the project root (`CLAUDE_PROJECT_DIR` when set,
 *      else the git root, else the filesystem root), plus `$CLAUDE_PROJECT_DIR/.claude/agents` when the cwd is
 *      outside it. Claude Code loads project agents from the project root, so EVERY project-level definition
 *      of the name is read; when they disagree the answer is unreadable (the guard asks);
 *   2. the user config dir's `agents/` (`CLAUDE_CONFIG_DIR` when set and non-empty, replacing `~/.claude`
 *      entirely; a relative value is resolved against the hook cwd);
 *   3. installed plugins' `agents/`, through `<config dir>/plugins/installed_plugins.json` (enabled plugins first
 *      per `enabledPlugins`, then the rest). A namespaced name `plugin:agent` only looks in that plugin.
 *
 * Every `.md` file under a directory is read and matched on its front matter `name:` (or its file name when it
 * has none), as Claude Code registers agents. A conflict (two claimants, a file called `<name>.md` that declares
 * another name, an unreadable block) is `unreadable`, never a guess. The name is restricted to file-name
 * characters (one `:` allowed, the plugin separator), so a path-like name never escapes the directories.
 * This module never decides to allow: a name that resolves to nothing is `found: false`, which the guard asks about.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRegularFile } from './safe-read.js';

/** Settings and plugin registry files are small JSON; anything bigger is not read. */
const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

export interface AgentDefinition {
  /** A definition file exists in one of the lookup locations. */
  found: boolean;
  /** The `model:` of the first definition found; null when it sets none (it inherits). */
  model: string | null;
  /** The `effort:` as written; absent when the definition sets none. */
  effort?: string | null;
  /** Set when the definition's model, effort or name could not be established; the guard asks with this text. */
  unreadable?: string;
}

/** Claude Code's built-in subagent types: they have no definition file and run on the session model. */
export const BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'claude']);

/**
 * INTERIM threshold on a subagent's reasoning effort (cognitive-engine docs/rfc/007, no spec behind it):
 * `xhigh` and `max` ask, `low`, `medium` and `high` pass, anything else cannot be checked and asks.
 */
/** A script-supplied literal as it may appear in an ask reason or the decisions log: clipped, so a long string never carries script text out. */
export const clip = (s: string, max = 48): string => (s.length > max ? `${s.slice(0, max)}…` : s);

const EFFORT_ASK: ReadonlySet<string> = new Set(['xhigh', 'max']);
const EFFORT_PASS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/** The ask reason for one `effort` value, or null when it passes. `what` names where it came from. */
export function effortReason(effort: unknown, what: string): string | null {
  if (typeof effort !== 'string') {
    return `${what}: effort is ${effort === null ? 'null' : `a ${typeof effort}`}, not a string, so it cannot be checked.`;
  }
  if (EFFORT_ASK.has(effort)) {
    return `${what}: effort ${JSON.stringify(clip(effort))} is above the interim effort threshold (xhigh and max ask; low, medium and high pass). The model ceiling does not bound effort, so this needs your approval.`;
  }
  if (EFFORT_PASS.has(effort)) return null;
  return `${what}: effort ${JSON.stringify(clip(effort))} is not a level Jev recognises (low, medium, high, xhigh, max), so it cannot be checked.`;
}

/**
 * The Agent path's INTERIM effort rule: `effortReason` for a literal `xhigh` or `max` only. Unrecognised levels,
 * non-string values and the comparison with the session's effort are deliberately not checked there (RFC 007 says do
 * not build further); the Workflow guard keeps the full `effortReason`.
 */
export function agentEffortReason(effort: unknown, what: string): string | null {
  return typeof effort === 'string' && EFFORT_ASK.has(effort) ? effortReason(effort, what) : null;
}

// ── Environment overrides of the subagent model ──
//
// Claude Code lets the environment set the model of a subagent: `CLAUDE_CODE_SUBAGENT_MODEL` (the default for
// subagents that name no model), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (that model replaces the call's and the
// definition's) and, for agents spawned inside a Workflow only, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`. The hook
// process's environment is assumed to match the one Claude Code runs with. The FORCE and workflow details
// were read from the Claude Code 2.1.321 binary by cognitive-engine: version-bound. One function serves the
// Workflow guard and the Agent/Task guard, so the two paths cannot disagree.

export type Env = Readonly<Record<string, string | undefined>>;
export type ModelSource = 'call' | 'definition' | 'ladder' | 'env' | 'env-forced' | 'workflow-env' | 'session';
export interface ModelCandidate {
  /** Null: the session model. */
  model: string | null;
  source: ModelSource;
}

const envModel = (v: string | undefined): string | null => {
  const m = v?.trim() ?? '';
  return m === '' || m.toLowerCase() === 'inherit' ? null : m;
};

/** True for the values that mean "run on the session model": absent, empty or `inherit`. */
export const inheritsSessionModel = (model: string | null | undefined): boolean => model === undefined || model === null || ['', 'inherit'].includes(String(model).trim().toLowerCase());

/** Is `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on (1, true, yes, on)? */
export const subagentModelForced = (env: Env): boolean => ['1', 'true', 'yes', 'on'].includes((env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? '').trim().toLowerCase());

/**
 * Every model a subagent can run on, given what the call, its definition, a ladder pin and the environment say. One
 * entry, except when two forced sources disagree about which wins (a workflow model and a forced model both set).
 * - `workflow` only (an agent() call in a Workflow): `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` replaces the call's and
 *   the definition's model. The Agent tool never applies it.
 * - `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on: the forced model replaces both, `inherit` on the call included
 *   (the stricter reading: one spurious ask if the binary is right, a silent escalation if the docs are).
 * - Otherwise the call's model, else the definition's, else a `jev-ladder-<id>` pin (`ladder`), else
 *   `CLAUDE_CODE_SUBAGENT_MODEL`, else the session model.
 */
export function subagentModelCandidates(input: { call?: string; definition?: string | null; ladder?: string | null }, env: Env, opts: { workflow?: boolean } = {}): ModelCandidate[] {
  const workflowModel = opts.workflow ? envModel(env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL) : null;
  const model = envModel(env.CLAUDE_CODE_SUBAGENT_MODEL);
  const force = subagentModelForced(env);
  if (workflowModel) {
    const out: ModelCandidate[] = [{ model: workflowModel, source: 'workflow-env' }];
    if (force && model && model !== workflowModel) out.push({ model, source: 'env-forced' });
    return out;
  }
  if (force) return model ? [{ model, source: 'env-forced' }] : [{ model: null, source: 'session' }];
  if (input.call !== undefined && input.call.trim() !== '') return [{ model: input.call, source: 'call' }];
  if (input.definition !== undefined && input.definition !== null && input.definition.trim() !== '') return [{ model: input.definition, source: 'definition' }];
  if (input.ladder !== undefined && input.ladder !== null && input.ladder.trim() !== '') return [{ model: input.ladder, source: 'ladder' }];
  return model ? [{ model, source: 'env' }] : [{ model: null, source: 'session' }];
}

// ── Front matter ───────────────────────────────────────────────────────────────────────────────

type Field = { kind: 'none' } | { kind: 'value'; value: string } | { kind: 'unreadable'; reason: string };

export interface Frontmatter {
  name: Field;
  model: Field;
  effort: Field;
}

const FIELDS = ['name', 'model', 'effort'] as const;
const INDICATOR_START = /^[\[{&*!|>%@`]/;

const allUnreadable = (reason: string): Frontmatter => ({
  name: { kind: 'unreadable', reason },
  model: { kind: 'unreadable', reason },
  effort: { kind: 'unreadable', reason }
});

/**
 * The top-level `name`, `model` and `effort` of a YAML front matter block, read strictly. Understood: a
 * `key: value` block mapping where the value is one plain line (bare, or in quotes without escapes, optionally
 * followed by a ` #comment`). Everything else about those three keys is unreadable and the guard asks: a value
 * that continues on the next lines, a block scalar, flow value, anchor, alias or tag, a duplicate key, a key that
 * only differs by case, a merge key, an unterminated block, a line that is no `key: value` at the top level.
 * Reading any of them as "no model" would let `"model": opus` or a BOM hide an escalation.
 *
 * Then every key this reader found readable is checked against Claude Code's own pipeline (see the cross-check
 * section below): a disagreement makes that field unreadable.
 */
export function parseFrontmatter(rawText: string, yaml: YamlParse | null = bunYaml()): Frontmatter {
  const strict = strictFrontmatter(rawText);
  const out: Frontmatter = { ...strict };
  for (const key of FIELDS) {
    const f = strict[key];
    if (f.kind === 'unreadable') continue;
    const problem = crossCheck(rawText, yaml, key, f.kind === 'value' ? f.value.trim() : '');
    if (problem !== null) out[key] = { kind: 'unreadable', reason: problem };
  }
  return out;
}

function strictFrontmatter(rawText: string): Frontmatter {
  const none: Frontmatter = { name: { kind: 'none' }, model: { kind: 'none' }, effort: { kind: 'none' } };
  const text = rawText.replace(/^﻿/, '');
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[0]?.trimEnd() !== '---') {
    // Not a block at the very start. A `---` after blank or indented lines may still be read as one by a parser
    // that tolerates leading whitespace: do not guess, it is unreadable.
    const first = lines.findIndex((l) => l.trim() !== '');
    if (first >= 0 && lines[first].trim() === '---') return allUnreadable('the front matter delimiter is preceded by whitespace');
    return none;
  }
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (end < 0) return allUnreadable('the front matter block is not terminated');
  const out: Frontmatter = { name: { kind: 'none' }, model: { kind: 'none' }, effort: { kind: 'none' } };
  const seen = new Set<string>();
  const block = lines.slice(1, end);
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) continue; // continuation or nested: its key is checked below
    if (/^(?:-|\?)(?:\s|$)/.test(line)) return allUnreadable('the front matter is not a block mapping (sequence or complex key)');
    const m = /^([^\s:#'"][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) return allUnreadable(`a front matter line is not a plain "key: value" (${JSON.stringify(line.slice(0, 40))})`);
    const key = m[1];
    const lower = key.toLowerCase().normalize('NFKC');
    const field = FIELDS.find((f) => f === lower);
    if (key === '<<') return allUnreadable('the front matter uses a merge key');
    if (!field) continue;
    if (key !== field) return allUnreadable(`the front matter key ${JSON.stringify(key)} only differs from "${field}" by case or form`);
    if (seen.has(field)) return allUnreadable(`the front matter has "${field}" twice`);
    seen.add(field);
    const next = block[i + 1];
    const continues = next !== undefined && /^\s+\S/.test(next) && !/^\s*#/.test(next);
    let value = (m[2] ?? '').trim();
    if (continues) {
      out[field] = { kind: 'unreadable', reason: `the front matter "${field}" value continues over several lines` };
      continue;
    }
    if (value === '') {
      out[field] = { kind: 'none' };
      continue;
    }
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
    if (quote) {
      const close = value.indexOf(quote, 1);
      const rest = close < 0 ? '?' : value.slice(close + 1).trim();
      const inner = close < 0 ? '' : value.slice(1, close);
      if (close < 0 || (rest !== '' && !rest.startsWith('#')) || inner.includes('\\') || (quote === "'" && inner.includes("'"))) {
        out[field] = { kind: 'unreadable', reason: `the front matter "${field}" is quoted in a way Jev does not read` };
        continue;
      }
      value = inner.trim();
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
      if (INDICATOR_START.test(value) || value === '') {
        out[field] = { kind: 'unreadable', reason: `the front matter "${field}" is not a plain string (flow value, block scalar, anchor, alias or tag)` };
        continue;
      }
    }
    out[field] = value === '' ? { kind: 'none' } : { kind: 'value', value };
  }
  return out;
}

// ── Lookup ─────────────────────────────────────────────────────────────────────────────────────

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Parse `name` or `plugin:name` into its parts, or null for anything else. */
function parseAgentName(subagentType: unknown): { plugin: string | null; agent: string } | null {
  if (typeof subagentType !== 'string' || subagentType.length === 0) return null;
  const parts = subagentType.split(':');
  if (parts.length > 2 || !parts.every((p) => SEGMENT.test(p))) return null;
  return parts.length === 2 ? { plugin: parts[0], agent: parts[1] } : { plugin: null, agent: parts[0] };
}

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/**
 * Claude Code's user config dir: `CLAUDE_CONFIG_DIR` when set and non-empty (it replaces `~/.claude` entirely; a
 * relative value is resolved against the working directory), else `~/.claude`.
 */
export function userClaudeDir(cwd?: string): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) return path.resolve(cwd || process.cwd(), dir);
  return path.join(homeDir(), '.claude');
}

function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function gitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The directories from `cwd` up to the project root, nearest first, plus `CLAUDE_PROJECT_DIR` when the cwd is outside it. */
export function projectDirs(cwd: string | undefined): string[] {
  const envRoot = process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : null;
  const dirs: string[] = [];
  if (cwd && path.isAbsolute(cwd)) {
    const start = path.resolve(cwd);
    const stop = envRoot ? (isWithin(envRoot, start) ? envRoot : start) : gitRoot(start);
    let dir = start;
    for (;;) {
      dirs.push(dir);
      const parent = path.dirname(dir);
      if (dir === stop || parent === dir) break;
      dir = parent;
    }
  }
  if (envRoot && !dirs.includes(envRoot)) dirs.push(envRoot);
  return dirs;
}

const projectAgentDirs = (cwd: string | undefined): string[] => projectDirs(cwd).map((d) => path.join(d, '.claude', 'agents'));

/** `enabledPlugins` as Claude Code layers it: user settings, then each project's settings and settings.local (later wins). */
function enabledPluginKeys(cwd: string | undefined): Set<string> {
  const files = [path.join(userClaudeDir(cwd), 'settings.json')];
  for (const agents of [...projectAgentDirs(cwd)].reverse()) {
    const claudeDir = path.dirname(agents);
    files.push(path.join(claudeDir, 'settings.json'), path.join(claudeDir, 'settings.local.json'));
  }
  const state = new Map<string, boolean>();
  for (const file of files) {
    let enabled: unknown;
    try {
      const read = readRegularFile(file, MAX_CONFIG_FILE_BYTES);
      if (read.kind !== 'ok') continue;
      enabled = JSON.parse(read.text)?.enabledPlugins;
    } catch {
      continue;
    }
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) continue;
    for (const [key, value] of Object.entries(enabled)) state.set(key, value === true);
  }
  return new Set([...state].filter(([, on]) => on).map(([key]) => key));
}

/** `agents/` dirs of installed plugins as `[pluginName, dir]`, enabled first. Ordering only: no plugin is left out. */
function pluginAgentDirs(cwd: string | undefined): Array<[string, string]> {
  const found: Array<{ name: string; dir: string; key: string }> = [];
  let doc: any;
  try {
    const read = readRegularFile(path.join(userClaudeDir(cwd), 'plugins', 'installed_plugins.json'), MAX_CONFIG_FILE_BYTES);
    if (read.kind !== 'ok') return [];
    doc = JSON.parse(read.text);
  } catch {
    return [];
  }
  const plugins = doc?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  for (const [key, installs] of Object.entries(plugins)) {
    const name = key.split('@')[0];
    if (!name || !Array.isArray(installs)) continue;
    for (const inst of installs) {
      const p = (inst as any)?.installPath;
      if (typeof p === 'string' && path.isAbsolute(p)) found.push({ name, dir: path.join(p, 'agents'), key });
    }
  }
  const enabled = enabledPluginKeys(cwd);
  return [...found.filter((e) => enabled.has(e.key)), ...found.filter((e) => !enabled.has(e.key))].map((e) => [e.name, e.dir]);
}

/** The directories searched for `subagentType`, nearest first (empty for an invalid name). */
export function agentLookupDirs(subagentType: unknown, cwd: string | undefined): string[] {
  const parsed = parseAgentName(subagentType);
  if (!parsed) return [];
  const dirs = new Set<string>();
  if (!parsed.plugin) {
    for (const d of projectAgentDirs(cwd)) dirs.add(d);
    dirs.add(path.join(userClaudeDir(cwd), 'agents'));
  }
  for (const [plugin, dir] of pluginAgentDirs(cwd)) if (!parsed.plugin || plugin === parsed.plugin) dirs.add(dir);
  return [...dirs];
}

/** One-line account of where a definition is looked for, for ask reasons. */
export function describeAgentLookup(cwd: string | undefined): string {
  const project = projectAgentDirs(cwd);
  return (
    `${project.length > 0 ? project.join(', ') : '<cwd>/.claude/agents'} (hook cwd up to the project root), ` +
    `${path.join(userClaudeDir(cwd), 'agents')}, and the agents/ dir of each plugin in ` +
    `${path.join(userClaudeDir(cwd), 'plugins', 'installed_plugins.json')} (enabled plugins first; a "plugin:agent" name only looks in that plugin)`
  );
}

/** The sentence the guard uses when a subagent's definition cannot be found. */
export function missingAgentDetail(lookup: string): string {
  return `no definition for it could be found, so the model it will run on cannot be checked against the session model. Looked in ${lookup}.`;
}

const MAX_AGENT_FILES = 2000;
const MAX_AGENT_DEPTH = 8;
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** Every `.md` file under `root`, subdirectories included, sorted; null when `root` is not a readable directory. */
function listMarkdown(root: string): { files: string[]; special: string[]; truncated: boolean } | null {
  const files: string[] = [];
  /** `.md` entries that are not regular files (a FIFO, a socket, a device): never opened. */
  const special: string[] = [];
  const visited = new Set<string>();
  let truncated = false;
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      const real = fs.realpathSync(dir);
      if (visited.has(real)) return true;
      visited.add(real);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling
        }
      }
      if (isDir) {
        if (depth >= MAX_AGENT_DEPTH) truncated = true;
        else walk(full, depth + 1);
      } else if (!isFile && /\.md$/i.test(entry.name)) {
        special.push(full);
      } else if (isFile && /\.md$/i.test(entry.name)) {
        if (files.length >= MAX_AGENT_FILES) {
          truncated = true;
          return true;
        }
        files.push(full);
      }
    }
    return true;
  };
  return walk(root, 0) ? { files, special, truncated } : null;
}

type Claim = { file: string; model: string | null; effort: string | null; unreadable: string | null };
type DirScan = { kind: 'none' } | { kind: 'conflict'; reason: string } | ({ kind: 'def' } & Claim);

const modelKey = (m: string | null): string => (m === null || m.trim() === '' ? 'inherit' : m.trim().toLowerCase());

/**
 * The definition of `agent` in ONE agents directory, as Claude Code registers it. A file whose `name:` is the agent
 * claims it; a file called `<agent>.md` with no `name:` claims it by file name; a file called `<agent>.md` that
 * declares another (or an unreadable) name, another file with an unreadable name that could be this agent, more
 * than one claimant and a tree too large to read are conflicts.
 */
function scanAgentDir(dir: string, agent: string): DirScan {
  const listing = listMarkdown(dir);
  if (listing === null) return { kind: 'none' };
  const claims: Claim[] = [];
  const conflicts: string[] = [];
  if (listing.truncated) conflicts.push(`${dir} holds more agent files than Jev reads (${MAX_AGENT_FILES}), or nests deeper than ${MAX_AGENT_DEPTH} levels`);
  for (const file of listing.special) {
    if (path.basename(file).replace(/\.md$/i, '') === agent) conflicts.push(`${file} is not a regular file and is not read`);
  }
  for (const file of listing.files) {
    const byFileName = path.basename(file).replace(/\.md$/i, '') === agent;
    const read = readRegularFile(file, MAX_AGENT_FILE_BYTES);
    if (read.kind === 'too-large') {
      if (byFileName) conflicts.push(`${file} is over ${MAX_AGENT_FILE_BYTES} bytes and is not read`);
      continue;
    }
    if (read.kind === 'not-regular') {
      if (byFileName) conflicts.push(`${file} is not a regular file and is not read`);
      continue;
    }
    if (read.kind !== 'ok') continue; // not readable: not a definition
    const text = read.text;
    const { name, model, effort } = parseFrontmatter(text);
    const claim = (): Claim => ({
      file,
      model: model.kind === 'value' ? model.value : null,
      effort: effort.kind === 'value' ? effort.value : null,
      unreadable: model.kind === 'unreadable' ? model.reason : effort.kind === 'unreadable' ? effort.reason : null
    });
    if (name.kind === 'value') {
      if (name.value === agent) claims.push(claim());
      else if (byFileName) conflicts.push(`${file} declares the name "${name.value}", so it is not clear which file defines "${agent}"`);
    } else if (name.kind === 'none') {
      if (byFileName) claims.push(claim());
    } else if (byFileName) {
      conflicts.push(`${file} has a name that cannot be read (${name.reason})`);
    } else {
      // Another file whose name the strict reader cannot establish (a flow mapping, an indented block, an escape such
      // as "\x68elper"): Claude Code's own reading may still register it as this agent. A second opinion from its
      // pipeline: it names the agent, it rejects the block, or the text mentions the agent: all conflicts.
      const cc = readClaudeCodeName(text);
      if (cc.kind === 'unreadable') conflicts.push(`${file} has a name that cannot be read (${name.reason})`);
      else if (cc.kind === 'value' && cc.value === agent) conflicts.push(`${file} may declare the name "${agent}" (${name.reason})`);
      else if (text.includes(agent)) conflicts.push(`${file} has a name that cannot be read (${name.reason}) and mentions "${agent}"`);
    }
  }
  if (conflicts.length > 0) return { kind: 'conflict', reason: conflicts.join('; ') };
  if (claims.length === 0) return { kind: 'none' };
  if (claims.length > 1) {
    return { kind: 'conflict', reason: `more than one file in ${dir} defines "${agent}": ${claims.map((c) => `${c.file} (${c.model ?? 'no model'}, ${c.effort ?? 'no effort'})`).join(' vs ')}` };
  }
  return { kind: 'def', ...claims[0] };
}

const toDefinition = (c: Claim): AgentDefinition => ({
  found: true,
  model: c.model,
  ...(c.effort !== null ? { effort: c.effort } : {}),
  ...(c.unreadable !== null ? { unreadable: `${c.file}: ${c.unreadable}` } : {})
});

/**
 * The definition of `subagentType`. The FIRST definition found decides, as in Claude Code, with one exception:
 * every project-level definition of the name is read, and when they disagree the answer is unreadable.
 */
export function readAgentDefinition(subagentType: string | undefined, cwd: string | undefined): AgentDefinition {
  const none: AgentDefinition = { found: false, model: null };
  const parsed = parseAgentName(subagentType);
  if (!parsed) return none;
  const userDir = path.join(userClaudeDir(cwd), 'agents');
  const projectSet = new Set(parsed.plugin ? [] : projectAgentDirs(cwd).filter((d) => d !== userDir));
  const project: Claim[] = [];
  for (const dir of agentLookupDirs(subagentType, cwd)) {
    const inProject = projectSet.has(dir);
    if (project.length > 0 && !inProject) break; // past the project: the project definition decided
    const scan = scanAgentDir(dir, parsed.agent);
    if (scan.kind === 'none') continue;
    if (scan.kind === 'conflict') return { found: true, model: null, unreadable: scan.reason };
    if (!inProject) return toDefinition(scan);
    project.push(scan);
  }
  if (project.length === 0) return none;
  const [first, ...others] = project;
  const differing = others.filter((o) => o.unreadable !== null || first.unreadable !== null || modelKey(o.model) !== modelKey(first.model) || modelKey(o.effort) !== modelKey(first.effort));
  if (differing.length === 0) return toDefinition(first);
  const describeOne = (d: Claim) => `${d.file} (${d.model ?? 'no model'}, ${d.effort ?? 'no effort'})`;
  return { found: true, model: null, unreadable: `the project defines "${parsed.agent}" in more than one place with different models or efforts: ${[first, ...differing].map(describeOne).join(' vs ')}` };
}

// ── The model an Agent/Task call will run on ───────────────────────────────────────────────────

/** Where the model of an Agent/Task call comes from; `inherit` is the session model (nothing stronger can run). */
export type AgentModelSource = 'call' | 'definition' | 'env-force' | 'ladder' | 'env' | 'inherit';

export interface ResolvedAgentModel {
  /** The model the call will run on; null when it inherits the session model. */
  model: string | null;
  source: AgentModelSource;
  /** Set when the definition that decides the model could not be established: the guard asks with this text. */
  unreadable?: string;
  /** The `effort:` of the definition behind the call's `subagent_type`, when one was found and it sets a readable one. */
  definitionEffort?: string;
}

/**
 * The model an Agent/Task call will actually run on: the forced environment model (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
 * with `CLAUDE_CODE_SUBAGENT_MODEL`) when on; else the call's own model; else the model of the definition behind its
 * `subagent_type` (read from disk, except for Claude Code's built-in types, which have none); else a `jev-ladder-<id>`
 * pin (`ladder`, found by the caller); else `CLAUDE_CODE_SUBAGENT_MODEL`; else the session's own. Same environment
 * resolution as the Workflow guard (`subagentModelCandidates`), minus `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`.
 * A type with no definition file resolves as if it had none (Claude Code itself reports an unknown agent). A
 * definition the strict reader cannot establish is `unreadable` only when it is what decides the model; the
 * definition's readable `effort:` is returned whatever decides the model (the narrow interim effort rule reads it).
 */
export function resolveAgentModel(
  call: { model?: unknown; subagent_type?: unknown },
  cwd: string | undefined,
  env: Env,
  ladder: string | null
): ResolvedAgentModel {
  const callModel = call.model;
  const callWritten = typeof callModel === 'string' ? callModel.trim() !== '' : !!callModel;
  const forced = subagentModelForced(env);
  let definition: string | null = null;
  let definitionEffort: string | undefined;
  const type = call.subagent_type;
  if (typeof type === 'string' && !BUILTIN_AGENT_TYPES.has(type)) {
    const def = readAgentDefinition(type, cwd);
    if (def.found && typeof def.effort === 'string') definitionEffort = def.effort;
    if (def.found && !forced && !callWritten) {
      if (def.unreadable) return { model: null, source: 'definition', unreadable: def.unreadable, ...(definitionEffort !== undefined ? { definitionEffort } : {}) };
      definition = def.model;
    }
  }
  const extra = definitionEffort !== undefined ? { definitionEffort } : {};
  if (callWritten && typeof callModel !== 'string') return { model: callModel as string, source: 'call', ...extra };
  const [c] = subagentModelCandidates({ call: callModel as string | undefined, definition, ladder }, env);
  const source: AgentModelSource = c.source === 'env-forced' ? 'env-force' : c.source === 'session' || c.source === 'workflow-env' ? 'inherit' : c.source;
  return { model: c.model, source, ...extra };
}

// ── Claude Code cross-check ────────────────────────────────────────────────────────────────────
//
// The strict reader above and Claude Code's own frontmatter pipeline must agree on `name`, `model` and `effort`;
// where they do not (a top-level flow mapping, a block indented as a whole, a tab-indented line, a `---` inside a
// value, an escape the strict reader skipped, a number where a string is expected), the field is unreadable and the
// guard asks, instead of reading "no model" where Claude Code reads `opus`. The pipeline is a copy of Claude Code
// 2.1.312's, by cognitive-engine: its block regex, `Bun.YAML.parse`, then its quoting fallback when that throws.
// The plugin's own stricter reader is kept for everything else (no per-key isolation of a bad block).

/** A YAML parser (`Bun.YAML.parse` under bun, where the hooks and the MCP server run). */
export type YamlParse = (text: string) => unknown;

function bunYaml(): YamlParse | null {
  const parse = (globalThis as { Bun?: { YAML?: { parse?: unknown } } }).Bun?.YAML?.parse;
  return typeof parse === 'function' ? (parse as YamlParse) : null;
}

/** Claude Code's frontmatter block regex (2.1.312). */
const CC_BLOCK = /^---\s*\n([\s\S]*?)---\s*\n?/;
/** What Claude Code's fallback quotes: a special character, or ": " inside a plain value. */
const CC_SPECIAL = /[{}[\]*&#!|>%@`]|: /;
/** A top-level `key: value` line, as Claude Code's fallback sees it. */
const CC_PAIR = /^([a-zA-Z_-]+):\s+(\S.*)$/;

/** The text of the frontmatter block as Claude Code finds it, or null when it finds none. */
function ccBlock(raw: string): string | null {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = text.indexOf('---', 3) < 0 ? null : CC_BLOCK.exec(text);
  return m ? (m[1] ?? '') : null;
}

/** Whether any line of `block` is one Claude Code's fallback might re-quote (without a YAML parser: assume it can). */
function fallbackMightApply(block: string): boolean {
  return block.split('\n').some((line) => {
    const m = CC_PAIR.exec(line);
    if (!m) return false;
    const w = m[2];
    if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) return false;
    return CC_SPECIAL.test(w);
  });
}

/** Claude Code's quoting fallback: quote the value of every top-level `key: value` line that holds a YAML special character. */
function ccQuoteFallback(block: string, yaml: YamlParse): string {
  return block
    .split('\n')
    .map((line) => {
      const m = CC_PAIR.exec(line);
      if (!m) return line;
      const [, key, w] = m;
      if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) return line;
      if (w.startsWith('[') && w.endsWith(']')) {
        try {
          if (Array.isArray(yaml(w))) return line;
        } catch {
          // not a sequence: fall through to quoting
        }
      }
      if (CC_SPECIAL.test(w)) return `${key}: "${w.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      return line;
    })
    .join('\n');
}

/** The frontmatter Claude Code reads for `raw`: its mapping, `{}` when there is none, or null when both parses throw. */
function ccFrontmatter(raw: string, yaml: YamlParse): Record<string, unknown> | null {
  const block = ccBlock(raw);
  if (block === null) return {};
  let value: unknown;
  try {
    value = yaml(block);
  } catch {
    try {
      value = yaml(ccQuoteFallback(block, yaml).replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length)));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The string Claude Code would read for the top-level `key` of `raw`, trimmed ('' for none), or an `unreadable` reason. */
function ccString(raw: string, yaml: YamlParse, key: (typeof FIELDS)[number]): { ok: true; value: string } | { ok: false; reason: string } {
  const front = ccFrontmatter(raw, yaml);
  if (front === null) return { ok: false, reason: "Claude Code's YAML parser rejects this frontmatter, so what it would run is not known" };
  const v = front[key];
  if (v === undefined || v === null) return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, reason: `Claude Code reads "${key}" as ${typeof v === 'object' ? 'a collection' : `the ${typeof v} ${String(v)}`}, not a string` };
  return { ok: true, value: v.trim() };
}

/**
 * Check a strict answer for `key` against Claude Code's pipeline: null when both agree (`mine` is the strict value,
 * '' for none), else the reason they differ. Without a YAML parser (`yaml` null, not under bun) only a conservative
 * rule applies: a block with a line the fallback could re-quote is not trusted.
 */
function crossCheck(raw: string, yaml: YamlParse | null, key: (typeof FIELDS)[number], mine: string): string | null {
  if (yaml === null) {
    const block = ccBlock(raw);
    return block !== null && fallbackMightApply(block)
      ? "a line could be re-quoted by Claude Code's fallback frontmatter parser, and no YAML parser is available here to check it"
      : null;
  }
  const cc = ccString(raw, yaml, key);
  if (!cc.ok) return cc.reason;
  if (cc.value === mine) return null;
  return `Jev reads ${key} ${mine === '' ? 'as none' : JSON.stringify(mine)} but Claude Code's parser reads ${cc.value === '' ? 'none' : JSON.stringify(cc.value)}`;
}

/**
 * The `name` as Claude Code's pipeline alone reads it (no strict reader, no cross-check): the second opinion for a
 * file whose strict `name` is unreadable. Unreadable when Claude Code's parser rejects the block, reads a
 * non-string, or no YAML parser is available.
 */
export function readClaudeCodeName(raw: string, yaml: YamlParse | null = bunYaml()): Field {
  if (yaml === null) return { kind: 'unreadable', reason: 'no YAML parser is available here' };
  const cc = ccString(raw, yaml, 'name');
  if (!cc.ok) return { kind: 'unreadable', reason: cc.reason };
  return cc.value === '' ? { kind: 'none' } : { kind: 'value', value: cc.value };
}
