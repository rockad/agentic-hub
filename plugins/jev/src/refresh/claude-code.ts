/**
 * Claude Code discoverer: probes candidate model ids with `claude -p --model <id>` and reports which ones the
 * account can use, plus which concrete id each native alias (`haiku`, `sonnet`, `opus`, `fable`) resolves to.
 *
 * Every probe is a paid call, so the run is capped (`maxCalls`, hard) and strictly sequential. A probe runs with
 * hooks disabled and the Jev plugin switched off in a throwaway settings file, in one stable empty working
 * directory, so it can never recurse into Jev's own hooks. The process spawner is injected: tests never run `claude`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareVersions, parseModelId, type Catalogue, type ProbeResult } from '../core/catalogue.js';
import { privateDir } from '../core/private-fs.js';
import { defaultSpawner, type Spawner } from './spawn.js';
import type { DiscoveryOutcome, LogFn } from './types.js';

export const NATIVE_ALIAS_LIST = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/** Families and versions Jev knows about; the probe starts from these plus whatever the last catalogue held. */
export const KNOWN_CLAUDE_IDS: readonly string[] = [
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-5',
  'claude-fable-5-2'
];

export const PROBE_TIMEOUT_MS = 60_000;
/** Stop the run after this many probes in a row that gave no usable answer (offline, not logged in, limit hit). */
export const MAX_CONSECUTIVE_ERRORS = 3;

// ---------------------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------------------

export function versionToId(family: string, version: readonly number[]): string {
  return `claude-${family}-${version.join('-')}`;
}

/**
 * For each known family: the next minor and the next major of its newest known version
 * (`claude-sonnet-5-5` gives `claude-sonnet-5-6` and `claude-sonnet-6`). Ids already in `known` are left out.
 */
