/**
 * Shared, harness-neutral part of the downgrade choice (no I/O): the mode, the tier rating (probabilities per tier from
 * Jev's router and the tier a delegation needs), and the per-session state (questions asked and answered, cached ratings,
 * the session-off switch). The Claude Code flow (`claude/downgrade.ts`) and the Antigravity flow
 * (`antigravity/downgrade.ts`) both build on it; each keeps its own marker, question wording and answer labels.
 *
 * Everything here fails open: a malformed state or rating means "no downgrade question".
 */
import type { JevTier } from '../stage-rubric.js';
import { parseDowngradeMode, parseMinProbability, type DowngradeMode } from './downgrade-config.js';

export type { DowngradeMode };

/** A question is asked at most once per call signature in this window; an answer and a cached rating hold for the same time. */
export const DOWNGRADE_TTL_MS = 10 * 60 * 1000;

export const MAX_ENTRIES = 50;

/** The answer that switches the downgrade question off for the rest of the session. */
export const SESSION_OFF_LABEL = "No, and don't ask again this session";

/**
 * The downgrade mode: `JEV_DOWNGRADE` (`ask` | `auto` | `off`) wins, then the configured
 * `models.downgrade.mode`, then `ask`. An invalid value anywhere is ignored.
 */
export function downgradeMode(env: Record<string, string | undefined> | undefined, configured?: unknown): DowngradeMode {
  return parseDowngradeMode(env?.JEV_DOWNGRADE) ?? parseDowngradeMode(configured) ?? 'ask';
}

// ── The rating: probabilities per tier, and the tier a delegation needs ─────────

/** The tiers of Jev's tier question, cheapest first. */
export const TIER_ORDER: readonly JevTier[] = ['openrouter_free', 'flash_lite', 'flash', 'pro'];

export const DEFAULT_MIN_PROBABILITY = 0.6;
export const MIN_PROBABILITY_FLOOR = 0.5;
export const MIN_PROBABILITY_CEIL = 0.95;

/** A tier rating: Jev's choice and a probability per tier (sums to 1). `real` is false for a one-hot stand-in (the API sent no probabilities). */
export type TierRating = { choice: JevTier; p: Record<JevTier, number>; real: boolean };

export const isTier = (t: unknown): t is JevTier => typeof t === 'string' && (TIER_ORDER as readonly string[]).includes(t);

/**
 * Pure: read the `recommendedTier` answer of a Decisions API response. The per-choice `probabilities` are kept (negative or
 * non-finite values and keys that are no tier dropped, the rest normalised to sum to one); without usable ones the rating is
 * one-hot on the chosen tier. Null (fail open) when there is no valid chosen tier.
 */
export function parseTierRating(data: unknown): TierRating | null {
  try {
    const answer = (data as { answers?: { recommendedTier?: { choice?: unknown; probabilities?: unknown } } } | null)?.answers?.recommendedTier;
    const choice = answer?.choice;
    if (!isTier(choice)) return null;
    const p: Record<JevTier, number> = { openrouter_free: 0, flash_lite: 0, flash: 0, pro: 0 };
    const raw = answer?.probabilities;
    if (raw && typeof raw === 'object') {
      for (const t of TIER_ORDER) {
        const v = (raw as Record<string, unknown>)[t];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) p[t] = v;
      }
    }
    const sum = TIER_ORDER.reduce((a, t) => a + p[t], 0);
    if (sum > 0) {
      for (const t of TIER_ORDER) p[t] /= sum;
      return { choice, p, real: true };
    }
    return { choice, p: { openrouter_free: 0, flash_lite: 0, flash: 0, pro: 0, [choice]: 1 }, real: false };
  } catch {
    return null;
  }
}

/**
 * Pure: the cheapest tier whose cumulative probability (of it and every cheaper tier) reaches `minProbability`. A tie at the
 * threshold goes to the cheaper tier (a small tolerance keeps floating-point sums from flipping it). A rating whose
 * probabilities never reach the threshold needs its chosen tier.
 */
export function neededTier(rating: TierRating, minProbability: number): { tier: JevTier; cumulative: number } {
  let cumulative = 0;
  for (const t of TIER_ORDER) {
    cumulative += rating.p[t];
    if (cumulative + 1e-9 >= minProbability) return { tier: t, cumulative: Math.min(1, cumulative) };
  }
  return { tier: rating.choice, cumulative: Math.min(1, cumulative) };
}

