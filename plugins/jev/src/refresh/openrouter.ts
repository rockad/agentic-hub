/**
 * OpenRouter discoverer (OpenCode): the public model list, no key needed.
 *
 * Reads `GET https://openrouter.ai/api/v1/models` and reports every `anthropic/*` id as available, together with
 * the ids already in the harness's tier map. Ids in the tier map that the list never shows (`~anthropic/...-latest`
 * and `openrouter/free` are resolved by OpenRouter itself) are taken as configured. An id the previous catalogue had
 * that is no longer listed is reported as failed, so the strikes rule retires it.
 *
 * The same list carries list prices (`pricing.prompt` and `pricing.completion`, USD per token as strings). They are
 * read here for the ids kept, and {@link fetchOpenRouterPrices} reads them alone for the Claude Code refresh, whose
 * models come from probes. {@link applyPrices} attaches them to catalogue entries; prices are never fetched at hook
 * time.
 *
 * Never throws; on any failure (network, timeout, bad status, unreadable body, empty list) it returns null and the
 * previous catalogue stays as it was.
 */
import { getHarnessModels, type HarnessModelMap, type JevHarness } from '../core/config.js';
import type { Catalogue, ProbeResult } from '../core/catalogue.js';
import { MODEL_ID_PATTERN } from './config.js';
import { tierMapEntries } from './static.js';
import type { DiscoveryOutcome, OpenRouterPrices } from './types.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_TIMEOUT_MS = 10_000;
/** The most `anthropic/*` ids taken from one list (the real list has a few dozen). */
export const MAX_ANTHROPIC_IDS = 200;

export interface OpenRouterDiscoverOptions {
  previous: Catalogue | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The tier map; default is the harness's configured map. */
  map?: HarnessModelMap;
  harness?: JevHarness | string;
}

const isAnthropic = (id: string): boolean => /^~?anthropic\//i.test(id);
/** Ids OpenRouter resolves itself and never lists. */
const isVirtual = (id: string): boolean => id.startsWith('~') || id.toLowerCase().startsWith('openrouter/');

// ---------------------------------------------------------------------------------------------------------------
// List prices
// ---------------------------------------------------------------------------------------------------------------

/**
 * Catalogue id for an OpenRouter id: `anthropic/claude-sonnet-5.5` is `claude-sonnet-5-5` (dots become dashes).
 * Null for anything else: another provider, a `~` virtual id, a variant with a `:` suffix (`:batch`, `:thinking`,
 * `:free`; a variant is a different product and its price must not stand in for the base model's), a nested path,
 * or an id that fails {@link MODEL_ID_PATTERN}.
 */
export function catalogueIdFromOpenRouter(id: string): string | null {
  if (typeof id !== 'string') return null;
  const m = /^anthropic\/(claude-[^/:]+)$/.exec(id.trim());
  if (!m) return null;
  const mapped = m[1].replace(/\./g, '-');
  return MODEL_ID_PATTERN.test(m[1]) && MODEL_ID_PATTERN.test(mapped) ? mapped : null;
}

/** USD per token (a string such as `0.000002`) to USD per million tokens, without float noise. Null unless a finite number >= 0. */
function perMillion(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toFixed(6));
}

/**
 * Prices from the `data` array of the OpenRouter list, for `anthropic/*` ids only. Each priced model is stored under
 * its OpenRouter id (OpenCode catalogue entries use it) and under its catalogue id (Claude Code entries use it).
 * Entries with a `:` variant suffix, no pricing, a negative price (OpenRouter uses -1 for "varies") or an unreadable
 * one are skipped. `keep` limits the result to those OpenRouter ids. Never throws.
 */
export function parseOpenRouterPrices(data: unknown, keep?: ReadonlySet<string>): OpenRouterPrices {
  const out: OpenRouterPrices = new Map();
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    try {
      const id = typeof m?.id === 'string' ? m.id.trim() : '';
      const cid = catalogueIdFromOpenRouter(id);
      if (!cid || (keep && !keep.has(id))) continue;
      const inputPerM = perMillion(m?.pricing?.prompt);
      const outputPerM = perMillion(m?.pricing?.completion);
      if (inputPerM === null || outputPerM === null) continue;
      out.set(id, { inputPerM, outputPerM });
      out.set(cid, { inputPerM, outputPerM });
    } catch {
      // one odd row never costs the others
    }
  }
  return out;
}

