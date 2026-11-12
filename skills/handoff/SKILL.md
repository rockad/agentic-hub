---
name: handoff
description: >-
  Create or update a project's living handoff document (HANDOFF.md, in the project root
  or in a directory named by the HANDOFF_DIR environment variable): where the work
  stands, decisions with their reasons and what was rejected, deferred branches with
  their triggers, open questions, next actions. A new session, another person or a
  cheaper model can continue from it without the original conversation. The mode
  "/handoff switch" carries the work across a change of login or subscription.
  Optionally installs a SessionStart hook that reminds you when HANDOFF.md has fallen
  behind the project's files.
when_to_use: >-
  Only when the user invokes it by name ("/handoff", "/handoff switch", "run the handoff skill"). Do not
  start it on indirect phrases such as "save the context" or "write down where we are":
  the user decides when the handoff format is wanted.
disable-model-invocation: true
---

# handoff: the living handoff document

You keep the project's handoff file (`HANDOFF.md` in the project root, or in `$HANDOFF_DIR`; see Step 1): the file from which a session that never saw the original conversation recovers EVERYTHING it needs to continue. It records STATE ("where we are, what is decided, what is next"), not procedures and not the train of thought.

## When not to use it

- A routine mechanical task with no decisions: a handoff is overkill.
- Documentation of how the system works: that belongs in a README, inline docs or a skill. A handoff is about state, not structure.
- The step-by-step reasoning inside one topic, rejected branches included: that is a JOURNAL.md; the handoff only links to it.

A handoff answers "where are we and what is next", not "how does it work" and not "how did we reach this decision step by step".

## Step 1: find the file

Resolve the target in this order and use the first that applies:

1. A path the user names.
2. `$HANDOFF_DIR/<repo>-HANDOFF.md`, when the environment variable `HANDOFF_DIR` is set and non-empty. `<repo>` is the repository's directory name: the parent directory of the git common dir, so every worktree of one repository shares one file. Make it filename-safe (replace anything but letters, digits, `.`, `_` and `-` with `-`). Outside git, use the current directory's name.
3. `HANDOFF.md` in the root of the current project. This is the behaviour when `HANDOFF_DIR` is unset, unchanged.

If `HANDOFF_DIR` is set and a root `HANDOFF.md` also exists, do not leave two copies. If the `HANDOFF_DIR` path does not exist yet, move the root file there. If both exist, tell the user and ask which to keep; do not merge them yourself. Never `git add` a file that lives outside the repository.

If the target EXISTS, read it in full: you continue it, you do not rewrite it. If it does NOT, create it from the structure below.

## Step 2: collect the state

