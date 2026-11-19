# Case study: clarify loses option explanations after the first question in Claude Code

Date: 2026-11-19. Skill: `skills/clarify/SKILL.md` (last change `5185039`). Evidence: the Claude Code session `jev-updates`, transcript `~/.claude/projects/-home-rockad-projects-agentic-hub/e74c1164-5f04-4bd0-b078-360049754941.jsonl`.

## Symptom

Only Question 1 of each series is explained. Questions 2 and later show a bare dialog: one short sentence per option and a 30–110 character preview. Antigravity on the same skill explains every question.

## Evidence from the transcript

The session ran three clarify series (3, 3 and 5 forks). The pattern is the same in every series:

| Series | Question | Assistant prose before the call | Option `description` length |
| --- | --- | --- | --- |
| 1 | Q1 of 3 | full step: context, Options A–C with pros/cons, reading, recommendation | 62–101 chars |
| 1 | Q2 of 3 | **none**: the call follows Q1's tool result directly | 47–115 chars |
| 1 | Q3 of 3 | **none** | 52–95 chars |
| 2 | Q1 of 3 | full step | 70–105 chars |
| 2 | Q2, Q3 | **none** | 67–97 chars |
| 3 | Q1 of 5 | a mode table only | 61–85 chars |
| 3 | "Q2 of 3" | **none**, and the count changed from 5 to 3 | rejected by the user |

Turn shape for Q2 and Q3 (from `jq` over the transcript):

```
A-TOOL  AskUserQuestion  Fork 1/3
U-RESULT "Your questions have been answered: ... = Option A"
A-TOOL  AskUserQuestion  Fork 2/3     <- no text block, not even the "Noted:" line
U-RESULT ...
A-TOOL  AskUserQuestion  Fork 3/3     <- no text block
```

The session also ran the **Concise** output style.

## Root causes

1. **The skill puts every explanation outside the dialog, and Claude Code may not show it.**
   - The skill says all analysis lives "in the markdown prose above the tool call" (line 147). Its Claude Code examples use one-line descriptions (lines 328–388). An anti-pattern forbids "overloading tool call descriptions with previews" (line 557).
   - Antigravity's `ask_question` takes plain strings, and prose renders above the widget, so the design works there.
   - Claude Code's `AskUserQuestion` tool tells the model that the user may see only the question dialog, and that earlier text in the turn may not be on screen. So in Claude Code the dialog is the only surface that is sure to be seen, and the skill makes it the thinnest one.

2. **After the first answer, Claude Code drops the per-question prose entirely.**
   - The answer comes back as a tool result inside the same agent turn. The model continues straight to the next tool call.
   - Nothing in the skill says that the full step format repeats for every fork, including after a tool result. The step format is described once, and the series flow is described as "one fork, one call, one answer".
   - "After Each Answer" says "Acknowledge in one line … On to the next" and "Do not repeat the preview". This reads as "move on quickly". It was meant to say "do not re-show the fork that was just answered".
   - The Concise output style ("cut narration", "short by default") and the tool's own "keep questions self-contained" guidance push the same way. Antigravity has neither pressure, which is why it behaves.
   - Even the one-line "Noted:" acknowledgement the skill requires was skipped, which shows the after-answer section was not applied at all.

3. **Secondary: the fork counter drifted.** Series 3 opened as "of 5" and the next call said "of 3", with no announcement that the fork map changed.

## Decisions (clarify session, 2026-11-19)

| # | Decision | Chosen |
| --- | --- | --- |
| 1 | Where explanations live in Claude Code | Both: full prose step above the call and a self-sufficient dialog (F1) |
| 2 | Enforcement | Skill rules plus an anti-pattern entry (F2, F3); add a PreToolUse hook only if the checker still finds failures |
| 3 | Terse output styles | The step format takes precedence during a series; acknowledgements and the closing stay terse (F4) |
| 4 | Verification | `jq` transcript checker plus one live run per harness (F6) |
| 5 | Delivery | One PR including this case study, `@Doc-Cr` reviews; test install of the branch before the PR, then reinstall from `main` after merge |

`/cplain` and `/celi5` are aliases that defer to `clarify` Mode B, so they need no edits. The fix covers Mode B's Claude Code example, and the live test runs all three commands.

## Live test 1 (clarify-check, 2026-11-19): the per-question rule lost

- Session `clarify-check` (`~/.claude/projects/-home-rockad-projects-doppelganger/297faa14-…jsonl`) loaded the fixed skill. The checker gave `PASS Fork 1/10` and `FAIL Fork 2/10: no step prose`.
- The dialog part (F1) held: Fork 2 descriptions were 183–194 characters with 8-line previews.
- Cause: the Concise output style re-injects its `turnReminder` ("Be concise: … skip preamble and narration") after every tool result. That puts it right before Question N+1, where it outweighs skill text loaded much earlier.

