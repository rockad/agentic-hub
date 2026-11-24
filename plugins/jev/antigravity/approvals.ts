import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/shared.js';
import { modelTierRank, safeSessionId } from '../src/core/governance.js';
import { withDirLock } from '../src/core/dir-lock.js';
import { DEFAULT_COST_EFFORT, effortFromModelId, type CostEffort } from '../src/core/cost-estimate.js';
import { LEGACY_APPROVAL_EFFORT, effortIndex, effortWithin, stripEffortSuffix } from '../src/core/cost-gate.js';
import { denialPredatesModeChange, type ModeChangeConfigLike } from '../src/core/mode-change.js';
import { markOnceUsed, onceLive, storedClause, type AnswerScope, type OnceUsed, type StoredClause } from '../src/core/elevation-answer.js';
import { subagentEnumOf } from '../src/core/served-model.js';
import {
  DOWNGRADE_TTL_MS,
  MAX_ENTRIES,
  voidStalePending,
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

/** `once`: bound to the turn it was answered in (no clock); `session`. A `5min` record from before 2.3.21 is read as expired (dropped). */
export type ApprovalScope = AnswerScope;

export type Approval = {
  model: string;
  scope: ApprovalScope;
  created_at: number;
  /** A `once` approval's turn: the hash of the user input of the turn it was answered in (`antigravityTurnKey`). It is live only in that turn. */
  turn?: string;
};

/** A No (2.3.21): this delegation only (`once`: the next launch of the turn) or the rest of the session; `model` is the marker's model key. */
export type Decline = { model: string; scope: ApprovalScope; created_at: number; turn?: string };

/** What a stored answer is read against: the turn a `once` belongs to, and the config for the `modeChangedAt` stamp (anything older no longer counts). */
export type ElevationCtx = { turn?: string; config?: ModeChangeConfigLike | null };

/**
 * The key of the user turn a call belongs to, which is also the turn a `Yes, once` answer is bound to (2.3.21): the first 16 hex of the
 * sha256 of the hook input's `lastUserInput`, the same per-prompt key the attempt counter uses; `no-prompt` when the input carries none.
 * A new user message changes it, so a once given in an earlier turn is not live. (Two user messages with identical text share a key.)
 */
export function antigravityTurnKey(lastUserInput: unknown): string {
  return typeof lastUserInput === 'string' && lastUserInput ? createHash('sha256').update(lastUserInput).digest('hex').slice(0, 16) : 'no-prompt';
}

/** A question-pending note (see `ApprovalState.pendingQuestions`): the answer row's step_index and question index, and when PostToolUse saw the question answered. */
export type PendingQuestion = { stepIdx: number; questionIdx?: number; asked_at: number };

export type ApprovalState = {
  approvals: Approval[];
  attempts?: Record<string, { count: number; updated_at: number }>;
  /**
   * The elevation questions Jev prescribed, per model key (lower-case), with the time. No expiry (2.3.21): with the effort suffix of the
   * key it is the record of what Jev prescribed, and an answer approves at most that effort.
   */
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
   * Answers that already produced an approval (or a decline): `step:<step_index>#<questionIndex>` or `<toolCallId>#<questionIndex>`.
   * A denial that arrives later must not be approved again from the same answer row (one answer, one approval).
   */
  consumedAnswers?: string[];
  /**
   * Question-pending notes (2.3.21): an elevation question PostToolUse saw answered but whose answer row was not in the transcript yet, with
   * no denial on record for its model (the question was not prescribed by Jev). Per marker model (lower-case): where the answer row will be.
   * No expiry; voided by a mode change (like the prescriptions); dropped when a denial for the model is noted and when the answer is read.
   */
  pendingQuestions?: Record<string, PendingQuestion>;
  /** The No answers (2.3.21). */
  declines?: Decline[];
  /** The once approvals a launch used in the turn (the approval's model key), so a later deny can say so. Only the current turn's marks are kept. */
  onceUsed?: OnceUsed[];
};

export type ApprovalStore = {
  /**
   * Store an approval (2.3.21: whether or not Jev denied anything first, no window). `consumedKeys` name the answer rows it came from: when any of them is
   * already consumed nothing is stored (false), otherwise they are remembered as consumed. The model key keeps the effort the marker
   * named, held to the effort Jev prescribed for it (none on record: `high`). `config`: the `modeChangedAt` stamp, which voids earlier prescriptions.
   */
  record: (sessionId: string, approval: Approval, consumedKeys?: string[], config?: ModeChangeConfigLike | null) => boolean;
  /** `record`, returning what was stored (the capped model key), or null when nothing was (an answer already consumed). */
  recordWithResult?: (sessionId: string, approval: Approval, consumedKeys?: string[], config?: ModeChangeConfigLike | null) => Approval | null;
  /**
   * `record` and `claim` as ONE locked operation: the approval is stored and, in the same
   * lock, claimed for `approval.model`. No other call can claim a "once" approval in between, so one answer allows
   * one run even when two pro calls evaluate in parallel. `stored: false` (nothing recorded, `approval: null`) when
   * `record` would refuse; a stored approval is always claimed, so `approval` is null only when `stored` is false.
   */
  recordAndClaim?: (
    sessionId: string,
    approval: Approval,
    consumedKeys?: string[],
    ectx?: ElevationCtx | null
  ) => { stored: boolean; approval: Approval | null };
  deny: (sessionId: string, model: string, nowMs: number) => void;
  /** Find the approval covering `requested` and consume it when it is a `once`. `effort` (2.3.19) is the effort the call runs at when its model id names none (the cost gate's call effort). `ectx`: the turn and the mode-change config. */
  claim: (sessionId: string, requested: string, nowMs: number, effort?: CostEffort, ectx?: ElevationCtx | null) => Approval | null;
  /** Record a No for the marker's model (this delegation or the session); false when the answer row was already consumed. */
  recordDecline?: (sessionId: string, decline: Decline, consumedKeys?: string[]) => boolean;
  /** `recordDecline` and `claimDecline` as one locked operation (a pulled answer): the No applies to this call at once. */
  recordDeclineAndClaim?: (sessionId: string, decline: Decline, consumedKeys?: string[], ectx?: ElevationCtx | null) => { stored: boolean; decline: Decline | null };
  /** The No covering `requested` (a No for a model covers that model and stronger ones of the same kind), a session No before a `once` of this turn; a `once` No is consumed. */
  claimDecline?: (sessionId: string, requested: string, nowMs: number, ectx?: ElevationCtx | null) => Decline | null;
  /** The same without consuming (a script that cannot be clamped is denied while the No stands). */
  peekDecline?: (sessionId: string, requested: string, nowMs: number, ectx?: ElevationCtx | null) => Decline | null;
  /** The stored state, read-only (for the clause a deny reason adds about what is stored). */
  snapshot?: (sessionId: string) => ApprovalState;
  attempt: (sessionId: string, promptKey: string, signature: string, nowMs: number, windowMs?: number) => number;
  /** When Jev last prescribed the question for `model` or a stronger one (epoch ms; no expiry), or null. */
  wasDeniedRecently: (sessionId: string, model: string, nowMs: number) => number | null;
  /** Record the answer row's step_index against the pending denial for `model`. False when no denial is pending. */
  noteAnswerStep?: (sessionId: string, model: string, stepIdx: number, nowMs: number, markerIndex?: number) => boolean;
  /** The recorded answer row step_index for `model`, or null when none is recorded for a pending denial. */
  getAnswerStep?: (sessionId: string, model: string, nowMs: number) => number | null;
  /** The recorded question index inside that row, or null when none is recorded for a pending denial. */
  getAnswerQuestion?: (sessionId: string, model: string, nowMs: number) => number | null;
  /** Note a question PostToolUse saw answered but whose row was not in the transcript yet, when no denial for `model` is on record (2.3.21). False when none was stored. */
  notePendingQuestion?: (sessionId: string, model: string, stepIdx: number, nowMs: number, markerIndex?: number) => boolean;
  /** The question-pending note standing for `model` (that model or a stronger one), not voided by a mode change; null when none. */
  getPendingQuestion?: (sessionId: string, model: string, config?: ModeChangeConfigLike | null) => PendingQuestion | null;
  /** Drop the question-pending notes standing for `model` (its answer was read). */
  clearPendingQuestion?: (sessionId: string, model: string) => void;
  /** The answer keys already consumed by an approval in this session. */
  getConsumedAnswers?: (sessionId: string) => string[];
};

export const CONSUMED_ANSWERS_CAP = 100;

/**
 * An approval (or a denial, which stands for one) is keyed as one of two kinds: an ENUM value of `invoke_subagent`'s `Model` (`pro`,
 * `flash`, `flash_lite`: served on Hydrogen, never on a pro-class model) or a FULL id (`gemini-4-argon-high`, `claude-opus-5-5`, or the
 * `pro-high` form of its marker). An enum approval covers enum values only: `pro` (Hydrogen at xhigh) must never cover a real
 * pro-class id, whose cost is several times higher. A full-id approval covers the full ids at or below its tier and effort, and the
 * enum values at or below its tier (an enum is always the cheaper model).
 */
export const approvalKindCovers = (approved: string, requested: string): boolean => subagentEnumOf(requested) !== null || subagentEnumOf(approved) === null;

/** A No covers a request of the same kind (enum or full id) at its tier or above. */
const declineKindMatches = (declined: string, requested: string): boolean => (subagentEnumOf(declined) === null) === (subagentEnumOf(requested) === null);

export const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
export const ATTEMPT_TOTAL_CAP = 20;

/** Most approvals (and declines) one file keeps. */
const ANSWERS_CAP = 24;

const SCOPE_PREFERENCE: Record<ApprovalScope, number> = {
  session: 0,
  once: 1
};

const voided = (createdAt: number, ectx?: ElevationCtx | null): boolean => denialPredatesModeChange(createdAt, ectx?.config, 'antigravity');
/** A stored answer that counts now: a session one, or a once of this turn; and not from before the last mode change. */
const usable = (a: { scope: ApprovalScope; turn?: string; created_at: number }, ectx?: ElevationCtx | null): boolean => onceLive(a, ectx?.turn) && !voided(a.created_at, ectx);

export function noteDenied(state: ApprovalState, model: string, nowMs: number): ApprovalState {
  // A fresh denial starts a fresh question: an answer row recorded for an earlier denial must not be read for it.
  const { [model.toLowerCase()]: _stale, ...answerSteps } = state.answerSteps ?? {};
  const { [model.toLowerCase()]: _staleQ, ...answerQuestions } = state.answerQuestions ?? {};
  // A denial supersedes a question-pending note for the model: the denial path reads its answer from then on.
  const next: ApprovalState = { ...(clearPendingQuestion(state, model) ?? state), denied: { ...(state.denied ?? {}), [model.toLowerCase()]: nowMs } };
  if (Object.keys(answerSteps).length > 0) next.answerSteps = answerSteps;
  else delete next.answerSteps;
  if (Object.keys(answerQuestions).length > 0) next.answerQuestions = answerQuestions;
  else delete next.answerQuestions;
  return next;
}

/** The model keys of `pendingQuestions` that stand for `model`: that model or a stronger one of the same kind, at an effort that covers it (the denial check's rule). */
const pendingKeysCovering = (state: ApprovalState, model: string): string[] => {
  const want = modelTierRank(model);
  return Object.keys(state.pendingQuestions ?? {}).filter(
    (m) => modelTierRank(m) >= want && approvalKindCovers(m, model) && effortWithin(effortFromModelId(m) ?? DEFAULT_COST_EFFORT, effortFromModelId(model) ?? DEFAULT_COST_EFFORT)
  );
};

/** Pure: the state without the question-pending notes that stand for `model` (null when there were none). */
export function clearPendingQuestion(state: ApprovalState, model: string): ApprovalState | null {
  const keys = pendingKeysCovering(state, model);
  if (keys.length === 0) return null;
  const rest = Object.fromEntries(Object.entries(state.pendingQuestions ?? {}).filter(([m]) => !keys.includes(m)));
  const { pendingQuestions: _p, ...base } = state;
  return Object.keys(rest).length > 0 ? { ...base, pendingQuestions: rest } : base;
}

/**
 * Pure: the state with a question-pending note for `model`, or null when a denial for it is on record (the existing denial path reads that answer
 * with `noteAnswerStep`) or the indexes are not plain non-negative integers. A later note for the same model replaces the earlier one.
 */
export function notePendingQuestion(state: ApprovalState, model: string, stepIdx: number, nowMs: number, markerIndex = 0): ApprovalState | null {
  if (!Number.isInteger(stepIdx) || stepIdx < 0 || !Number.isInteger(markerIndex) || markerIndex < 0) return null;
  if (wasDeniedRecently(state, model, nowMs)) return null;
  return { ...state, pendingQuestions: { ...(state.pendingQuestions ?? {}), [model.toLowerCase()]: { stepIdx, questionIdx: markerIndex, asked_at: nowMs } } };
}

/** The question-pending note standing for `model` (the latest of those that cover it), not voided by a mode change; null when none. */
export function getPendingQuestion(state: ApprovalState, model: string, config?: ModeChangeConfigLike | null): PendingQuestion | null {
  let best: PendingQuestion | null = null;
  for (const key of pendingKeysCovering(state, model)) {
    const note = (state.pendingQuestions ?? {})[key];
    if (voided(note.asked_at, { config })) continue;
    if (best === null || note.asked_at > best.asked_at) best = note;
  }
  return best;
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

/** The effort a prescription (a denial key) stands for: its suffix; a key with none was a bare question, which stands for at most `high`. */
const prescriptionEffort = (key: string): CostEffort => effortFromModelId(key) ?? LEGACY_APPROVAL_EFFORT;

/**
 * The latest time Jev prescribed the question for `model` or a stronger one of the same kind (epoch ms), or null. No expiry (2.3.21).
 * The prescription must also cover the effort the answer would name (the id's suffix, else medium): an answer cannot approve a higher
 * effort than the question asked about.
 */
export function getRecentDenialTimestamp(state: ApprovalState, model: string, _nowMs?: number): number | null {
  const want = modelTierRank(model);
  let latest: number | null = null;
  for (const [m, t] of Object.entries(state.denied ?? {})) {
    if (modelTierRank(m) >= want && approvalKindCovers(m, model) && effortWithin(effortFromModelId(m) ?? DEFAULT_COST_EFFORT, effortFromModelId(model) ?? DEFAULT_COST_EFFORT)) {
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

/**
 * The effort Jev prescribed for the model an answer names: the highest effort among the questions it prescribed for that model's own
 * tier (same kind), unless the prescription predates the last mode change; null when there is none on record. As in Claude Code, only
 * the model's own prescription counts: a stronger tier's question never raises the cap of a weaker one's answer.
 */
export function prescribedEffortFor(state: ApprovalState, model: string, config?: ModeChangeConfigLike | null): CostEffort | null {
  const want = modelTierRank(model);
  let best: CostEffort | null = null;
  for (const [m, t] of Object.entries(state.denied ?? {})) {
    if (voided(t, { config })) continue;
    if (modelTierRank(m) !== want || !approvalKindCovers(m, model)) continue;
    const e = prescriptionEffort(m);
    if (best === null || effortIndex(e) > effortIndex(best)) best = e;
  }
  return best;
}

/** The marker model key held to the effort Jev prescribed: an effort suffix above the cap is lowered to it (none prescribed: `high`); a key with no suffix is left as it is. */
export function cappedModelKey(model: string, prescribed: CostEffort | null): string {
  const named = effortFromModelId(model);
  if (named === null) return model;
  const cap = prescribed ?? LEGACY_APPROVAL_EFFORT;
  return effortIndex(named) <= effortIndex(cap) ? model : `${stripEffortSuffix(model)}-${cap}`;
}

export function addApproval(state: ApprovalState, approval: Approval, _nowMs?: number): ApprovalState {
  // A new `once` replaces the once approvals of other turns (never live again); the file keeps at most ANSWERS_CAP.
  const keep = state.approvals.filter((a) => !(approval.scope === 'once' && a.scope === 'once' && a.turn !== approval.turn));
  return { ...state, approvals: [...keep, approval].slice(-ANSWERS_CAP) };
}

/**
 * Pure: the state with the user's Yes added (2.3.21), and the approval as stored. No denial is needed and there is no window. The model
 * key keeps the effort the marker named, held to the effort Jev prescribed for it (`cappedModelKey`). One answer, one approval: an
 * answer row that already produced one cannot produce another (null). A Yes also drops the declines it contradicts (that model or a
 * weaker one of the same kind). The prescription (`denied`) stays: it is the record of what Jev asked.
 */
export function recordApproval(
  state: ApprovalState,
  approval: Approval,
  nowMs: number,
  consumedKeys: string[] = [],
  config?: ModeChangeConfigLike | null
): { state: ApprovalState; approval: Approval } | null {
  const alreadyConsumed = state.consumedAnswers ?? [];
  if (consumedKeys.some((k) => alreadyConsumed.includes(k))) return null;
  const model = cappedModelKey(approval.model, prescribedEffortFor(state, approval.model, config));
  const stored: Approval = { ...approval, model };
  const want = modelTierRank(stored.model);
  // Consume the matching answer-row bookkeeping so a "once" answer in the transcript cannot be replayed on later calls.
  const remainingSteps = Object.fromEntries(Object.entries(state.answerSteps ?? {}).filter(([m]) => modelTierRank(m) < want));
  const remainingQuestions = Object.fromEntries(Object.entries(state.answerQuestions ?? {}).filter(([m]) => modelTierRank(m) < want));
  const declines = (state.declines ?? []).filter((d) => !(modelTierRank(d.model) <= want && approvalKindCovers(stored.model, d.model)));
  const { declines: _d, ...base } = state;
  const next: ApprovalState = { ...addApproval({ ...base, ...(declines.length ? { declines } : {}) }, stored, nowMs) };
  if (Object.keys(remainingSteps).length > 0) next.answerSteps = remainingSteps;
  else delete next.answerSteps;
  if (Object.keys(remainingQuestions).length > 0) next.answerQuestions = remainingQuestions;
  else delete next.answerQuestions;
  const consumed = [...alreadyConsumed, ...consumedKeys.filter((k) => !alreadyConsumed.includes(k))];
  if (consumed.length > 0) next.consumedAnswers = consumed.slice(-CONSUMED_ANSWERS_CAP);
  return { state: next, approval: stored };
}

/**
 * Pure: the approval that covers `requested` (a tier at or above it, of a kind that covers it, at an effort that covers it), a session
 * one before a `once`, which is consumed and marked used in this turn. An approval that is not live is ignored: a `once` of another turn,
 * and anything from before the last mode change (`ectx`).
 */
export function claimApproval(
  state: ApprovalState,
  requested: string,
  nowMs: number,
  effort?: CostEffort,
  ectx?: ElevationCtx | null
): { state: ApprovalState; approval: Approval | null } {
  void nowMs;
  const wantRank = modelTierRank(requested);
  const hit =
    state.approvals
      .filter((a) => usable(a, ectx))
      .filter((a) => modelTierRank(a.model) >= wantRank)
      // An enum approval never covers a full id (see `approvalKindCovers`).
      .filter((a) => approvalKindCovers(a.model, requested))
      // The approval must cover the call's effort too (2.3.19): the suffix of its model id, else `high` for a record that names none, against the call's suffix, else `medium`.
      .filter((a) => effortWithin(effortFromModelId(a.model) ?? LEGACY_APPROVAL_EFFORT, effortFromModelId(requested) ?? effort ?? DEFAULT_COST_EFFORT))
      .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, approval: null };
  if (hit.scope !== 'once') return { state, approval: hit };
  return { state: { ...state, approvals: state.approvals.filter((a) => a !== hit), onceUsed: markOnceUsed(state.onceUsed, hit.model, ectx?.turn) }, approval: hit };
}

/** Pure: the state with a No added, or null when its answer row was already consumed. A session No drops the approvals it contradicts (that model or a stronger one of the same kind) and replaces earlier declines of the same model; a once No drops only the unused once approvals, never a session Yes. */
export function recordDecline(
  state: ApprovalState,
  decline: Decline,
  consumedKeys: string[] = []
): { state: ApprovalState; decline: Decline } | null {
  const alreadyConsumed = state.consumedAnswers ?? [];
  if (consumedKeys.some((k) => alreadyConsumed.includes(k))) return null;
  const rank = modelTierRank(decline.model);
  // A once No never withdraws the user's standing "Yes, for this session": it drops only the unused once approvals it contradicts.
  const approvals = state.approvals.filter(
    (a) => !(modelTierRank(a.model) >= rank && approvalKindCovers(a.model, decline.model) && (decline.scope === 'session' || a.scope === 'once'))
  );
  const declines = (state.declines ?? []).filter(
    (d) => !(decline.scope === 'session' && d.model === decline.model) && !(decline.scope === 'once' && d.scope === 'once' && d.turn !== decline.turn)
  );
  const next: ApprovalState = { ...state, approvals, declines: [...declines, decline].slice(-ANSWERS_CAP) };
  const consumed = [...alreadyConsumed, ...consumedKeys.filter((k) => !alreadyConsumed.includes(k))];
  if (consumed.length > 0) next.consumedAnswers = consumed.slice(-CONSUMED_ANSWERS_CAP);
  return { state: next, decline };
}

/** Pure: the No covering `requested` (a session one before a `once` of this turn), consuming the `once` when `consume` is set. Not live: ignored (see `claimApproval`). */
export function claimDecline(
  state: ApprovalState,
  requested: string,
  ectx?: ElevationCtx | null,
  consume = true
): { state: ApprovalState; decline: Decline | null } {
  const rank = modelTierRank(requested);
  const hit =
    (state.declines ?? [])
      .filter((d) => usable(d, ectx))
      .filter((d) => rank >= modelTierRank(d.model) && declineKindMatches(d.model, requested))
      .sort((a, b) => SCOPE_PREFERENCE[a.scope] - SCOPE_PREFERENCE[b.scope])[0] ?? null;
  if (!hit) return { state, decline: null };
  if (hit.scope !== 'once' || !consume) return { state, decline: hit };
  const declines = (state.declines ?? []).filter((d) => d !== hit);
  const { declines: _d, ...rest } = state;
  return { state: { ...rest, ...(declines.length ? { declines } : {}) }, decline: hit };
}

/** The clause a deny reason adds: what Jev has stored for `requested` (see `storedClause`). Pure. */
export function storedClauseFor(state: ApprovalState, requested: string, effort?: CostEffort, ectx?: ElevationCtx | null): StoredClause {
  const wantRank = modelTierRank(requested);
  const covering = state.approvals
    .filter((a) => !voided(a.created_at, ectx) && modelTierRank(a.model) >= wantRank && approvalKindCovers(a.model, requested))
    .map((a) => ({ scope: a.scope, ...(a.turn !== undefined ? { turn: a.turn } : {}), effort: effortFromModelId(a.model) ?? LEGACY_APPROVAL_EFFORT }));
  const onceUsedThisTurn = (state.onceUsed ?? []).some(
    (u) => ectx?.turn !== undefined && u.turn === ectx.turn && modelTierRank(u.key) >= wantRank && approvalKindCovers(u.key, requested)
  );
  const needed = effortFromModelId(requested) ?? effort;
  return storedClause({ kind: 'model', subject: requested, covering, turn: ectx?.turn, ...(needed ? { neededEffort: needed } : {}), onceUsedThisTurn });
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
  const scopeOk = (s: unknown): s is ApprovalScope => s === 'once' || s === 'session';
  const turnOf = (x: { turn?: unknown }): { turn?: string } => (typeof x.turn === 'string' && x.turn ? { turn: x.turn } : {});
  // A record from before 2.3.21 with the `5min` scope is read as expired: dropped.
  const approvals: Approval[] = [];
  if (Array.isArray(r.approvals)) {
    for (const a of r.approvals) {
      if (a && typeof a === 'object' && typeof a.model === 'string' && scopeOk(a.scope) && typeof a.created_at === 'number') {
        approvals.push({ model: a.model, scope: a.scope, created_at: a.created_at, ...turnOf(a) });
      }
    }
  }
  const declines: Decline[] = [];
  if (Array.isArray(r.declines)) {
    for (const d of r.declines) {
      if (d && typeof d === 'object' && typeof d.model === 'string' && scopeOk(d.scope) && typeof d.created_at === 'number') {
        declines.push({ model: d.model, scope: d.scope, created_at: d.created_at, ...turnOf(d) });
      }
    }
  }
  const onceUsed: OnceUsed[] = Array.isArray(r.onceUsed)
    ? r.onceUsed.filter((u): u is OnceUsed => !!u && typeof u.key === 'string' && typeof u.turn === 'string').map((u) => ({ key: u.key, turn: u.turn }))
    : [];
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
  const pendingQuestions =
    r.pendingQuestions && typeof r.pendingQuestions === 'object' && !Array.isArray(r.pendingQuestions)
      ? Object.fromEntries(
          Object.entries(r.pendingQuestions as Record<string, any>)
            .filter(([, p]) => !!p && typeof p === 'object' && Number.isInteger(p.stepIdx) && p.stepIdx >= 0 && typeof p.asked_at === 'number')
            .map(([m, p]): [string, PendingQuestion] => [
              m,
              { stepIdx: p.stepIdx, ...(Number.isInteger(p.questionIdx) && p.questionIdx >= 0 ? { questionIdx: p.questionIdx } : {}), asked_at: p.asked_at }
            ])
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
    ...(consumedAnswers && consumedAnswers.length > 0 ? { consumedAnswers } : {}),
    ...(pendingQuestions && Object.keys(pendingQuestions).length > 0 ? { pendingQuestions } : {}),
    ...(declines.length ? { declines } : {}),
    ...(onceUsed.length ? { onceUsed } : {})
  };
}

export function createAntigravityApprovalStore(sessionsDir: string): ApprovalStore {
  // The sessions directory is created lazily, by the first call that really writes (a lock or a state file), never when
  // the store is only built or asked a question it can answer from nothing: mode on-demand, or a call with no stored
  // state, creates no directory.

  // Defence in depth: a conversation id comes from hook stdin and ends up in file names, so it is normalised here
  // too (the hook entry already does). An id with nothing safe in it means "no stored state": no file I/O at all.
  const approvalsFile = (safeId: string) => path.join(sessionsDir, `${safeId}.approvals.json`);
  const lockDir = (safeId: string) => path.join(sessionsDir, `${safeId}.approvals.lock`);

  function withLock<T>(safeId: string, fn: () => T): T {
    privateDir(sessionsDir);
    return withDirLock(lockDir(safeId), fn);
  }

  /**
   * For a call that only reads (or writes nothing when there is no state): with no approvals file there is nothing to
   * read, race or change, so `fn` runs on the empty state without a lock and without creating the directory.
   */
  function withLockIfState<T>(safeId: string, fn: () => T): T {
    if (!fs.existsSync(approvalsFile(safeId))) return fn();
    return withLock(safeId, fn);
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

  const recordWithResult = (rawId: string, approval: Approval, consumedKeys?: string[], config?: ModeChangeConfigLike | null): Approval | null => {
    const sessionId = safeSessionId(rawId);
    if (!sessionId) return null;
    return withLock(sessionId, () => {
      const done = recordApproval(readState(sessionId), approval, approval.created_at, consumedKeys, config);
      if (!done) return null;
      writeState(sessionId, done.state);
      return done.approval;
    });
  };

  return {
    record: (rawId, approval, consumedKeys, config) => recordWithResult(rawId, approval, consumedKeys, config) !== null,
    recordWithResult,
    recordAndClaim: (rawId, approval, consumedKeys, ectx) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return { stored: false, approval: null };
      return withLock(sessionId, () => {
        const recorded = recordApproval(readState(sessionId), approval, approval.created_at, consumedKeys, ectx?.config);
        if (!recorded) return { stored: false, approval: null };
        const { state, approval: claimed } = claimApproval(recorded.state, recorded.approval.model, approval.created_at, undefined, ectx);
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
    claim: (rawId, requested, nowMs, effort, ectx) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => {
        const { state, approval } = claimApproval(readState(sessionId), requested, nowMs, effort, ectx);
        if (approval?.scope === 'once') writeState(sessionId, state);
        return approval;
      });
    },
    recordDecline: (rawId, decline, consumedKeys) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const done = recordDecline(readState(sessionId), decline, consumedKeys);
        if (!done) return false;
        writeState(sessionId, done.state);
        return true;
      });
    },
    recordDeclineAndClaim: (rawId, decline, consumedKeys, ectx) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return { stored: false, decline: null };
      return withLock(sessionId, () => {
        const done = recordDecline(readState(sessionId), decline, consumedKeys);
        if (!done) return { stored: false, decline: null };
        const claimed = claimDecline(done.state, decline.model, ectx);
        writeState(sessionId, claimed.state);
        return { stored: true, decline: claimed.decline };
      });
    },
    claimDecline: (rawId, requested, _nowMs, ectx) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => {
        const { state, decline } = claimDecline(readState(sessionId), requested, ectx);
        if (decline?.scope === 'once') writeState(sessionId, state);
        return decline;
      });
    },
    peekDecline: (rawId, requested, _nowMs, ectx) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => claimDecline(readState(sessionId), requested, ectx, false).decline);
    },
    snapshot: (rawId) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return { approvals: [] };
      return withLockIfState(sessionId, () => readState(sessionId));
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
      return withLockIfState(sessionId, () => {
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
    notePendingQuestion: (rawId, model, stepIdx, nowMs, markerIndex) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return false;
      return withLock(sessionId, () => {
        const next = notePendingQuestion(readState(sessionId), model, stepIdx, nowMs, markerIndex);
        if (!next) return false;
        writeState(sessionId, next);
        return true;
      });
    },
    getPendingQuestion: (rawId, model, config) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => getPendingQuestion(readState(sessionId), model, config));
    },
    clearPendingQuestion: (rawId, model) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return;
      withLockIfState(sessionId, () => {
        const next = clearPendingQuestion(readState(sessionId), model);
        if (next) writeState(sessionId, next);
      });
    },
    getAnswerStep: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => getAnswerStep(readState(sessionId), model, nowMs));
    },
    getAnswerQuestion: (rawId, model, nowMs) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return null;
      return withLockIfState(sessionId, () => getAnswerQuestion(readState(sessionId), model, nowMs));
    },
    getConsumedAnswers: (rawId) => {
      const sessionId = safeSessionId(rawId);
      if (!sessionId) return [];
      return withLockIfState(sessionId, () => readState(sessionId).consumedAnswers ?? []);
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
  /**
   * The `step_index` of the answer row of the `ask_question` that carries this question, recorded by PostToolUse (its
   * `stepIdx`) even when the row was not written yet. The PreToolUse pull reads only that row: real transcripts carry no
   * tool call ids, and a tool that ran in parallel with the ask can put its own output row first.
   */
  answer_step?: number;
  /** The question index (0 = A1) of this question inside that answer row, recorded with `answer_step`. */
  answer_q?: number;
};

