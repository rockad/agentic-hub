import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getTracer, type JevSpan, type JevTracer } from '../tracing.js';
import {
  getFreeModelsPool,
  getJevTimeouts,
  loadJevConfigSync
} from './config.js';

// ── Endpoints / models ───────────────────────────────────────────────────────
export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function getJevModels() {
  const cfg = loadJevConfigSync();
  return {
    decision: process.env.JEV_MODEL || cfg.models?.decision || '~typesafe/jev-latest',
    router: process.env.JEV_ROUTER_MODEL || cfg.models?.router || 'typesafe/jev-router',
    fallback: process.env.JEV_FALLBACK_MODEL || cfg.models?.fallback || 'typesafe/jev-router',
    free: process.env.JEV_FREE_MODEL || 'openrouter/free'
  };
}

export const JEV_MODEL = process.env.JEV_MODEL || '~typesafe/jev-latest';
export const JEV_ROUTER_MODEL = process.env.JEV_ROUTER_MODEL || 'typesafe/jev-router';
export const FALLBACK_MODEL = process.env.JEV_FALLBACK_MODEL || JEV_ROUTER_MODEL;
export const FREE_MODEL = process.env.JEV_FREE_MODEL || 'openrouter/free';

export const FREE_MODELS_POOL = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-lightning:free'
];

export const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 3500);
export const FALLBACK_TIMEOUT_MS = Number(process.env.JEV_FALLBACK_TIMEOUT_MS || 5000);
export const FREE_EXEC_TIMEOUT_MS = 25000;
export const FREE_MODEL_TIMEOUT_MS = 8000;

export const JEV_INPUT_COST_PER_MILLION = 0.042; // $0.042 per 1M input tokens
export const FALLBACK_INPUT_COST_PER_MILLION = 0.15; // $0.15 per 1M tokens

// ── Environment & Secrets ────────────────────────────────────────────────────
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

export function ensureSecretsLoaded(): void {
  if (isPlaceholder(process.env.JEV_OPENROUTER_API_KEY) && isPlaceholder(process.env.OPENROUTER_API_KEY)) {
    loadEnvFile(path.join(os.homedir(), '.config', 'zsh', 'secrets.env'));
    loadEnvFile(path.join(os.homedir(), '.config', 'jev', 'env'));
    loadEnvFile(path.join(os.homedir(), '.gemini', 'config', 'plugins', 'jev', '.env'));
  }
}

ensureSecretsLoaded();

