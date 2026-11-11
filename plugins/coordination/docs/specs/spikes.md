# S0 spike plan: coordination server

Status: DRAFT, planning only. No spike has been run. Nothing in this file has been built or installed.
Date: 2026-11-04. Branch: `feat/coordination`.
Scope: the experiments that must finish before stage S1 (localhost `127.0.0.1:8120` on alyx) is built and enabled.

## 1. Purpose and ground rules

The audit left a short list of behaviours of Claude Code, Antigravity (`agy`) and `a2a-python` that nobody has tested. Several of the 13 binding decisions rest on them. Each spike below turns one of those guesses into a recorded fact, or tells us which fallback to take.

Evidence behind this plan:

- [Audit synthesis](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md), section 7 (open questions)
- [t1b wake mechanisms](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1b-wake-mechanisms.md), section 5 (wake design), section 4 (agy hooks), section 7 (open items)
- [t1c SDKs](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md) (a2a-python store, migrations, cluster mode, gaps)
- [t2 cognitive-engine](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md) (ports, network isolation)

Rules for every spike:

- **Throwaway code only inside the spike.** It lives in a scratch directory outside every git repo, `~/scratch/a2a-spikes/<spike-id>/`. Nothing from it is committed to `main` or to `feat/coordination`. Only the written result is kept.
- **Host changes: "borrow and put back" (decision 25, 2026-11-05).** A spike may change host configuration, under these rules:
  - Back up every file the spike touches before the first edit.
  - Add test entries through the harness's own CLI (`claude mcp add`, `agy mcp add`), not by hand-editing JSON, wherever the CLI does the job.
  - Prefer project-scoped configuration: Claude `.claude/settings.local.json` in a scratch directory, an agy scratch workspace.
  - Write user-level files (`~/.claude/settings.json`, `~/.gemini/config/hooks.json`, `~/.gemini/config/mcp_config.json`) only when unavoidable, and say so in the result.
  - Remove the entries afterwards and verify the file matches the backup byte for byte; for chezmoi-managed files `chezmoi diff` must also be clean.
  - agy-side changes are made only by agy itself or the user. A Claude Code helper never writes agy's files and never starts agy.
  - Spike sessions are fresh sessions, started after the configuration edits (a running session does not pick up changed hooks or MCP entries reliably).
  - The result file lists each touched file, the backup location, and the restore check.
- **Spike port `18120`, loopback only**, so a spike never collides with the future `:8120`, with 8100 to 8110, or with 11434. The stub accepts one fixed throwaway API key (`spike-token`) and never a real credential.
- **Nothing launches, drives or wraps agy** (DDR-003). Every agy spike is run by the user in their own interactive agy session, or by agy itself inside that session at the user's request. No `agy -p`, no PTY, no tmux, no `agentapi`. A Claude Code session may prepare files and read logs for an agy spike; it never starts agy.
- **Claude Code test sessions are started by the user** in a terminal tab, interactive CLI only. No `claude -p`, no PTY driver. A helper session may run the stub and tail its logs.
- **Decision 9 already approves shipping the agy `SessionStart` and `PreInvocation` hooks.** Spikes install them only in a scratch workspace; the user applies them to real config (host-hygiene rule). Only the held-`Stop` park (SP4) needs a further user decision before it could ship.
- **Cheap models, small budgets.** Test sessions run on the cheapest model that exercises the behaviour (`haiku` for Claude Code). Check the 5h and 7d quota first. Every stub that can wake a session has a hard wake budget (default 12 per hour) and a kill file.
- **Spikes execute later, on the user's go.** A spike's scratch environment may need a `uv`-managed virtualenv in its scratch directory (SP5 needs `a2a-sdk`). That is a scratch install, never a system or repo install, and it is created only when the spike runs.
- **Spike ids.** This file defines SP1 to SP6, SP5b (added 2026-11-09), and their test ids (for example T11, A6, D11). Other documents refer to spikes by these ids only. The older names used in server-api.md section 12.1 are mapped in the table in section 2.1.
- **Result format.** Each spike writes one section to a results file, `docs/research/spike-results-<date>.md` (created by whoever runs the spike, not by this plan). Each section holds:
  - the tool versions (see each spike)
  - what was run, exactly
  - observed behaviour per test, with raw log lines
  - pass or fail per criterion
  - the decision consequence, in one line

Labels follow the audit: verified (read in code or official docs), reported (project claim, not reproduced), unverified. A spike moves an item to "verified by spike" with a date.

## 2. Summary

| spike | question in one line | decision it protects | runner | effort | role in the S1 gate |
| --- | --- | --- | --- | --- | --- |
| SP1 | Does the `asyncRewake` long-poll wake an idle Claude Code session, and how does it fail? | 8 | user starts the session; helper runs the stub | about half a day, plus one passive overnight run | must pass |
| SP2 | Can a handle be tied to an MCP session id for both harnesses? | 6 | Claude half: user plus helper; agy half: user or agy itself | about 1 day (Claude), about 2 h (agy) | must pass |
| SP3 | Does a `PreInvocation` hook surface a pending count to agy cheaply and safely? | 9 | user or agy itself | about 1.5 h | must pass |
| SP4 | Can a held `Stop` hook park agy at idle without hurting the user? | 9 (the spike-only part) | user or agy itself | about 2 h | recorded, not required to pass |
| SP5 | Does `DatabaseTaskStore` on SQLite hold up under our single-process mix of traffic? | 4 | helper session | about 1 to 1.5 days | passed 2026-11-05; stays in the record, no longer gating (D-A, D-D) |
| SP5b | Does the versioned store on Postgres hold up under the same mix, with dump and restore and crash recovery? | 4 (starting engine reversed to Postgres, 2026-11-09) | helper session | [design] about 0.5 to 1 day | must pass |
| SP6 | Can a host helper wake Claude Code through the inbox socket? | 8 (later candidate) | user plus helper | about 2 h | optional, outside the gate |

### 2.1 Mapping from server-api.md spike names

| server-api.md name | spike id here | what it settles |
| --- | --- | --- |
| `A2A-SDK-FIT` | SP5 D11 | custom request handler for parked tasks, owner visibility, held tasks, `ListTasks` wrapping |
| `MCP-MOUNT` | SP5 D12 | official `mcp` SDK streamable-HTTP app mounted in the a2a-python Starlette app, stateful, behind our middleware |
| `HOOK-ORDER` | SP2 C7 | two `SessionStart` hooks: parallel or ordered |
| `HOOK-HTTP-SHAPE` | SP1 T11 | request body and response shape of a `type: http` `UserPromptSubmit` hook |
| `MCP-TOOL-TIMEOUT` | SP2 C8 (Claude Code) and A7 (agy) | effective timeout of a blocking MCP tool call, which bounds `a2a_wait` |
| agy `Authorization` header (server-api.md open point 6) | SP2 A6 | whether agy sends the configured bearer header on every `/mcp` request |

## 3. Shared scaffolding (built once, used by SP1 to SP3)

One throwaway stub server in `~/scratch/a2a-spikes/stub/`, single file, standard library only, so no install is needed. It is not the real server and shares no code with it.

Endpoints the stub fakes:

- `POST /wake/listen`
  - reads `X-Session`, `X-Wait`, `X-Again`
  - parks the request until a control file `ctl/<session>.release` appears (its content is the HTTP status to return), or until the round times out and it returns 408
  - keeps one parked listener per session and answers 409 to the older one when a newer arrives
  - logs every request, response, and connection close with a timestamp
  - enforces the wake budget and honours `ctl/KILL`
- `POST /sessions`: stores `{session_id, handle, harness, pid}` and answers 200.
- `GET /pending?handle=`: returns `{"pending": N}` from a control file.
- `POST /mcp`: a minimal streamable-HTTP MCP endpoint in stateful mode. It rejects any request that lacks `Authorization: Bearer spike-token` with 401 (needed by SP2 A6) and logs which requests carried the header. It answers `initialize` with an `Mcp-Session-Id` header, `tools/list`, and `tools/call` for three fake tools: `a2a_hello(handle)`, `a2a_inbox()`, `a2a_wait(seconds)`. It logs every request header and the full JSON body, including `clientInfo` and any `_meta`.

Notes:

- The stub must run MCP in **stateful** mode on purpose. The user's existing Recall container runs with `FASTMCP_STATELESS_HTTP: "true"` (verified in `plugins/memory/docker-compose.yml`), which means no `Mcp-Session-Id` at all. Whether the user's Lookup server is stateful is not in the evidence. So neither harness has been observed against a stateful HTTP MCP server in this setup.
- If a hand-written MCP endpoint turns out too fiddly, the fallback is `uv run --with mcp` in the scratch directory (cache only). Tell the user before doing it.
- The listener script for SP1 is a draft of the real `a2a-listen`: POSIX `sh` plus `curl`, built to the exact table in decision 8. It also logs its own start, pid, parent pid, the stdin JSON it received, and the names (never values) of all `CLAUDE_*` environment variables.

## 4. SP1: Claude Code `asyncRewake` long-poll

### Question

Does a command hook with `asyncRewake: true` on `SessionStart` and `Stop`, long-polling a stub in 900 s rounds (shortened in the spike), wake an idle interactive Claude Code session on exit code 2? What happens at timeout, on Esc, on a second listener, on `kill -9`, and in a chain of wakes?

### Why it matters

- Decision 8 makes this the only idle wake for Claude Code. Every claim about it is reported by third parties (switchboard FINDINGS) or inferred from docs, none reproduced on our machines.
- The wake budget (20 per hour per handle), the re-arm design and the "offered until confirmed" rule are all sized on these behaviours.
- Two items are unknown even to the audit: whether wakes count toward the Stop continuation cap, and the real timeout ceiling.

### Method

Setup:

- Create `~/scratch/a2a-spikes/sp1/` as a scratch project with `.claude/settings.local.json` holding only the spike hooks.
- Hooks:
  - `SessionStart`: a short sync command that logs the stdin JSON, then the `asyncRewake` listener
  - `Stop`: the `asyncRewake` listener
  - `UserPromptSubmit`: a short command for T1 to T10 (to keep those runs simple) that returns `additionalContext` "N pending" from `/pending`. T11 swaps it for a `type: http` hook
- First run uses `timeout: 600` and 60 s rounds. A later run uses `timeout: 604800` and 900 s rounds.
- Record `claude --version` on every machine used. Version check today on alyx: `claude --version` reported 2.1.318 (verified 2026-11-04 by running it). The requirement from decision 8 is 2.1.290 or later (reported); the spike confirms or corrects that number by also reading the changelog entry. The mac and core machines are checked before S2.

Tests, in order. The user starts one interactive `claude --model haiku` in the scratch directory; the helper drives the stub only.

- **T1, arm and idle wake.** Start the session, send no prompt. Confirm the listener is parked at the stub. Write `ctl/<session>.release` with `200`. Expect a turn to start with no user input. Record latency (release to first model output), what the model was shown (ask it to quote verbatim), and how it is framed.
- **T2, status table.** Return each of these from the stub, one at a time. Expect exit 2 only for 200 and the single marker-guarded notice.
  - 408: listener loops, nothing visible
  - 409: listener exits 0, nothing visible, no wake
  - 401: marker file written, one exit-2 notice, second occurrence silent
  - 429 and 503: backoff, no wake
  - connection refused: backoff, no wake