/** Whether an entry already carries `askId` as the key of the answer that closed it (one answer closes one entry). */
const askIdConsumed = (entries: DowngradeEntry[], askId: string): boolean =>
  (entries as AskEntry[]).some((e) => e.ask_id === askId);

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
 * How long an unanswered question can still be answered. The 10-minute window (`expires_at`) decides when a question is
 * asked again; a user can leave the dialog open longer than that, and their answer must still count, so an unanswered
 * entry stays answerable (and is kept by every write) for this long from the time it was asked.
 */
export const DOWNGRADE_ANSWER_WINDOW_MS = 60 * 60 * 1000;

/** How many characters of a delegation's signature the question marker carries: `[jev-downgrade:flash_lite:<sig8>]`. */
export const DOWNGRADE_MARKER_SIG_CHARS = 8;

const isPending = (e: DowngradeEntry): boolean => !e.answered && e.from === DOWNGRADE_ALIAS;

/** Whether an unanswered entry has run out of its 10-minute window but can still be answered. */
const isLatePending = (e: DowngradeEntry, nowMs: number): boolean =>
  isPending(e) && e.expires_at <= nowMs && typeof e.asked_at === 'number' && e.asked_at + DOWNGRADE_ANSWER_WINDOW_MS > nowMs;

/** The entries a write keeps: the live ones, plus the unanswered ones still inside their answer window. */
function answerable(state: DowngradeState, nowMs: number): DowngradeEntry[] {
  return state.entries.filter((e) => e.expires_at > nowMs || isLatePending(e, nowMs));
}

