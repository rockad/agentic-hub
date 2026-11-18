import * as fs from 'node:fs';
import * as path from 'node:path';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/shared.js';
import { modelTierRank, safeSessionId } from '../src/core/governance.js';
import { withDirLock } from '../src/core/dir-lock.js';

export type ApprovalScope = 'once' | '5min' | 'session';

export type Approval = {
  model: string;
  scope: ApprovalScope;
  created_at: number;
};

export type ApprovalState = {
  approvals: Approval[];
  attempts?: Record<string, { count: number; updated_at: number }>;
  denied?: Record<string, number>;
  /**
   * The step_index of the ask_question answer row, per elevation model (lower-case), recorded by PostToolUse against
   * a pending denial. The PreToolUse pull reads only that row: real transcripts carry no tool call ids, so the
   * position of the answer cannot be inferred when other tools ran in parallel with the question.
   */
  answerSteps?: Record<string, number>;
};

export type ApprovalStore = {
  record: (sessionId: string, approval: Approval) => boolean;
  deny: (sessionId: string, model: string, nowMs: number) => void;
  claim: (sessionId: string, requested: string, nowMs: number) => Approval | null;
  attempt: (sessionId: string, promptKey: string, signature: string, nowMs: number, windowMs?: number) => number;
  wasDeniedRecently: (sessionId: string, model: string, nowMs: number) => number | null;
  /** Record the answer row's step_index against the pending denial for `model`. False when no denial is pending. */
  noteAnswerStep?: (sessionId: string, model: string, stepIdx: number, nowMs: number) => boolean;
  /** The recorded answer row step_index for `model`, or null when none is recorded for a pending denial. */
  getAnswerStep?: (sessionId: string, model: string, nowMs: number) => number | null;
};

export const DENIAL_WINDOW_MS = 15 * 60 * 1000;
export const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
export const ATTEMPT_TOTAL_CAP = 20;

const SCOPE_PREFERENCE: Record<ApprovalScope, number> = {
  session: 0,
  '5min': 1,
  once: 2
};

export function approvalValid(a: Approval, nowMs: number): boolean {
  if (a.scope === 'session') return true;
  if (a.scope === '5min') return nowMs - a.created_at <= 5 * 60 * 1000;
  if (a.scope === 'once') return nowMs - a.created_at <= 10 * 60 * 1000;
  return false;
}

export function noteDenied(state: ApprovalState, model: string, nowMs: number): ApprovalState {
  const kept = Object.entries(state.denied ?? {}).filter(([, t]) => nowMs - t <= DENIAL_WINDOW_MS);
  // A fresh denial starts a fresh question: an answer row recorded for an earlier denial must not be read for it.
  const { [model.toLowerCase()]: _stale, ...answerSteps } = state.answerSteps ?? {};
  const next: ApprovalState = { ...state, denied: { ...Object.fromEntries(kept), [model.toLowerCase()]: nowMs } };
  if (Object.keys(answerSteps).length > 0) next.answerSteps = answerSteps;
  else delete next.answerSteps;
  return next;
}

export function noteAnswerStep(state: ApprovalState, model: string, stepIdx: number, nowMs: number): ApprovalState | null {
  if (!Number.isInteger(stepIdx) || stepIdx < 0) return null;
  if (!wasDeniedRecently(state, model, nowMs)) return null;
  return { ...state, answerSteps: { ...(state.answerSteps ?? {}), [model.toLowerCase()]: stepIdx } };
}

export function getAnswerStep(state: ApprovalState, model: string, nowMs: number): number | null {
  if (!wasDeniedRecently(state, model, nowMs)) return null;
  const v = state.answerSteps?.[model.toLowerCase()];
  return typeof v === 'number' ? v : null;
}

export function getRecentDenialTimestamp(state: ApprovalState, model: string, nowMs: number): number | null {
  const want = modelTierRank(model);
  let latest: number | null = null;
  for (const [m, t] of Object.entries(state.denied ?? {})) {
    if (modelTierRank(m) >= want && nowMs - t <= DENIAL_WINDOW_MS) {
      if (latest === null || t > latest) {
        latest = t;
      }
    }
  }
  return latest;
}

export function wasDeniedRecently(state: ApprovalState, model: string, nowMs: number): boolean {
  return getRecentDenialTimestamp(state, model, nowMs) !== null;
}

export function addApproval(state: ApprovalState, approval: Approval, nowMs: number): ApprovalState {
  return { ...state, approvals: [...state.approvals.filter((a) => approvalValid(a, nowMs)), approval] };
}

export function recordApproval(state: ApprovalState, approval: Approval, nowMs: number): ApprovalState | null {
  if (!wasDeniedRecently(state, approval.model, nowMs)) return null;
  const want = modelTierRank(approval.model);
  // Consume the matching denial(s) so a "once" answer in the transcript cannot be replayed on later calls.
  const remainingDenied = Object.fromEntries(
    Object.entries(state.denied ?? {}).filter(([m]) => modelTierRank(m) < want)
  );
  const remainingSteps = Object.fromEntries(
    Object.entries(state.answerSteps ?? {}).filter(([m]) => modelTierRank(m) < want)
  );
  const next: ApprovalState = { ...addApproval(state, approval, nowMs), denied: remainingDenied };
  if (Object.keys(remainingSteps).length > 0) next.answerSteps = remainingSteps;
  else delete next.answerSteps;
  return next;
}

