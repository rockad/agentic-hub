#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  callJevDecision,
  callJevRouter,
  readQuotaView,
  selectModel,
  defaultEffortForSubagent,
  applyEffortGovernance,
  assertFreeModel,
  callRouterCompletion,
  type ModelCandidate,
  JEV_DECISIONS_URL,
  OPENROUTER_CHAT_URL,
  JEV_MODEL,
  JEV_ROUTER_MODEL,
  FALLBACK_MODEL,
  FREE_MODEL,
  JEV_INPUT_COST_PER_MILLION,
  FALLBACK_INPUT_COST_PER_MILLION,
  JEV_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS
} from './shared.js';

const FREE_EXEC_TIMEOUT_MS = 30000;

function getOpenRouterApiKey(): string {
  return process.env.JEV_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
}

// Telemetry log file in Antigravity app directory
const TELEMETRY_DIR = path.join(os.homedir(), '.gemini/antigravity-cli');
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, 'jev_telemetry.jsonl');

// Phoenix push disabled (costs tracked directly via OpenRouter dashboard)
async function pushPhoenixSpan(_span: unknown): Promise<void> {}

// Mode configuration paths
const JEV_CONFIG_DIR = path.join(os.homedir(), '.config', 'jev');
const JEV_STATE_FILE = path.join(JEV_CONFIG_DIR, 'mode.json');
const JEV_MODE_BIN = path.join(os.homedir(), '.local', 'bin', 'jev-mode');

export type JevMode = 'off' | 'on-demand' | 'on';

export interface ModeDetails {
  mode: JevMode;
  title: string;
  explanation: string;
  characteristics: string[];
}

export function getModeDetails(mode: string): ModeDetails {
  const normalized = mode.trim().toLowerCase();
  if (normalized === 'off') {
    return {
      mode: 'off',
      title: 'OFF',
      explanation: 'MCP server disabled. Zero token overhead. Zero OpenRouter calls. Antigravity operates strictly with built-in native tools.',
      characteristics: [
        'MCP server disabled (zero token overhead)',
        'Zero external OpenRouter calls',
        'Antigravity operates strictly with built-in native tools',
        'No pre-flight routing or automatic quality evaluations'
      ]
    };
  }
  if (normalized === 'on-demand' || normalized === 'ondemand') {
    return {
      mode: 'on-demand',
      title: 'ON-DEMAND',
      explanation: 'MCP server enabled as a passive System 1 coprocessor. Invoked selectively for complex multi-role workflows and ad-hoc free-tier generation.',
      characteristics: [
        'Passive System 1 coprocessor',
        'Invoked selectively for complex multi-role workflows and routing',
        'Free-tier generative execution available on request (openrouter/free)',
        'No mandatory pre-flight dispatch on routine tasks'
      ]
    };
  }
  return {
    mode: 'on',
    title: 'ON (AGGRESSIVE)',
    explanation: 'Mandatory System 1 enforcement active: aggressive pre-flight routing, free-tier offloading, automated quality gates, and subagent tier clamping.',
    characteristics: [
      'Pre-Flight Everything: Non-trivial tasks dispatched via jev_dispatch to calibrate subagent role & tier',
      'Free-Tier Offloading: Boilerplate, text formatting, summaries, and commits offloaded to openrouter/free ($0.00 cost, 0 quota)',
      'Automated Quality Gates: Diff evaluations and pre-commit checks evaluated with jev_judge',
      'Subagent Tier Guard: Pro tier models strictly gated behind manual user approval'
    ]
  };
}

