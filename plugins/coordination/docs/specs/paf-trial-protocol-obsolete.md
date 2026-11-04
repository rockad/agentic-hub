# phone-a-friend trial protocol: draft (task C5)

Status: OBSOLETE (2026-11-03). phone-a-friend was removed completely at the user's request; it does not give two-way, live conversation-to-conversation communication. The trial never ran. Kept as a record only.
Original status: DRAFT. **Not approved to run.** Nothing below has been executed. Running it needs the user's explicit yes in the session that runs it (Antigravity message 2 claims approval of O4; Claude Code has not seen it from the user).
Author: Claude Code (macp), 2026-11-03. Source: `~/projects/phone-a-friend` v4.16.0 (3c220b8), Apache-2.0, read-only clone.

## 1. Question the trial answers

- Does a synchronous relay between Claude Code and Antigravity (`agy`) work reliably on this machine (WSL), and does it turn silence into an error?
- Is the output structured enough to replace one bridge turn for a review?
- It does NOT test: Docker slot, leases, agentic mode, team mode.

## 2. Isolation rules

- Install into a scratch prefix only: `npm install --prefix <scratch>/paf @freibergergarcia/phone-a-friend@4.16.0 --ignore-scripts`. Never `-g`. Never run `setup`, `plugin install`, or marketplace registration (they edit host configs).
- Before installing: record `npm view @freibergergarcia/phone-a-friend@4.16.0 dist.integrity` and compare with the lockfile entry; run `npm audit --prefix <scratch>/paf` and keep the output.
- `better-sqlite3` is native: `--ignore-scripts` may leave it unbuilt. If the CLI then fails on it, record that, do not re-run with scripts without a fresh yes from the user.
- Run with `HOME` untouched but `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointed at a scratch dir, so PaF's task, session and job SQLite files land there; delete afterwards.
- Read-only scenarios only (`--sandbox read-only`); no Edit/Write, no shell commands by the backend. Target: a throwaway git repo with one small diff, not `cognitive-engine`.
- `PHONE_A_FRIEND_INCLUDE_DIFF` stays default only for the scratch repo; no secrets or vault content in prompts.
- No network use beyond the chosen backends and the one npm install; disable update checks if a flag exists (check `phone-a-friend --help`).

## 3. Steps and success criteria

1. `phone-a-friend doctor --json`: records which backends it finds (`claude`, `agy`). Pass: both detected, no stale host registration reported.
2. Scenario S1, Claude to Antigravity review: `phone-a-friend --to antigravity --review --verdict-json --prompt "Review this diff" --sandbox read-only` in the scratch repo.
   - Pass: exit 0, JSON verdict parses with `jq`, findings reference real lines of the diff, wall time recorded.
3. Scenario S2, silence becomes an error: same call with a short timeout flag (find the real flag in `--help`; if none exists, wrap with `timeout 20`) against a backend made unresponsive (for example `agy` replaced by a `sleep` shim on `PATH` in the scratch env only).
   - Pass: non-zero exit with a clear timeout message within the limit, no orphan child process left (`pgrep` check).
4. Scenario S3, session resume: two calls with `--session trial-1`; the second prompt depends on the first answer.
   - Pass: the second answer uses the first's context; `session` is listed by the CLI.
5. Scenario S4 (reverse direction, only if Antigravity runs it): Antigravity calls `--to claude` read-only on the same scratch repo.
   - Pass or fail recorded as is; this is A4's open question.

## 4. Measurements to record (plain table in the channel)

- Per scenario: wall time, exit code, output size, whether JSON parsed, cost or quota note if the backend reports one.
- Failure modes seen (auth prompts, headless `agy` shell denials, sandbox behaviour).
- Dependency footprint: `npm ls --prefix <scratch>/paf --all | wc -l`, disk size of the prefix.

## 5. Decision rule after the trial

- Adopt for delegation/review only if S1 to S3 pass and S1 wall time is acceptable to the user.
- If S3 or S4 fail but S1/S2 pass: adopt for one-way review only, document the limit.
- If `better-sqlite3` cannot run without install scripts, or `doctor` shows host-config side effects we cannot avoid: stop and report; the fallback is O1 only (own heartbeat plus `BuildSlot`).

## 6. Rollback

- Delete the scratch prefix, scratch XDG dirs and the throwaway repo; confirm `~/.claude`, `~/.codex`, `~/.config/opencode` and `~/.agents` are unchanged (compare `stat`/`ls -la` snapshots taken before, or `git status` where they are tracked).
- Nothing was registered with any marketplace, so nothing else to undo.

## 7. Open questions for the user

- Yes or no to run this trial (and who runs it: Claude Code, Antigravity, or both).
- Whether a native `better-sqlite3` build step is acceptable if `--ignore-scripts` breaks it.