- **T3, re-arm at Stop.** After the woken turn ends, confirm a new listener starts at `Stop`, the old one got 409 and exited, and exactly one listener is parked. Repeat after a normal user-typed turn.
- **T4, hook timeout.** With a short `timeout`, let it expire while idle. Record the signal the script receives, whether anything is shown, and that nothing re-arms until the next `Stop` or `SessionStart`. Then run the 604800 configuration: confirm it is accepted without error, and run one passive overnight test (idle at least 8 h, then release 200). Report the longest idle period that still woke.
- **T5, Esc gap.** Release a wake, press Esc mid-turn. Record whether `Stop` fired, whether a new listener armed, and what a second release does. Then type a prompt, let it finish, and confirm re-arm. Also test Esc during a turn the user started (the original listener must survive).
- **T6, Stop continuation cap.** Chain wakes: the stub answers 200 every time a listener re-arms, up to a budget of 12. Run two variants. Variant A: the model replies with text only (no tool call). Variant B: the stub text tells it to call a tool each time. Record the number of consecutive wake-turns before the session stops continuing, if it does.
- **T7, orphan and pid watch.** `kill -9` the session's `claude` pid (the scratch one only). Confirm the listener exits within a few seconds (owner pid watch) and the stub sees the connection close. Record whether any message released after that is lost, and check that the stub's "offered until confirmed" bookkeeping would re-offer it.
- **T8, permission prompt and mode.** Open a permission prompt, release a wake, then reject the prompt. Record the order of events and how the model reads it. Repeat once in `bypassPermissions` mode.
- **T9, guards.** Run the listener by hand with `CLAUDE_CODE_SESSION_ATTENDED=0` (the claimed `-p` marker, reported): it must exit 0 at once. Run it with a bad `session_id` and with `SessionStart` source `clear` or `compact`: it must exit 0. Do not run `claude -p` to test this.
- **T10, environment inventory.** From the log, list which `CLAUDE_*` variables hooks see (for example `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`). This feeds SP6.
- **T11, HTTP hook shape (HOOK-HTTP-SHAPE).** Replace the `UserPromptSubmit` command hook with a `type: http` hook pointing at a stub endpoint `POST /wake/pending`. Record the exact request body and headers the harness sends (is `session_id` present, is there a bearer or custom header option), and which response shapes it accepts for `additionalContext` (the `hookSpecificOutput` form from t1b section 5.1 against any other). Also record what happens on a non-2xx response, on a timeout and on invalid JSON (expected: fail open, prompt proceeds).

### Pass and fail

Must pass (gate):

- T1: an idle session starts a turn on release, with latency under 10 s and the stub text visible to the model.
- T2: exit 2 occurs only for the documented cases; 409 and 408 never produce a visible wake.
- T3: exactly one parked listener after any turn; superseded listeners exit.
- T4: expiry behaviour is as the docs say (SIGTERM, silent, no re-arm), and the long timeout is accepted.
- T7: the owner pid watch ends the listener.
- T9: guards hold.
- T11: the HTTP hook's request body and an accepted `additionalContext` response shape are recorded, and the prompt proceeds on every failure mode. If the HTTP form is unusable, the fallback below applies.

Record only (design inputs, not pass or fail):

- T4 overnight result, T5 Esc gap size, T6 cap, T8 prompt behaviour, T10 variables.

If T6 shows wakes count toward a cap of 8, the plan still works because wakes are budgeted at 20 per hour and each wake text asks for a tool call, but the result must say so and the spec must name the real cap.

### Record

- Claude Code version, OS, shell, the exact hooks JSON and listener script used.
- A table of T1 to T11 with timestamps, stub log excerpts and the model's verbatim view of the wake text.
- The longest idle period that woke.
- The cap number, or "no cap observed in 12".

### Runner

The user starts and watches the Claude Code session and presses Esc. A helper Claude Code session writes the stub and listener, runs the stub in the background, tails its log, and writes the result. T4's overnight leg runs unattended with the stub's kill file as a safety.

### Estimated effort

- About 4 h of active work.
- One passive overnight run, no attention.
- About 30 minutes per extra machine for the version check and T1 only.

### Fallback if it fails

- T1 fails (no idle wake): promote SP6 (inbox socket) to a gate item. If that also fails, Claude Code gets the same surfacing as agy (`UserPromptSubmit` pending count, `a2a_inbox`, `a2a_wait`), and the "no idle wake" asymmetry applies to both. That is a change to decision 8, so it goes back to the user.
- T4 shows a short timeout ceiling: keep the in-script rounds but add the re-arm path at `UserPromptSubmit`, and shorten the documented idle window.
- T5 gap is large: show a "not listening" flag on the card and in `/sessions` (already planned) and make `UserPromptSubmit` re-arm the listener.
- T6 cap is low: lower the per-handle wake budget and make each wake text ask for a tool call.
- T11 shows the HTTP hook is unusable or its shape differs: use a short command hook (`a2a-pending`, curl with `--max-time 2`, exit 0 on every failure) for `UserPromptSubmit` instead, and update server-api.md 7.5 to the observed shape.

## 5. SP2: session binding (handle to Mcp-Session-Id)

### Question

Decision 6 proposes this chain, flagged unverified: a `SessionStart` hook posts the session to `/sessions`, the hook puts the handle into the model's context, and the model's first MCP call, `a2a_hello(handle)`, ties that connection's `Mcp-Session-Id` to the handle. Does each link work, for Claude Code and for agy?

### Why it matters

- Per-session addressing (`claude-code@alyx/<name>~<sid8>`, decision of 2026-11-09, separator `~` by round-4 X1 of 2026-11-10, server-api 5.1) is the core of decision 6. Without binding, only card-level addressing (newest live listener) is possible.
- The wake listener knows the harness session id from hook stdin. The MCP side knows only `Mcp-Session-Id`. The handle is the only join key, and it travels through the model.

### Method, Claude Code half

Uses the shared stub and the SP1 scratch project, with the stub registered as an MCP server (streamable HTTP, `http://127.0.0.1:18120/mcp`) in the scratch project's own MCP config.

- **C1, stdin and context.** In the `SessionStart` hook, log the full stdin JSON (all keys). Record whether any session name exists there or in the environment. Return `additionalContext` carrying a proposed handle (the handle grammar is now `<card>/<name>~<sid8>`, decision of 2026-11-09 with the `~` separator of round-4 X1, server-api 5.1; the session-name hint source recorded here is `session_title`) and the instruction to call `a2a_hello`. Ask the model to quote its context to confirm it arrived.
- **C2, one id per session.** The model calls `a2a_hello`, then `a2a_inbox` five times. Check the stub saw one `Mcp-Session-Id` throughout, and that `a2a_hello` bound to it.
- **C3, lifecycle.** Check whether the `Mcp-Session-Id` is unchanged after each event below. Record whether `SessionStart` fires on each, with which `source`, and whether the handle is still in context afterwards.
  - `/compact`
  - `/clear`
  - `--resume` of the same session
  - a subagent tool call
  - a long idle gap
- **C4, server restart.** Restart the stub mid-session. Record how the client reacts (404 then re-`initialize`, or an error shown to the model) and whether the next tool call arrives with a new id and no binding.
- **C5, compliance.** In 10 fresh sessions, count how many call `a2a_hello` unprompted before any other `a2a_*` tool. The stub answers any call from an unbound id with an error that says "call a2a_hello(handle)"; count how many then recover.
- **C6, two sessions.** Two concurrent Claude sessions with different handles, then with the same requested name. Record that ids and bindings do not cross, and what the stub sees on a name collision.
  - **Handle format now refers to the decision of 2026-11-09 (server-api 5.1, 3.5):** `<name>~<sid8>`, `~` plus the first 8 hex characters of the session id always present, so the same-name case no longer shares a handle (the separator was `#` between 2026-11-09 and 2026-11-10; round-4 X1 changed it to `~`, see 8b). Evidence: pair 3 of the SP2 Claude half passed with `claude-code@alyx/<name>#<first 8 of session_id>` (the `#` form that was current on 2026-11-06; the suffix mechanism is the same) ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-06-sp2-claude.md), Pair 3). That results file is a historical record and is not edited; the spec changes it lists (name at most 39 characters, lowercase) are applied in server-api 5.1.
- **C7, hook order (HOOK-ORDER).** Configure two `SessionStart` hooks, the registration hook (`POST /sessions`, with a deliberate 2 s delay in variant B) and the `asyncRewake` listener. Over 10 session starts, log the start and end timestamps of each from the stub. Record whether they run in parallel or in listed order, and how often the listener's first `/wake/listen` reaches the stub before the registration does (this decides whether the 15 s retry on `410 unregistered` in server-api.md 7.1 is needed).
- **C8, MCP tool timeout (MCP-TOOL-TIMEOUT).** The model calls the stub's blocking `a2a_wait(seconds)` with 30, 120 and 240 s. Record for each whether the result arrives, whether progress or an error is shown, whether the connection or the session survives a timeout, and the effective limit if one is hit. Also check whether an `MCP_TOOL_TIMEOUT`-style setting exists in the installed version's docs.
- **C9, header environment expansion (decision 24).** Register the stub with `headers: {"Authorization": "Bearer ${A2A_API_KEY}"}` in the scratch project's MCP config and export `A2A_API_KEY=spike-token` in the environment of the Claude Code session. Record whether the stub receives `Authorization: Bearer spike-token` (expanded) or the literal `Bearer ${A2A_API_KEY}`, on every request (`initialize`, `tools/list`, `tools/call`, `DELETE`), and what Claude Code shows on a 401. Repeat with the variable unset to record the failure mode. This is **unverified** today. If expansion does not work, the fallback is decided (decision 34): the installer writes the literal key into the user-scope MCP config (`~/.claude.json`, unmanaged), never into a chezmoi-managed file. Also record whether a GUI-launched Claude sees `A2A_API_KEY` (the shell-rc export may not reach it; hooks are unaffected because they read `~/.config/a2a-coord/api-key` directly).

### Method, agy half (run in the user's own session)

The user opens their own interactive agy in a scratch trusted workspace. Files are prepared by a helper session beforehand: a scratch `.agents/hooks.json` (the CLI reads it, verified in t1b section 4) and the stub MCP entry, added through `agy mcp add` by agy or the user (decision 25). agy's own MCP config location for a workspace-scoped entry is not in the evidence (see open points); if only the user-level `mcp_config.json` works, the user (or agy) adds the entry for the test, backs the file up first, and restores it afterwards.

- **A1, session id.** After agy calls any stub tool, read the stub log. Record whether an `Mcp-Session-Id` is issued and echoed back, how many MCP connections agy opens (per process, per conversation, per call), `clientInfo`, and whether any `_meta` or header carries the conversation id.
  - **Fully answered for agy, 2026-11-04** [verified on the wire] ([A6 results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a6.md) sections 5 and 6, and [A4 results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a4.md)):
    - `params._meta["antigravity.google/conversation_id"]` is present on `tools/call` (3 of 3 in the A6 run, every call in the A4 run), with `antigravity.google/root_conversation_id` and `antigravity.google/artifacts_dir`, and absent on `tools/list` and the notifications.
    - `Mcp-Session-Id` is process-scoped: one agy process shares one across conversations (A4 T1), separate processes get separate ones (T2), and a restart and resume gets a new one (T3).
    - Consequence for binding: server-api.md 5.4.1.
- **A2, injectSteps.** A `SessionStart` hook logs its stdin (`conversationId`, `workspacePaths` and others) and returns `injectSteps` with the handle and the `a2a_hello` instruction. Try each item type that is documented (`systemMessage`, `userMessage`, `ephemeralMessage`). Record which the model sees, and whether it is still visible five turns later.
  - **Result (2026-11-08): PASS [verified, transcript]** ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-08-sp2-agy.md) section 3): `systemMessage` arrives wrapped in `<SYSTEM_MESSAGE>` and was quoted verbatim after 8 or more turns; `ephemeralMessage` is gone by turn 2; `userMessage` reads as a second user request and confused the model. `systemMessage` is the canonical type (server-api.md 5.4).
- **A3, resume.** Quit and resume the same conversation. Record whether `SessionStart` fires again and whether the handle is still in context.
  - **Result (2026-11-08): recorded [verified]** (results section 4): `/clear` gives a new `conversationId` and `SessionStart` fires on the next input with a fresh handle; resume (`agy --conversation <id>`) does not re-fire `SessionStart`, the injected `systemMessage` stays in context, and the model called `a2a_hello` on its first turn.
