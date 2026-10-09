import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadJevConfigSync,
  getHarnessConfig,
  readJevMode,
  evaluateLocalHeuristic,
  getCachedDecision,
  setCachedDecision,
  JEV_CACHE_FILE
} from '../src/shared.ts';
import { initTracing, getTracer } from '../src/tracing.ts';
import { applyModelSwap, describeLanguageEvent } from '../opencode/swap.ts';

describe('Consolidated Master Plan: Phase 1 (Unified Config & Harness Scoping)', () => {
  it('loads default configuration when config file is minimal', () => {
    const cfg = loadJevConfigSync();
    expect(cfg.version).toBeNumber();
    expect(cfg.defaults).toBeDefined();
    expect(cfg.defaults.mode).toBeDefined();
  });

  it('provides independent per-harness configurations', () => {
    const agyCfg = getHarnessConfig('antigravity');
    const ocCfg = getHarnessConfig('opencode');
    const ccCfg = getHarnessConfig('claude-code');

    expect(agyCfg.mode).toBeDefined();
    expect(ocCfg.mode).toBeDefined();
    expect(ccCfg.mode).toBeDefined();
  });

  it('reads harness mode accurately', async () => {
    const ocMode = await readJevMode('opencode');
    expect(['off', 'on-demand', 'on']).toContain(ocMode);
  });
});

describe('Consolidated Master Plan: Phase 2 (Latency Optimization & Caching)', () => {
  it('evaluates local complexity heuristic for short formatting tasks (<40 tokens)', () => {
    const heuristic = evaluateLocalHeuristic('format JSON indent 2');
    expect(heuristic).not.toBeNull();
    expect(heuristic?.route).toBe('openrouter_free');
    expect(heuristic?.tier).toBe('openrouter_free');
    expect(heuristic?.effort).toBe('low');
  });

  it('returns null for non-mechanical or complex tasks', () => {
    const heuristic = evaluateLocalHeuristic('architect a multi-tenant distributed consensus database');
    expect(heuristic).toBeNull();
  });

  it('stores and retrieves decisions from the atomic cache', () => {
    const testHash = `test-hash-${Date.now()}`;
    const testData = { choice: 'code_engineer', confidence: 0.95 };

    setCachedDecision(testHash, testData);
    const cached = getCachedDecision(testHash);
    expect(cached).toEqual(testData);
  });
});

describe('Consolidated Master Plan: Phase 4 (Non-Obtrusive OTEL Tracing)', () => {
  it('defaults to NoopTracer with zero overhead when OTEL is inactive', async () => {
    delete process.env.JEV_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    const tracer = await initTracing();
    expect(tracer).toBeDefined();

    const span = tracer.startSpan('test-span', { 'test.attr': 'val' });
    expect(span).toBeDefined();
    expect(() => span.setAttribute('key', 123)).not.toThrow();
    expect(() => span.setError(new Error('test'))).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});

describe('Consolidated Master Plan: OpenCode Cross-Provider Normalization', () => {
  it('normalizes target provider to openrouter format when swapping across providers', () => {
    const mockSdk = {
      languageModel: (id: string) => ({ id })
    };
    const mockEvent: any = {
      sdk: mockSdk,
      model: { providerID: 'anthropic', id: 'claude-3-5-sonnet' },
      language: null
    };

    const res = applyModelSwap(mockEvent, 'openrouter/google/gemini-flash');
    expect(res.ok).toBe(true);
    expect(mockEvent.language.id).toBe('openrouter/google/gemini-flash');
  });
});

describe('Consolidated Master Plan: Unified Telemetry Logging', () => {
  it('logs telemetry events conforming to JevTelemetryEvent', async () => {
    const { logJevTelemetry, JEV_TELEMETRY_FILE } = await import('../src/shared.ts');
    const testSession = `test-session-${Date.now()}`;

    await logJevTelemetry({
      harness: 'antigravity',
      toolOrHook: 'test_tool',
      sessionId: testSession,
      taskSummary: 'Test telemetry logging',
      tierRecommended: 'flash',
      modelUsed: 'gemini-3.8-flash',
      tokensSaved: 100,
      costUsd: 0.0,
      quotaStrategy: 'normal'
    });

    expect(fs.existsSync(JEV_TELEMETRY_FILE)).toBe(true);
    const content = fs.readFileSync(JEV_TELEMETRY_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);

    expect(lastEntry.harness).toBe('antigravity');
    expect(lastEntry.toolOrHook).toBe('test_tool');
    expect(lastEntry.sessionId).toBe(testSession);
    expect(lastEntry.tierRecommended).toBe('flash');
    expect(lastEntry.quotaStrategy).toBe('normal');
  });
});

