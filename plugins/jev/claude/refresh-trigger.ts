/**
 * Background catalogue refresh, started from the SessionStart hook, plus the notice the hooks can show when a
 * model id is not in the catalogue.
 *
 * The trigger must never slow or break the hook: everything it does before returning is a few small synchronous
 * file reads, one lock create and one detached spawn. The refresh itself runs in its own process
 * (`scripts/jev-models.ts refresh --harness claude-code --quiet`), which is the only thing that makes paid probe
 * calls.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJevModeSync } from '../src/core/config.js';
import {
  DEFAULT_MAX_AGE_DAYS,
  compareVersions,
  isStale,
  loadCatalogue,
  parseModelId,
  resolveAlias,
  type Catalogue
} from '../src/core/catalogue.js';
import { handOffLock, tryLock, unlock } from '../src/core/lock.js';
import { attemptedRecently, loadRefreshConfig, refreshLockPath, writeAttempt, type RefreshConfig } from '../src/refresh/config.js';

export const REFRESH_HARNESS = 'claude-code';
/** A trigger-held lock older than this is taken over; the refresh itself needs at most about 20 minutes. */
export const TRIGGER_LOCK_STALE_MS = 30 * 60 * 1000;
const SCRIPT = path.resolve(import.meta.dir, '..', 'scripts', 'jev-models.ts');

export type TriggerResult =
  | 'started'
  | 'mode-off'
  | 'disabled'
  | 'fresh'
  | 'backoff'
  | 'locked'
  | 'no-bun'
  | 'no-script'
  | 'spawn-failed'
  | 'error';

export interface DetachedChild {
  pid?: number;
  unref(): void;
  on?(event: 'error', cb: () => void): unknown;
}

export interface TriggerDeps {
  /** Environment; `JEV_MODEL_REFRESH=off` disables the background refresh (the test suites set it). */
  env?: NodeJS.ProcessEnv;
  /** Jev mode for Claude Code. */
  readMode?: () => string;
  loadConfig?: () => RefreshConfig;
  /** Catalogue directory (tests). */
  dir?: string;
  now?: Date;
  /** Path of the bun executable, or null when there is none. */
  findBun?: () => string | null;
  /** Script to run; default `JEV_REFRESH_SCRIPT` from the environment (tests, development), else `scripts/jev-models.ts`. */
  scriptPath?: string;
  /** Starts the detached refresh. */
  spawnDetached?: (bun: string, args: string[]) => DetachedChild;
  /** `child_process.spawn` stand-in used by the default starter (tests assert the spawn options through it). */
  spawnFn?: SpawnFn;
}

