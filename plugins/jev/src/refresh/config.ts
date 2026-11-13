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

export const DEFAULT_MAX_CALLS = 20;
/** Whatever the config or the command line says, one refresh never makes more probe calls than this. */
export const ABSOLUTE_MAX_CALLS = 100;

export interface RefreshConfig {
  /** False only when the config says `false`: the background refresh is on by default. */
  enabled: boolean;
  maxAgeDays: number;
  maxCalls: number;
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

function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function loadRefreshConfig(configFile?: string): RefreshConfig {
  const out: RefreshConfig = {
    enabled: true,
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    maxCalls: DEFAULT_MAX_CALLS,
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