- **A4, compliance and multi-conversation.** Same 10-session count as C5. Open a second conversation in the same agy process if the product allows it, and record whether it shares the MCP connection (which would make binding per process, not per conversation). Two follow-up checks moved here from the A6 run (its "parallel background invocation" is not a demonstrated second conversation in one process, [results section 6](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a6.md)):
  - Distinctness: with two conversations in the same agy process, call a tool in each and compare `Mcp-Session-Id` and `_meta["antigravity.google/conversation_id"]` (and `root_conversation_id`) on each `tools/call`. Also start a background or sub-invocation and record whether its `conversation_id` differs from its `root_conversation_id`.
  - Resume: restart agy, resume one conversation, call a tool, and compare its `conversation_id` with the one before the restart.
  - **Result (2026-11-04), identity part: PASS [verified on the wire]** per Antigravity's run, [`spike-results-2026-11-04-sp2-a4.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a4.md), reviewed by Claude Code (section 5 there):
    - T1: one agy process shares one `Mcp-Session-Id` across conversations (`/clear` starts a new conversation in the same process), while `conversation_id` differs.
    - T2: separate processes get separate `Mcp-Session-Id` and `conversation_id` values.
    - T3: after a full exit (`DELETE /mcp` seen) and `agy --conversation <id>` resume, `conversation_id` and `root_conversation_id` are the same, with a new `Mcp-Session-Id` and a new PID. Caveat: the pre-restart row came from a subagent call; stability still holds because the post-resume calls carry exactly the resumed id.
    - T4: subagent calls carry their own `conversation_id`, plus `root_conversation_id` and `parent_conversation_id` equal to the parent's.
  - Not covered by that run: the 10-session hook-compliance count (whether the model follows the injected `a2a_hello` instruction), which this step also asks for. It stays open, with A2.
  - **Result (2026-11-08), compliance count: PASS [verified on the wire]** (results section 5): with `systemMessage` injection, 10 of 10 fresh conversations bound unprompted (`a2a_hello` then `a2a_inbox`), 0 needed the error message.
- **A5, trust gate.** Confirm the hook runs only in the trusted scratch workspace (reported by zb-ss), and record what happens in an untrusted one.
  - **Result (2026-11-08): recorded** (results section 6): an untrusted workspace shows a blocking trust dialog; "No, exit" ends agy at once, with 0 lines in `session.log` and no hook or MCP server run [verified]. The "Yes" path was not part of this step.
- **A6, Authorization header.** Evidence gathered 2026-11-04 (Claude Code, read-only):
  - verified: agy 1.5.0 `agy mcp add --help` documents `--header "Authorization: Bearer TOKEN"` (repeatable `-H/--header`) for http servers
  - verified: the user's `~/.gemini/config/mcp_config.json` already has an entry (`obsidian`) with `serverUrl` plus a `headers` object holding an `Authorization` key (key names checked only, value not read)
  - reported: third-party guides show the same `serverUrl` + `headers` shape and say `httpUrl` is the older key
  - verified: agy's `mcp_servers.md` (line 66) documents `url` as the key and says the legacy key `serverUrl` is also accepted; examples in this plan use `url`. The `obsidian` entry above predates that and uses `serverUrl`.
  - still unverified, and what this step now tests: that the header is sent on every request of a streamable-HTTP session; whether `headers` values support environment-variable interpolation (otherwise the API key sits in plain text in `mcp_config.json`, as obsidian's does today); and whether agy's `/mcp` view shows a 401 clearly
  Why the interpolation answer matters beyond the spike (decisions 16 and 24): chezmoi source is committed to the dotfiles repository, and `~/.gemini/config/mcp_config.json` is managed as the template `private_mcp_config.json.tmpl` (verified with `chezmoi source-path` on 2026-11-04, contents not read). If interpolation worked, an entry could hold only `Bearer ${A2A_API_KEY}`. It does not (see the Result below: verified on the wire), so the agy key has to be a literal somewhere. Decision 24: that place is an unmanaged, plugin-scoped `.agents/plugins/coordination/mcp_config.json` (mode 0600) outside chezmoi, and chezmoi-managed files, `~/.gemini/config/mcp_config.json` included, never hold keys and are not edited for keys. Whether agy loads that file is step A8. The installer itself is not part of any spike and does not exist yet.
  Configure the stub entry with `agy mcp add --header "Authorization: Bearer spike-token" a2a-stub http://127.0.0.1:<stub-port>/mcp`, or edit `mcp_config.json` with the same `headers` shape. Also try a value of `Bearer ${A2A_API_KEY}` with `A2A_API_KEY` exported in the agy session's environment, and record whether it is expanded. The stub rejects any `/mcp` request lacking `Authorization: Bearer spike-token` with 401. Record that agy sends the header on every request (`initialize`, `tools/list`, `tools/call`, session-closing `DELETE`), and what agy shows the user and the model on a 401 (run once with the header removed). If agy cannot send a custom header, record that decisions 9 and 11 conflict for agy and stop: the plan needs a user decision. An API key in the URL is not an acceptable fallback.
  - **Result (2026-11-04): PASS** per Antigravity's run, [`spike-results-2026-11-04-sp2-a6.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a6.md). agy sent `Authorization: Bearer spike-token` on every request that reached the stub after the first probe: server discover, `initialize`, the `GET` SSE stream, `notifications/*`, `tools/list`, `tools/call` and the closing `DELETE` [verified, wire log]; a request without the header got 401.
  - Follow-up pass (results section 5, reviewed by Claude Code in section 6):
    - Q3 environment-variable interpolation: **verified on the wire**. agy sent `Bearer ${A2A_TOKEN}` and `Bearer $A2A_TOKEN` literally with the variable exported; no expansion. The literal key in the unmanaged plugin config (decision 24) stands.
    - The first unauthenticated `ping` came from Antigravity's own curl test script, not from agy. agy (`Go-http-client`) always sent the header.
    - Q1 correction confirmed by Antigravity: `url` is the documented key, `serverUrl` is the legacy alias, and `headers` is documented only in `agy mcp add --help`; the `McpServerSpec` struct names come from binary strings, not documentation.
  - Hard-gate status: the header gate is met on the evidence of the wire log.
- **A7, MCP tool timeout.** Same as C8 for agy: blocking `a2a_wait(seconds)` at 30, 120 and 240 s. Record the result, any error shown, and the effective limit.
  - **Result (2026-11-08): PASS [verified on the wire]** (results section 7): 30 s and 120 s returned 200; 240 s was cancelled at exactly 180.0 s (`notifications/cancelled`, "timed out after 3m0s: context deadline exceeded"), and the connection and `Mcp-Session-Id` survived. The 50 s `a2a_wait` default fits (server-api.md 4.5).
- **A8, plugin-scoped MCP config location and the `~/.agents` collision (decision 24).** Question: where can the installer put the agy key so that it is outside chezmoi and agy still loads it?
  - Method: in a scratch location, place a plugin-scoped `.agents/plugins/coordination/mcp_config.json` (mode 0600) holding the stub entry with the literal key. Try both a workspace-level placement (inside the scratch workspace) and a user-level placement (`~/.agents/plugins/coordination/`, created for the test and removed after). Record which one agy loads, and what `/mcp` shows for each. Reported by the A6 run: workspace MCP is supported only inside plugin bundles (`plugin.json` beside `mcp_config.json`); whether a user-level plugin directory exists is [unverified].
  - Collision check: `~/.agents` also holds the frozen bridge channel files (decision 14 keeps them untouched, with Antigravity's research exception). Record whether agy reads or scans `~/.agents` for anything else (hooks, rules), whether a `plugins/` subdirectory there is inert to the frozen channel's watcher (`watch-bridge-coordination.sh`, which counts files in `~/.agents` `handoff/`), and that the test left no file behind.
  - Pass: a placement is found that agy loads, is outside chezmoi, and does not disturb `~/.agents`. Fallback if none: a non-chezmoi include that agy reads, chosen by the user. Nothing launches, drives or wraps agy; the user or agy itself runs this in its own session.
  - **Result (2026-11-08): partial** ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-08-sp2-agy.md) section 2): `~/.agents/plugins/` is ignored by agy (0 requests) and the `~/.agents` collision check was clean [verified]. `~/.gemini/config/plugins/coordination` connected (`initialize` and `tools/list` 200) but its tools failed with `tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`, and the same-named workspace plugin did not load [verified]. The results file's readings of that failure (session enablement or sign-in, user level shadows workspace) are superseded by A8b.
  - **A8b, user-level plugin tools (2026-11-09): PASS, with the unique-name caveat** ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-09-a8b-agy.md), [runbook](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-runbook-a8b-user-level-plugin-2026-11-08.md)):
    - A user-level plugin at `~/.gemini/config/plugins/<name>/` with a native `mcp_config.json` runs `a2a_hello` and `a2a_inbox` through agy with no `agy plugin enable`, no `config.json` entry, on a warm restart and on a cold first load with no cache [verified, runs A, A2, A3, A4].
    - The 2026-11-08 failure was not sign-in (the startup warning appears in every startup log, including working runs), not a missing enable step (A3) and not a cold first load (A4) [verified].
    - It correlates with a same-named workspace plugin being present: in both runs with one, the user-level tools were "not enabled"; in the 2026-11-09 shadow run both servers connected and the workspace server's tools worked [verified]. Which scope wins is [unverified]. Rule: the installed plugin's name must not equal any workspace plugin name.
    - A connected server (`initialize` and `tools/list` 200) is not proof the tools are callable; the installer's health check must call a real tool [verified].
    - Untested: `.mcp.json` at user level, `agy plugin install`, and whether tool use needs a live sign-in (every successful call was signed in). All three are A8c below.
    - Fallback if the placement ever breaks: the `agy mcp add` global entry in `~/.gemini/config/mcp_config.json` (verified in A6 and A4, 2026-11-04); chezmoi-managed, so it reopens decision 24.
  - **A8c, the three items A8b left open (2026-11-09, planned, not run; D-E)** ([runbook](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md)):
    - Items: (1) `.mcp.json` at user level in `~/.gemini/config/plugins/<name>/`, (2) `agy plugin install <path>` and uninstall, (3) tool use while signed out of agy.
    - Not blocking S1. Until it runs, the installer's agy placement is the A8b form (user-level native `mcp_config.json`, unique plugin name).
    - Item (3) changes the user's real agy login, so it is the last run, with an explicit backup of the agy credential file, a put-back step and a check. The helper never signs the user out; the user does.
    - Same rules as A8b: the helper never starts or drives agy, the user starts agy, agy answers the prompts, labels verified, reported and unverified, borrow and put back. Every variant's plugin name must differ from any workspace plugin name (the A8b unique-name rule).

### Pass and fail

Must pass (gate):

- Claude Code: C1 and C2 pass (handle arrives in context; one stable `Mcp-Session-Id` per session across at least 5 calls). C3 either keeps the binding across `/compact` and resume, or shows a clean way to re-bind (the unbound-call error). C5: at least 8 of 10 bind unprompted and 10 of 10 bind after the error message.
- agy: A1 shows a stable per-conversation id (met 2026-11-04: `_meta["antigravity.google/conversation_id"]`, verified on the wire; `Mcp-Session-Id` is per process and is not the key). A2 shows at least one injectSteps type reaches the model and the model calls `a2a_hello`. A4: at least 8 of 10 bind after the injected instruction or the error message.
- agy A6: agy sends the configured `Authorization: Bearer` header on every `/mcp` request, and a request without it is refused with 401. This is a hard gate: if it fails, decision 9 (agy uses MCP at `:8120/mcp`) and decision 11 (loopback still needs an API key) cannot both hold, and S1 does not start until the user decides.
- Binding is unambiguous: two concurrent sessions never share a binding (C6).
- C7: the result states whether the two `SessionStart` hooks run in parallel or in order, so the listener retry rule is either kept or removed on evidence.
- C8 and A7: the effective MCP tool timeout is recorded for both harnesses and `a2a_wait`'s default is shown to sit inside it (or lowered to fit).

Record only: A3 resume behaviour, C4 restart behaviour, A5 trust behaviour, session-name availability.

Record, with a stated fallback if negative (they do not block S1 by failing, but they decide how keys are stored, decision 24):

- C9: whether Claude Code expands `${A2A_API_KEY}` in MCP header values.
- A8: whether agy loads a plugin-scoped `mcp_config.json` from a user-level location, and the `~/.agents` collision check. Answered by A8 and A8b (2026-11-08 and 2026-11-09): yes at `~/.gemini/config/plugins/<name>/` with a unique name; `~/.agents` is not scanned.
- A4 identity checks are done (verified 2026-11-04): distinctness, resume stability and sub-invocation ids. Only the A4 10-session hook-compliance count remains open. Done 2026-11-08: 10 of 10.

