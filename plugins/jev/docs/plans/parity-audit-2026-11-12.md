# Jev parity audit: agentic-hub 2.3.2 against cognitive-engine PR #22

Date: 2026-11-12. Branch: `test/jev-parity-audit` (from agentic-hub `main`, Jev 2.3.2). Nothing under `src/`, `claude/` or any other non-test path was changed.

Spec: the test files of cognitive-engine PR #22 (`feat/jev-advisor-port`, `packages/jev/tests`), items 5.1 to 5.11 and the review fixes. Each case was ported to `plugins/jev/tests/parity-*.test.ts` and run on 2.3.2. A FAIL is a gap between 2.3.2 and #22, with two exceptions called out under "Reading the numbers".

## Result

Runner: `bun test` in `plugins/jev` (package.json `test` script).

| Run | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Ported parity files only (`bun test tests/parity-*.test.ts`) | 289 | 175 | 114 |
| Pre-existing suite (15 files, unchanged) | 292 | 284 passed, 1 skipped | 6 failed tests + 1 unhandled error |
| Whole suite | 581 | 459 pass | 121 fail + 1 error |

Counts are per `it` or `it.each` case. Whole suite: 114 parity failures plus the 7 baseline failures.

Baseline (not gaps), identical on a clean main:

- The five named in the brief: custom-agent discovery (claude-hook), per-harness mode isolation, three Stage 2 workspace-agent discovery tests (audit).
- Two more than the brief listed: `Wave 1 & 3 ... OpenCode binary and runner exports are completely removed from src/index.ts` plus one `Unhandled error between tests` in `tests/jev.test.ts`. Both come from `Cannot find module '@modelcontextprotocol/sdk/server/index.js'`: the worktree has no `node_modules` (no `bun install` was run). Environmental, not counted.

## Files

All new, in `plugins/jev/tests/`:

