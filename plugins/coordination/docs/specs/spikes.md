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
- **No change to the user's real configuration.** Hooks go in a scratch project's own settings (`.claude/settings.local.json` for Claude Code, `.agents/hooks.json` for agy in a scratch workspace). The user-level files `~/.claude/settings.json`, `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json` are not touched. If agy turns out to need a user-level MCP entry for a spike, the user adds it and removes it, and that is stated in the result.
- **Spike port `18120`, loopback only**, so a spike never collides with the future `:8120`, with 8100 to 8110, or with 11434. The stub accepts one fixed throwaway token (`spike-token`) and never a real credential.
- **Nothing launches, drives or wraps agy** (DDR-003). Every agy spike is run by the user in their own interactive agy session, or by agy itself inside that session at the user's request. No `agy -p`, no PTY, no tmux, no `agentapi`. A Claude Code session may prepare files and read logs for an agy spike; it never starts agy.
- **Claude Code test sessions are started by the user** in a terminal tab, interactive CLI only. No `claude -p`, no PTY driver. A helper session may run the stub and tail its logs.
- **Decision 9 already approves shipping the agy `SessionStart` and `PreInvocation` hooks.** Spikes install them only in a scratch workspace; the user applies them to real config (host-hygiene rule). Only the held-`Stop` park (SP4) needs a further user decision before it could ship.
- **Cheap models, small budgets.** Test sessions run on the cheapest model that exercises the behaviour (`haiku` for Claude Code). Check the 5h and 7d quota first. Every stub that can wake a session has a hard wake budget (default 12 per hour) and a kill file.
- **Spikes execute later, on the user's go.** A spike's scratch environment may need a `uv`-managed virtualenv in its scratch directory (SP5 needs `a2a-sdk`). That is a scratch install, never a system or repo install, and it is created only when the spike runs.
- **Spike ids.** This file defines SP1 to SP6 and their test ids (for example T11, A6, D11). Other documents refer to spikes by these ids only. The older names used in server-api.md section 12.1 are mapped in the table in section 2.1.
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
| SP5 | Does `DatabaseTaskStore` on SQLite hold up under our single-process mix of traffic? | 4 | helper session | about 1 to 1.5 days | must pass |
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

- Per-session addressing (`claude-code@alyx/<session-name>`) is the core of decision 6. Without binding, only card-level addressing (newest live listener) is possible.
- The wake listener knows the harness session id from hook stdin. The MCP side knows only `Mcp-Session-Id`. The handle is the only join key, and it travels through the model.

### Method, Claude Code half

Uses the shared stub and the SP1 scratch project, with the stub registered as an MCP server (streamable HTTP, `http://127.0.0.1:18120/mcp`) in the scratch project's own MCP config.

- **C1, stdin and context.** In the `SessionStart` hook, log the full stdin JSON (all keys). Record whether any session name exists there or in the environment. Return `additionalContext` carrying a proposed handle `claude-code@alyx/<name-or-short-id>` and the instruction to call `a2a_hello`. Ask the model to quote its context to confirm it arrived.
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
- **C7, hook order (HOOK-ORDER).** Configure two `SessionStart` hooks, the registration hook (`POST /sessions`, with a deliberate 2 s delay in variant B) and the `asyncRewake` listener. Over 10 session starts, log the start and end timestamps of each from the stub. Record whether they run in parallel or in listed order, and how often the listener's first `/wake/listen` reaches the stub before the registration does (this decides whether the 15 s retry on `410 unregistered` in server-api.md 7.1 is needed).
- **C8, MCP tool timeout (MCP-TOOL-TIMEOUT).** The model calls the stub's blocking `a2a_wait(seconds)` with 30, 120 and 240 s. Record for each whether the result arrives, whether progress or an error is shown, whether the connection or the session survives a timeout, and the effective limit if one is hit. Also check whether an `MCP_TOOL_TIMEOUT`-style setting exists in the installed version's docs.

### Method, agy half (run in the user's own session)

The user opens their own interactive agy in a scratch trusted workspace. Files are prepared by a helper session beforehand: a scratch `.agents/hooks.json` (the CLI reads it, verified in t1b section 4) and the stub MCP entry. agy's own MCP config location for a workspace-scoped entry is not in the evidence (see open points); if only the user-level `mcp_config.json` works, the user adds the entry for the test and removes it after.