### Record

- The full hook stdin keys for both harnesses (keys and example shapes, no secrets).
- The `Mcp-Session-Id` lifecycle table per event.
- The count for C5 and A4.
- The A6 header result, the C7 ordering result and the C8 and A7 timeout limits.
- A statement that binding is an assertion by an API key holder, not authentication of a particular session. Every holder of a local-harness API key can claim any local handle; the spec has to say that this is accepted.

### Runner

- Claude half: user starts sessions; helper runs the stub and reads logs.
- agy half: the user, or agy inside that session at the user's request. Nothing else may start or touch agy.

### Estimated effort

- Claude half: about 1 day including the 10-session compliance runs (they are short).
- agy half: about 2 h, mostly the user's time.

### Fallback if it fails

- Handle name not available from the harness: the unnamed-session form is [design, open] (server-api 3.5): either `<card>/<first 8 chars of the session id>` with no suffix (the SP2 Claude half note) or the always-present `~<sid8>` suffix with a default name. `a2a_hello(name=...)` supplies a name hint; the server derives the handle.
- `Mcp-Session-Id` not stable or not sent (agy): carry the handle explicitly in every write tool (`as_handle`), validated server-side against `/sessions`, and keep the hook-injected handle in context. Read tools stay unbound.
- Injected handle not seen by the model: the handle and the "check a2a_inbox now" line are the `SessionStart` `injectSteps` content (decision 27); no `AGENTS.md` is ever written. If injection does not reach the model, the server's unbound-call error carries the instruction ("call `a2a_hello`") and agy binds by `conversation_id` anyway (server-api.md 5.4.1).
- A6 fails (agy cannot send a custom `Authorization` header): no safe in-plan fallback. Options for the user:
  - a separate loopback-only MCP shim that adds the header (it does not launch or wrap agy, so DDR-003 is untouched), evaluated as a candidate
  - agy gets no `/mcp` and relies on the hooks alone

  Either option changes decision 9 or 11 and goes back to the user.
- C7 shows hooks run in order, registration first: drop the 410 retry from the listener. If parallel: keep it.
- C8 or A7 shows a short tool timeout: lower `a2a_wait`'s default and maximum below it and document the limit.
- Binding unreliable overall: drop per-session addressing for that harness. Card-level addressing (newest live listener, else queued) already exists in decision 6 and keeps working. This reopens decision 6 for that harness only.

## 6. SP3: agy `PreInvocation` surfacing

### Question

Does a `PreInvocation` command hook that asks the server for a pending count and returns `injectSteps` with a constant stub reliably surface the count to agy's model? What does it cost per model call, and what does agy do when the hook is slow, wrong or absent?

### Why it matters

- Decision 9 depends on it as the main way an agy session learns it has mail, since there is no idle wake.
- A hook that runs before every model call is on the hot path. A bad failure mode (blocking every call, or silently dropping the turn) would be worse than having no hook.
- The audit found exit-code semantics, timeout behaviour and a maximum timeout all undocumented (t1b section 4).

### Method

Run in the same user-owned agy session and scratch workspace as SP2-agy, after SP2-agy.

- **P1, basic surfacing.** The hook calls `GET /pending` with `curl --max-time 2` and, when the count is above zero, returns `{"injectSteps":[{"ephemeralMessage":"[a2a] N pending. Call a2a_inbox."}]}`. Set the pending count to 2 via the control file. Type an ordinary message. Record whether the model mentions it and whether it calls `a2a_inbox` unprompted. Do five trials.
  - **Result P1 (2026-11-10): PASS [verified, wire]** ([results](../research/spike-results-2026-11-10-sp3-sp4.md) section 2, P1): 5 of 5 valid trials; the model saw the `ephemeralMessage` and called `a2a_inbox` unprompted on the wire in every trial (gate: at least 4 of 5). With dedupe off the notice was injected on every model call (3 to 9 per turn).
  - **Result P1b (2026-11-10): recorded [verified]** (results section 2, P1b): with `systemMessage` and dedupe on, 5 of 5 trials announced exactly once per turn and the model called `a2a_inbox` unprompted.
  - **Result P1r (2026-11-10): recorded [verified]** (results section 2, P1r): resume (`agy --conversation <id>`) did not re-fire `SessionStart` (0 new calls), and `PreInvocation` fired on the first model call and announced 3 pending; the model called `a2a_inbox` and answered.
- **P2, frequency.** Log every hook invocation. Record how often `PreInvocation` fires per user turn (once, or after every tool call), and whether it fires on the first model call of a conversation.
  - **Result (2026-11-10): recorded [verified]** (results section 2, P2): `PreInvocation` fires once on a no-tool turn and once per model call on a tool turn (2 calls on a one-tool turn), including the first model call of a conversation; `invocationNum` resets to 0 on each user prompt. Stdin keys: `artifactDirectoryPath`, `conversationId`, `cwd`, `hookEventName`, `initialNumSteps`, `invocationNum`, `lastUserInput`, `modelName`, `transcriptPath`, `workspacePaths`.
- **P3, latency.** Record per-invocation hook duration from the hook's own timestamps. Record the visible delay added to a turn compared with a no-hook turn.
  - **Result (2026-11-10): PASS [verified]** (results section 2, P3): 186 normal hook runs against the loopback stub: p50 28 ms, p95 33 ms, max 39 ms (gate: p50 under 100 ms, p95 under 500 ms). The visible per-turn delay was dominated by model latency, not the hook.
- **P4, persistence and noise.** Check whether an `ephemeralMessage` survives into later model calls or vanishes after one. With a per-conversation state file in the hook (announce only when the count changed), confirm the model is not told the same thing on every call.
  - **Result P4a (2026-11-10): recorded, one sample** (results section 2, P4a): in turn 2 the model searched its own transcript file instead of answering from context, so it behaved as if the `ephemeralMessage` text was no longer in its context; that the text is gone from context is [inferred, unverified]; the text is still in the transcript file [verified].
  - **Result P4b (2026-11-10): PASS [verified]** (results section 2, P4b): with `systemMessage` and the dedupe rule, pending counts 2, 2, 3, 0, 2 gave 12 invocations and 3 announcements, sequence `[2, 3, 2]`; the stale-state bug (state not reset when the count dropped to 0) was fixed and re-verified; in one conversation the model quoted all notices verbatim several turns later. Reliability over many conversations is [unverified].
- **P5, failure behaviour**, one at a time, with the model asked to do a trivial task each time:
  - hook exits non-zero
  - hook prints invalid JSON
  - hook prints nothing
  - hook sleeps longer than its `timeout` (use `timeout: 5`)
  - server down (connection refused)
  - hook exits 2
  Record for each: does the model call still happen, does the user see an error, is the turn blocked.
  - **Result (2026-11-10): PASS [verified]** (results section 2, P5): all 6 failure modes (exit 1, invalid JSON, empty output, sleep 8 s against `timeout: 5`, server down, exit 2) failed open: the model call proceeded, no error shown to the user, no turn blocked, no orphan. agy did not kill the sleeping hook at 5 s; it stopped waiting after about 5 to 6 s and proceeded, and the hook finished its 8 s. A down stub cost 1,025 to 1,028 ms (bounded by `curl --connect-timeout 1`). Safe script behaviour: always exit 0 with `{}` on any internal error.
- **P6, timeout setting.** Confirm the 30 s default by running a 35 s sleep once with no `timeout` set. Record what happens.
  - **Result (2026-11-10): recorded [verified]** (results section 2, P6): with no `timeout` key and a 35 s sleep, agy proceeded after about 31.5 s without the hook output and did not kill the hook (it ran 35,030 ms, no orphan). This fits the documented 30 s default [reported]; one sample.
- **P7, stub text.** Check that the wake wording is understood and not mistaken for an instruction from the user. Record the verbatim model reply.
  - **Result (2026-11-10): recorded [verified]** (results section 2, P7): asked about messages other than the user's, the model quoted both the `ephemeralMessage` and the `systemMessage` text and attributed them to the hooks or the system; neither was taken for a user instruction or an agent message.
- **P8, user-level hooks file in all workspaces (decision 26).** The shipped agy hook entries live in the user-level `~/.gemini/config/hooks.json` (exists, not chezmoi-managed, verified), not in per-workspace `.agents/hooks.json`. Under "borrow and put back" (decision 25), back that file up, add the test `SessionStart` and `PreInvocation` entries, and start fresh agy sessions in at least three unrelated workspaces, one of them untrusted. Record whether the hooks run in each (the A5 trust gate may apply to workspace hooks only), and whether a workspace opt-out marker is honoured: the hook script checks for `.a2a-optout` in the workspace root and exits at once and silently [proposal for the marker name]. Also record that an unreachable server makes the hook exit fast (within the P5 timings) and print nothing. Restore the file and verify it matches the backup. agy edits are made by agy or the user.
  - **Result (2026-11-10): recorded [verified]** (results section 2, P8): user-level hooks ran in a trusted workspace (`SessionStart` and `PreInvocation` at 28 to 31 ms, stub received `/sessions`); in a workspace with `.a2a-optout` both hooks logged the opt-out, emitted `{}` and the stub saw 0 requests; the untrusted workspace stopped at the folder trust dialog, "No, exit" ended agy with 0 hook runs [reported dialog, verified 0 runs], so hooks in an untrusted workspace past the dialog are [unverified]. With the stub stopped, `SessionStart` took 2.0 s and `PreInvocation` 1,025 ms, no error shown. The user's own `hx-tab-sync` entry in the same file was preserved, and the file was restored byte-for-byte.

### Pass and fail

Must pass (gate):

- P1: the model sees the stub and calls `a2a_inbox` in at least 4 of 5 trials.
- P3: median hook time under 100 ms against the loopback stub, 95th percentile under 500 ms.
- P5: every failure mode is fail-open (the model call proceeds). If any mode blocks or breaks the turn, the hook script must be able to avoid it, and it must be shown which script behaviour avoids it (for example always exit 0 with `{}`).
- P4: a dedupe rule exists that stops repeated announcements.

Record only: P2 frequency, P6 default behaviour, P7 wording.

### Record

- agy version.
- Hook invocation counts per turn and a latency table.
- A table of failure mode versus observed behaviour.
- The exact script behaviour that is safe on every failure.

### Runner

The user, or agy itself in the user's session. A helper Claude session prepares the scratch files and reads the logs afterwards.

### Estimated effort

About 1.5 h.

### Fallback if it fails

- `ephemeralMessage` not seen: try `userMessage` or `systemMessage` types; if none reach the model, drop the hook.
- Hook fires on every tool call and cost is real: dedupe with the state file, or throttle to one server call per 10 s.
- A failure mode blocks the turn and cannot be avoided: do not ship the `PreInvocation` hook; agy keeps the `SessionStart` `injectSteps` inbox instruction (decision 27, no `AGENTS.md`), the `a2a_inbox` tool and `a2a_wait`. The asymmetry grows but nothing breaks.

## 7. SP4: agy held `Stop` park (spike only, never shipped without a user decision)

### Question

Can a `Stop` hook gated on `fullyIdle: true` hold the session while it long-polls and then return `{"decision":"continue","reason":...}` to wake an idle agy, without making the user's session unusable? Also, does a finished background command wake an idle agy?

### Why it matters

- Decision 9 records "no idle wake for agy" as an accepted asymmetry and treats the held park as a spike only. This spike tells the user whether that acceptance could be revisited.
- The audit found switchboard precedents for other harnesses where a long Stop hook left the interface on "Working" and deferred typing (reported). For agy none of this is documented: maximum timeout, typing during the hook, whether `Stop` fires per turn.
- A separate claim sits in the old heartbeat spec: that agy wakes on a background task finishing (an Antigravity message, recorded in [heartbeat-spec](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/heartbeat-spec.md) section 1). The audit marks it unverified.

### Method

In its own scratch workspace and its own agy session, not combined with SP3. Use no network at first: the "park" is a script that waits for a control file.

Safety first:

- Keep a second terminal ready with `pkill -f spike-stop-park`.
- Start with `timeout: 30`, then 300, then 1800. Never start with a long timeout.
- The hook returns `{"decision":"stop"}` immediately unless `fullyIdle` is true.

Tests:

