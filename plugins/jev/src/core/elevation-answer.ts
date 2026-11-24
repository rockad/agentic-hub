/**
 * The rules an answer to the elevation question follows (2.3.21), shared by the Claude Code and Antigravity hooks. Pure: nothing
 * here reads a file, the environment or the clock.
 *
 * An answered marker question counts as given. There is no time window: the answer is the user's click (`tool_response` in Claude Code,
 * the answer row of the transcript in Antigravity, never what the assistant wrote), and it is recorded whether or not Jev denied
 * anything first. What stays is Jev's own effort cap: the effort Jev prescribed for the model is kept for the session with no expiry,
 * and an answer approves at most that effort (a question asked before any denial approves no effort, which stands for at most `high`).
 *
 * The question has exactly four options, in this order:
 *
 * - `Yes, once`: bound to the turn it was answered in (no clock), used by the first covering launch of that turn, dropped when a
 *   new user prompt starts. Claude Code: the prompt id (else the stored turn and its time). Antigravity: the hash of the last user
 *   input, the same per-prompt key the attempt counter uses.
 * - `Yes, for this session`.
 * - `No, proceed on <session model>` (the effort question: `No, run at <level>`): this delegation only, i.e. the next launch of
 *   that model in the same turn runs on the session model without another deny.
 * - `No, don't ask again this session`: every later launch of that model (or a stronger one) is clamped to the session model silently.
 */

import { effortIndex, effortWithin } from './cost-gate.js';
import type { CostEffort } from './cost-estimate.js';

export type AnswerKind = 'model' | 'effort';
export type AnswerScope = 'once' | 'session';

/** The exact labels of the four options. The `No` of the model question names the session model, the effort question's the level. */
export const ELEVATION_LABELS = {
  yesOnce: 'Yes, once',
  yesSession: 'Yes, for this session',
  noOncePrefix: 'No, proceed on ',
  noEffortPrefix: 'No, run at ',
  noSession: "No, don't ask again this session",
  noOnce: (sessionAlias: string): string => `No, proceed on ${sessionAlias}`,
  noEffort: (level: string): string => `No, run at ${level}`
} as const;

/** The four labels of the question, in order, for a reason text. `noLabel` is the harness's own `No, proceed on <alias>` or `No, run at <level>`. */
export function elevationLabelList(noLabel: string): string {
  const l = ELEVATION_LABELS;
  return `'${l.yesOnce}', '${l.yesSession}', '${noLabel}', "${l.noSession}"`;
}

/** An answer text as a comparable label: the `(Recommended)` tag (prefix or suffix) and typographic apostrophes are normalised away. */
export function normalizeAnswerLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^\(Recommended\)\s+/i, '')
    .replace(/\s+\(Recommended\)$/i, '')
    .replace(/[‘’ʼ]/g, "'")
    .trim();
}

export type ParsedAnswer = {
  answer: 'yes' | 'no';
  scope: AnswerScope;
  /** The text after `No, proceed on ` / `No, run at ` (the session alias, or the effort level); absent for the other labels. */
  noTarget?: string;
};

const NO_TARGET_MAX = 80;

/**
 * The answer a label stands for, or null when it is not one of the four exact labels (free text, a missing answer, a label with
 * something added). Matching is exact (no substring): "No, not even once" is not an answer. For the `No` of the question, `noTarget`
 * is the session model (model question) or the level (effort question) the label names.
 */
export function parseAnswerLabel(raw: unknown, kind: AnswerKind): ParsedAnswer | null {
  const label = normalizeAnswerLabel(raw);
  if (!label) return null;
  const l = ELEVATION_LABELS;
  if (label === l.yesOnce) return { answer: 'yes', scope: 'once' };
  if (label === l.yesSession) return { answer: 'yes', scope: 'session' };
  if (label === l.noSession) return { answer: 'no', scope: 'session' };
  const prefix = kind === 'model' ? l.noOncePrefix : l.noEffortPrefix;
  if (label.startsWith(prefix)) {
    const target = label.slice(prefix.length).trim();
    if (target && target.length <= NO_TARGET_MAX && !/[\r\n]/.test(target)) return { answer: 'no', scope: 'once', noTarget: target };
  }
  return null;
}