- **A1, session id.** After agy calls any stub tool, read the stub log. Record whether an `Mcp-Session-Id` is issued and echoed back, how many MCP connections agy opens (per process, per conversation, per call), `clientInfo`, and whether any `_meta` or header carries the conversation id.
  - **Partially answered 2026-11-04** (by the A6 run, [results](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a6.md)): `Mcp-Session-Id` is process-scoped in agy (one client session shared across conversations in the same process) [verified, one run]. Every observed `tools/call` carried `params._meta["antigravity.google/conversation_id"]`, plus `antigravity.google/root_conversation_id` and `antigravity.google/artifacts_dir` [verified on one call]. Still pending the follow-up pass: presence on every call, per-conversation distinctness with two conversations in one process, and stability across resume. Consequence for binding: server-api.md 5.4.
- **A2, injectSteps.** A `SessionStart` hook logs its stdin (`conversationId`, `workspacePaths` and others) and returns `injectSteps` with the handle and the `a2a_hello` instruction. Try each item type that is documented (`systemMessage`, `userMessage`, `ephemeralMessage`). Record which the model sees, and whether it is still visible five turns later.
- **A3, resume.** Quit and resume the same conversation. Record whether `SessionStart` fires again and whether the handle is still in context.
- **A4, compliance and multi-conversation.** Same 10-session count as C5. Open a second conversation in the same agy process if the product allows it, and record whether it shares the MCP connection (which would make binding per process, not per conversation).
- **A5, trust gate.** Confirm the hook runs only in the trusted scratch workspace (reported by zb-ss), and record what happens in an untrusted one.
- **A6, Authorization header.** Evidence gathered 2026-11-04 (Claude Code, read-only):
  - verified: agy 1.5.0 `agy mcp add --help` documents `--header "Authorization: Bearer TOKEN"` (repeatable `-H/--header`) for http servers
  - verified: the user's `~/.gemini/config/mcp_config.json` already has an entry (`obsidian`) with `serverUrl` plus a `headers` object holding an `Authorization` key (key names checked only, value not read)
  - reported: third-party guides show the same `serverUrl` + `headers` shape and say `httpUrl` is the older key
  - verified: agy's `mcp_servers.md` (line 66) documents `url` as the key and says the legacy key `serverUrl` is also accepted; examples in this plan use `url`. The `obsidian` entry above predates that and uses `serverUrl`.
  - still unverified, and what this step now tests: that the header is sent on every request of a streamable-HTTP session; whether `headers` values support environment-variable interpolation (otherwise the token sits in plain text in `mcp_config.json`, as obsidian's does today); and whether agy's `/mcp` view shows a 401 clearly
  Why the interpolation answer matters beyond the spike (decision 16): the installer `a2a-coord install --claude --agy` writes this entry through chezmoi, and chezmoi source is committed to the dotfiles repository. `~/.gemini/config/mcp_config.json` is managed as the template `private_mcp_config.json.tmpl` (verified with `chezmoi source-path` on 2026-11-04, contents not read). If interpolation worked, the entry would hold only `Bearer ${A2A_TOKEN}`. It does not (see the Result below, reported, live confirmation pending), so the token is a literal in the rendered file. Rule: the installer writes it through a chezmoi template function that reads a secret source (password manager, keyring or an encrypted file), never as a literal in the chezmoi source repository. The choice of secret backend is an open point for the user (plan section 7). The installer itself is not part of any spike and does not exist yet.
  Configure the stub entry with `agy mcp add --header "Authorization: Bearer spike-token" a2a-stub http://127.0.0.1:<stub-port>/mcp`, or edit `mcp_config.json` with the same `headers` shape. Also try a value of `Bearer ${A2A_TOKEN}` with `A2A_TOKEN` exported in the agy session's environment, and record whether it is expanded. The stub rejects any `/mcp` request lacking `Authorization: Bearer spike-token` with 401. Record that agy sends the header on every request (`initialize`, `tools/list`, `tools/call`, session-closing `DELETE`), and what agy shows the user and the model on a 401 (run once with the header removed). If agy cannot send a custom header, record that decisions 9 and 11 conflict for agy and stop: the plan needs a user decision. A token in the URL is not an acceptable fallback.
  - **Result (2026-11-04): PASS** per Antigravity's run, [`spike-results-2026-11-04-sp2-a6.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-04-sp2-a6.md). agy sent `Authorization: Bearer spike-token` on every request that reached the stub after the first probe: server discover, `initialize`, the `GET` SSE stream, `notifications/*`, `tools/list`, `tools/call` and the closing `DELETE` [verified, wire log]; a request without the header got 401.
  - Claude Code's review of that report, which qualifies it:
    - Q1 is overstated: agy's `mcp_servers.md` documents `url` as the key (`serverUrl` legacy) and does not mention `headers`. Header support is documented only in `agy mcp add --help`; the `McpServerSpec` struct names come from binary strings, not documentation.
    - Q3 ("sent literally", no env expansion) is not shown in the wire log. A follow-up live run with `Bearer ${A2A_TOKEN}` exported was requested. Until then it is reported, not verified.
    - The origin of the first unauthenticated `ping` in the wire log is unclear (agy probe, or the stub's own check).
  - Hard-gate status: the header gate is met on the evidence of the wire log. The env-var and documentation caveats do not change the gate.
- **A7, MCP tool timeout.** Same as C8 for agy: blocking `a2a_wait(seconds)` at 30, 120 and 240 s. Record the result, any error shown, and the effective limit.

### Pass and fail

Must pass (gate):

- Claude Code: C1 and C2 pass (handle arrives in context; one stable `Mcp-Session-Id` per session across at least 5 calls). C3 either keeps the binding across `/compact` and resume, or shows a clean way to re-bind (the unbound-call error). C5: at least 8 of 10 bind unprompted and 10 of 10 bind after the error message.
- agy: A1 shows a stable per-connection id, or a documented fallback is chosen (below). A2 shows at least one injectSteps type reaches the model and the model calls `a2a_hello`. A4: at least 8 of 10 bind after the injected instruction or the error message.
- agy A6: agy sends the configured `Authorization: Bearer` header on every `/mcp` request, and a request without it is refused with 401. This is a hard gate: if it fails, decision 9 (agy uses MCP at `:8120/mcp`) and decision 11 (loopback still needs a token) cannot both hold, and S1 does not start until the user decides.
- Binding is unambiguous: two concurrent sessions never share a binding (C6).
- C7: the result states whether the two `SessionStart` hooks run in parallel or in order, so the listener retry rule is either kept or removed on evidence.
- C8 and A7: the effective MCP tool timeout is recorded for both harnesses and `a2a_wait`'s default is shown to sit inside it (or lowered to fit).

Record only: A3 resume behaviour, C4 restart behaviour, A5 trust behaviour, session-name availability.

### Record

- The full hook stdin keys for both harnesses (keys and example shapes, no secrets).
- The `Mcp-Session-Id` lifecycle table per event.
- The count for C5 and A4.
- The A6 header result, the C7 ordering result and the C8 and A7 timeout limits.
- A statement that binding is an assertion by a token holder, not authentication of a particular session. Every holder of a local-harness token can claim any local handle; the spec has to say that this is accepted.

### Runner

- Claude half: user starts sessions; helper runs the stub and reads logs.
- agy half: the user, or agy inside that session at the user's request. Nothing else may start or touch agy.

### Estimated effort

- Claude half: about 1 day including the 10-session compliance runs (they are short).
- agy half: about 2 h, mostly the user's time.

### Fallback if it fails

- Handle name not available from the harness: use `<card>/<first 8 chars of the session id>` and let `a2a_hello(handle, name=...)` set a readable alias.
- `Mcp-Session-Id` not stable or not sent (agy): carry the handle explicitly in every write tool (`as_handle`), validated server-side against `/sessions`, and keep the hook-injected handle in context. Read tools stay unbound.
- Injected handle not seen by the model: put the handle in the always-loaded `AGENTS.md` rule instead (a rule that says "call `a2a_hello`; your handle is returned by the `/sessions` registration, read it from the error text").
- A6 fails (agy cannot send a custom `Authorization` header): no safe in-plan fallback. Options for the user:
  - a separate loopback-only MCP shim that adds the header (it does not launch or wrap agy, so DDR-003 is untouched), evaluated as a candidate
  - agy gets no `/mcp` and relies on the hooks and the `AGENTS.md` rule alone

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
- **P2, frequency.** Log every hook invocation. Record how often `PreInvocation` fires per user turn (once, or after every tool call), and whether it fires on the first model call of a conversation.
- **P3, latency.** Record per-invocation hook duration from the hook's own timestamps. Record the visible delay added to a turn compared with a no-hook turn.
- **P4, persistence and noise.** Check whether an `ephemeralMessage` survives into later model calls or vanishes after one. With a per-conversation state file in the hook (announce only when the count changed), confirm the model is not told the same thing on every call.
- **P5, failure behaviour**, one at a time, with the model asked to do a trivial task each time:
  - hook exits non-zero
  - hook prints invalid JSON
  - hook prints nothing
  - hook sleeps longer than its `timeout` (use `timeout: 5`)
  - server down (connection refused)
  - hook exits 2
  Record for each: does the model call still happen, does the user see an error, is the turn blocked.
- **P6, timeout setting.** Confirm the 30 s default by running a 35 s sleep once with no `timeout` set. Record what happens.
- **P7, stub text.** Check that the wake wording is understood and not mistaken for an instruction from the user. Record the verbatim model reply.

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
- A failure mode blocks the turn and cannot be avoided: do not ship the hook; agy gets the `AGENTS.md` rule to check the inbox at session start, the `a2a_inbox` tool and `a2a_wait`. The asymmetry grows but nothing breaks.

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
- **K2, typing.** While the hook is parked, try to type, submit a message, press Esc and Ctrl-C. Record what the interface shows and whether input is queued, lost or blocked.
- **K3, release.** Release the hook with `{"decision":"continue","reason":"[a2a] N pending. Call a2a_inbox."}`. Record whether a new turn starts, how the reason is shown to the model, and whether repeated continues are capped.
- **K4, timeout.** At each timeout setting let the hook expire. Record what happens (kill, error text, session state) and the largest `timeout` accepted. Record whether the park child process is also killed or is orphaned.
- **K5, interruption.** Press Ctrl-C and Esc while parked, and quit agy while parked. Check for orphaned processes afterwards (`pgrep -f spike-stop-park`).
- **K6, background command.** Ask agy to run `sleep 60; echo done` as a background command through its own shell tool. Then leave it idle. Record whether the command finishing starts a turn.

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

### Question

Does `a2a-python` (1.3.0 or later) with `DatabaseTaskStore` on SQLite hold up under the traffic of one server process that serves MCP, A2A and the wake long-poll together, with WAL and a busy timeout that we configure ourselves? Do migrations, backups and crash recovery behave?

### Why it matters

- Decision 4 puts all state in one SQLite file owned by one process, with the promise that Postgres is "a SQLAlchemy URL change" later.
- The audit verified there is no WAL, busy-timeout or `PRAGMA` handling anywhere in the SDK (t1c), and that cluster mode is only about five weeks old. We are choosing not to depend on cluster mode, so the plain store must be shown sufficient.
- Our own tables (sessions, tokens hashes, wake budgets, quarantine records) sit in the same file, and we need to know they coexist with the SDK's migrations.

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
- **D5, owner scoping.** Using the SDK's owner resolver, check that a task created under one token's owner is invisible to another token through `GetTask`, `ListTasks` and `CancelTask`. This is what keeps a remote-peer token from reading local tasks.
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
- SQLite itself unfit: use Postgres in compose from S1. This would change decision 4 only in the starting engine and needs the user's confirmation.

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
- **X4, sender identity.** Check the listener (a child of the hook) is accepted as an "own child". Also try a post from an unrelated host process with the token to see whether the token alone is enough.
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
- SP6 after SP1 only. It reuses SP1's hooks and the SP1 T10 variable inventory.

Suggested order:

- Day 1: build the stub, start SP5, run SP1 T1 to T3 and T9 to T10, start the SP1 overnight leg.
- Day 2: finish SP1, run SP2-Claude, continue SP5.
- Day 3: one user session in agy for SP2-agy then SP3 (about 3.5 h of the user's time), then a separate user session for SP4. Finish SP5.
- Later, optional: SP6.

User time needed in total: about one afternoon (agy sessions), plus short sittings to start and Esc the Claude sessions.

## 11. S1 entry gate

S1 (the real server on `127.0.0.1:8120`, tokens, `/mcp`, `/a2a/v1`, `/wake/listen`, `/sessions`, `/status`) may be started once:

- SP1 passed
- SP2 passed
- SP3 passed, or failed with the section 6 fallback (agy hook dropped) recorded
- SP5 passed
- SP4 recorded
- the results file is written and linked from the master tasklist

Definitions:

- **Passed**: every "must pass" criterion of that spike is met on alyx, with logs in the results file. "Record only" items are written down but do not block.
- **Recorded**: every question the spike asked has an observed answer in the results file, whichever way it went. SP4 never blocks S1 by failing.
- **Failed with fallback**: a spike whose fallback is listed as safe above counts as passed once the fallback itself is stated in the spec and, where the section says so, confirmed by the user.

What a failure does:

- SP1 T1 failure changes decision 8 for Claude Code. It stops S1 until the user decides (promote SP6, or accept the agy-style asymmetry for both).
- SP2 failure for one harness reopens decision 6 for that harness only. Card-level addressing remains.
- SP2 A6 failure (agy cannot send a bearer header) stops S1 until the user decides between decisions 9 and 11 for agy.
- SP1 T11 failure falls back to a command hook for `UserPromptSubmit`. With that fallback recorded in the spec it counts as passed ("failed with fallback"), so it does not block S1.
- SP3 failure removes the agy hook from the plan. It does not block S1 (the `AGENTS.md` rule, `a2a_inbox` and `a2a_wait` remain).
- SP5 failure picks the listed fallback. Moving the starting engine to Postgres needs the user's confirmation.

What the gate does not cover (these are gates of later stages, not S1):

- S2 (tailnet): tokens and scopes live, cross-host wake works, and the tailnet identity check of decision 17 (section 13). The version check on mac and core happens here.
- S3 (public HTTPS, the Cloudflare Tunnel on core, decision 20): quarantine live, rate limits, the fuzz pass, an honest card, an explicit user go, and the tunnel checks in section 13.
- The cognitive-engine status client (decision 13): built after S1 on the user's go.

## 12. Open points not resolved by the evidence

- Where agy reads MCP server entries from for a workspace-scoped test. `~/.gemini/config/mcp_config.json` exists on alyx (verified by listing the directory, content not read), and the plugin layout `.agents/plugins/<name>/mcp_config.json` is reported by zb-ss. Which form accepts `url` (legacy `serverUrl`) for a scratch workspace is unverified; the A6 run found standalone `.agents/mcp_config.json` undocumented and workspace MCP supported only inside plugin bundles (reported).
- Whether the user's existing Lookup server runs stateful or stateless MCP over HTTP. Recall is stateless (verified in compose); Lookup is not in the evidence.
- Where Claude Code gets a human session name for `claude-code@alyx/<session-name>`. SP2 C1 records what hook input contains; the fallback is a short session-id suffix.
- The exact `DatabaseTaskStore` constructor, extras names and migration CLI invocation. The audit lists them only by name; SP5 reads the source first.
- The real `asyncRewake` timeout ceiling. The JS timer limit of about 2,147,483 s was verified in zb-ss source; whether Claude Code applies it to hooks is unverified until SP1 T4.
- Whether the SP5 workload size (10 times a realistic rate) is realistic. The realistic rate is itself a guess (a handful of sessions, tasks per minute); revisit if S2 adds more machines.

## 13. Later-stage checks (not part of the S1 gate)

Decisions 17 and 20 (2026-11-04, `/cplain`) rest on mechanisms nobody has tested. They gate S2 and S3, not S1, so they are not SP-numbered spikes inside the S0 plan. They run when the stage starts, in scratch, with the same ground rules as section 1. All are **unverified** today.

- **L1, tailnet identity at the server (S2, decision 17).** Question: what identity does a request carry when it reaches the server through `tailscale serve`, and can the server tell the user's machines apart?
  - Method: stub behind `tailscale serve` on alyx, called from mac and core. Log every header and the source address. Record whether a user login header is present (`Tailscale-User-Login` is reported for `tailscale serve`; not read by us), whether any node identity is available, and whether a source-address lookup (the local Tailscale API) returns the node name.
  - Pass: the server can bind a token to one machine (a node name), or the user accepts a user-level check instead. If only a user login is available, the check cannot distinguish mac from core, and decision 17 needs the user's input before S2.
  - Also record: which header names a client can forge when it reaches the server some other way (it must not be able to).
- **L2, `CF-Connecting-IP` through the tunnel (S3, decision 20).** Question: does the real client address reach the server, and can the server trust it only for tunnel traffic?
  - Method: a scratch cloudflared ingress rule (the user adds it) to the stub over the tailnet. Record the `Host` the stub sees, whether `CF-Connecting-IP` arrives unchanged after the `tailscale serve` hop, and what the stub sees as the TCP peer.
  - Pass: `CF-Connecting-IP` arrives unchanged, and the tunnel's node identity (from L1) lets the server believe it only for tunnel traffic. Otherwise per-IP limits fall back to the token only.
- **L3, Cloudflare timeout and path routing (S3, decisions 20 and 22).** Question: what is the real request timeout on the user's plan, and can the ingress rule restrict paths?
  - Method: a stub endpoint that holds a request for 30, 60, 90 and 120 s; a request to a path outside `/a2a/v1` and the card.
  - Pass: a 60 s hold succeeds, the observed limit is recorded (about 100 s is reported), and the unrouted path is refused by the ingress or by the server (`404`).
- **Not a spike, a user step:** the hostname (example `a2a.bigrockad.com`) is confirmed before the ingress rule is written (plan section 7).