export function openRouterKey(): string {
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

export function getOpenRouterApiKey(): string {
  try {
    return openRouterKey();
  } catch {
    return process.env.JEV_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
  }
}

export async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Decision Cache ───────────────────────────────────────────────────────────
import {
  computeDecisionCacheKey,
  getCachedDecision,
  setCachedDecision,
} from './cache.js';

export function formatVerdict(result: any): string {
  if (!result || typeof result !== 'object') return '';
  const answers = result.answers;
  if (!answers || typeof answers !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(answers)) {
    if (v && typeof v === 'object') {
      const a = v as any;
      if (typeof a.choice === 'string') parts.push(`${k}=${a.choice}`);
      else if (typeof a.noul === 'number') parts.push(`${k}=${a.noul.toFixed(2)}`);
      else if (typeof a.score === 'number') parts.push(`${k}=${a.score}`);
    }
  }
  return parts.join('; ');
}

// ── Free-Tier Guards ─────────────────────────────────────────────────────────
export function isFreeModel(model: string): boolean {
  return model === FREE_MODEL || model === 'openrouter/free' || model.endsWith(':free');
}

export function assertFreeModel(model: string): string {
  if (!isFreeModel(model)) {
    throw new Error(
      `"${model}" is not a free model. Free execution accepts openrouter/free or a model id ending in ":free".`
    );
  }
  return model;
}

// ── OpenRouter Clients ───────────────────────────────────────────────────────
export function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

/**
 * Tier 1: TypeSafe Jev Decisions API on OpenRouter (~800ms, calibrated).
 */
export async function callJevDecision(
  state: string,
  questions: Record<string, unknown>,
  modelTier?: string
): Promise<any> {
  const models = getJevModels();
  const timeouts = getJevTimeouts();
  const targetModel = modelTier || models.decision;

  const hash = computeDecisionCacheKey(state, questions, targetModel);
  let cached = getCachedDecision(hash);
  if (!cached) {
    const legacyHash = `${state.length}:${state.slice(0, 64)}:${state.slice(-64)}:${JSON.stringify(Object.keys(questions).sort())}`;
    cached = getCachedDecision(legacyHash);
  }

  if (cached) {
    const span = getTracer().startSpan('jev.decision', {
      'decision.state_length': state.length,
      'decision.cached': true,
      'decision.model': targetModel
    });
    span.setAttribute('decision.latency_ms', 0);
    const verdict = formatVerdict(cached);
    if (verdict) span.setAttribute('decision.verdict', verdict);
    span.end();
    return cached;
  }

  const startTime = Date.now();
  const span = getTracer().startSpan('jev.decision', {
    'decision.state_length': state.length,
    'decision.cached': false,
    'decision.model': targetModel
  });

  try {
    const res = await fetchWithTimeout(
      JEV_DECISIONS_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/agentic-hub/jev',
          'X-Title': 'Jev Decisions Gateway'
        },
        body: JSON.stringify({ model: targetModel, state, questions })
      },
      timeouts.decisionMs
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Jev Decisions API Error ${res.status}: ${errText}`);
    }
    const result = await res.json();
    const latencyMs = Date.now() - startTime;

    span.setAttribute('decision.latency_ms', latencyMs);
    const promptTokens = result.usage?.input_tokens ?? result.usage?.prompt_tokens;
    const completionTokens = result.usage?.output_tokens ?? result.usage?.completion_tokens;
    const totalTokens = result.usage?.total_tokens;

    if (typeof promptTokens === 'number') span.setAttribute('decision.tokens.input', promptTokens);
    if (typeof completionTokens === 'number') span.setAttribute('decision.tokens.output', completionTokens);
    if (typeof totalTokens === 'number') span.setAttribute('decision.tokens.total', totalTokens);

    const verdict = formatVerdict(result);
    if (verdict) span.setAttribute('decision.verdict', verdict);
    span.end();

    setCachedDecision(hash, result);
    return result;
  } catch (err: any) {
    span.setError(err);
    span.setAttribute('decision.latency_ms', Date.now() - startTime);
    span.end();
    throw err;
  }
}

/**
 * Tier 2: `typesafe/jev-router` via OpenRouter Chat Completions with strict structured JSON schema.
 */
export async function callJevRouter(state: string, questions: Record<string, unknown>): Promise<any> {
  const models = getJevModels();
  const timeouts = getJevTimeouts();
  const targetModel = models.router;

  const prompt =
    'You are a fast routing and decision engine. Read the state and answer every question.\n' +
    'Return ONLY a JSON object of the form {"answers":{"<key>":<answer>}} where each answer is\n' +
    '  {"type":"choice","choice":"<one criterion key>","confidence":<0..1>} for a choice question,\n' +
    '  {"type":"noul","noul":<0..1>} for a probability/yes-no question,\n' +
    '  {"type":"score","score":<number>} for a score question.\n' +
    'Use exactly the question keys and criterion keys given.\n\n' +
    `Questions: ${JSON.stringify(questions)}\n\nState:\n${state}`;

  const startTime = Date.now();
  const span = getTracer().startSpan('jev.router', {
    'decision.state_length': state.length,
    'decision.model': targetModel
  });

  try {
    const res = await fetchWithTimeout(
      OPENROUTER_CHAT_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/agentic-hub/jev',
          'X-Title': 'Jev Router (OpenRouter)'
        },
        body: JSON.stringify({
          model: targetModel,
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
      },
      timeouts.fallbackMs
    );

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

    const latencyMs = Date.now() - startTime;
    span.setAttribute('decision.latency_ms', latencyMs);
    if (typeof json?.usage?.prompt_tokens === 'number') span.setAttribute('decision.tokens.input', json.usage.prompt_tokens);
    if (typeof json?.usage?.completion_tokens === 'number') span.setAttribute('decision.tokens.output', json.usage.completion_tokens);
    if (typeof json?.usage?.total_tokens === 'number') span.setAttribute('decision.tokens.total', json.usage.total_tokens);

    const verdict = formatVerdict(parsed);
    if (verdict) span.setAttribute('decision.verdict', verdict);
    span.end();

    return {
      model: json?.model || targetModel,
      provider: json?.provider,
      answers: parsed?.answers || {},
      usage: json?.usage
    };
  } catch (err: any) {
    span.setError(err);
    span.setAttribute('decision.latency_ms', Date.now() - startTime);
    span.end();
    throw err;
  }
}

/**
 * Unified Jev decision call: Tier 1 decisions API first, then Tier 2 router fallback.
 */
export async function callJev(state: string, questions: Record<string, unknown>): Promise<any> {
  try {
    return await callJevDecision(state, questions);
  } catch {
    return await callJevRouter(state, questions);
  }
}

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
 * Plain generation on the fallback model. Used to escalate free-tier output.
 */
export async function callRouterCompletion(prompt: string, systemInstruction?: string): Promise<string> {
  const models = getJevModels();
  const timeouts = getJevTimeouts();
  const targetModel = models.fallback;

  const res = await fetchWithTimeout(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/agentic-hub/jev',
      'X-Title': 'Jev Escalation (OpenRouter)'
    },
    body: JSON.stringify({
      model: targetModel,
      messages: buildRouterCompletionMessages(prompt, systemInstruction)
    })
  }, timeouts.fallbackMs);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jev Escalation Error ${res.status}: ${errText}`);
  }
  const json: any = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

