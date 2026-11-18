import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  callJev,
  ensureSecretsLoaded,
  JEV_MODEL
} from './client.js';
import {
  computeDecisionCacheKey,
  getCachedDecision,
  setCachedDecision
} from './cache.js';
import { JEV_CONFIG_FILE, type JevMode } from './config.js';
import { isFormattingTask } from './heuristics.js';
import { getTracer } from '../tracing.js';
import { privateDir, privateFile, PRIVATE_FILE_MODE, jevHomeDir } from './private-fs.js';
import { safeSessionId } from '../../claude/logic.js';
export { safeSessionId };
import { readRegularFile } from '../../claude/safe-read.js';

// ── Antigravity quota view ───────────────────────────────────────────────────
/** Default quota-state path, fixed when the module loads. `readQuotaView` resolves `quotaStateFile()` at call time instead. */
export const QUOTA_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'quota-state.json');
export function quotaStateFile(): string {
  return path.join(jevHomeDir(), '.gemini', 'antigravity-cli', 'quota-state.json');
}
/** Legacy schema-1 quota fallback; `JEV_QUOTA_LEGACY_FILE` overrides it at call time so tests can isolate it. */
export const QUOTA_LEGACY_FILE = '/tmp/antigravity-quota.json';

export const DEFAULT_5H_NORMAL_MIN = 0.30;
export const DEFAULT_5H_CONSERVE_MIN = 0.10;
export const DEFAULT_WEEKLY_NORMAL_MIN = 0.20;
export const DEFAULT_WEEKLY_CONSERVE_MIN = 0.10;

export const QUOTA_NORMAL_MIN = DEFAULT_5H_NORMAL_MIN;
export const QUOTA_CONSERVE_MIN = DEFAULT_5H_CONSERVE_MIN;
export const QUOTA_5H_NORMAL_MIN = DEFAULT_5H_NORMAL_MIN;
export const QUOTA_5H_CONSERVE_MIN = DEFAULT_5H_CONSERVE_MIN;
export const QUOTA_WEEKLY_NORMAL_MIN = DEFAULT_WEEKLY_NORMAL_MIN;
export const QUOTA_WEEKLY_CONSERVE_MIN = DEFAULT_WEEKLY_CONSERVE_MIN;
export const QUOTA_STALE_SECONDS = Number(process.env.JEV_QUOTA_STALE_SECONDS || 15 * 60);

export interface QuotaThresholds {
  normal_min: number;
  conserve_min: number;
  five_hour_normal_min: number;
  five_hour_conserve_min: number;
  weekly_normal_min: number;
  weekly_conserve_min: number;
}