/** A once answer is live only in the turn it was given in; a session one always. A once with no turn (an old file) never is. */
export function onceLive(a: { scope: AnswerScope; turn?: string }, turn: string | undefined): boolean {
  return a.scope === 'session' || (a.turn !== undefined && turn !== undefined && a.turn === turn);
}

/** The `once` entries of a list that were used by a launch of this turn: `{ key, turn }`. Bounded, newest last. */
export type OnceUsed = { key: string; turn: string };
export const ONCE_USED_CAP = 16;

/** Pure: `used` with `key` marked as used in `turn`, other turns' marks dropped, bounded. */
export function markOnceUsed(used: readonly OnceUsed[] | undefined, key: string, turn: string | undefined): OnceUsed[] {
  if (turn === undefined) return [...(used ?? [])].slice(-ONCE_USED_CAP);
  return [...(used ?? []).filter((u) => u.turn === turn && u.key !== key), { key, turn }].slice(-ONCE_USED_CAP);
}

/** What Jev has stored for a model (or an effort level) when it denies: nothing, a once used or dropped, or an approval below the effort asked. */
export type StoredKind = 'none' | 'once-used' | 'once-stale' | 'effort-below';

export type StoredFacts = {
  kind: AnswerKind;
  /** The model alias the question is about (model question), or the effort level (effort question). */
  subject: string;
  /** Every stored approval that covers the subject by model (or level) alone: its scope, the turn of a once, and the effort it stands for. */
  covering: ReadonlyArray<{ scope: AnswerScope; turn?: string; effort: CostEffort }>;
  turn: string | undefined;
  /** The effort this call asks (the call's own at the cost gate, else none: only an approval's own effort is compared when it is given). */
  neededEffort?: CostEffort;
  /** A once approval covering the subject was used by an earlier launch of this turn. */
  onceUsedThisTurn: boolean;
};

export type StoredClause = { stored: StoredKind; text: string };

/**
 * The clause a deny reason adds, saying what Jev has stored. In order of precedence:
 * - `effort-below`: a live approval covers the model but only up to a lower effort than this call asks;
 * - `once-used`: the once approval was used by an earlier launch in this turn;
 * - `once-stale`: a once approval is stored, from an earlier turn, so it was dropped;
 * - `none`.
 */
export function storedClause(f: StoredFacts): StoredClause {
  const live = f.covering.filter((a) => onceLive(a, f.turn));
  const needed = f.neededEffort;
  if (needed && live.length > 0 && !live.some((a) => effortWithin(a.effort, needed))) {
    const top = [...live].sort((a, b) => effortIndex(b.effort) - effortIndex(a.effort))[0];
    const what = f.kind === 'effort' ? `effort up to ${top.effort}` : `${f.subject} up to ${top.effort}`;
    return { stored: 'effort-below', text: `Stored: the ${top.scope} approval covers ${what}; this call asks ${needed}.` };
  }
  if (f.onceUsedThisTurn) return { stored: 'once-used', text: 'Stored: the once approval was used by an earlier launch in this turn.' };
  if (f.covering.some((a) => a.scope === 'once' && !onceLive(a, f.turn))) {
    return { stored: 'once-stale', text: 'Stored: a once approval from an earlier turn was dropped.' };
  }
  return { stored: 'none', text: f.kind === 'effort' ? `Stored: no approval for effort ${f.subject} in this session.` : `Stored: no approval for ${f.subject} in this session.` };
}