/**
 * The threshold: `JEV_DOWNGRADE_MIN_PROBABILITY`, then the configured `models.downgrade.minProbability`, then 0.6. A number
 * outside 0.5..0.95 is clamped; anything that is not a number is ignored (the next source applies).
 */
export function resolveMinProbability(env: Record<string, string | undefined> | undefined, configured?: unknown): number {
  const n = parseMinProbability(env?.JEV_DOWNGRADE_MIN_PROBABILITY) ?? parseMinProbability(configured) ?? DEFAULT_MIN_PROBABILITY;
  return Math.min(MIN_PROBABILITY_CEIL, Math.max(MIN_PROBABILITY_FLOOR, n));
}

// ── State: asked and answered, ratings, session-off; per session ────────────

/** One question asked or answered. `signature` is null for an answer that no recorded question matched (it covers that `from` for the window). */
export type DowngradeEntry = {
  kind: 'downgrade';
  /** The needed alias the question was about; `*` for an answer that covers every delegation (a No to the elevation question). */
  from: string;
  answered: boolean;
  signature: string | null;
  chosen?: string;
  asked_at?: number;
  expires_at: number;
};

/** A tier rating kept for one call signature, so a retry does not call the router again. */
export type StoredRating = { signature: string; choice: JevTier; p: [number, number, number, number]; real: boolean; expires_at: number };

export type DowngradeState = {
  entries: DowngradeEntry[];
  ratings?: StoredRating[];
  /** Set by the fourth answer: nothing is evaluated for the rest of the session. */
  off?: { at: number };
};
export type DowngradeClaim = 'first' | 'asked' | 'answered';

/** Pure: read a state object of unknown shape into a clean one (a corrupt file gives an empty state; an old file has entries only). */
export function normalizeDowngradeState(raw: unknown): DowngradeState {
  const r = raw as { entries?: unknown; ratings?: unknown; off?: unknown } | null;
  const list = r?.entries;
  const entries = Array.isArray(list)
    ? list.filter((e): e is DowngradeEntry => {
        const x = e as Partial<DowngradeEntry> | null;
        return (
          !!x &&
          x.kind === 'downgrade' &&
          typeof x.from === 'string' &&
          typeof x.answered === 'boolean' &&
          (x.signature === null || typeof x.signature === 'string') &&
          typeof x.expires_at === 'number' &&
          Number.isFinite(x.expires_at)
        );
      })
    : [];
  const ratings = Array.isArray(r?.ratings)
    ? (r!.ratings as unknown[]).filter((e): e is StoredRating => {
        const x = e as Partial<StoredRating> | null;
        return (
          !!x &&
          typeof x.signature === 'string' &&
          isTier(x.choice) &&
          Array.isArray(x.p) &&
          x.p.length === 4 &&
          x.p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) &&
          typeof x.real === 'boolean' &&
          typeof x.expires_at === 'number' &&
          Number.isFinite(x.expires_at)
        );
      })
    : [];
  const at = (r?.off as { at?: unknown } | null | undefined)?.at;
  return {
    entries,
    ...(ratings.length > 0 ? { ratings } : {}),
    ...(typeof at === 'number' && Number.isFinite(at) ? { off: { at } } : {})
  };
}

export const live = (state: DowngradeState, nowMs: number): DowngradeEntry[] => state.entries.filter((e) => e.expires_at > nowMs);
export const liveRatings = (state: DowngradeState, nowMs: number): StoredRating[] => (state.ratings ?? []).filter((e) => e.expires_at > nowMs);
export const withRatings = (state: DowngradeState, entries: DowngradeEntry[], nowMs: number): DowngradeState => {
  const ratings = liveRatings(state, nowMs);
  return { entries, ...(ratings.length > 0 ? { ratings } : {}), ...(state.off ? { off: state.off } : {}) };
};

/** Whether the user switched the downgrade question off for this session (the fourth answer). */
export function downgradeOff(state: DowngradeState): boolean {
  return !!state.off;
}

