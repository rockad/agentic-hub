import * as fs from 'node:fs';
import * as path from 'node:path';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/shared.js';
import { modelTierRank, safeSessionId } from '../src/core/governance.js';
import { withDirLock } from '../src/core/dir-lock.js';
import {
  DOWNGRADE_TTL_MS,
  MAX_ENTRIES,
  claimDowngrade,
  downgradeOff,
  live,
  normalizeDowngradeState,
  peekDowngrade,
  rememberRating,
  withRatings,
  type DowngradeClaim,
  type DowngradeEntry,
  type DowngradeState,
  type TierRating
} from '../src/core/downgrade-state.js';

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
  /** The question index (0 = A1) inside that answer row, per elevation model, recorded together with the step. */
  answerQuestions?: Record<string, number>;
  /**
   * Answers that already produced an approval: `step:<step_index>#<questionIndex>` or `<toolCallId>#<questionIndex>`.
   * A denial that arrives later must not be approved again from the same answer row (one answer, one approval).
   */
  consumedAnswers?: string[];
};

export type ApprovalStore = {
  /**
   * Store an approval for a pending denial. `consumedKeys` name the answer rows it came from: when any of them is
   * already consumed nothing is stored (false), otherwise they are remembered as consumed.
   */
  record: (sessionId: string, approval: Approval, consumedKeys?: string[]) => boolean;
  /**
   * `record` and `claim` as ONE locked operation: the approval is stored for the pending denial and, in the same
   * lock, claimed for `approval.model`. No other call can claim a "once" approval in between, so one answer allows
   * one run even when two pro calls evaluate in parallel. `stored: false` (nothing recorded, `approval: null`) when
   * `record` would refuse; a stored approval is always claimed, so `approval` is null only when `stored` is false.
   */
  recordAndClaim?: (
    sessionId: string,
    approval: Approval,
    consumedKeys?: string[]
  ) => { stored: boolean; approval: Approval | null };
  deny: (sessionId: string, model: string, nowMs: number) => void;
  claim: (sessionId: string, requested: string, nowMs: number) => Approval | null;
  attempt: (sessionId: string, promptKey: string, signature: string, nowMs: number, windowMs?: number) => number;
  wasDeniedRecently: (sessionId: string, model: string, nowMs: number) => number | null;
  /** Record the answer row's step_index against the pending denial for `model`. False when no denial is pending. */
  noteAnswerStep?: (sessionId: string, model: string, stepIdx: number, nowMs: number, markerIndex?: number) => boolean;
  /** The recorded answer row step_index for `model`, or null when none is recorded for a pending denial. */
  getAnswerStep?: (sessionId: string, model: string, nowMs: number) => number | null;
  /** The recorded question index inside that row, or null when none is recorded for a pending denial. */
  getAnswerQuestion?: (sessionId: string, model: string, nowMs: number) => number | null;
  /** The answer keys already consumed by an approval in this session. */
  getConsumedAnswers?: (sessionId: string) => string[];
};

export const CONSUMED_ANSWERS_CAP = 100;

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
  const { [model.toLowerCase()]: _staleQ, ...answerQuestions } = state.answerQuestions ?? {};
  const next: ApprovalState = { ...state, denied: { ...Object.fromEntries(kept), [model.toLowerCase()]: nowMs } };
  if (Object.keys(answerSteps).length > 0) next.answerSteps = answerSteps;
  else delete next.answerSteps;
  if (Object.keys(answerQuestions).length > 0) next.answerQuestions = answerQuestions;
  else delete next.answerQuestions;
  return next;
}

export function noteAnswerStep(
  state: ApprovalState,
  model: string,
  stepIdx: number,
  nowMs: number,
  markerIndex = 0
): ApprovalState | null {
  if (!Number.isInteger(stepIdx) || stepIdx < 0) return null;
  if (!Number.isInteger(markerIndex) || markerIndex < 0) return null;
  if (!wasDeniedRecently(state, model, nowMs)) return null;
  return {
    ...state,
    answerSteps: { ...(state.answerSteps ?? {}), [model.toLowerCase()]: stepIdx },
    answerQuestions: { ...(state.answerQuestions ?? {}), [model.toLowerCase()]: markerIndex }
  };
}

