#!/usr/bin/env bun
/**
 * Shared Jev primitives used by both the MCP server (src/index.ts) and the
 * OpenCode V2 plugin (opencode/plugin.ts). Keep this module free of side
 * effects: it must never start a server or block on import.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Endpoints / models ───────────────────────────────────────────────────────
export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const JEV_MODEL = process.env.JEV_MODEL || '~typesafe/jev-latest';
/**
 * Tier-2 routing engine: the OpenRouter-native `typesafe/jev-router` Chat
 * Completions model. OpenRouter-only — it never touches the Google/Antigravity
 * subscription, so Jev keeps working when the Google route is unavailable.
 * Replaces the old `google/gemini-2.5-flash` fallback.
 */
export const JEV_ROUTER_MODEL = process.env.JEV_ROUTER_MODEL || 'typesafe/jev-router';
export const FALLBACK_MODEL = process.env.JEV_FALLBACK_MODEL || JEV_ROUTER_MODEL;
export const FREE_MODEL = process.env.JEV_FREE_MODEL || 'openrouter/free';

export const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 3500);
export const FALLBACK_TIMEOUT_MS = Number(process.env.JEV_FALLBACK_TIMEOUT_MS || 5000);

export const JEV_INPUT_COST_PER_MILLION = 0.042; // $0.042 per 1M input tokens
export const FALLBACK_INPUT_COST_PER_MILLION = 0.15; // $0.15 per 1M tokens

/**
 * Load simple KEY=VALUE pairs from a .env file into process.env (without
 * overwriting existing non-empty values). Shared so the OpenCode plugin can pick up the
 * key the same way the MCP server does.
 */
function isPlaceholder(val?: string): boolean {
  return !val || val === '' || val.startsWith('${') || val.startsWith('$');
}

export function loadEnvFile(filePath: string): void {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const raw = fsSync.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && (!process.env[k] || isPlaceholder(process.env[k]))) {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore
  }
}

function ensureSecretsLoaded(): void {
  if (isPlaceholder(process.env.JEV_OPENROUTER_API_KEY) && isPlaceholder(process.env.OPENROUTER_API_KEY)) {
    loadEnvFile(path.join(os.homedir(), '.config', 'zsh', 'secrets.env'));
    loadEnvFile(path.join(os.homedir(), '.config', 'jev', 'env'));
    loadEnvFile(path.join(os.homedir(), '.gemini', 'config', 'plugins', 'jev', '.env'));
  }
}

ensureSecretsLoaded();

