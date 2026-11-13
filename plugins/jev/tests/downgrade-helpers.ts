/**
 * Shared fixtures of the downgrade tests: the nine ladder models of the live catalogue with their list prices, tier ratings
 * with exact probabilities, and an in-memory stand-in for the downgrade store.
 */
import { buildCatalogue } from '../src/core/catalogue.ts';
import {
  TIER_ORDER,
  answerDowngrade,
  claimDowngrade,
  normalizeDowngradeState,
  peekDowngrade,
  rememberRating,
  type TierRating
} from '../claude/downgrade.ts';
import type { DowngradeStore } from '../claude/hook.ts';
import type { RankContext } from '../claude/logic.ts';

/** USD per million input/output tokens, as the live catalogue stores them. */
export const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-5': [3, 15],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-fable-5-2': [8, 40]
};
const ALIAS: Record<string, string> = { 'claude-haiku-5-5': 'haiku', 'claude-sonnet-5-5': 'sonnet', 'claude-opus-5-5': 'opus', 'claude-fable-5-2': 'fable' };

/** A catalogue of the nine ladder models; `prices` gives each id its price (null or absent: none). */
export function catalogue(prices: Record<string, [number, number] | null> = PRICES): RankContext {
  const cat = buildCatalogue(
    'claude-code',
    Object.keys(PRICES).map((id) => ({ id, ok: true, ...(ALIAS[id] ? { alias: ALIAS[id] } : {}) })),
    'probe',
    null,
    new Date('2026-11-12T10:00:00.000Z')
  );
  cat.models = cat.models.map((m) => {
    const p = prices[m.id];
    return p ? { ...m, price: { inputPerM: p[0], outputPerM: p[1], source: 'openrouter' as const, at: '2026-11-12T10:00:00.000Z' } } : m;
  });
  return { cat };
}

/** A rating whose probabilities are exactly `p` (free, flash_lite, flash, pro). */
export function rating(p: [number, number, number, number], real = true): TierRating {
  const best = p.indexOf(Math.max(...p));
  return { choice: TIER_ORDER[best], p: { openrouter_free: p[0], flash_lite: p[1], flash: p[2], pro: p[3] }, real };
}
export const HAIKU = rating([0.03, 0.83, 0.14, 0]);
export const SONNET = rating([0.07, 0.08, 0.85, 0]);
export const OPUS = rating([0, 0.02, 0.18, 0.8]);

/** An in-memory stand-in for the downgrade store, built on the same pure functions the live store runs under its lock. */
export function memoryDowngrades(): DowngradeStore & { states: Map<string, ReturnType<typeof normalizeDowngradeState>> } {
  const states = new Map<string, ReturnType<typeof normalizeDowngradeState>>();
  const get = (s: string) => states.get(s) ?? { entries: [] };
  return {
    states,
    peek: (s, sig, nowMs) => peekDowngrade(get(s), sig, nowMs),
    remember: (s, sig, r, nowMs) => void states.set(s, rememberRating(get(s), sig, r, nowMs)),
    claim: (s, sig, from, nowMs, opts) => {
      const { state, result } = claimDowngrade(get(s), sig, from, nowMs, opts.record);
      if (opts.record) states.set(s, state);
      return result;
    },
    answer: (s, from, chosen, nowMs) => void states.set(s, answerDowngrade(get(s), from, chosen, nowMs))
  };
}
