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

## Second reproduction (2026-11-28, Claude Code)

The same drift happened on Claude Code, in a `/clarify` session on a channel decision (Question 3 of 6).

- The prose headings were `### Option A. Go`, `### Option B. Prepare, merge on your word (Recommended)`, `### Option C. Defer`. The recommended option was not A.
- The first `AskUserQuestion` call used the label `Option B-first: Prepare ... (Recommended)`. The checkpoint hook of that time (the PreToolUse design before #111, still installed on that machine) told the model to call again with the identical question.
- To satisfy the naming rule the assistant relabelled in the dialog only: A = Prepare (Recommended), B = Go, C = Defer, with a one-line correction note and no reprint of the prose.
- The user picked "Option B: Go" in the dialog. In the printed prose "Option B" meant Prepare. The letters the user saw in the two places named different options, and a risky decision (an unattended merge of a large change) may have been taken from the wrong reading.

New root causes seen on Claude Code:

1. The headings were drafted before the recommendation was locked, as on Antigravity.
2. The checkpoint's "identical question" instruction discouraged fixing labels, and nothing compared prose and dialog. (Main no longer has that checkpoint: #111 replaced it with a quiet PostToolUse reminder. The installed plugin on that machine was still `35eadb2`.)
3. A relabel without reprinting the prose is silent drift: both the correction note and the dialog looked fine on their own.

A sweep of older real sessions (Claude Code and Antigravity transcripts) with the new check found the same family of drift in other shapes: a recommended "Option B" listed first with the letters in the order B, A, C, a recommendation on B in the dialog while the prose said A, and two dialog options swapped against the printed ones. The sweep also showed that compact Antigravity transcripts middle-truncate long replies (`<truncated N bytes>`), which loses headings, so such replies are not compared.

## What was built (issue #123)

- **Skill:** settle the recommendation and the option order (recommended = A) before writing any heading; if the recommendation changes after printing, reprint the whole step, never patch only the dialog.
- **`hooks/clarify-labels.mjs`**, one comparison for all paths:
  - dialog only: labels `Option A:`, `Option B:`, ... in order, recommended option = A;
  - dialog against prose: same letters, same recommended option, and each dialog option is the printed option of the same letter (a swap is caught with Jaccard word similarity: another letter fits at least 0.5 and at least 0.3 better than the same letter, so renaming that keeps the meaning passes).
- **Antigravity:** a `PreToolUse` hook on `ask_question` (`hooks.json`) with the full comparison. Antigravity flushes the reply before `PreToolUse` runs (agy probe, 2026-11-24), so the prose is in the transcript. It denies at most twice per question number; a pass-through is empty stdout, because Antigravity treats `{}` as a denial.
- **Claude Code:** a `PreToolUse` hook on `AskUserQuestion` for the dialog-only rules. It cannot compare the prose: Claude Code writes the current reply to the transcript after `PreToolUse` hooks finish (measured, #97/#101). So the prose comparison for Claude Code is offline, in `scripts/check-clarify-transcript.sh` (`FAIL ... option labels`, counted in `failed`).
- **Reminder text:** the PostToolUse reminder after each answer now also says to settle the recommendation first and to keep dialog labels equal to the printed headings, and never says "identical" (the denial message that said so no longer exists).
- **Tests:** `scripts/test-clarify-labels.sh` covers a happy path, the swapped-meaning case, the relabel case, the recommendation not on A, a reprint that fixes it, an earlier question's headings in the same window, the deny budget, fail-open, the Antigravity empty-stdout pass-through, and the offline checker in both formats.

Known limit: on Claude Code a relabel with a matching letter order and the recommendation on A cannot be caught before the picker is shown (the hook sees no prose); it shows up as an offline `FAIL` in the checker.
