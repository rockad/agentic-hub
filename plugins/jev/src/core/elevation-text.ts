/**
 * Wording the elevation flow shares between harnesses, so Claude Code and Antigravity tell the agent the same thing.
 */

/** The attempt (of one delegation in one prompt) from which a deny reason tells the agent to stop retrying. */
export const STOP_RETRYING_FROM_ATTEMPT = 3;

/**
 * The sentence added to a choice-flow deny reason from the third attempt of the same delegation: stop asking for the
 * stronger model, and either run on an explicit model at the ceiling or ask the user again. Empty before that attempt.
 *
 * The choice flow never asks through a permission dialog (a harness that auto-approves would approve it without showing it),
 * so a repeated denial has to say plainly what to do instead. Only `askTool` differs between harnesses
 * (`ask_question` in Antigravity, `AskUserQuestion` in Claude Code).
 */
export function stopRetryingText(
  attempt: number | null | undefined,
  requestedModel: string,
  ceiling: string,
  askTool: string,
  field: string = 'Model'
): string {
  if (typeof attempt !== 'number' || attempt < STOP_RETRYING_FROM_ATTEMPT) return '';
  return (
    `This is attempt ${attempt} for the same delegation: stop retrying '${requestedModel}'. ` +
    `Proceed with an explicit ${field}: "${ceiling}", or ask the user again with ${askTool}.`
  );
}
