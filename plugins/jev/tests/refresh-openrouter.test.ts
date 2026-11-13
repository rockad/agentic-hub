import { describe, it, expect } from 'bun:test';
import {
  MAX_ANTHROPIC_IDS,
  OPENROUTER_MODELS_URL,
  OPENROUTER_TIMEOUT_MS,
  applyPrices,
  catalogueIdFromOpenRouter,
  discoverOpenRouter,
  fetchOpenRouterPrices,
  parseOpenRouterPrices
} from '../src/refresh/openrouter.js';
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

  it('drops ids that are not plain model-id characters or are too long (the same rule as config candidates)', async () => {
    const body = {
      data: [
        { id: 'anthropic/claude-sonnet-4.5' },
        { id: 'anthropic/claude-bad; rm -rf' },
        { id: 'anthropic/claude with space' },
        { id: '--anthropic/claude-flag' },
        { id: `anthropic/${'x'.repeat(100)}` },
        { id: 'anthropic/claude-new\nline' }
      ]
    };
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(body), map: OPENCODE_MAP });
    const anthropic = out!.results.map((r) => r.id).filter((id) => id.startsWith('anthropic/'));
    expect(anthropic).toEqual(['anthropic/claude-sonnet-4.5']);
  });

  it('caps the number of ids it takes from the list', async () => {
    const data = Array.from({ length: MAX_ANTHROPIC_IDS + 50 }, (_, i) => ({ id: `anthropic/claude-m${i}` }));
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch({ data }), map: OPENCODE_MAP });
    const anthropic = out!.results.filter((r) => r.id.startsWith('anthropic/'));
    expect(anthropic.length).toBe(MAX_ANTHROPIC_IDS);
    expect(out!.notes.join(' ')).toContain('capped');
  });

  it('treats a list with no anthropic ids as a failed fetch when the previous catalogue had some', async () => {
    const previous = buildCatalogue('opencode', [{ id: 'anthropic/claude-sonnet-4.5', ok: true }, { id: 'anthropic/claude-opus-4.1', ok: true }], 'openrouter');
    const noAnthropic = { data: [{ id: 'google/gemini-2.5-pro' }, { id: 'openai/gpt-5' }] };
    expect(await discoverOpenRouter({ previous, fetch: jsonFetch(noAnthropic), map: OPENCODE_MAP })).toBeNull();
    // with no previous anthropic ids the same list is accepted
    expect(await discoverOpenRouter({ previous: null, fetch: jsonFetch(noAnthropic), map: OPENCODE_MAP })).not.toBeNull();
    const virtualOnly = buildCatalogue('opencode', [{ id: '~anthropic/claude-sonnet-latest', ok: true }, { id: 'openrouter/free', ok: true }], 'openrouter');
    expect(await discoverOpenRouter({ previous: virtualOnly, fetch: jsonFetch(noAnthropic), map: OPENCODE_MAP })).not.toBeNull();
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

// ---------------------------------------------------------------------------------------------------------------
// List prices
// ---------------------------------------------------------------------------------------------------------------

const PRICED = {
  data: [
    { id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0.0000001', completion: '0.0000005' } },
    { id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } },
    { id: 'anthropic/claude-fable-5.2', pricing: { prompt: '0.000008', completion: '0.00004' } },
    { id: 'anthropic/claude-sonnet-5.5:batch', pricing: { prompt: '0.000001', completion: '0.000005' } },
    { id: 'google/gemini-2.5-pro', pricing: { prompt: '0.000001', completion: '0.00001' } },
    { id: 'anthropic/claude-zephyr-1' }
  ]
};
const T1 = new Date('2026-11-13T10:00:00.000Z');

describe('OpenRouter id to catalogue id', () => {
  it('maps anthropic/claude-<family>-<version with dots> to the dashed catalogue id', () => {
    expect(catalogueIdFromOpenRouter('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5');
    expect(catalogueIdFromOpenRouter('anthropic/claude-haiku-5.5')).toBe('claude-haiku-5-5');
    expect(catalogueIdFromOpenRouter('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(catalogueIdFromOpenRouter('anthropic/claude-fable-5.2')).toBe('claude-fable-5-2');
    expect(catalogueIdFromOpenRouter('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
  });

  it('rejects a :batch or any other colon suffix, a non-anthropic id, a virtual id and a bad shape', () => {
    expect(catalogueIdFromOpenRouter('anthropic/claude-sonnet-5.5:batch')).toBeNull();
    expect(catalogueIdFromOpenRouter('anthropic/claude-sonnet-5.5:thinking')).toBeNull();
    expect(catalogueIdFromOpenRouter('openai/gpt-5')).toBeNull();
    expect(catalogueIdFromOpenRouter('google/gemini-2.5-pro')).toBeNull();
    expect(catalogueIdFromOpenRouter('~anthropic/claude-sonnet-latest')).toBeNull();
    expect(catalogueIdFromOpenRouter('anthropic/gpt-5')).toBeNull();
    expect(catalogueIdFromOpenRouter('anthropic/')).toBeNull();
    expect(catalogueIdFromOpenRouter('anthropic/claude-a/b')).toBeNull();
    expect(catalogueIdFromOpenRouter('anthropic/claude-bad; rm')).toBeNull();
    expect(catalogueIdFromOpenRouter(`anthropic/claude-${'x'.repeat(100)}`)).toBeNull();
    expect(catalogueIdFromOpenRouter('')).toBeNull();
    expect(catalogueIdFromOpenRouter(undefined as unknown as string)).toBeNull();
  });
});

describe('parseOpenRouterPrices', () => {
  it('converts USD per token to USD per million, keyed by the OpenRouter id and the catalogue id', () => {
    const prices = parseOpenRouterPrices(PRICED.data);
    expect(prices.get('claude-sonnet-5-5')).toEqual({ inputPerM: 2, outputPerM: 10 });
    expect(prices.get('anthropic/claude-sonnet-5.5')).toEqual({ inputPerM: 2, outputPerM: 10 });
    // no float noise from the multiplication
    expect(prices.get('claude-haiku-5-5')).toEqual({ inputPerM: 0.1, outputPerM: 0.5 });
    expect(prices.get('claude-fable-5-2')).toEqual({ inputPerM: 8, outputPerM: 40 });
  });

  it('ignores :batch, other providers, and entries with a missing, negative or unparsable price', () => {
    const prices = parseOpenRouterPrices([
      ...PRICED.data,
      { id: 'anthropic/claude-opus-4.5', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'anthropic/claude-opus-4.1', pricing: { prompt: 'abc', completion: '0.00001' } },
      { id: 'anthropic/claude-opus-4', pricing: { prompt: '0.000015' } },
      { id: 'anthropic/claude-sonnet-4', pricing: null },
      null,
      { pricing: { prompt: '1', completion: '1' } }
    ]);
    expect([...prices.keys()].some((k) => k.includes('batch'))).toBe(false);
    expect([...prices.keys()].some((k) => k.includes('gemini'))).toBe(false);
    expect(prices.has('claude-zephyr-1')).toBe(false);
    expect(prices.has('claude-opus-4-5')).toBe(false);
    expect(prices.has('claude-opus-4-1')).toBe(false);
    expect(prices.has('claude-opus-4')).toBe(false);
    expect(prices.has('claude-sonnet-4')).toBe(false);
    // the :batch variant did not overwrite the real price
    expect(prices.get('claude-sonnet-5-5')).toEqual({ inputPerM: 2, outputPerM: 10 });
  });

  it('accepts a free (0) price', () => {
    const prices = parseOpenRouterPrices([{ id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0', completion: '0' } }]);
    expect(prices.get('claude-haiku-5-5')).toEqual({ inputPerM: 0, outputPerM: 0 });
  });
});

describe('discoverOpenRouter prices', () => {
  it('returns prices for the anthropic ids it kept, under the OpenRouter id (OpenCode entries use it)', async () => {
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(PRICED), map: OPENCODE_MAP });
    expect(out!.prices!.get('anthropic/claude-sonnet-5.5')).toEqual({ inputPerM: 2, outputPerM: 10 });
    expect(out!.prices!.get('claude-opus-5')).toEqual({ inputPerM: 5, outputPerM: 25 });
    expect(out!.prices!.has('anthropic/claude-sonnet-5.5:batch')).toBe(false);
    expect(out!.prices!.has('google/gemini-2.5-pro')).toBe(false);
  });

  it('keeps pricing only for ids inside the cap', async () => {
    const data = Array.from({ length: MAX_ANTHROPIC_IDS + 5 }, (_, i) => ({ id: `anthropic/claude-m${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } }));
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch({ data }), map: OPENCODE_MAP });
    const taken = new Set(out!.results.map((r) => r.id));
    for (const k of out!.prices!.keys()) if (k.startsWith('anthropic/')) expect(taken.has(k)).toBe(true);
    expect(out!.prices!.has(`anthropic/claude-m${MAX_ANTHROPIC_IDS + 1}`)).toBe(false);
  });

  it('still discovers when the list has no pricing at all', async () => {
    const out = await discoverOpenRouter({ previous: null, fetch: jsonFetch(LIST), map: OPENCODE_MAP });
    expect(out!.results.length).toBeGreaterThan(0);
    expect(out!.prices!.size).toBe(0);
  });
});

describe('fetchOpenRouterPrices', () => {
  it('asks the public list with a timeout and returns the prices', async () => {
    let url = '';
    let signal: AbortSignal | undefined;
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      signal = init.signal as AbortSignal;
      return { ok: true, json: async () => PRICED } as unknown as Response;
    }) as unknown as typeof fetch;
    const prices = await fetchOpenRouterPrices({ fetch: f });
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(prices!.get('claude-sonnet-5-5')).toEqual({ inputPerM: 2, outputPerM: 10 });
  });

  it('returns null, never throws, on a network error, error status, bad body or timeout', async () => {
    const rejecting = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchOpenRouterPrices({ fetch: rejecting })).toBeNull();
    expect(await fetchOpenRouterPrices({ fetch: jsonFetch(PRICED, { ok: false, status: 500 }) })).toBeNull();
    expect(await fetchOpenRouterPrices({ fetch: jsonFetch({ error: 'x' }) })).toBeNull();
    const badJson = (async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchOpenRouterPrices({ fetch: badJson })).toBeNull();
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); })) as unknown as typeof fetch;
    expect(await fetchOpenRouterPrices({ fetch: hanging, timeoutMs: 30 })).toBeNull();
  });
});

describe('applyPrices', () => {
  const prices = parseOpenRouterPrices(PRICED.data);

  it('attaches price, source openrouter and the refresh time to ok entries whose id matches', () => {
    const cat = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }, { id: 'claude-opus-5', ok: true }], 'probe', null, T1);
    expect(applyPrices(cat, prices, T1)).toBe(2);
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5-5')!.price).toEqual({ inputPerM: 2, outputPerM: 10, source: 'openrouter', at: T1.toISOString() });
    expect(cat.models.find((m) => m.id === 'claude-opus-5')!.price).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it('never creates an entry: a priced model that is not in the catalogue stays out', () => {
    const cat = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }], 'probe', null, T1);
    applyPrices(cat, prices, T1);
    expect(cat.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
  });

  it('leaves entries without a match, and entries that are not ok, as they were', () => {
    const old = { inputPerM: 9, outputPerM: 9, source: 'openrouter' as const, at: '2026-11-01T00:00:00.000Z' };
    const cat = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: false }, { id: 'claude-sonnet-4-5', ok: true }, { id: 'claude-zephyr-1', ok: true }], 'probe', null, T1);
    cat.models.find((m) => m.id === 'claude-sonnet-4-5')!.price = old;
    expect(applyPrices(cat, prices, T1)).toBe(0);
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5-5')!.price).toBeUndefined(); // missing: not verified
    expect(cat.models.find((m) => m.id === 'claude-sonnet-4-5')!.price).toEqual(old); // no match: kept, not erased
    expect(cat.models.find((m) => m.id === 'claude-zephyr-1')!.price).toBeUndefined();
  });

  it('refreshes an older price when OpenRouter lists the model again', () => {
    const cat = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }], 'probe', null, T1);
    cat.models[0].price = { inputPerM: 3, outputPerM: 15, source: 'openrouter', at: '2026-11-01T00:00:00.000Z' };
    applyPrices(cat, prices, T1);
    expect(cat.models[0].price).toEqual({ inputPerM: 2, outputPerM: 10, source: 'openrouter', at: T1.toISOString() });
  });

  it('matches an OpenCode entry by its OpenRouter id', () => {
    const cat = buildCatalogue('opencode', [{ id: 'anthropic/claude-sonnet-5.5', ok: true }, { id: '~anthropic/claude-sonnet-latest', ok: true }], 'openrouter', null, T1);
    expect(applyPrices(cat, prices, T1)).toBe(1);
    expect(cat.models.find((m) => m.id === 'anthropic/claude-sonnet-5.5')!.price).toMatchObject({ inputPerM: 2 });
    expect(cat.models.find((m) => m.id === '~anthropic/claude-sonnet-latest')!.price).toBeUndefined();
  });
});