Second clarify round (no hooks):

| # | Decision | Chosen |
| --- | --- | --- |
| 1 | How to beat the reminder | Every Claude Code option preview ends with `→ next: full Question N+1 write-up, then ask`. The answer echo repeats the chosen preview right beside the reminder. The Style rule is reworded to cite Concise's own "full detail on request" rule. Hooks are the fallback only if the next test fails. |
| 2 | Hint to switch off Concise | None for now, so the test measures the nudge alone |

## Live test 2 (with the `→ next:` nudge): pass

| Session | Harness / mode | Checker |
| --- | --- | --- |
| clarify-test | Claude Code, `/clarify`, Concise | 3/3 PASS, step prose 2,697–3,618 chars |
| cplain-test | Claude Code, `/cplain`, Concise | 3/3 PASS, step prose 3,281–3,784 chars |
| celi5-test | Claude Code, `/celi5`, Concise | 3/3 PASS, step prose 3,751–4,305 chars |
| Antigravity | `/clarify`, "keep responses concise" | full step on all 3 forks (by eye) |

- In cplain-test and celi5-test, the 5-hour usage limit hit between Q2 and Q3. Q3 therefore started a fresh turn and is weaker evidence than Q1–Q2.
- One earlier miss happened in the authoring session, after the nudge was written but before it was installed: Fork 2/2 had no step prose. The nudge improves the odds and does not guarantee the result. If misses recur, the fallback is a `PreToolUse` block in skill frontmatter.
- Antigravity's turn 1 ended without calling `ask_question`. That is a pre-existing, separate issue and is not changed here.

## Fix plan

### F1. Make the Claude Code dialog stand on its own (main fix)

- Claude Code `description`: two or three sentences per option, covering what it does, the main pro and the main con. Target 150–300 characters.
- Claude Code `preview`: the technical block, followed by `+` pro lines and `-` con lines, about 6–12 lines. Previews render only with `multiSelect: false`, which the skill already requires.
- Rewrite the Claude Code examples (Mode A and Mode B) to show this density.
- Scope the anti-pattern at line 557 to GUI harnesses whose dialogs break on long text (Antigravity). In Claude Code, a thin dialog is the anti-pattern.
- Leave Antigravity and OpenCode unchanged.

### F2. State a per-fork invariant

- Add to "The Shape of Each Step": every fork N gets the full step (heading, context, argued options, reading, recommendation) in prose immediately before its own question call. This includes forks 2..N that follow a tool result in the same turn.
- Add an anti-pattern: "Back-to-back question calls", meaning two question tool calls with no step prose between them.

### F3. Rewrite "After Each Answer"

- The order becomes: the "Noted:" line, then the full `## Question N+1` step, then the call.
- Replace "Do not repeat the preview" with "Do not re-show the fork that was just answered".

### F4. Precedence over terse output styles

- One line in the skill: while a clarify series is running, its step format takes precedence over concise or terse output styles. The analysis is the detail the user asked for, and the Concise style's own rule 5 allows full detail on request.

### F5. Lock the fork count

- The total is fixed when the fork map is announced. If it changes, say "Fork map revised: N → M (reason)" before the next question.

### F6. Verification

- Add a `jq` transcript check, `scripts/check-clarify-transcript.sh <jsonl>`. For each `AskUserQuestion` whose header matches `Fork N/M`:
  - the preceding assistant message has a text block that contains `## Question N`
  - every option `description` is at least 120 characters
  - every option `preview` is non-empty
  - the `M` in the header is constant across the series, unless a "Fork map revised" line comes before the change
- Run it on `e74c1164…jsonl` first; it must fail (baseline).
- Before the PR: install the branch's skill into `~/.agents/skills/clarify` (a temporary test install, an exception to the install-from-`main` rule).
- Live test: a toy design with four forks under `/clarify`, `/cplain` and `/celi5` in Claude Code with the Concise style on, each in a fresh session. Run the check on each new transcript. Repeat once in Antigravity and confirm nothing regressed.
- After merge: reinstall from `main` with `npx skills add rockad/agentic-hub --skill clarify`.
- Validate: `claude plugin validate .` and `bash scripts/check-skills-marketplace.sh`.

## Scope and ownership

- Files: `skills/clarify/SKILL.md` (F1–F5) and a new `scripts/check-clarify-transcript.sh` (F6). `skills/cplain` and `skills/celi5` are 13–14-line entry points, so they inherit the fix with no change.
- The skill author is `doccr` (GitHub `@Doc-Cr`), so request their review on the PR.
- Estimate: one Sonnet code-engineer pass for F1–F6, then one live re-test per harness.
