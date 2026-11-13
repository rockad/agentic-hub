/**
 * Jev downgrade choice, pure part (no I/O): when an Agent call asks for a model ABOVE the one Jev recommends for
 * the user's prompt, the hook offers the cheaper model through one prescribed AskUserQuestion (mode `ask`, the
 * default) or runs the call on the recommended alias (mode `auto`). `hook.ts` wires the store and the output.
 *
 * Everything here fails open: no catalogue, an unknown id or a malformed state means "no downgrade question".
 */
import { ladder, compareModels, parseModelId, resolveAlias } from '../src/core/catalogue.js';
import {
  compareClaudeModels,
  modelAlias,
  type AgentCall,
  type ClaudeModelAlias,
  type RankContext,
  type UserIntent
} from './logic.js';
import { parseDowngradeMode, type DowngradeMode } from '../src/core/downgrade-config.js';
import { ladderDefName } from '../src/refresh/ladder-agents.js';

export type { DowngradeMode };
export { ladderDefName };

/** The marker the downgrade question starts with, and the PostToolUse recorder's pattern for it. */
export const DOWNGRADE_MARKER_RE = /^\s*\[jev-downgrade:([a-z0-9._-]+)\]/;

/** A question is asked at most once per call signature in this window; an answer holds for the same time. */
export const DOWNGRADE_TTL_MS = 10 * 60 * 1000;

const ALIASES: readonly ClaudeModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'];
const MAX_ENTRIES = 50;

/**
 * The downgrade mode: `JEV_DOWNGRADE` (`ask` | `auto` | `off`) wins, then the configured
 * `models.downgrade.mode`, then `ask`. An invalid value anywhere is ignored.
 */