- **K1, per-turn firing.** Log every `Stop` payload: `executionNum`, `terminationReason`, `fullyIdle`. Run three turns with no tools, then a turn with a tool call. Record whether `Stop` fires per turn or per conversation, and when `fullyIdle` is true.
  - **Result K1 (2026-11-10): recorded [verified]** ([results](../research/spike-results-2026-11-10-sp3-sp4.md) section 3, K1): `Stop` fires once per user turn after the final model response (4 turns observed), not per model call or tool step; `fullyIdle` was `true` on every turn without background tasks. Payload keys include `executionNum`, `terminationReason` (`NO_TOOL_CALL`), `fullyIdle`, `error`.
- **K2, typing.** While the hook is parked, try to type, submit a message, press Esc and Ctrl-C. Record what the interface shows and whether input is queued, lost or blocked.
  - **Result K2 (2026-11-10): recorded** (results section 3, K2): text typed while the hook was parked was queued, not lost or blocked [verified]; the UI showed a "Generating" or "Loading" spinner [reported]; on release the queued prompt was delivered as a user step and the model answered.
- **K3, release.** Release the hook with `{"decision":"continue","reason":"[a2a] N pending. Call a2a_inbox."}`. Record whether a new turn starts, how the reason is shown to the model, and whether repeated continues are capped.
  - **Result K3 (2026-11-10): recorded [verified]** (results section 3, K3): `{"decision":"continue","reason":...}` starts a new model turn at once; the reason reaches the model as `<SYSTEM_MESSAGE>Stop hook blocked termination: <reason></SYSTEM_MESSAGE>`; consecutive continues are capped at 10 (the 11th was ignored and the session stopped).
- **K4, timeout.** At each timeout setting let the hook expire. Record what happens (kill, error text, session state) and the largest `timeout` accepted. Record whether the park child process is also killed or is orphaned.
  - **Result K4 (2026-11-10): recorded** (results section 3, K4): with `timeout: 30` agy did not release at 30 s and did not kill the hook [verified]; it released the UI at about 60 s [reported] and the hook kept running as an orphan (ppid 626, the WSL init) until killed by hand at 105 s [verified]. A 300 s hold was never run to expiry and 1800 s was not run [unverified]; the largest accepted `timeout` was not established.
- **K5, interruption.** Press Ctrl-C and Esc while parked, and quit agy while parked. Check for orphaned processes afterwards (`pgrep -f spike-stop-park`).
  - **Result K5 (2026-11-10): recorded** (results section 3, K5): Esc, Ctrl-C and `/exit` each released the UI or exited agy, and all three left the park script running as an orphan; agy sends no signal to a `Stop` hook child on cancel or exit [verified, orphans seen]; the Ctrl-C key press itself is [reported] by the user.
- **K6, background command.** Ask agy to run `sleep 60; echo done` as a background command through its own shell tool. Then leave it idle. Record whether the command finishing starts a turn.
  - **Result K6 (2026-11-10): YES [verified]** (results section 3, K6): `Stop` fired with `fullyIdle: false` while `sleep 60; echo done` ran in the background; when it finished about 60 s later agy injected a system message, ran `PreInvocation`, and the model started a new turn without user input; the next `Stop` had `fullyIdle: true`.

### Pass and fail

This spike is recorded, not gated. For the user's later decision, the park would count as "usable" only if all hold:

- typing is not blocked (K2)
- interrupts end the hook and leave no orphan (K5)
- the accepted timeout is at least one hour, or re-arm by `continue` is clean (K4)
- `Stop` fires at a predictable point (K1)

The K6 result decides whether the "background watcher started by agy itself" fallback in t1b section 5.3 is worth trying; it is recorded as yes, no or unclear.

### Record

- agy version and the `Stop` payload samples.
- A table of K1 to K6 with observed behaviour.
- A one-line recommendation: usable, usable with caveats, or not usable. The user decides.

### Runner

The user, or agy itself in the user's session. Nobody else touches agy.

### Estimated effort

About 2 h, mostly the user's time.

### Fallback if it fails

None needed. Decision 9 already ships without it. If the park is not usable, the asymmetry stays as accepted. If K6 says background completion wakes agy, record it as a candidate for a later user decision. Nothing ships on it.

## 8. SP5: a2a-python on SQLite

Status (2026-11-09): passed, results recorded. On 2026-11-09 the user chose Postgres as the starting engine for reasons beyond this spike (see D-A and SP5b), so SP5 stays in the record as passed and no longer gates S1. Its evidence still explains why the wrappers exist.

### Question

Does `a2a-python` (1.3.0 or later) with `DatabaseTaskStore` on SQLite hold up under the traffic of one server process that serves MCP, A2A and the wake long-poll together, with WAL and a busy timeout that we configure ourselves? Do migrations, backups and crash recovery behave?

### Why it matters

- Decision 4 puts all state in one SQLite file owned by one process, with the promise that Postgres is "a SQLAlchemy URL change" later.
- The audit verified there is no WAL, busy-timeout or `PRAGMA` handling anywhere in the SDK (t1c), and that cluster mode is only about five weeks old. We are choosing not to depend on cluster mode, so the plain store must be shown sufficient.
- Our own tables (sessions, API keys hashes, wake budgets, quarantine records) sit in the same file, and we need to know they coexist with the SDK's migrations.

### Method

A scratch `uv` project in `~/scratch/a2a-spikes/sp5/` with `a2a-sdk` (extras for the HTTP server and SQLite, names checked against the SDK's `pyproject.toml` first), plus a small load driver. Docker only where a step says so. Read the store's constructor and the migration CLI source before writing anything; the exact signatures are not in the audit.

Steps:

- **D1, engine setup.** Create the async engine on a file in a Docker named volume `a2a-data` mounted at `/data` (inside a scratch container). Set `journal_mode=WAL`, `busy_timeout` (start at 5000 ms), `synchronous=NORMAL` and `foreign_keys=ON` through a connect event. Also test `BEGIN IMMEDIATE` for write transactions, because a deferred transaction that upgrades from read to write can return `SQLITE_BUSY` without waiting (general SQLite behaviour; the test shows whether it bites here).
- **D2, mixed load in one process.** Run for 10 minutes, at 10 times the realistic rate, all at once:
  - A2A `SendMessage`, `GetTask`, `ListTasks` and `CancelTask` over JSON-RPC and REST
  - fake MCP tool calls that create tasks and move them SUBMITTED to WORKING to COMPLETED
  - 200 parked wake listeners (long-poll requests) waking on task creation through an in-process notify, not by polling the database
  - writes to our own tables from the same process (session register, budget counters)
  Measure: p50 and p99 latency per operation, count of `SQLITE_BUSY` or "database is locked" errors, event-loop lag, wake latency from task creation to the listener's 200, and WAL file growth between checkpoints.
- **D3, same-task race.** Two writers update one task at the same time (cancel versus complete; two `a2a_inbox` takes). Record whether the plain store loses an update. If it does, test whether the versioned store (cluster mode) is the cure, and say so.
- **D4, extension round trip.** Store a task with our extension data and read it back through `GetTask` and `ListTasks`:
  - the addressed handle in `Message.metadata.coord.to` and the sender in `Task.metadata.coord.from` (server-api 5.3)
  - a held task stored with state `TASK_STATE_INPUT_REQUIRED` plus metadata `coord.hold="quarantine"` (QUARANTINED is our extension, not an A2A state; the sender sees INPUT_REQUIRED). Confirm `interrupted_task_timeout` does not auto-release it (server-api 6.1, 10)
  - `context_id` generated per (originator, recipient card) pair
  - confirm what `ListTasks` can filter by, and whether we need a side index table for handle lookups
- **D5, owner scoping.** Using the SDK's owner resolver, check that a task created under one API key's owner is invisible to another API key through `GetTask`, `ListTasks` and `CancelTask`. This is what keeps a remote-peer API key from reading local tasks.
- **D6, migrations.** Run the SDK's migration CLI against an empty database, again (it must be a no-op), and from the oldest shipped revision with data present. Check what happens when the database is newer than the code. Check how `create_table` style setup in the store interacts with Alembic. Check that our own tables can have their own migration history in the same file without clashing with the SDK's version table.
- **D7, backup and restore.** While D2 load runs, take a backup with `sqlite3 .backup` (or `VACUUM INTO`), then restore it to a fresh volume and run `PRAGMA integrity_check` and row counts. Also show that copying only the `.db` file during load is not safe, so the backup procedure is written down correctly.
- **D8, crash.** `kill -9` the container mid-load, restart it. Check no committed task is lost or corrupt, WAL recovery is clean, and tasks left in an "offered" state are re-offered after restart.
- **D9, filesystem.** Confirm the volume's filesystem supports WAL shared memory (`stat -f -c %T /data` inside the container). Record that the database must not sit on a bind mount of a Windows-side or network path on WSL2 or macOS.
- **D11, SDK fit (A2A-SDK-FIT).** Using the scratch project, build the smallest version of the three SDK extension points server-api.md sections 3.3 and 10 rely on, and record whether each works without patching the SDK:
  - a custom request handler for parked tasks (create a task and return; later state changes arrive from outside the request, not from an `AgentExecutor`)
  - task visibility for "originator or recipient card" over the SDK's `owner_resolver`, with `ListTasks` as a wrapper over the store and a side `task_index` table
  - a held task stored as `INPUT_REQUIRED` plus `coord.hold`, returned to the sender as plain `INPUT_REQUIRED`
  - the SDK's own status-event publication to a subscriber, driven by our service layer rather than an executor (needed only for S2 streaming; record, do not gate)
- **D12, MCP mount (MCP-MOUNT).** Mount the official `mcp` SDK's streamable-HTTP app into the same Starlette application as the a2a-python routes, with stateful sessions, behind one shared middleware stack (Host and Origin checks, bearer auth, scope check). Record whether lifespan and session managers start and stop cleanly together, whether `Mcp-Session-Id` is issued and echoed, whether auth middleware sees `/mcp` requests, and whether a 200-listener long-poll on `/wake/listen` in the same process starves MCP calls. If mounting fails, record the fallback taken (two ASGI apps under one server process, or a second internal port behind the same container).
- **D10, Postgres swap (stretch).** Run the D2 mix and D4 to D6 against a Postgres container by changing only the SQLAlchemy URL. This is the evidence for decision 4's "URL change only". If time is short, mark it not run.

### Pass and fail

Must pass (gate):

- D2: zero unhandled `SQLITE_BUSY` errors in 10 minutes. p99 write latency under 200 ms. Event-loop lag under 100 ms. Wake latency p99 under 500 ms with 200 parked listeners.
- D3: either no lost update, or a named cure that passes.
- D4: our extension data round-trips, and a plan for handle lookup (store filter or side table) is chosen.
- D5: no cross-owner read or cancel.
- D6: migrations are idempotent, a newer-than-code database is refused with a clear error, and our own tables migrate alongside the SDK's.
- D7: a restored backup passes the integrity check with consistent counts.
- D8: no committed task is lost after `kill -9`.
- D11: the parked-task handler, visibility wrapper and held-task storage work on the SDK as published, or a thin wrapper of ours is shown to work (and is named in the record).
- D12: the `mcp` app and the a2a-python app run in one process with shared middleware, or the fallback is shown working.

Record only: D9 filesystem facts, D10 Postgres result, resource use at idle.

### Record

- `a2a-sdk` exact version, Python version, SQLite version, `aiosqlite` and SQLAlchemy versions.
- The engine and PRAGMA configuration that passed.
- A latency table and error counts for D2.
- The backup and restore command sequence that worked.
- Any SDK behaviour that needs a wrapper of ours (for example D3).

### Runner

A helper Claude Code session on alyx. No harness session of the user's is involved. Docker is used only for the volume steps, per decision 1 (container restrictions lifted).

### Estimated effort

About 1 to 1.5 days. D10 adds about 2 h.

### Fallback if it fails

- Busy errors under load: route all writes through one writer task (one queue, one connection) and keep reads concurrent; use `BEGIN IMMEDIATE`; raise the busy timeout.
- Lost updates on the plain store: use the SDK's versioned store (cluster mode) inside the single process, or our own compare-and-swap in a thin store wrapper.
- Plain store unfit overall: write our own `TaskStore` subclass on the same schema (the SDK's abstract base is small, and the mcp-a2a store shows the pattern), keeping the A2A request handler and wire code from the SDK.
- D11 shows the SDK request handler cannot support parked tasks: write our own request handler and `TaskStore` wrapper and keep only the SDK's types, card and wire code.
- D12 shows the two Starlette apps cannot share a process: run `/mcp` as a second ASGI app in the same container on an internal port behind the same auth middleware, published through one internal route in the container (not the public front door, which is the Cloudflare Tunnel of decision 20 and routes only `/a2a/v1` and the card).
- Migrations clash: keep our tables in a second SQLite file owned by the same process, with its own Alembic history.
- SQLite itself unfit: use Postgres in compose from S1. Not triggered: SP5 passed. The user chose Postgres in compose from S1 on 2026-11-09 anyway, for reasons beyond SP5 (D-A), which reverses decision 4's starting engine. The gate for that engine is SP5b.

## 8b. SP5b: a2a-python on Postgres (D-D)

### Question

Does the planned storage stack hold up on Postgres as the starting engine: the SDK `VersionedDatabaseTaskStore` with a version row seeded at task creation, our `CoordTaskStore`, the custom parked-task request handler, the `task_index` side table and our own tables on SQLAlchemy Core, under one server process that serves MCP, A2A and the wake long-poll, with the database as a second compose service? Do the dump and restore backup and crash recovery (server killed, Postgres restarted) behave?

### Why it matters

- Decision 4 started on SQLite. The user reversed that on 2026-11-09: Postgres in the compose project from S1 [D-A]. The user chose it although SQLite had been enough: SP5 on SQLite measured about 23 writes per second at 10 times the realistic rate, p99 write 17 to 35 ms, a ceiling of about 430 saves per second on one connection, and 0 lost acked writes after `kill -9` ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-05-sp5.md)). The tripwires that would have forced a move, kept for the record: more than one writer process, a network filesystem, a failover need, around 100 times the load.
- The server stays ONE process (parked wake listeners live in memory), so the single-server-process rule stands. Only the database is now a second service.
- What SP5 D10 covered on Postgres was partial [verified, SP5 results]: D4, D5 and D6 passed by URL change; the D2 mix ran 3 minutes, not 10, with 22 retried deadlocks (transition p99 1031 ms) cured by seeding the version row at creation (p99 13.8 ms); D3 on Postgres gave 0 lost updates with the versioned store. Stress, backup and crash were not run on Postgres.
- Our SQLite compare-and-swap built on `BEGIN IMMEDIATE` did not carry over (259 of 300 lost updates on Postgres). That is why the wrapper is the versioned store with a seeded version row, and why the single-connection `BEGIN IMMEDIATE` write engine, the WAL and filesystem caveats, and `sqlite3 .backup` are retired.
- SP5 D2 skipped the steady-state session-register and budget-counter writes (its own-table writes were wake and audit rows only). SP5b adds them.