Do not invent anything. Collect from the current conversation, the git history (in a repository), the existing docs, and what was actually done in this session. Date every fact that can go stale (use today's real date).

## Step 3: write or update by the structure

A header plus nine sections (a tested structure; section 10 when facts drift):

```
# HANDOFF: <project>
Date: <today> (updated <date>: <what changed>).
The reader has not seen the original conversation; everything needed is here.

**What this file does NOT hold, and where to look (memory map):**
- <kind of information> → <where it lives, NOT here>
- ... (procedures → code and docs; reasoning → JOURNAL; here, only state)

## 1. One-page summary
What the project is, where it stands, the "right now" point, the next actions.

## 2. Chronology of <the work / the thinking>
Numbered steps. APPEND-ONLY: add new steps, do NOT rewrite earlier ones.
This protects the history from being rewritten after the fact.

## 3. Key decisions (summary)
Each one: decision, reason, what was rejected. Without "what was rejected" a
decision is incomplete: the next session will reopen what was discarded.

## 4. Rejected and deferred branches
Each with a TRIGGER, not "some day": the condition for coming back to it.

## 5. Open questions and risks
What is unresolved, what can break, where the main risk is.

## 6. Assets
Table: file or path · what it is · status. Honest about what is done, what is
a draft, what is unverified.

## 7. Key wording, verbatim
Insurance against lost files: critical phrases, numbers and commands, word for word.

## 8. Sources and tools of the session
What the work relied on, what it used.

## 9. Open threads → next actions
A numbered list of concrete next actions.

## 10. Re-verification (facts that drift silently)  [optional]
One-line commands that re-check claims which will go stale ("N records",
"all closed", "version X"). No hook catches that drift: give a command, not a bare claim.
```

Quality rules:
- The audience has zero context: expand every abbreviation on first use.
- No oversell: mark anything unverified as "unverified", "hypothesis" or "draft".
- Section 2 is append-only. Keep sections 1, 5, 6 and 9 current (they may be rewritten). Date status facts.

## Step 4: the drift hook (optional; ask once PER MACHINE)

A handoff rots when nobody updates it. A SessionStart hook adds a reminder at the start of a new session when HANDOFF.md is older than the project's files, and goes silent again once the handoff is saved.

The hook is **self-locating**: it reads the session's `cwd` from the SessionStart JSON on stdin, walks up from it to the nearest `HANDOFF.md`, and checks drift for THAT project. So:
- **It is installed once per machine** and serves EVERY project. A second `/handoff` in another project does NOT touch it; there is nothing to register again.
- **Nothing is hard-coded**: there are no placeholder paths to fill in. Do NOT edit the paths in the hook.

The hook ships for Claude Code (`hooks.SessionStart` in `~/.claude/settings.json`). Other harnesses need their own registration of the same script.

If the hook is not installed yet (search for `handoff-drift` in `~/.claude/settings.json`) and the user agrees, install it:
1. Copy `hooks/handoff-drift.sh` (macOS and Linux, needs `python3`) or `hooks/handoff-drift.ps1` (Windows) to `~/.claude/hooks/`; for `.sh`, `chmod +x`. Detect the user's OS. Do not edit the hook body.
2. Register it with ONE entry under `hooks.SessionStart` in `~/.claude/settings.json`, APPENDING an element to the array. CRITICAL: do not overwrite existing hooks; other SessionStart hooks may be load-bearing. Prefer a deterministic config-editing tool over a hand merge of the JSON.
3. If a `handoff-drift` entry already exists, do NOTHING: the hook is global and already covers this project.
4. Tell the user it only takes effect from the NEXT session (SessionStart is read at start), and that it stays silent when the handoff is fresh OR the project has no HANDOFF.md: silence is normal.

## Mode: switch (carry work across a change of login or subscription)

Invoked as `/handoff switch`. Text only: there is no script, no index and no per-switch note. The state file plus the session transcript carry the work. The steps below are the same in every harness; the commands differ, so each step says where to find them.

### Skeleton

1. **Run the normal handoff first** (Steps 1 to 3), so the state file is current before anything changes.
2. **Finish or stop background work.** Details in the file for your harness.
3. **Change the login.** Details in the file for your harness.
4. **Verify the new login is live.** Details in the file for your harness.
5. **Continue the work:** resume the session, or start a fresh one. Details in the file for your harness.
6. **Verify the state against git before trusting anything**, whichever way you continued.

### "Start here" prompt for a fresh session

Give the user this text to paste into the new session, with `<handoff-file>` filled in with the resolved path from Step 1:

```
Read <handoff-file> in full. Then verify before you act:
- git branch --show-current
- git status --short
- git log --oneline -8
Check every claim in the file against evidence. Label each statement you rely on as
verified (you checked it just now), reported (the file says so, not re-checked) or
unverified. First action: report the branch, the git state and the next action in three
lines, then wait for me.
```

### Files per harness

| Harness | File | Status |
| --- | --- | --- |
| Claude Code | `skills/handoff/switch/claude-code.md` | written |
| Antigravity | `skills/handoff/switch/antigravity.md` | not written yet: ask the owner; to be written by an agent running in that harness |
| OpenCode | `skills/handoff/switch/opencode.md` | not written yet: ask the owner; to be written by an agent running in that harness |

If the file for your harness does not exist, say so and stop at the steps you can do harness-neutrally (1 and 6, and the "Start here" prompt); do not invent commands.

## Gotchas

- **An unset `HANDOFF_DIR` silently puts `HANDOFF.md` back in the repository.** The design keeps today's behaviour when the variable is unset (Step 1, item 3), so there is no warning and no error: the file lands in the project root. In a public repository a stray `HANDOFF.md` can end up in a commit. Before relying on the setting:
  - set `HANDOFF_DIR` where every session sees it (the harness's own environment settings, not only an interactive shell), because it is unverified whether sessions started by a daemon or by other tools receive it;
  - run `/handoff` once in each kind of session you use, including a background one, and check that no `HANDOFF.md` appeared in the repository root (`git status --short`);
  - never `git add` a handoff file.
- **The optional drift hook does not know `HANDOFF_DIR`.** With `HANDOFF_DIR` set, the hook (Step 4) finds no `HANDOFF.md` above the working directory and stays silent.
- **The drift hook is global, one per machine.** It is self-locating (the project comes from cwd). A second `/handoff` in another project does NOT register it again: grep for `handoff-drift` in `~/.claude/settings.json` first.
- **A silent hook is normal.** It fires only from the next session and only when the handoff is behind the files. It is silent when the handoff is fresh or there is no HANDOFF.md.
- **The chronology is append-only.** Rewriting it after the fact loses the history: add the new, leave the old.
- **The date is never hard-coded** from this SKILL.md: use the real date at the time of the edit.
- **Registering the hook never overwrites other hooks**: append an element to the SessionStart array with a deterministic tool, not a hand merge.

## Upkeep

Update the handoff at the end of a substantial block of work, not after every reply. To check that the hook is registered, search for `handoff-drift` in `~/.claude/settings.json`.
