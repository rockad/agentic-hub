import { addApproval, bumpAttempts, claimApproval, type ApprovalState } from '../claude/logic.ts';
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
    record: (s, approval) => void states.set(s, addApproval(get(s), approval, approval.created_at)),
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

/**
 * An in-memory stand-in for the hook's clamp claim: `first` is true for the first caller of a session and
 * prompt key, false after, and a later caller gets the signature of the delegation the first one clamped.
 */
export function memoryClaim(): (sessionId: string, promptKey: string, signature: string) => { first: boolean; signature?: string } {
  const seen = new Map<string, string>();
  return (sessionId, promptKey, signature) => {
    const key = `${sessionId}\u0000${promptKey}`;
    if (seen.has(key)) return { first: false, signature: seen.get(key) };
    // One slot per session, like the live store: a new prompt forgets the old one.
    for (const k of [...seen.keys()]) if (k.startsWith(`${sessionId}\u0000`)) seen.delete(k);
    seen.set(key, signature);
    return { first: true };
  };
}
