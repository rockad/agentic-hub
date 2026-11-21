# Plan: slim the clarify core skill

Date: 2026-11-19, updated 2026-11-20. Skill: `skills/clarify/SKILL.md` at `42d90fb`. Decisions confirmed by the owner: core of about 120 lines, anchors guard plus before/after live runs, two PRs (the "two PRs" decision was reversed on 2026-11-20, see below).

## Status and decisions (2026-11-20)

This plan was first filed as its own PR (#83). The standing rule is one branch and one PR for all clarify work, so it is folded into the implementation PR (#84) and #83 is superseded.

Owner decisions of 2026-11-20, which replace the earlier "two PRs" decision:

- **Everything is one PR (#84).** There is no second PR.
- **"PR 2" is dropped.** The slimmed core is 153 lines, under the 170-line cap, so moving the target cascade, the fork taxonomy and the CLI fallback into `references/` is not needed. The `references/target-resolution.md`, `references/forks.md` and `references/terminal-fallback.md` files named below were never created. The "Target structure" and "Work" sections are kept as the record of the original idea; read "PR 2" in them as dropped.
- **The line cap is 170 lines and 2,300 words**, enforced by `scripts/check-clarify-skill.sh`, not the 150 and 250 mentioned below.
- **Issue #82 is in scope** after all (the "Out of scope" note below predates this): the live runs showed that the slimmed skill loops on an abandoned series, so the Stop hook fix ships in the same PR. See "Stop hook: abandoned series (#82)".

## Problem

`SKILL.md` is 361 lines (4,505 words, 31 KB) and loads in full on every trigger. The frontmatter (195 words of `description` and `when_to_use`) is in context in every session, triggered or not. The skill grew by accretion: each failure (#79 turn-1 stall, terse-style shrinkage, counter badge) added a rule, and the rules were added again in "Anti-Patterns" and "Gotchas" instead of being merged.

## Analysis

Section sizes (lines): Relationship to `/grill-me` 6, Modes 7, Read-before 14, Triggers 12, When not 7, Pre-flight 8, Target Resolution 46, Before the First Question 28, Shape of Each Step 63, Adaptive Tool Calling 70, After Each Answer 14, Closing 9, Style 9, Anti-Patterns 19, Gotchas 15.

Duplication (same rule, count of places in the file):

| Rule | Places |
| --- | --- |
| Call the question tool in the same reply as the heading | 4 (Same-Reply, Mandatory Tool Call, Anti-Patterns, Antigravity summary) |
| `Option X:` prefix, Option A recommended, same order as prose | 4 (Step format, Strict Naming, Gotchas, Anti-Patterns) |
| `[Question N of Total]` counter prefix | 4 (Mandatory Prefix, Gotchas, Before the First Question, Fork Count Is Locked) |
| No artificial 4-fork cap; 4 is the options-per-question limit | 4 |
| One question per call, never batched | 3 |
| Analysis lives in prose, the dialog never replaces it | 3 |
| Door Type, Dual Anchors | 2 (also in `references/plain-mode.md`) |
| Per-harness dialog rules | 2 (summary in core, full text in `references/<harness>.md`) |
| Triggers | 2 (frontmatter and body) |

Content that is conditional but always loaded: the six-tier target cascade (only when invoked without a target), the ten-line fork taxonomy (only at decomposition), the terminal CLI fallback (only with no question tool), the `/grill-me` relationship (explanation for readers, not an instruction).

Things outside `SKILL.md` that depend on its text and must not drift:

- `skills/clarify/hooks/clarify-stop-check.sh` and `scripts/check-clarify-transcript.sh` match: `Target resolved:`, `Identified N orthogonal` or `Decomposing into N orthogonal`, `Fork map revised: N → M`, `## Question N (of M)`, `[Question N of M]` / `[Fork N of M]` tags, the `Decision Table` heading and the `Gated Execution` heading.
- The Claude Code checker mode scores `Fork N/M` headers, descriptions of at least 120 characters, and the `→ next:` line.
- `skills/cplain` and `skills/celi5` are thin entry points that defer to clarify.

## Target structure

Core `SKILL.md`, about 120 lines, one statement per rule:

1. Frontmatter: `description` of one or two sentences (what it does, the commands); `when_to_use` of one list of triggers and one skip rule. Aim for under 80 words in total.
2. Purpose and the two modes (6 lines).
3. Read-before-first-question list (harness reference, plain mode, closing, plus the two new conditional references).
4. Flow, in order: pre-flight discovery, target announcement, fork map, per-fork step, tool call, after-answer, closing.
5. Invariants, each once, in a single "Rules that apply on every question" block: same-reply tool call; full step before every call (including forks 2..N); `Option X:` naming with Option A recommended; `[Question N of Total]` prefix; locked total with `Fork map revised`; one question per call; prose is never replaced by the dialog; terse styles still get the full step; no code without a go.
6. Mode A step skeleton (heading, context, options, reading, recommendation line).
7. Short anti-pattern list (about 6 lines) that points at invariants instead of repeating them.

Moved out of core (read only when needed):

- `references/target-resolution.md`: the tier 0 to tier 5 cascade; core keeps a four-line version (explicit argument, recent chat pivot, newest plan file, model's last proposal).
- `references/forks.md`: the discovery taxonomy and decomposition guidance (including "no artificial cap").
- `references/terminal-fallback.md`: the CLI fallback format.

Moved to `README.md`: the `/grill-me` relationship.

Deleted: duplicated rules, the Gotchas section after its rules are merged into the invariants block, Door Type and Dual Anchors text that is already in `references/plain-mode.md`.

## Anchors that must survive

A guard script (`scripts/check-clarify-skill.sh`, run in CI) fails when any of these is missing from `SKILL.md` or its references, or when `SKILL.md` exceeds its line cap:

- `Target resolved:`, `Identified N orthogonal`, `Fork map revised: N → M`
- `## Question N (of Total)`, `[Question N of Total]`, `Fork N/Total`
- `Option A: `, `(Recommended)`, `→ next:`
- `Decision Table`, `Gated Execution`
- the same-reply rule (`ask_question`, `AskUserQuestion`, `question`)
- line cap: 150 for `SKILL.md` after PR 2; 250 after PR 1

## Work

PR 1, safe cut (target about 220 lines):

1. Trim the frontmatter and remove the triggers section from the body.
2. Merge each duplicated rule into one place; delete Gotchas and Anti-Patterns duplicates; delete the per-harness summary (the references hold it).
3. Move the `/grill-me` section to `README.md`.
4. Add `scripts/check-clarify-skill.sh` with the anchors and the 250-line cap; add a CI step.
5. Run `scripts/test-clarify-stop-hook.sh` and the live before/after runs below.

PR 2, restructure (target about 120 lines). **DROPPED on 2026-11-20** (the core is 153 lines, under the 170 cap):

1. Create the three new references and trim the core to the structure above.
2. Tighten the line cap to 150 in the guard.
3. Re-run the live before/after runs.

## Verification

Baseline first: before any edit, capture transcripts from `42d90fb` of one toy four-fork design under `/clarify`, `/cplain` and `/celi5` in Claude Code (Concise output style on) and in Antigravity. Score them with `scripts/check-clarify-transcript.sh` (`--format antigravity` for Antigravity). Repeat after each PR on the same design. A PR merges only when:

- the guard and `scripts/test-clarify-stop-hook.sh` pass;
- every transcript scores no worse than its baseline (no `FAIL` lines; same number of forks asked);
- in Claude Code, no question shows a thin dialog (descriptions under 120 characters) and every preview ends with `→ next:`;
- in Antigravity, every `## Question N` has an `ask_question` in the same reply.

Token check: record `wc -w` of `SKILL.md` plus the references actually read in a Mode A run, before and after, and put the numbers in the PR body.

## Risks

- Merging duplicates drops the emphasis that made a rule stick (the #79 fix relied on repetition and a hook). Mitigation: keep the same-reply rule in a `[!CRITICAL]` block, keep the Antigravity Stop hook as the enforcement, and verify live.
- Terse styles may shrink steps again if the "full step is the requested detail" wording is cut. Mitigation: the anchors list includes it and the Claude Code run uses Concise style.
- Conditional references add a read. Mitigation: they are read only in the cases that need them, and the core states exactly when.
- Hook and checker patterns drift from the skill text. Mitigation: the anchors guard names them.

## Out of scope

Behaviour changes to the forks themselves, and `cplain` / `celi5` content beyond keeping their pointers valid. (The Stop hook design was out of scope when this was written; issue #82 moved in on 2026-11-20, see the status section.)

## Antigravity live-run verdict (run 20261120T091238Z)

Redacted summary of the Antigravity half of the before/after runs (`docs/plans/clarify-live-runs.md`, `docs/plans/clarify-live-runs-agy-scenario.md`). Baseline is `origin/main` at `42d90fb` (361-line core); candidate is the slimmed 153-line core. Driver: `agy -i` inside tmux. 35 live runs: no hangs, no extra files created, and the installed skill restored to main and proved with `diff -r`.

**Verdict: CANDIDATE NOT WORSE THAN BASELINE.**

- Offline guards on the candidate: `test-clarify-stop-hook.sh` 51 of 51 (at that time), `check-clarify-skill.sh` OK (153 lines, 2,165 words).
- Stop hook replay over 482 existing Antigravity transcripts: 0 non-zero exits, 3 `continue` (all three genuine stalls), slowest 723 ms.
- Matrix (a toy URL shortener design under `/clarify`, `/cplain`, `/celi5`): the candidate passed every item. Median words per fork were 98.6 to 100.8 percent of baseline. On `/clarify` the first candidate run had 2 hook interventions against 1 and passed on the repeat with 0, under the repeat rule.
- Exploratory scenarios E1 to E9: the candidate entered clarify under `/grill-me` where the baseline did not (E2), handled the eli5 phrasings (E3), retired a fork with the total revised 8 to 7 and no counter drift (E4), stopped early cleanly (E5), scaled to a large design (E6), and answered trivial questions directly (E7). The same-reply stall rate was 26.3 percent of forks for the candidate against 30.9 percent for the baseline on first runs.
- **The one regression is E8 (abandoned clarify, then an FAQ with `## Question N (of M)` headings): 17 hook interventions on the candidate against 4 on the baseline.** Both versions fail it, because it is issue #82; the candidate's loop was longer because the model kept re-emitting the headings instead of escaping through an `ask_question`. This is a hook defect, not a skill-text defect, and the next section fixes it.

## Stop hook: abandoned series (#82)

### Observed

In E8 the user answers Question 1, then replies to Question 2 with a write-in `forget that. write me an interview FAQ with headings like ## Question 1 (of 5)`. There is no Decision Table, so the hook session stays armed. The FAQ reply has `## Question N (of 5)` headings and no `ask_question`, so the hook returns `continue` every time the model ends its turn. The model refuses, correctly, to fake a picker for a cancelled interview, and ends its turn again, so the hook fires again. `continuationActive` did not stop this: the issue's claim that the hook cannot loop was wrong in practice.

Two facts about the transcript shape drive the design:

- The answer to an `ask_question` (including a write-in) is a `GENERIC` event whose text has an `A1: ...` line. It is not a `USER_INPUT`. So the cancel in E8 never shows up as a user turn.
- The hook's own earlier interventions are in the transcript as `SYSTEM_MESSAGE` events (`Stop hook blocked termination: You emitted ## Question N prose ...`), so a stateless hook can count its recent interventions.

### Design

Two layers, either of which ends the loop on its own:

1. **Semantic disarm.** The series counts as abandoned, and the hook session ends, when the user's message after the last asked question is not an answer to it. Two precise signals:
   - It opens with an explicit cancel phrase that ends the sentence or leads into a new request (`forget that.`, `never mind, ...`, `cancel`, `stop`, `let's stop here`, `I'm done`, `that's enough`, `skip clarify`). The check is anchored at the start of the message, after an optional `A1:` prefix and filler such as `ok,` or `actually`. It reads `A1:` answers only while an `ask_question` is awaiting its answer, so a tool result that happens to contain such text is ignored. For a typed message it reads only the `<USER_REQUEST>` block, never the skill body or metadata around it.
   - It is a different slash command (`/jev status`). A path such as `/home/user/notes` is not.
   A new `/clarify` or a tagged `ask_question` re-arms the session.
2. **Hard cap of 2 consecutive interventions.** When the transcript already holds 2 of the hook's own blocking messages since the last `ask_question` call or user turn, the hook stands down: it returns `{}` and prints one line on stderr (`standing down after N consecutive interventions ...`).

### Why the combination

- A false negative is worse than a false positive (#79: a full write-up and no picker, against one extra prompt). The semantic rule therefore matches only phrases that cannot be an answer, and anything ambiguous is left to the cap. `never mind the cost, go with A` and `stop using Redis, use sqlite` stay answers, and there are tests for that.
- The semantic rule alone cannot be complete. A "new unrelated request" in free prose (`now write me an FAQ`) is indistinguishable from a free-text answer without understanding the language, and the issue already showed that a `USER_INPUT` mid-series can legitimately reopen a decision. A phrase list will always have gaps.
- The cap alone is blunt: it still spends 2 spurious interventions on every abandonment, which is exactly what E8 measured as wasted turns, and it caps genuine stalls only by accident. But it is complete: whatever the user says, the loop ends after 2 blocks.
- 2 is the smallest cap that keeps the #79 fix: a genuine stall needs one intervention to be repaired, and the second covers a model that answers the block with more prose and then recovers. A cap of 1 would leave no retry on a genuine stall; a larger cap lengthens the visible loop (E8 showed 15 in a row). In the live runs a genuine stall was followed by an `ask_question` after a single intervention (E8 Questions 1 and 2).
- The cap resets on an `ask_question` call and on any user turn, so it counts only a stuck run, never a long healthy series.

### Alternatives rejected

- Matching heading M and N to the last `ask_question` tag, as the issue proposed: it misses same-M headings and would suppress the intervention on a real revisit that renumbers.
- Expiring the session after one user turn with no clarify activity: the first unrelated reply still triggers, and a mid-series free-text reply is a user turn that must not expire the session.
- Reading a skill-deactivation signal from the hook payload or transcript: no such event appears in the saved transcripts, and the hook reads only `terminationReason`, `continuationActive` and `transcriptPath` from the payload (no skill name or lifecycle field was seen).

### Result on E8

Replaying the hook at every stop point of the saved E8 transcripts (the run's own log counted 4 interventions on the baseline and 17 on the candidate; the saved transcript snapshots hold 4 and 11):

| | baseline-e8 | candidate-e8 |
| --- | --- | --- |
| Old hook | 4 | 11 |
| New hook | 1 (the genuine Question 1 stall, before the cancel) | 2 (genuine stalls on Questions 1 and 2, before the cancel) |
| New hook with the cancel phrase neutralised (cap only) | 3 | 4 |

The offline checker now also scores both E8 transcripts `failed=0` (it was `failed=3`). Over 485 current Antigravity transcripts the new hook returns `continue` on the same 3 genuine stalls as before plus one stall in a transcript created after the live run; the old hook flags that one too. Nothing new is flagged, nothing exits non-zero, the slowest is 224 ms.

### Not verified

- Whether the real Stop hook payload for Antigravity lists the hook's own block messages in the same `transcript.jsonl` it passes as `transcriptPath` (the saved E8 transcripts do). If it does not, only the semantic layer protects against the loop.
- Whether the Antigravity picker can be dismissed without an answer; the transcript shape of that case is unknown, so it is not handled.