export function getQuotaThresholds(): QuotaThresholds {
  ensureSecretsLoaded();

  let fileConfig: any = {};
  try {
    if (fsSync.existsSync(JEV_CONFIG_FILE)) {
      fileConfig = JSON.parse(fsSync.readFileSync(JEV_CONFIG_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }

  const fileThresholds = fileConfig.thresholds || fileConfig.quota || {};

  const parseNum = (val: any): number | undefined => {
    if (typeof val === 'number' && !Number.isNaN(val)) return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const n = Number(val);
      if (!Number.isNaN(n)) return n;
    }
    return undefined;
  };

  const fiveHourNormalMin =
    parseNum(process.env.JEV_QUOTA_5H_NORMAL_MIN) ??
    parseNum(process.env.JEV_QUOTA_5H_THRESHOLD) ??
    parseNum(fileThresholds.five_hour_normal_min) ??
    parseNum(fileThresholds.quota_5h_threshold) ??
    parseNum(fileThresholds['5h_normal_min']) ??
    parseNum(fileThresholds['5h']) ??
    parseNum(process.env.JEV_QUOTA_NORMAL_MIN) ??
    DEFAULT_5H_NORMAL_MIN;

  const fiveHourConserveMin =
    parseNum(process.env.JEV_QUOTA_5H_CONSERVE_MIN) ??
    parseNum(process.env.JEV_QUOTA_5H_CRITICAL) ??
    parseNum(fileThresholds.five_hour_conserve_min) ??
    parseNum(fileThresholds.quota_5h_critical) ??
    parseNum(fileThresholds['5h_conserve_min']) ??
    parseNum(process.env.JEV_QUOTA_CONSERVE_MIN) ??
    DEFAULT_5H_CONSERVE_MIN;

  const weeklyNormalMin =
    parseNum(process.env.JEV_QUOTA_WEEKLY_NORMAL_MIN) ??
    parseNum(process.env.JEV_QUOTA_WEEKLY_THRESHOLD) ??
    parseNum(process.env.JEV_QUOTA_7D_NORMAL_MIN) ??
    parseNum(process.env.JEV_QUOTA_7D_THRESHOLD) ??
    parseNum(fileThresholds.weekly_normal_min) ??
    parseNum(fileThresholds.seven_day_normal_min) ??
    parseNum(fileThresholds['7d_normal_min']) ??
    parseNum(fileThresholds.quota_weekly_threshold) ??
    parseNum(fileThresholds.quota_7d_threshold) ??
    parseNum(fileThresholds['weekly_normal_min']) ??
    parseNum(fileThresholds['weekly']) ??
    parseNum(fileThresholds['7d']) ??
    DEFAULT_WEEKLY_NORMAL_MIN;

  const weeklyConserveMin =
    parseNum(process.env.JEV_QUOTA_WEEKLY_CONSERVE_MIN) ??
    parseNum(process.env.JEV_QUOTA_WEEKLY_CRITICAL) ??
    parseNum(process.env.JEV_QUOTA_7D_CONSERVE_MIN) ??
    parseNum(process.env.JEV_QUOTA_7D_CRITICAL) ??
    parseNum(fileThresholds.weekly_conserve_min) ??
    parseNum(fileThresholds.seven_day_conserve_min) ??
    parseNum(fileThresholds['7d_conserve_min']) ??
    parseNum(fileThresholds.quota_weekly_critical) ??
    parseNum(fileThresholds.quota_7d_critical) ??
    parseNum(fileThresholds['weekly_conserve_min']) ??
    DEFAULT_WEEKLY_CONSERVE_MIN;

  return {
    normal_min: fiveHourNormalMin,
    conserve_min: fiveHourConserveMin,
    five_hour_normal_min: fiveHourNormalMin,
    five_hour_conserve_min: fiveHourConserveMin,
    weekly_normal_min: weeklyNormalMin,
    weekly_conserve_min: weeklyConserveMin
  };
}

export interface QuotaBucket {
  remaining_fraction: number;
  used_fraction: number;
  used_pct: number;
  reset_at: number | null;
  reset_in_seconds: number | null;
  effective_remaining_fraction: number;
  refreshed: boolean;
}

export type QuotaStrategy = 'normal' | 'conserve' | 'free_only' | 'unknown';

export const ANTIGRAVITY_SESSION_TTL_SEC = 7200;

export type AntigravitySessionRecord = {
  conversationId: string;
  model: string;
  updated_at: number;
};

export type ActiveModelSource = 'argument' | 'env' | 'latest' | 'quota-state';

export type OrchestratorVariant = 'argon' | 'carbon';

export interface QuotaPoolView {
  pool?: string;
  five_hour: number | null;
  weekly: number | null;
  min_remaining: number | null;
  strategy: QuotaStrategy;
}

export interface OrchestratorQuotaFields {
  variant: OrchestratorVariant;
  pools: {
    execution: QuotaPoolView;
    frontier: QuotaPoolView;
  };
}

export interface QuotaView {
  source: string;
  schema: number;
  stale: boolean;
  updated_at: number | null;
  plan_tier?: string;
  active_model?: string;
  quota_state_active_model?: string;
  activeModelSource?: ActiveModelSource;
  buckets: Record<string, QuotaBucket>;
  gemini: { five_hour: number | null; weekly: number | null; min_remaining: number | null };
  strategy: QuotaStrategy;
  thresholds: QuotaThresholds;
  geminiRemainingFraction: number | null;
  /** Pool backing the currently selected model (Gemini buckets for Gemini models, 3p buckets otherwise). */
  active: QuotaPoolView & { pool: 'gemini' | '3p' };
  variant?: OrchestratorVariant;
  pools?: {
    execution: QuotaPoolView;
    frontier: QuotaPoolView;
  };
}

export function evaluatePoolStrategy(
  fiveHour: number | null,
  weekly: number | null,
  t: QuotaThresholds
): QuotaStrategy {
  if (fiveHour === null && weekly === null) return 'unknown';

  const is5hCritical = fiveHour !== null && fiveHour <= t.five_hour_conserve_min;
  const isWeeklyCritical = weekly !== null && weekly <= t.weekly_conserve_min;
  if (is5hCritical || isWeeklyCritical) {
    return 'free_only';
  }

  const is5hConserve = fiveHour !== null && fiveHour <= t.five_hour_normal_min;
  const isWeeklyConserve = weekly !== null && weekly <= t.weekly_normal_min;
  if (is5hConserve || isWeeklyConserve) {
    return 'conserve';
  }

  return 'normal';
}

export function normaliseBucket(nowSec: number, raw: any): QuotaBucket | null {
  if (!raw || typeof raw.remaining_fraction !== 'number') return null;
  const rem = raw.remaining_fraction;
  const resetAt =
    typeof raw.reset_at === 'number' ? raw.reset_at
    : typeof raw.quota_resets_at === 'number' ? raw.quota_resets_at
    : typeof raw.reset_in_seconds === 'number' ? nowSec + raw.reset_in_seconds
    : null;
  const refreshed = resetAt !== null && nowSec >= resetAt;
  return {
    remaining_fraction: rem,
    used_fraction: typeof raw.used_fraction === 'number' ? raw.used_fraction : 1 - rem,
    used_pct: typeof raw.used_pct === 'number' ? raw.used_pct : Math.round((1 - rem) * 1000) / 10,
    reset_at: resetAt,
    reset_in_seconds: typeof raw.reset_in_seconds === 'number' ? raw.reset_in_seconds : resetAt !== null ? resetAt - nowSec : null,
    effective_remaining_fraction: refreshed ? 1 : rem,
    refreshed
  };
}

export function getAntigravitySessionsDir(): string {
  const jevDir = process.env.JEV_CONFIG_FILE
    ? path.dirname(process.env.JEV_CONFIG_FILE)
    : path.join(jevHomeDir(), '.config', 'jev');
  return path.join(jevDir, 'antigravity-sessions');
}

const PRUNE_INTERVAL_SEC = 600; // 10 minutes

export function pruneExpiredSessionModels(sessionsDir: string, nowSec: number, force = false): void {
  try {
    const stampFile = path.join(sessionsDir, '.prune-stamp');
    if (!force) {
      try {
        if (fsSync.existsSync(stampFile)) {
          const raw = fsSync.readFileSync(stampFile, 'utf8');
          const lastPrune = Number(raw.trim());
          if (!Number.isNaN(lastPrune) && nowSec - lastPrune < PRUNE_INTERVAL_SEC) {
            return;
          }
        }
      } catch {
        // ignore read error and proceed
      }
    }

    try {
      fsSync.writeFileSync(stampFile, String(nowSec), { mode: PRIVATE_FILE_MODE });
      privateFile(stampFile);
    } catch {
      // ignore
    }

    const entries = fsSync.readdirSync(sessionsDir);
    for (const name of entries) {
      const filePath = path.join(sessionsDir, name);
      if (name.endsWith('.write-guard.json') || name.endsWith('.turn.json')) {
        // Write-guard streak files and per-conversation turn state carry no model: expire them by their last write, with the same TTL.
        try {
          const st = fsSync.statSync(filePath);
          if (st.isFile() && nowSec - st.mtimeMs / 1000 > ANTIGRAVITY_SESSION_TTL_SEC) {
            fsSync.unlinkSync(filePath);
          }
        } catch {
          // ignore
        }
        continue;
      }
      if (!name.endsWith('.model.json')) continue;
      try {
        const read = readRegularFile(filePath, 64 * 1024);
        if (read.kind === 'ok') {
          const parsed = JSON.parse(read.text);
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.updated_at === 'number' &&
            nowSec - parsed.updated_at > ANTIGRAVITY_SESSION_TTL_SEC
          ) {
            fsSync.unlinkSync(filePath);
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // best-effort
  }
}

export function writeAntigravitySessionModel(
  conversationId: string,
  model: string,
  nowSec?: number,
  overrideSessionsDir?: string
): void {
  const safeId = safeSessionId(conversationId);
  if (!safeId || !model || typeof model !== 'string' || model.trim().length === 0) {
    return;
  }

  const trimmedModel = model.trim();
  const currentSec = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
  const sessionsDir = overrideSessionsDir || getAntigravitySessionsDir();

  try {
    privateDir(sessionsDir);

    const record: AntigravitySessionRecord = {
      conversationId: safeId,
      model: trimmedModel,
      updated_at: currentSec
    };
    const content = JSON.stringify(record, null, 2) + '\n';

    // 1. Write <sessionsDir>/<safeId>.model.json atomically
    const modelFile = path.join(sessionsDir, `${safeId}.model.json`);
    const tmp1 = `${modelFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fsSync.writeFileSync(tmp1, content, { mode: PRIVATE_FILE_MODE });
    privateFile(tmp1);
    fsSync.renameSync(tmp1, modelFile);
    privateFile(modelFile);

    // 2. Write <sessionsDir>/latest.json atomically
    const latestFile = path.join(sessionsDir, 'latest.json');
    const tmp2 = `${latestFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fsSync.writeFileSync(tmp2, content, { mode: PRIVATE_FILE_MODE });
    privateFile(tmp2);
    fsSync.renameSync(tmp2, latestFile);
    privateFile(latestFile);

    // 3. Best-effort pruning (only in writers, at most once per 10m)
    pruneExpiredSessionModels(sessionsDir, currentSec);
  } catch {
    // best-effort; never crash the caller
  }
}

/**
 * Read the multi-bucket quota state. Prefers schema v2, falls back to legacy single-bucket.
 * Resolves active_model and activeModelSource with per-field precedence.
 */
export async function readQuotaView(opts?: { conversationId?: string; overrideSessionsDir?: string }): Promise<QuotaView> {
  const nowSec = Math.floor(Date.now() / 1000);
  let source = 'none';
  let schema = 0;
  let updatedAt: number | null = null;
  let planTier: string | undefined;
  let rawActiveModel: string | undefined;
  let rawBuckets: Record<string, any> = {};

  const tryParse = (file: string): any | null => {
    try {
      if (fsSync.existsSync(file)) return JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch {
      // ignore
    }
    return null;
  };

  const quotaFile = process.env.JEV_QUOTA_STATE_FILE || quotaStateFile();
  const v2 = tryParse(quotaFile);
  if (v2 && typeof v2 === 'object') {
    if (v2.buckets && typeof v2.buckets === 'object') {
      source = quotaFile; schema = Number(v2.schema || 2); updatedAt = v2.updated_at ?? null;
      planTier = v2.plan_tier; rawActiveModel = v2.active_model; rawBuckets = v2.buckets;
    } else if (typeof v2.remaining_fraction === 'number') {
      source = quotaFile; schema = 1; updatedAt = v2.updated_at ?? null;
      rawBuckets = { 'gemini-5h': v2 };
    }
  }

  if (schema === 0) {
    const legacyFile = process.env.JEV_QUOTA_LEGACY_FILE || QUOTA_LEGACY_FILE;
    const legacy = tryParse(legacyFile);
    if (legacy && typeof legacy.remaining_fraction === 'number') {
      source = legacyFile; schema = 1; updatedAt = legacy.updated_at ?? null;
      rawBuckets = { 'gemini-5h': legacy };
    }
  }

  // Resolve active_model and activeModelSource with per-field precedence
  const sessionsDir = opts?.overrideSessionsDir || getAntigravitySessionsDir();
  let activeModel: string | undefined = rawActiveModel;
  let activeModelSource: ActiveModelSource = 'quota-state';

  const readSessionFile = (fileName: string): AntigravitySessionRecord | null => {
    const filePath = path.join(sessionsDir, fileName);
    try {
      const read = readRegularFile(filePath, 64 * 1024);
      if (read.kind === 'ok') {
        const parsed = JSON.parse(read.text);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.model === 'string' &&
          parsed.model.trim().length > 0 &&
          typeof parsed.updated_at === 'number'
        ) {
          return {
            conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
            model: parsed.model.trim(),
            updated_at: parsed.updated_at
          };
        }
      }
    } catch {
      // ignore
    }
    return null;
  };

  // 1. Argument conversationId
  const safeId = opts?.conversationId ? safeSessionId(opts.conversationId) : null;
  if (safeId) {
    const rec = readSessionFile(`${safeId}.model.json`);
    if (rec && nowSec - rec.updated_at <= ANTIGRAVITY_SESSION_TTL_SEC) {
      activeModel = rec.model;
      activeModelSource = 'argument';
    }
  }

  // 2. ANTIGRAVITY_CONVERSATION_ID ('env') - skipped until Live Check 7 confirms it

  // 3. Otherwise latest.json
  if (activeModelSource === 'quota-state') {
    const rec = readSessionFile('latest.json');
    if (rec && nowSec - rec.updated_at <= ANTIGRAVITY_SESSION_TTL_SEC) {
      activeModel = rec.model;
      activeModelSource = 'latest';
    }
  }

  // 4. Otherwise quota-state.json (activeModel remains rawActiveModel, activeModelSource is 'quota-state')

  const buckets: Record<string, QuotaBucket> = {};
  for (const [k, v] of Object.entries(rawBuckets)) {
    const b = normaliseBucket(nowSec, v);
    if (b) buckets[k] = b;
  }

  const isOrchestrator = isOrchestratorModel(activeModel);
  const isArgonActive = Boolean(activeModel && /argon/i.test(activeModel));
  const isHydrogenActive = Boolean(activeModel && /hydrogen/i.test(activeModel));
  const argonWeeklyKey = Object.keys(buckets).find((k) => /argon/i.test(k) && /week|7d/i.test(k)) ?? 'gemini-argon-wtu-weekly';
  const argonFiveKey = Object.keys(buckets).find((k) => /argon/i.test(k) && /5h/i.test(k));
  const hydrogenWeeklyKey = Object.keys(buckets).find((k) => /hydrogen/i.test(k) && /week|7d/i.test(k));
  const hydrogenFiveKey = Object.keys(buckets).find((k) => /hydrogen/i.test(k) && /5h/i.test(k));

  const thresholds = getQuotaThresholds();
  const stale = updatedAt === null || nowSec - updatedAt > QUOTA_STALE_SECONDS;

  if (isOrchestrator) {
    let variant: OrchestratorVariant = 'argon';
    // The variant follows the RESOLVED active model (the conversation's own record, or latest.json), never the global
    // quota-state model while a fresher source won: that file can be stale and name the other variant. When the source
    // is quota-state, the resolved model is that same value.
    const qm = activeModel || '';
    if (/carbon/i.test(qm)) {
      variant = 'carbon';
    } else if (/argon/i.test(qm)) {
      variant = 'argon';
    } else if (planTier && /pro/i.test(planTier)) {
      variant = 'argon';
    } else {
      let configVariant: string | undefined;
      try {
        const cfgFile = process.env.JEV_CONFIG_FILE || JEV_CONFIG_FILE;
        if (fsSync.existsSync(cfgFile)) {
          const cfg = JSON.parse(fsSync.readFileSync(cfgFile, 'utf8'));
          configVariant = cfg.models?.orchestratorVariant;
        }
      } catch {}
      if (configVariant && /carbon/i.test(configVariant)) {
        variant = 'carbon';
      } else {
        variant = 'argon';
      }
    }

    const execFive = buckets['gemini-5h']?.effective_remaining_fraction ?? null;
    const execWeekly = buckets['gemini-weekly']?.effective_remaining_fraction ?? null;
    const execCands = [execFive, execWeekly].filter((x): x is number => typeof x === 'number');
    const execMin = execCands.length ? Math.min(...execCands) : null;
    const execStrategy = evaluatePoolStrategy(execFive, execWeekly, thresholds);

    const execPool: QuotaPoolView = {
      pool: 'execution',
      five_hour: execFive,
      weekly: execWeekly,
      min_remaining: execMin,
      strategy: execStrategy
    };

    let frontierFive: number | null = null;
    let frontierWeekly: number | null = null;
    if (variant === 'argon') {
      frontierFive = null;
      frontierWeekly = buckets['gemini-argon-wtu-weekly']?.effective_remaining_fraction
        ?? buckets[argonWeeklyKey]?.effective_remaining_fraction
        ?? null;
    } else {
      frontierFive = null;
      frontierWeekly = buckets['gemini-weekly']?.effective_remaining_fraction ?? null;
    }
    const frontierCands = [frontierFive, frontierWeekly].filter((x): x is number => typeof x === 'number');
    const frontierMin = frontierCands.length ? Math.min(...frontierCands) : null;
    const frontierStrategy = evaluatePoolStrategy(frontierFive, frontierWeekly, thresholds);

    const frontierPool: QuotaPoolView = {
      pool: 'frontier',
      five_hour: frontierFive,
      weekly: frontierWeekly,
      min_remaining: frontierMin,
      strategy: frontierStrategy
    };

    const orchestratorActive: QuotaPoolView & { pool: 'gemini' | '3p' } = {
      pool: 'gemini',
      five_hour: execFive,
      weekly: execWeekly,
      min_remaining: execMin,
      strategy: execStrategy
    };

    return {
      source,
      schema,
      stale,
      updated_at: updatedAt,
      plan_tier: planTier,
      active_model: activeModel,
      quota_state_active_model: rawActiveModel,
      activeModelSource,
      buckets,
      gemini: { five_hour: execFive, weekly: execWeekly, min_remaining: execMin },
      strategy: execStrategy,
      thresholds,
      geminiRemainingFraction: execMin,
      active: orchestratorActive,
      variant,
      pools: {
        execution: execPool,
        frontier: frontierPool
      }
    };
  }

  const geminiFive = (isArgonActive && argonFiveKey ? buckets[argonFiveKey]?.effective_remaining_fraction : undefined)
    ?? (isHydrogenActive && hydrogenFiveKey ? buckets[hydrogenFiveKey]?.effective_remaining_fraction : undefined)
    ?? buckets['gemini-5h']?.effective_remaining_fraction ?? null;
  const geminiWeekly = (isArgonActive ? buckets[argonWeeklyKey]?.effective_remaining_fraction : undefined)
    ?? (isHydrogenActive && hydrogenWeeklyKey ? buckets[hydrogenWeeklyKey]?.effective_remaining_fraction : undefined)
    ?? buckets['gemini-weekly']?.effective_remaining_fraction ?? null;
  const p3Five = buckets['3p-5h']?.effective_remaining_fraction ?? null;
  const p3Weekly = buckets['3p-weekly']?.effective_remaining_fraction ?? null;

  const geminiCandidates = [geminiFive, geminiWeekly].filter((x): x is number => typeof x === 'number');
  const p3Candidates = [p3Five, p3Weekly].filter((x): x is number => typeof x === 'number');
  const geminiMin = geminiCandidates.length ? Math.min(...geminiCandidates) : null;
  const p3Min = p3Candidates.length ? Math.min(...p3Candidates) : null;

  const availablePools = [geminiMin, p3Min].filter((x): x is number => typeof x === 'number');
  const minRemaining = availablePools.length ? Math.max(...availablePools) : null;

  const geminiStrategy = evaluatePoolStrategy(geminiFive, geminiWeekly, thresholds);
  const p3Strategy = evaluatePoolStrategy(p3Five, p3Weekly, thresholds);

  let strategy: QuotaStrategy = 'unknown';
  if (geminiStrategy !== 'unknown' && p3Strategy !== 'unknown') {
    const rank = (s: QuotaStrategy) => s === 'normal' ? 3 : s === 'conserve' ? 2 : s === 'free_only' ? 1 : 0;
    strategy = rank(geminiStrategy) >= rank(p3Strategy) ? geminiStrategy : p3Strategy;
  } else if (geminiStrategy !== 'unknown') {
    strategy = geminiStrategy;
  } else if (p3Strategy !== 'unknown') {
    strategy = p3Strategy;
  }

  // The selected model decides which pool is spent: non-Gemini models draw on the 3p buckets.
  const isGeminiActive = !activeModel || /gemini|argon|hydrogen/i.test(activeModel) || p3Min === null;
  const active = isGeminiActive
    ? { pool: 'gemini' as const, five_hour: geminiFive, weekly: geminiWeekly, min_remaining: geminiMin ?? minRemaining, strategy: geminiStrategy }
    : { pool: '3p' as const, five_hour: p3Five, weekly: p3Weekly, min_remaining: p3Min, strategy: p3Strategy };

  return {
    source,
    schema,
    stale,
    updated_at: updatedAt,
    plan_tier: planTier,
    active_model: activeModel,
    quota_state_active_model: rawActiveModel,
    activeModelSource,
    buckets,
    gemini: { five_hour: geminiFive, weekly: geminiWeekly, min_remaining: geminiMin ?? minRemaining },
    strategy,
    thresholds,
    geminiRemainingFraction: geminiMin ?? minRemaining,
    active
  };
}

export function quotaRecommendation(strategy: string): string {
  switch (strategy) {
    case 'free_only':
      return 'Gemini quota critically low. Route non-trivial generation to openrouter/free via jev_execute_free/jev_agent_free; avoid pro/flash tiers.';
    case 'conserve':
      return 'Gemini quota limited. Prefer flash_lite and free-tier offloads; reserve flash/pro for high-value work.';
    case 'normal':
      return 'Gemini quota healthy. Normal tier selection applies.';
    default:
      return 'Quota state unknown or stale. Assume limited: prefer free-tier offloads until the statusline refreshes.';
  }
}

// ── Model Tier Ranking & Clamping ────────────────────────────────────────────
export function isOrchestratorModel(model?: string | null): boolean {
  if (!model || typeof model !== 'string') return false;
  return /orchestrator/i.test(model);
}

export function subagentCeilingRank(sessionModel?: string | null): number {
  if (isOrchestratorModel(sessionModel)) {
    return 2; // flash
  }
  return modelTierRank(sessionModel ?? '');
}

const STRATEGY_SEVERITY: Record<QuotaStrategy, number> = {
  free_only: 0,
  conserve: 1,
  normal: 2,
  unknown: 3
};

export function comparePoolSeverity(a: QuotaPoolView, b: QuotaPoolView): QuotaPoolView {
  const sevA = STRATEGY_SEVERITY[a.strategy] ?? 3;
  const sevB = STRATEGY_SEVERITY[b.strategy] ?? 3;
  if (sevA < sevB) return a;
  if (sevB < sevA) return b;
  const remA = typeof a.min_remaining === 'number' ? a.min_remaining : 1;
  const remB = typeof b.min_remaining === 'number' ? b.min_remaining : 1;
  return remA <= remB ? a : b;
}

export function poolForTier(view: QuotaView, tier: string): QuotaPoolView {
  if (view.pools) {
    const t = (tier || '').toLowerCase().trim();
    if (t === 'pro' || t === 'judgement' || modelTierRank(t) >= 3) {
      return comparePoolSeverity(view.pools.execution, view.pools.frontier);
    }
    return view.pools.execution;
  }
  return view.active;
}

export function modelTierRank(tierOrModel: string): number {
  const t = (tierOrModel || '').toLowerCase();
  if (t.includes('free') || t === 'openrouter_free') return 0;
  if (t.includes('flash_lite') || t.includes('flash-lite')) return 1;
  if (t.includes('flash') || t.includes('hydrogen') || t.includes('cheap') || t.includes('standard')) return 2;
  if (t.includes('pro') || t.includes('argon') || t.includes('opus') || t.includes('fable') || t.includes('expensive') || t === 'deep') return 3;
  return 2;
}

export function rankToTierName(rank: number): 'openrouter_free' | 'flash_lite' | 'flash' | 'pro' {
  if (rank <= 0) return 'openrouter_free';
  if (rank === 1) return 'flash_lite';
  if (rank === 2) return 'flash';
  return 'pro';
}

/** Whole words and whole phrases only: "jargon" and "Argonaut" are not "argon". Matched against lowercase text.
 * Bare "argon" is dropped: in Antigravity only Gemini Pro / Claude Opus (or explicit "gemini argon") are valid model names;
 * bare "argon" collides with argon hashing ("hash it with argon") or chemical argon. Specific phrases like
 * "argon subagent", "argon coordinator", "argon agent", or "argon model" are recognized as explicit overrides.
 */
const PRO_OVERRIDE_PHRASES =
  /(?<![\w-])(?:manual\s+pro\s+approval|gemini\s+pro|gemini\s+argon|(?:gemini\s+)?argon\s+(?:coordinator|subagent|agent|model)|claude\s+opus|(?:claude\s+)?fable|deep\s+reasoning|cross-system\s+architecture)(?![\w-])/g;

/** Negators that indicate negation of the model directive. */
const NEGATOR_PATTERN =
  /\b(?:don'?t|do\s+not|never|not|no|without|avoid|stop|instead\s+of|rather\s+than)\b/i;

/** Affirmative contrast resets: "but", "however", or an imperative directive after a completed negative clause like "Do not rush, use deep reasoning". */
const AFFIRMATIVE_RESET_PATTERN =
  /\b(?:but|however)\b|\b(?:rush|worry|panic|hesitate|stop|wait|delay)\s*,\s*(?:please\s+)?(?:use|run|launch|start|go\s+with|prefer|pick|select)\b/i;

/** Phrases where "no" is an idiom rather than a negation of the model directive. */
const NON_NEGATING_NO_IDIOMS =
  /\bno\s+(?:idea|doubt|problem|worries|matter\s+what)\b/i;

function phraseModelRank(phrase: string): number {
  if (phrase.includes('fable')) return 4;
  if (phrase.includes('pro') || phrase.includes('opus') || phrase.includes('argon') || phrase.includes('reasoning') || phrase.includes('architecture')) {
    return 3;
  }
  return 2;
}

/** Check if the phrase tier and family cover the requested model. E.g. "gemini pro" does not authorize claude opus. */
function phraseCoversModel(phrase: string, requestedModel?: string | null): boolean {
  if (!requestedModel) return true;

  const phraseLower = phrase.toLowerCase();
  const reqLower = requestedModel.toLowerCase();

  // 1. Rank check: phrase tier rank must cover requested model tier rank
  const phraseRank = phraseModelRank(phraseLower);
  const reqRank = modelTierRank(reqLower);
  if (phraseRank < reqRank) return false;

  // 2. Family compatibility:
  // If phrase specifically names gemini or argon, it cannot approve a claude/opus request
  if ((phraseLower.includes('gemini') || phraseLower.includes('argon')) && (reqLower.includes('claude') || reqLower.includes('opus'))) {
    return false;
  }
  // If phrase specifically names claude (or fable), it cannot approve a gemini or argon request
  // A bare "fable" is the Claude family too: the word alone names no Gemini model.
  if ((phraseLower.includes('claude') || phraseLower.includes('fable')) && (reqLower.includes('gemini') || reqLower.includes('argon'))) {
    return false;
  }

  return true;
}

export function isExplicitProOverride(promptText?: string, requestedModel?: string | null): boolean {
  // A typographic apostrophe is an apostrophe: "Don’t use gemini pro" is the same negation as "Don't".
  const text = (promptText || '').replace(/[‘’ʼ]/g, "'").toLowerCase();
  for (const m of text.matchAll(PRO_OVERRIDE_PHRASES)) {
    const matchIndex = m.index!;
    const matchedPhrase = m[0];

    // Check sentence / clause boundary before the match
    const textBeforeMatch = text.slice(0, matchIndex);
    let sentenceStart = 0;
    for (const b of textBeforeMatch.matchAll(/[.!?;\n]/g)) {
      sentenceStart = b.index! + b[0].length;
    }

    const clauseBefore = textBeforeMatch.slice(sentenceStart);

    // Look for negators in the clause before the match
    const negMatch = NEGATOR_PATTERN.exec(clauseBefore);
    if (negMatch) {
      // Check if this is a false negator idiom ("no idea", "no doubt", etc.)
      const idiomMatch = NON_NEGATING_NO_IDIOMS.exec(clauseBefore);
      if (idiomMatch && idiomMatch.index <= negMatch.index && idiomMatch.index + idiomMatch[0].length >= negMatch.index + negMatch[0].length) {
        // Negator was part of idiom, continue check
      } else {
        // Check for affirmative contrast or completed negative clause before comma
        const between = clauseBefore.slice(negMatch.index + negMatch[0].length);
        if (!AFFIRMATIVE_RESET_PATTERN.test(between)) {
          // Clause is negated!
          continue;
        }
      }
    }

    // Verify the named model/phrase covers requestedModel
    if (phraseCoversModel(matchedPhrase, requestedModel)) {
      return true;
    }
  }
  return false;
}

export function clampTierToSessionCeiling(
  recommendedTier: string,
  activeModel?: string,
  promptText: string = ''
): { clampedTier: string; wasClamped: boolean; ceilingTier: string } {
  if (!activeModel) {
    return { clampedTier: recommendedTier, wasClamped: false, ceilingTier: 'pro' };
  }

  // Whole phrases with negation handling, shared with the Antigravity hook (a bare "argon" is not an override).
  const explicitProOverride = isExplicitProOverride(promptText, recommendedTier);

  const ceilingRank = subagentCeilingRank(activeModel);
  const ceilingTier = rankToTierName(ceilingRank);
  const recRank = modelTierRank(recommendedTier);

  if (recRank > ceilingRank && !explicitProOverride) {
    return {
      clampedTier: ceilingTier,
      wasClamped: true,
      ceilingTier
    };
  }

  return {
    clampedTier: recommendedTier,
    wasClamped: false,
    ceilingTier
  };
}

export interface QuotaClampResult {
  tier: string;
  /** The Jev mode "on" lowered the tier because the active pool is low. */
  wasClampedByQuota: boolean;
  /** Set only when the tier is still `pro` in a low pool (mode "on-demand"): names the pool and what is left. */
  quotaWarning?: string;
  strategy: QuotaStrategy;
  pool: 'gemini' | '3p' | string;
}

/**
 * The low-quota step of the dispatch tools, applied AFTER the session-model ceiling (a stage exempt from the
 * ceiling is still subject to it). The one threshold source is the pool strategy from evaluatePoolStrategy
 * (config-overridable thresholds, already resolved on `quotaView.active.strategy`); no percentage is read here.
 *
 * - mode "on": `conserve` clamps to flash_lite, `free_only` to openrouter_free (flash_lite when the item edits
 *   files, since the free tier cannot edit). Approvals and override phrases in the task text cannot lift it.
 * - mode "on-demand": the tier survives; a `pro` tier carries a `quotaWarning` naming the pool and its remaining %.
 * - mode "off", or a `normal` / `unknown` pool: unchanged.
 */
export function applyLowQuotaClamp(
  tier: string,
  quotaView: { active: QuotaPoolView } | Pick<QuotaView, 'active'>,
  mode: JevMode,
  editsFiles: boolean
): QuotaClampResult {
  const { pool, strategy, min_remaining } = quotaView.active;
  const poolName = pool || 'gemini';
  const unchanged: QuotaClampResult = { tier, wasClampedByQuota: false, strategy, pool: poolName };
  if (mode === 'off' || (strategy !== 'conserve' && strategy !== 'free_only')) return unchanged;

  const rank = modelTierRank(tier);
  if (mode === 'on') {
    const floorTier = strategy === 'free_only' ? (editsFiles ? 'flash_lite' : 'openrouter_free') : 'flash_lite';
    if (rank > modelTierRank(floorTier)) {
      return { ...unchanged, tier: floorTier, wasClampedByQuota: true };
    }
    return unchanged;
  }

  if (rank >= 3) {
    const left = typeof min_remaining === 'number' ? ` (${Math.round(min_remaining * 100)}% remaining)` : '';
    return {
      ...unchanged,
      quotaWarning: `The ${pool} quota pool is in ${strategy}${left}: pro tier needs explicit user approval.`
    };
  }
  return unchanged;
}

// ── Thinking Effort Governance ───────────────────────────────────────────────
export type ThinkingEffort = 'low' | 'medium' | 'high';

export function defaultEffortForSubagent(subagent: string, promptText: string = ''): ThinkingEffort {
  const sa = (subagent || '').toLowerCase();
  const text = (promptText || '').toLowerCase();
  const hasWord = (pattern: RegExp): boolean => pattern.test(text);

  // High effort keywords / roles
  if (
    sa.includes('architect') ||
    sa.includes('security') ||
    sa.includes('auditor') ||
    hasWord(/\barchitecture\b/) ||
    hasWord(/\bsecurity audit\b/) ||
    hasWord(/\brfc design\b/)
  ) {
    return 'high';
  }

  // Low effort mechanical roles / keywords
  if (
    sa.includes('inbox') ||
    sa.includes('processor') ||
    // A role named for formatting ("formatter", "doc-formatter"), not any name that merely contains the letters ("information-architect").
    /(?:^|[^a-z])(?:re|auto-)?format(?:ter|ters|ting)?(?:$|[^a-z])/.test(sa) ||
    sa.includes('scribe') ||
    isFormattingTask(promptText) ||
    hasWord(/\bfile into\b/) ||
    hasWord(/\bcommit message\b/)
  ) {
    return 'low';
  }

  // Bounded deterministic ports
  if (
    hasWord(/\bport(ing)?\b/) &&
    (hasWord(/\brust\b/) || hasWord(/\bpython\b/) || hasWord(/\bcli\b/))
  ) {
    return 'medium';
  }

  return 'medium';
}

export function applyEffortGovernance(effort: ThinkingEffort, quotaStrategy: string, targetTier: string = ''): ThinkingEffort {
  const isFree = targetTier.toLowerCase().includes('free');
  if (quotaStrategy === 'free_only') {
    if (isFree) {
      return effort;
    }
    return 'low';
  }
  if (quotaStrategy === 'conserve' && effort === 'high') {
    return 'medium';
  }
  return effort;
}

// ── Tier Cost Estimation ────────────────────────────────────────────────────
export function estimateTierCost(tier: string): number {
  const t = (tier || '').toLowerCase();
  if (t === 'pro' || t === 'tier_3_deep' || t === 'expensive') {
    return 0.015;
  }
  if (t === 'flash' || t === 'tier_2_standard' || t === 'standard') {
    return 0.001;
  }
  if (t === 'flash_lite' || t === 'tier_1_cheap' || t === 'cheap') {
    return 0.0001;
  }
  return 0.0;
}

// ── Cost-Tiered Model Selection ─────────────────────────────────────────────
export type ModelTier = 'free' | 'cheap' | 'standard' | 'expensive' | string;

export interface ModelCandidate {
  id: string;
  tier: ModelTier;
  providerModel: string;
  costInPerMTok: number;
  costOutPerMTok: number;
  label?: string;
}

export interface ScoredOption extends ModelCandidate {
  prob: number;
  suitable: boolean;
  costScore: number;
}

export type ModelRecommendation = 'cheapest_suitable' | 'ask_user' | 'unknown';

export interface ModelSelection {
  options: ScoredOption[];
  cheapestOptionId: string;
  cheapestSuitableOptionId: string | null;
  recommendedOptionId: string | null;
  expensiveOptionIds: string[];
  upgradeOptionId: string | null;
  recommendation: ModelRecommendation;
  cheapestSufficient: boolean;
  cheapestSufficientProb: number;
  quotaStrategy: string;
  recommendedEffort?: ThinkingEffort;
  confidence: number;
  modelUsed: string;
  fallbackUsed: boolean;
  error?: string;
}

export const JEV_SELECT_NOUL_MIN = Number(process.env.JEV_SELECT_NOUL_MIN || 0.5);
const EXPENSIVE_ABOVE_USD_PER_MTOK = Number(process.env.JEV_SELECT_EXPENSIVE_ABOVE || 20);
const ASK_ABOVE_EXPENSIVE_PROB = Number(process.env.JEV_SELECT_ASK_EXPENSIVE_PROB || 0.35);

export const DEFAULT_MODEL_CANDIDATES: ModelCandidate[] = [
  { id: 'free', tier: 'free', providerModel: 'openrouter/free', costInPerMTok: 0, costOutPerMTok: 0, label: 'Free tier' },
  { id: 'cheap', tier: 'cheap', providerModel: '(configured cheap tier)', costInPerMTok: 0.15, costOutPerMTok: 0.6, label: 'Cheap tier' },
  { id: 'standard', tier: 'standard', providerModel: '(configured standard tier)', costInPerMTok: 1, costOutPerMTok: 4, label: 'Standard tier' },
  { id: 'expensive', tier: 'expensive', providerModel: '(configured expensive tier)', costInPerMTok: 3, costOutPerMTok: 15, label: 'Expensive tier' }
];

function costScore(c: ModelCandidate): number {
  return (Number(c.costInPerMTok) || 0) + 3 * (Number(c.costOutPerMTok) || 0);
}

function isExpensive(c: ModelCandidate): boolean {
  return c.tier === 'expensive' || costScore(c) > EXPENSIVE_ABOVE_USD_PER_MTOK;
}

export async function selectModel(
  task: string,
  candidates: ModelCandidate[],
  quotaStrategy = 'unknown'
): Promise<ModelSelection> {
  const cacheKey = computeDecisionCacheKey(task, candidates, quotaStrategy);
  const cached = getCachedDecision(cacheKey);
  if (cached) {
    const span = getTracer().startSpan('jev.select_model', {
      'task.length': task.length,
      'candidates.count': candidates.length,
      'quota.strategy': quotaStrategy,
      'decision.cached': true
    });
    span.setAttribute('decision.latency_ms', 0);
    if (cached.recommendedOptionId) span.setAttribute('decision.verdict', cached.recommendedOptionId);
    span.end();
    return cached;
  }

  const startTime = Date.now();
  const span = getTracer().startSpan('jev.select_model', {
    'task.length': task.length,
    'candidates.count': candidates.length,
    'quota.strategy': quotaStrategy,
    'decision.cached': false
  });

  const ranked = [...candidates].sort((a, b) => costScore(a) - costScore(b));
  const cheapest = ranked[0];

  const base = (extra: Partial<ModelSelection>): ModelSelection => ({
    options: ranked.map((c) => ({ ...c, prob: 0, suitable: false, costScore: costScore(c) })),
    cheapestOptionId: cheapest.id,
    cheapestSuitableOptionId: null,
    recommendedOptionId: null,
    expensiveOptionIds: ranked.filter(isExpensive).map((c) => c.id),
    upgradeOptionId: null,
    recommendation: 'unknown',
    cheapestSufficient: false,
    cheapestSufficientProb: 0,
    quotaStrategy,
    confidence: 0,
    modelUsed: JEV_MODEL,
    fallbackUsed: false,
    ...extra
  });

  try {
    const criteria: Record<string, string> = {};
    for (const c of ranked) {
      criteria[c.id] = `${c.label || c.providerModel} — tier ${c.tier}, ~$${c.costInPerMTok}/$${c.costOutPerMTok} per Mtok`;
    }

    const data: any = await callJev(
      `Task: ${task}\n\nQuota strategy for this machine: ${quotaStrategy}. ` +
        `Choose the cheapest model tier that can complete this task to a high standard.`,
      {
        selectedOption: {
          type: 'choice',
          instructions: 'Select the best option balancing task suitability against cost (prefer cheaper).',
          criteria
        },
        cheapestSufficient: {
          type: 'noul',
          instructions:
            `Is the cheapest option ("${cheapest.id}", tier ${cheapest.tier}, ~$${cheapest.costInPerMTok}/$${cheapest.costOutPerMTok} per Mtok) ` +
            `sufficient to complete this task to a high standard?`
        }
      }
    );

    const choiceAnswer = data?.answers?.selectedOption;
    const noulAnswer = data?.answers?.cheapestSufficient;
    const probs: Record<string, number> = choiceAnswer?.probabilities || {};
    const noul = typeof noulAnswer?.noul === 'number' ? noulAnswer.noul : 0.5;
    const cheapestSufficient = noul >= JEV_SELECT_NOUL_MIN;

    let required = cheapest;
    if (!cheapestSufficient) {
      const chosenId = typeof choiceAnswer?.choice === 'string' ? choiceAnswer.choice : cheapest.id;
      required = ranked.find((c) => c.id === chosenId) || cheapest;
      if (costScore(required) < costScore(cheapest)) required = cheapest;
    }

    const options: ScoredOption[] = ranked.map((c) => ({
      ...c,
      prob: probs[c.id] ?? 0,
      suitable: costScore(c) >= costScore(required),
      costScore: costScore(c)
    }));

    const upgrade = options.filter((o) => isExpensive(o)).sort((a, b) => b.prob - a.prob)[0];
    const maxExpensiveProb = upgrade?.prob ?? 0;

    let recommendation: ModelRecommendation = cheapestSufficient ? 'cheapest_suitable'
      : isExpensive(required) ? 'ask_user'
      : 'cheapest_suitable';
    if (!cheapestSufficient && recommendation !== 'ask_user' && maxExpensiveProb >= ASK_ABOVE_EXPENSIVE_PROB) {
      recommendation = 'ask_user';
    }

    const confidence = choiceAnswer?.confidence ?? 0.9;

    const result = base({
      options,
      cheapestSuitableOptionId: required.id,
      recommendedOptionId: required.id,
      upgradeOptionId: upgrade?.id ?? null,
      recommendation,
      cheapestSufficient,
      cheapestSufficientProb: noul,
      confidence: Number.isFinite(confidence) ? confidence : 0.9,
      modelUsed: data?.model || JEV_MODEL,
      fallbackUsed: false
    });

    const latencyMs = Date.now() - startTime;
    span.setAttribute('decision.latency_ms', latencyMs);
    if (result.recommendedOptionId) span.setAttribute('decision.verdict', result.recommendedOptionId);
    if (result.recommendation) span.setAttribute('decision.recommendation', result.recommendation);
    span.setAttribute('decision.cheapest_sufficient', result.cheapestSufficient);
    span.end();

    setCachedDecision(cacheKey, result);
    return result;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    span.setError(err);
    span.setAttribute('decision.latency_ms', latencyMs);
    span.setAttribute('decision.verdict', cheapest?.id || 'cheapest');
    span.end();

    const options: ScoredOption[] = ranked.map((c) => ({
      ...c,
      prob: 0,
      suitable: c.id === cheapest.id,
      costScore: costScore(c)
    }));
    return base({
      options,
      cheapestSuitableOptionId: cheapest.id,
      recommendedOptionId: cheapest.id,
      recommendation: 'cheapest_suitable',
      confidence: 0,
      fallbackUsed: true,
      error: String(err?.message || err)
    });
  }
}
