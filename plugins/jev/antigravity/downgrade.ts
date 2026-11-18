/**
 * Jev downgrade choice for Antigravity `invoke_subagent` (`[jev-downgrade:flash_lite]`), the counterpart of the Claude Code
 * flow in `claude/downgrade.ts` / `claude/hook.ts`. A subagent that would run on `flash` is rated on its own text by Jev's
 * router; when `P(openrouter_free) + P(flash_lite)` reaches the threshold (0.6), the call is either denied once with the
 * prescribed `ask_question` (mode `ask`) or rewritten to run on `flash_lite` (mode `auto`, `allow` + `overwrite`).
 *
 * It runs only AFTER the v2.3.16 checks of `evaluateAntigravitySubagentCall` have passed the call, so it can never turn a
 * deny, an ask or an elevation decision into an allow. Everything fails open: a slow or failing router, a missing key,
 * an unreadable state or a transcript that cannot be read leaves the call as it was. The task text itself never reaches
 * a log, only its length and a short hash.
 */
import { createHash } from 'node:crypto';
import { dispatchQuestions } from '../claude/logic.js';
import type { JevMode } from '../src/core/config.js';
import { isOrchestratorModel, modelTierRank } from '../src/core/governance.js';
import { parseDowngradeMode } from '../src/core/downgrade-config.js';
import { downgradeMode, neededTier, parseTierRating, resolveMinProbability, SESSION_OFF_LABEL, type TierRating } from '../src/core/downgrade-state.js';
import { taskFingerprint } from '../src/core/telemetry.js';
import { withTimeout } from '../src/core/with-timeout.js';
import { callJev } from '../src/core/client.js';
import { DOWNGRADE_ALIAS, DOWNGRADE_MARKER_SIG_CHARS, type DowngradeChoice, type DowngradeStore } from './approvals.js';
import { answerLabel, askAnswerKey, extractSubagentModel, pullAskAnswerFromTranscript, type AntigravityHookDecision, type AntigravityHookInput } from './logic.js';

export { askAnswerKey };

/**
 * The plain marker the downgrade question starts with. The question Jev prescribes carries the delegation's short
 * signature inside it (`[jev-downgrade:flash_lite:<sig8>]`, see `downgradeMarker`), so an answer is bound to ONE delegation;
 * the plain form is still accepted and then answers only the oldest pending question.
 */
export const DOWNGRADE_MARKER = `[jev-downgrade:${DOWNGRADE_ALIAS}]`;
export const DOWNGRADE_MARKER_PREFIX = '[jev-downgrade:';

/** The marker of one delegation's question: `[jev-downgrade:flash_lite:<first 8 characters of its signature>]`. */
export function downgradeMarker(signature: string): string {
  return `${DOWNGRADE_MARKER_PREFIX}${DOWNGRADE_ALIAS}:${signature.slice(0, DOWNGRADE_MARKER_SIG_CHARS).toLowerCase()}]`;
}

const MARKER_AT_START = new RegExp(`^\\[jev-downgrade:${DOWNGRADE_ALIAS}(?::([0-9a-f]{${DOWNGRADE_MARKER_SIG_CHARS}}))?\\]`);

/**
 * Pure: the marker a question text STARTS with: `{ sig: null }` for the plain marker, `{ sig }` for the signed one, null
 * when the text does not start with a downgrade marker (a question that merely mentions it does not count).
 */
export function parseDowngradeMarker(text: string): { sig: string | null } | null {
  const m = MARKER_AT_START.exec(text.trim().toLowerCase());
  return m ? { sig: m[1] ?? null } : null;
}

/** The three prescribed answers, in the order the question lists them. */
export const DOWNGRADE_LABELS = {
  yes: 'Yes, flash_lite',
  keep: 'No, keep flash',
  off: SESSION_OFF_LABEL
} as const;