function isRefusalResponse(content: string, message?: any): boolean {
  if (message?.refusal) return true;
  const lower = content.trim().toLowerCase();
  if (
    lower.startsWith('user safety:') ||
    lower.startsWith('i cannot fulfill') ||
    lower.startsWith('i am unable to') ||
    lower.startsWith('i apologize, but i cannot')
  ) {
    return true;
  }
  return false;
}

export interface FreeExecutionResult {
  content: string;
  modelUsed: string;
  tokensSaved: number;
  escalated?: boolean;
  choices?: Array<{ message: { role: string; content: string } }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

/**
 * Call OpenRouter Free Model (resilient pool across top coding & text free models).
 * Cycles through FREE_MODELS_POOL with 25s timeout, strictly asserts content.trim().length >= 3
 * and non-refusal. Strictly fails if all free models fail (zero paid escalation invariant).
 */
export async function callOpenRouterFree(
  prompt: string,
  systemInstruction?: string,
  requestedModel?: string
): Promise<FreeExecutionResult> {
  const timeouts = getJevTimeouts();
  const pool = getFreeModelsPool();

  const keysToTry = Array.from(new Set([
    process.env.OPENROUTER_API_KEY,
    process.env.JEV_OPENROUTER_API_KEY,
    getOpenRouterApiKey()
  ])).filter((k): k is string => Boolean(k && k.trim() !== ''));

  if (keysToTry.length === 0) {
    throw new Error('Neither OPENROUTER_API_KEY nor JEV_OPENROUTER_API_KEY is set');
  }

  if (requestedModel) {
    assertFreeModel(requestedModel);
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const rawCandidates = requestedModel ? [requestedModel, ...pool] : pool;
  const modelsToTry = Array.from(new Set(rawCandidates)).filter((m) => isFreeModel(m));

  if (modelsToTry.length === 0) {
    throw new Error('No valid free model candidates available');
  }

  const timeoutMs = timeouts.freeExecutionMs || FREE_EXEC_TIMEOUT_MS || 25000;
  let lastError: any = null;

  for (const apiKey of keysToTry) {
    for (const m of modelsToTry) {
      try {
        const res = await fetchWithTimeout(OPENROUTER_CHAT_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/agentic-hub/jev',
            'X-Title': 'Antigravity Free Execution Offloader'
          },
          body: JSON.stringify({
            model: m,
            messages
          })
        }, timeoutMs);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          lastError = new Error(`OpenRouter Free Error (${m}) ${res.status}: ${errText}`);
          continue;
        }

        const json = await res.json();
        const content = String(json.choices?.[0]?.message?.content || '');

        // Strict content assertion: reject empty 200 OK responses (<3 chars) and refusals
        if (content.trim().length < 3 || isRefusalResponse(content, json.choices?.[0]?.message)) {
          lastError = new Error(`OpenRouter Free model ${m} returned empty content or refusal`);
          continue;
        }

        const actualModel = json.model || m;
        const promptTokens = json.usage?.prompt_tokens ?? 0;
        const completionTokens = json.usage?.completion_tokens ?? 0;
        const tokensSaved = (json.usage?.total_tokens ?? 0) || (promptTokens + completionTokens);

        return {
          ...json,
          content,
          modelUsed: actualModel,
          tokensSaved,
          escalated: false
        };
      } catch (err: any) {
        lastError = err;
        continue;
      }
    }
  }

  throw lastError || new Error('All free model candidates failed');
}
