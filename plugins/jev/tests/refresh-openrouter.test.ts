import { describe, it, expect } from 'bun:test';
import { OPENROUTER_MODELS_URL, OPENROUTER_TIMEOUT_MS, discoverOpenRouter } from '../src/refresh/openrouter.js';
import { applyTierMap, discoverStatic, tierMapEntries } from '../src/refresh/static.js';
import { buildCatalogue, ladder } from '../src/core/catalogue.js';
import { DEFAULT_JEV_CONFIG, type HarnessModelMap } from '../src/core/config.js';

const OPENCODE_MAP = DEFAULT_JEV_CONFIG.harnesses!.opencode!.models as HarnessModelMap;
const ANTIGRAVITY_MAP = DEFAULT_JEV_CONFIG.harnesses!.antigravity!.models as HarnessModelMap;

const LIST = {
  data: [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    { id: 'anthropic/claude-opus-4.1' },
    { id: 'anthropic/claude-haiku-4.5' },
    { id: 'anthropic/claude-zephyr-1' },
    { id: 'google/gemini-2.5-pro' },
    { id: 'openai/gpt-5' }
  ]
};

const jsonFetch = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
  (async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

describe('OpenRouter discoverer', () => {
  it('asks the public list with a 10 second timeout', async () => {
    let url = '';
    let signal: AbortSignal | undefined;
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      signal = init.signal as AbortSignal;
      return { ok: true, json: async () => LIST } as unknown as Response;
    }) as unknown as typeof fetch;
    await discoverOpenRouter({ previous: null, fetch: f, map: OPENCODE_MAP });
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect(OPENROUTER_MODELS_URL).toBe(url);
    expect(OPENROUTER_TIMEOUT_MS).toBe(10_000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('maps every anthropic id, and the configured tier-map ids, to ok results with source openrouter', async () => {
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(LIST), map: OPENCODE_MAP });
    expect(out!.source).toBe('openrouter');
    const ids = out!.results.map((r) => r.id);
    expect(ids).toContain('anthropic/claude-sonnet-4.5');
    expect(ids).toContain('anthropic/claude-opus-4.1');
    expect(ids).toContain('anthropic/claude-zephyr-1');
    expect(ids).not.toContain('google/gemini-2.5-pro');
    expect(ids).not.toContain('openai/gpt-5');
    // the "latest" names and the free pool are resolved by OpenRouter and never listed: taken as configured
    expect(ids).toContain('~anthropic/claude-sonnet-latest');
    expect(ids).toContain('openrouter/free');
    expect(out!.results.every((r) => r.ok)).toBe(true);
  });

  it('takes a tier-map id that is in the list, and ignores other providers', async () => {
    const map: HarnessModelMap = { ...OPENCODE_MAP, cheap: 'google/gemini-2.5-pro' };
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(LIST), map });
    expect(out!.results.map((r) => r.id)).toContain('google/gemini-2.5-pro');
  });

  it('reports an id the previous catalogue had that is no longer listed as failed', async () => {
    const previous = buildCatalogue('opencode', [{ id: 'anthropic/claude-3-opus', ok: true }, { id: 'anthropic/claude-sonnet-4.5', ok: true }], 'openrouter');
    const out = await discoverOpenRouter({ previous, fetch: jsonFetch(LIST), map: OPENCODE_MAP });
    expect(out!.results).toContainEqual({ id: 'anthropic/claude-3-opus', ok: false });
    expect(out!.results).toContainEqual({ id: 'anthropic/claude-sonnet-4.5', ok: true });
  });

  it('returns null, not an error, when the request fails', async () => {
    const rejecting = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await discoverOpenRouter({ previous: null, fetch: rejecting, map: OPENCODE_MAP })).toBeNull();
  });

  it('returns null on an error status, a non-JSON body, a body without data and an empty list', async () => {
    expect(await discoverOpenRouter({ previous: null, fetch: jsonFetch(LIST, { ok: false, status: 503 }), map: OPENCODE_MAP })).toBeNull();
    const badJson = (async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response) as unknown as typeof fetch;
    expect(await discoverOpenRouter({ previous: null, fetch: badJson, map: OPENCODE_MAP })).toBeNull();
    expect(await discoverOpenRouter({ previous: null, fetch: jsonFetch({ error: 'x' }), map: OPENCODE_MAP })).toBeNull();
    expect(await discoverOpenRouter({ previous: null, fetch: jsonFetch({ data: [] }), map: OPENCODE_MAP })).toBeNull();
  });

  it('returns null when the request times out', async () => {
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const start = performance.now();
    expect(await discoverOpenRouter({ previous: null, fetch: hanging, timeoutMs: 30, map: OPENCODE_MAP })).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('builds a catalogue the ladder can use: anthropic ids by family and version, the rest by tier map', async () => {
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(LIST), map: OPENCODE_MAP });
    const cat = applyTierMap(buildCatalogue('opencode', out!.results, out!.source, null), OPENCODE_MAP);
    expect(ladder(cat, 'standard')[0]).toBe('~anthropic/claude-sonnet-latest');
    expect(ladder(cat, 'standard')).toContain('anthropic/claude-sonnet-4.5');
    expect(ladder(cat, 'deep')).toContain('anthropic/claude-opus-4.1');
    expect(ladder(cat, 'free')).toEqual(['openrouter/free']);
    // an unknown family stays out of the ladder until reviewed
    expect(cat.models.find((m) => m.id === 'anthropic/claude-zephyr-1')?.status).toBe('needs-review');
  });
});

describe('static discoverer (Antigravity)', () => {
  it('reports every distinct id of the tier map with source static', () => {
    const out = discoverStatic('antigravity', { map: ANTIGRAVITY_MAP });
    expect(out.source).toBe('static');
    expect(out.calls).toBe(0);
    expect(out.results).toEqual([
      { id: 'openrouter/free', ok: true },
      { id: 'flash_lite', ok: true },
      { id: 'flash', ok: true },
      { id: 'pro', ok: true }
    ]);
  });

  it('keeps one entry for an id the map uses for two tiers', () => {
    const map: HarnessModelMap = { free: 'a/free', cheap: 'x', standard: 'typesafe/jev-router', deep: 'typesafe/jev-router' };
    expect(tierMapEntries(map)).toEqual([
      { id: 'a/free', tier: 'free' },
      { id: 'x', tier: 'cheap' },
      { id: 'typesafe/jev-router', tier: 'standard' }
    ]);
  });

  it('gives ids the heuristic cannot rank the tier of their map key, so the ladder uses them', () => {
    const out = discoverStatic('antigravity', { map: ANTIGRAVITY_MAP });
    const cat = applyTierMap(buildCatalogue('antigravity', out.results, out.source, null), ANTIGRAVITY_MAP);
    expect(ladder(cat, 'free')).toEqual(['openrouter/free']);
    expect(ladder(cat, 'cheap')).toEqual(['flash_lite']);
    expect(ladder(cat, 'standard')).toEqual(['flash']);
    expect(ladder(cat, 'deep')).toEqual(['pro']);
  });

  it('leaves the family tier alone for an id the heuristic does rank', () => {
    const map: HarnessModelMap = { ...ANTIGRAVITY_MAP, cheap: 'claude-sonnet-5' };
    const cat = applyTierMap(buildCatalogue('antigravity', discoverStatic('antigravity', { map }).results, 'static', null), map);
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5')?.tier).toBe('standard');
  });
});