### Method

A scratch compose project in `~/scratch/a2a-spikes/sp5b/`, same tools and drivers as SP5 (the load driver and test suites are copied from `~/scratch/a2a-spikes/sp5/`, which is not edited). Ports in the 181xx range, as SP5 did, loopback only (`127.0.0.1:...`): SP5 used 18125 to 18127, so SP5b uses 18130 to 18132 [design; check they are free with `ss` first]. The compose project holds:

- the server container, `A2A_DB_URL` pointing at Postgres, one process
- a Postgres container from an image pinned by **exact tag plus a digest**, both chosen when SP5b runs and recorded in the results [D-B, R3]. This is the pin note for S1: the same image then runs in S1, S2 and S3, there is no major-only tag and no `latest`, and an upgrade is a deliberate change (`pg_dump`, upgrade, restore test). This file states no version number; SP5 D10 happened to use 17.11, which is a record, not the pin.
- a named volume for the Postgres data
- no published Postgres port: the database is reachable only on the compose network (confirm with `ss` on the host that nothing listens)
- the Postgres password from a secret file in the scratch directory (a throwaway value, mode 0600, never printed or written to a result), wired as the real stack will be (R2): Postgres reads `POSTGRES_PASSWORD_FILE`, the server reads `A2A_DB_PASSWORD_FILE` and composes its connection at start-up, `A2A_DB_URL` carries no password, no password environment variable, no trust authentication
- the real dump sidecar as a compose service with `profiles: ["backup"]` (R14), so it does not start with a plain `docker compose up`. It connects as the read-only role `dump_ro` (R11: `CREATE ROLE dump_ro LOGIN; GRANT pg_read_all_data TO dump_ro`; the SP5b run of 2026-11-10 created it with a Postgres init script on first initialisation of the volume, and round-4 X2 replaced that route with the host command `a2a-coord db init-dump-role`, retested in the SP5b follow-up below) with its own throwaway secret file in the scratch directory (mode 0600, mounted only into the sidecar, never printed or written to a result), writing into a scratch bind-mounted directory on alyx (SP5b runs on alyx; `/media/media2/backup/a2a/` is a core path and is not used here)

The engine factory is plain: no SQLite PRAGMAs, no single-connection write engine, no `BEGIN IMMEDIATE`. Version rows are seeded at task creation in the same transaction as the task (SP5 D10 cure).

Steps (SP5 ids kept):

- **D2, mixed load in one process.** The SP5 D2 mix on Postgres: 10 minutes at 10 times the realistic rate, with 200 parked wake listeners, the A2A and fake MCP traffic of SP5 D2, and now the steady-state session-register and budget-counter writes. Their rates are [design, open]: set when the driver is written, from the realistic-traffic assumption in the SP5 results (5 agents), and recorded. Measure p50 and p99 per operation, database errors, event-loop lag, wake latency, and the count of `deadlock detected` lines in the Postgres log (SP5 D10 saw 22 before the seeding cure).
- **D3, same-task race.** Cancel versus complete, and two `a2a_inbox` takes, on the versioned store with the seeded version row, 300 rounds each as in SP5. Record lost updates and double takes.
- **D7, backup and restore (R12, R14).** While D2 load runs, take the dump with the real sidecar, run once with `docker compose --profile backup run --rm dump`, so the sidecar, its `dump_ro` role and its secret are tested. The dump is in custom format (`-Fc`, R12; the format is decided, no longer open), named `a2a-<UTC timestamp>.dump`. Verify the file with `pg_restore --list` (the check the sidecar runs before it writes the `last_ok` stamp), restore it with `pg_restore` into a fresh Postgres container and volume of the same pinned image, and check integrity: the restore completes without error, row counts per table match the counts taken at dump time, and the SDK migration CLI reports the restored database at head. This is the same restore test as SP5 D7 for the nightly dump [D-B]. Up to about one day of loss is accepted; WAL archiving and point-in-time restore are not adopted, and a host-installed Postgres is not adopted. In production the nightly dump is written by the same sidecar into `/media/media2/backup/a2a/` on core and collected by a second restic job (R9: its own script, user-crontab line and tag `a2a-dumps`); the schedule, retention, `last_ok`, `dump_age_h`, the role-creation command (`a2a-coord db init-dump-role`, round-4 X2) and the restic job are S1-BKP, S1-PG and S2-DEPLOY work and are not spiked here (the restic path is no longer [unverified]: R9 makes it a new job, checked in S2-DEPLOY).
- **D8, crash.** Under D2 load, `kill -9` the server container and restart it, and separately restart the Postgres container. Check no acked write is lost (acked creates, completions and cancels all present, as SP5 D8 counted them), that tasks left in an "offered" state are re-offered after the server restart, and record how the server's connection pool behaves while Postgres is down and after it returns.

- **Separator check (added 2026-11-09, handle grammar decision `name#sid8`).** Run handles with `#` and with `~` (for example `claude-code@alyx/c6-same#3f2a9c1d` and `claude-code@alyx/c6-same~3f2a9c1d`) through every place a handle travels:
  - URL use: `coord.to` in the JSON-RPC path and in the REST path, and percent-encoding wherever a handle appears in a URL (query strings such as `GET /wake/pending`, a path segment if one is ever used). `#` starts a URL fragment and is never sent to the server unless encoded as `%23`.
  - Shell use: `curl` in the hook scripts (`a2a-register`, `a2a-listen`, `a2a-agy-session`, `a2a-agy-pending`) with and without quoting, and the `a2a_send` tool argument.
  - JSON: the handle as a string value and as an object key, round-tripped.
  - Storage: the handle as a database key (Postgres primary or unique key, `task_index.to_handle`, `sessions.handle`).
  - Pass: `#` works everywhere (with the percent-encoding and quoting rules written down), or `~` is adopted as the separator. Record the choice. If `~` is adopted, the regex, every example and the hook templates in server-api change together; if both fail somewhere, stop and ask the user.
  - **Outcome (SP5b run 2026-11-10; verdict updated by round-4 X1, 2026-11-10):** both separators passed the checks as run, and a raw `#` starts a URL fragment, so an unencoded `curl` URL is silently truncated and `#` needs `%23` in URL queries [verified, SP5b results section 7]. The user adopted `~` on 2026-11-10: the handle is `card/name~sid8` (for example `claude-code@alyx/c6-same~3f2a9c1d`), session part regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`, and `~` is outside the name charset so the split is exact. `@` and `/` stay in the handle: they are legal unencoded in a URL query string (RFC 3986 section 3.4) and handles never appear as URL path segments (they travel in JSON bodies and in query parameters such as `/wake/pending?session=` and `/sessions?handle=`). Prior art: XMPP addresses have the same shape `localpart@domain/resource` (RFC 7622); Matrix identifiers need `%23` for `#`. The unnamed-session form stays [design, open]. The SP2 Claude results file records `#` on the wire and is a historical record, not edited. The SP5b run recorded the old `#` verdict (adopted `name#sid8`), which round-4 X1 supersedes.
  - **D7 note (round-4 X2):** SP5b D7 created `dump_ro` with a Postgres init script. The decision of 2026-11-10 replaces that route: the secret file is mounted only into the sidecar, and the host command `a2a-coord db init-dump-role` (idempotent; run by the installer after Postgres is up and again on rotation) reads the secret on the host and feeds `psql` in the Postgres container over stdin (`docker compose exec -T`): `CREATE ROLE dump_ro LOGIN` if it does not exist, else `ALTER ROLE dump_ro PASSWORD`, then `GRANT pg_read_all_data TO dump_ro`. The D7 role setup therefore has to be retested through the command route (follow-up item (a) below).

Not re-run: D4, D5, D6, D11 and D12 passed on Postgres by URL change in SP5 D10 and are not repeated here [verified]. D9 (filesystem) is retired with SQLite.

### SP5b follow-up (round-4 C4, added 2026-11-10; not gating S1)

