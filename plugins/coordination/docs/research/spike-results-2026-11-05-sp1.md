# SP1 results: Claude Code `asyncRewake` long-poll (2026-11-05)

- Date: 2026-11-05 (runs from about 13:55 EET)
- Branch: `main` (the repo state at the time; no commits made by the helper)
- Claude Code: 2.1.318 (verified, `claude --version`), model `haiku` for all test sessions
- Runbook: `https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-runbooks-2026-11-05.md` section 1
- Spec: `https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/spikes.md` section 4
- Labels: **verified** (observed in this run), **reported** (claimed, not reproduced), **unverified**

## Summary

Runbook 1.8 pass and fail summary. Pre-test Gate 0: PASS after patch 2 (owner pid is `$CLAUDE_PID`).

Gate items:

- T1: **PASS**. Release to turn start 0.4 s, to first assistant output 7.5 s (under 10 s), wake text visible to the model.
- T2: **PASS**. Exit 2 only in the documented cases.
- T3: **PASS**. One parked listener, superseded listeners exit (409), re-arm at `Stop` works after a woken turn and after the overnight park.
- T4: **PASS**. At the hook timeout the listener gets SIGTERM, silent, no re-arm until the next `Stop` (T4a, 20 s). The long timeout 604800 was accepted at start (T4b).
- T7: **PASS**. The listener exits about 1 s after `kill -9` of claude.
- T9: **PASS**. Guards hold.
- T11: **PASS**. Body and `hookSpecificOutput.additionalContext` shape recorded, the prompt proceeds on every failure mode (non-JSON, 500, timeout, unset key).

Record-only items:

- T4 overnight: **PASS**, 10 h 39 m idle, 43 rounds of 900 s with no gap, exit 2 woke the session 0.3 s after release.
- T5: `Stop` does not fire after Esc, so no listener is armed and the gap is unbounded. Suggests re-arm from `UserPromptSubmit`.
- T6: no cap on consecutive `Stop` continuations in 11 consecutive turns (variants capA and capB). Loop control must be server side (the per-session wake budget).
- T8: wakes during a permission prompt or a running tool are queued by the harness and delivered after (new turn after a prompt, merged into the same turn after a tool in bypass mode).
- T10: environment names and values recorded.

Go or no-go for decision 8: **GO**. SP1 T1 passes, so S1 is not stopped and neither SP6 nor the agy-style asymmetry is needed for the wake path.

Design points the spike raises for the plan:

- `/clear` creates a new `session_id` and orphans the old id's listener. The new session needs its own `SessionStart` arm (source `clear` is not in the listener guard) and the server must expire the orphan.
- `Stop` does not fire after Esc. A re-arm from `UserPromptSubmit` is needed to close the gap.
- Wake and loop control (no cap) must be enforced server side.
- `UserPromptSubmit` hooks also run for woken turns, and the user-level JEV hook adds context to them.
- `asyncRewake` first version is **reported** only (changelog 2.1.287); 2.1.290 in decision 8 is not confirmed. The feature is present in 2.1.318 (**verified**).
- Unverified: how the `/hooks` detail view shows `604800`, and whether a `systemMessage` in the HTTP hook reaches the model.

## Setup notes

- Stub on `127.0.0.1:18120`, wake budget 12 per hour per session, `/wake/pending` patch live (verified).
- `a2a-listen` patches (backup `sp1/a2a-listen.orig`):
  - patch 1: `A2A_WAKE_TEXT` overrides the wake text
  - patch 2: owner default is `$CLAUDE_PID`, else `$PPID`
- Offline `test-listen.sh` passes after both patches when run with `CLAUDE_CODE_SESSION_ATTENDED=1` (verified). The attended guard exits silently otherwise, so a non-attended helper cannot run it.
- `asyncRewake` first version: **reported** only. The changelog names it first as a fix in 2.1.287. The "2.1.290" figure in decision 8 is not confirmed. The string is present in the installed 2.1.318 binary (`rg -a -c asyncRewake` gives 17, **verified**).

## Gate 0: owner pid and parked listener

First run (session `36d5da16`, before patch 2):

- **verified**: hooks see `A2A_API_KEY` from the launch command (the listener parked).
- **verified**: the listener's `$PPID` is not claude. Chain: listener `127952` -> `127950:sh` (the hook's `sh -c` wrapper, alive as long as the listener) -> `127447:claude` -> zsh -> tmux. An owner watch on `$PPID` would never see claude die.
- **verified**: `CLAUDE_PID=127447` equalled the claude pid in the hook env. Hence patch 2.
- Side finding, **verified**: when that claude exited, its listener got `signal TERM received` (11:55:39Z) and the stub logged `close ... by client` at 11:55:40Z. So claude's exit reaches the listener as SIGTERM via the wrapper, even with the wrong owner pid. This is not a substitute for T7 (kill -9).

Second run (session `47086062-5da6-4c7d-ab39-89467dd73aa5`, claude pid 153753, started 11:56Z, after patch 2):