/** Pure: keep the rating of a call signature for the window (a second rating of the same signature replaces the first). */
export function rememberRating(state: DowngradeState, signature: string, rating: TierRating, nowMs: number): DowngradeState {
  const p = TIER_ORDER.map((t) => rating.p[t]) as [number, number, number, number];
  const stored: StoredRating = { signature, choice: rating.choice, p, real: rating.real, expires_at: nowMs + DOWNGRADE_TTL_MS };
  const ratings = [...liveRatings(state, nowMs).filter((r) => r.signature !== signature), stored].slice(-MAX_ENTRIES);
  return { entries: live(state, nowMs), ratings, ...(state.off ? { off: state.off } : {}) };
}

/** Pure: the rating kept for this call signature, or null (none, or older than the window). */
export function findRating(state: DowngradeState, signature: string, nowMs: number): TierRating | null {
  const r = liveRatings(state, nowMs).find((x) => x.signature === signature);
  if (!r) return null;
  const p = { openrouter_free: r.p[0], flash_lite: r.p[1], flash: r.p[2], pro: r.p[3] };
  return { choice: r.choice, p, real: r.real };
}

const answeredFor = (e: DowngradeEntry, signature: string): boolean => e.answered && (e.signature === signature || (e.signature === null && e.from === '*'));

/**
 * Pure, read-only: what is on record for a call before it is rated. `off` is the session switch; `answered` is an answer
 * for this signature (or a No to the elevation question, which covers every delegation for the window); `asked` is a
 * question for this signature that was not answered; `rating` is a rating kept within the window.
 */
export function peekDowngrade(
  state: DowngradeState,
  signature: string,
  nowMs: number
): { off: boolean; answered: boolean; asked: boolean; rating: TierRating | null } {
  const entries = live(state, nowMs);
  const answered = entries.some((e) => answeredFor(e, signature));
  return {
    off: downgradeOff(state),
    answered,
    asked: !answered && entries.some((e) => !e.answered && e.signature === signature),
    rating: findRating(state, signature, nowMs)
  };
}

/**
 * Pure: what the hook does with a call whose signature is `signature` and whose needed alias is `from`.
 *   `answered`  the user answered a downgrade question for this signature (or for this alias, with no signature on
 *               record, or for every delegation): let it through.
 *   `asked`     a question for this signature was already asked in the window and not answered: ask no second time.
 *   `first`     nothing on record: ask. With `record` the question is written down so the next call finds it.
 * Expired entries are dropped.
 */
export function claimDowngrade(
  state: DowngradeState,
  signature: string,
  from: string,
  nowMs: number,
  record: boolean
): { state: DowngradeState; result: DowngradeClaim } {
  const entries = live(state, nowMs);
  if (entries.some((e) => answeredFor(e, signature) || (e.answered && e.signature === null && e.from === from))) {
    return { state: withRatings(state, entries, nowMs), result: 'answered' };
  }
  if (entries.some((e) => !e.answered && e.signature === signature)) return { state: withRatings(state, entries, nowMs), result: 'asked' };
  if (!record) return { state: withRatings(state, entries, nowMs), result: 'first' };
  const added: DowngradeEntry = { kind: 'downgrade', from, answered: false, signature, asked_at: nowMs, expires_at: nowMs + DOWNGRADE_TTL_MS };
  return { state: withRatings(state, [...entries, added].slice(-MAX_ENTRIES), nowMs), result: 'first' };
}


/**
 * Pure: drop the questions that are still waiting for an answer and were asked at a time `stale` rejects (a question
 * that predates the last mode change, see `denialPredatesModeChange`). Answered entries and ratings are kept. With no
 * such question the state is returned as it is and `voided` is 0, so a caller writes only when something changed. The
 * next call for the delegation is then asked afresh, as for a first attempt, and an answer to the old question finds
 * nothing pending.
 */
export function voidStalePending(state: DowngradeState, stale: (askedAtMs: number) => boolean): { state: DowngradeState; voided: number } {
  const entries = state.entries.filter((e) => !(!e.answered && typeof e.asked_at === 'number' && stale(e.asked_at)));
  const voided = state.entries.length - entries.length;
  return voided === 0 ? { state, voided: 0 } : { state: { ...state, entries }, voided };
}
