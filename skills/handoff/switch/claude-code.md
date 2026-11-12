# handoff switch: Claude Code

How to carry work across a change of Claude login or subscription in Claude Code. Part of `/handoff switch` (see `skills/handoff/SKILL.md` for the harness-neutral skeleton and the "Start here" prompt).

Labels: **V** verified (observed on one machine, 2026-11-11 and 2026-11-12), **I** inferred, **U** unverified, **D** documented by the harness.

## Steps

The commands below are the ones actually run on a real machine on 2026-11-11 and 2026-11-12.

1. **Compact.** Run `/compact` in the session you will continue. Prompt-cache entries are isolated per organization, so the other login writes the history to its cache cold; a smaller context is cheaper.
2. **Stop background work.** `claude daemon stop --any`. This stops background sessions, including the one you run it from. They respawn after the login.
3. **Change the login.** `claude auth logout`, then `claude auth login` as the other account. Inside a session, `/logout` and `/login` do the same.
4. **Verify the login.** `claude auth status`. Check `loggedIn`, `orgId` and `subscriptionType`. It prints the organization id, not the account id.
5. **Continue the work.**
   - Background sessions respawn and continue from the same transcript.
   - Otherwise resume by session id or by the absolute path of the `.jsonl` transcript:
     - interactive: `claude --resume <session id or absolute path>`
     - headless, writes nothing: `claude -p --resume <id> --no-session-persistence --output-format json "<prompt>"`
   - If you resume interactively and want the original transcript left unchanged, add `--fork-session`.
   - Fallback: a fresh `claude` plus the "Start here" prompt from `SKILL.md`.
6. **Verify the first reply against git** (`git status --short`, `git log --oneline -8`). Do not trust a claim without evidence.

## Verified and not verified

Verified (V), on one machine, 2026-11-11 and 2026-11-12:

- A transcript written under one account resumed on another account with no error, by each of three routes:
  - the daemon respawn of a background session
  - interactive `claude --resume`
  - headless `claude -p --resume`
- This held for a 778 KB and a 22 MB transcript.
- The headless cold-cache write was about 67k to 71k tokens for both. The cost follows the current context after the last compaction, not the file size (I: inferred from those two numbers, not read from the client).
- A resume keeps writing the session's CREATOR in its `session-owner` records, so those records do not show the live login after a switch.
- `claude auth status` shows the live organization.

Not verified (U):

- Whether the signed thinking blocks of the old transcript are actually replayed.
- An interactive session left open across `claude auth logout`.
- A transcript whose current context is near the window limit.
- A plan that lacks the session's model (the model was the same in every run).

Not movable (D): cloud sessions and Remote Control sessions are bound to the claude.ai account and cannot be moved to another login.

Terms: holding two accounts is not explicitly banned, but check that the organization behind a work seat allows this use. That is the user's to confirm. Also do not put anything in the state file that the other account's organization should not see, because the file crosses the switch.