- `parity-intent.test.ts` (advisor-intent, advisor-intent-false-positives, advisor-intent-table parser and cap)
- `parity-mixed-wording.test.ts` (advisor-mixed-wording, one case of advisor-ceiling)
- `parity-precedence.test.ts`
- `parity-rubric.test.ts` (advisor-rubric)
- `parity-preflight.test.ts` (advisor-preflight)
- `parity-repeat-turn.test.ts` (advisor-repeat-turn, staleness half of advisor-intent-table)
- `parity-telemetry-fields.test.ts`
- `parity-dispatch-keywords.test.ts`
- `parity-dispatch-harness.test.ts`
- `parity-dispatch-telemetry-harness.test.ts`
- `parity-helpers.ts` (shared deps, parser adapters, #22 rubric text; not a test file)
- `fixtures/run-dispatch.ts` (copied from #22, import path adjusted)

## Table

Ported name is `file > describe`. "n/m" means n failed of m ported cases. Session model in every case is `claude-sonnet-5-5` (or the opus/haiku variant the case needs).

| Item | #22 test (file, describe) | Ported test | 2.3.2 | Reason for FAIL |
| --- | --- | --- | --- | --- |
| 5.1 | advisor-intent, `parseUserIntent (5.1)` (named model, cost phrase, prose, scan window) | parity-intent > parseUserIntent (5.1) | 4/19 FAIL | "as cheap as possible" is no cost phrase; "the opus subagent finished" and "not the cheapest, the best one" read as an instruction; no `phrase` field on the intent |
| 5.1 | advisor-intent, `applyUserIntent (5.1)` | parity-intent > applyUserIntent, via resolveModel | pass (4/4) | none. Adapted: asserts tier, model, source; `routerTier` and `by` fields have no equivalent |
| 5.1 | advisor-intent, `onUserPromptSubmit with an explicit instruction` | parity-intent > onUserPromptSubmit with an explicit instruction | 3/4 FAIL | wording ("do not ask separately", "lowered the tier from pro to flash" absent); decisions log has no `by` / `routerTier` and records the router tier, not the applied one |
| 5.1 review fix | advisor-intent-false-positives, `ignores a model that is not an instruction` (22 model cases, 5 cost cases) | parity-intent > the parser ignores a model that is not an instruction | 25/27 FAIL | 2.3.2 parser has only a short negation check: it reads a model out of quotes, code spans and fences, questions, "if" suppositions, first-person and pasted-log lines, `--model` flags in prose, poem words (haiku, sonnet), "sonnet 130", `Используй opus`; reads cost out of "minimal viable product", questions, quotes and code spans. Only the two-model split ("use sonnet for the tests and opus for the review") and the "MVP" abbreviation case pass |
| 5.1 review fix | advisor-intent-false-positives, `still reads a real instruction` | parity-intent > the parser still reads a real instruction | 1/13 FAIL | "use opus over sonnet" yields no model (two names are treated as a split) |
| 5.1 review fix | advisor-intent-table, `reads imperatives only` | parity-intent > the explicit-instruction parser reads imperatives only | 8/37 FAIL | "compare with opus", "opus is the strongest model", "the opus subagent finished", "we compared results with sonnet yesterday" read as instructions; "as cheap as possible" missed; "not the cheapest", "do not choose the cheapest", "without the cheapest option" still read as cost intent |
| 5.1 review fix | advisor-intent-table, `capped at one tier step` | parity-intent > the effect is capped at one tier step | 5/10 FAIL | a named model overrides the tier with no one-step cap (flash_lite plus opus gives opus, free plus sonnet gives sonnet, pro plus haiku gives haiku); directive never says "at most one tier step" |
| 5.2 | advisor-intent, `buildDirective ceiling sentence` | parity-intent > buildDirective ceiling sentence (5.2) | 2/3 FAIL | pro tier on a sonnet session: no "let the user choose", and the ask is capitalised "Ask the user before delegating on opus" (wording only); pro tier on an opus session still says "present the cheaper and the stronger option", not "allows it" |
| 5.2 | advisor-mixed-wording, `one ceiling sentence for any model above the session model` (5 named cases) | parity-mixed-wording > one ceiling sentence | 3/5 FAIL (named) | no "one approval prompt" sentence for a named model above the session; no "hard ceiling, so ask the user before delegating on sonnet" for a flash rec on a haiku session; custom persona above the session still gets the "never delegate to a stronger model" line plus `Agent(subagent_type` action |
| 5.2 | advisor-mixed-wording, 27-case session by router by prompt table | parity-mixed-wording > same describe, `.each` | 1/27 FAIL | only haiku session, flash router, neutral prompt breaks it (ceiling line next to a sonnet delegation). The other 26 pass, many because a named model skips the ceiling line, so this table is weak evidence |
| 5.2 | advisor-ceiling, `the advisor honours the project ceiling`, case "without a ceiling the same session still allows opus" | parity-mixed-wording > advisor-ceiling.test.ts, the portable case | FAIL | no "allows it" wording on an opus session (same cause as the 5.2 opus case above) |
| 5.3 | advisor-rubric, `stage rubric (5.3)` | parity-rubric > stage rubric (5.3) | 2/3 FAIL | rubric lines are not in `TIER_CRITERIA` or `dispatchQuestions()`; `buildDirective` does not carry the stage rubric (it lives only in the pre-flight reminder, in different words). `parseDispatch` unchanged: pass |
| 5.4 | advisor-preflight, `stage plan reminder (5.4)` | parity-preflight > stage plan reminder (5.4) | 2/3 FAIL | no "call jev_batch_dispatch with one task per stream" text for workflow or workstreams prompts; no `staged` flag on the turn state. Ordinary-prompt case passes |
| 5.4 / 5.11 | dispatch-harness, `jev_batch_dispatch on Claude Code (5.4, 5.11)` | parity-dispatch-harness > jev_batch_dispatch on Claude Code | 9/10 FAIL | batch tasks have no `kind` (judgement, settled-edit, mechanical), `needsEdit` or `tierSource`; no stored-session-model read (`activeSessionModel` is "unknown"); no opus-above-session flag or `requiresUserApproval` per task; a needsEdit or edit-wording stage still lands on the free tier; no tier question to the router per stage; Claude Code offers the router no real built-in types (Plan, general-purpose), so a router answer of general-purpose falls to `self`; read-only stage with "no edits" wording is taken as editing. Only the unknown-session case passes |
| 5.5 | advisor-rubric, `silence on turns without delegation intent (5.5)` | parity-rubric > silence on turns without delegation intent | 4/6 FAIL | task notification still calls Jev and returns advice; a 20 000 character paste still gets advice; the task sent to Jev is not trimmed (6029 chars, not 2000); a status turn (`self`, cheap tier, no work verb) still gets advice. Two pass (work-verb turn still advised; instruction never silenced) |
| 5.6 | advisor-rubric, `personas match real subagent types (5.6)` | parity-rubric > personas match real subagent types (5.6) | pass (3/3) | none, including the discovered-directory case |
| 5.6 / 4.11 | dispatch-keywords, `read-only personas never own an editing task` | parity-dispatch-keywords > read-only personas never own an editing task | 7/32 FAIL | `taskNeedsEdit` is not negation-aware or narrow: "Commit to a direction", "Create a picture of the flow", "Outline the approach, no edits", "Do not update the files, just read them" count as edits; `resolveEditCapableSubagent` falls back to `self` (not the original read-only persona) outside Claude Code; batch ignores `needsEdit: false`; single dispatch outside Claude Code turns Plan into `self` when Plan is offered |
| 5.7 | advisor-rubric, `recommended and used share one key (5.7)` | parity-rubric > recommended and used share one key | 2/3 FAIL | log key is `session`, #22 expects `session_id`; `telemetryEvent` also reads `session`, so `session_id` input gives `sessionId: null`. turn-id case passes |
| 5.7 | advisor-telemetry-fields, `UserPromptSubmit record` | parity-telemetry-fields > UserPromptSubmit record | 2/3 FAIL | `session` vs `session_id` in the log; saved turn state has no `by`, `at`, `mode` fields. Telemetry-event key set passes |
| 5.7 | advisor-telemetry-fields, `PreToolUse record` | parity-telemetry-fields > PreToolUse record | 2/3 FAIL | no `Workflow` handling (no log entry); the PreToolUse event has no `taskSummary` (log carries `subagent_type`, telemetry reads `subagent`). The join-on-turn-id case passes |
| 5.8 | none (documentation only in #22: "Workflow agent() calls cannot be intercepted", README and CHANGELOG) | none | NOT PORTABLE | no test case in #22. Note: 2.3.2 `hooks.json` PreToolUse matcher is `Agent\|Task`, and `onPreToolUse` returns null for any other tool name |
| 5.9 | advisor-precedence, `precedence: instruction, guard, standing rule` | parity-precedence > precedence ... (5.9) | 5/10 FAIL | opus session plus pro rec gives `mode-guard`, needsApproval true (#22: `standing`, false); sonnet session plus pro rec is capped to sonnet with approval (#22: opus advised, approval); directive carries no "rule: per ..." text; no "do not ask separately"; ask text capitalised. Five pass (instruction rows, flash default, unknown-session guard, sonnet advice) |
| 5.10 | advisor-preflight, `pre-flight reminder (5.10)` | parity-preflight > pre-flight reminder (5.10) | 5/9 FAIL | `Workflow` calls ignored by `onPreToolUse`; a lone Agent call is reminded (#22: only a staged turn or third call); log has no `event: 'agent_call'` and `preflight_reminder` is true; rubric wording differs and "not a block" is absent. Silent-off, no-remind-when-dispatched (vacuous: Workflow is ignored), null-recommendation and same-turn-id cases pass |
| 5.10 | advisor-preflight, `reading the logs` | parity-preflight > reading the logs | 3/5 FAIL | `hasRecentDispatch` ignores harness and failure status (counts an antigravity line and a failed call); window is 10 minutes (#22: 30). The last item is derived from #22's `DISPATCH_WINDOW_MS`, not a #22 test. Recent-dispatch and later-failure cases pass |
| 5.10 | advisor-preflight, `pre-tool-use process` | parity-preflight > pre-tool-use process | pass | none |
| 5.10 support | dispatch-telemetry-harness, `dispatch telemetry harness label` | parity-dispatch-telemetry-harness | 4/4 FAIL | `telemetryHarness` does not exist; dispatch telemetry lines carry no `harness: 'claude-code'` label |
| 5.1 / 5.7 / 5.9 review fix | advisor-intent-table, `PreToolUse ignores a stale turn`, and advisor-repeat-turn staleness | parity-repeat-turn > PreToolUse ignores a stale turn | 2/2 FAIL | PreToolUse log has no `user_intent`; the stored turn has no `mode`, so a mode flip does not drop it |
| 5.1 / 5.7 / 5.9 review fix | advisor-intent-table, `UserPromptSubmit stores the turn marker before anything can return early` | parity-repeat-turn > UserPromptSubmit stores the turn marker | 4/4 FAIL | stored state lacks `mode`; no `user_intent` in the PreToolUse log; a host-injected task notification overwrites the marker with its own turn id; a turn with Jev off does not clear the stored turn (stale intent survives a mode flip) |
| 5.7 review fix | advisor-repeat-turn, `a repeated prompt without advice does not inherit the previous advice` | parity-repeat-turn > a repeated prompt ... (end to end) | 1/3 FAIL | stale advice itself is not inherited (the isolated extra case passes); the failing case is the staged-flag expectation and the reminder that fires on a lone Agent call. "Same turn sees its own advice" passes |
| 5.11 | dispatch-harness, `harness style table` | parity-dispatch-harness > harness style table, via buildExecutionGuidance | 2/3 FAIL | no `agent({ agentType, model })` wording for workflows; `self` maps to "Handle it directly", not `general-purpose`. Antigravity wording case passes |
| 5.11 | dispatch-harness, `Antigravity and OpenCode are unchanged` | parity-dispatch-harness > Antigravity and OpenCode are unchanged | pass (7/7) | none |
| 5.11 | dispatch-harness, `jev_dispatch on Claude Code` | parity-dispatch-harness > jev_dispatch on Claude Code | FAIL | router answer `self` gives "Handle it directly" (not Agent with general-purpose and opus); no "the Jev guard will ask the user once" note; no `activeSessionModel`; `requiresUserApproval` differs |
| 4.11 | dispatch-keywords, `free-tier keyword rule` | parity-dispatch-keywords > free-tier keyword rule | 1/17 FAIL | `isFormattingTask` does not exist. All tier cases pass |
| 4.11 | dispatch-keywords, `every substring site uses the whole-word rule` | parity-dispatch-keywords > every substring site | 3/3 FAIL | `defaultEffortForSubagent` gives low for "information" and "dump format"; `evaluateLocalHeuristic('decide the dump format')` is free tier; `detectScaffoldingTask('Fix the scaffoldless design')` matches |
| 4.11 | dispatch-keywords, `jev_batch_dispatch tier rule end to end` | parity-dispatch-keywords > jev_batch_dispatch tier rule end to end | pass (4/4) | none |

## NOT PORTABLE

Counts are `it` or `it.each` cases not ported.

| #22 test | Count | Reason |
| --- | --- | --- |
| advisor-ceiling: `effectiveSessionModel` | 5 | needs `effectiveSessionModel` and `guard.ts` lowerModel; no project ceiling in agentic-hub |
| advisor-ceiling: project-ceiling hook cases (opus session with sonnet ceiling, pro rec, throwing reader), `resolveModel applies the ceiling`, `buildDirective takes the ceiling` | 5 | `.jev.json` `guard.ceiling` (project-config.ts), `readCeiling` dep |
| advisor-ceiling: `projectCeiling` | 4 | `projectCeiling` and project-config.ts absent |
| advisor-rubric: `maps the three kinds`, `recognises a stage kind` | 2 | `stage-rubric.ts` (STAGE_RUBRIC, STAGE_KINDS, isStageKind) absent. The rubric text is checked at its observable surfaces instead |
| advisor-rubric: `recognises host-injected turns` | 1 | `isNonTaskPrompt`, `trimTask` unit helpers absent (behaviour ported through the hook) |
| advisor-rubric: remembered advice round trip | 1 | `advisor-state.ts` (writeLastAdvice, readLastAdvice, `JEV_CLAUDE_STATE_DIR`); 2.3.2 keeps one private turn file |
| advisor-intent-table: `measures the step from the router tier, not from a tier an earlier instruction set` | 1 | `applyUserIntent` chaining; `resolveModel` is single pass |
| advisor-intent-table: `currentTurn` | 4 | `currentTurn` and the separate LastAdvice plus TurnState records absent |
| advisor-intent-table: stale turn id discards advice and staged flag | 1 | needs a separate advice record next to the marker |
| advisor-repeat-turn: `currentTurn and a repeated prompt` (timestamps) | 4 | `currentTurn`, marker `at` field absent |
| advisor-preflight: third agent call reminded once | 1 | `recentAgentCalls` dep and decisions-log reader absent (2.3.2 reminds on the first Agent call instead) |
| advisor-preflight: `counts the session agent calls in the window` | 1 | `recentAgentCalls` absent |
| advisor-preflight: `answers no for a missing file` | 1 | file reading is private to hook.ts in 2.3.2 (`hasRecentDispatch` takes lines) |
| dispatch-harness: `session model for the tools (5.11)` (reads session model from environment, unknown without id, finds transcript, model to tier) | 4 | `claude-active-session.ts` and `session-model.ts` absent |
| dispatch-harness: `reports the ceiling on Claude Code and never lowers the tier` | 1 | `claudeCeiling` and `escalationNote` absent |
| dispatch-harness: `claudeKeywordTier` table | 6 | helper absent; its behaviour is covered by the `classifyBatchTier` cases |
| dispatch-harness: `freeTierCriteria` assertion inside `keeps the Antigravity wording verbatim` | 1 assertion | tier criteria text is inline in the handler, not exported |
| 5.8 | n/a | documentation only in #22 |
| acorn workflow guard, `lowerModel` guard tests | not in the requested file list | out of scope per the brief |

## Adaptations worth knowing

- #22's `parseUserIntent` returns `{model, cost, phrase}`; 2.3.2 returns `{models[], cost}`. `modelOf()` and `costOf()` in `parity-helpers.ts` read the equivalent value. #22's `applyUserIntent` is read through `resolveModel`.
- #22's `Resolution.rule` values (`instruction`, `guard`, `standing`) were mapped to 2.3.2's `source` (`user-instruction`, `mode-guard`, `default-rule`).
- #22 keeps two state records (advice and turn marker); 2.3.2 keeps one `TurnState` behind `readTurn` / `saveTurn`. Ports use an in-memory store with the same hook deps.
- Assertions use #22's exact wording. Several FAILs are wording only (the capitalised "Ask the user ...", "do not ask separately", "lowered the tier from pro to flash", `rule: per ...`). Whoever ports #22 can either adopt the wording or relax those assertions.
- Session model is `claude-sonnet-5-5` throughout. The `claude-sonnet-5` cases in #22 that depend on version ranking (alias "sonnet" is 5.5, above a 5 session) cannot be reproduced: 2.3.2's `modelRank` ignores versions.
- Dispatch handler cases run in a child process with `HOME` set to a temp dir and a stubbed Decisions API, as in #22. For Plan cases the ports pass `availableSubagents: ['Plan']`, because in this repo the discovered agent list does not include the Claude built-ins.

## Reading the numbers

- The 114 FAILs are not all independent. Many share one cause: for example the `Workflow` tool name is ignored, the parser lacks quote/question/code handling (about 40 cases), the stored turn lacks `mode`, and the dispatch tools have no Claude-session awareness.
- Cases that pass but prove little: the 26 passing cells of the 27-case mixed-wording table; "gives no reminder when a recent jev_batch_dispatch exists" (passes because `Workflow` is ignored); "never goes silent when the user gave an instruction" (the hook returns advice for every turn on 2.3.2).
- Two extra cases are mine, not #22's: `isolated staleness check (extra)` in parity-repeat-turn (passes, shows stale advice is not the problem) and `2.3.2 window constant is 30 minutes like #22` in parity-preflight (fails; derived from `DISPATCH_WINDOW_MS`). They are counted in the totals.
- `#22` also writes the log key `session_id` and `event: 'agent_call'`, while its own header says its field names "match agentic-hub Jev 2.3.1". 2.3.2 uses `session`. The audit follows #22; the direction of that rename is a decision for the maintainer.