/**
 * Read only the prices from the public list. Used by the Claude Code refresh, whose models come from probes. Returns
 * null on any failure (network, timeout, status, body), so the caller keeps the previous prices. At most
 * {@link MAX_ANTHROPIC_IDS} anthropic ids are read. Never throws.
 */
export async function fetchOpenRouterPrices(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OpenRouterPrices | null> {
  try {
    const res = await (opts.fetch ?? fetch)(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? OPENROUTER_TIMEOUT_MS)
    });
    if (!res || !res.ok) return null;
    const body: any = await res.json();
    if (!Array.isArray(body?.data)) return null;
    const anthropic = body.data.filter((m: any) => typeof m?.id === 'string' && isAnthropic(m.id.trim()) && MODEL_ID_PATTERN.test(m.id.trim()));
    return parseOpenRouterPrices(anthropic.slice(0, MAX_ANTHROPIC_IDS));
  } catch {
    return null;
  }
}

/**
 * Attach list prices to the catalogue entries that match: `status` `ok` (the probe or list verified it) and an id
 * found in `prices`. `at` is `now`. An entry with no match keeps whatever price it had; an id in `prices` that is not
 * in the catalogue is ignored, so a price never creates an entry. Mutates `cat`; returns how many entries got a price.
 */
export function applyPrices(cat: Catalogue, prices: OpenRouterPrices, now: Date = new Date()): number {
  let n = 0;
  for (const m of cat.models) {
    if (m.status !== 'ok') continue;
    const p = prices.get(m.id);
    if (!p) continue;
    m.price = { inputPerM: p.inputPerM, outputPerM: p.outputPerM, source: 'openrouter', at: now.toISOString() };
    n++;
  }
  return n;
}

export async function discoverOpenRouter(opts: OpenRouterDiscoverOptions): Promise<DiscoveryOutcome | null> {
  try {
    const doFetch = opts.fetch ?? fetch;
    const res = await doFetch(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? OPENROUTER_TIMEOUT_MS)
    });
    if (!res || !res.ok) return null;
    const body: any = await res.json();
    const data = Array.isArray(body?.data) ? body.data : null;
    if (!data) return null;
    const listed = new Set<string>();
    for (const m of data) {
      if (!m || typeof m.id !== 'string') continue;
      const id = m.id.trim();
      // the same rule as config candidates: plain model-id characters, bounded length
      if (MODEL_ID_PATTERN.test(id)) listed.add(id);
    }
    if (listed.size === 0) return null;
    const listedAnthropic = [...listed].filter(isAnthropic);
    // A list with no anthropic id at all, when the last catalogue had some, is a bad fetch (a changed or partial
    // response), not news that every model is gone.
    const hadAnthropic = (opts.previous?.models ?? []).some((m) => isAnthropic(m.id) && !isVirtual(m.id));
    if (listedAnthropic.length === 0 && hadAnthropic) return null;

    const map = opts.map ?? getHarnessModels((opts.harness ?? 'opencode') as JevHarness);
    const results: ProbeResult[] = [];
    const seen = new Set<string>();
    const add = (id: string, ok: boolean): void => {
      if (seen.has(id)) return;
      seen.add(id);
      results.push({ id, ok });
    };
    for (const id of listedAnthropic.slice(0, MAX_ANTHROPIC_IDS)) add(id, true);
    for (const { id } of tierMapEntries(map)) {
      if (listed.has(id) || isVirtual(id)) add(id, true);
    }
    const notes: string[] = [`${listed.size} models listed, ${results.length} taken`];
    if (listedAnthropic.length > MAX_ANTHROPIC_IDS) notes.push(`anthropic ids capped at ${MAX_ANTHROPIC_IDS} of ${listedAnthropic.length}`);
    for (const m of opts.previous?.models ?? []) {
      if (seen.has(m.id) || isVirtual(m.id)) continue;
      if (!listed.has(m.id)) add(m.id, false);
    }
    const prices = parseOpenRouterPrices(data, new Set(results.filter((r) => r.ok).map((r) => r.id)));
    return { source: 'openrouter', results, calls: 0, costUsd: 0, dropped: [], inconclusive: [], notes, prices };
  } catch {
    return null;
  }
}
