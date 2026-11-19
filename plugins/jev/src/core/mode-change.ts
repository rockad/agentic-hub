/**
 * When the Jev mode last changed, and what that does to a denial that is still waiting for its answer.
 *
 * The mode writers (`writeModeState`, the `/jev` skill and `mcp-toggle`) stamp `modeChangedAt` (an ISO string) in
 * `~/.config/jev/config.json`: `defaults.modeChangedAt` for a change of every harness, `harnesses.<harness>.modeChangedAt`
 * for a change of one. A denial (an elevation question or a downgrade question that Jev prescribed) that was issued
 * before that time belongs to an earlier mode, and an answer to it must not approve it: the user may have answered while
 * the mode was `on-demand`, where nothing is recorded, and switched back to `on` afterwards. Every harness checks this
 * with `denialPredatesModeChange` before it approves a pending denial; the call is then denied again with a fresh
 * question, as for a first attempt.
 *
 * A config with no stamp (written before this existed) puts no restriction on anything.
 */

/** The part of a Jev config this module reads (a full `JevConfig` fits). */
export interface ModeChangeConfigLike {
  defaults?: { modeChangedAt?: unknown } | null;
  harnesses?: Record<string, { modeChangedAt?: unknown } | null | undefined> | null;
}

function stampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * The time (epoch ms) the mode last changed for `harness`, or null when no stamp is on record. A change made for every
 * harness and a change made for this one both count; the later one wins.
 */
export function modeChangedAtMs(config: ModeChangeConfigLike | null | undefined, harness?: string): number | null {
  const global = stampMs(config?.defaults?.modeChangedAt);
  const own = harness ? stampMs(config?.harnesses?.[harness]?.modeChangedAt) : null;
  if (global === null) return own;
  if (own === null) return global;
  return Math.max(global, own);
}

/**
 * True when a denial issued at `deniedAtMs` is older than the last mode change, so an answer to it must not approve it.
 * False when there is no stamp (an older config) or the denial is at or after the change.
 */
export function denialPredatesModeChange(deniedAtMs: number, config: ModeChangeConfigLike | null | undefined, harness?: string): boolean {
  const changed = modeChangedAtMs(config, harness);
  return changed !== null && Number.isFinite(deniedAtMs) && deniedAtMs < changed;
}