export function getAnswerQuestion(state: ApprovalState, model: string, nowMs: number): number | null {
  if (!wasDeniedRecently(state, model, nowMs)) return null;
  const v = state.answerQuestions?.[model.toLowerCase()];
  return typeof v === 'number' ? v : null;
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

export function recordApproval(
  state: ApprovalState,
  approval: Approval,
  nowMs: number,
  consumedKeys: string[] = []
): ApprovalState | null {
  if (!wasDeniedRecently(state, approval.model, nowMs)) return null;
  // One answer, one approval: an answer row that already produced an approval cannot produce another.
  const alreadyConsumed = state.consumedAnswers ?? [];
  if (consumedKeys.some((k) => alreadyConsumed.includes(k))) return null;
  const want = modelTierRank(approval.model);
  // Consume the matching denial(s) so a "once" answer in the transcript cannot be replayed on later calls.
  const remainingDenied = Object.fromEntries(
    Object.entries(state.denied ?? {}).filter(([m]) => modelTierRank(m) < want)
  );
  const remainingSteps = Object.fromEntries(
    Object.entries(state.answerSteps ?? {}).filter(([m]) => modelTierRank(m) < want)
  );
  const remainingQuestions = Object.fromEntries(
    Object.entries(state.answerQuestions ?? {}).filter(([m]) => modelTierRank(m) < want)
  );
  const next: ApprovalState = { ...addApproval(state, approval, nowMs), denied: remainingDenied };
  if (Object.keys(remainingSteps).length > 0) next.answerSteps = remainingSteps;
  else delete next.answerSteps;
  if (Object.keys(remainingQuestions).length > 0) next.answerQuestions = remainingQuestions;
  else delete next.answerQuestions;
  const consumed = [...alreadyConsumed, ...consumedKeys.filter((k) => !alreadyConsumed.includes(k))];
  if (consumed.length > 0) next.consumedAnswers = consumed.slice(-CONSUMED_ANSWERS_CAP);
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
  const answerQuestions =
    r.answerQuestions && typeof r.answerQuestions === 'object' && !Array.isArray(r.answerQuestions)
      ? Object.fromEntries(
          Object.entries(r.answerQuestions as Record<string, unknown>).filter(
            (e): e is [string, number] => typeof e[1] === 'number' && Number.isInteger(e[1]) && e[1] >= 0
          )
        )
      : undefined;
  const consumedAnswers = Array.isArray(r.consumedAnswers)
    ? r.consumedAnswers.filter((k): k is string => typeof k === 'string').slice(-CONSUMED_ANSWERS_CAP)
    : undefined;
  return {
    approvals,
    ...(attempts ? { attempts } : {}),
    ...(denied ? { denied } : {}),
    ...(answerSteps && Object.keys(answerSteps).length > 0 ? { answerSteps } : {}),
    ...(answerQuestions && Object.keys(answerQuestions).length > 0 ? { answerQuestions } : {}),
    ...(consumedAnswers && consumedAnswers.length > 0 ? { consumedAnswers } : {})
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
    record: (rawId, approval, consumedKeys) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const next = recordApproval(readState(sessionId), approval, approval.created_at, consumedKeys);
        if (next) {
          writeState(sessionId, next);
          return true;
        }
        return false;
      });
    },
    recordAndClaim: (rawId, approval, consumedKeys) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return { stored: false, approval: null };
      return withLock(sessionId, () => {
        const recorded = recordApproval(readState(sessionId), approval, approval.created_at, consumedKeys);
        if (!recorded) return { stored: false, approval: null };
        const { state, approval: claimed } = claimApproval(recorded, approval.model, approval.created_at);
        writeState(sessionId, state);
        return { stored: true, approval: claimed };
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
    noteAnswerStep: (rawId, model, stepIdx, nowMs, markerIndex) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const next = noteAnswerStep(readState(sessionId), model, stepIdx, nowMs, markerIndex);
        if (!next) return false;
        writeState(sessionId, next);
        return true;
      });
    },
    getAnswerStep: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLock(sessionId, () => getAnswerStep(readState(sessionId), model, nowMs));
    },
    getAnswerQuestion: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLock(sessionId, () => getAnswerQuestion(readState(sessionId), model, nowMs));
    },
    getConsumedAnswers: (rawId) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return [];
      return withLock(sessionId, () => readState(sessionId).consumedAnswers ?? []);
    }
  };
}

