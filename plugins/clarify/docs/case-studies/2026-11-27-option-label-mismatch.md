# Case study: prose option labels can diverge from `ask_question` picker labels

Date: 2026-11-27
Plugin: `plugins/clarify`
Context: `/clarify` architectural interview (Antigravity harness, Question 3 of 7)
Issue: https://github.com/rockad/agentic-hub/issues/123

## What happened

During a `/clarify` session, the assistant wrote the Question 3 prose with:

- `### Option A. Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen (Recommended)`
- `### Option B. Standalone bin/a2a-agy-listen, forked from a2a-listen`
- `### Option C. Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch`

While writing the `**Your reading:**` paragraph, the assistant reconsidered and decided that the standalone fork was the safer recommendation. Instead of rewriting the `### Option A` / `### Option B` headings above, it added a prose correction ("the honest recommendation is B") and emitted the `ask_question` picker with:

- `(Recommended) Option A: Standalone bin/a2a-agy-listen forked from a2a-listen`
- `Option B: Shared loop in a2a-lib.sh plus thin per-harness wrappers`
- `Option C: Reuse a2a-listen behind an A2A_HARNESS=agy switch`

As a result, **Option A** in the prose referred to the shared-core approach, while **Option A** in the interactive picker referred to the standalone fork.

## Root cause

1. **Ordering decided too late:** `SKILL.md` requires Option A to always be the recommended option, and prose + picker options to be in the same order. Because the model drafted the option headings before locking in its recommendation, it reversed the recommendation mid-reply and patched the picker instead of rewriting the prose.
2. **No automated check:** `plugins/clarify/hooks/clarify-stop-check.mjs` only checks for `NO_TOOL_CALL` replies that emit `## Question N` without calling `ask_question`. Nothing checks that `### Option X. <name>` headings in the prose match the option labels passed to `ask_question`.

## Proposed fixes

1. **`plugins/clarify/skills/clarify/SKILL.md`:**
   - State explicitly in **The Shape of Each Step**: decide which option is recommended *before* writing any `### Option X.` heading.
   - If the recommendation changes while drafting `Your reading`, rewrite the `### Option A/B/C` headings in place rather than issuing an inline correction or reordering only the picker.
2. **`plugins/clarify/hooks/clarify-stop-check.mjs` (or a `PreToolUse` / `PostToolUse` check if applicable):**
   - Extract `### Option ([A-D])\. (.+)` headings from the assistant's turn text and compare their order/names against the `ask_question` options array (`Option X: <name>`), flagging any letter/label mismatch before the picker is shown or on stop.
3. **Tests:**
   - Add a test case to `plugins/clarify` hook tests covering mismatched prose Option A/B vs `ask_question` Option A/B.