export function neighbourIds(known: readonly string[]): string[] {
  const newest = new Map<string, number[]>();
  for (const id of known) {
    const p = parseModelId(id);
    if (!p || p.alias || p.latest || p.provider || p.version.length === 0) continue;
    if (!(NATIVE_ALIAS_LIST as readonly string[]).includes(p.family)) continue;
    const cur = newest.get(p.family);
    if (!cur || compareVersions(p.version, cur) > 0) newest.set(p.family, p.version);
  }
  const have = new Set(known);
  const out: string[] = [];
  for (const family of NATIVE_ALIAS_LIST) {
    const v = newest.get(family);
    if (!v) continue;
    const nextMinor = [v[0], (v[1] ?? 0) + 1];
    const nextMajor = [v[0] + 1];
    for (const n of [nextMinor, nextMajor]) {
      const id = versionToId(family, n);
      if (!have.has(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * The ordered, de-duplicated list of concrete ids to probe, most valuable first:
 * ids from the previous catalogue (so strikes progress), the built-in known ids, user additions from the config,
 * then generated neighbours. Bare aliases are not candidates here: they are probed separately.
 */
export function generateCandidates(previous: Catalogue | null | undefined, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const add = (id: string): void => {
    const p = parseModelId(id);
    if (!p || p.alias || out.includes(id)) return;
    out.push(id);
  };
  for (const m of previous?.models ?? []) add(m.id);
  for (const id of KNOWN_CLAUDE_IDS) add(id);
  for (const id of extra) add(id);
  for (const id of neighbourIds(out)) add(id);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------------------------------------------

export function probeSettingsJson(): string {
  return JSON.stringify({ disableAllHooks: true, enabledPlugins: { 'jev@agentic-hub': false } });
}

export function probeArgs(model: string, settingsFile: string): string[] {
  return [
    '-p',
    'Reply OK',
    '--model',
    model,
    '--setting-sources',
    'project',
    '--settings',
    settingsFile,
    '--no-session-persistence',
    '--output-format',
    'json'
  ];
}

export type ProbeOutcome =
  /** The model answered; `resolved` is the id the harness actually used (the `modelUsage` key). */
  | { kind: 'ok'; resolved: string; costUsd: number }
  /** A clear answer that the model is not usable: an error naming the model, or another model served the call. */
  | { kind: 'fail'; reason: string; costUsd: number }
  /** No usable answer (timeout, could not start, unreadable output, rate limit): says nothing about the model. */
  | { kind: 'error'; reason: string };

/** The result object of `claude -p --output-format json`: one object, or an array of messages ending in it. */
function extractResult(stdout: string): any | null {
  const text = (stdout || '').trim();
  if (!text) return null;
  const pick = (v: any): any | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === 'object' && v[i].type === 'result') return v[i];
      return null;
    }
    return v && typeof v === 'object' ? v : null;
  };
  try {
    return pick(JSON.parse(text));
  } catch {
    // a warning line before the JSON: try the last line that looks like an object
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return pick(JSON.parse(line));
    } catch {
      // keep looking
    }
  }
  return null;
}

function normaliseUsageKey(key: string): string {
  return key.toLowerCase().replace(/\[[^\]]*\]$/, '');
}

function keyMatchesId(key: string, id: string): boolean {
  const k = normaliseUsageKey(key);
  const want = id.toLowerCase();
  return k === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(k);
}

/**
 * The wording of a model rejection in a JSON error result. Deliberately narrow: "not found" and "not available"
 * also appear in a broken wrapper ("node: not found"), a missing feature or a missing resource, none of which say
 * anything about the model.
 */
const MODEL_REJECTED = /issue with the selected model|may not exist or you may not have access|invalid model|unknown model|model [^\n]{0,80}(does not exist|not found)/i;

/**
 * Read the output of one probe. `want` is a concrete id (ok when `modelUsage` has that id) or a native alias
 * (ok when the call was served, and `resolved` is the usage key of that alias's family, else the costliest key).
 */
export function parseProbeOutput(res: { stdout: string; stderr?: string; timedOut?: boolean; code?: number | null; error?: string }, want: string): ProbeOutcome {
  if (res.timedOut) return { kind: 'error', reason: 'timed out' };
  if (res.error) return { kind: 'error', reason: `could not start: ${res.error}` };
  const result = extractResult(res.stdout);
  if (!result) {
    // Free text on a path with no parsed JSON proves nothing about the model: a wrapper script, a missing runtime
    // or a login prompt all look like this.
    return { kind: 'error', reason: `no JSON result (exit ${res.code ?? 'none'})` };
  }
  const costUsd = typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
  if (result.is_error !== false) {
    const msg = typeof result.result === 'string' ? result.result : '';
    if (result.is_error === true && MODEL_REJECTED.test(msg)) return { kind: 'fail', reason: msg.slice(0, 160), costUsd };
    return { kind: 'error', reason: msg ? msg.slice(0, 160) : 'error result' };
  }
  const usage = result.modelUsage && typeof result.modelUsage === 'object' ? (result.modelUsage as Record<string, any>) : {};
  const keys = Object.keys(usage);
  if (keys.length === 0) return { kind: 'fail', reason: 'no modelUsage in the result', costUsd };

  const parsedWant = parseModelId(want);
  if (parsedWant?.alias) {
    const cost = (k: string): number => (typeof usage[k]?.costUSD === 'number' ? usage[k].costUSD : 0);
    const sameFamily = keys.filter((k) => parseModelId(normaliseUsageKey(k))?.family === parsedWant.family);
    const pool = sameFamily.length > 0 ? sameFamily : keys;
    const best = [...pool].sort((a, b) => cost(b) - cost(a))[0];
    return { kind: 'ok', resolved: normaliseUsageKey(best), costUsd };
  }
  const hit = keys.find((k) => keyMatchesId(k, want));
  if (hit) return { kind: 'ok', resolved: want, costUsd };
  return { kind: 'fail', reason: `served by ${keys.map(normaliseUsageKey).join(', ')}`, costUsd };
}

export interface ProbeOptions {
  spawn: Spawner;
  claudeBin?: string;
  timeoutMs?: number;
  /** Where the throwaway settings file goes (default: the system temp directory). */
  tmpRoot?: string;
  /** The probe's working directory (default `~/.config/jev/probe-cwd`): one stable, empty directory, reused. */
  cwd?: string;
  /** The environment to filter into the probe's (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** The probe's working directory when none is given. */
export function defaultProbeCwd(): string {
  // HOME first: a probe run under a temp HOME (tests, containers) must stay inside it
  return path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.config', 'jev', 'probe-cwd');
}

/**
 * Environment names a probe may inherit: what `claude` needs to run and to reach the same account (PATH, HOME,
 * locale, proxy and certificate settings, the Anthropic and Claude auth variables). Everything else, notably
 * `JEV_*` and `OPENROUTER_*` keys and unrelated cloud credentials, is left out.
 */
const PROBE_ENV_ALLOW = /^(PATH|HOME|USER|LANG|TERM|TMPDIR|SHELL|XDG_.+|ANTHROPIC_.+|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy|SSL_CERT_.+|NODE_EXTRA_CA_CERTS)$/;

/**
 * The probe's environment: the allowlisted part of `base`, with auto-memory off
 * (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, an environment variable of Claude Code) so a probe never writes a memory entry.
 */
export function probeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && PROBE_ENV_ALLOW.test(k)) out[k] = v;
  }
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}

/** The stable empty probe directory, created owner-only when missing. Claude Code keeps one project entry for it. */
function ensureProbeCwd(cwd: string): string {
  privateDir(cwd);
  return cwd;
}

/**
 * One probe call. The working directory is one stable empty directory (`~/.config/jev/probe-cwd`, reused), so
 * Claude Code records a single project entry instead of one per probe; the throwaway settings file lives in a
 * temp directory that is removed afterwards. Never throws.
 */
