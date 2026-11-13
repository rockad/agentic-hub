/**
 * Tolerant reader for `models.downgrade.mode` in the user config (`ask` | `auto` | `off`). The shared config
 * loader and its types are deliberately left untouched (its `models` map holds plain strings), so this reads the
 * one key it needs, the way `loadOverrides` reads `models.overrides`. Never throws.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type DowngradeMode = 'ask' | 'auto' | 'off';

/** The mode a string names, or null for anything else (case and surrounding spaces are tolerated). */
export function parseDowngradeMode(value: unknown): DowngradeMode | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === 'ask' || v === 'auto' || v === 'off' ? v : null;
}

function configPath(configFile?: string): string {
  return configFile ?? process.env.JEV_CONFIG_FILE ?? path.join(os.homedir(), '.config', 'jev', 'config.json');
}

/** `models.downgrade.mode` from the config file; undefined when the file, the key or the value is missing or invalid. */
export function loadDowngradeMode(configFile?: string): DowngradeMode | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(configFile), 'utf8'));
    return parseDowngradeMode(parsed?.models?.downgrade?.mode) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A finite number from a number or a numeric string; null for anything else (a boolean, NaN, an empty string). */
export function parseMinProbability(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `models.downgrade.minProbability` as written in the config file (not clamped); undefined when missing or not a number. */
export function loadDowngradeMinProbability(configFile?: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(configFile), 'utf8'));
    return parseMinProbability(parsed?.models?.downgrade?.minProbability) ?? undefined;
  } catch {
    return undefined;
  }
}