/**
 * Pure: `next` with the late-but-answerable questions of `prev` put back (the shared helpers drop them after 10 minutes).
 * `superseded` is the signature of a delegation that was just asked again: its older late question is NOT put back, so the
 * delegation has one live question and a plain-marker answer closes it entirely (not just the older of two).
 */
export function retainAnswerable(prev: DowngradeState, next: DowngradeState, nowMs: number, superseded?: string): DowngradeState {
  const kept = prev.entries.filter((e) => isLatePending(e, nowMs) && !(superseded !== undefined && e.signature === superseded));
  if (kept.length === 0) return next;
  const have = new Set(next.entries.map((e) => `${e.signature}|${e.asked_at}`));
  const entries = [...kept.filter((e) => !have.has(`${e.signature}|${e.asked_at}`)), ...next.entries].slice(-MAX_ENTRIES);
  return { ...next, entries };
}

/**
 * Pure: record the user's answer for ONE delegation, once.
 *   `sig` (the first characters of a signature, from the marker `[jev-downgrade:flash_lite:<sig8>]`): the pending question
 *   of that delegation is closed, and no other. An answer for a delegation nothing is pending for records nothing.
 *   no `sig` (the plain marker): the OLDEST pending question is closed, and no other, so one answer can never decide
 *   two delegations; the next answer closes the next one.
 * The entry is marked answered with the label and the answer's tool call id, so the same answer read again finds nothing
 * pending. With no matching pending question the state is returned unchanged and `recorded` is false: an answer nobody asked
 * for covers no call. A question older than 10 minutes can still be answered (see `DOWNGRADE_ANSWER_WINDOW_MS`).
 */