/** The effort an answer approves: the marker's, held to the one Jev prescribed. With none prescribed, or none in the marker, it carries no effort (at most `high`). */
export function cappedEffort(marker: CostEffort | undefined, prescribed: CostEffort | undefined): CostEffort | undefined {
  if (!marker || !prescribed) return undefined;
  return effortIndex(marker) <= effortIndex(prescribed) ? marker : prescribed;
}

// ── What the assistant is told, and what the log row says ─────────────────────────────────────────────────────────

export type NotRecordedReason = 'label' | 'marker' | 'mode' | 'write';

const scopeWords = (scope: AnswerScope): string => (scope === 'once' ? 'once (this turn)' : 'for this session');

/** `[jev] Recorded: opus, once (this turn) up to high. Relaunch now.` (the effort question names the level instead of a model). */
export function recordedYesLine(a: { kind: AnswerKind; subject: string; scope: AnswerScope; effort?: CostEffort | null }): string {
  if (a.kind === 'effort') return `[jev] Recorded: effort ${a.subject}, ${scopeWords(a.scope)}. Relaunch now.`;
  return `[jev] Recorded: ${a.subject}, ${scopeWords(a.scope)} up to ${a.effort ?? 'high'}. Relaunch now.`;
}

/** `[jev] Recorded: No for opus for this session; launches run on sonnet.` */
export function recordedNoLine(a: { kind: AnswerKind; subject: string; scope: AnswerScope; target: string }): string {
  const what = a.kind === 'effort' ? `effort ${a.subject}` : a.subject;
  const run = a.kind === 'effort' ? `launches run at ${a.target}` : `launches run on ${a.target}`;
  if (a.scope === 'session') return `[jev] Recorded: No for ${what} for this session; ${run}.`;
  return `[jev] Recorded: No for ${what} for this delegation (this turn); the next launch ${a.kind === 'effort' ? 'runs at' : 'runs on'} ${a.target}.`;
}

const REASON_TEXT: Record<NotRecordedReason, (kind: AnswerKind, markerHint: string, noLabel: string) => string> = {
  label: (_k, _m, noLabel) =>
    `the answer was not one of the four exact labels. Ask again with exactly these options: ${elevationLabelList(noLabel)}`,
  marker: (_k, markerHint) =>
    `the question's marker is malformed or names an unknown model. Ask again with a question that starts with ${markerHint}`,
  mode: () => 'Jev is not on, so nothing is stored. Launch on the session model, or have the user run /jev on and ask again',
  write: () => 'the state file could not be written. Ask the question again; if it keeps failing, launch on the session model'
};

/** Queued for the assistant when an answer's row was not readable yet and the question was not prescribed by Jev (Antigravity): the next launch reads it. */
export const ANSWER_PENDING_LINE = '[jev] Answer not read yet; it is recorded at the next launch.';

/** `[jev] Not recorded: <reason>. <what to do>.` `noLabel` is the harness's own No label (`No, proceed on <alias>`, `No, run at <level>`). */
export function notRecordedLine(reason: NotRecordedReason, kind: AnswerKind, markerHint: string, noLabel: string): string {
  return `[jev] Not recorded: ${REASON_TEXT[reason](kind, markerHint, noLabel)}.`;
}

/**
 * The fields every `elevation_answer` row carries (the decisions log and the telemetry row alike); the harness adds the session, the
 * turn, its join key (`toolUseId` or `callKey`) and the mode. `effort` is the cap stored (null when none); `recorded: false` carries a `reason`.
 */
export function elevationAnswerFields(a: {
  kind: AnswerKind;
  model: string | null;
  effort: CostEffort | null;
  answer: 'yes' | 'no' | null;
  scope: AnswerScope | null;
  recorded: boolean;
  reason?: NotRecordedReason;
}): Record<string, unknown> {
  return {
    event: 'elevation_answer',
    kind: a.kind,
    model: a.model,
    effort: a.effort,
    answer: a.answer,
    scope: a.scope,
    recorded: a.recorded,
    ...(a.recorded ? {} : { reason: a.reason ?? 'label' })
  };
}
