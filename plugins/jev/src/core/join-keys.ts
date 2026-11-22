/**
 * The join keys and the effort source of a telemetry row (2.3.20). Pure: nothing here reads a file, the environment or the clock.
 *
 * A row can be joined to measured usage (the harness's own trace of a call) by the id the host gave the tool call:
 *
 * - Claude Code: `toolUseId`, the hook input's `tool_use_id`, on every PreToolUse `agent_call` row (Agent, Task and Workflow, a deny
 *   included) and on the PostToolUse rows Jev writes for those tools (the Workflow drift row). The agents a Workflow script launches
 *   have no hook of their own, so they have no id: the Workflow call's `toolUseId` stands for the workflow as a whole.
 * - Antigravity: `callKey`, the hook input's `toolCall.id`, which is the same in PreToolUse and PostToolUse for one call and unique
 *   per call (also across parallel `invoke_subagent` calls of one step). It is on the `agent_call`, `agent_call_recommendation` and
 *   `subagent_served` rows and on the `run_workflow` rows. The child conversation id is only known at PostToolUse (the tool return),
 *   so `subagent_served` also carries `childConversationId`: child conversations write their own usage rows with
 *   `session_id` equal to it.
 *
 * An id is written only when it is a short token; an absent or malformed one is omitted, never replaced by a guess.
 */

import { costEffortOf, effortFromModelId, type CostEffort } from './cost-estimate.js';

/** The longest id written. */
export const JOIN_TOKEN_MAX = 128;

/** A short token: letters, digits and `_ . : -`. No whitespace, no path or shell characters, so an id can be used as a key without escaping. */
const JOIN_TOKEN_RE = /^[A-Za-z0-9_.:-]+$/;

/** The id as a short token (surrounding whitespace trimmed), or undefined when it is absent, not a string, empty, too long or malformed. */
export function joinToken(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 && s.length <= JOIN_TOKEN_MAX && JOIN_TOKEN_RE.test(s) ? s : undefined;
}

/** `{ toolUseId }` for a Claude Code row, or nothing. */
export function toolUseIdField(v: unknown): { toolUseId?: string } {
  const id = joinToken(v);
  return id ? { toolUseId: id } : {};
}

/** `{ callKey }` for an Antigravity row, or nothing. */
export function callKeyField(v: unknown): { callKey?: string } {
  const id = joinToken(v);
  return id ? { callKey: id } : {};
}

/**
 * Where the effort of a call came from (`effortSource` on an `agent_call` row):
 *
 * - `requested`: the call, or its agent definition, named a literal effort (Antigravity: the model it asked for fixes one, see below).
 * - `inherited`: it named none and the session's effort is known, so the session's applies.
 * - `default`: it named none and the session's effort is not known either, so a default was used for the cost fields: `medium`, except on Claude Code under an assumed session model (none known), which is assumed to run at `high` (ASSUMED_CLAUDE_SESSION_EFFORT) and whose cost fields are computed at that level.
 * - `clamped`: the cost-gate clamp lowered the effort the call asked for (`clamped_effort` says the level it runs at).
 */
export type EffortSource = 'requested' | 'default' | 'inherited' | 'clamped';

export type EffortFields = {
  /** The literal level the call asked for; present whenever one was named (also with `clamped`), absent otherwise. */
  effortRequested?: CostEffort;
  effortSource: EffortSource;
};

/**
 * Pure: the effort fields of a call.
 *
 * `named` is the literal effort the call (or its definition) names, `sessionKnown` whether the session's effort is known (a real
 * report, not an assumed fallback), `clampedFrom` the effort the clamp lowered (the level the call asked for, when it was lowered).
 * `effortRequested` is written whenever a literal level was named, whether or not it is the one applied: with `clamped` it is the
 * level that was lowered, with `requested` the level that applies.
 */
export function effortFields(a: { named?: unknown; sessionKnown: boolean; clampedFrom?: unknown }): EffortFields {
  const named = costEffortOf(a.named);
  const lowered = costEffortOf(a.clampedFrom);
  if (lowered) return { effortRequested: lowered, effortSource: 'clamped' };
  if (named) return { effortRequested: named, effortSource: 'requested' };
  return { effortSource: a.sessionKnown ? 'inherited' : 'default' };
}

/**
 * The effort fields of an Antigravity `invoke_subagent` call. Antigravity carries an effort as the SUFFIX of a model id
 * (`gemini-4-argon-high`), and the three `Model` enum values have a fixed served effort, so the mapping is:
 *
 * | `Model`                      | effort                          | `effortSource`        | `effortRequested` |
 * | ---------------------------- | ------------------------------- | --------------------- | ----------------- |
 * | `flash`                      | `high` (served as Hydrogen high)| `requested`           | `high`            |
 * | `pro`                        | `xhigh` (Hydrogen xhigh)        | `requested`           | `xhigh`           |
 * | `flash_lite`                 | none (the id has no suffix)     | `inherited`/`default` | absent            |
 * | a full id with a suffix      | the suffix                      | `requested`           | the suffix        |
 * | a full id without a suffix   | none                            | `inherited`/`default` | absent            |
 * | `inherit` or omitted         | the parent's suffix             | `inherited`/`default` | absent            |
 *
 * `inherited` when the session model id carries an effort suffix (the session's effort is known), else `default` (`medium`, what the
 * cost fields assume). `clampedEffort` is the effort the cost-gate clamp lowers the call to; when the clamp lowered it
 * (`clampedFrom` is what it asked for) the source is `clamped`.
 */
export function antigravityEffortFields(a: {
  servedEffort: CostEffort | null;
  sessionModel: unknown;
  clampedFrom?: unknown;
}): EffortFields {
  return effortFields({ named: a.servedEffort, sessionKnown: effortFromModelId(a.sessionModel) !== null, clampedFrom: a.clampedFrom });
}
