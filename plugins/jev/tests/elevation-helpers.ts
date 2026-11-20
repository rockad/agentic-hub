import {
  bumpAttempts,
  claimApproval,
  claimEffortApproval,
  consumeApprovals,
  lastDeniedAtMs,
  noteDenied,
  noteEffortDenied,
  recordApproval,
  recordEffortApproval,
  type ApprovalState
} from '../claude/logic.ts';
import type { ApprovalStore } from '../claude/hook.ts';

/**
 * An in-memory stand-in for the hook's approvals store, built on the same pure state functions the live store
 * runs under its file lock: one state per session id.
 */
export function memoryApprovals(): ApprovalStore & { states: Map<string, ApprovalState> } {
  const states = new Map<string, ApprovalState>();
  const get = (s: string): ApprovalState => states.get(s) ?? { approvals: [] };
  return {
    states,
    record: (s, approval, config) => {
      const next = recordApproval(get(s), approval, approval.created_at, config);
      if (next) states.set(s, next);
    },
    deny: (s, model, nowMs) => void states.set(s, noteDenied(get(s), model, nowMs)),
    deniedAt: (s, model) => lastDeniedAtMs(get(s), model),
    claim: (s, requested, nowMs, ctx) => {
      const { state, approval } = claimApproval(get(s), requested, nowMs, ctx);
      states.set(s, state);
      return approval;
    },
    attempt: (s, promptKey, signature, nowMs, windowMs) => {
      const { state, count } = bumpAttempts(get(s), promptKey, signature, nowMs, windowMs);
      states.set(s, state);
      return count;
    },
    recordEffort: (s, approval, config) => {
      const next = recordEffortApproval(get(s), approval, approval.created_at, config);
      if (next) states.set(s, next);
    },
    denyEffort: (s, level, nowMs) => void states.set(s, noteEffortDenied(get(s), level, nowMs)),
    claimEffort: (s, level, nowMs) => {
      const { state, approval } = claimEffortApproval(get(s), level, nowMs);
      states.set(s, state);
      return approval;
    },
    peek: (s, requested, nowMs, ctx) => claimApproval(get(s), requested, nowMs, ctx).approval,
    peekEffort: (s, level, nowMs) => claimEffortApproval(get(s), level, nowMs).approval,
    consume: (s, wants, nowMs) => {
      const done = consumeApprovals(get(s), wants, nowMs);
      if (!done) return null;
      states.set(s, done.state);
      return { model: done.model, effort: done.effort };
    }
  };
}
