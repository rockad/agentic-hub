/**
 * The Antigravity session model assumed when nothing reports one (no `modelName` on the hook input, no stored session
 * model, no quota-state `active_model`).
 *
 * One constant for every code path (the PreToolUse evaluation and the pre-flight clamp both read it), so an unknown
 * session never gets a higher ceiling in one hook than in the other. It is the lower of the two ids the code used to
 * default to (`gemini-pro` in the pre-flight, `gemini-3.8-flash-low` in the evaluation): a flash-class model, so an
 * unknown session is held to the flash ceiling and a stronger model needs an approval.
 */
export const DEFAULT_ANTIGRAVITY_SESSION_MODEL = 'gemini-3.8-flash-low';
