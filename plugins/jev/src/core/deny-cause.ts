/**
 * Why a hook held a call (2.3.20), in one vocabulary for both harnesses. Every `deny` row of the decisions log and of the telemetry
 * carries `denyCause`, and every dialog `ask` row carries `askCause`, with one of these values. The value is chosen by the code
 * path that produced the decision, never by reading the reason text.
 *
 * - `tier`:           a model stronger than the session's (the rank ceiling). Also the cause under an assumed session model; the
 *                     row then also carries `sessionModelAssumed` as before.
 * - `effort-interim`: the interim rule for an `xhigh` or `max` effort, which applies where the cost gate cannot judge.
 * - `cost`:           the enforced cost gate held the call (model or effort), and the rank ceiling alone would not have.
 * - `unranked`:       a model Jev cannot rank (an unrecognised value, an unranked or remapped alias).
 * - `definition`:     the agent definition that decides the model cannot be read or is ambiguous.
 * - `orchestrator`:   an Antigravity Orchestrator conversation: the explicit-`Model` rule, or the Orchestrator's flash ceiling.
 * - `downgrade`:      the downgrade question (a cheaper model may be enough).
 * - `unverifiable`:   a Workflow / `run_workflow` script Jev cannot verify.
 * - `quota`:          Antigravity low-quota block of a paid tier (not a model or cost decision; kept apart so it never reads as a cost-gate disagreement).
 * - `unknown-model`:  the session model was not known and no other cause applies (kept for completeness; every path today has a cause).
 */
export type DenyCause =
  | 'tier'
  | 'effort-interim'
  | 'cost'
  | 'unranked'
  | 'definition'
  | 'orchestrator'
  | 'downgrade'
  | 'unverifiable'
  | 'quota'
  | 'unknown-model';

export const DENY_CAUSES: readonly DenyCause[] = ['tier', 'effort-interim', 'cost', 'unranked', 'definition', 'orchestrator', 'downgrade', 'unverifiable', 'quota', 'unknown-model'];

/**
 * The cause field of a row for a decision: `{ denyCause }` for a deny, `{ askCause }` for an ask (`force_ask` too), nothing for any
 * other decision or when no cause was recorded. Spread it into a row.
 */
export function causeFields(decision: unknown, cause: DenyCause | undefined | null): { denyCause?: DenyCause; askCause?: DenyCause } {
  if (!cause) return {};
  if (decision === 'deny') return { denyCause: cause };
  if (decision === 'ask' || decision === 'force_ask') return { askCause: cause };
  return {};
}

/** Narrow an unknown value (a decisions-log field) to a cause. */
export function asDenyCause(v: unknown): DenyCause | undefined {
  return typeof v === 'string' && (DENY_CAUSES as readonly string[]).includes(v) ? (v as DenyCause) : undefined;
}
