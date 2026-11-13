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

/** `models.downgrade.mode` from the config file; undefined when the file, the key or the value is missing or invalid. */
export function loadDowngradeMode(configFile?: string): DowngradeMode | undefined {
  const file = configFile ?? process.env.JEV_CONFIG_FILE ?? path.join(os.homedir(), '.config', 'jev', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parseDowngradeMode(parsed?.models?.downgrade?.mode) ?? undefined;
  } catch {
    return undefined;
  }
}
