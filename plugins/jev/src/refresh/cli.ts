/**
 * `scripts/jev-models.ts`: refresh, inspect and list the model catalogue.
 *
 *   bun scripts/jev-models.ts refresh [--harness claude-code|opencode|antigravity] [--max-calls N] [--quiet]
 *   bun scripts/jev-models.ts status  [--harness ...]
 *   bun scripts/jev-models.ts list    [--harness ...] [--json]
 *
 * All IO goes through injectable dependencies so tests never run `claude`, never touch the network and never touch
 * the real `~/.config/jev`.
 */
import * as fs from 'node:fs';
import {
  buildCatalogue,
  cataloguePath,
  isStale,
  isVeryStale,
  ladder,
  loadCatalogue,
  loadOverrides,
  saveCatalogue,
  unknownIds,
  type Catalogue,
  type CatalogueTier
} from '../core/catalogue.js';
import { getHarnessModels } from '../core/config.js';
import { tryLock, unlock } from '../core/lock.js';
import { ABSOLUTE_MAX_CALLS, loadRefreshConfig, refreshLockPath } from './config.js';
import { discoverClaudeCode, reconcileAliases } from './claude-code.js';
import { discoverOpenRouter } from './openrouter.js';
import { applyTierMap, discoverStatic } from './static.js';
import { defaultSpawner, type Spawner } from './spawn.js';
import type { DiscoveryOutcome } from './types.js';

export const REFRESH_HARNESSES = ['claude-code', 'opencode', 'antigravity'] as const;
export type RefreshHarness = (typeof REFRESH_HARNESSES)[number];
/** A refresh lock older than this is taken over (20 probes at the 60 s timeout is 20 minutes). */
export const REFRESH_LOCK_STALE_MS = 30 * 60 * 1000;

export interface CliArgs {
  command: 'refresh' | 'status' | 'list' | 'help';
  harness: RefreshHarness;
  maxCalls?: number;
  quiet: boolean;
  json: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { command: 'help', harness: 'claude-code', quiet: false, json: false };
  const rest = [...argv];
  const first = rest[0];
  if (!first || first === 'help' || first === '--help' || first === '-h') return args;
  if (first !== 'refresh' && first !== 'status' && first !== 'list') {
    return { ...args, error: `unknown command: ${first}` };
  }
  args.command = first;
  rest.shift();
  for (let i = 0; i < rest.length; i++) {
    let flag = rest[i];
    let inline: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const value = (): string | undefined => (inline !== undefined ? inline : rest[++i]);
    if (flag === '--quiet' || flag === '-q') args.quiet = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--harness') {
      const v = value();
      if (!v || !(REFRESH_HARNESSES as readonly string[]).includes(v)) {
        return { ...args, error: `--harness must be one of ${REFRESH_HARNESSES.join(', ')}` };
      }
      args.harness = v as RefreshHarness;
    } else if (flag === '--max-calls') {
      const v = value();
      const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > ABSOLUTE_MAX_CALLS) {
        return { ...args, error: `--max-calls must be a whole number from 1 to ${ABSOLUTE_MAX_CALLS}` };
      }
      args.maxCalls = n;
    } else {
      return { ...args, error: `unknown option: ${rest[i]}` };
    }
  }
  return args;
}

export const USAGE = `jev-models: refresh, inspect and list the Jev model catalogue

  refresh [--harness claude-code|opencode|antigravity] [--max-calls N] [--quiet]
  status  [--harness ...]
  list    [--harness ...] [--json]

The default harness is claude-code. Claude Code refresh makes paid probe calls, capped by --max-calls
(default 20, config models.refresh.maxCalls).`;

export interface CliDeps {
  spawn?: Spawner;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Catalogue directory (default `~/.config/jev/models`). */
  dir?: string;
  configFile?: string;
  claudeBin?: string;
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function lockHeldBySelf(lockPath: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid === process.pid;
  } catch {
    return false;
  }
}

const ids = (list: string[]): string => (list.length ? list.join(', ') : 'none');
const usd = (n: number): string => `$${n.toFixed(4)}`;