- Capture: `start event=[SessionStart] ... source=[startup] owner=[153753]`
- Capture: `claude_pids` for the scratch dir gives `153753`; listener chain `154010 -> 154008:sh -> 153753:claude -> zsh -> tmux`
- Capture: one listener parked in the stub, rounds of 60 s with `http=408` and a new `park` per round
- Result: **PASS** for patch 2. Owner equals the claude pid.

## T10: environment inventory

- `SessionStart` hook stdin keys (**verified**): `cwd,hook_event_name,model,scratchpad_dir,session_id,source,transcript_path`
- `CLAUDE_*` env names in the hook and in the listener (**verified**, identical): `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`
- Values (**verified**): `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_SESSION_ATTENDED=1`, `CLAUDE_PID=153753` (equals the claude pid), `CLAUDE_CODE_MESSAGING_SOCKET=/run/user/1000/cc-socks/153753.sock`
- `CLAUDE_CODE_MESSAGING_TOKEN` is present (name only; value never printed or logged).
- Claude ran inside tmux; the user's terminal is a tmux pane (matters for T7 `reset`).
- Pass: record only.

## T1: arm and idle wake (session 1, `base`, session `47086062`)

Capture (**verified**):

- T_rel (helper wrote the release file): 11:58:50.702Z
- Stub `/wake/listen` response 200 (`release_file`): 11:58:50.755Z
- Listener: `http=200 ... WAKE: 200 count=1, exit 2` at 11:58:51Z
- Transcript: the wake entry (type `user`) at 11:58:51.095Z, 0.4 s after the release. The first assistant entry (thinking) at 11:58:58.185Z. Latency release to model turn start: 0.4 s; release to first assistant entry: 7.5 s (target under 10 s).
- Wake text as the transcript stores it, in one `user` entry (no `attachment` wrapper):

  ```
  <task-notification>
  <summary>Stop hook feedback</summary>
  </task-notification>
  <system-reminder>
  Stop hook blocking error from command "SessionStart:startup": [a2a] 1 pending. Call a2a_inbox.
  </system-reminder>
  ```

  - Framing: the exit-2 stderr of an `asyncRewake` hook arrives as a user-role `task-notification` plus a `system-reminder` that calls it a "Stop hook blocking error from command", labelled with the hook that spawned the listener (`SessionStart:startup`), even though the listener was armed by SessionStart.
- The `UserPromptSubmit` hooks ran for the woken turn as well (verified): the user-level hook context was attached at 11:58:52.2Z, and the spike `sp1-pending` hook logged `pending-hook ... n=0 ms=10` at 11:58:51.140Z. So a woken turn is treated like a prompt for `UserPromptSubmit`.
- The model replied that `a2a_inbox` is not available in this session (expected, no MCP entry in SP1) and asked what to do. The text was visible to it and it acted on it.
- Model's own verbatim quote on request: pending (asked of the user, see the T1 follow-up below).

Pass: **PASS** (a turn started with no user input, 0.4 s to turn start and 7.5 s to first assistant output, stub text visible to the model).

## T3: re-arm at Stop, first half (after the woken turn)

Capture (**verified**):

- `start event=[Stop] ... owner=[153753]` at 11:58:59Z, `round=1 parked` at the same second. Stub `park` at 11:58:59.134Z with `again=1` (the counter reset).
- Exactly one listener parked after the turn (`parked` shows one session id); `pgrep -af a2a-listen` shows one `sh -c` wrapper and one `sh a2a-listen` (the curl was between rounds at that moment).
- The SessionStart listener had already exited with the wake (exit 2), so no `409` appeared in this half. The supersede case is the user-turn half below.
- `wakes_last_hour` for the session: 1.

### T1 follow-up: the model's verbatim quote

- Asked: `Quote verbatim, in a code block, the hook or system-reminder text that started your previous turn, and say how it was framed.`
- Model answer (**verified**): it called the text hook output labelled `UserPromptSubmit hook additional context`, said it could not confirm which block began its previous turn, and quoted the user-level JEV recommendation instead of the `[a2a]` line.
- Reading: the quote request was itself preceded by the user-level JEV `UserPromptSubmit` context, and haiku mixed the two. The transcript (above) proves the wake text reached the model, and the woken turn's own reply acted on it. Whether a clean session would quote it exactly is **unverified**. The test setup is polluted by the user-level JEV hook, which also fires on woken turns.

## T3: re-arm at Stop, user-turn half

Capture (**verified**), prompt `Reply with the word ok.` at about 12:03:4xZ:

- `start event=[Stop]` at 12:03:47Z, `round=1 parked`. Stub `park` with `again=1`, `superseded_older=true` at 12:03:47.054Z.
- Old listener (armed by the previous Stop): `round=2 http=409 ... 409 superseded, exit 0 silently` at 12:03:48Z. Stub `response 409 reason=superseded` at 12:03:47.076Z.
- After the turn: one listener in the stub, one `sh -c` plus one `a2a-listen` plus one curl in `pgrep`.

Pass: **PASS** (exactly one parked listener after each turn, the superseded listener exits).

## T2: status table (session 1)

Capture (**verified**), from `listen.log` and the stub log:

- 408 by release file at 12:04:07Z: `round=1 http=408`, `round=2 parked`. No turn, nothing visible, no exit 2. Natural 60 s round ends also showed `http=408` with a new `park` every round (11:57, 11:58, 12:03).
- 409 (seen in T3): `409 superseded, exit 0 silently`, no turn.
- 401 first time (12:04:32Z): `401, marker written, exit 2 once`. The model got `Stop hook blocking error from command "Stop": [a2a] wake listener stopped: server answered 401. Check the coordination server and API key.` and a turn ran. `Stop` then re-armed a listener by itself at 12:04:35Z (no user input needed). File `notice-<sid>` existed.
- 401 second time (12:04:45Z): `401 again, marker present, exit 0 silently`, no turn, no listener parked afterwards (stub `listeners` empty). The user typed `Reply with the word ok.`, `Stop` re-armed.
- Marker clear: `rel ... 408` at 12:06:03Z, then `ls notice-*` gave no match, so a 408 clears it.
- 429 (12:04:13Z): `http=429 backoff 1s (retry-after=[1])`, re-parked 1 s later. 503 (12:04:19Z): `http=503 backoff 2s (retry-after=[1])`, re-parked. No `WAKE` line. Note: the stub sent `Retry-After: 1` both times, and the 503 backoff was 2 s, so the listener's own doubling applied and the header was not used as the delay (backoff sequence is exponential on consecutive failures).
- Refused (stub stopped 12:06:1xZ, restarted after 25 s):
  - the parked curl got `curl_rc=52` (empty reply, the stub died mid-poll) with `http=000`
  - then refusals at once: `curl_rc=7 Failed to connect ... after 0 ms` (a quick refusal, not the 28 timeout seen inside the earlier tool sandbox)
  - backoff 1, 2, 4, 8, 16 s (exponential), no wake
  - after `stub_start` the listener re-parked at 12:06:47Z (`round=7 parked`), the stub shows the session parked again with `again=7`
  - the stub restart cleared its in-memory `wakes_last_hour` (the budget counters), so the per-hour budget resets on a stub restart
- `rg -c 'exit 2' listen.log` is 2: the one real wake (T1) plus the one marker-guarded notice.

Pass: **PASS** (exit 2 only for the 200 and the single marker-guarded notice).

## T9: guards (session 1 plus by hand)