// ── Downgrade choice state (`[jev-downgrade:flash_lite]`) ───────────────────────────────────────────────────────────
// A separate file from the approvals: a downgrade answer never grants an elevation and an elevation approval never
// answers a downgrade question. The rating, the question state and the session-off switch are the shared pure state of
// `src/core/downgrade-state.ts`; this section adds what is Antigravity's own (one needed alias, three prescribed answers,
// and the bounds that keep an answer from being applied twice).

/** The only alias the Antigravity downgrade question is about: the marker is `[jev-downgrade:flash_lite]`. */
export const DOWNGRADE_ALIAS = 'flash_lite';

/** The three prescribed answers: a Yes, a No for this delegation, and a No for the rest of the conversation. */
export type DowngradeChoice = 'yes' | 'keep' | 'off';

/** What an answered entry stores: the prescribed label (`off` is the shared session-off form), never the user's text. */
const STORED_LABEL: Record<DowngradeChoice, string> = { yes: 'Yes, flash_lite', keep: 'No, keep flash', off: 'session off' };

/** One question asked in this conversation, as `claimDowngrade` writes it, plus what Antigravity adds to it. */
type AskEntry = DowngradeEntry & {
  /** The `step_index` the denial happened at: a question at or before it cannot be this denial's. */
  ask_step?: number;
  /** The tool call id of the `ask_question` whose answer closed this entry: that answer is never applied again. */
  ask_id?: string;
};

/** Pure: record the question for `signature` (a denial about to be sent). `first` when it was written, `asked`/`answered` when on record. */
export function claimAskDowngrade(
  state: DowngradeState,
  signature: string,
  nowMs: number,
  stepIdx?: number
): { state: DowngradeState; result: DowngradeClaim } {
  const claimed = claimDowngrade(state, signature, DOWNGRADE_ALIAS, nowMs, true);
  if (claimed.result !== 'first' || typeof stepIdx !== 'number') return claimed;
  const entries = claimed.state.entries.map((e) =>
    !e.answered && e.signature === signature && e.asked_at === nowMs ? ({ ...e, ask_step: stepIdx } as AskEntry) : e
  );
  return { state: { ...claimed.state, entries }, result: 'first' };
}

/**
 * Pure: record the user's answer. Every unanswered question of this conversation is closed by it (the answer does not name a
 * delegation), once: the pending entries are marked answered with the label and the answer's tool call id, so the same
 * answer read again, from the transcript or from a second hook run, finds nothing pending and records nothing. With no
 * pending question the state is returned unchanged and `recorded` is false: an answer nobody asked for covers no call.
 */
export function answerAskDowngrade(
  state: DowngradeState,
  choice: DowngradeChoice,
  askId: string | undefined,
  nowMs: number
): { state: DowngradeState; recorded: boolean } {
  const entries = live(state, nowMs);
  if (!entries.some((e) => !e.answered && e.from === DOWNGRADE_ALIAS)) return { state, recorded: false };
  const next = entries.map((e) =>
    !e.answered && e.from === DOWNGRADE_ALIAS
      ? ({ ...e, answered: true, chosen: STORED_LABEL[choice], ...(askId ? { ask_id: askId } : {}), expires_at: nowMs + DOWNGRADE_TTL_MS } as AskEntry)
      : e
  );
  const base = withRatings(state, next.slice(-MAX_ENTRIES), nowMs);
  return { state: choice === 'off' ? { ...base, off: state.off ?? { at: nowMs } } : base, recorded: true };
}

/** Pure: the answer on record for `signature` (`off` when the conversation switched the question off), or null. */
export function answeredDowngradeChoice(state: DowngradeState, signature: string, nowMs: number): DowngradeChoice | null {
  if (downgradeOff(state)) return 'off';
  const hit = live(state, nowMs)
    .filter((e) => e.answered && e.signature === signature)
    .pop();
  if (!hit) return null;
  return hit.chosen === STORED_LABEL.yes ? 'yes' : hit.chosen === STORED_LABEL.keep ? 'keep' : hit.chosen === STORED_LABEL.off ? 'off' : null;
}