/** The per-delegation rating at PreToolUse: well inside the hook's 10 s budget; a slow router means no question. */
export const DOWNGRADE_RATING_TIMEOUT_MS = 1500;
/** How much of a delegation's prompt goes to the router with its role. */
export const DOWNGRADE_TASK_PROMPT_CHARS = 1000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Model-supplied text reaches the reason: keep only safe characters and a bounded length. */
function safeText(text: unknown, max = 60): string {
  return typeof text === 'string' ? text.replace(/[^A-Za-z0-9:_.\/-]/g, '').slice(0, max) : '';
}

/** The text a delegation is rated on: its role and the first 1000 characters of its prompt. Empty when it has neither. */
export function delegationTask(args: Record<string, unknown> | undefined): string {
  const part = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return [part(args?.Role ?? args?.role, 300), part(args?.Prompt ?? args?.prompt, DOWNGRADE_TASK_PROMPT_CHARS)].filter(Boolean).join('\n\n');
}

/**
 * Pure: a stable signature of what a delegation is (type, role and the start of the prompt), as a SHA-256 hex prefix, so a
 * question, an answer and a cached rating can say "the same delegation" without storing task text. The model is not part
 * of it: a call that asks for `flash` and the same call with the model omitted are one delegation.
 */
export function downgradeSignature(args: Record<string, unknown> | undefined): string {
  const text = [
    str(args?.TypeName ?? args?.typeName),
    str(args?.Role ?? args?.role),
    str(args?.Prompt ?? args?.prompt).slice(0, DOWNGRADE_TASK_PROMPT_CHARS)
  ].join('\u0000');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ── The question and its answer ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The deny reason of the downgrade question. A PreToolUse `deny` does not stop the turn: the assistant gets this text,
 * keeps working and is told to ask the one prescribed question.
 */
export function downgradeReason(opts: {
  typeName: unknown;
  inherited: boolean;
  neededTier: string;
  cumulative: number;
  real: boolean;
  /** The delegation's signature: the marker the question must start with then names it. Absent: the plain marker. */
  signature?: string;
}): string {
  const marker = opts.signature ? downgradeMarker(opts.signature) : DOWNGRADE_MARKER;
  const type = safeText(opts.typeName) || 'subagent';
  const evidence = `Jev rates this ${opts.neededTier}${opts.neededTier === 'openrouter_free' ? '' : ' or cheaper'}${opts.real ? `, ${Math.round(opts.cumulative * 100)}%` : ''}`;
  const requested = opts.inherited ? 'no Model (it would run on flash, the session model)' : "Model 'flash'";
  return (
    `[jev] Subagent '${type}' was invoked with ${requested}, but ${evidence}, and the user did not ask for flash. ` +
    `Ask the user with ask_question: one question whose text STARTS with the marker ${marker} exactly as written, followed by a short question ` +
    `naming the subagent (${type}) and offering flash_lite for it, with exactly three options in this order: ` +
    `'${DOWNGRADE_LABELS.yes}', '${DOWNGRADE_LABELS.keep}', '${DOWNGRADE_LABELS.off}'. ` +
    `Then invoke the subagent again with Model 'flash_lite' on Yes, or with Model 'flash' on either No; do not stop and do not ask in any other form.`
  );
}

/**
 * Whether an answer is one of the three prescribed labels, EXACTLY (after the `A1:` prefix and a `(Recommended)` tag are
 * removed; a typographic apostrophe in "don't" is the same label). Free text, `No, keep flash_lite`, a label with extra
 * words and a missing answer give null: nothing is recorded for them.
 */
export function parseDowngradeAnswer(answerText?: string | null): DowngradeChoice | null {
  if (!answerText || typeof answerText !== 'string') return null;
  const label = answerLabel(answerText).replace(/’/g, "'");
  if (label === DOWNGRADE_LABELS.yes) return 'yes';
  if (label === DOWNGRADE_LABELS.keep) return 'keep';
  if (label === DOWNGRADE_LABELS.off) return 'off';
  return null;
}

/** The text of a question entry (`ask_question` takes strings or `{ question }` objects). */
export function questionText(q: unknown): string {
  if (typeof q === 'string') return q;
  if (q && typeof q === 'object') return str((q as Record<string, unknown>).question);
  return '';
}

/**
 * Every question that starts with a downgrade marker, with its index (the answer line is `A<index + 1>`) and the signature
 * prefix its marker carries (null for the plain marker). A question that merely mentions the marker further in does not
 * count: the question is the one Jev prescribed, and it starts with it.
 */
export function findDowngradeQuestions(questions: unknown): Array<{ index: number; sig: string | null }> {
  if (Array.isArray(questions)) {
    return questions.flatMap((q, index) => {
      const m = parseDowngradeMarker(questionText(q));
      return m ? [{ index, sig: m.sig }] : [];
    });
  }
  const m = typeof questions === 'string' ? parseDowngradeMarker(questions) : null;
  return m ? [{ index: 0, sig: m.sig }] : [];
}

/** The index of the first question that starts with the downgrade marker, or null. */
export function findDowngradeQuestion(questions: unknown): number | null {
  return findDowngradeQuestions(questions)[0]?.index ?? null;
}

// ── The rating ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The per-delegation tier rating: the tier question alone, for the delegation's own text; null on any failure (the caller times it out). */
export async function liveRateTask(task: string, signal?: AbortSignal): Promise<TierRating | null> {
  try {
    const data = await callJev(`Task: ${task}`, { recommendedTier: dispatchQuestions().recommendedTier }, signal);
    return parseTierRating(data);
  } catch {
    return null;
  }
}

// ── The evaluation ──────────────────────────────────────────────────────────────────────────────────────────────────

export type DowngradeDeps = {
  /** The per-conversation downgrade store. Absent: no downgrade evaluation at all. */
  store?: DowngradeStore;
  /** The Jev mode. The downgrade runs only in `on` (as on Claude Code); `on-demand` and `off` leave the call alone. */
  jevMode?: JevMode;
  /** The session model the call would inherit (the one the ceiling uses). */
  sessionModel?: string | null;
  env?: Record<string, string | undefined>;
  /** The configured `models.downgrade.mode` (the environment's JEV_DOWNGRADE wins). */
  downgradeConfig?: () => string | undefined;
  /** The configured `models.downgrade.minProbability` (JEV_DOWNGRADE_MIN_PROBABILITY wins); absent means 0.6. */
  downgradeMinProbability?: () => number | undefined;
  /** Jev's tier rating of a task text. Null on any failure. Absent: no rating, so no downgrade. */
  rateTask?: (task: string, signal?: AbortSignal) => Promise<TierRating | null>;
  /** False when the egress policy forbids sending the task from this directory. */
  egressAllowed?: (cwd?: string) => boolean;
  now?: () => number;
  ratingTimeoutMs?: number;
};

export type DowngradeResult = { decision: AntigravityHookDecision; log: Record<string, unknown> };

const safely = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

// A user who names flash outranks the advice ("use flash for the sweep"); "not flash" does not count.
const FLASH_IMPERATIVE =
  /(?<![\w-])(?:use|using|run|launch|spawn|start|delegate\s+to|go\s+with|switch\s+to|want|prefer|choose|pick|select)\s+(?:an?\s+|the\s+|only\s+)?(?:gemini[\s-]*)?(?:[0-9.]+[\s-]*)?flash(?![\w-]*[\s_-]*lite)(?![\w-])/gi;
const NEGATION = /\b(?:don'?t|do\s+not|never|not|no|without|avoid|stop|instead\s+of|rather\s+than)\s+(?:[\w'-]+\s+){0,2}$/i;