By hand (**verified**, no `claude -p`; the helper's own session env was used for the attended runs):

- `source=startup`, `CLAUDE_CODE_SESSION_ATTENDED=0`: exit 0 at once, no output. Log line `guard: CLAUDE_CODE_SESSION_ATTENDED=0 (non-interactive), exit 0`.
- `session_id="bad id!"`, attended=0: exit 0, no output (the attended guard fires first).
- `source=clear`, attended=0: exit 0, no output (same).
- `session_id="bad id!"`, attended=1: exit 0, no output. Log line `guard: session_id missing or fails ^[A-Za-z0-9_-]+$, exit 0`.
- `source=clear`, attended=1: exit 0, no output. Log line `guard: SessionStart source [clear] not startup/resume, exit 0`.
- No request reached the stub for session id `t9` in any run (no network call). Scratch dir `live-t9` removed.

Real events in session 1 (**verified**): `/clear` at 12:11:10Z, then three short turns, then `/compact` at 12:11:44Z.

- `/clear`: `SessionStart` fired with `source=clear` and the widened matcher delivered it to the listener, which logged `guard: SessionStart source [clear] not startup/resume, exit 0`.
- **`/clear` gives a NEW `session_id`**: `47086062-...` became `45bf6446-f722-4f81-b3c4-957d5dde4e0b` (the sync hook's stdin shows `source=clear` with the new id; a new transcript file was created).
- First `Stop` after `/clear` armed a listener for the new id at 12:11:22Z. The second and third turns each started a new `Stop` listener and the older one got `409 superseded, exit 0 silently` (12:11:26Z and 12:11:27Z). So the clear itself armed nothing until the first `Stop`, a gap from 12:11:10Z to 12:11:22Z (12 s, one turn).
- `/compact`: `SessionStart` with `source=compact`, session id unchanged (`45bf6446`). The listener logged `guard: SessionStart source [compact] not startup/resume, exit 0`. The listener armed at the last `Stop` stayed parked, so compaction needs no re-arm.
- **Finding, orphaned listener after `/clear`**: the listener armed for the OLD id (`47086062`, `a2a-listen` pid 228025) kept polling (stub `again=12`) after `/clear`, because supersede is keyed by session id and the new id differs. After `/clear` there were two parked listeners for one claude process (one per id) until the owner dies. Effect: a wake queued under the old id would still wake this claude, and the new id would be a second handle. The shipped design must either re-key on `source=clear` (SessionStart `clear` should end the old listener and arm for the new id) or unregister the old id. This was found with the widened matcher; the shipped `startup|resume` matcher would not see `clear` at all.

Pass: **PASS for the guards** (all guards exit 0 at once with no output and no network call), with the `/clear` orphan recorded as a design issue.

## T7: orphan and pid watch (end of session 1)

Setup: claude pid `153753` (cwd confirmed as the scratch dir before the kill), session id `45bf6446-...`, two listeners parked (the current one and the `/clear` orphan for `47086062`). The user ran `kill -9 153753` from a third terminal, then `reset` in the dead tmux pane.

Capture (**verified**):

- Orphan listener `228025`: `owner 153753 gone while parked, killing curl_pid=258905, exit 0` at 12:13:13Z. Stub `close ... by client` for `47086062` at 12:13:13.877Z.
- Current listener `248091`: `owner 153753 gone while parked, killing curl_pid=256649, exit 0` at 12:13:14Z. Stub `close ... by client` for `45bf6446` at 12:13:14.657Z.
- The owner poll is 1 s (`A2A_POLL_S` default), so both listeners ended within about 1 s of the kill. The exact kill instant was typed by the user and is not timestamped; it lies between 12:12:48Z (last round start) and 12:13:13Z. Exit 1 s apart is consistent with a 1 s poll.
- `pgrep -af 'a2a-listen|curl.*wake/listen'` after the kill: no listener, no curl. Stub `listeners` empty.
- Both listeners (including the `/clear` orphan) end on the owner kill, so the orphan from T9 is bounded by the claude lifetime.
- Queue check: `rel 45bf6446-... 200 1` after the kill left `ctl/45bf6446-....release` on disk with no consumer (the file stays until a listener of that session id asks, as expected from the offline test). The real server's "offered until confirmed" rule is not tested here (server-api.md 7.5).

Pass: **PASS** (the listener exits within a few seconds, the stub sees the connection close, no leftover process).

### T7b: `--resume` of the killed session (optional)

Command: `A2A_API_KEY=spike-token claude --model haiku --resume 45bf6446-f722-4f81-b3c4-957d5dde4e0b`, started 12:55:4xZ, no prompt typed. New claude pid `362792`.

Capture (**verified**):

- `--resume` keeps the same `session_id` (`45bf6446-...`).
- `SessionStart` with `source=resume` armed a listener with `owner=[362792]` (the new claude pid, from `$CLAUDE_PID`) at 12:55:47Z. The stub took the park and answered at once from the queued `45bf6446-....release` file (200 `release_file`, 12:55:47.532Z). The listener logged `round=1 http=200 ... WAKE: 200 count=1, exit 2` at 12:55:48Z, about 1 s after start. The release file was consumed.
- The wake turned into a turn with no user input; `Stop` at 12:55:55Z armed the next listener (`again=1`). One listener parked afterwards.
- A message queued while the session was dead (about 42 min) was delivered at resume. At the stub, only the session id matters, not the process.
- New `SessionStart` stdin keys on resume (**verified**, differs from `startup`): `context_tokens, cwd, estimated_cache_write_usd, hook_event_name, prompt_cache_likely_expired, scratchpad_dir, seconds_since_last_response, session_id, source, transcript_path` (the `startup` set had `model` and no cache or token keys).

Pass (record only): **works**.

## T5: Esc gap (variant `esc`)

Setup notes (**verified**):

- **The Bash tool of 2.1.318 blocks a standalone `sleep N`**: `<tool_use_error>Blocked: standalone sleep 40. To wait for a condition, use Monitor with an until-loop ... or run_in_background`. The runbook's `Run the Bash command: sleep 40` (T5, T8) and the `esc` wake text therefore did not run. The allow rule `Bash(sleep 40)` does not override the block. Substitute used: the script `sp1/bin/wait40` (`sleep 40` inside a script, a separate command line the harness does not block), and the `esc` variant wake text and allow rule were changed to it. Use the same substitute for T8 and for any later long-running command.
- The first session with the block gave an unplanned data point: two user turns that ended normally each re-armed a `Stop` listener and superseded the older one with `409 superseded, exit 0 silently` (12:58:23Z, 12:59:00Z, 12:59:18Z). A fourth turn was interrupted with Esc while the model was streaming text (12:59:43Z): no `stop_hook_summary`, no `start event=[Stop]`, the previous listener (armed 12:59:18Z) stayed parked and was still the only one 90 s later.

Part 1, Esc during a user-started turn (session `2f390f20`, `wait40` prompt typed 13:01:54Z):

- The model issued the Bash call at 13:01:57Z. The user pressed Esc at 13:02:10Z (13 s in). The transcript shows `User rejected tool use` and `[Request interrupted by user for tool use]`. Whether a permission prompt was open at that moment could not be told from the transcript (**unverified**). The user's permission mode in the transcript was `auto`.
- No `Stop` event followed the Esc. The `SessionStart` listener (pid 381008) stayed parked, unchanged (**verified**). Typing `ok` at 13:02:50Z produced a normal turn, `start event=[Stop]` at 13:02:52Z, and the old listener got `409 superseded` at 13:02:53Z. Exactly one parked afterwards. **PASS** for part 1.
- Reading: a listener started at `SessionStart` survives an interrupted user turn, so Esc during a turn that the listener did not start loses nothing.

Part 2, Esc during a woken turn (session `b041904f-ab56-4439-b3b5-e88d5d190fd7`, normal mode, `wait40` wake text):

- Release (200) at 13:07:08.849Z. Wake entry in the transcript at 13:07:09.453Z. Tool call at 13:07:13Z. `wait40` and `sleep 40` were seen running at 13:07:14Z (so no permission prompt was holding it, verified by `pgrep`). The woken turn started with no user input.
- The user pressed Esc at 13:07:29Z (16 s after the tool call, about 20 s after the wake): the process list was empty at 13:07:40Z (the command was killed) and the transcript shows the same two interrupt lines.
- **`Stop` did NOT fire after the Esc**: no `start event=[Stop]`, no new `park`, `pgrep -af a2a-listen` empty, stub `listeners` empty from 13:07:09Z (the wake listener exited 2 on the wake) until the next `Stop`.
- A second release (200, body 2) at 13:07:46.938Z had no consumer: `ctl/b041904f-....release` stayed on disk, nothing parked.
- User typed `ok` at about 13:09:0xZ. The turn ended with `start event=[Stop]` at 13:09:02Z. That listener took the queued release 1 s later (`http=200 ... WAKE: 200 count=2, exit 2` at 13:09:03Z, stub `release_file`), a woken turn ran, `Stop` at 13:09:06Z armed the next listener, one parked. The release file was consumed.
- Gap: from the Esc (13:07:29Z), and in fact from the wake listener's exit (13:07:09Z), until the user's next turn ended at 13:09:02Z: 93 s after the Esc, 113 s with no listener. The gap has no upper bound; it lasts until the user types something.
- Model behaviour worth noting (**verified**): after an interrupted wake turn, later wakes asking for the same command were refused by haiku ("You declined that command a moment ago"). The wake loop then ended in a 3 s turn; the model treats a repeated wake text like a repeated request.

Capture summary:

- `Stop` after an Esc: does not fire (verified on four Esc events: one on a text stream, one on a running tool under bypass, one on a running tool in a woken turn, one that may have hit a permission prompt).
- Gap: unbounded, ended only by the next user turn (113 s here).
- Second release during the gap: stays on disk, no consumer, delivered right after the next `Stop`.

Pass: record only. The gap is real, so the spec needs a "not listening" flag or a `UserPromptSubmit` re-arm check (the `UserPromptSubmit` hook does fire on every user prompt, so it could re-arm the listener).

## T8: permission prompt and mode

Part 1, default mode with an open permission prompt (session `e6941ac0-4dc9-4d45-9c56-fdcf2bafddc3`, variant `base`, launched with `--permission-mode default` because the user's default is `auto`):

- Prompt (**verified**, pasted by the user): `Bash command`, `touch .../t8.tmp && ls -l .../t8.tmp`, options `1. Yes`, `2. Yes, and always allow access to <sp1 dir> from this project`, `3. Yes, and switch to auto mode`, `4. No`. A tip line reads "auto mode handles these prompts for you".
- Order of events (**verified**, transcript and listener log):
  - 13:13:51.5Z user prompt; 13:13:54.1Z `tool_use` Bash (prompt opens)
  - 13:14:11.7Z helper release (200)
  - 13:14:12Z listener `http=200 ... WAKE: 200 count=1, exit 2`; 13:14:12.303Z transcript `queue-operation enqueue`; no turn starts, the prompt stays open
  - about 13:15:16.9Z user chose No: `tool_result` "The user doesn't want to proceed with this tool use", `[Request interrupted by user for tool use]`
  - 13:15:16.950Z `queue-operation dequeue`; 13:15:16.967Z the wake entry arrives as a `user` message (`task-notification` "Stop hook feedback" plus `system-reminder` "Stop hook blocking error from command "SessionStart:startup": [a2a] 1 pending. Call a2a_inbox.")
  - 13:15:19.9Z the model replies (about the rejected touch); 13:15:20Z `Stop`, a new listener armed, one parked
- So: while a permission prompt is open, a wake is **accepted and held** in the harness queue (about 62 s here), not lost and not refused. It is delivered 0.04 s after the prompt resolves, and starts the next turn. The listener has already exited by then, so the Stop re-arm is what restores the listener.
- Model's answer to `What did you just receive besides my request? Quote it.` (verified, pasted): it listed the wake as "a background-task notice, labeled as not user input" and quoted `Stop hook blocking error from command "SessionStart:startup": [a2a] 1 pending. Call a2a_inbox.` verbatim, then also the user-level JEV hook context and the MCP failure list. So a clean quote of the wake text works when asked after a turn, and the T1 miss was a prompt-mixing issue. It also said it had no tool called `a2a_inbox` (expected). It treated the wake as informational, not as an instruction to act on.
- `t8.tmp` was not created (rejected).

Part 2, bypass mode (session `58d7ea7c-be0b-48bf-aa5e-a3528983de53`, variant `base`; `ps` showed `--permission-mode bypassPermissions --dangerously-skip-permissions --allow-dangerously-skip-permissions`, the extra flags probably come from a shell alias):

- 13:19:44.6Z user prompt `Run the Bash command: .../wait40`; 13:19:47.0Z `tool_use`; the script was running at 13:19:5x (`pgrep`, no permission prompt).
- 13:19:51.342Z helper release (200); 13:19:51Z listener `WAKE: 200 count=1, exit 2`; 13:19:51.914Z transcript `queue-operation enqueue`. The wake was **accepted and held** while the tool ran.
- 13:20:27.8Z the tool finished (`Bash completed with no output`); 13:20:28.759Z `queue-operation remove` (note: `remove`, not `dequeue` as in part 1), and the model continued **in the same turn**: its single reply says "The command ran and exited with no output. A session-start hook also reported one pending a2a message and asked for `a2a_inbox`...". No separate woken turn started.
- 13:20:31Z `Stop`; `start event=[Stop]` armed a listener, one parked.
- Delivery delay: about 37 s after the release (the remainder of the running tool), at the next tool boundary.
- Not accepted-and-refused, not delayed beyond the tool: so in bypass mode a wake during a running tool is delivered at the end of that tool call and merged into the running turn.
- SP6 X3 preview: the wake is consumed once, no duplicate turn, and the listener is re-armed by the turn's `Stop`.
- `t8.tmp` was never created, so nothing to remove (`ls` confirmed).

Pass: record only.

## Unplanned: session started without `A2A_API_KEY` (T4a session, first attempt)

- **verified**: session `924214d1-...` was launched as plain `claude --model haiku` (the environment of claude pid 434961 had no `A2A_API_KEY`, checked by name only). The `SessionStart` listener logged `no API key available, exit 0` at 13:22:01Z, nothing parked, nothing was shown to the user, and no stub request was made. This is the expected silent fail of decision 34 for a missing key, and it matches the C9 "unset" case. The session was discarded and restarted with the key for T4a.

## T4a: hook timeout, 20 s (variant `short`, session `1bd1afee-f129-47a5-95ca-cf90a9bb060b`)

Capture (**verified**, `listen.log` and stub log):

- 13:25:53Z `SessionStart` listener armed (`owner=[439043]` = claude pid). A turn ended at 13:26:07Z (the user's prompt made haiku start a background `sleep 40`), so a `Stop` listener armed at 13:26:07Z and superseded the first one (`409 superseded, exit 0 silently`, 14 s after its start, before the 20 s timeout could expire).
- 13:26:27Z the `Stop` listener logged `signal TERM received`, exactly 20 s after its start at 13:26:07Z. Stub `close ... by client` at 13:26:27.715Z. So expiry is **SIGTERM** (not SIGKILL), delivered to the listener, which exits.
- Nothing was shown on screen at that moment: the user's pasted conversation shows only the model's turn and a later background-task notice, no hook error, no timeout text.
- No new `park` from 13:26:27Z until 13:26:48Z. At 13:26:48Z a `Stop` fired (the model's turn ended after the completed-background-task notification, not a user prompt) and armed a new listener. So the gap after expiry lasts until the next `Stop` or `SessionStart`, which can be a background-task completion rather than a user turn. 21 s gap here.
- Side finding: a background-task completion notification starts a model turn on its own, and that turn ends in `Stop`, so it re-arms a listener like any other turn.
- `/hooks` (**verified**, pasted by the user; the menu is read-only): the list view shows each hook as `[Local]` (project `settings.local.json`) or `[Plugin]` with a truncated command and, for `SessionStart`, the matcher `startup|resume|clear|compact`. The list does not show the timeout or `asyncRewake`. `UserPromptSubmit` showed the `sp1-pending` hook as `command`, `SessionStart` two `[Local]` entries (the sync logger, the listener) plus the jev plugin, `Stop` one `[Local]` listener entry. The detail view ("Enter to view") was not opened, so how it prints the timeout is **unverified**.
- Open: the `604800` long timeout (T4b).

Pass: **PASS** (SIGTERM, silent, no re-arm until the next `Stop`), long timeout still to check.

## T6 variant A: Stop continuation cap (`capA`, session `f79e5406-a239-41e5-b1bd-3703aca2b519`)

Wake text: `[a2a] 1 pending. Reply with one short sentence. Do not use any tool.` The helper `chainwake` kept a 200 release queued (12 queued, one more queued as soon as the previous one was consumed).

Capture (**verified**):

- 11 consecutive wake turns (11 stub 200 responses, 11 listener `WAKE: 200 count=N, exit 2` lines, 11 `Stop hook feedback` user entries in the transcript) between 13:30:45.4Z and 13:31:13.4Z: 29 s, about 2.8 s per turn, each ended in `Stop`, re-armed a listener, and the next release was consumed at once.
- The 12th queued release was removed by `chainwake` at its end, unconsumed (the helper stopped at its limit, not the session). The stub's wake budget (12 per hour) was not hit (no `budget_exhausted`).
- **No cap observed in 11 consecutive turns.** The session kept continuing for as long as wakes were queued; no stop by the harness.
- No tool calls (0 `tool_use`). The model's later replies showed it noticing the loop ("this is the same notice again, so I'll stop repeating it until you tell me to check it", "it's likely stuck on the hook side") yet it still took a turn on every wake.
- The runaway stop condition was not triggered: every turn followed a helper release.
- After the chain a listener was parked (`again=1`), one only.

Pass: record only. Result: no cap in 11, so the plan's "cap 8" figure is not supported at this length; the stub budget is the only brake. The server-side cap (server-api budget) has to carry the loop control.

## T6 variant B: Stop continuation cap with a tool (`capB`, session `ec7ec542-d022-4015-a28b-2fa1ce0961da`)

Wake text: `[a2a] 1 pending. Run the Bash command: date -u. Then reply with one short sentence.` (`Bash(date -u)` allow-listed). Same `chainwake` helper as variant A.

Capture (**verified**):

- 11 consecutive wake turns (11 stub 200 responses) from 13:37:03.2Z to 13:37:54.2Z: 51 s, about 4.6 s per turn. No `budget_exhausted`, one listener parked at the end. The 12th queued release was removed by the helper unconsumed. **No cap observed in 11.**
- The model used the tool in the first turns: 6 `Bash` calls of `date -u` (allow-listed, no prompt), plus one read-only `rg` for `a2a` in the settings files (looking for the source of the repeated hook message). In the later turns it declined to repeat: "I'm not running `date -u` again; the Stop hook is looping and needs a config change to stop", offering to disable the two `a2a-listen` Stop hooks in the project settings. It did not change any file.
- Result: the harness did not cap the continuation; only the model's own refusal and the helper's limit ended the chain. The wake kept starting turns (each one cheap, answered in a sentence) even after the model refused to act.

Pass: record only. Combined with variant A: no harness cap found for 11 turns in a row, with or without a tool. The loop brake has to be server side, and the wake text has to stay a constant stub: repeated identical wakes make a small model go meta about the hook, so a real task must not depend on the model obeying the wake text.

## T11: HTTP hook shape (variant `http`, session `79654528-6cd7-4f0e-8b25-75cfec03acd4`)

Hook config (from the variant): `{"type":"http","url":"http://127.0.0.1:18120/wake/pending","timeout":5,"headers":{"Authorization":"Bearer $A2A_API_KEY"},"allowedEnvVars":["A2A_API_KEY"]}` on `UserPromptSubmit`. The stub mode was switched by a helper script after each response (`sp1/bin/t11-modes.sh`), one prompt `Reply with the word ok.` per mode. The wall clock of this run is later (19:07 to 19:10Z) than the earlier sessions (the user paused for a few hours).

Request the harness sent (**verified**, stub log):

- `POST /wake/pending`, `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Accept: application/json, text/plain, */*`.
- Authorization: present, equals `Bearer spike-token` (the stub's `auth_equals_token: true`, `auth_len: 18`, `auth_is_literal_placeholder: false`). So `$A2A_API_KEY` in the header value was expanded from the launch environment because the variable is in `allowedEnvVars`. The stub redacts the header from its logged header list.
- Body keys: `cwd, hook_event_name, permission_mode, prompt, prompt_id, scratchpad_dir, session_id, transcript_path`. `session_id` is present; so is the raw `prompt` text (the server must not log it) and `permission_mode` (`auto`).
- No session-name or model keys.

Response shapes (**verified**, transcript attachments):

| mode | stub response | what the harness did |
| --- | --- | --- |
| `hso` | 200 `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[a2a] 2 pending. Call a2a_inbox."}}` | `hook_additional_context` attachment with the text: **reached the model** |
| `flat` | 200 `{"additionalContext":"..."}` | nothing: no attachment, no error, the text appears nowhere in the transcript. **Not accepted**, silently ignored |
| `sysmsg` | 200 `{"systemMessage":"..."}` | `hook_system_message` attachment with the text. A UI-level message; whether the model sees it is **unverified** (the model was not asked) |
| `plain` | 200 `text/plain` text | `hook_non_blocking_error`: `HTTP hook must return JSON, but got non-JSON response body: [a2a] 2 pending (plain text).` Prompt proceeds, text not injected |
| `empty` | 200 `{}` | nothing, no error |
| `bad` | 200 `not json{` | `hook_non_blocking_error`: `HTTP hook must return JSON, but got non-JSON response body: not json{` |
| `e500` | 500 `{"error":...}` | `hook_non_blocking_error`: `HTTP 500 from the hook's server` (exitCode 500) |
| `slow` | 200 after 8 s | at 5.0 s `hook_cancelled` with `timedOut: true, timeoutMs: 5000`; the prompt proceeded and the model answered 5.8 s after the prompt |

- Fail open on every failure mode (**verified**): all seven prompts after `hso` were answered `ok` (7 replies), including `plain`, `bad`, `e500` and `slow`. The only user-visible effect is a non-blocking error line in the transcript.
- The accepted `additionalContext` shape is the `hookSpecificOutput` form (`hso`) only. The `flat` shape is ignored.
- Elapsed time for `slow`: the harness waited exactly the configured timeout (5 s) then cancelled; the stub still finished its 8 s sleep.

Unset-key run (`env -u A2A_API_KEY claude --model haiku`, session `603205a9-d5fd-41d2-9cd5-caf18f308b47`, **verified**):

- The environment of the claude process had no `A2A_API_KEY` (checked by name only).
- The HTTP hook still ran: one `POST /wake/pending` at 19:15:57.7Z with an `Authorization` header present but only 6 characters long (`auth_len: 6`, `auth_equals_token: false`, not the literal placeholder), i.e. `Bearer ` with the variable expanded to an empty string. The hook did not fail, was not skipped, and the stub (in `hso` mode) answered 200; the model received the `[a2a] 2 pending` context and answered `ok`. So an unset `allowedEnvVars` variable does not break the hook; the server must reject the empty bearer itself (the real server answers 401, which would surface as a non-blocking error, not a block).
- Both command listeners (`SessionStart` at 19:15:49Z and `Stop` at 19:16:00Z) logged `no API key available, exit 0` and exited silently.

Pass: **PASS** (body and accepted shape recorded, prompt proceeds on every failure mode, including the unset key).

## T4b: overnight leg (variant `long`, session `eb0b27ad-3533-4eef-9b12-685146ccd767`)

Start (**verified**):

- Session started 19:23:18Z (21:23 EET), claude pid `626033`, `A2A_API_KEY` present, no prompt sent.
- Hook timeout `604800` s was accepted: the claude session started with no settings error shown to the user (the user said nothing about one) and the `SessionStart` listener started and parked with `round=900s`. Stub `park` at 19:23:18Z, `wait: 900`. The `/hooks` list view does not show timeouts (see T4a), so how `604800` is displayed is **unverified**.
- Machine must stay awake; the stub and the session need no helper. Morning checks per runbook 1.6: round gaps in the stub log (about 4 rounds an hour, no gap over 15 min), `parked`, then a release.

Morning check (**verified**, 2026-11-06 06:02Z, 08:02 EET):

- Idle period: 19:23:18Z to 06:02:50Z, 10 h 39 m. No prompt was sent and nothing was typed in the session.
- Stub log: one `/wake/listen` response every 900 s from 19:23:19Z to 05:53:29Z (43 rounds in this leg, `again` 43 at the check; 81 `http=408` lines in the whole `listen.log`). No gap over 15 min 1 s, so the machine did not sleep and the idle period is valid.
- One listener only (pid `626067`, owner `626033`), parked in the stub with `age_s` 555 at the check.
- Release: `rel <sid> 200 1` at 06:02:50.321Z. Stub response `status=200 reason=release_file ms=561119`. The listener logged `round=43 http=200`, fetched `/pending`, and `WAKE: 200 count=1, exit 2` at 06:02:50Z.
- Transcript (`eb0b27ad...jsonl`):
  - `queue-operation enqueue` 06:02:50.626Z, `dequeue` 06:02:50.635Z
  - user-role message 06:02:50.651Z: `<task-notification> <summary>Stop hook feedback</summary>` plus `system-reminder` `Stop hook blocking error from command "SessionStart:startup": [a2a] 1 pending. Call a2a_inbox.`
  - first assistant output 06:02:54.3Z (thinking), final text 06:02:58.5Z
- Time from release to turn start: 0.3 s. To first assistant output: 4 s. The idle session was woken after more than 10 h.
- The model could not act on the text (no `a2a_inbox` tool exists in this scratch session, as expected). It said so and asked for the message. This is a property of the spike setup, not a wake failure.
- After the woken turn ended, `Stop` armed a new listener (pid `1284635`, `source=[]`, `stop_hook_active:true`, owner `626033`) at 06:02:58Z. The wake budget counter for the session is 1. Re-arm after a woken turn works after an overnight park too.
- The label in the wake text says `SessionStart:startup`, because the hook that woke it was the `SessionStart` listener.

Result: **PASS**. A 604800 s hook timeout is accepted, the 900 s round long poll survives 10 h 39 m idle, and exit 2 wakes the idle session. No shorter retry is needed.

## Open items settled

- Owner pid source: `$CLAUDE_PID` is in the hook env and equals the claude pid (Gate 0, **verified**). Default in the listener is `$CLAUDE_PID`, else `$PPID`. `$PPID` alone is wrong (it is the hook's `sh -c` wrapper).
- Wake header spelling: the listener sends `X-Session`, `X-Wait` and `X-Again` on `/wake/listen`. All 188 `/wake/listen` requests in the stub log carry exactly `Accept, Host, User-Agent, X-Again, X-Session, X-Wait`. `X-Coord-Session` never appears. **verified** for what the stub as patched accepts. Which name the real server will use is a spec decision, not settled by this spike.
- `/clear` gives a new `session_id` (**verified**, T9). The old id's listener is orphaned.
- Exit 2 wakes an idle session (T1, T4b). `Stop` does not fire after Esc (T5).
- Real hook timeout signal: SIGTERM, silent (T4a).
- T11 HTTP hook shape: only `hookSpecificOutput.additionalContext` is accepted, fail open everywhere (T11).
