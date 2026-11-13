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
import { tryLock, unlock } from '../src/core/lock.js';
import { loadRefreshConfig, refreshLockPath, type RefreshConfig } from '../src/refresh/config.js';
import { PRIVATE_FILE_MODE } from '../src/core/private-fs.js';

export const REFRESH_HARNESS = 'claude-code';
/** A trigger-held lock older than this is taken over; the refresh itself needs at most about 20 minutes. */
export const TRIGGER_LOCK_STALE_MS = 30 * 60 * 1000;
const SCRIPT = path.resolve(import.meta.dir, '..', 'scripts', 'jev-models.ts');

export type TriggerResult =
  | 'started'
  | 'mode-off'
  | 'disabled'
  | 'fresh'
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
  scriptPath?: string;
  /** Starts the detached refresh. */
  spawnDetached?: (bun: string, args: string[]) => DetachedChild;
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

function defaultSpawnDetached(bun: string, args: string[]): DetachedChild {
  const child = spawn(bun, args, { detached: true, stdio: 'ignore', cwd: path.dirname(SCRIPT) });
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * Start a detached catalogue refresh when it is due. Returns why it did or did not start; never throws and never
 * waits for the refresh.
 *
 * Starts when all of these hold: Jev mode is `on` for Claude Code; `models.refresh.enabled` is not `false`; the
 * catalogue is missing or older than `models.refresh.maxAgeDays` (default 7); no other refresh holds the lock;
 * `bun` and the script are found. The lock is taken here and handed to the child by writing the child's pid into
 * it, so a second session starting a moment later sees a live owner and does nothing.
 */
export function maybeStartCatalogueRefresh(deps: TriggerDeps = {}): TriggerResult {
  let locked: string | null = null;
  try {
    if ((deps.env ?? process.env).JEV_MODEL_REFRESH === 'off') return 'disabled';
    const mode = (deps.readMode ?? (() => readJevModeSync(REFRESH_HARNESS)))();
    if (mode !== 'on') return 'mode-off';
    const cfg = (deps.loadConfig ?? (() => loadRefreshConfig()))();
    if (!cfg.enabled) return 'disabled';
    const cat = loadCatalogue(REFRESH_HARNESS, deps.dir);
    if (cat && !isStale(cat, deps.now ?? new Date(), cfg.maxAgeDays)) return 'fresh';

    const bun = (deps.findBun ?? findBun)();
    if (!bun) return 'no-bun';
    const script = deps.scriptPath ?? SCRIPT;
    if (!fs.existsSync(script)) return 'no-script';

    const lockPath = refreshLockPath(REFRESH_HARNESS, deps.dir);
    if (!tryLock(lockPath, TRIGGER_LOCK_STALE_MS)) return 'locked';
    locked = lockPath;

    let child: DetachedChild;
    try {
      child = (deps.spawnDetached ?? defaultSpawnDetached)(bun, [script, 'refresh', '--harness', REFRESH_HARNESS, '--quiet']);
    } catch {
      return 'spawn-failed';
    }
    if (typeof child.pid !== 'number') return 'spawn-failed';
    // Hand the lock to the child: it recognises its own pid and carries on; if it dies the lock goes stale.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, ts: Date.now() }), { mode: PRIVATE_FILE_MODE });
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
