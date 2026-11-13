/**
 * Tolerant reader for the `models.refresh` object in the user config (`~/.config/jev/config.json`, or the file
 * named by `JEV_CONFIG_FILE`). Same style as `loadOverrides`: the shared config schema is left alone, this reads
 * the one key it needs, drops anything invalid and never throws.
 *
 *   { "models": { "refresh": { "enabled": true, "maxAgeDays": 7, "maxCalls": 20, "candidates": ["claude-sonnet-6"] } } }
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { catalogueDir, DEFAULT_MAX_AGE_DAYS } from '../core/catalogue.js';
import { privateDir, PRIVATE_FILE_MODE } from '../core/private-fs.js';

export const DEFAULT_MAX_CALLS = 20;
/**
 * Whatever the config or the command line says, one refresh never makes more probe calls than this. With the 60 s
 * probe timeout, 25 calls is 25 minutes at worst, under the 30 minute lock stale time (the refresh also writes a
 * heartbeat after every probe).
 */
export const ABSOLUTE_MAX_CALLS = 25;
/** After any refresh attempt (started, failed or inconclusive) the SessionStart trigger waits this long. */
export const DEFAULT_MIN_RETRY_HOURS = 6;

export interface RefreshConfig {
  /** False only when the config says `false`: the background refresh is on by default. */
  enabled: boolean;
  maxAgeDays: number;
  maxCalls: number;
  /** Minimum hours between two background refresh attempts, whatever their outcome. */
  minRetryHours: number;
  /** User-added candidate ids for the Claude Code probe. */
  candidates: string[];
}

export function defaultConfigFile(): string {
  return process.env.JEV_CONFIG_FILE || path.join(os.homedir(), '.config', 'jev', 'config.json');
}

/** The refresh lock of a harness, next to its catalogue file: one refresh per harness at a time. */
export function refreshLockPath(harness: string, dir?: string): string {
  return path.join(catalogueDir(dir), `${harness}.lock`);
}

export interface AttemptStamp {
  /** ISO time of the attempt. */
  ts: string;
  /** `started` (written by the trigger at spawn time) or how the run ended: `ok`, `inconclusive`, `error`. */
  result: string;
}

/** The attempt stamp of a harness, next to its catalogue file: when the last refresh was tried and how it went. */
export function attemptPath(harness: string, dir?: string): string {
  return path.join(catalogueDir(dir), `${harness}.attempt.json`);
}

/** Write the attempt stamp (temp file and rename). Returns false when it could not be written; never throws. */
export function writeAttempt(harness: string, result: string, now: Date, dir?: string): boolean {
  const file = attemptPath(harness, dir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    privateDir(path.dirname(file));
    fs.writeFileSync(tmp, JSON.stringify({ ts: now.toISOString(), result } satisfies AttemptStamp) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    return false;
  }
}

/** The last attempt stamp, or null when there is none or it is unreadable. */
export function readAttempt(harness: string, dir?: string): AttemptStamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(attemptPath(harness, dir), 'utf8'));
    if (raw && typeof raw.ts === 'string' && Number.isFinite(Date.parse(raw.ts))) {
      return { ts: raw.ts, result: typeof raw.result === 'string' ? raw.result : 'unknown' };
    }
  } catch {
    // none
  }
  return null;
}

/** True when the last attempt was less than `minRetryHours` before `now`. A stamp from the future counts as recent. */
export function attemptedRecently(harness: string, now: Date, minRetryHours: number, dir?: string): boolean {
  const last = readAttempt(harness, dir);
  if (!last) return false;
  return now.getTime() - Date.parse(last.ts) < minRetryHours * 3_600_000;
}

function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function loadRefreshConfig(configFile?: string): RefreshConfig {
  const out: RefreshConfig = {
    enabled: true,
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    maxCalls: DEFAULT_MAX_CALLS,
    minRetryHours: DEFAULT_MIN_RETRY_HOURS,
    candidates: []
  };
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configFile ?? defaultConfigFile(), 'utf8'))?.models?.refresh;
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.enabled === false) out.enabled = false;
  const age = positiveNumber(raw.maxAgeDays);
  if (age !== null) out.maxAgeDays = age;
  const calls = positiveNumber(raw.maxCalls);
  if (calls !== null) out.maxCalls = Math.min(Math.max(1, Math.floor(calls)), ABSOLUTE_MAX_CALLS);
  const retry = positiveNumber(raw.minRetryHours);
  if (retry !== null) out.minRetryHours = retry;
  if (Array.isArray(raw.candidates)) {
    const seen = new Set<string>();
    for (const c of raw.candidates) {
      if (typeof c !== 'string') continue;
      const id = c.trim();
      // an id goes to a command line: plain model-id characters only
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,99}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.candidates.push(id);
    }
  }
  return out;
}
