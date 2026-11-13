/**
 * Antigravity discoverer, and the tier-map helpers shared with the OpenRouter discoverer.
 *
 * Antigravity has no model list to ask, so its catalogue is the configured tier map (`harnesses.antigravity.models`
 * in `src/core/config.ts`, after the user's overrides), source `static`. The names in that map (`flash_lite`,
 * `flash`, `pro`, `openrouter/free`) are not in a family the heuristic knows, so {@link applyTierMap} gives each one
 * the tier of the map key it sits under instead of leaving it `needs-review`.
 */
import { getHarnessModels, type CognitiveTier, type HarnessModelMap, type JevHarness } from '../core/config.js';
import type { Catalogue } from '../core/catalogue.js';
import type { DiscoveryOutcome } from './types.js';

const TIER_KEYS: readonly CognitiveTier[] = ['free', 'cheap', 'standard', 'deep'];

/** The map's distinct ids with the first tier each one appears under. */
export function tierMapEntries(map: HarnessModelMap): Array<{ id: string; tier: CognitiveTier }> {
  const out: Array<{ id: string; tier: CognitiveTier }> = [];
  for (const tier of TIER_KEYS) {
    const id = map?.[tier];
    if (typeof id === 'string' && id.trim() && !out.some((e) => e.id === id)) out.push({ id, tier });
  }
  return out;
}

/**
 * Give the entries the heuristic cannot rank (status `needs-review`) the tier their tier-map key says, and mark
 * them usable. Entries of a known family keep the tier the family implies. Mutates and returns `cat`.
 */
export function applyTierMap(cat: Catalogue, map: HarnessModelMap, now: Date = new Date()): Catalogue {
  const byId = new Map(tierMapEntries(map).map((e) => [e.id, e.tier] as const));
  for (const m of cat.models) {
    const tier = byId.get(m.id);
    if (!tier || m.status !== 'needs-review') continue;
    m.tier = tier;
    m.status = 'ok';
    m.strikes = 0;
    m.last_ok = now.toISOString();
  }
  return cat;
}

export interface StaticDiscoverOptions {
  /** The tier map; default is the harness's configured map. */
  map?: HarnessModelMap;
}

export function discoverStatic(harness: JevHarness | string, opts: StaticDiscoverOptions = {}): DiscoveryOutcome & { map: HarnessModelMap } {
  const map = opts.map ?? getHarnessModels(harness as JevHarness);
  const entries = tierMapEntries(map);
  return {
    source: 'static',
    results: entries.map((e) => ({ id: e.id, ok: true })),
    calls: 0,
    costUsd: 0,
    dropped: [],
    inconclusive: [],
    notes: [`built from the configured tier map of ${harness}`],
    map
  };
}