/** The running bun when this process is bun, else a `bun` on PATH; null when neither exists. */
export function findBun(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
    for (const d of (env.PATH ?? '').split(path.delimiter)) {
      if (!d) continue;
      const candidate = path.join(d, process.platform === 'win32' ? 'bun.exe' : 'bun');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // next
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** How the refresh process is started: its own process group, no stdio, no console window on Windows. */
export const DETACHED_SPAWN_OPTIONS = { detached: true, stdio: 'ignore', windowsHide: true } as const;

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => DetachedChild;

function makeSpawnDetached(spawnFn: SpawnFn, cwd: string): (bun: string, args: string[]) => DetachedChild {
  return (bun, args) => {
    const child = spawnFn(bun, args, { ...DETACHED_SPAWN_OPTIONS, cwd });
    child.on?.('error', () => {});
    child.unref();
    return child;
  };
}

/**
 * Start a detached catalogue refresh when it is due. Returns why it did or did not start; never throws and never
 * waits for the refresh.
 *
 * Starts when all of these hold: Jev mode is `on` for Claude Code; `models.refresh.enabled` is not `false`; the
 * catalogue is missing or older than `models.refresh.maxAgeDays` (default 7); no refresh was attempted in the last
 * `models.refresh.minRetryHours` (default 6; the attempt stamp is written at spawn time and again when the refresh
 * ends, whatever the result, so a broken environment is not retried at every session start); no other refresh
 * holds the lock; `bun` and the script are found. The lock is taken here and handed to the child by writing the
 * child's pid into it (atomically), so a second session starting a moment later sees a live owner and does nothing.
 */
export function maybeStartCatalogueRefresh(deps: TriggerDeps = {}): TriggerResult {
  let locked: string | null = null;
  try {
    const env = deps.env ?? process.env;
    if (env.JEV_MODEL_REFRESH === 'off') return 'disabled';
    const mode = (deps.readMode ?? (() => readJevModeSync(REFRESH_HARNESS)))();
    if (mode !== 'on') return 'mode-off';
    const cfg = (deps.loadConfig ?? (() => loadRefreshConfig()))();
    if (!cfg.enabled) return 'disabled';
    const now = deps.now ?? new Date();
    const cat = loadCatalogue(REFRESH_HARNESS, deps.dir);
    if (cat && !isStale(cat, now, cfg.maxAgeDays)) return 'fresh';
    if (attemptedRecently(REFRESH_HARNESS, now, cfg.minRetryHours, deps.dir)) return 'backoff';

    const bun = (deps.findBun ?? findBun)();
    if (!bun) return 'no-bun';
    const script = deps.scriptPath ?? env.JEV_REFRESH_SCRIPT ?? SCRIPT;
    if (!fs.existsSync(script)) return 'no-script';

    const lockPath = refreshLockPath(REFRESH_HARNESS, deps.dir);
    if (!tryLock(lockPath, TRIGGER_LOCK_STALE_MS)) return 'locked';
    locked = lockPath;

    // Stamp before the spawn, so the child's own end-of-run stamp is never overwritten by this one.
    writeAttempt(REFRESH_HARNESS, 'started', now, deps.dir);
    let child: DetachedChild;
    try {
      const starter = deps.spawnDetached ?? makeSpawnDetached(deps.spawnFn ?? (spawn as unknown as SpawnFn), path.dirname(SCRIPT));
      child = starter(bun, [script, 'refresh', '--harness', REFRESH_HARNESS, '--quiet']);
    } catch {
      return 'spawn-failed';
    }
    if (typeof child.pid !== 'number') return 'spawn-failed';
    // Hand the lock to the child: it recognises its own pid and carries on; if it dies the lock goes stale.
    handOffLock(lockPath, child.pid, Date.now());
    locked = null;
    return 'started';
  } catch {
    return 'error';
  } finally {
    if (locked) unlock(locked);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------------------------------------------

export interface NoticeOptions {
  dir?: string;
  now?: Date;
  maxAgeDays?: number;
}

const HINT = 'run /jev-refresh';

/** Id as the harness names it, without a `[1m]` context suffix. */
function bareId(id: string): string {
  return id.trim().replace(/\[[^\]]*\]$/, '');
}

function findEntry(cat: Catalogue, id: string): Catalogue['models'][number] | undefined {
  const exact = cat.models.find((m) => m.id === id) ?? cat.models.find((m) => m.alias === id);
  if (exact) return exact;
  const p = parseModelId(id);
  if (!p) return undefined;
  if (p.alias) {
    const resolved = resolveAlias(cat, p.family);
    return resolved ? cat.models.find((m) => m.id === resolved) : undefined;
  }
  // a dated id (`claude-sonnet-4-20250514`) matches the entry with the same family and version
  return cat.models.find((m) => m.family === p.family && p.version.length > 0 && compareVersions(m.version, p.version) === 0);
}

/**
 * One line to show when `modelId` is a problem for the catalogue, else null. In order:
 * - no catalogue yet
 * - the id is not in the catalogue
 * - the id is marked missing
 * - the id is in the catalogue but unranked (needs review)
 * - the catalogue is stale
 * Every message ends with the hint to run /jev-refresh. Never throws; not yet wired into the hooks.
 */
export function catalogueNotice(harness: string, modelId: string, opts: NoticeOptions = {}): string | null {
  try {
    const id = bareId(modelId || '');
    if (!id) return null;
    const cat = loadCatalogue(harness, opts.dir);
    if (!cat) return `Jev model catalogue: none yet for ${harness}; ${HINT}`;
    const entry = findEntry(cat, id);
    if (!entry) return `Jev model catalogue: "${id}" is not in the catalogue; ${HINT}`;
    if (entry.status === 'missing') return `Jev model catalogue: "${id}" is marked missing; ${HINT}`;
    if (entry.status === 'needs-review') return `Jev model catalogue: "${id}" is not ranked yet (needs review); ${HINT}`;
    const maxAge = opts.maxAgeDays ?? loadRefreshConfig().maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    if (isStale(cat, opts.now ?? new Date(), maxAge)) {
      const days = Math.floor(((opts.now ?? new Date()).getTime() - Date.parse(cat.updated_at)) / 86_400_000);
      return `Jev model catalogue: last refreshed ${days} days ago; ${HINT}`;
    }
    return null;
  } catch {
    return null;
  }
}
