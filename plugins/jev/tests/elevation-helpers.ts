import { bumpAttempts, claimApproval, noteDenied, recordApproval, type ApprovalState } from '../claude/logic.ts';
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
    record: (s, approval) => {
      const next = recordApproval(get(s), approval, approval.created_at);
      if (next) states.set(s, next);
    },
    deny: (s, model, nowMs) => void states.set(s, noteDenied(get(s), model, nowMs)),
    claim: (s, requested, nowMs, ctx) => {
      const { state, approval } = claimApproval(get(s), requested, nowMs, ctx);
      states.set(s, state);
      return approval;
    },
    attempt: (s, promptKey, signature, nowMs, windowMs) => {
      const { state, count } = bumpAttempts(get(s), promptKey, signature, nowMs, windowMs);
      states.set(s, state);
      return count;
    }
  };
}