export function claimApproval(
  state: ApprovalState,
  requested: string,
  nowMs: number
): { state: ApprovalState; approval: Approval | null } {
  const wantRank = modelTierRank(requested);
  const live = state.approvals.filter((a) => approvalValid(a, nowMs));
  const hit =
    live
      .filter((a) => modelTierRank(a.model) >= wantRank)
      .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;

  const approvals = hit?.scope === 'once' ? live.filter((a) => a !== hit) : live;
  return { state: { ...state, approvals }, approval: hit };
}

export function bumpAttempts(
  state: ApprovalState,
  promptKey: string,
  signature: string,
  nowMs: number,
  windowMs = ATTEMPT_WINDOW_MS
): { state: ApprovalState; count: number } {
  const key = `${promptKey}:${signature}`;
  const totalKey = `${promptKey}:*`;
  const prev = state.attempts?.[key];
  const prevTotal = state.attempts?.[totalKey];

  const fresh = !prev || nowMs - prev.updated_at > windowMs;
  const count = fresh ? 1 : prev.count + 1;
  const totalFresh = !prevTotal || nowMs - prevTotal.updated_at > windowMs;
  const totalCount = totalFresh ? 1 : prevTotal.count + 1;

  const kept = Object.entries(state.attempts ?? {}).filter(([, v]) => nowMs - v.updated_at <= windowMs);
  const nextAttempts: Record<string, { count: number; updated_at: number }> = {
    ...Object.fromEntries(kept),
    [key]: { count, updated_at: nowMs },
    [totalKey]: { count: totalCount, updated_at: nowMs }
  };

  const finalCount = totalCount >= ATTEMPT_TOTAL_CAP ? Math.max(count, 3) : count;
  return { state: { ...state, attempts: nextAttempts }, count: finalCount };
}

function normalizeApprovalState(raw: unknown): ApprovalState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const approvals: Approval[] = [];
  if (Array.isArray(r.approvals)) {
    for (const a of r.approvals) {
      if (
        a &&
        typeof a === 'object' &&
        typeof a.model === 'string' &&
        (a.scope === 'once' || a.scope === '5min' || a.scope === 'session') &&
        typeof a.created_at === 'number'
      ) {
        approvals.push({ model: a.model, scope: a.scope, created_at: a.created_at });
      }
    }
  }
  const attempts =
    r.attempts && typeof r.attempts === 'object' && !Array.isArray(r.attempts)
      ? (r.attempts as Record<string, { count: number; updated_at: number }>)
      : undefined;
  const denied =
    r.denied && typeof r.denied === 'object' && !Array.isArray(r.denied)
      ? (r.denied as Record<string, number>)
      : undefined;
  const answerSteps =
    r.answerSteps && typeof r.answerSteps === 'object' && !Array.isArray(r.answerSteps)
      ? Object.fromEntries(
          Object.entries(r.answerSteps as Record<string, unknown>).filter(
            (e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]) && e[1] >= 0
          )
        )
      : undefined;
  return {
    approvals,
    ...(attempts ? { attempts } : {}),
    ...(denied ? { denied } : {}),
    ...(answerSteps && Object.keys(answerSteps).length > 0 ? { answerSteps } : {})
  };
}

export function createAntigravityApprovalStore(sessionsDir: string): ApprovalStore {
  privateDir(sessionsDir);

  // Defence in depth: a conversation id comes from hook stdin and ends up in file names, so it is normalised here
  // too (the hook entry already does). An id with nothing safe in it means "no stored state": no file I/O at all.
  const approvalsFile = (safeId: string) => path.join(sessionsDir, `${safeId}.approvals.json`);
  const lockDir = (safeId: string) => path.join(sessionsDir, `${safeId}.approvals.lock`);

  function withLock<T>(safeId: string, fn: () => T): T {
    return withDirLock(lockDir(safeId), fn);
  }

  function readState(sessionId: string): ApprovalState {
    try {
      return normalizeApprovalState(JSON.parse(fs.readFileSync(approvalsFile(sessionId), 'utf8')));
    } catch {
      return { approvals: [] };
    }
  }

  function writeState(sessionId: string, state: ApprovalState): void {
    const file = approvalsFile(sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: PRIVATE_FILE_MODE });
    privateFile(tmp);
    fs.renameSync(tmp, file);
    privateFile(file);
  }

  return {
    record: (rawId, approval) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const next = recordApproval(readState(sessionId), approval, approval.created_at);
        if (next) {
          writeState(sessionId, next);
          return true;
        }
        return false;
      });
    },
    deny: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return;
      withLock(sessionId, () => {
        writeState(sessionId, noteDenied(readState(sessionId), model, nowMs));
      });
    },
    claim: (rawId, requested, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLock(sessionId, () => {
        const { state, approval } = claimApproval(readState(sessionId), requested, nowMs);
        if (approval?.scope === 'once' || state.approvals.length !== readState(sessionId).approvals.length) {
          writeState(sessionId, state);
        }
        return approval;
      });
    },
    attempt: (rawId, promptKey, signature, nowMs, windowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return 1;
      return withLock(sessionId, () => {
        const { state, count } = bumpAttempts(readState(sessionId), promptKey, signature, nowMs, windowMs);
        writeState(sessionId, state);
        return count;
      });
    },
    wasDeniedRecently: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLock(sessionId, () => {
        return getRecentDenialTimestamp(readState(sessionId), model, nowMs);
      });
    },
    noteAnswerStep: (rawId, model, stepIdx, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const next = noteAnswerStep(readState(sessionId), model, stepIdx, nowMs);
        if (!next) return false;
        writeState(sessionId, next);
        return true;
      });
    },
    getAnswerStep: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLock(sessionId, () => getAnswerStep(readState(sessionId), model, nowMs));
    }
  };
}
