/**
 * What each Jev mode does, in one place, for every harness.
 *
 * Every harness adapter (Claude Code, Antigravity, and any later one such as OpenCode or Codex) asks this helper instead
 * of comparing the mode to `'on'` or `'on-demand'` itself, so a mode means the same thing everywhere:
 *
 * - `off`:       nothing runs, nothing is written.
 * - `on-demand`: the MCP tools are available and telemetry rows are written. No decisions (no deny, ask, allow or
 *                overwrite, no approvals read or recorded, no attempt counted), no routing advice (no router call at
 *                prompt time, no directive, no tier advice). A short informational notice is injected only when a
 *                quota pool is low or exhausted.
 * - `on`:        everything.
 */
import type { JevMode } from './config.js';

export type QuotaNoticeMode = 'none' | 'low-only' | 'always';

export interface ModeBehaviour {
  /** The MCP tools are available. */
  tools: boolean;
  /** Hooks may deny, ask, allow with an overwrite, read or record approvals, count attempts, run downgrades and guards. */
  decisions: boolean;
  /** Prompt-time routing: the router call, the directive and any tier advice. */
  routingAdvice: boolean;
  /** Telemetry rows (prompt rows and `agent_call` rows) are written. */
  telemetry: boolean;
  /**
   * `none`: no quota text. `low-only`: the one-line informational notice, only for a low or exhausted pool.
   * `always`: the harness's full quota directives (these are advice, so only mode `on`).
   */
  quotaNotice: QuotaNoticeMode;
}

const OFF: ModeBehaviour = { tools: false, decisions: false, routingAdvice: false, telemetry: false, quotaNotice: 'none' };
const ON_DEMAND: ModeBehaviour = { tools: true, decisions: false, routingAdvice: false, telemetry: true, quotaNotice: 'low-only' };
const ON: ModeBehaviour = { tools: true, decisions: true, routingAdvice: true, telemetry: true, quotaNotice: 'always' };

/** The behaviour of a mode. An unknown value is treated as `off` (nothing runs). */
export function modeBehaviour(mode: JevMode | string | null | undefined): ModeBehaviour {
  if (mode === 'on') return ON;
  if (mode === 'on-demand') return ON_DEMAND;
  return OFF;
}

/** One quota pool as the notice needs it. */
export interface LowQuotaPool {
  /** Human label of the pool, from {@link quotaPoolLabel} or the harness's own (for example "Argon"). */
  label: string;
  strategy?: string | null;
  /** The lower of the pool's remaining fractions (0 to 1), when known. */
  minRemaining?: number | null;
}

/** The pool label every harness uses for a pool of the quota view. */
export function quotaPoolLabel(pool: { pool?: string } | null | undefined, activeModel?: string | null): string {
  return pool?.pool === '3p' ? `3p (${activeModel ?? 'non-Gemini'})` : 'Gemini';
}

/** True when the pool is conserve, free_only or at exactly 0 remaining. */
export function isLowQuotaPool(pool: Pick<LowQuotaPool, 'strategy' | 'minRemaining'>): boolean {
  return pool.strategy === 'conserve' || pool.strategy === 'free_only' || pool.minRemaining === 0;
}

/**
 * The informational quota notice of mode `on-demand`, one line, the same text in every harness. Null when the pool is
 * healthy. It carries no tier advice and asks for nothing.
 */
export function lowQuotaNotice(pool: LowQuotaPool): string | null {
  if (!isLowQuotaPool(pool)) return null;
  const state = pool.strategy === 'conserve' || pool.strategy === 'free_only' ? pool.strategy : 'exhausted';
  const pct = typeof pool.minRemaining === 'number' ? ` (${Math.round(pool.minRemaining * 100)}% remaining)` : '';
  return `[JEV] quota notice: ${pool.label} is ${state}${pct}. Informational only.`;
}
