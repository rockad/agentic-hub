import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type JevMode = 'off' | 'on-demand' | 'on';
export const JEV_STATE_FILE = path.join(os.homedir(), '.config', 'jev', 'mode.json');
export const JEV_CONFIG_FILE = path.join(os.homedir(), '.config', 'jev', 'config.json');

export type JevHarness = 'antigravity' | 'claude-code' | 'cli';

export interface HarnessRoutingConfig {
  swap?: boolean;
  models?: Record<string, string>;
}

export interface HarnessConfig {
  mode: JevMode;
  routing?: HarnessRoutingConfig;
  requireUpgradeApproval?: boolean;
  availableSubagents?: string[];
}

export interface JevConfigDefaults {
  mode: JevMode;
  requireUpgradeApproval?: boolean;
  swap?: boolean;
  availableSubagents?: string[];
}

export interface JevConfig {
  version: number;
  defaults: JevConfigDefaults;
  thresholds?: Record<string, number>;
  harnesses?: Partial<Record<JevHarness, Partial<HarnessConfig>>>;
}

export const DEFAULT_JEV_CONFIG: JevConfig = {
  version: 1,
  defaults: {
    mode: 'on',
    requireUpgradeApproval: true,
    swap: true,
    availableSubagents: ['explore', 'general', 'code_engineer', 'research', 'vault_librarian', 'ghostwriter', 'inbox_processor', 'self']
  },
  thresholds: {
    five_hour_normal_min: 0.30,
    five_hour_conserve_min: 0.10,
    weekly_normal_min: 0.20,
    weekly_conserve_min: 0.10
  },
  harnesses: {
    antigravity: { mode: 'on' },
    'claude-code': { mode: 'on' },
    cli: { mode: 'on' }
  }
};

let cachedConfig: { at: number; data: JevConfig } | null = null;
const CONFIG_CACHE_TTL_MS = 2000;

export function loadJevConfigSync(): JevConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_CACHE_TTL_MS) {
    return cachedConfig.data;
  }

  let config: JevConfig = JSON.parse(JSON.stringify(DEFAULT_JEV_CONFIG));
  try {
    if (fsSync.existsSync(JEV_CONFIG_FILE)) {
      const parsed = JSON.parse(fsSync.readFileSync(JEV_CONFIG_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        config = {
          version: typeof parsed.version === 'number' ? parsed.version : config.version,
          defaults: { ...config.defaults, ...(parsed.defaults || {}) },
          thresholds: { ...config.thresholds, ...(parsed.thresholds || parsed.quota || {}) },
          harnesses: { ...config.harnesses, ...(parsed.harnesses || {}) }
        };
      }
    }
  } catch {
    // Return default on error
  }

  cachedConfig = { at: now, data: config };
  return config;
}

export async function loadJevConfig(): Promise<JevConfig> {
  return loadJevConfigSync();
}

export function getHarnessConfig(harness: JevHarness): HarnessConfig {
  const cfg = loadJevConfigSync();
  const overrides = cfg.harnesses?.[harness] || {};
  const mode = (overrides.mode || cfg.defaults.mode || 'on') as JevMode;
  const requireUpgradeApproval =
    typeof overrides.requireUpgradeApproval === 'boolean'
      ? overrides.requireUpgradeApproval
      : cfg.defaults.requireUpgradeApproval ?? true;
  const availableSubagents =
    Array.isArray(overrides.availableSubagents) && overrides.availableSubagents.length
      ? overrides.availableSubagents
      : cfg.defaults.availableSubagents;

  return {
    mode,
    routing: overrides.routing,
    requireUpgradeApproval,
    availableSubagents
  };
}

export async function readJevMode(harness?: JevHarness): Promise<JevMode> {
  if (harness) {
    return getHarnessConfig(harness).mode;
  }
  try {
    if (fsSync.existsSync(JEV_STATE_FILE)) {
      const parsed = JSON.parse(await fs.readFile(JEV_STATE_FILE, 'utf8'));
      const m = String(parsed.mode || '').toLowerCase();
      if (m === 'off' || m === 'on-demand' || m === 'on') return m as JevMode;
    }
  } catch {
    // fall through
  }
  return loadJevConfigSync().defaults.mode || 'on';
}