Status: **done 2026-11-10** (agy run on alyx, checked independently by Claude Code; [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-10-sp5b-followup.md), section 7 holds Claude Code's check). Verdicts:
- (a) PASS for the mechanism. [verified] by Claude Code: the scratch script matches X2 (SQL over stdin through `docker compose exec -T postgres psql`, `SET log_statement = 'none'`, create the role if missing, `ALTER ROLE ... PASSWORD`, `GRANT pg_read_all_data`); the secret is mounted only into the dump sidecar; a scan of all saved logs for the secret value found 0 files; four more sidecar dumps with 71 `pg_restore --list` entries each. [reported] by agy, no saved log: idempotency over repeated runs, rotation with the old credential rejected, restored row counts (226 of 226 tasks and index, 210 sessions, 223 wakes, orphan tasks 0), the Postgres container log scan. These are covered again by the S1-PG and S1-BKP exit tests.
- (b) PASS. [verified] `logs/separator_tilde_evidence.json`: `~` needs no encoding in a URL query, the shell, the JSON-RPC and REST `coord.to` calls or the database insert and select.
- (c) Cause UNVERIFIED. [verified] the 1,036.82 ms event did not reproduce over 4 consecutive dumps under the 10x load (`transition.versioned` n=1246, p50 6.5 ms, p99 19.5 ms, max 100.27 ms); lock contention and slow queries over 100 ms were ruled out. [unverified] a host-level scheduling pause under WSL2 is agy's guess. No further work unless it recurs.

The S1 entry gate was not open on 2026-11-10 because SP3 and SP4 were open; both are recorded since 2026-11-11 (section 11).

Owner: an agy run on alyx, in the same scratch project style as SP5b. Result file: `docs/research/spike-results-2026-11-10-sp5b-followup.md`. The numbers of the SP5b results file stay as measured.

- **(a) D7 role setup through the command route (X2).** On a fresh volume, on an existing volume and on a password rotation, run `a2a-coord db init-dump-role` (or its scratch equivalent) and then the sidecar with `docker compose --profile backup run --rm dump`: `dump_ro` can log in with the secret that only the sidecar mounts, the dump passes `pg_restore --list`, no init script and no mount of the secret into Postgres exist. [design, open: the exact scratch stand-in for the command before S1 builds it]
- **(b) Separator evidence with `~` (X1).** The same places as the separator check above, with `claude-code@alyx/c6-same~3f2a9c1d`: URL query (no encoding needed), shell (quoted and unquoted), JSON body (value and key), and storage key (`task_index.to_handle`, `sessions.handle`), plus the regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$` against valid and invalid examples.
- **(c) The 1,036.82 ms outlier (C2, optional).** Try to establish the cause of the `CancelTask` at 1,036.82 ms during the D7 dump (`transition.versioned` n=95, p99 = max = 1,036.82 ms in `logs/d7-load.out`). The cause is [unverified]; the earlier `pg_dump` `ACCESS SHARE` lock explanation is not accepted, because `ACCESS SHARE` does not conflict with row-level writes. Record what was found, or that the cause stayed unknown.

### Pass and fail

Same numbers as SP5. Must pass (gate):

- D2: p99 write latency under 200 ms. Zero unhandled database errors in 10 minutes. Event-loop lag under 100 ms. Wake latency p99 under 500 ms with 200 parked listeners. The deadlock count is recorded and expected to be 0 with the seeded version row [design; not a numbered SP5 criterion].
- D3: 0 lost updates and 0 double takes.
- D7: the `-Fc` dump written by the sidecar (backup profile, `dump_ro`) passes `pg_restore --list`, and the `pg_restore` restore passes the integrity check with consistent counts.
- D8: 0 lost acked writes after `kill -9` of the server and after a restart of the Postgres container.
- Separator check: `#` works everywhere in the list above, or `~` is adopted. The choice is recorded either way. (Result: `~` adopted by user decision 2026-11-10, X1; the follow-up (b) repeats the evidence with `~`.)

### Record

- `a2a-sdk` exact version, Python version, the Postgres image tag and digest (R3), `asyncpg` and SQLAlchemy versions.
- The engine and pool configuration that passed.
- A latency table and error counts for D2, including the steady-state own-table writes and the deadlock count.
- The sidecar run, the `dump_ro` role statements, the `pg_restore --list` check and the `pg_restore` command sequence that worked (the dump format is `-Fc`, R12).
- Any SDK behaviour that needs a wrapper of ours.
- The separator check result: per place (URL, shell, JSON, storage) for `#` and `~`, and the separator adopted (`~`, X1).

### Runner

A helper Claude Code session on alyx. No harness session of the user's is involved. Docker, per decision 1.

### Estimated effort

[design] About 0.5 to 1 day (SP5b itself; the follow-up above is not estimated): the drivers and suites are reused from SP5, and SP5 took 1 to 1.5 days. No source gives a figure; revise after the first run.

### What a failure does and fallback

- The engine itself is chosen by the user, so a failure revises the versioned-store wrapper or the Postgres setup (pool settings, seeding, dump procedure), not the engine.
- **Failure rule (R7, decided 2026-11-09):** if SP5b fails its pass criteria, up to two revise-and-rerun cycles (wrapper tuning, isolation level, the seeded version row, a Postgres setting), then stop S1 storage work and ask the user. There is no automatic fallback to SQLite.
- A failure blocks S1 storage tasks and therefore S1 (section 11).
- Lost updates: the wrapper is revised until D3 passes; the plain store and the SQLite compare-and-swap are not options (SP5 D3, D10).
- Deadlocks or high transition p99: check that the version row is seeded in the creation transaction, then revise the wrapper.
- Restore fails: revise the dump procedure (the sidecar, the role grants, the `-Fc` and `pg_restore` sequence); WAL archiving is not adopted [D-B].

## 9. SP6: Claude Code inbox socket from a host helper (optional, later)

### Question

Can the listener (or a separate host helper) deliver the wake stub through Claude Code's per-session inbox socket instead of exit code 2? What are the frame shape, the auth line, and the effect of `crossSessionInbound` and permission modes?

### Why it matters

- Decision 8 names the inbox socket as a later spike candidate. If it works it removes the hook timeout, the Esc gap for the wake itself, and the "Stop hook blocking error" framing.
- It could replace `asyncRewake` as the primary Claude wake, or serve as the fallback if SP1 fails.
- The official page documents the socket and an optional `{"type":"auth","token":...}` line, but the message frame is known only from interlink's source (verified in source, reported as working).

### Method

Reuse the SP1 scratch project and stub. Cross-session messaging needs Claude Code 2.1.224 or later (verified in official docs). Hooks receive `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, including at `SessionStart` (verified in docs); SP1 T10 confirms this on our install.

- **X1, self post.** From the SP1 listener, on a 200, post the interlink-shaped frame to the socket after the auth line, then exit 0. Record whether an idle session starts a turn, with what framing, and the latency.
- **X2, frame shape.** Try the documented auth line alone, then the frame from interlink's source. Record the minimum that works and any acknowledgement the socket returns.
- **X3, `crossSessionInbound`.** Run the session in default, `acceptEdits`, `plan` and `bypassPermissions` modes. Record whether the message is accepted, held for approval or refused in each, and where the setting lives.
- **X4, sender identity.** Check the listener (a child of the hook) is accepted as an "own child". Also try a post from an unrelated host process with the API key to see whether the API key alone is enough.
- **X5, no hook timeout.** Confirm the listener can run past the `asyncRewake` timeout if it is not the thing waking the session (it is not required to exit 2).

### Pass and fail

Optional, outside the gate. It is a candidate for adoption if:

- X1 works in default mode with a latency comparable to SP1,
- X3 shows no hold in the modes the user actually uses,
- the frame shape is stable across two minor versions (re-check on upgrade).

### Record

- Frame shape and auth requirements, with the version tested.
- A table of mode versus accept, hold or refuse.
- Whether the wake appears in the transcript differently from a hook wake.

### Runner

The user starts the session; a helper Claude session runs the stub and reads logs.

### Estimated effort

About 2 h once SP1 is done.

### Fallback if it fails

Stay on `asyncRewake` as shipped under decision 8. No change.

## 10. Ordering and dependencies

Dependencies:

- The shared stub (section 3) comes first. SP1, SP2, SP3 and SP4 all use parts of it.
- SP1 before SP2-Claude, because SP2-Claude reuses the SP1 scratch project, hooks and listener, and the session id seen by the listener must match the one registered with `/sessions`.
- SP2-agy before SP3, because SP3 reuses the same scratch workspace, hooks file and MCP entry, and SP3's `a2a_inbox` call needs the binding result.
- SP4 after SP3, in a separate session and workspace, because it is the one spike that can make an agy session awkward to use.
- SP5 depends on nothing. It can run in parallel with everything else, and should start first because it takes longest and needs no user time.
- SP5b (added 2026-11-09) reuses SP5's load driver and test suites and needs no user time, so it can run in parallel with the user-time spikes. SP5 is already done.
- SP6 after SP1 only. It reuses SP1's hooks and the SP1 T10 variable inventory.

Suggested order:

- Day 1: build the stub, start SP5, run SP1 T1 to T3 and T9 to T10, start the SP1 overnight leg.
- Day 2: finish SP1, run SP2-Claude, continue SP5.
- Day 3: one user session in agy for SP2-agy then SP3 (about 3.5 h of the user's time), then a separate user session for SP4. Finish SP5.
- Later, optional: SP6.

User time needed in total: about one afternoon (agy sessions), plus short sittings to start and Esc the Claude sessions.

## 11. S1 entry gate

S1 (the real server on `127.0.0.1:8120`, API keys, `/mcp`, `/a2a/v1`, `/wake/listen`, `/sessions`, `/status`) may be started once:

- SP1 passed
- SP2 passed
- SP3 passed, or failed with the section 6 fallback (agy hook dropped) recorded
- SP5b passed (the SP5 rerun on Postgres, D-D)
- SP4 recorded
- the results file is written and linked from the master tasklist

Gate status (2026-11-11): the S1 entry gate is **satisfied on SP1 to SP5b**. SP3 (gate items P1, P3, P4, P5 passed) and SP4 (K1 to K6 recorded, non-gating) were run on 2026-11-10 and 2026-11-11 and are recorded in [results](../research/spike-results-2026-11-10-sp3-sp4.md); SP5b satisfied the storage part on 2026-11-10. This replaces the round-4 C1 wording of 2026-11-10 ("NOT satisfied, SP3 and SP4 still open"), which was correct on that date. What is still needed before S1 starts: the user's go for the S1 kickoff. The attended tests (`asyncRewake` on `UserPromptSubmit`, the GUI-launched Claude test) run inside S1 with their own exit tests, and A8c does not block S1, so none of them is an S1-entry blocker. The earlier withdrawal of the "S0 complete" wording stands: the non-gating SP5b follow-up and A8c stay open.

- SP1: **passed** (decision 8 go), [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-05-sp1.md).
- SP2: Claude half **passed with spec changes** ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-06-sp2-claude.md)); agy A1, A4 identity and A6 passed (2026-11-04); agy A2, A4 compliance (10 of 10) and A7 (180 s) **passed**, A3 and A5 **recorded** (2026-11-08, [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-08-sp2-agy.md)); A8 **passed with the unique-name caveat** after A8b (2026-11-09, [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-09-a8b-agy.md)). SP2 is **passed**.
- SP3: **passed** (2026-11-10, [results](../research/spike-results-2026-11-10-sp3-sp4.md)). Gate items: P1 5 of 5 trials, P3 p50 28 ms and p95 33 ms over 186 runs, P4 dedupe rule works (announce sequence `[2, 3, 2]`), P5 all 6 failure modes fail open [verified]. Record-only items P1b, P1r, P2, P6, P7 and P8 are recorded. Findings that bear on the shipped hook: `systemMessage` is the tested injection type (the `ephemeralMessage` text appears not to persist across turns, [inferred], one sample); a down server costs about 1.03 s at `--connect-timeout 1`; agy does not kill a hook that outlives its timeout. Decision 26 is supported for trusted workspaces; an untrusted workspace past the trust dialog is [unverified].
- SP4: **recorded** (2026-11-10 and 2026-11-11, non-gating, [results](../research/spike-results-2026-11-10-sp3-sp4.md)). K1 to K6 have observed answers [verified unless marked in the step bullets]: `Stop` fires once per user turn; typing is queued; `continue` restarts a turn and is capped at 10; agy released the UI at about 60 s on `timeout: 30` and did not kill the hook; Esc, Ctrl-C and `/exit` leave the park script running as an orphan; a finished background command wakes an idle agy (K6 yes). The results file's reading is "usable with serious caveats at best"; nothing ships on SP4 without a user decision. SP4 was not MCP-free: the user-level `sp3coord` plugin was installed.
- SP5 (SQLite): **passed with four wrappers** ([results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-05-sp5.md)); one defect to fix in S1 (session id bound to the API key). Recorded as passed, **not gating** since the user chose Postgres on 2026-11-09 (D-A, D-D).
- SP5b (Postgres): **passed** (2026-11-10, [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-10-sp5b.md)). All gates met: 0 lost updates, 0 lost acked writes, p99 write 17-18 ms on D2 (the 200 ms gate was evaluated on D2 only), backup sidecar (-Fc, dump_ro) verified with 100% restore match and Alembic at head, 0 deadlocks with SEED_VERSION=1 (inferred from an empty `db_errors` count; no separate deadlock counter in the logs, C3), separator check run for `#` and `~` (verdict updated by round-4 X1: `~` adopted, `#` needs `%23`). One 1,036.82 ms `CancelTask` outlier during the D7 dump has an unverified cause (C2). This satisfies the storage part of the gate only. Follow-up (not gating S1): section 8b, SP5b follow-up.
- Moved inside S1 (D-D), not before it, each with its own exit test [design, details open until S1 starts]:
  - `asyncRewake` on a `UserPromptSubmit` command hook (the re-arm after Esc, added by SP1). Exit test: after Esc during a turn, a task created for the session's handle wakes the idle session again, within the wake latency SP1 recorded.
  - The GUI-launched Claude test (decision 34). Exit test: a Claude Code session launched from the GUI registers, binds with `a2a_hello`, and its MCP calls carry the API key by the route decision 34 chose, with C9's record of what a GUI-launched session sees in its environment.

Definitions:

- **Passed**: every "must pass" criterion of that spike is met on alyx, with logs in the results file. "Record only" items are written down but do not block.
- **Recorded**: every question the spike asked has an observed answer in the results file, whichever way it went. SP4 never blocks S1 by failing.
- **Failed with fallback**: a spike whose fallback is listed as safe above counts as passed once the fallback itself is stated in the spec and, where the section says so, confirmed by the user.

What a failure does:

- SP1 T1 failure changes decision 8 for Claude Code. It stops S1 until the user decides (promote SP6, or accept the agy-style asymmetry for both).
- SP2 failure for one harness reopens decision 6 for that harness only. Card-level addressing remains.
- SP2 A6 failure (agy cannot send a bearer header) stops S1 until the user decides between decisions 9 and 11 for agy.
- SP1 T11 failure falls back to a command hook for `UserPromptSubmit`. With that fallback recorded in the spec it counts as passed ("failed with fallback"), so it does not block S1.
- SP3 failure removes the agy hook from the plan. It does not block S1 (the `SessionStart` `injectSteps` instruction, `a2a_inbox` and `a2a_wait` remain).
- SP5b failure revises the versioned-store wrapper or the Postgres setup and blocks S1 storage tasks. The engine is already Postgres by the user's choice (2026-11-09), so no engine confirmation is pending. An SP5 (SQLite) result no longer gates. Rule (R7): up to two revise-and-rerun cycles (wrapper tuning, isolation level, the seeded version row, a Postgres setting), then S1 storage work stops and the user is asked; no automatic fallback to SQLite.

What the gate does not cover (these are gates of later stages, not S1):

- S2 (tailnet): API keys and scopes live, cross-host wake works, the tailnet identity check of decision 17 (section 13), and, new by R8 (2026-11-09), the public-listener tests on the 8121 listener that the server runs on core's loopback from stage `s2` (L6, section 13): bound to loopback only, remote-peer keys only, only `/a2a/v1` and the public Agent Card, uniform "not available" handle errors with the guess counter (R1, R10; round-4 X3: the counter covers handle-addressed sends only, card-addressed sends stay under the per-key `SendMessage` limit of 10 per minute), per-key rate limits and the fuzz pass. The dump sidecar has run under `COMPOSE_PROFILES=backup` (R14) and `dump_age_h` shows in `/status` (R4, R5), and the second restic job (R9, X4) has collected a dump. The version check on mac and core happens here.
- S3 (public HTTPS, the Cloudflare Tunnel on core, decision 20): quarantine live, rate limits and the fuzz pass (tested against the 8121 listener in S2 and still green), an honest card, an explicit user go, and the tunnel checks in section 13. The route is the exposure gate and is created only at the S3 go (R8). The stage flip to `A2A_EXPOSURE_STAGE=s3` is a deliberate human step before the route (R13, 2026-11-09): the user runs the read-only `a2a-coord expose check` (exit 0 all conditions met, 1 at least one unmet with an itemised report, 2 could not evaluate; round-4 X5: the server checks quarantine for remote-peer keys, per-key rate limits and the guess counter, `dump_age_h` below 36 h and port 8121 bound to host loopback only, and lists the fuzz report, the honest card and the extension URI as manual items until S3, [design], task S3-EXPOSE-CHECK), sets `A2A_EXPOSURE_STAGE=s3` and the public host in the compose environment and restarts the stack, the server's `s3` start-up checks refuse to start if a condition fails, and only then the user creates the route to `127.0.0.1:8121`; there is no runtime admin command for it. Listener facts decided 2026-11-09 (D-F, R8): the tunnel targets a dedicated loopback port 8121, which the server treats as the public listener (remote-peer keys only, only `/a2a/v1` and the public Agent Card, `CF-Connecting-IP` trusted only on that port) and which runs from stage `s2`, bound to `127.0.0.1:8121`; port 8120 stays tailnet-only (`tailscale serve`, local-harness keys). The final extension URI must be chosen and published before the public card goes live (L5, D-J).
- The cognitive-engine status client (decision 13): built after S1 on the user's go.

## 12. Open points not resolved by the evidence

- Where agy reads MCP server entries from for a workspace-scoped test. `~/.gemini/config/mcp_config.json` exists on alyx (verified by listing the directory, content not read), and the plugin layout `.agents/plugins/<name>/mcp_config.json` is reported by zb-ss. Which form accepts `url` (legacy `serverUrl`) for a scratch workspace is unverified; the A6 run found standalone `.agents/mcp_config.json` undocumented and workspace MCP supported only inside plugin bundles (reported).
- Whether the user's existing Lookup server runs stateful or stateless MCP over HTTP. Recall is stateless (verified in compose); Lookup is not in the evidence.
- Where Claude Code gets a human session name for `claude-code@alyx/<name>~<sid8>`. Answered by SP2 C1: `session_title` on `SessionStart` stdin when a name is set. For an unnamed session the form is [design, open] (server-api 3.5).
- The exact `DatabaseTaskStore` constructor, extras names and migration CLI invocation. The audit lists them only by name; SP5 reads the source first.
- The real `asyncRewake` timeout ceiling. The JS timer limit of about 2,147,483 s was verified in zb-ss source; whether Claude Code applies it to hooks is unverified until SP1 T4.
- Whether the SP5 workload size (10 times a realistic rate) is realistic. The realistic rate is itself a guess (a handful of sessions, tasks per minute); revisit if S2 adds more machines.

## 13. Later-stage checks (not part of the S1 gate)

Decisions 17, 20 and 23 (2026-11-04) rest on mechanisms nobody has tested. They gate S2 and S3, not S1, so they are not SP-numbered spikes inside the S0 plan. They run when the stage starts, in scratch, with the same ground rules as section 1. In production the service runs on core (decision 23), so these checks run against a stub on core. All are **unverified** today.

- **L1, tailnet identity at the server (S2, decisions 17 and 23).** Question: what identity does a request carry when it reaches the server through `tailscale serve` on core, and can the server tell the user's machines apart, alyx included?
  - Method: stub behind `tailscale serve` on core, called from alyx and mac. Log every header and the source address. Record whether a user login header is present (`Tailscale-User-Login` is reported for `tailscale serve`; not read by us), whether any node identity is available, and whether a source-address lookup (the local Tailscale API on core) returns the node name.
  - Pass: the server can bind an API key to one machine (a node name), or the user accepts a user-level check instead. If only a user login is available, the check cannot distinguish alyx from mac, and decision 17 needs the user's input before S2.
  - Also record: which header names a client can forge when it reaches the server some other way (it must not be able to).
- **L2, `CF-Connecting-IP` from `cloudflared` on the same host (S3, decisions 20 and 23).** Question: does the real client address reach the server, and can the server believe it only for tunnel traffic when `tailscale serve` traffic also arrives from core's loopback?
  - Precondition: no route exists now (plan Risk 13). The 8121 listener already runs on core's loopback from stage `s2` (R8) and is tested there without a route (L6); only the real `cloudflared` path needs the route. This check runs at S3 only, after the stage flip (R13: `a2a-coord expose check` exits zero, `A2A_EXPOSURE_STAGE=s3` is set and the stack restarted, the `s3` start-up checks pass) and after the user creates the route on his explicit go (the route is the exposure gate). If a route is created earlier just for this test, it sits behind a Cloudflare Access deny-all or service-token-only policy (the test uses a Cloudflare Access service token) and the stub, not the real service, listens behind it.
  - Method: point the route `a2a.bigrockad.com` at the stub on core. Record the `Host` the stub sees, the `CF-Connecting-IP` it receives, and the TCP peer. Send the same request through `tailscale serve` with a forged `CF-Connecting-IP` and with `Host: a2a.bigrockad.com`, and record what the stub can use to tell the two paths apart. Repeat with the route pointed at the dedicated loopback port (`localhost:8121`), which the user decided on 2026-11-09 (D-F): the server treats 8121 as the public listener (remote-peer keys only, only `/a2a/v1` and the public Agent Card, `CF-Connecting-IP` trusted only on that port), and 8120 stays tailnet-only. The Host-based `A2A_TUNNEL_HOSTS` design is no longer the plan; it is kept only as a rejected alternative.
  - Pass: `CF-Connecting-IP` arrives from `cloudflared` as the real client address, and the server can believe it only for tunnel traffic, by listener port 8121 (no forged-header weakness). The Host-based path is not a fallback any more; if the port design does not work well enough, fall back to per-key limits only.
- **L3, Cloudflare timeout and path routing (S3, decisions 20 and 22).** Question: what is the real request timeout on the user's plan, and can the ingress rule restrict paths?
  - Method: a stub endpoint that holds a request for 30, 60, 90 and 120 s; a request to a path outside `/a2a/v1` and the card.
  - Pass: a 60 s hold succeeds, the observed limit is recorded (about 100 s is reported), and the unrouted path is refused by the ingress or by the server (`404`).
- **L4, wake over the tailnet (S2, decision 23).** Question: what wake latency and failure behaviour does a long-poll from alyx or mac to core show over Tailscale?
  - Method: the SP1 listener against a stub on core. Record time from task creation to the wake line, behaviour across a tailnet interruption (kill the link for 30 s and 5 min), and whether 900 s rounds survive idle NAT or relay paths.
  - Pass: latency recorded; after an interruption the listener re-parks without a loop (plan Risk 12).
- **L5, final extension URI (S3 gate item, D-J).** Question: which URI identifies the coordination extension on the public Agent Card?
  - Today: the placeholder `urn:agentic-hub:coordination:v1` stays through S1 and S2. Open point 13 of server-api.md stays open until S3 and is assigned to this gate.
  - Check: the final URI is chosen and published before the public card goes live, and the card, the server and the docs all use it. Where it is published and whether it must resolve are [design, open].
  - Pass: the public Agent Card carries the final URI and no placeholder remains in anything served on 8121.
- **L6, public-listener tests on core's loopback (S2 gate, R1 and R8).** Question: with the 8121 listener running on `127.0.0.1:8121` from stage `s2` and no route, do the remote-peer rules hold?
  - Method: a scripted `remote-peer` test peer and a `local-harness` key against `127.0.0.1:8121` on core, and the fuzz harness, sending `Host: 127.0.0.1:8121` (R13 default); no route is created.
  - Pass: 8121 is bound to loopback only; a `local-harness` key gets 403 there; only `/a2a/v1` and the public Agent Card are served (other paths 404 with no body); a forged `CF-Connecting-IP` on 8120 is ignored; a handle that exists inside a card in the key's `cards_allowed` yields a held task while an unknown, ended or disallowed handle returns the same "not available" task (same error class and response shape); 10 "not available" responses within 60 s from one key trip the per-key guess counter (R10), after which a handle-addressed `SendMessage` from that key gets `429` with `Retry-After: 60`, one `handle_probe_limited` audit row is written per trip with `key_id` and `window_count`, and the counter clears by itself after 60 s without further misses; the counter covers handle-addressed sends only (round-4 X3): a card-addressed send to an unknown or disallowed card is `403 CardNotAllowed`, is not counted and stays under the per-key `SendMessage` limit of 10 per minute; per-key rate limits apply; the fuzz pass has no unexplained 5xx or hang. The sbx isolation test covers ports 8120 and 8121.
- **Hostname:** `a2a.bigrockad.com` is the chosen S3 hostname. No route exists now: the user created one on 2026-11-04 and deleted it the same day. L2 and L3 run at S3, when the user creates the route on his explicit go (plan Risk 13).
