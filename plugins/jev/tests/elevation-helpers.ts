import {
  bumpAttempts,
  claimApproval,
  claimDecline,
  claimEffortApproval,
  claimEffortDecline,
  consumeApprovals,
  lastDeniedAtMs,
  noteDenied,
  noteEffortDenied,
  recordApproval,
  recordDecline,
  recordEffortApproval,
  recordEffortDecline,
  resolveEffortDecline,
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
      const done = recordApproval(get(s), approval, approval.created_at, config);
      states.set(s, done.state);
      return done.approval;
    },
    deny: (s, model, nowMs, effort) => void states.set(s, noteDenied(get(s), model, nowMs, effort)),
    deniedAt: (s, model) => lastDeniedAtMs(get(s), model),
    claim: (s, requested, nowMs, ctx, effort, ectx) => {
      const { state, approval } = claimApproval(get(s), requested, nowMs, ctx, effort, ectx);
      states.set(s, state);
      return approval;
    },
    attempt: (s, promptKey, signature, nowMs, windowMs) => {
      const { state, count } = bumpAttempts(get(s), promptKey, signature, nowMs, windowMs);
      states.set(s, state);
      return count;
    },
    recordEffort: (s, approval, config) => {
      const done = recordEffortApproval(get(s), approval, approval.created_at, config);
      states.set(s, done.state);
      return done.approval;
    },
    recordDecline: (s, decline) => void states.set(s, recordDecline(get(s), decline)),
    recordEffortDecline: (s, decline, config) => {
      const stored = resolveEffortDecline(get(s), decline, config);
      states.set(s, recordEffortDecline(get(s), stored));
      return stored;
    },
    denyEffort: (s, level, nowMs, model, noEffort) => void states.set(s, noteEffortDenied(get(s), level, nowMs, model, noEffort)),
    claimEffort: (s, level, nowMs, model, ectx) => {
      const { state, approval } = claimEffortApproval(get(s), level, nowMs, model, ectx);
      states.set(s, state);
      return approval;
    },
    peek: (s, requested, nowMs, ctx, effort, ectx) => claimApproval(get(s), requested, nowMs, ctx, effort, ectx).approval,
    peekEffort: (s, level, nowMs, model, ectx) => claimEffortApproval(get(s), level, nowMs, model, ectx).approval,
    peekDecline: (s, requested, ctx, ectx) => claimDecline(get(s), requested, ctx, ectx).decline,
    peekEffortDecline: (s, level, ectx) => claimEffortDecline(get(s), level, ectx).decline,
    consume: (s, wants, nowMs, ectx) => {
      const done = consumeApprovals(get(s), wants, nowMs, ectx);
      if (!done) return null;
      states.set(s, done.state);
      return { model: done.model, effort: done.effort, decline: done.decline, effortDecline: done.effortDecline };
    },
    snapshot: (s) => get(s)
  };
}
