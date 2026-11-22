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

/**
 * The Claude Code session model assumed when nothing reports one (a brand-new or headless session before its transcript is
 * written, with no SessionStart record), so an unknown session fails CLOSED: a subagent on opus is held to the same approval
 * question as on a known sonnet session, instead of running unchecked. It is the model alias the cost gate and the elevation
 * check read; the real model replaces it as soon as one is known (nothing remembers the assumption).
 */
export const ASSUMED_CLAUDE_SESSION_MODEL = 'sonnet';

/** The Claude Code session effort assumed together with {@link ASSUMED_CLAUDE_SESSION_MODEL} when the effort is not reported either. */
export const ASSUMED_CLAUDE_SESSION_EFFORT = 'high';

/** The `session_model_source` value of a row whose session model is the assumed one. */
export const ASSUMED_SESSION_MODEL_SOURCE = 'assumed';

/** The sentence a deny (or dialog ask) reason carries when the session model is the assumed one. */
export const ASSUMED_SESSION_MODEL_NOTE = `The session model is not known yet, so Jev assumes ${ASSUMED_CLAUDE_SESSION_MODEL}.`;
