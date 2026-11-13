/**
 * OpenRouter discoverer (OpenCode): the public model list, no key needed.
 *
 * Reads `GET https://openrouter.ai/api/v1/models` and reports every `anthropic/*` id as available, together with
 * the ids already in the harness's tier map. Ids in the tier map that the list never shows (`~anthropic/...-latest`
 * and `openrouter/free` are resolved by OpenRouter itself) are taken as configured. An id the previous catalogue had
 * that is no longer listed is reported as failed, so the strikes rule retires it.
 *
 * Never throws; on any failure (network, timeout, bad status, unreadable body, empty list) it returns null and the
 * previous catalogue stays as it was.
 */
import { getHarnessModels, type HarnessModelMap, type JevHarness } from '../core/config.js';
import type { Catalogue, ProbeResult } from '../core/catalogue.js';
import { tierMapEntries } from './static.js';
import type { DiscoveryOutcome } from './types.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_TIMEOUT_MS = 10_000;

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
    for (const m of data) if (m && typeof m.id === 'string' && m.id.trim()) listed.add(m.id.trim());
    if (listed.size === 0) return null;

    const map = opts.map ?? getHarnessModels((opts.harness ?? 'opencode') as JevHarness);
    const results: ProbeResult[] = [];
    const seen = new Set<string>();
    const add = (id: string, ok: boolean): void => {
      if (seen.has(id)) return;
      seen.add(id);
      results.push({ id, ok });
    };
    for (const id of listed) if (isAnthropic(id)) add(id, true);
    for (const { id } of tierMapEntries(map)) {
      if (listed.has(id) || isVirtual(id)) add(id, true);
    }
    const notes: string[] = [`${listed.size} models listed, ${results.length} taken`];
    for (const m of opts.previous?.models ?? []) {
      if (seen.has(m.id) || isVirtual(m.id)) continue;
      if (!listed.has(m.id)) add(m.id, false);
    }
    return { source: 'openrouter', results, calls: 0, costUsd: 0, dropped: [], inconclusive: [], notes };
  } catch {
    return null;
  }
}