export function downgradeMode(env: Record<string, string | undefined> | undefined, configured?: unknown): DowngradeMode {
  return parseDowngradeMode(env?.JEV_DOWNGRADE) ?? parseDowngradeMode(configured) ?? 'ask';
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** One answer option of the question: its label, and how to run the delegation when it is picked. */
export type DowngradeOption = { label: string; model?: string; subagentType?: string };

export type DowngradePlan = {
  requested: string;
  /** The recommended model's alias: the marker names it, and `auto` runs the call on it. */
  recAlias: ClaudeModelAlias;
  /** Ladder steps strictly between the recommended and the requested model (cheapest first, at most two) that can be run. */
  alternatives: DowngradeOption[];
  /** Steps between them that need a ladder definition (`jev-ladder-<id>`) which is not in the discovered subagents. */
  hiddenVia: string[];
  options: DowngradeOption[];
};

type Step = { id: string; alias: ClaudeModelAlias | null };

/** The ladder, cheapest first. With a catalogue: its ids (alias-expressible when the alias resolves to that id); without: the four aliases. */
function ladderSteps(ctx: RankContext | null | undefined): Step[] {
  if (!ctx) return ALIASES.map((a) => ({ id: a, alias: a }));
  const ids = [...new Set((['free', 'cheap', 'standard', 'deep'] as const).flatMap((t) => ladder(ctx.cat, t, ctx.overrides)))];
  ids.sort((a, b) => compareModels(a, b, ctx.cat, ctx.overrides) ?? 0);
  return ids.map((id) => {
    const family = parseModelId(id)?.family as ClaudeModelAlias | undefined;
    const alias = family && ALIASES.includes(family) && resolveAlias(ctx.cat, family, ctx.overrides) === id ? family : null;
    return { id, alias };
  });
}

/** The discovered subagent named for this ladder step (plain or `<plugin>:<name>`), or null. */
function findDefinition(id: string, defs: readonly string[]): string | null {
  const name = ladderDefName(id);
  return defs.find((d) => d === name) ?? defs.find((d) => d.endsWith(`:${name}`)) ?? null;
}

/** Model-supplied text reaches the reason: keep only safe characters and a bounded length. */
function safeText(text: unknown, max = 60): string {
  return typeof text === 'string' ? text.replace(/[^A-Za-z0-9:_.\/-]/g, '').slice(0, max) : '';
}

/**
 * Pure: should this call be offered a cheaper model? Needs a recommended model that is a valid alias, a requested model
 * strictly above it (by the catalogue, else the family rank) and no instruction from the user naming the requested model
 * or a stronger one. Null otherwise (unknown ids included: they are ignored, never guessed at).
 *
 * `defs` are the discovered subagent names. A ladder step that the Agent tool cannot name (a version inside an alias,
 * `claude-sonnet-5` while `sonnet` is `claude-sonnet-5-5`) is offered only for a `general-purpose` call and only when its
 * `jev-ladder-<id>` definition is in `defs`, because a definition replaces the subagent type.
 */
export function planDowngrade(args: {
  call: AgentCall;
  rec: { model?: string } | null | undefined;
  intent?: UserIntent | null;
  ctx?: RankContext | null;
  defs?: readonly string[];
}): DowngradePlan | null {
  try {
    const { call, rec, intent, ctx } = args;
    const defs = args.defs ?? [];
    const requested = typeof call.model === 'string' ? call.model : '';
    const recAlias = rec?.model && (ALIASES as readonly string[]).includes(rec.model) ? (rec.model as ClaudeModelAlias) : null;
    if (!requested || !recAlias) return null;
    // A version step inside one alias cannot be chosen per call (the Agent tool takes aliases only).
    if (modelAlias(requested) === recAlias) return null;
    const above = compareClaudeModels(requested, recAlias, ctx);
    // The catalogue orders by tier and then version, the family rank by family: a step is called cheaper only when both agree
    // (opus 5.5 is above fable 5.2 by version but fable is the stronger family, so neither is offered as the cheaper of the two).
    if (above === null || above <= 0 || (compareClaudeModels(requested, recAlias, null) ?? 1) < 0) return null;
    // The user's own words outrank the advice: a named model at or above the requested one is an instruction.
    if (intent?.models.some((m) => (compareClaudeModels(m, requested, ctx) ?? -1) >= 0)) return null;

    const generalPurpose = !call.subagent_type || call.subagent_type === 'general-purpose';
    const alternatives: DowngradeOption[] = [];
    const hiddenVia: string[] = [];
    for (const step of ladderSteps(ctx)) {
      const probe = step.alias ?? step.id;
      const vsRec = compareClaudeModels(probe, recAlias, ctx);
      const vsReq = compareClaudeModels(probe, requested, ctx);
      if (vsRec === null || vsReq === null || vsRec <= 0 || vsReq >= 0) continue;
      if ((compareClaudeModels(probe, recAlias, null) ?? -1) < 0 || (compareClaudeModels(probe, requested, null) ?? 1) > 0) continue;
      if (step.alias) {
        alternatives.push({ label: step.alias, model: step.alias });
        continue;
      }
      const def = generalPurpose ? findDefinition(step.id, defs) : null;
      if (def) alternatives.push({ label: `${step.id} via ${def}`, subagentType: def });
      else if (generalPurpose) hiddenVia.push(step.id);
    }
    const shown = alternatives.slice(0, 2);
    const keep = safeText(requested) || 'the requested model';
    return {
      requested,
      recAlias,
      alternatives: shown,
      hiddenVia,
      options: [
        { label: `Yes, ${recAlias}`, model: recAlias },
        ...shown,
        { label: `No, keep ${keep}`, model: requested }
      ]
    };
  } catch {
    return null;
  }
}

function effortSentence(suggested?: string | null, session?: string | null): string {
  if (suggested && session) return `Jev suggests ${suggested} effort; session effort is ${session}`;
  if (suggested) return `Jev suggests ${suggested} effort`;
  return '';
}

/**
 * The deny reason of the downgrade question. A PreToolUse `deny` does not stop the turn: the assistant gets this text,
 * keeps working and is told to ask the one prescribed question. Under 900 characters (alternatives are dropped first
 * when a long subagent name would push it over).
 */
export function downgradeReason(
  plan: DowngradePlan,
  subagentType?: unknown,
  effort: { suggested?: string | null; session?: string | null } = {}
): string {
  const type = safeText(subagentType) || 'general-purpose';
  const req = safeText(plan.requested) || 'the requested model';
  const say = effortSentence(effort.suggested, effort.session);
  const build = (alts: DowngradeOption[]): string => {
    const cands = [plan.recAlias, ...alts.map((a) => a.label)].join(', ');
    const options = [plan.options[0], ...alts, plan.options[plan.options.length - 1]].map((o) => `'${o.label}'`).join(', ');
    return (
      `[jev] "${req}" is above "${plan.recAlias}", the model Jev recommends for this task, and the user did not ask for ${req}. ` +
      `Ask the user with AskUserQuestion, one question whose text STARTS with the marker [jev-downgrade:${plan.recAlias}] followed by a short question ` +
      `naming the subagent_type (${type}), the requested model (${req}) and the cheaper candidates (${cands})` +
      `${say ? `, and stating: ${say}` : ''}; ` +
      `at most four options in this order: ${options}. ` +
      `Then launch the delegation again with the chosen model${alts.some((a) => a.subagentType) ? " (an option with \"via\" is a subagent_type, with no model)" : ""}; ` +
      `do not stop and do not ask in any other form.`
    );
  };
  let alts = plan.alternatives;
  let text = build(alts);
  while (text.length >= 900 && alts.length > 0) {
    alts = alts.slice(0, -1);
    text = build(alts);
  }
  return text.length >= 900 ? text.slice(0, 897) + '...' : text;
}

/**
 * The PreToolUse output of mode `auto`: `allow` plus the whole original tool input with `model` replaced by the
 * recommended alias (`updatedInput` replaces the input, so every original field is copied) plus a note for the assistant.
 */
export function applyDowngrade(call: Record<string, unknown>, plan: DowngradePlan): { hookSpecificOutput: Record<string, unknown> } {
  const req = safeText(plan.requested) || 'the requested model';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[jev] Downgrade applied: ${req} to ${plan.recAlias} (the model Jev recommends for this task).`,
      updatedInput: { ...call, model: plan.recAlias },
      additionalContext:
        `[jev] Jev ran this delegation on ${plan.recAlias} instead of ${req}, because Jev rates the task ${plan.recAlias}-level and the user did not ask for ${req}. ` +
        `Report the result; if ${req} is really needed, ask the user in chat (a reply naming ${req} passes).`
    }
  };
}

/**
 * The sentence the UserPromptSubmit directive adds when Jev's recommendation is cheaper than the session model:
 * the assistant may offer the cheaper model through the prescribed question before it delegates. Same marker and
 * option labels as the deny reason; the alternatives are left to the PreToolUse reason.
 */
export function downgradeDirective(args: {
  recAlias: ClaudeModelAlias;
  sessionModel: string;
  sessionAlias: ClaudeModelAlias;
  effort?: { suggested?: string | null; session?: string | null };
}): string {
  const say = effortSentence(args.effort?.suggested, args.effort?.session);
  return (
    `Jev rates this ${args.recAlias}-level, cheaper than the session model "${safeText(args.sessionModel, 80)}": before delegating you may offer the cheaper model, ` +
    `with AskUserQuestion: one question whose text STARTS with [jev-downgrade:${args.recAlias}] followed by a short question naming the subagent_type, ` +
    `the model you would use and ${args.recAlias}${say ? `, and stating: ${say}` : ''}; ` +
    `options in this order: 'Yes, ${args.recAlias}', 'No, keep ${args.sessionAlias}'. ` +
    `On a Yes launch it on ${args.recAlias}; on No keep ${args.sessionAlias}. Do not ask twice.`
  );
}

// ── State: asked and answered, per session ──────────────────────────────────

/** One question asked or answered. `signature` is null for an answer that no recorded question matched (it covers that recommendation for the window). */
export type DowngradeEntry = {
  kind: 'downgrade';
  from: string;
  answered: boolean;
  signature: string | null;
  chosen?: string;
  asked_at?: number;
  expires_at: number;
};
export type DowngradeState = { entries: DowngradeEntry[] };
export type DowngradeClaim = 'first' | 'asked' | 'answered';

/** Pure: read a state object of unknown shape into a clean one (a corrupt file gives an empty state). */
export function normalizeDowngradeState(raw: unknown): DowngradeState {
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return { entries: [] };
  const entries = list.filter((e): e is DowngradeEntry => {
    const x = e as Partial<DowngradeEntry> | null;
    return (
      !!x &&
      x.kind === 'downgrade' &&
      typeof x.from === 'string' &&
      typeof x.answered === 'boolean' &&
      (x.signature === null || typeof x.signature === 'string') &&
      typeof x.expires_at === 'number' &&
      Number.isFinite(x.expires_at)
    );
  });
  return { entries };
}

const live = (state: DowngradeState, nowMs: number): DowngradeEntry[] => state.entries.filter((e) => e.expires_at > nowMs);

/**
 * Pure: what the hook does with a call whose signature is `signature` and whose recommendation is `from`.
 *   `answered`  the user answered a downgrade question for this signature (or for this recommendation, with no
 *               signature on record): let it through.
 *   `asked`     a question for this signature was already asked in the window and not answered: ask no second time.
 *   `first`     nothing on record: ask. With `record` the question is written down so the next call finds it.
 * Expired entries are dropped.
 */
export function claimDowngrade(
  state: DowngradeState,
  signature: string,
  from: string,
  nowMs: number,
  record: boolean
): { state: DowngradeState; result: DowngradeClaim } {
  const entries = live(state, nowMs);
  if (entries.some((e) => e.answered && (e.signature === signature || (e.signature === null && e.from === from)))) {
    return { state: { entries }, result: 'answered' };
  }
  if (entries.some((e) => !e.answered && e.signature === signature)) return { state: { entries }, result: 'asked' };
  if (!record) return { state: { entries }, result: 'first' };
  const added: DowngradeEntry = { kind: 'downgrade', from, answered: false, signature, asked_at: nowMs, expires_at: nowMs + DOWNGRADE_TTL_MS };
  return { state: { entries: [...entries, added].slice(-MAX_ENTRIES) }, result: 'first' };
}

/** What is stored for a No to the elevation question that answered the downgrade question too (see `onPostToolUse`). */
export const ELEVATION_DECLINED = 'elevation declined';

const MODEL = '(haiku|sonnet|opus|fable|claude-(?:haiku|sonnet|opus|fable)(?:-\\d{1,3}){0,3})';
const PRESCRIBED: ReadonlyArray<{ re: RegExp; label: (m: RegExpExecArray) => string }> = [
  { re: new RegExp(`^(Yes, )?${MODEL}$`), label: (m) => `${m[1] ?? ''}${m[2]}` },
  { re: new RegExp(`^No, keep ${MODEL}$`), label: (m) => `No, keep ${m[1]}` },
  // `<id> via <definition>`: the definition name is not kept (it is any text the user could have typed)
  { re: new RegExp(`^${MODEL} via (?:[a-z0-9-]+:)?jev-ladder-claude-[a-z0-9-]{1,40}$`), label: (m) => `${m[1]} via ladder` }
];

/**
 * Pure: the only part of an answer the state keeps. A prescribed label (`Yes, <alias>`, `<alias>`, `No, keep <model>`,
 * `<id> via <definition>`) is kept in a normalised form that names the model and nothing else; anything else, an
 * "Other" free-text answer in particular, is stored as `other`. The text itself never reaches the file: it can hold
 * task content, and nothing reads it back (an answer of any kind just marks the question answered).
 */
export function prescribedChoice(answer: string): string {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (text === ELEVATION_DECLINED) return ELEVATION_DECLINED;
  for (const { re, label } of PRESCRIBED) {
    const m = re.exec(text);
    if (m) return label(m);
  }
  return 'other';
}

/**
 * Pure: record the user's answer to a downgrade question for the recommendation `from`. Every pending question of that
 * recommendation is marked answered (Yes variants and No alike: the retried call must not be asked again). With no
 * pending question the answer is kept without a signature and covers that recommendation for the window.
 */
export function answerDowngrade(state: DowngradeState, from: string, chosen: string, nowMs: number): DowngradeState {
  const entries = live(state, nowMs);
  const label = prescribedChoice(chosen);
  let matched = false;
  const next = entries.map((e) => {
    if (e.answered || e.from !== from) return e;
    matched = true;
    return { ...e, answered: true, chosen: label, expires_at: nowMs + DOWNGRADE_TTL_MS };
  });
  if (!matched) {
    next.push({ kind: 'downgrade', from, answered: true, signature: null, chosen: label, expires_at: nowMs + DOWNGRADE_TTL_MS });
  }
  return { entries: next.slice(-MAX_ENTRIES) };
}

/**
 * Pure: the recommendation and the answer label of a PostToolUse payload for AskUserQuestion whose question starts
 * with `[jev-downgrade:<alias>]`, or null. The answer is `tool_response.answers[question]`, falling back to
 * `tool_input.answers[question]`. Any label counts (Yes or No); a missing answer and malformed input give null.
 */
export function parseDowngradeAnswer(input: unknown): { from: string; label: string } | null {
  try {
    const i = input as { tool_name?: unknown; tool_input?: any; tool_response?: any } | null;
    if (!i || typeof i !== 'object') return null;
    if (i.tool_name !== undefined && i.tool_name !== 'AskUserQuestion') return null;
    const question = i.tool_input?.questions?.[0]?.question;
    if (typeof question !== 'string') return null;
    const m = DOWNGRADE_MARKER_RE.exec(question);
    if (!m) return null;
    const answer = i.tool_response?.answers?.[question] ?? i.tool_input?.answers?.[question];
    if (typeof answer !== 'string' || !answer.trim()) return null;
    return { from: m[1], label: answer.trim() };
  } catch {
    return null;
  }
}

/** The effort level in a hook's `effort` field: a plain string, or an object holding one (`level` or `value`). Null when unknown. */
export function readEffort(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? ((value as Record<string, unknown>).level ?? (value as Record<string, unknown>).value ?? (value as Record<string, unknown>).name)
        : null;
  return typeof raw === 'string' && /^[A-Za-z]{2,12}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}
