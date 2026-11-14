import * as fs from 'node:fs';
import * as path from 'node:path';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/shared.js';
import { modelTierRank } from '../src/core/governance.js';

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
};

export type ApprovalStore = {
  record: (sessionId: string, approval: Approval) => void;
  deny: (sessionId: string, model: string, nowMs: number) => void;
  claim: (sessionId: string, requested: string, nowMs: number) => Approval | null;
  attempt: (sessionId: string, promptKey: string, signature: string, nowMs: number, windowMs?: number) => number;
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
  return { ...state, denied: { ...Object.fromEntries(kept), [model.toLowerCase()]: nowMs } };
}

export function wasDeniedRecently(state: ApprovalState, model: string, nowMs: number): boolean {
  const want = modelTierRank(model);
  return Object.entries(state.denied ?? {}).some(([m, t]) => modelTierRank(m) >= want && nowMs - t <= DENIAL_WINDOW_MS);
}

export function addApproval(state: ApprovalState, approval: Approval, nowMs: number): ApprovalState {
  return { ...state, approvals: [...state.approvals.filter((a) => approvalValid(a, nowMs)), approval] };
}

export function recordApproval(state: ApprovalState, approval: Approval, nowMs: number): ApprovalState | null {
  return wasDeniedRecently(state, approval.model, nowMs) ? addApproval(state, approval, nowMs) : null;
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
  return { approvals, ...(attempts ? { attempts } : {}), ...(denied ? { denied } : {}) };
}

export function createAntigravityApprovalStore(sessionsDir: string): ApprovalStore {
  privateDir(sessionsDir);

  const approvalsFile = (sessionId: string) => path.join(sessionsDir, `${sessionId}.approvals.json`);
  const lockDir = (sessionId: string) => path.join(sessionsDir, `${sessionId}.approvals.lock`);

  function withLock<T>(sessionId: string, fn: () => T): T {
    const lock = lockDir(sessionId);
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > 3000) {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock was released
        }
        if (Date.now() > deadline) throw new Error('approvals lock timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
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
    record: (sessionId, approval) =>
      withLock(sessionId, () => {
        const next = recordApproval(readState(sessionId), approval, approval.created_at);
        if (next) writeState(sessionId, next);
      }),
    deny: (sessionId, model, nowMs) =>
      withLock(sessionId, () => {
        writeState(sessionId, noteDenied(readState(sessionId), model, nowMs));
      }),
    claim: (sessionId, requested, nowMs) =>
      withLock(sessionId, () => {
        const { state, approval } = claimApproval(readState(sessionId), requested, nowMs);
        if (approval?.scope === 'once' || state.approvals.length !== readState(sessionId).approvals.length) {
          writeState(sessionId, state);
        }
        return approval;
      }),
    attempt: (sessionId, promptKey, signature, nowMs, windowMs) =>
      withLock(sessionId, () => {
        const { state, count } = bumpAttempts(readState(sessionId), promptKey, signature, nowMs, windowMs);
        writeState(sessionId, state);
        return count;
      })
  };
}