export function answerAskDowngrade(
  state: DowngradeState,
  choice: DowngradeChoice,
  askId: string | undefined,
  nowMs: number,
  sig?: string | null
): { state: DowngradeState; recorded: boolean } {
  const entries = answerable(state, nowMs);
  // One answer, one delegation: an answer row (and question) that already closed an entry cannot close another, however
  // many times its PostToolUse is delivered or in which order the pull and the recorder see it.
  if (askId && askIdConsumed(entries, askId)) return { state, recorded: false };
  const wanted = typeof sig === 'string' && sig ? sig.toLowerCase() : null;
  const target = wanted
    ? entries.filter((e) => isPending(e) && typeof e.signature === 'string' && e.signature.startsWith(wanted))
    : entries.filter(isPending).slice(0, 1);
  if (target.length === 0) return { state, recorded: false };
  const next = entries.map((e) =>
    target.includes(e)
      ? ({ ...e, answered: true, chosen: STORED_LABEL[choice], ...(askId ? { ask_id: askId } : {}), expires_at: nowMs + DOWNGRADE_TTL_MS } as AskEntry)
      : e
  );
  const base = withRatings(state, next.slice(-MAX_ENTRIES), nowMs);
  return { state: choice === 'off' ? { ...base, off: state.off ?? { at: nowMs } } : base, recorded: true };
}

