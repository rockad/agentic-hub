# AW0 Spike Results — Antigravity Idle-Wake (`2026-11-28`)

- **Runbook:** `plugins/coordination/docs/research/spike-runbook-2026-11-27-agy-idle-wake.md` (Decision Z23)
- **Antigravity version (`agy --version`):** `1.5.18`
- **Coordination server:** `http://127.0.0.1:8120`
- **Session A (recipient):** `antigravity@alyx-wsl/77efe5b3~77efe5b3` (`77efe5b3-dee5-474c-8b26-c37267c8e353`)
- **Session B (senders):** `antigravity@alyx-wsl/f61691fb~f61691fb` (`peer-carbon-2`, C1), `antigravity@alyx-wsl/b8b7e41f~b8b7e41f` (`peer-low`, C2/C5)

## Results

| Check | Result | Notes |
| --- | --- | --- |
| **C1** Idle wake on background completion | **PASS** | `/tmp/a2a-wake-spike.sh` survived a `408` poll at `11:14:21`, received HTTP `200` at `11:15:19` (`< 1s` after `a2a_send`), and woke idle Session A. |
| **C2** Survives 3 ordinary turns | **PASS** | Listener `pid=1942551` (`ppid=3874`) stayed alive across 3 ordinary user turns (`12:10:02`–`12:14:02`). Note: a server restart at `12:16:58` stopped background tasks before the ping arrived; `PreInvocation` surfaced the pending task cleanly. |
| **C3** Parent PID | **PASS** | Identical `ppid=3874` (`agy`, `PPID 3720`, `ELAPSED 2-00:42:02`) across all `start` and `alive` log lines. |
| **C4** Sandbox | **no** | Launching `/tmp/a2a-wake-spike.sh` and curling `127.0.0.1:8120/wake/listen` required no sandbox approval and had zero curl refusals. |
| **C5** Long idle (>= 30 minutes) | **PASS** | `task-1729` stayed alive for **37 minutes** (`12:17:23` → `12:54:29+02:00`) and woke idle Session A on `peer-low`'s scheduled ping (`c64c1bfd-a436-5c11-a624-60621b11b577`). At 30m (`12:47:27+02:00`), Antigravity emitted a built-in `[Notice] The conversation has been idle for 30m with background tasks or subagents still running.` without killing the task. |
| **C6** Inbox after wake | **PASS** | Called `a2a_inbox`, treated `untrusted: true` payload strictly as data, and completed via `a2a_respond`. |
| **C7** 60s `schedule` backstop | **PASS** | `task-1678` fired at `12:09:51+02:00` (~63s after `12:08:47+02:00`) and woke idle Session A. |
| **C8** Survives CLI close & resume | **neither (re-arm needed)** | Closing CLI and resuming `77efe5b3-dee5-474c-8b26-c37267c8e353` emitted `[Notice] All your subagents and background tasks have been stopped due to server restart.` Neither listener nor schedule survived; re-arming after resume is required. |

## Decision

- **C1 and C5 both PASS** -> Design stands as written; **AW0 gate is PASSED** and streams **AW1–AW4** may proceed.