/** Entries by id, for the before/after comparison. */
function statusMap(cat: Catalogue | null): Map<string, string> {
  return new Map((cat?.models ?? []).map((m) => [m.id, m.status]));
}

export interface RefreshSummary {
  added: string[];
  removed: string[];
  nowMissing: string[];
  recovered: string[];
  needsReview: string[];
}

export function summarise(before: Catalogue | null, after: Catalogue): RefreshSummary {
  const b = statusMap(before);
  const a = statusMap(after);
  return {
    added: [...a.keys()].filter((id) => !b.has(id)),
    removed: [...b.keys()].filter((id) => !a.has(id)),
    nowMissing: [...a.entries()].filter(([id, s]) => s === 'missing' && b.get(id) !== 'missing').map(([id]) => id),
    recovered: [...a.entries()].filter(([id, s]) => s === 'ok' && b.get(id) === 'missing').map(([id]) => id),
    needsReview: unknownIds(after)
  };
}

async function discover(
  harness: RefreshHarness,
  previous: Catalogue | null,
  maxCalls: number,
  deps: CliDeps,
  log: (l: string) => void
): Promise<{ outcome: DiscoveryOutcome; aliases?: Record<string, string>; map?: ReturnType<typeof discoverStatic>['map'] } | null> {
  const cfg = loadRefreshConfig(deps.configFile);
  if (harness === 'claude-code') {
    const outcome = await discoverClaudeCode({
      previous,
      maxCalls,
      extra: cfg.candidates,
      spawn: deps.spawn ?? defaultSpawner,
      claudeBin: deps.claudeBin,
      tmpRoot: deps.tmpRoot,
      env: deps.env,
      log
    });
    return { outcome, aliases: outcome.aliases };
  }
  if (harness === 'opencode') {
    const map = getHarnessModels(harness);
    const outcome = await discoverOpenRouter({ previous, fetch: deps.fetch, harness, map });
    return outcome ? { outcome, map } : null;
  }
  const outcome = discoverStatic(harness);
  return { outcome, map: outcome.map };
}

async function runRefresh(args: CliArgs, deps: CliDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const { harness } = args;
  const cfg = loadRefreshConfig(deps.configFile);
  const maxCalls = args.maxCalls ?? cfg.maxCalls;
  const now = (deps.now ?? (() => new Date()))();
  const lockPath = refreshLockPath(harness, deps.dir);

  // The background trigger takes the lock for the process it spawns and writes that process's pid into it.
  if (!lockHeldBySelf(lockPath) && !tryLock(lockPath, REFRESH_LOCK_STALE_MS)) {
    out(`jev-models: another refresh of ${harness} is running; nothing probed`);
    return 0;
  }
  try {
    const previous = loadCatalogue(harness, deps.dir);
    const log = args.quiet ? () => {} : (l: string) => out(`  ${l}`);
    if (!args.quiet) out(`jev-models: refreshing ${harness}${harness === 'claude-code' ? ` (at most ${maxCalls} probe calls)` : ''}`);

    const found = await discover(harness, previous, maxCalls, deps, log);
    if (!found) {
      err(`jev-models: could not read the model list for ${harness}; catalogue unchanged`);
      return 1;
    }
    const { outcome } = found;
    if (outcome.results.length === 0) {
      err(
        `jev-models: no usable answer${outcome.aborted ? ` (${outcome.aborted})` : ''}; catalogue unchanged` +
          (outcome.calls ? `; ${outcome.calls} calls made` : '')
      );
      return 1;
    }

    const cat = buildCatalogue(harness, outcome.results, outcome.source, outcome.source === 'static' ? null : previous, now);
    if (found.aliases) reconcileAliases(cat, found.aliases);
    if (found.map) applyTierMap(cat, found.map, now);
    if (!saveCatalogue(cat, deps.dir)) {
      err(`jev-models: could not write ${cataloguePath(harness, deps.dir) ?? 'the catalogue file'}`);
      return 1;
    }

    if (!args.quiet) {
      const s = summarise(previous, cat);
      out(`updated ${cataloguePath(harness, deps.dir)}`);
      if (outcome.calls) out(`probe calls: ${outcome.calls} of at most ${maxCalls}, cost ${usd(outcome.costUsd)}`);
      out(`new: ${ids(s.added)}`);
      out(`missing: ${ids(s.nowMissing)}`);
      out(`recovered: ${ids(s.recovered)}`);
      out(`removed: ${ids(s.removed)}`);
      out(`needs review: ${ids(s.needsReview)}`);
      if (outcome.dropped.length) out(`not probed (call cap): ${ids(outcome.dropped)}`);
      if (outcome.inconclusive.length) out(`no answer (left unchanged): ${ids(outcome.inconclusive)}`);
      if (outcome.aborted) out(`note: ${outcome.aborted}`);
      for (const n of outcome.notes) out(`note: ${n}`);
    }
    return 0;
  } finally {
    unlock(lockPath);
  }
}