/**
 * Pure: record `stepIdx`, the step_index of the answer row of an ask, against the pending question(s) it carries.
 *   `sig` (the first characters of a signature, from the signed marker): the pending question of that delegation.
 *   no `sig` (the plain marker): the OLDEST pending question that has no row recorded yet, so two plain questions of one ask
 *   land on two entries, as their answers will.
 * Nothing is recorded when no such question is pending (an answered question keeps nothing: it is closed).
 */
export function noteAskAnswerStep(
  state: DowngradeState,
  stepIdx: number,
  nowMs: number,
  sig?: string | null,
  questionIndex?: number
): { state: DowngradeState; recorded: boolean } {
  if (!Number.isInteger(stepIdx) || stepIdx < 0) return { state, recorded: false };
  if (questionIndex !== undefined && (!Number.isInteger(questionIndex) || questionIndex < 0)) return { state, recorded: false };
  const entries = answerable(state, nowMs) as AskEntry[];
  // A row and question that already closed an entry are not recorded onto another one (a late PostToolUse, or a pull
  // that consumed the row first, would otherwise move that row onto the next pending question).
  if (askIdConsumed(entries, `step:${stepIdx}#${questionIndex ?? 0}`)) return { state, recorded: false };
  const wanted = typeof sig === 'string' && sig ? sig.toLowerCase() : null;
  const target = wanted
    ? entries.filter((e) => isPending(e) && typeof e.signature === 'string' && e.signature.startsWith(wanted))
    : entries.filter((e) => isPending(e) && typeof e.answer_step !== 'number').slice(0, 1);
  if (target.length === 0) return { state, recorded: false };
  // The question index is stored only when the caller knows it; without it the pull reads the matched call's own line.
  const next = entries.map((e) => {
    if (!target.includes(e)) return e;
    const { answer_q: _stale, ...rest } = e;
    return { ...rest, answer_step: stepIdx, ...(questionIndex !== undefined ? { answer_q: questionIndex } : {}) } as AskEntry;
  });
  return { state: { ...state, entries: next.slice(-MAX_ENTRIES) }, recorded: true };
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

/**
 * Pure: the unanswered question for `signature` (when it was asked, at which step), plus the ask ids already consumed.
 * `oldest` is true when no older question is pending: only then may a plain marker (no signature in it) answer this one.
 */
export function pendingDowngradeAsk(
  state: DowngradeState,
  signature: string,
  nowMs: number
): { askedAt: number; askStep?: number; answerStep?: number; answerQuestion?: number; consumed: Set<string>; oldest: boolean } | null {
  const entries = live(state, nowMs) as AskEntry[];
  const pending = entries.find((e) => !e.answered && e.signature === signature && typeof e.asked_at === 'number');
  if (!pending) return null;
  const consumed = new Set(entries.flatMap((e) => (typeof e.ask_id === 'string' ? [e.ask_id] : [])));
  const oldest = answerable(state, nowMs).find(isPending) === pending;
  return {
    askedAt: pending.asked_at as number,
    ...(typeof pending.ask_step === 'number' ? { askStep: pending.ask_step } : {}),
    ...(typeof pending.answer_step === 'number' ? { answerStep: pending.answer_step } : {}),
    ...(typeof pending.answer_step === 'number' && typeof pending.answer_q === 'number' ? { answerQuestion: pending.answer_q } : {}),
    consumed,
    oldest
  };
}

export type DowngradeStore = {
  /** What is on record for a call before it is rated (see `peekDowngrade`). */
  peek: (sessionId: string, signature: string, nowMs: number) => ReturnType<typeof peekDowngrade>;
  /** Keep the delegation's rating for ten minutes, so a retry does not call the router again. */
  remember: (sessionId: string, signature: string, rating: TierRating, nowMs: number) => void;
  /** Write the question down (atomically: one parallel caller is `first`). */
  claim: (sessionId: string, signature: string, nowMs: number, stepIdx?: number) => DowngradeClaim;
  /** Record an answer once, for the delegation named by `sig` (or the oldest pending one); false when no such question was pending. */
  answer: (sessionId: string, choice: DowngradeChoice, askId: string | undefined, nowMs: number, sig?: string | null) => boolean;
  /** Record the answer row's step_index against the pending question(s) of the ask (see `noteAskAnswerStep`); false when none is pending. */
  noteAnswerStep?: (sessionId: string, stepIdx: number, nowMs: number, sig?: string | null, questionIndex?: number) => boolean;
  /**
   * Drop the pending (unanswered) questions that `stale` rejects, by the time they were asked: the ones that predate the last
   * mode change (`denialPredatesModeChange`). Returns how many were dropped; writes only when that is above 0.
   */
  voidStale?: (sessionId: string, stale: (askedAtMs: number) => boolean) => number;
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
      locked(sessionId, () => {
        const prev = read(sessionId);
        write(sessionId, retainAnswerable(prev, rememberRating(prev, signature, rating, nowMs), nowMs));
      }),
    claim: (sessionId, signature, nowMs, stepIdx) =>
      locked(sessionId, () => {
        const prev = read(sessionId);
        const { state, result } = claimAskDowngrade(prev, signature, nowMs, stepIdx);
        if (result === 'first') write(sessionId, retainAnswerable(prev, state, nowMs, signature));
        return result;
      }),
    answer: (sessionId, choice, askId, nowMs, sig) =>
      locked(sessionId, () => {
        const { state, recorded } = answerAskDowngrade(read(sessionId), choice, askId, nowMs, sig);
        if (recorded) write(sessionId, state);
        return recorded;
      }),
    noteAnswerStep: (sessionId, stepIdx, nowMs, sig, questionIndex) =>
      locked(sessionId, () => {
        const { state, recorded } = noteAskAnswerStep(read(sessionId), stepIdx, nowMs, sig, questionIndex);
        if (recorded) write(sessionId, state);
        return recorded;
      }),
    voidStale: (sessionId, stale) =>
      locked(sessionId, () => {
        const { state, voided } = voidStalePending(read(sessionId), stale);
        if (voided > 0) write(sessionId, state);
        return voided;
      }),
    choiceFor: (sessionId, signature, nowMs) => answeredDowngradeChoice(read(sessionId), signature, nowMs),
    pending: (sessionId, signature, nowMs) => pendingDowngradeAsk(read(sessionId), signature, nowMs)
  };
}
