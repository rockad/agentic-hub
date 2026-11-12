/**
 * Shared helpers for the parity-*.test.ts files (cognitive-engine PR #22 spec ported onto agentic-hub 2.3.2).
 * Not a test file. Adapts #22's parseUserIntent shape ({model, cost, phrase}) to agentic-hub's
 * ({models[], cost}) so the ported cases assert the same observable behaviour.
 */
import { namedModel, parseUserIntent, type Dispatch } from '../claude/logic.ts';
import type { HookDeps, HookInput } from '../claude/hook.ts';

export const SESSION = 'claude-sonnet-5-5';
export const flashRec: Dispatch = { subagent: 'Explore', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
export const proRec: Dispatch = { subagent: 'general-purpose', tier: 'pro', model: 'opus', effort: 'high', confidence: 0.8 };
export const liteRec: Dispatch = { subagent: 'Explore', tier: 'flash_lite', model: 'haiku', effort: 'low', confidence: 0.9 };
export const selfLite: Dispatch = { subagent: 'self', tier: 'flash_lite', model: 'haiku', effort: 'low', confidence: 0.9 };

export function deps(overrides: Partial<HookDeps> = {}): HookDeps {
  return {
    readMode: async () => 'on',
    readSessionModel: () => SESSION,
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: () => {},
    ...overrides
  };
}

/** #22's `parseUserIntent(p).model`: the one model named, or undefined. */
export const modelOf = (prompt: string): string | undefined => namedModel(parseUserIntent(prompt)) ?? undefined;
/** #22's `parseUserIntent(p).cost`. */
export const costOf = (prompt: string): string | undefined => parseUserIntent(prompt).cost;

export const context = (out: { hookSpecificOutput: Record<string, unknown> } | null): string => String(out?.hookSpecificOutput?.additionalContext);

/** In-memory replacement for the per-session turn file. */
export function memoryTurnStore() {
  const store: { state: any } = { state: null };
  return {
    store,
    readTurn: () => store.state,
    saveTurn: (_s: string | null, state: any) => {
      store.state = state;
    }
  };
}

export const input = (prompt: string, extra: Partial<HookInput> = {}): HookInput => ({ session_id: 's1', prompt, ...extra });

/** The rubric text exactly as #22's stage-rubric.ts defines it. */
export const RUBRIC = {
  mechanical: 'mechanical edit or checklist update -> haiku',
  settled: 'spec or plan edit with a settled decision -> sonnet',
  judgement:
    'judgement whose error is expensive (a reversal not yet decided, adversarial verification, synthesis across disagreeing sources) -> opus'
};
export const STAGE_RUBRIC_TEXT = `Stage rubric, cheapest model that fits: ${RUBRIC.mechanical}; ${RUBRIC.settled}; ${RUBRIC.judgement}.`;