function openRouterKey(): string {
  // Jev runs on its own dedicated OpenRouter key so this session's general
  // OPENROUTER_API_KEY (used for chat/models) is never billed for Jev traffic.
  ensureSecretsLoaded();
  let key = process.env.JEV_OPENROUTER_API_KEY;
  if (isPlaceholder(key)) {
    key = process.env.OPENROUTER_API_KEY;
  }
  if (!key || isPlaceholder(key)) {
    throw new Error('JEV_OPENROUTER_API_KEY (or OPENROUTER_API_KEY) is not set');
  }
  return key;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Filesystem Decision Cache & Local Heuristics ──────────────────────────────
export const JEV_CACHE_FILE = path.join(os.homedir(), '.config', 'jev', 'decision-cache.json');
const DECISION_CACHE_TTL_MS = 30_000;

export interface DecisionCacheEntry {
  at: number;
  data: any;
}

export function getCachedDecision(hash: string): any | null {
  try {
    if (fsSync.existsSync(JEV_CACHE_FILE)) {
      const cache: Record<string, DecisionCacheEntry> = JSON.parse(fsSync.readFileSync(JEV_CACHE_FILE, 'utf8'));
      const hit = cache[hash];
      if (hit && Date.now() - hit.at < DECISION_CACHE_TTL_MS) {
        return hit.data;
      }
    }
  } catch {
    // Cache miss or read error
  }
  return null;
}

export function setCachedDecision(hash: string, data: any): void {
  try {
    const dir = path.dirname(JEV_CACHE_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    let cache: Record<string, DecisionCacheEntry> = {};
    if (fsSync.existsSync(JEV_CACHE_FILE)) {
      try {
        cache = JSON.parse(fsSync.readFileSync(JEV_CACHE_FILE, 'utf8'));
      } catch {
        cache = {};
      }
    }
    // Prune stale entries
    const now = Date.now();
    for (const [k, v] of Object.entries(cache)) {
      if (now - v.at > DECISION_CACHE_TTL_MS * 2) {
        delete cache[k];
      }
    }
    cache[hash] = { at: now, data };
    fsSync.writeFileSync(JEV_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Cache write is best-effort
  }
}

/**
 * Zero-Network Local Complexity Heuristic Pre-Filter
 * Evaluated before remote decision calls to instantly resolve trivial mechanical tasks (<40 tokens)
 * or establish code density floors.
 */
export function evaluateLocalHeuristic(text: string): { route?: string; tier?: string; effort?: string } | null {
  const trimmed = text.trim();
  const tokenEst = Math.ceil(trimmed.length / 4);

  // Very short mechanical tasks (<40 tokens) matching routine transformation patterns
  if (tokenEst < 40) {
    const isFormatting = /\b(format|indent|organize imports|sort|prettier|clean whitespace|tabs to spaces)\b/i.test(trimmed);
    const isBoilerplate = /\b(scaffold boilerplate|empty template|stub function|skeleton)\b/i.test(trimmed);
    if (isFormatting || isBoilerplate) {
      return {
        route: 'openrouter_free',
        tier: 'openrouter_free',
        effort: 'low'
      };
    }
  }
  return null;
}

/**
 * Shared Recall / durable session memory reader across harnesses.
 */
export async function fetchRecallMemory(workspace = path.basename(process.cwd()) || 'default'): Promise<any> {
  const tryReadRecall = async (identifier: string) => {
    try {
      const res = await fetchWithTimeout('http://127.0.0.1:8110/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_note',
            arguments: {
              identifier,
              output_format: 'json',
              include_frontmatter: true
            }
          }
        })
      }, 800);
      if (res.ok) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            const parsed = JSON.parse(line.slice(6));
            const fm = parsed?.result?.structuredContent?.result?.frontmatter;
            if (fm && fm.activeGoal) {
              return fm;
            }
          }
        }
      }
    } catch {
      // fallback
    }
    return null;
  };

  const remote = (await tryReadRecall(`session-memory:${workspace}`)) || (await tryReadRecall(`session-handoff:${workspace}`));
  if (remote) return remote;

  for (const file of ['memory.json', 'handoff.json']) {
    try {
      const filePath = path.join(os.homedir(), 'projects', workspace, '.agents', file);
      if (fsSync.existsSync(filePath)) {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // try next
    }
  }

  return null;
}

/**
 * Tier 1: TypeSafe Jev Decisions API on OpenRouter (~800ms, calibrated).
 */