/** Whether the user's own words ask for flash: their instruction outranks the advice. */
export function userNamedFlash(prompt: unknown): boolean {
  const text = str(prompt).slice(0, 1500);
  for (const m of text.matchAll(FLASH_IMPERATIVE)) {
    if (!NEGATION.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * The downgrade for a call the v2.3.16 checks passed. `base` is that verdict: anything but `pass` is returned untouched, so
 * this can never turn a deny, an ask or an elevation into an allow. The returned `log` holds the `downgrade*` fields of the
 * decisions-log row and is empty when the call is not a downgrade candidate at all.
 *
 *   explicit `Model: "flash"`, or `Model` omitted/`inherit` on a standard `flash` session when a downgrade mode is configured
 *   (under Orchestrator an omitted/`inherit` Model never gets here: the explicit-Model rule decided it first);
 *   mode `ask` (default): deny once with the `[jev-downgrade:flash_lite]` question;
 *   mode `auto`: `allow` + `overwrite: { Model: "flash_lite" }`.
 */
export async function applyAntigravityDowngrade(
  input: AntigravityHookInput,
  base: AntigravityHookDecision,
  deps: DowngradeDeps = {}
): Promise<DowngradeResult> {
  const log: Record<string, unknown> = {};
  const unchanged = (): DowngradeResult => ({ decision: base, log });
  if (base.decision !== 'pass') return unchanged();
  const args = input.toolCall?.args;
  if (input.toolCall?.name !== 'invoke_subagent' || !args || typeof args !== 'object') return unchanged();

  const env = deps.env ?? {};
  const configured = safely(() => deps.downgradeConfig?.());
  const mode = downgradeMode(env, configured);
  if (mode === 'off') return unchanged();

  // Which calls are candidates: explicit flash, or an omitted/inherit Model on a standard flash session.
  const { requestedModel, isExplicit } = extractSubagentModel(args);
  const hasSubagentArray = Array.isArray(args.Subagents) || Array.isArray(args.subagents);
  const sessionModel = deps.sessionModel ?? null;
  const inheritsFlash =
    !isExplicit &&
    !!sessionModel &&
    !isOrchestratorModel(sessionModel) &&
    /flash/i.test(sessionModel) &&
    !/lite/i.test(sessionModel) &&
    modelTierRank(sessionModel) === 2;
  const explicitFlash = isExplicit && requestedModel === 'flash';
  if (hasSubagentArray || !(explicitFlash || inheritsFlash)) return unchanged();

  const skip = (reason: string): DowngradeResult => {
    log.downgrade = 'skipped';
    log.downgrade_skip = reason;
    return unchanged();
  };
  try {
    if ((deps.jevMode ?? 'on') !== 'on') return skip('jev-mode');
    // An omitted Model changes behaviour for every default call: it needs a downgrade mode that was set on purpose.
    const explicitlyConfigured = parseDowngradeMode(env.JEV_DOWNGRADE) !== null || parseDowngradeMode(configured) !== null;
    if (inheritsFlash && !explicitlyConfigured) return skip('not-configured');
    if (userNamedFlash(input.lastUserInput)) return skip('instructed');
    const store = deps.store;
    if (!store) return skip('no-store');
    const sessionId = input.conversationId;
    if (!sessionId) return skip('no-session');
    const nowMs = (deps.now ?? Date.now)();
    const signature = downgradeSignature(args);

    const peek = safely(() => store.peek(sessionId, signature, nowMs));
    if (!peek) return skip('store-error');
    if (peek.off) return skip('session-off');

    const applied = (via: string): DowngradeResult => {
      const key = typeof args.Model === 'string' || typeof args.model !== 'string' ? 'Model' : 'model';
      log.downgrade = 'applied';
      log.downgrade_from = 'flash';
      log.downgrade_to = 'flash_lite';
      log.downgrade_via = via;
      return { decision: { decision: 'allow', overwrite: { [key]: 'flash_lite' } }, log };
    };
    const byAnswer = (choice: DowngradeChoice | null, pulled: boolean): DowngradeResult => {
      if (pulled) log.downgrade_pull = true;
      if (choice === 'yes') return applied('answer');
      if (choice === 'off') return skip('session-off');
      log.downgrade = 'answered';
      return unchanged();
    };

    // An answer on record for this delegation: Yes runs it on flash_lite, either No lets it through as it is.
    if (peek.answered) return byAnswer(safely(() => store.choiceFor(sessionId, signature, nowMs)) ?? null, false);

    if (mode === 'ask' && peek.asked) {
      // Asked, not answered: the PostToolUse recorder may not have seen the answer row (it can arrive after PostToolUse
      // returns). Pull it from the transcript tail now; a question whose answer was recorded already never counts again.
      const pending = safely(() => store.pending(sessionId, signature, nowMs));
      if (pending && input.transcriptPath) {
        // Only a question that starts with this delegation's own marker counts; the plain marker only while no older
        // question is pending (the same rule the recorder uses), so one delegation never reads another's answer.
        const sigPrefix = signature.slice(0, DOWNGRADE_MARKER_SIG_CHARS);
        const ownQuestion = (text: string): boolean => {
          const m = parseDowngradeMarker(text);
          return !!m && (m.sig === null ? pending.oldest : m.sig === sigPrefix);
        };
        const pulled = pullAskAnswerFromTranscript(input.transcriptPath, DOWNGRADE_MARKER, {
          deniedAtMs: pending.askedAt,
          afterStepIdx: pending.askStep,
          excludeToolCallIds: pending.consumed,
          matches: ownQuestion
        });
        const choice = pulled ? parseDowngradeAnswer(pulled.raw) : null;
        const askId = pulled ? askAnswerKey(pulled.toolCallId, pulled.questionIndex ?? 0) : undefined;
        if (choice && safely(() => store.answer(sessionId, choice, askId, nowMs, sigPrefix))) {
          return byAnswer(safely(() => store.choiceFor(sessionId, signature, nowMs)) ?? choice, true);
        }
      }
      // Asked at most once per delegation in the window: the retry passes even if the assistant skipped the question.
      return skip('already-asked');
    }

    // Rate the delegation (once per signature in the window).
    const task = delegationTask(args);
    let rating = peek.rating;
    if (rating) {
      log.downgrade_rating = 'cached';
    } else {
      if (!deps.rateTask) return skip('no-router');
      if (!task) return skip('no-task');
      if (deps.egressAllowed && !deps.egressAllowed(input.cwd ?? input.workspacePaths?.[0])) return skip('egress');
      const started = performance.now();
      try {
        const rate = deps.rateTask;
        rating = await withTimeout((signal) => rate(task, signal), deps.ratingTimeoutMs ?? DOWNGRADE_RATING_TIMEOUT_MS);
      } catch {
        rating = null;
      }
      log.downgrade_rating_ms = Math.round(performance.now() - started);
      if (!rating) return skip('no-rating');
      const fresh = rating;
      safely(() => store.remember(sessionId, signature, fresh, nowMs));
    }
    // The task itself never reaches a log: its length and a short hash only.
    if (task) Object.assign(log, taskFingerprint(task));

    const minProbability = resolveMinProbability(env, safely(() => deps.downgradeMinProbability?.()));
    const needed = neededTier(rating, minProbability);
    log.downgrade_needed = needed.tier;
    log.downgrade_probability = Math.round(needed.cumulative * 100) / 100;
    log.downgrade_rated = rating.choice;
    // P(openrouter_free + flash_lite) >= threshold: the needed tier is flash_lite or cheaper.
    if (needed.tier !== 'openrouter_free' && needed.tier !== 'flash_lite') return skip('not-needed');
    log.downgrade_from = 'flash';
    log.downgrade_to = 'flash_lite';

    if (mode === 'auto') return applied('auto');

    const result = safely(() => store.claim(sessionId, signature, nowMs, input.stepIdx));
    if (result === undefined) return skip('store-error');
    if (result === 'answered') return byAnswer(safely(() => store.choiceFor(sessionId, signature, nowMs)) ?? null, false);
    if (result === 'asked') return skip('already-asked');
    log.downgrade = 'asked';
    return {
      decision: {
        decision: 'deny',
        reason: downgradeReason({
          typeName: args.TypeName ?? args.typeName,
          inherited: !explicitFlash,
          neededTier: needed.tier,
          cumulative: needed.cumulative,
          real: rating.real,
          signature
        })
      },
      log
    };
  } catch {
    return skip('error');
  }
}