export async function probeModel(model: string, opts: ProbeOptions): Promise<ProbeOutcome> {
  let root: string | null = null;
  try {
    const cwd = ensureProbeCwd(opts.cwd ?? defaultProbeCwd());
    root = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), 'jev-probe-'));
    const settings = path.join(root, 'settings.json');
    fs.writeFileSync(settings, probeSettingsJson());
    const res = await opts.spawn(opts.claudeBin ?? 'claude', probeArgs(model, settings), {
      cwd,
      timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      env: probeEnv(opts.env ?? process.env)
    });
    return parseProbeOutput(res, model);
  } catch (err: any) {
    return { kind: 'error', reason: String(err?.message ?? err) };
  } finally {
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // a leftover temp dir is harmless
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------------------------------------------

export interface ClaudeDiscoverOptions extends ProbeOptions {
  previous: Catalogue | null;
  /** Hard cap on probe calls for the whole run, aliases included. */
  maxCalls: number;
  /** User additions from `models.refresh.candidates`. */
  extra?: readonly string[];
  log?: LogFn;
  /** Called after every probe (the refresh uses it to write the lock heartbeat). */
  onProbe?: () => void;
}

export interface ClaudeDiscovery extends DiscoveryOutcome {
  /** Alias to the concrete id it resolved to in this run. */
  aliases: Record<string, string>;
}

/**
 * Probe the four aliases first (each one both resolves the alias and verifies the concrete id it lands on), then
 * the candidate list in order, skipping ids already verified, until `maxCalls` calls are spent. What the cap cuts
 * off is logged and returned in `dropped`.
 *
 * Recording rules (these protect the catalogue from a bad round):
 * - ok: recorded with the alias when the resolved family matches the alias
 * - fail on an id that is in the previous catalogue: recorded (the strikes rule applies)
 * - fail on an id the catalogue never had (a speculative neighbour): only noted, not added as a `missing` entry
 * - error (timeout, offline, rate limit, could not start): inconclusive, no strike; after
 *   {@link MAX_CONSECUTIVE_ERRORS} in a row the run stops
 */
export async function discoverClaudeCode(opts: ClaudeDiscoverOptions): Promise<ClaudeDiscovery> {
  const log = opts.log ?? (() => {});
  const known = new Set((opts.previous?.models ?? []).map((m) => m.id));
  const out: ClaudeDiscovery = {
    source: 'probe',
    results: [],
    calls: 0,
    costUsd: 0,
    dropped: [],
    inconclusive: [],
    notes: [],
    aliases: {}
  };
  const verified = new Set<string>();
  let streak = 0;

  const call = async (model: string): Promise<ProbeOutcome> => {
    out.calls++;
    const r = await probeModel(model, opts);
    try {
      opts.onProbe?.();
    } catch {
      // a failed heartbeat must not end the run
    }
    if ('costUsd' in r) out.costUsd += r.costUsd;
    if (r.kind === 'error') {
      streak++;
      out.inconclusive.push(model);
      log(`probe ${model}: no answer (${r.reason})`);
    } else {
      streak = 0;
    }
    return r;
  };

  const queue: Array<{ model: string; alias: boolean }> = [
    ...NATIVE_ALIAS_LIST.map((a) => ({ model: a as string, alias: true })),
    ...generateCandidates(opts.previous, opts.extra).map((id) => ({ model: id, alias: false }))
  ];

  for (let i = 0; i < queue.length; i++) {
    const { model, alias } = queue[i];
    if (!alias && verified.has(model)) continue;
    if (out.aborted || out.calls >= opts.maxCalls) {
      out.dropped.push(model);
      continue;
    }
    const r = await call(model);
    if (r.kind === 'ok') {
      if (alias) {
        const parsed = parseModelId(r.resolved);
        out.aliases[model] = r.resolved;
        verified.add(r.resolved);
        const aliasMatches = parsed?.family === model;
        out.results.push({ id: r.resolved, ok: true, ...(aliasMatches ? { alias: model } : {}) });
        log(`probe ${model}: ok, resolves to ${r.resolved}`);
        if (!aliasMatches) out.notes.push(`alias ${model} resolved to ${r.resolved}, a different family`);
      } else {
        verified.add(model);
        out.results.push({ id: model, ok: true });
        log(`probe ${model}: ok`);
      }
    } else if (r.kind === 'fail') {
      log(`probe ${model}: not available (${r.reason})`);
      if (alias) {
        out.notes.push(`alias ${model} is not usable: ${r.reason}`);
      } else if (known.has(model)) {
        out.results.push({ id: model, ok: false });
      } else {
        out.notes.push(`${model} is not available`);
      }
    }
    if (streak >= MAX_CONSECUTIVE_ERRORS && !out.aborted) {
      out.aborted = `stopped after ${streak} probes in a row without an answer`;
      log(out.aborted);
    }
  }
  if (out.dropped.length > 0) {
    log(`call cap (${opts.maxCalls}) reached: not probed this round: ${out.dropped.join(', ')}`);
  }
  return out;
}

/**
 * Clear a stale native alias: when this run resolved `sonnet` to one id, no other catalogue entry keeps `sonnet`
 * as its alias. Returns the catalogue (mutated).
 */
export function reconcileAliases(cat: Catalogue, aliases: Record<string, string>): Catalogue {
  for (const m of cat.models) {
    if (m.alias && aliases[m.alias] && aliases[m.alias] !== m.id) delete m.alias;
  }
  return cat;
}
