# Plan: slim the clarify core skill

Date: 2026-11-19. Skill: `skills/clarify/SKILL.md` at `42d90fb`. Decisions confirmed by the owner: core of about 120 lines, anchors guard plus before/after live runs, two PRs.

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

PR 2, restructure (target about 120 lines):

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

Behaviour changes to the forks themselves, the Stop hook design (issue #82 stays separate), and `cplain` / `celi5` content beyond keeping their pointers valid.