export async function callJevDecision(state: string, questions: Record<string, unknown>): Promise<any> {
  const hash = `${state.length}:${state.slice(0, 64)}:${state.slice(-64)}:${JSON.stringify(Object.keys(questions).sort())}`;
  const cached = getCachedDecision(hash);
  if (cached) return cached;

  const res = await fetchWithTimeout(JEV_DECISIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/agentic-hub/jev',
      'X-Title': 'Jev Decisions Gateway'
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions })
  }, JEV_TIMEOUT_MS);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jev Decisions API Error ${res.status}: ${errText}`);
  }
  const result = await res.json();
  setCachedDecision(hash, result);
  return result;
}

/** Strip ```json ... ``` fences so lenient JSON parsing works. */
function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

/**
 * Tier 2: `typesafe/jev-router` via OpenRouter Chat Completions with strict structured JSON schema.
 */
export async function callJevRouter(state: string, questions: Record<string, unknown>): Promise<any> {
  const prompt =
    'You are a fast routing and decision engine. Read the state and answer every question.\n' +
    'Return ONLY a JSON object of the form {"answers":{"<key>":<answer>}} where each answer is\n' +
    '  {"type":"choice","choice":"<one criterion key>","confidence":<0..1>} for a choice question,\n' +
    '  {"type":"noul","noul":<0..1>} for a probability/yes-no question,\n' +
    '  {"type":"score","score":<number>} for a score question.\n' +
    'Use exactly the question keys and criterion keys given.\n\n' +
    `Questions: ${JSON.stringify(questions)}\n\nState:\n${state}`;

  const res = await fetchWithTimeout(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/agentic-hub/jev',
      'X-Title': 'Jev Router (OpenRouter)'
    },
    body: JSON.stringify({
      model: JEV_ROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'jev_router_answers',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              answers: { type: 'object', additionalProperties: true }
            },
            required: ['answers']
          }
        }
      }
    })
  }, FALLBACK_TIMEOUT_MS);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jev Router Error ${res.status}: ${errText}`);
  }

  const json: any = await res.json();
  const raw = String(json?.choices?.[0]?.message?.content ?? '');
  let parsed: any = {};
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    parsed = {};
  }
  return {
    model: json?.model || JEV_ROUTER_MODEL,
    provider: json?.provider,
    answers: parsed?.answers || {},
    usage: json?.usage
  };
}

/**
 * Unified Jev decision call: the fast (~13–800 ms) calibrated Decisions API
 * first, then the OpenRouter-native `typesafe/jev-router` fallback.
 */
export async function callJev(state: string, questions: Record<string, unknown>): Promise<any> {
  try {
    return await callJevDecision(state, questions);
  } catch {
    return await callJevRouter(state, questions);
  }
}

/** Chat messages for a plain generation request: the prompt itself, no classifier wrapper. */
export function buildRouterCompletionMessages(
  prompt: string,
  systemInstruction?: string
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    ...(systemInstruction ? [{ role: 'system' as const, content: systemInstruction }] : []),
    { role: 'user' as const, content: prompt }
  ];
}

/**
 * Plain generation on the fallback model, used to escalate a free-tier output
 * that failed its quality gate. Returns the generated text ('' if none).
 */
