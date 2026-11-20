# Plan: live before/after runs for the clarify slimming (Claude Code and Antigravity)

Date: 2026-11-19. Gate for PR #84 (`refactor/clarify-dedupe`) in `docs/plans/clarify-slimming.md`. Baseline is `main` at `42d90fb` (361-line skill); candidate is the branch tip.

## What a run must show

The offline checker and the Stop hook tests use fixtures. Only a live run shows the four failure modes:

- (a) Antigravity: a `## Question N` write-up with no `ask_question` in the same reply.
- (b) Claude Code under Concise: thin steps, thin `AskUserQuestion` dialogs, missing `→ next:`.
- (c) The `1/1` counter badge (missing `[Question N of M]` prefix).
- (d) Forks 2..N skipping their full step after an answer.

## Setup

Both harnesses read the same skill: `~/.claude/skills/clarify` is a symlink to `~/.agents/skills/clarify`, which is currently the `main` copy (identical to `origin/main`). So the A/B swap is one directory:

1. `cp -a ~/.agents/skills/clarify ~/.agents/skills/clarify.main` (backup, outside the skill name).
2. For the candidate runs: `rsync -a --delete <worktree>/skills/clarify/ ~/.agents/skills/clarify/`. For the baseline runs: `rsync -a --delete ~/.agents/skills/clarify.main/ ~/.agents/skills/clarify/`.
3. When done, restore `main` the same way and delete the backup. `cplain` and `celi5` stay untouched (thin entry points).
4. Confirm the Stop hook is registered (`jq '."clarify-require-tool-call".enabled' ~/.gemini/config/hooks.json` is `true`); it is for Antigravity only.

This edits files in `~/.agents/skills`, outside the repo, so do it only with the owner's go and restore at the end.

Run in a scratch directory with no repo (for example `$CLAUDE_JOB_DIR/tmp/toy`), so pre-flight discovery finds nothing and target resolution uses the explicit argument.

## The toy design and scripted answers

Prompt (explicit target, so Tier 0): `/clarify design a URL shortener service` (and `/cplain ...`, `/celi5 ...` with the same topic).

Answers, identical in every run, by fork order:

1. Pick Option A (recommended).
2. Pick Option B.
3. Choose "Other" and type `use Redis for the hot path` (tests taking "Other" without pushback and re-checking remaining forks).
4. After the Question 4 write-up, answer with free text that touches fork 1 (`actually also support custom aliases`) to test out-loud revisiting.
5. Pick Option A for every remaining fork.
6. At the closing, reply `no go yet` and stop (never let it write code).

## Driving the sessions

Step 0, feasibility probes (10 minutes, decide the driver per harness):

- **Claude Code:** drive an interactive session in `tmux` (`tmux send-keys` for the answers; Concise style on via `/config` or the settings file). Headless `claude -p` is not a candidate: `AskUserQuestion` needs the picker.
- **Antigravity:** try `agy -p ... --input-format stream-json --output-format stream-json` with one NDJSON message per turn; check that `ask_question` calls appear and an answer message resolves them. If not, drive `agy -i` in `tmux` the same way, or have the owner answer by hand.
- Fallback for either: the owner runs the sessions by hand with the answer sheet above, and hands over the transcript paths.

Transcripts to score:

- Claude Code: `~/.claude/projects/<project-slug>/<session>.jsonl`.
- Antigravity: `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl` (the checker's `--format antigravity`).

## Matrix

| Harness | Style | Commands | Versions | Runs |
| --- | --- | --- | --- | --- |
| Claude Code | Concise on | `/clarify`, `/cplain`, `/celi5` | baseline, candidate | 6 |
| Antigravity | default | `/clarify`, `/cplain`, `/celi5` | baseline, candidate | 6 |

Order: all baselines first, then swap once, then all candidates. Model nondeterminism is real: a candidate failure counts only if it repeats on a rerun or the matching baseline passed both of its runs. Rerun every failing baseline cell once too.

## Scoring (per transcript)

1. `scripts/check-clarify-transcript.sh [--format antigravity] <transcript>`: no `FAIL` lines. Record `checked`, `failed`, `warned`.
2. Forks asked: the same number as the baseline within one fork (the fork map may legitimately differ by one).
3. Step depth (guards (b) and (d)): words of assistant prose before each question call, per fork. Candidate median per fork must be at least 75% of the baseline median, and fork 2..N must not be shorter than 50% of fork 1 in the same run. Compute with `jq` over the transcript.
4. Claude Code only: every `AskUserQuestion` description is at least 120 characters, every preview ends with `→ next:` (checker `WARN` count must not rise).
5. Antigravity only: every `## Question N` has an `ask_question` in the same reply (checker); count Stop hook `continue` interventions per run (candidate must not need more than the baseline).
6. Counter prefix `[Question N of M]` on every call; `M` constant unless `Fork map revised` appears.
7. The "Other" answer was taken and later forks acknowledged it; the free-text clarification produced an out-loud revisit.
8. The closing has the Decision Table, the artifact, and the gate, and no code or file was written.

## Decision rule

PR #84 is marked ready when every candidate cell passes 1, 2, 4, 5, 6 and 8, and 3 and 7 are not worse than the baseline in the same cell, after the rerun rule above. A blocking regression (a missing tool call, thin dialogs, skipped step prose) means restoring the lost rule in the core, re-running only the affected cells, and not merging until they pass.

## Cost and time

12 runs of about six forks each. Roughly two to three hours of wall time if scripted, four if answered by hand. Record the result table in the PR body.