async function readCurrentMode(): Promise<{ mode: JevMode; updatedAt?: string; raw?: Record<string, any> }> {
  try {
    if (fsSync.existsSync(JEV_STATE_FILE)) {
      const raw = await fs.readFile(JEV_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const m = (parsed.mode || 'on').toLowerCase();
      const validMode: JevMode = (m === 'off' || m === 'on-demand' || m === 'on') ? m : 'on';
      return { mode: validMode, updatedAt: parsed.updated_at, raw: parsed };
    }
  } catch {
    // Ignore read errors, default to on
  }
  return { mode: 'on' };
}

async function writeModeState(mode: JevMode): Promise<string> {
  await fs.mkdir(JEV_CONFIG_DIR, { recursive: true });
  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify({ mode, updated_at: updatedAt });
  await fs.writeFile(JEV_STATE_FILE, payload + '\n', 'utf8');
  return updatedAt;
}

function quotaRecommendation(strategy: string): string {
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

// Abstract fallback candidates for jev_select_model when the caller passes none.
const DEFAULT_MODEL_CANDIDATES: ModelCandidate[] = [
  { id: 'free', tier: 'free', providerModel: 'openrouter/free', costInPerMTok: 0, costOutPerMTok: 0, label: 'Free tier' },
  { id: 'cheap', tier: 'cheap', providerModel: '(configured cheap tier)', costInPerMTok: 0.15, costOutPerMTok: 0.6, label: 'Cheap tier' },
  { id: 'standard', tier: 'standard', providerModel: '(configured standard tier)', costInPerMTok: 1, costOutPerMTok: 4, label: 'Standard tier' },
  { id: 'expensive', tier: 'expensive', providerModel: '(configured expensive tier)', costInPerMTok: 3, costOutPerMTok: 15, label: 'Expensive tier' }
];

/**
 * Non-blocking append to local telemetry log
 */
async function logTelemetry(entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(TELEMETRY_DIR, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    await fs.appendFile(TELEMETRY_FILE, line, 'utf8');
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Fetch wrapper with strict timeout
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}



const FREE_MODELS_POOL = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-lightning:free'
];

const OPENCODE_BIN = process.env.OPENCODE_BIN || path.join(os.homedir(), '.opencode', 'bin', 'opencode');

export interface OpenCodeAgentOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
}

export interface OpenCodeAgentResult {
  content: string;
  modelUsed: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensSaved?: number;
  costUsd: number;
  rawStdout: string;
  backend: 'opencode';
}

export async function callOpenCodeAgent(options: OpenCodeAgentOptions): Promise<OpenCodeAgentResult> {
  const opencodebin = fsSync.existsSync(OPENCODE_BIN) ? OPENCODE_BIN : 'opencode';
  const rawModel = options.model || 'openrouter/free';
  // OpenCode expects provider-prefixed model: openrouter/<model_id>
  // For openrouter/free, the provider is openrouter and model ID is openrouter/free -> openrouter/openrouter/free
  let openCodeModel = rawModel;
  if (openCodeModel === 'openrouter/free') {
    openCodeModel = 'openrouter/openrouter/free';
  } else if (!openCodeModel.startsWith('openrouter/')) {
    openCodeModel = `openrouter/${openCodeModel}`;
  }
  const targetCwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 120000;
  const startTs = Date.now();

  // Inject OpenRouter key via OPENCODE_CONFIG_CONTENT
  const apiKey = getOpenRouterApiKey();
  const providerConfig = JSON.stringify({
    provider: {
      openrouter: {
        options: {
          apiKey
        }
      }
    }
  });

  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: providerConfig
  };

  const args = ['run', '--standalone', '--auto', '--format', 'json', '-m', openCodeModel, options.prompt];

  let stdout = '';
  if (typeof Bun !== 'undefined' && typeof (Bun as any).spawn === 'function') {
    const proc = (Bun as any).spawn([opencodebin, ...args], {
      cwd: targetCwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    // Bun.spawn has no timeout of its own here, so enforce timeoutMs explicitly.
    // Race rather than wait: a grandchild can keep the pipes open after kill().
    // stderr is drained alongside stdout so a chatty process cannot fill the pipe and stall.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`OpenCode execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const [out, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited
        ]),
        timeout
      ]);
      stdout = out;
      if (exitCode !== 0 && !stdout.trim()) {
        throw new Error(`OpenCode execution failed with exit code ${exitCode}: ${stderr}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    const { stdout: out } = await execFileAsync(opencodebin, args, {
      cwd: targetCwd,
      timeout: timeoutMs,
      env,
      maxBuffer: 10 * 1024 * 1024
    });
    stdout = out;
  }

  // Parse NDJSON stream: collect all type:"text" part.text values
  const textParts: string[] = [];
  let modelUsed = rawModel;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'text' && event.part?.text) {
        textParts.push(event.part.text);
        if (!firstTs && event.part.time?.start) firstTs = event.part.time.start;
        if (event.part.time?.end) lastTs = event.part.time.end;
      }
      if (event.type === 'error') {
        throw new Error(`OpenCode agent error: ${event.error?.message || JSON.stringify(event.error)}`);
      }
      // Extract usage if present in any event
      if (event.part?.usage) {
        inputTokens = event.part.usage.input ?? inputTokens;
        outputTokens = event.part.usage.output ?? outputTokens;
        if (event.part.usage.model) modelUsed = event.part.usage.model;
      }
    } catch (parseErr: any) {
      if (parseErr.message?.startsWith('OpenCode agent error:')) throw parseErr;
      // skip unparseable lines
    }
  }

  const content = textParts.join('').trim();
  const durationMs = firstTs && lastTs ? lastTs - firstTs : Date.now() - startTs;
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);

  return {
    content: content || stdout.trim(),
    modelUsed,
    durationMs,
    inputTokens,
    outputTokens,
    tokensSaved: totalTokens,
    costUsd: 0,
    rawStdout: stdout,
    backend: 'opencode'
  };
}

/**
 * Call OpenRouter Free Model (resilient pool across top coding & text free models)
 */
async function callOpenRouterFree(prompt: string, systemInstruction?: string, requestedModel?: string): Promise<any> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const modelsToTry = Array.from(new Set(requestedModel ? [requestedModel, ...FREE_MODELS_POOL] : FREE_MODELS_POOL));
  let lastError: any = null;

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
      }, FREE_EXEC_TIMEOUT_MS);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastError = new Error(`OpenRouter Free Error (${m}) ${res.status}: ${errText}`);
        continue;
      }

      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '';
      // Avoid content-safety false positives
      if (content.trim().toLowerCase().startsWith('user safety:')) {
        continue;
      }
      return json;
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error('All free model candidates failed');
}

const server = new Server(
  { name: 'jev', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'jev_route',
      description: 'Ultra-fast (~800ms) choice selection and classification via OpenRouter native Decisions API (~typesafe/jev-latest). Evaluates candidate options and criteria mapping, returning calibrated probabilities and confidence.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'The text snippet, note, or prompt to classify' },
          options: { type: 'array', items: { type: 'string' }, description: 'Candidate categories/options to choose from' },
          criteria: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional dictionary mapping option keys to descriptive criteria'
          },
          instruction: { type: 'string', description: 'Optional instruction or question for classification' }
        },
        required: ['context', 'options']
      }
    },
    {
      name: 'jev_judge',
      description: 'Fast binary condition testing and verification using OpenRouter native Decisions API (question type "noul"). Returns passed: true if noul >= 0.5.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'The content or output to evaluate' },
          condition: { type: 'string', description: 'The condition to test (e.g. "Did this task succeed?")' }
        },
        required: ['context', 'condition']
      }
    },
    {
      name: 'jev_score',
      description: 'Rate relevance, quality, or cognitive complexity on an ordinal scale using OpenRouter native Decisions API (question type "score") with criteria buckets.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Content to rate' },
          rubric: { type: 'string', description: 'Rubric or question for rating' },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional array of criteria descriptions (defaults to standard 5-point quality scale)'
          }
        },
        required: ['context']
      }
    },
    {
      name: 'jev_dispatch',
      description: 'Intelligently route a task to the optimal subagent and model tier ("openrouter_free" | "flash_lite" | "flash" | "pro") in a single ~800ms decision call using TypeSafe Jev. "pro" tier models require explicit manual user approval before invocation.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, prompt, or sub-goal to dispatch' },
          availableSubagents: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional candidate subagents (defaults to generic subagents: code_engineer, research, general_assistant, review)'
          }
        },
        required: ['task']
      }
    },
    {
      name: 'jev_agent_free',
      description: 'Execute autonomous agentic coding, workspace modification, refactoring, and text tasks using free-tier models via OpenCode CLI or OpenRouter Free pool at $0.00 cost (0 Gemini quota).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The coding task, refactoring request, or prompt for the autonomous agent' },
          cwd: { type: 'string', description: 'Optional working directory for agent workspace execution (defaults to current working directory)' },
          backend: {
            type: 'string',
            enum: ['auto', 'opencode', 'openrouter'],
            description: 'Execution backend: "opencode" for full workspace agent CLI (multi-step), "openrouter" for direct model inference (single-turn), "auto" for opencode with fallback to openrouter'
          },
          model: {
            type: 'string',
            description: 'Free model to use (defaults to "openrouter/free" [200k ctx, official router], also supports "google/gemma-4-31b-it:free", "cohere/north-mini-code:free", "nvidia/nemotron-3.5-lightning:free")'
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional execution timeout in milliseconds (defaults to 120000ms)'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'jev_execute_free',
      description: 'Execute lightweight generative tasks (summaries, formatting, drafting, boilerplate) using OpenRouter Free Tier (defaults to openrouter/free [200k ctx]) at $0.00 cost, saving Gemini quota.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt or instructions to execute' },
          systemInstruction: { type: 'string', description: 'Optional system instructions' },
          model: { type: 'string', description: 'Optional OpenRouter free model (defaults to openrouter/free)' },
          backend: {
            type: 'string',
            enum: ['openrouter', 'opencode', 'auto'],
            description: 'Optional backend: "openrouter" (default, direct HTTP inference) or "opencode" (OpenCode CLI agent)'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'jev_execute_free_guarded',
      description: 'Execute lightweight or trivial generative tasks (formatting, boilerplate, summaries, single-file edits, markdown transformations) on OpenRouter free-tier models ($0.00 cost) with an automatic jev_judge quality gate evaluation. Automatically escalates to a fallback tier if quality verification fails.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task prompt or content to process' },
          systemInstruction: { type: 'string', description: 'Optional system instructions' },
          condition: { type: 'string', description: 'Optional quality gate evaluation condition (e.g. "Is the output complete, coherent, and non-empty?")' },
          model: { type: 'string', description: 'Optional free model candidate (defaults to openrouter/free)' }
        },
        required: ['prompt']
      }
    },
    {
      name: 'jev_set_mode',
      description: 'Switch TypeSafe Jev operating mode ("off" | "on-demand" | "on"). Updates ~/.config/jev/mode.json and MCP availability via ~/.local/bin/jev-mode.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['off', 'on-demand', 'on'],
            description: 'The operating mode to set: "off" (disabled, 0 overhead), "on-demand" (passive coprocessor), or "on" (aggressive System 1 enforcement)'
          }
        },
        required: ['mode']
      }
    },
    {
      name: 'jev_get_mode',
      description: 'Inspect current TypeSafe Jev operating mode, configuration state, and operating characteristics.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'jev_quota',
      description: 'Report the live Antigravity (Google AI Pro) quota view across all buckets (gemini-5h, gemini-weekly, 3p-5h, 3p-weekly), reset-aware, and return a spending strategy: "normal" | "conserve" | "free_only" | "unknown". Use it to decide whether to keep working on Gemini tiers or offload to openrouter/free. May be stale when Antigravity is closed.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description: 'Reserved: hint that the caller wants a fresh read (the statusline is the only live source; this flag does not force a refresh).'
          }
        }
      }
    },
    {
      name: 'jev_select_model',
      description: 'Cost-tiered model selection. In one ~800ms Jev decision call, returns a ranked set of candidate models (with cost + calibrated probability), the cheapest option that is sufficient for the task, the expensive options, and a recommendation: "cheapest_suitable" (proceed on the cheap option) or "ask_user" (the cheapest sufficient option is expensive — present the options and let the user choose). Cost-first: always prefers cheaper; expensive requires manual approval.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, prompt, or sub-goal to size up' },
          candidates: {
            type: 'array',
            description: 'Optional cost-annotated candidate models. Each: { id, tier, providerModel, costInPerMTok, costOutPerMTok, label? }. Defaults to four abstract tiers if omitted.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                tier: { type: 'string', enum: ['free', 'cheap', 'standard', 'expensive'] },
                providerModel: { type: 'string' },
                costInPerMTok: { type: 'number' },
                costOutPerMTok: { type: 'number' },
                label: { type: 'string' }
              },
              required: ['id', 'providerModel', 'costInPerMTok', 'costOutPerMTok']
            }
          },
          quotaStrategy: {
            type: 'string',
            enum: ['normal', 'conserve', 'free_only', 'unknown'],
            description: 'Optional quota strategy from jev_quota; biases the ladder toward free when quota is tight.'
          }
        },
        required: ['task']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const start = performance.now();
  const startTimeIso = new Date().toISOString();

  // -------------------------------------------------------------
  // Tool: jev_route
  // -------------------------------------------------------------
  if (name === 'jev_route') {
    const { context, options, criteria, instruction } = (args || {}) as {
      context: string;
      options: string[];
      criteria?: Record<string, string>;
      instruction?: string;
    };

    if (!context || !Array.isArray(options) || options.length === 0) {
      throw new Error('jev_route requires non-empty "context" and "options" array');
    }

    // Build criteria dictionary
    const criteriaMap: Record<string, string> = {};
    for (const opt of options) {
      criteriaMap[opt] = (criteria && criteria[opt]) ? criteria[opt] : opt;
    }

    let chosen: string | null = null;
    let confidence = 1.0;
    let probabilities: Record<string, number> = {};
    let modelUsed = JEV_MODEL;
    let fallbackUsed = false;
    let promptTokens = 0;
    let costUsd = 0;

    // Tier 1: Jev Decisions API
    try {
      const data = await callJevDecision(context, {
        route: {
          type: 'choice',
          instructions: instruction || 'Select the most applicable category',
          criteria: criteriaMap
        }
      });
      const routeAnswer = data.answers?.route;
      chosen = routeAnswer?.choice || options[0];
      confidence = routeAnswer?.confidence ?? 1.0;
      probabilities = routeAnswer?.probabilities ?? {};
      promptTokens = data.usage?.input_tokens ?? 0;
      costUsd = typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
      modelUsed = data.model || JEV_MODEL;
    } catch (primaryErr: any) {
      console.error(`[jev warn] Tier 1 decisions failed: ${primaryErr.message}. Triggering Tier 2 (${FALLBACK_MODEL})...`);

      // Tier 2: Fallback Model
      try {
        const fallbackData = await callJevRouter(context, {
          route: {
            type: 'choice',
            instructions: instruction || 'Select the most applicable category',
            criteria: criteriaMap
          }
        });
        fallbackUsed = true;
        modelUsed = fallbackData.model || FALLBACK_MODEL;
        promptTokens = fallbackData.usage?.prompt_tokens ?? fallbackData.usage?.input_tokens ?? 0;
        costUsd = (promptTokens / 1_000_000) * FALLBACK_INPUT_COST_PER_MILLION;

        const routeAnswer = fallbackData.answers?.route;
        chosen = routeAnswer?.choice || options[0];
        confidence = routeAnswer?.confidence ?? 0.85;
        probabilities = routeAnswer?.probabilities ?? { [chosen || options[0]]: 1.0 };
      } catch (fallbackErr: any) {
        const latencyMs = Math.round(performance.now() - start);
        const endTimeIso = new Date().toISOString();
        await logTelemetry({ tool: 'jev_route', status: 'error', error: String(fallbackErr), latencyMs });
        pushPhoenixSpan({
          name: 'jev:jev_route',
          startTimeIso,
          endTimeIso,
          attributes: {
            'tool.name': 'jev_route',
            'fallback.used': true,
            'fallback.tier': 3,
            'latency_ms': latencyMs
          }
        });
        // Fail loudly — both Jev Decisions API and fallback model are unavailable.
        // Check OPENROUTER_API_KEY is set and valid; both tiers require it.
        throw new Error(
          `jev_route: all routing tiers failed. Tier 1 (Jev Decisions API) and Tier 2 (${FALLBACK_MODEL}) both unavailable. ` +
          `Last error: ${fallbackErr.message}. Ensure OPENROUTER_API_KEY is set and valid.`
        );
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const endTimeIso = new Date().toISOString();

    const telemetry = {
      modelUsed,
      fallbackUsed,
      latencyMs,
      promptTokens,
      costUsd: Number(costUsd.toFixed(8)),
      costFormatted: `$${costUsd.toFixed(6)}`
    };

    await logTelemetry({
      tool: 'jev_route',
      chosen,
      confidence,
      probabilities,
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_route',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_route',
        'decision.choice': chosen,
        'decision.confidence': confidence,
        'decision.probabilities': JSON.stringify(probabilities),
        'model.used': modelUsed,
        'cost_usd': telemetry.costUsd,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          choice: chosen,
          confidence,
          probabilities,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_judge
  // -------------------------------------------------------------
  if (name === 'jev_judge') {
    const { context, condition } = (args || {}) as { context: string; condition: string };
    if (!context || !condition) {
      throw new Error('jev_judge requires "context" and "condition"');
    }

    let passed = false;
    let noulValue = 0.5;
    let confidence = 0.5;
    let modelUsed = JEV_MODEL;
    let fallbackUsed = false;
    let promptTokens = 0;
    let costUsd = 0;

    // Tier 1: Jev Decisions API with question type 'noul'
    try {
      const data = await callJevDecision(context, {
        judgment: {
          type: 'noul',
          instructions: condition
        }
      });
      const judgmentAnswer = data.answers?.judgment;
      noulValue = typeof judgmentAnswer?.noul === 'number' ? judgmentAnswer.noul : 0.5;
      passed = noulValue >= 0.5;
      confidence = judgmentAnswer?.confidence ?? Number((Math.abs(noulValue - 0.5) * 2).toFixed(2));
      promptTokens = data.usage?.input_tokens ?? 0;
      costUsd = typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
      modelUsed = data.model || JEV_MODEL;
    } catch (primaryErr: any) {
      console.error(`[jev warn] Tier 1 decisions failed: ${primaryErr.message}. Triggering Tier 2 (${FALLBACK_MODEL})...`);

      // Tier 2: Fallback Model
      try {
        const fallbackData = await callJevRouter(context, {
          judgment: {
            type: 'noul',
            instructions: condition
          }
        });
        fallbackUsed = true;
        modelUsed = fallbackData.model || FALLBACK_MODEL;
        promptTokens = fallbackData.usage?.prompt_tokens ?? fallbackData.usage?.input_tokens ?? 0;
        costUsd = (promptTokens / 1_000_000) * FALLBACK_INPUT_COST_PER_MILLION;

        const judgmentAnswer = fallbackData.answers?.judgment;
        noulValue = typeof judgmentAnswer?.noul === 'number' ? judgmentAnswer.noul : 0.5;
        passed = noulValue >= 0.5;
        confidence = judgmentAnswer?.confidence ?? Number((Math.abs(noulValue - 0.5) * 2).toFixed(2));
      } catch (fallbackErr: any) {
        const latencyMs = Math.round(performance.now() - start);
        const endTimeIso = new Date().toISOString();
        await logTelemetry({ tool: 'jev_judge', status: 'error', error: String(fallbackErr), latencyMs });
        pushPhoenixSpan({
          name: 'jev:jev_judge',
          startTimeIso,
          endTimeIso,
          attributes: {
            'tool.name': 'jev_judge',
            'fallback.used': true,
            'fallback.tier': 3,
            'latency_ms': latencyMs
          }
        });
        // Fail loudly — both Jev Decisions API and fallback model are unavailable.
        throw new Error(
          `jev_judge: all judgment tiers failed. Tier 1 (Jev Decisions API) and Tier 2 (${FALLBACK_MODEL}) both unavailable. ` +
          `Last error: ${fallbackErr.message}. Ensure OPENROUTER_API_KEY is set and valid.`
        );
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const endTimeIso = new Date().toISOString();

    const telemetry = {
      modelUsed,
      fallbackUsed,
      latencyMs,
      promptTokens,
      costUsd: Number(costUsd.toFixed(8)),
      costFormatted: `$${costUsd.toFixed(6)}`
    };

    await logTelemetry({
      tool: 'jev_judge',
      passed,
      noul: noulValue,
      confidence,
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_judge',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_judge',
        'decision.passed': passed,
        'decision.noul': noulValue,
        'decision.confidence': confidence,
        'model.used': modelUsed,
        'cost_usd': telemetry.costUsd,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          passed,
          noul: noulValue,
          confidence,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_score
  // -------------------------------------------------------------
  if (name === 'jev_score') {
    const { context, rubric, criteria } = (args || {}) as {
      context: string;
      rubric?: string;
      criteria?: string[];
    };

    if (!context) {
      throw new Error('jev_score requires "context"');
    }

    const criteriaList = Array.isArray(criteria) && criteria.length > 0
      ? criteria
      : ['Poor', 'Fair', 'Good', 'Very Good', 'Exceptional'];

    let score = 3;
    let confidence = 0.9;
    let probabilities: Record<string, number> = {};
    let legend: Record<string, string> = {};
    let modelUsed = JEV_MODEL;
    let fallbackUsed = false;
    let promptTokens = 0;
    let costUsd = 0;

    // Tier 1: Jev Decisions API with question type 'score'
    try {
      const data = await callJevDecision(context, {
        score: {
          type: 'score',
          instructions: rubric || 'Rate content quality according to the criteria',
          criteria: criteriaList
        }
      });
      const scoreAnswer = data.answers?.score;
      score = typeof scoreAnswer?.score === 'number' ? scoreAnswer.score : 3;
      confidence = scoreAnswer?.confidence ?? 0.95;
      probabilities = scoreAnswer?.probabilities ?? {};
      legend = scoreAnswer?.legend ?? {};
      promptTokens = data.usage?.input_tokens ?? 0;
      costUsd = typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
      modelUsed = data.model || JEV_MODEL;
    } catch (primaryErr: any) {
      console.error(`[jev warn] Tier 1 decisions failed: ${primaryErr.message}. Triggering Tier 2 (${FALLBACK_MODEL})...`);

      // Tier 2: Fallback Model
      try {
        const fallbackData = await callJevRouter(context, {
          score: {
            type: 'score',
            instructions: rubric || 'Rate content quality according to the criteria',
            criteria: criteriaList
          }
        });
        fallbackUsed = true;
        modelUsed = fallbackData.model || FALLBACK_MODEL;
        promptTokens = fallbackData.usage?.prompt_tokens ?? fallbackData.usage?.input_tokens ?? 0;
        costUsd = (promptTokens / 1_000_000) * FALLBACK_INPUT_COST_PER_MILLION;

        const scoreAnswer = fallbackData.answers?.score;
        score = typeof scoreAnswer?.score === 'number' ? scoreAnswer.score : 3;
        confidence = scoreAnswer?.confidence ?? 0.85;
        probabilities = scoreAnswer?.probabilities ?? {};
        legend = scoreAnswer?.legend ?? {};
      } catch (fallbackErr: any) {
        const passthroughPayload = {
          score: null,
          confidence: 0,
          fallbackToAgent: true,
          message: 'Rating models unavailable. Please score directly using your own reasoning.'
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(passthroughPayload, null, 2) }]
        };
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const endTimeIso = new Date().toISOString();

    const telemetry = {
      modelUsed,
      fallbackUsed,
      latencyMs,
      promptTokens,
      costUsd: Number(costUsd.toFixed(8)),
      costFormatted: `$${costUsd.toFixed(6)}`
    };

    await logTelemetry({
      tool: 'jev_score',
      score,
      confidence,
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_score',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_score',
        'decision.score': score,
        'decision.confidence': confidence,
        'decision.probabilities': JSON.stringify(probabilities),
        'model.used': modelUsed,
        'cost_usd': telemetry.costUsd,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          score,
          legend,
          probabilities,
          confidence,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_dispatch
  // -------------------------------------------------------------
  if (name === 'jev_dispatch') {
    const { task, availableSubagents } = (args || {}) as {
      task: string;
      availableSubagents?: string[];
    };

    if (!task) {
      throw new Error('jev_dispatch requires a non-empty "task" string');
    }

    const defaultSubagentCriteria: Record<string, string> = {
      code_engineer: 'Software engineering, writing/refactoring code, automation scripts, tests, MCP servers',
      research: 'Broad web exploration, documentation gathering, deep analysis',
      general_assistant: 'General multi-domain coordination, task execution, planning',
      review: 'Quality gate review, code/diff verification, sanity checking',
      self: 'Direct clone of parent execution or current session',
      none: 'Direct answer without subagent delegation'
    };

    let subagentCriteria: Record<string, string> = {};
    if (Array.isArray(availableSubagents) && availableSubagents.length > 0) {
      for (const sa of availableSubagents) {
        subagentCriteria[sa] = defaultSubagentCriteria[sa] || sa;
      }
    } else {
      subagentCriteria = defaultSubagentCriteria;
    }

    const tierCriteria: Record<string, string> = {
      openrouter_free: 'Lightweight summaries, drafts, syntax transformations, autonomous free agent tasks via opencode/jev_agent_free, and boilerplate ($0 cost, 0 Gemini quota)',
      flash_lite: 'Trivial triage, fast simple lookups, file moves, quick formatting',
      flash: 'Standard agentic steps, routine edits, content synthesis, local commands',
      pro: 'Deep reasoning, architectural planning, complex multi-file refactoring, high-stakes writing'
    };

    let recommendedSubagent = 'self';
    let recommendedTier = 'flash';
    let confidence = 0.95;
    let subagentProbabilities: Record<string, number> = {};
    let tierProbabilities: Record<string, number> = {};
    let modelUsed = JEV_MODEL;
    let fallbackUsed = false;
    let promptTokens = 0;
    let costUsd = 0;

    // Tier 1: Single decision call with both questions
    try {
      const data = await callJevDecision(`Task: ${task}`, {
        recommendedSubagent: {
          type: 'choice',
          instructions: 'Select the best specialized subagent for this task',
          criteria: subagentCriteria
        },
        recommendedTier: {
          type: 'choice',
          instructions: 'Determine the required model tier based on cognitive load and task complexity',
          criteria: tierCriteria
        }
      });

      const saAnswer = data.answers?.recommendedSubagent;
      const tierAnswer = data.answers?.recommendedTier;

      recommendedSubagent = saAnswer?.choice || 'self';
      recommendedTier = tierAnswer?.choice || 'flash';
      subagentProbabilities = saAnswer?.probabilities || {};
      tierProbabilities = tierAnswer?.probabilities || {};
      confidence = Math.min(saAnswer?.confidence ?? 0.95, tierAnswer?.confidence ?? 0.95);

      promptTokens = data.usage?.input_tokens ?? 0;
      costUsd = typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
      modelUsed = data.model || JEV_MODEL;
    } catch (primaryErr: any) {
      console.error(`[jev warn] Tier 1 dispatch failed: ${primaryErr.message}. Triggering Tier 2 (${FALLBACK_MODEL})...`);

      // Tier 2: Fallback Model
      try {
        const fallbackData = await callJevRouter(`Task: ${task}`, {
          recommendedSubagent: {
            type: 'choice',
            instructions: 'Select the best specialized subagent for this task',
            criteria: subagentCriteria
          },
          recommendedTier: {
            type: 'choice',
            instructions: 'Determine the required model tier based on cognitive load and task complexity',
            criteria: tierCriteria
          }
        });

        fallbackUsed = true;
        modelUsed = fallbackData.model || FALLBACK_MODEL;
        promptTokens = fallbackData.usage?.prompt_tokens ?? fallbackData.usage?.input_tokens ?? 0;
        costUsd = (promptTokens / 1_000_000) * FALLBACK_INPUT_COST_PER_MILLION;

        const saAnswer = fallbackData.answers?.recommendedSubagent;
        const tierAnswer = fallbackData.answers?.recommendedTier;

        recommendedSubagent = saAnswer?.choice || 'self';
        recommendedTier = tierAnswer?.choice || 'flash';
        subagentProbabilities = saAnswer?.probabilities || {};
        tierProbabilities = tierAnswer?.probabilities || {};
        confidence = Math.min(saAnswer?.confidence ?? 0.85, tierAnswer?.confidence ?? 0.85);
      } catch (fallbackErr: any) {
        const latencyMs = Math.round(performance.now() - start);
        const endTimeIso = new Date().toISOString();
        await logTelemetry({ tool: 'jev_dispatch', status: 'error', error: String(fallbackErr), latencyMs });
        pushPhoenixSpan({
          name: 'jev:jev_dispatch',
          startTimeIso,
          endTimeIso,
          attributes: {
            'tool.name': 'jev_dispatch',
            'fallback.used': true,
            'fallback.tier': 3,
            'latency_ms': latencyMs
          }
        });
        // Fail loudly — both Jev Decisions API and OpenRouter fallback are unavailable.
        // Do NOT return a fake self/flash payload: that silently hides misconfiguration.
        throw new Error(
          `jev_dispatch: all dispatch tiers failed. Tier 1 (Jev Decisions API) and Tier 2 (${FALLBACK_MODEL}) both unavailable. ` +
          `Last error: ${fallbackErr.message}. Ensure OPENROUTER_API_KEY is set and valid in mcp_config.json.`
        );
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const endTimeIso = new Date().toISOString();

    const telemetry = {
      modelUsed,
      fallbackUsed,
      latencyMs,
      promptTokens,
      costUsd: Number(costUsd.toFixed(8)),
      costFormatted: `$${costUsd.toFixed(6)}`
    };

    const quotaView = await readQuotaView();
    const rawEffort = defaultEffortForSubagent(recommendedSubagent, task);
    const recommendedEffort = applyEffortGovernance(rawEffort, quotaView.strategy, recommendedTier);

    const isPro = recommendedTier === 'pro';
    const result = {
      recommendedSubagent,
      recommendedTier,
      recommendedEffort,
      requiresUserApproval: isPro,
      ...(isPro
        ? {
            approvalReason:
              'Pro tier model recommended for deep reasoning. Explicit manual user approval required before proceeding.'
          }
        : {}),
      delegationRecommended: recommendedSubagent !== 'none',
      confidence,
      subagentProbabilities,
      tierProbabilities,
      telemetry
    };

    await logTelemetry({
      tool: 'jev_dispatch',
      task: task.slice(0, 100),
      ...result
    });

    pushPhoenixSpan({
      name: 'jev:jev_dispatch',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_dispatch',
        'dispatch.subagent': recommendedSubagent,
        'dispatch.tier': recommendedTier,
        'decision.confidence': confidence,
        'subagent.probabilities': JSON.stringify(subagentProbabilities),
        'tier.probabilities': JSON.stringify(tierProbabilities),
        'model.used': modelUsed,
        'cost_usd': telemetry.costUsd,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_agent_free
  // -------------------------------------------------------------
  if (name === 'jev_agent_free') {
    const { prompt, cwd, backend = 'auto', model, timeoutMs } = (args || {}) as {
      prompt: string;
      cwd?: string;
      backend?: 'auto' | 'opencode' | 'openrouter';
      model?: string;
      timeoutMs?: number;
    };

    if (!prompt) {
      throw new Error('jev_agent_free requires "prompt"');
    }

    const freeModel = assertFreeModel(model || FREE_MODEL);
    const targetCwd = cwd || process.cwd();
    let content = '';
    let actualModel = freeModel;
    let actualBackend: 'opencode' | 'openrouter' = 'opencode';
    let tokensSaved = 0;
    let costUsd = 0;
    let latencyMs = 0;
    let fallbackTriggered = false;

    if (backend === 'opencode' || backend === 'auto') {
      try {
        const ocRes = await callOpenCodeAgent({
          prompt,
          cwd: targetCwd,
          model: freeModel,
          timeoutMs: timeoutMs || 120000
        });
        content = ocRes.content;
        actualModel = ocRes.modelUsed;
        actualBackend = 'opencode';
        tokensSaved = ocRes.tokensSaved || 0;
        costUsd = ocRes.costUsd || 0;
        latencyMs = ocRes.durationMs || Math.round(performance.now() - start);
      } catch (ocErr: any) {
        if (backend === 'opencode') {
          console.error(`[jev error] jev_agent_free (opencode backend) failed: ${ocErr.message}`);
          throw new Error(`OpenCode Agent execution failed: ${ocErr.message}`);
        }
        console.warn(`[jev warn] jev_agent_free OpenCode failed: ${ocErr.message}. Falling back to OpenRouter direct...`);
        fallbackTriggered = true;
      }
    }

    if (backend === 'openrouter' || fallbackTriggered) {
      actualBackend = 'openrouter';
      try {
        const data = await callOpenRouterFree(prompt, undefined, freeModel);
        content = data.choices?.[0]?.message?.content || '';
        actualModel = data.model || freeModel;
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        tokensSaved = (data.usage?.total_tokens ?? 0) || (promptTokens + completionTokens);
        costUsd = 0;
        latencyMs = Math.round(performance.now() - start);
      } catch (err: any) {
        console.error(`[jev error] jev_agent_free failed: ${err.message}`);
        throw new Error(`Free Agent execution failed: ${err.message}`);
      }
    }

    const endTimeIso = new Date().toISOString();
    const telemetry = {
      modelUsed: actualModel,
      backend: actualBackend,
      fallbackTriggered,
      latencyMs,
      tokensSaved,
      costUsd,
      costFormatted: '$0.00'
    };

    await logTelemetry({
      tool: 'jev_agent_free',
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_agent_free',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_agent_free',
        'backend': actualBackend,
        'model.used': actualModel,
        'quota_tokens_saved': tokensSaved,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content,
          backend: actualBackend,
          modelUsed: actualModel,
          tokensSaved,
          costUsd: 0,
          latencyMs,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_execute_free
  // -------------------------------------------------------------
  if (name === 'jev_execute_free') {
    const { prompt, systemInstruction, model, backend = 'openrouter' } = (args || {}) as {
      prompt: string;
      systemInstruction?: string;
      model?: string;
      backend?: 'openrouter' | 'opencode' | 'auto';
    };

    if (!prompt) {
      throw new Error('jev_execute_free requires "prompt"');
    }

    const freeModel = assertFreeModel(model || FREE_MODEL);
    let content = '';
    let actualModel = freeModel;
    let actualBackend: 'openrouter' | 'opencode' = 'openrouter';
    let tokensSaved = 0;
    let costUsd = 0;
    let latencyMs = 0;

    if (backend === 'opencode') {
      try {
        const ocRes = await callOpenCodeAgent({
          prompt: systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt,
          model: freeModel
        });
        content = ocRes.content;
        actualModel = ocRes.modelUsed;
        actualBackend = 'opencode';
        tokensSaved = ocRes.tokensSaved || 0;
        costUsd = ocRes.costUsd || 0;
        latencyMs = ocRes.durationMs || Math.round(performance.now() - start);
      } catch (err: any) {
        console.error(`[jev error] jev_execute_free (opencode) failed: ${err.message}`);
        throw new Error(`OpenCode execution failed: ${err.message}`);
      }
    } else {
      let data: any;
      try {
        data = await callOpenRouterFree(prompt, systemInstruction, freeModel);
      } catch (err: any) {
        console.error(`[jev error] jev_execute_free failed: ${err.message}`);
        throw new Error(`OpenRouter Free execution failed: ${err.message}`);
      }

      content = data.choices?.[0]?.message?.content || '';
      actualModel = data.model || freeModel;
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      tokensSaved = (data.usage?.total_tokens ?? 0) || (promptTokens + completionTokens);
      costUsd = 0;
      latencyMs = Math.round(performance.now() - start);
    }

    const endTimeIso = new Date().toISOString();
    const telemetry = {
      modelUsed: actualModel,
      backend: actualBackend,
      latencyMs,
      tokensSaved,
      costUsd: 0.00,
      costFormatted: '$0.00'
    };

    await logTelemetry({
      tool: 'jev_execute_free',
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_execute_free',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_execute_free',
        'backend': actualBackend,
        'model.used': actualModel,
        'quota_tokens_saved': tokensSaved,
        'cost_usd': 0.0,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content,
          backend: actualBackend,
          modelUsed: actualModel,
          tokensSaved,
          costUsd: 0,
          latencyMs,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_execute_free_guarded
  // -------------------------------------------------------------
  if (name === 'jev_execute_free_guarded') {
    const { prompt, systemInstruction, condition, model } = (args || {}) as {
      prompt: string;
      systemInstruction?: string;
      condition?: string;
      model?: string;
    };

    if (!prompt) {
      throw new Error('jev_execute_free_guarded requires "prompt"');
    }

    const freeModel = assertFreeModel(model || FREE_MODEL);
    let data: any;
    try {
      data = await callOpenRouterFree(prompt, systemInstruction, freeModel);
    } catch (err: any) {
      console.error(`[jev error] jev_execute_free_guarded execution failed: ${err.message}`);
      throw new Error(`OpenRouter Free execution failed: ${err.message}`);
    }

    const content = data.choices?.[0]?.message?.content || '';
    const actualModel = data.model || freeModel;
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const tokensSaved = (data.usage?.total_tokens ?? 0) || (promptTokens + completionTokens);

    // Automated quality evaluation via jev_judge condition check
    const testCondition = condition || 'Is the output complete, valid, coherent, and non-empty?';
    let passed = false;
    let noulValue = 0.5;
    let confidence = 0.5;

    try {
      const judgeData = await callJevDecision(content, {
        judgment: {
          type: 'noul',
          instructions: testCondition
        }
      });
      const judgmentAnswer = judgeData.answers?.judgment;
      noulValue = typeof judgmentAnswer?.noul === 'number' ? judgmentAnswer.noul : 0.5;
      passed = noulValue >= 0.5;
      confidence = judgmentAnswer?.confidence ?? 0.85;
    } catch {
      passed = content.trim().length > 0;
      noulValue = passed ? 0.9 : 0.1;
      confidence = 0.7;
    }

    let escalated = false;
    let finalContent = content;

    if (!passed) {
      try {
        // A plain completion, not callFallbackModel: that one is a classifier and
        // answers {"choice","confidence"}, which would replace the output with JSON.
        const escalatedContent = await callRouterCompletion(prompt, systemInstruction);
        if (escalatedContent) {
          finalContent = escalatedContent;
          escalated = true;
        }
      } catch {
        // Keep original content if fallback also fails
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const endTimeIso = new Date().toISOString();
    const telemetry = {
      modelUsed: actualModel,
      passed,
      noul: noulValue,
      escalated,
      latencyMs,
      tokensSaved,
      costUsd: 0.00,
      costFormatted: '$0.00'
    };

    await logTelemetry({
      tool: 'jev_execute_free_guarded',
      ...telemetry
    });

    pushPhoenixSpan({
      name: 'jev:jev_execute_free_guarded',
      startTimeIso,
      endTimeIso,
      attributes: {
        'tool.name': 'jev_execute_free_guarded',
        'decision.passed': passed,
        'decision.noul': noulValue,
        'model.used': actualModel,
        'quota_tokens_saved': tokensSaved,
        'latency_ms': latencyMs
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content: finalContent,
          passed,
          noul: noulValue,
          confidence,
          escalated,
          modelUsed: actualModel,
          tokensSaved,
          costUsd: 0,
          latencyMs,
          telemetry
        }, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_set_mode
  // -------------------------------------------------------------
  if (name === 'jev_set_mode') {
    const { mode } = (args || {}) as { mode: string };
    if (!mode) {
      throw new Error('jev_set_mode requires "mode" ("off" | "on-demand" | "on")');
    }

    const norm = String(mode).trim().toLowerCase();
    let targetMode: JevMode;
    if (norm === 'off' || norm === 'disable') {
      targetMode = 'off';
    } else if (norm === 'on-demand' || norm === 'ondemand') {
      targetMode = 'on-demand';
    } else if (norm === 'on' || norm === 'aggressive' || norm === 'enable') {
      targetMode = 'on';
    } else {
      throw new Error(`Invalid mode "${mode}". Supported modes: "off", "on-demand", "on"`);
    }

    let cliOutput = '';
    if (fsSync.existsSync(JEV_MODE_BIN)) {
      try {
        const { stdout, stderr } = await execFileAsync(JEV_MODE_BIN, [targetMode]);
        cliOutput = (stdout + (stderr ? `\n${stderr}` : '')).trim();
      } catch (execErr: any) {
        await writeModeState(targetMode);
        cliOutput = `Direct state update fallback (binary exec error: ${execErr.message})`;
      }
    } else {
      await writeModeState(targetMode);
      cliOutput = 'Direct state update fallback (jev-mode binary not found)';
    }

    const currentState = await readCurrentMode();
    const details = getModeDetails(targetMode);

    const result = {
      mode: targetMode,
      status: 'success',
      title: details.title,
      explanation: details.explanation,
      characteristics: details.characteristics,
      stateFile: JEV_STATE_FILE,
      updatedAt: currentState.updatedAt || new Date().toISOString(),
      cliOutput
    };

    await logTelemetry({
      tool: 'jev_set_mode',
      mode: targetMode,
      status: 'success'
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_get_mode
  // -------------------------------------------------------------
  if (name === 'jev_get_mode') {
    const currentState = await readCurrentMode();
    const details = getModeDetails(currentState.mode);

    let cliStatusOutput: string | undefined = undefined;
    if (fsSync.existsSync(JEV_MODE_BIN)) {
      try {
        const { stdout } = await execFileAsync(JEV_MODE_BIN, ['status']);
        cliStatusOutput = stdout.trim();
      } catch {
        // Non-fatal status script error
      }
    }

    const result = {
      mode: currentState.mode,
      status: 'active',
      title: details.title,
      explanation: details.explanation,
      characteristics: details.characteristics,
      stateFile: JEV_STATE_FILE,
      updatedAt: currentState.updatedAt,
      cliStatus: cliStatusOutput
    };

    await logTelemetry({
      tool: 'jev_get_mode',
      mode: currentState.mode,
      status: 'success'
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_quota
  // -------------------------------------------------------------
  if (name === 'jev_quota') {
    const view = await readQuotaView();
    const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);
    const result = {
      source: view.source,
      schema: view.schema,
      stale: view.stale,
      planTier: view.plan_tier ?? null,
      activeModel: view.active_model ?? null,
      updatedAt: view.updated_at,
      strategy: view.strategy,
      thresholds: view.thresholds,
      gemini: {
        fiveHourRemainingPct: pct(view.gemini.five_hour),
        weeklyRemainingPct: pct(view.gemini.weekly),
        minRemainingPct: pct(view.gemini.min_remaining)
      },
      buckets: Object.fromEntries(
        Object.entries(view.buckets).map(([k, b]) => [k, {
          remainingPct: pct(b.remaining_fraction),
          usedPct: b.used_pct,
          resetInSeconds: b.reset_in_seconds,
          refreshed: b.refreshed
        }])
      ),
      recommendation: quotaRecommendation(view.strategy)
    };

    await logTelemetry({
      tool: 'jev_quota',
      strategy: view.strategy,
      minRemaining: view.gemini.min_remaining,
      stale: view.stale,
      source: view.source
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  // -------------------------------------------------------------
  // Tool: jev_select_model
  // -------------------------------------------------------------
  if (name === 'jev_select_model') {
    const { task, candidates, quotaStrategy } = (args || {}) as {
      task: string;
      candidates?: ModelCandidate[];
      quotaStrategy?: string;
    };
    if (!task) {
      throw new Error('jev_select_model requires "task"');
    }

    const cands = Array.isArray(candidates) && candidates.length ? candidates : DEFAULT_MODEL_CANDIDATES;
    const strategy = quotaStrategy || (await readQuotaView()).strategy;
    const selection = await selectModel(task, cands, strategy);

    await logTelemetry({
      tool: 'jev_select_model',
      recommendation: selection.recommendation,
      recommendedOptionId: selection.recommendedOptionId,
      cheapestSufficient: selection.cheapestSufficient,
      quotaStrategy: strategy,
      confidence: selection.confidence,
      fallbackUsed: selection.fallbackUsed
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(selection, null, 2)
      }]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