/** Pure: the unanswered question for `signature` (when it was asked, at which step), plus the ask ids already consumed. */
export function pendingDowngradeAsk(
  state: DowngradeState,
  signature: string,
  nowMs: number
): { askedAt: number; askStep?: number; consumed: Set<string> } | null {
  const entries = live(state, nowMs) as AskEntry[];
  const pending = entries.find((e) => !e.answered && e.signature === signature && typeof e.asked_at === 'number');
  if (!pending) return null;
  const consumed = new Set(entries.flatMap((e) => (typeof e.ask_id === 'string' ? [e.ask_id] : [])));
  return { askedAt: pending.asked_at as number, ...(typeof pending.ask_step === 'number' ? { askStep: pending.ask_step } : {}), consumed };
}

export type DowngradeStore = {
  /** What is on record for a call before it is rated (see `peekDowngrade`). */
  peek: (sessionId: string, signature: string, nowMs: number) => ReturnType<typeof peekDowngrade>;
  /** Keep the delegation's rating for ten minutes, so a retry does not call the router again. */
  remember: (sessionId: string, signature: string, rating: TierRating, nowMs: number) => void;
  /** Write the question down (atomically: one parallel caller is `first`). */
  claim: (sessionId: string, signature: string, nowMs: number, stepIdx?: number) => DowngradeClaim;
  /** Record an answer once; false when no question was pending. */
  answer: (sessionId: string, choice: DowngradeChoice, askId: string | undefined, nowMs: number) => boolean;
  choiceFor: (sessionId: string, signature: string, nowMs: number) => DowngradeChoice | null;
  pending: (sessionId: string, signature: string, nowMs: number) => ReturnType<typeof pendingDowngradeAsk>;
};

export function createAntigravityDowngradeStore(sessionsDir: string): DowngradeStore {
  const idOf = (sessionId: string): string => {
    const safe = safeSessionId(sessionId);
    if (!safe) throw new Error('unsafe session id');
    return safe;
  };
  const file = (sessionId: string) => path.join(sessionsDir, `${idOf(sessionId)}.downgrade.json`);
  const lock = (sessionId: string) => path.join(sessionsDir, `${idOf(sessionId)}.downgrade.lock`);

  const read = (sessionId: string): DowngradeState => {
    const target = file(sessionId); // an id with nothing safe in it throws here, so the caller skips the evaluation
    try {
      return normalizeDowngradeState(JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch {
      return { entries: [] };
    }
  };
  const write = (sessionId: string, state: DowngradeState): void => {
    privateDir(sessionsDir);
    const target = file(sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: PRIVATE_FILE_MODE });
    privateFile(tmp);
    fs.renameSync(tmp, target);
    privateFile(target);
  };
  const locked = <T>(sessionId: string, fn: () => T): T => {
    privateDir(sessionsDir);
    return withDirLock(lock(sessionId), fn);
  };

  return {
    peek: (sessionId, signature, nowMs) => peekDowngrade(read(sessionId), signature, nowMs),
    remember: (sessionId, signature, rating, nowMs) =>
      locked(sessionId, () => write(sessionId, rememberRating(read(sessionId), signature, rating, nowMs))),
    claim: (sessionId, signature, nowMs, stepIdx) =>
      locked(sessionId, () => {
        const { state, result } = claimAskDowngrade(read(sessionId), signature, nowMs, stepIdx);
        if (result === 'first') write(sessionId, state);
        return result;
      }),
    answer: (sessionId, choice, askId, nowMs) =>
      locked(sessionId, () => {
        const { state, recorded } = answerAskDowngrade(read(sessionId), choice, askId, nowMs);
        if (recorded) write(sessionId, state);
        return recorded;
      }),
    choiceFor: (sessionId, signature, nowMs) => answeredDowngradeChoice(read(sessionId), signature, nowMs),
    pending: (sessionId, signature, nowMs) => pendingDowngradeAsk(read(sessionId), signature, nowMs)
  };
}