function runStatus(args: CliArgs, deps: CliDeps, out: (l: string) => void): number {
  const now = (deps.now ?? (() => new Date()))();
  const cfg = loadRefreshConfig(deps.configFile);
  const file = cataloguePath(args.harness, deps.dir);
  out(`harness: ${args.harness}`);
  out(`file: ${file}`);
  out(`background refresh: ${cfg.enabled ? 'enabled' : 'disabled'} (max age ${cfg.maxAgeDays} days, max ${cfg.maxCalls} calls)`);
  const cat = loadCatalogue(args.harness, deps.dir);
  if (!cat) {
    out('catalogue: none (run /jev-refresh or: bun scripts/jev-models.ts refresh)');
    return 0;
  }
  const days = (now.getTime() - Date.parse(cat.updated_at)) / 86_400_000;
  const freshness = isVeryStale(cat, now, cfg.maxAgeDays) ? 'very stale' : isStale(cat, now, cfg.maxAgeDays) ? 'stale' : 'fresh';
  out(`updated: ${cat.updated_at} (${days.toFixed(1)} days ago, ${freshness})`);
  out(`source: ${cat.source}`);
  const by = (status: string): string[] => cat.models.filter((m) => m.status === status).map((m) => m.id);
  out(`models: ${cat.models.length}`);
  out(`ok: ${ids(by('ok'))}`);
  out(`missing: ${ids(by('missing'))}`);
  out(`needs review: ${ids(by('needs-review'))}`);
  return 0;
}

function runList(args: CliArgs, deps: CliDeps, out: (l: string) => void): number {
  const cat = loadCatalogue(args.harness, deps.dir);
  const overrides = loadOverrides(deps.configFile);
  const tiers: CatalogueTier[] = ['free', 'cheap', 'standard', 'deep'];
  if (args.json) {
    out(JSON.stringify({ harness: args.harness, catalogue: cat, ladders: Object.fromEntries(tiers.map((t) => [t, ladder(cat, t, overrides)])) }, null, 2));
    return 0;
  }
  if (!cat) {
    out(`no catalogue for ${args.harness} (run /jev-refresh)`);
    return 0;
  }
  for (const tier of tiers) {
    out(`${tier}: ${ids(ladder(cat, tier, overrides))}`);
  }
  for (const m of cat.models) {
    out(`  ${m.id}  tier=${m.tier} status=${m.status}${m.alias ? ` alias=${m.alias}` : ''} strikes=${m.strikes}`);
  }
  return 0;
}

/** Run the command; returns the exit code. Never throws. */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  try {
    const args = parseArgs(argv);
    if (args.error) {
      err(`jev-models: ${args.error}`);
      err(USAGE);
      return 2;
    }
    if (args.command === 'help') {
      out(USAGE);
      return 0;
    }
    if (args.command === 'refresh') return await runRefresh(args, deps, out, err);
    if (args.command === 'status') return runStatus(args, deps, out);
    return runList(args, deps, out);
  } catch (e: any) {
    err(`jev-models: ${String(e?.message ?? e)}`);
    return 1;
  }
}