export async function callRouterCompletion(prompt: string, systemInstruction?: string): Promise<string> {
  const res = await fetchWithTimeout(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/agentic-hub/jev',
      'X-Title': 'Jev Escalation (OpenRouter)'
    },
    body: JSON.stringify({
      model: FALLBACK_MODEL,
      messages: buildRouterCompletionMessages(prompt, systemInstruction)
    })
  }, FALLBACK_TIMEOUT_MS);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jev Escalation Error ${res.status}: ${errText}`);
  }
  const json: any = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

// ── Free-tier guard ──────────────────────────────────────────────────────────
/** True for OpenRouter's free router and for models published with the `:free` suffix. */
export function isFreeModel(model: string): boolean {
  return model === FREE_MODEL || model === 'openrouter/free' || model.endsWith(':free');
}

/**
 * The free-execution tools report $0 cost unconditionally, so a paid model must
 * never reach them. Returns the model unchanged, or throws.
 */
export function assertFreeModel(model: string): string {
  if (!isFreeModel(model)) {
    throw new Error(
      `"${model}" is not a free model. Free execution accepts openrouter/free or a model id ending in ":free".`
    );
  }
  return model;
}

// ── Cost-tiered model selection ──────────────────────────────────────────────
export type ModelTier = 'free' | 'cheap' | 'standard' | 'expensive' | string;

export interface ModelCandidate {
  /** Stable id used by Jev's choice answer and by callers. */
  id: string;
  tier: ModelTier;
  /** Concrete provider/model ref, e.g. "openrouter/openai/gpt-…". */
  providerModel: string;
  /** USD per 1M input tokens. */
  costInPerMTok: number;
  /** USD per 1M output tokens. */
  costOutPerMTok: number;
  /** Human label shown to Jev and (optionally) the user. */
  label?: string;
}

export interface ScoredOption extends ModelCandidate {
  /** Calibrated probability from Jev's choice answer. */
  prob: number;
  /** True if this option is at least as capable as the cheapest sufficient one. */
  suitable: boolean;
  /** Output-weighted cost used for ranking (in + 3*out). */
  costScore: number;
}

export type ModelRecommendation = 'cheapest_suitable' | 'ask_user' | 'unknown';

export type ThinkingEffort = 'low' | 'medium' | 'high';

export function defaultEffortForSubagent(subagent: string, promptText: string = ''): ThinkingEffort {
  const sa = (subagent || '').toLowerCase();
  const text = (promptText || '').toLowerCase();
  // Whole-word match: a bare substring test lets "information" match "format".
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
    sa === 'inbox_processor' ||
    sa === 'syntax_formatter' ||
    sa === 'git_scribe' ||
    hasWord(/\b(re)?format(s|ted|ting|ter|ters)?\b/) ||
    hasWord(/\bfile into\b/) ||
    hasWord(/\bcommit message\b/)
  ) {
    return 'low';
  }

  // Default balanced reasoning effort (vault_librarian defaults to medium per RFC D2)
  return 'medium';
}

export function applyEffortGovernance(effort: ThinkingEffort, quotaStrategy: string, targetTier: string = ''): ThinkingEffort {
  const isFreeModel = targetTier.toLowerCase().includes('free');
  if (quotaStrategy === 'free_only') {
    if (isFreeModel) {
      return effort;
    }
    return 'low';
  }
  if (quotaStrategy === 'conserve' && effort === 'high') {
    return 'medium';
  }
  return effort;
}

export interface ModelSelection {
  options: ScoredOption[];
  cheapestOptionId: string;
  cheapestSuitableOptionId: string | null;
  recommendedOptionId: string | null;
  expensiveOptionIds: string[];
  /** The expensive option to use if the user approves an upgrade. */
  upgradeOptionId: string | null;
  recommendation: ModelRecommendation;
  /** Whether the cheapest candidate is judged sufficient for the task. */
  cheapestSufficient: boolean;
  /** Raw noul value ∈ [0,1] for the sufficiency judgment. */
  cheapestSufficientProb: number;
  quotaStrategy: string;
  recommendedEffort?: ThinkingEffort;
  confidence: number;
  modelUsed: string;
  fallbackUsed: boolean;
  error?: string;
}

export const JEV_SELECT_NOUL_MIN = Number(process.env.JEV_SELECT_NOUL_MIN || 0.5);
// Safety net only: an option is "expensive" primarily via its explicit tier.
// Default threshold is set above a typical "standard" band so that only
// pro-class options (or unlabeled options that cost like them) require approval.
const EXPENSIVE_ABOVE_USD_PER_MTOK = Number(process.env.JEV_SELECT_EXPENSIVE_ABOVE || 20);
// Offer the user a choice (ask_user) when the cheapest option is insufficient
// and an expensive option has at least this much probability mass.
const ASK_ABOVE_EXPENSIVE_PROB = Number(process.env.JEV_SELECT_ASK_EXPENSIVE_PROB || 0.35);

function costScore(c: ModelCandidate): number {
  return (Number(c.costInPerMTok) || 0) + 3 * (Number(c.costOutPerMTok) || 0);
}

function isExpensive(c: ModelCandidate): boolean {
  return c.tier === 'expensive' || costScore(c) > EXPENSIVE_ABOVE_USD_PER_MTOK;
}

/**
 * Ask Jev, in a single decision call, which cost tier should run this task and
 * whether the cheapest tier is sufficient. Returns a ranked option set; the
 * caller decides between the cheapest-suitable option and asking the user.
 *
 * Never throws: on any Jev failure it returns the cheapest option with
 * fallbackUsed=true, honouring the cost-first principle.
 */
export async function selectModel(
  task: string,
  candidates: ModelCandidate[],
  quotaStrategy = 'unknown'
): Promise<ModelSelection> {
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

    // Required option: cheapest if sufficient, else Jev's most probable option at or above the cheapest.
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

    // The expensive option to upgrade to, if the user approves.
    const upgrade = options.filter((o) => isExpensive(o)).sort((a, b) => b.prob - a.prob)[0];
    const maxExpensiveProb = upgrade?.prob ?? 0;

    let recommendation: ModelRecommendation = cheapestSufficient ? 'cheapest_suitable'
      : isExpensive(required) ? 'ask_user'
      : 'cheapest_suitable';
    // Borderline: cheapest is insufficient and an expensive option is plausible,
    // so surface the choice instead of silently picking the cheaper tier.
    if (!cheapestSufficient && recommendation !== 'ask_user' && maxExpensiveProb >= ASK_ABOVE_EXPENSIVE_PROB) {
      recommendation = 'ask_user';
    }

    const confidence = choiceAnswer?.confidence ?? 0.9;

    return base({
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
  } catch (err: any) {
    // Cost-first fallback: cheapest wins.
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

// ── Jev configuration & operating mode ───────────────────────────────────────
export type JevMode = 'off' | 'on-demand' | 'on';
export const JEV_STATE_FILE = path.join(os.homedir(), '.config', 'jev', 'mode.json');
export const JEV_CONFIG_FILE = path.join(os.homedir(), '.config', 'jev', 'config.json');

export type JevHarness = 'antigravity' | 'opencode' | 'claude-code' | 'cli';

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
    opencode: { mode: 'off' },
    antigravity: { mode: 'on' },
    'claude-code': { mode: 'on' }
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
  // If no harness is specified, check mode.json legacy fallback, then default to antigravity/defaults
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

// ── Antigravity quota view (schema v2, written by .agents/statusline-command.sh) ─
export const QUOTA_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'quota-state.json');
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
  /** 1.0 once the reset time has passed (window refreshed), else remaining_fraction. */
  effective_remaining_fraction: number;
  refreshed: boolean;
}

export type QuotaStrategy = 'normal' | 'conserve' | 'free_only' | 'unknown';

export interface QuotaView {
  source: string;
  schema: number;
  stale: boolean;
  updated_at: number | null;
  plan_tier?: string;
  active_model?: string;
  buckets: Record<string, QuotaBucket>;
  gemini: { five_hour: number | null; weekly: number | null; min_remaining: number | null };
  strategy: QuotaStrategy;
  thresholds: QuotaThresholds;
  geminiRemainingFraction: number | null;
}

export function evaluatePoolStrategy(
  fiveHour: number | null,
  weekly: number | null,
  t: QuotaThresholds
): QuotaStrategy {
  if (fiveHour === null && weekly === null) return 'unknown';

  // 1. Critical check (free_only):
  const is5hCritical = fiveHour !== null && fiveHour <= t.five_hour_conserve_min;
  const isWeeklyCritical = weekly !== null && weekly <= t.weekly_conserve_min;
  if (is5hCritical || isWeeklyCritical) {
    return 'free_only';
  }

  // 2. Conserve check (start trying to offload work to free models):
  // 5h <= 25% or weekly <= 10%
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

/**
 * Read the multi-bucket quota state. Prefers schema v2, falls back to the
 * legacy single-bucket cache, and marks staleness when the statusline has not
 * refreshed it recently (e.g. while Antigravity is closed).
 */
export async function readQuotaView(): Promise<QuotaView> {
  const nowSec = Math.floor(Date.now() / 1000);
  let source = 'none';
  let schema = 0;
  let updatedAt: number | null = null;
  let planTier: string | undefined;
  let activeModel: string | undefined;
  let rawBuckets: Record<string, any> = {};

  const tryParse = (file: string): any | null => {
    try {
      if (fsSync.existsSync(file)) return JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch {
      // ignore
    }
    return null;
  };

  const v2 = tryParse(QUOTA_STATE_FILE);
  if (v2 && typeof v2 === 'object') {
    if (v2.buckets && typeof v2.buckets === 'object') {
      source = QUOTA_STATE_FILE; schema = Number(v2.schema || 2); updatedAt = v2.updated_at ?? null;
      planTier = v2.plan_tier; activeModel = v2.active_model; rawBuckets = v2.buckets;
    } else if (typeof v2.remaining_fraction === 'number') {
      source = QUOTA_STATE_FILE; schema = 1; updatedAt = v2.updated_at ?? null;
      rawBuckets = { 'gemini-5h': v2 };
    }
  }

  if (schema === 0) {
    const legacy = tryParse(QUOTA_LEGACY_FILE);
    if (legacy && typeof legacy.remaining_fraction === 'number') {
      source = QUOTA_LEGACY_FILE; schema = 1; updatedAt = legacy.updated_at ?? null;
      rawBuckets = { 'gemini-5h': legacy };
    }
  }

  const buckets: Record<string, QuotaBucket> = {};
  for (const [k, v] of Object.entries(rawBuckets)) {
    const b = normaliseBucket(nowSec, v);
    if (b) buckets[k] = b;
  }

  const geminiFive = buckets['gemini-5h']?.effective_remaining_fraction ?? null;
  const geminiWeekly = buckets['gemini-weekly']?.effective_remaining_fraction ?? null;
  const p3Five = buckets['3p-5h']?.effective_remaining_fraction ?? null;
  const p3Weekly = buckets['3p-weekly']?.effective_remaining_fraction ?? null;

  const geminiCandidates = [geminiFive, geminiWeekly].filter((x): x is number => typeof x === 'number');
  const p3Candidates = [p3Five, p3Weekly].filter((x): x is number => typeof x === 'number');
  const geminiMin = geminiCandidates.length ? Math.min(...geminiCandidates) : null;
  const p3Min = p3Candidates.length ? Math.min(...p3Candidates) : null;

  // Max available remaining quota across both Gemini and 3P pools (utilize best available route)
  const availablePools = [geminiMin, p3Min].filter((x): x is number => typeof x === 'number');
  const minRemaining = availablePools.length ? Math.max(...availablePools) : null;

  const thresholds = getQuotaThresholds();
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

  const stale = updatedAt === null || nowSec - updatedAt > QUOTA_STALE_SECONDS;

  return {
    source,
    schema,
    stale,
    updated_at: updatedAt,
    plan_tier: planTier,
    active_model: activeModel,
    buckets,
    gemini: { five_hour: geminiFive, weekly: geminiWeekly, min_remaining: geminiMin ?? minRemaining },
    strategy,
    thresholds,
    geminiRemainingFraction: geminiMin ?? minRemaining
  };
}

// ── Unified Telemetry Logging ────────────────────────────────────────────────
export const JEV_TELEMETRY_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');

export interface JevTelemetryEvent {
  timestamp?: string;
  harness: 'antigravity' | 'opencode' | 'claude' | 'cli';
  toolOrHook: string;
  sessionId?: string | null;
  taskSummary?: string;
  tierRecommended?: string;
  modelUsed?: string;
  latencyMs?: number;
  costUsd?: number;
  tokensSaved?: number;
  quotaStrategy?: string;
  [key: string]: unknown;
}

export async function logJevTelemetry(entry: JevTelemetryEvent): Promise<void> {
  try {
    const dir = path.dirname(JEV_TELEMETRY_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    const payload = {
      timestamp: entry.timestamp || new Date().toISOString(),
      ...entry
    };
    await fs.appendFile(JEV_TELEMETRY_FILE, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // telemetry is best-effort
  }
}

