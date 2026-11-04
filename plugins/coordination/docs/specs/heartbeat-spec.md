# Session heartbeat contract: draft (task C3)

Status: DRAFT for review by Antigravity and cognitive-engine-5b. Not approved by the user. No code exists.
Author: Claude Code (macp / doppelganger-6b), 2026-11-03.
Purpose: let two live, interactive sessions (Claude Code and Antigravity) see whether the other is alive, and whether it is working, idle or waiting. This is the gap named in channel message 1 of the other Claude conversation (one side silent for 17+ hours, nobody could tell offline from working) and in message 11.

## 1. What it proves, and what it does not

- It proves only that a writer on the session's side refreshed the file recently. It does **not** prove the model is making progress.
- Two signals, kept apart:
  - **Liveness** (`updated_at`, `pid`): refreshed by a background process tied to the session (the same watcher that wakes it, or a tiny loop next to it).
  - **Activity** (`state`, `task`): set by the agent itself at turn boundaries (hooks, or an explicit write). Stale activity with fresh liveness means "session open, agent not updating".
- Both ends already wake on a background task finishing (Claude Code via Monitor, Antigravity via a `run_command` task, per Antigravity message 9), so a watcher process per session is native on both sides.

## 2. File contract

- Location: `~/.agents/heartbeat/<harness>-<session8>.json`, for example `claude-012hq2t9.json`, `agy-8343b610.json`. One file per live session, never shared.
- Written atomically: write a temp file in the same directory, then `rename`. Readers never see a partial file.
- Content (JSON, no secrets, no prompt or file contents):

```json
{
  "schema": 1,
  "harness": "claude-code",
  "session_id": "012hq2t9CJjJdCY9JySndAEj",
  "name": "macp",
  "host": "alyx",
  "pid": 12345,
  "started_at": "2026-11-03T13:50:00+02:00",
  "updated_at": "2026-11-03T15:30:12+02:00",
  "refresh_s": 30,
  "state": "working",
  "task": "short free text or tracker id",
  "watching": ["bridge-v2-coordination-channel.md"],
  "last_block": "claude 012hq2t9 message 12"
}
```

- `state`: one of `working`, `idle`, `waiting-user`, `blocked`, `closing`. Unknown values are shown, never rejected.
- `closing` is written on a clean exit, then the file is removed. A crashed session leaves its file behind, which is the signal.

## 3. Reader rules

- A session is **live** if `now - updated_at <= 3 * refresh_s` and, on the same host, `kill -0 <pid>` succeeds.
- Otherwise it is **stale**: report "last seen N minutes ago", state as last written. Readers never delete another session's file and never infer that its work failed.
- `state` older than 10 minutes while liveness is fresh is shown as `unknown (agent not updating)`.
- Clock: same host only, so no skew handling. Cross-host is out of scope.
- PID reuse: if the pid exists but its start time is after `started_at`, treat the file as stale.
- Display: a one-line-per-session table (`jq -r` over the directory); a `who` helper script is a follow-up, not part of this contract.

## 4. Writers

- Liveness writer: the per-session watcher loop touches `updated_at` every `refresh_s` while the session is open. When the watcher exits to wake the model (event arrived), the model re-arms it, and the refresh gap during that moment must stay under `3 * refresh_s`.
- Activity writer: agent writes `state` and `task` at the start and end of a turn. Claude Code can use its `UserPromptSubmit` and `Stop` hooks; whether Antigravity has an equivalent hook is a question for Antigravity (open question 1).
- A missing activity writer degrades the feature to liveness only, which is still the main value.

## 5. Composition with other pieces

- `BuildSlot` holder sidecar: its `label` may carry the heartbeat file stem, so a waiter can look up whether the holder session is still live. Not required by either spec.
- Task ledger (beads or a registry, still undecided): a claim can store the session id; a stale heartbeat tells others a claim may be abandoned. The ledger still decides what to do.
- Channel files remain the message transport; this contract adds nothing to them except the `last_block` hint.

## 6. Kill switch and failure modes

- Nothing depends on it: delete `~/.agents/heartbeat/` and the channel keeps working.
- A watcher bug that stops refreshing makes a healthy session look stale; the cost is a false "offline" display, not data loss.
- Directory permissions: user-only (mode 0700); the files hold no secrets.

## 7. Review outcome and open questions

- Antigravity (channel message 10, 2026-11-03) endorsed the contract in principle, recommends `refresh_s = 30` with stale after 90 s (3 x refresh), and reports native hooks in `~/.gemini/config/hooks/` (`SessionStart`, `PreToolUse`, `PostToolUse`), so it can populate liveness and activity. Adopted: default `refresh_s` is 30. The hook names are Antigravity's report; not verified by me, and there is no hook for "turn ended", so `idle` would be inferred from the last `PostToolUse` plus silence (open question 1).
- Open 1: how does Antigravity detect "turn ended / waiting for the user" to write `idle` or `waiting-user`?
- Open 2: where does the directory live for the Mac or a second machine? The machines sync only through git; this contract is host-local and the directory stays out of git.

## 8. Alignment with A2A and ACP principles (user preference relayed by Antigravity, 2026-11-03)

The user is reported to prefer "ACP with A2A in mind (principles)". This contract stays a file contract now, shaped so it can be carried by either later:

- A2A task states are the vocabulary for activity: `working` ~ TASK_STATE_WORKING, `waiting-user` ~ INPUT_REQUIRED, `blocked` ~ AUTH_REQUIRED or a free-text reason, a finished item ~ COMPLETED, CANCELED, FAILED or REJECTED. The state names in section 2 map one to one; a ledger entry should use the A2A names.
- The heartbeat is a minimal "agent card": identity (`harness`, `name`, `session_id`), what it watches, what it is doing. Capability advertisement (skills, accepted message kinds) can be added as optional fields without a schema break.
- Symmetry: nothing in the file names a caller or a subordinate. Any session can read any other's file.
- ACP is not used as the transport yet; see channel message 14 for why.
