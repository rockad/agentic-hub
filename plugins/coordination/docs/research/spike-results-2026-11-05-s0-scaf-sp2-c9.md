# S0 results, 2026-11-05: shared stub, SP1 listener draft, SP2 C9 (headless)

Date: 2026-11-05 (log timestamps are UTC; host `ls` times are EET, UTC+2). Branch: `feat/coordination-s0`, nothing committed.
Plan: [spikes.md](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/spikes.md) sections 1, 3, 4 (SP1), 5 (SP2 C9), 10, 11.
Run by: Claude Code helper subagent (Sonnet 5.5), no interactive session, no `claude -p`, no agy.
Scope of this file: Task A only. The interactive SP1 and SP2 tests (T1 to T11, C1 to C8) are not run here.

Labels: **verified** = observed by this run, **reported** = claim not reproduced, **unverified** = not tested.

Summary:

- Scaffolding: the stub is built, self-tested with curl only, and passes every self-test case. Verified.
- SP1 listener draft: `a2a-listen` follows the 7.1 status table in an offline test with a fake stdin and a fake owner pid. Verified offline only; nothing about real hook behaviour is learned.
- SP2 C9 (headless): Claude Code 2.1.318 expands `${A2A_API_KEY}` in an MCP header value, in the CLI health check, for a local-scope entry. Verified. A project-scope entry is not health-checked until it is approved. Verified. Whether an interactive session expands identically is unverified and stays with SP2's interactive part.
- Stub left NOT running. Scratch files kept.

## 1. Scaffolding (stub and self-test)

### Tool versions

- Python 3.14.4 (stub, standard library only), curl 8.18.0, `/bin/sh` is dash, jq 1.8.1, shellcheck 0.11.0
- Claude Code 2.1.318 (`claude --version`)
- Host: alyx, WSL2, Linux 6.18.54.1-microsoft-standard-WSL2

### What was built

- `/home/rockad/scratch/a2a-spikes/stub/stub.py`, one file, 127.0.0.1:18120 (threaded `http.server`, HTTP/1.1 keep-alive)
- `/home/rockad/scratch/a2a-spikes/stub/README.md` with start and stop commands and the control-file protocol
- `/home/rockad/scratch/a2a-spikes/stub/selftest.sh`, curl only; outputs in `stub/log/selftest-output.txt` and `stub/log/stub-selftest.jsonl`
- Scratch location is outside every git repo (`git rev-parse` there: "not a git repository")

Endpoints, as in spikes.md section 3:

- `POST /wake/listen`: reads `X-Session`, `X-Wait`, `X-Again` (the `X-Coord-*` spellings of server-api.md 7.1 are accepted as aliases); parks until `ctl/<session>.release` appears or the round times out with 408; one parked listener per session with 409 to the older; wake budget default 12 per hour per session; `ctl/KILL` answers every listener 503.
- `POST /sessions`, `GET /pending?handle=`
- `POST|GET|DELETE /mcp`: stateful streamable HTTP, fresh random `Mcp-Session-Id` per `initialize`, 401 without `Authorization: Bearer spike-token` on every method, tools `a2a_hello(handle)`, `a2a_inbox()`, `a2a_wait(seconds)`.
- One JSON line per request and per response, with timestamp, source port, method, JSON-RPC method, `Mcp-Session-Id`, User-Agent, `auth_present` yes/no, `auth_equals_token`, full `params._meta`, `clientInfo`, and every header except `Authorization`. The Authorization value is never logged. Verified: `rg spike-token` finds nothing in any stub log file.
- Additions beyond the plan, for C9: `auth_len` and `auth_is_literal_placeholder` (a derived fact: value equals `Bearer ${A2A_API_KEY}`), plus a `GET /stub/status` debug view. Added at 06:36 UTC; the first C9 runs (project scope, first local-scope run) predate `auth_len`.

### Self-test, run with `A2A_STUB_WAKE_BUDGET=3` (curl only, no harness)

Run: `/home/rockad/scratch/a2a-spikes/stub/selftest.sh`. Result lines (full output in `stub/log/selftest-output.txt`):

- W1 release `200 2` while parked: `200 body=[2] elapsed=1.0s`. PASS.
- W2 round timeout (`X-Wait: 2`): `408 body=[] elapsed=2.0s`. PASS.
- W3 newer listener, same session: older answered `409` after 1.0 s, newer stays parked until released. PASS.
- W4 status codes through the release file: 401, 403, 410, 429, 503 each returned as written. PASS.
- W5 budget (3 per hour): releases 1 to 3 answered 200; release 4 answered nothing, the listener stayed parked and got `408 elapsed=4.0s` at the round end. PASS.
- W6 `ctl/KILL`: the parked listener got `503` in 1.0 s, a new listener got `503` in 0.0 s. PASS.
- W7 client disconnect while parked: logged as `close` with `by: client`. PASS.
- S1 `POST /sessions` returned `{"ok": true, "session_id": "s1"}`, `GET /pending?handle=` returned `{"pending": 3}` from the control file. PASS.
- M1 `/mcp` without bearer and with a wrong bearer: `401 Unauthorized`, `WWW-Authenticate: Bearer` present. PASS.
- M2 with bearer: `initialize` gave 200 and an `Mcp-Session-Id`; `notifications/initialized` gave 202; `tools/list` listed the three tools; an unbound `a2a_inbox` gave `isError` "This session is not bound. Call a2a_hello(handle) first."; `a2a_hello`, then `a2a_inbox`, then `a2a_wait(1)` worked; `GET /mcp` gave 405; `DELETE /mcp` gave 200; a `tools/list` after the DELETE gave 404; a DELETE without bearer gave 401. PASS.

Raw log lines (trimmed; `stub/log/stub-selftest.jsonl`):

    {"ts":"2026-11-05T06:26:25.624+00:00","ev":"response","rid":2,"path":"/wake/listen","status":200,"ms":1002,"reason":"release_file"}
    {"ts":"2026-11-05T06:26:28.668+00:00","ev":"park","rid":5,"session":"s3","wait":15,"again":"2","superseded_older":true,"src_port":41685}
    {"ts":"2026-11-05T06:26:28.669+00:00","ev":"response","rid":4,"path":"/wake/listen","status":409,"ms":1002,"reason":"superseded"}
    {"ts":"2026-11-05T06:26:36.153+00:00","ev":"budget_exhausted","rid":14,"session":"s5","budget":3,"action":"stay parked, 408 at round end"}
    {"ts":"2026-11-05T06:26:40.481+00:00","ev":"response","rid":15,"path":"/wake/listen","status":503,"ms":1002,"reason":"kill_file"}
    {"ts":"2026-11-05T06:26:41.520+00:00","ev":"close","rid":17,"session":"s7","by":"client","parked_s":1.0}
    {"ts":"2026-11-05T06:26:42.042+00:00","ev":"request","method":"POST","rpc_method":"initialize","auth_present":"no","auth_equals_token":false,"user_agent":"curl/8.18.0"}
    {"ts":"2026-11-05T06:26:42.082+00:00","ev":"request","rpc_method":"tools/call","tool":"a2a_inbox","params_meta":{"probe":"selftest"},"auth_present":"yes","auth_equals_token":true}

Observations worth carrying forward:

- **Header names differ between the two documents.** spikes.md section 3 says `X-Session`, `X-Wait`, `X-Again`; server-api.md 7.1 says `X-Coord-Session`, `X-Coord-Wait`, `X-Coord-Again`. The stub accepts both and the SP1 listener draft sends the spikes.md spelling. The spec should pick one before S1.
- **Claude Code 2.1.318 opens an MCP connection with `server/discover`, not `initialize`** (section 3 below). A stateful server must answer it with an ordinary JSON-RPC or HTTP error and let the client fall back; the stub's 400 was accepted. agy sends the same method (A6 results). The real `/mcp` mount must not 500 on it.
- **Closed IPv4 loopback ports time out instead of refusing in this tool sandbox.** `curl http://127.0.0.1:18199/` returned `000` after the full timeout (3 s, 5 s) for ports 9, 8120, 18121, 18150, 18198 and 18199, while `[::1]` refused in 0.0002 s. [verified, in this sandbox only; a normal user terminal may behave differently.] A real "connection refused" test therefore used `[::1]`. It is also why the listener draft sets `--connect-timeout 10`.
- Ports 18125 and 18126 are listening on this host and are not from this run (18125 is the port the agy A6 run used); Docker containers `a2a-spike-sp5*` exist and belong to another workstream. Neither was touched.

Decision consequence: the stub is ready for SP1 and SP2 runs; pick one set of wake header names in the spec.

## 2. SP1 listener draft (offline test)

### What was built

- `/home/rockad/scratch/a2a-spikes/sp1/a2a-listen`: POSIX `sh` plus `curl` (`sh -n` clean, `shellcheck -s sh` clean, run under dash).
- `/home/rockad/scratch/a2a-spikes/sp1/test-listen.sh`: the offline test; output in `sp1/out/test-listen-output.txt`, listener log in `sp1/state-run3/listen.log`.

Behaviour as built (configuration is by environment variable; see the script header):

- Reads the hook JSON on stdin, extracts `hook_event_name`, `session_id`, `source` with `sed` (flat string fields only).
- Logs start, its pid and ppid, the stdin JSON, and the names only of `CLAUDE_*` variables, to `$A2A_STATE_DIR/listen.log`.
- Guards, all exit 0 silently: `CLAUDE_CODE_SESSION_ATTENDED=0`; event not `Stop` or `SessionStart` with source `startup` or `resume`; `session_id` failing `^[A-Za-z0-9_-]+$`; no API key.
- The key reaches curl through a private (umask 077) `-K` config file, not argv.
- Status table (server-api.md 7.1, decision 8):
  - 200: body checked against `^[0-9]{1,4}$`, then `[a2a] N pending. Call a2a_inbox.` on stderr and exit 2. A 200 with a bad body does not wake; it is treated as a server error.
  - 408: loop at once.
  - 409: exit 0, silent.
  - 401, 403, 410: marker file `notice-<session>`; first occurrence exits 2 with a one-line notice, a repeat exits 0 silently. A `410` with `X-Coord-Reason: unregistered` is retried for the first 15 s after start (server-api.md 7.1). The marker is cleared by a later 200 or 408.
  - 429, 5xx, 000 and anything unexpected: backoff 1, 2, 4 up to 60 s, honouring `Retry-After`, reset when a call lasted at least 10 s; never exits 2.
- Owner watch: the curl runs in the background and the script polls the owner pid every second; on owner death it kills curl, posts `/sessions/end` (1 s limit, best effort) and exits 0. SIGTERM, SIGINT and SIGHUP are trapped: log, kill curl, exit 0.

### Test setup

- Stub on 127.0.0.1:18120 with the default budget (12). Fake stdin JSON `{"session_id":"t-lN","transcript_path":"/fake/t.jsonl","cwd":"/fake","hook_event_name":"SessionStart","source":"startup"}`. Fake owner: a `sleep 600` process killed by the test. No Claude session was started.
- The release files were written by the test into the stub's `ctl/` directory.

### Results (verified, offline)

- L1, 200: `exit=2 stderr=[[a2a] 4 pending. Call a2a_inbox.]`. Log: `round=1 http=200 ... WAKE: 200 count=4, exit 2`. PASS.
- L2, 408 loop and owner death: with 3 s rounds the listener ran on after the first 408 (`round=1 http=408`, `round=2 parked`), still running at 7 s; `kill -9` of the owner ended it with exit 0 and no stderr in 0.11 s. Log: `owner 1171688 gone while parked, killing curl_pid=1171794, exit 0`. PASS.
- L3, 409: second listener for the same session; older one `exit=0 stderr=[]` (log `409 superseded, exit 0 silently`), newer stayed parked. PASS.
- L4, 401, 403, 410: first occurrence `exit=2` with `[a2a] wake listener stopped: server answered N. Check the coordination server and API key.`, marker file written, second occurrence `exit=0 stderr=[]`. PASS for all three codes.
- L5, `410 unregistered` within 15 s: retried (`410 unregistered inside the 15s start window, retrying`, `round=2 parked`), then a 200 woke it. PASS.
- L6, 503, 429, 500 in sequence: no wake; backoff `1s`, `2s`, `4s` (the first two with `retry-after=[1]`); still running afterwards; a 200 then woke with `[a2a] 2 pending. Call a2a_inbox.`. PASS. Log:

      round=1 http=503 ... http=503 backoff 1s (retry-after=[1])
      round=2 http=429 ... http=429 backoff 2s (retry-after=[1])
      round=3 http=500 ... http=500 backoff 4s (retry-after=[])
      round=4 http=200 ... WAKE: 200 count=2, exit 2

- L7, connection refused (`[::1]:18199`): `http=000 curl_rc=7`, backoff 1, 2, 4 s, no wake, owner death during a backoff ended it (`owner ... gone during backoff, exit 0`). PASS.
- L8, guards: `CLAUDE_CODE_SESSION_ATTENDED=0`, a bad `session_id`, `source=clear`, `source=compact`, event `UserPromptSubmit` each gave `exit=0 stderr=[]` at once. PASS.
- L9, inventory: the log has the start line (`pid`, `ppid`, `event`, `session_id`, `source`, `owner`), the stdin JSON, and `claude_env_names`. The value `topsecret-value` of a planted `CLAUDE_FAKE_SECRET` appears nowhere in the log. `pgrep -a curl` during a live round shows `-K .../run.<pid>.cfg` and no `spike-token`. PASS.
- SIGTERM: sent to a parked listener; log `signal TERM received`, exit 0, the stub logged `close by client` after 2.0 s (curl was killed), no `run.*` temp files left. PASS.

### Caveats

- The `CLAUDE_*` names in the L9 log (`CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`, `CLAUDE_PID`, plus the planted `CLAUDE_FAKE_SECRET`) are the environment of this helper's own tool shell, inherited by the test. They are **not** the T10 hook-environment inventory. T10 needs a real hook run. This list shows only that those names exist in a Claude Code tool shell.
- The default owner pid is `$PPID`. In every test the owner was forced with `A2A_OWNER_PID`, so whether `$PPID` is the `claude` process inside a real hook (or an intermediate shell) is **unverified**. SP1 T7 and T10 must settle it; if it is a wrapper, the owner should come from a variable seen in T10 or from a walk up the process tree.
- Timings are limited to 1 s resolution by `date +%s` and the 1 s owner-poll tick. A round shows `dur` up to 1 s longer than the stub's 3 s.
- The hook-side facts (what Claude does with exit 2, the real timeout signal, Esc, a second listener) are SP1 T1 to T11 and are untouched here.
- Bugs found and fixed during the test: the first draft had no connect timeout (the sandbox's timing-out closed ports made one curl hang for minutes; `--connect-timeout 10` added), and the test harness wrote to `~/.local/state/a2a-coord/` once because of an empty variable (section 4).

Decision consequence: the status table of decision 8 is implementable in about 180 lines of POSIX sh with no tool beyond curl, sed, grep and sleep; the open items are the owner-pid source and everything that needs a real session.

## 3. SP2 C9 (headless): `${A2A_API_KEY}` in an MCP header

This shows the behaviour of the **CLI health check** (`claude mcp list` and `claude mcp get`) in Claude Code 2.1.318. Whether an interactive session expands the variable identically is **unverified** and stays to be confirmed in SP2's interactive part (C9 proper).

### What was run, in order (cwd `/home/rockad/scratch/a2a-spikes/sp2c`)

- Safety copy of `~/.claude.json` to `sp2c/backup/claude.json.pre-c9` (mode 600, sha256 prefix `cfb55e4fc786bb14`); recorded that no project entry existed for the scratch directory.
- `claude mcp add -s project --transport http -H 'Authorization: Bearer ${A2A_API_KEY}' a2a-stub http://127.0.0.1:18120/mcp` failed with `error: missing required argument 'name'`. `-H` is variadic and swallowed the name. Working form, options last:

      claude mcp add a2a-stub http://127.0.0.1:18120/mcp -s project --transport http -H 'Authorization: Bearer ${A2A_API_KEY}'

  Worth knowing for the installer. The command output shows the header as `[REDACTED]`.

- Project scope. `.mcp.json` was created with the placeholder stored literally:

      {"mcpServers":{"a2a-stub":{"type":"http","url":"http://127.0.0.1:18120/mcp","headers":{"Authorization":"Bearer ${A2A_API_KEY}"}}}}

  - `A2A_API_KEY=spike-token claude mcp list` (41 s, see the side effect below): `a2a-stub: http://127.0.0.1:18120/mcp (HTTP) - ⏸ Pending approval (run \`claude\` to approve)`. The stub saw **0 requests**.
  - `claude mcp get a2a-stub`: `Status: ⏸ Pending approval (run \`claude\` to approve)`, `Headers: Authorization: Bearer ${A2A_API_KEY}` (shown unexpanded), 0 requests.
  - Conclusion: **project-scope servers are not health-checked without trust approval**, so the project-scope variant cannot be tested without an interactive session. Switched to local scope as instructed. The project entry was removed with `claude mcp remove a2a-stub -s project` (leaves `.mcp.json` as `{"mcpServers": {}}`).
- Local scope: `claude mcp add a2a-stub http://127.0.0.1:18120/mcp -s local --transport http -H 'Authorization: Bearer ${A2A_API_KEY}'`. `~/.claude.json` then held `.projects["/home/rockad/scratch/a2a-spikes/sp2c"].mcpServers["a2a-stub"]` with the literal `Bearer ${A2A_API_KEY}`.
  - `A2A_API_KEY=spike-token claude mcp list`: `a2a-stub: http://127.0.0.1:18120/mcp (HTTP) - ✔ Connected`.
  - `A2A_API_KEY=spike-token claude mcp get a2a-stub`: `Status: ✔ Connected`; the displayed header stays the unexpanded text.
  - Unset: `env -u A2A_API_KEY claude mcp get a2a-stub`: `Status: ✘ Failed to connect`, `Issue: Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"error": "unauthorized"}`.
  - Unset: `env -u A2A_API_KEY claude mcp list`: `a2a-stub: ... - ✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401). ...` and a second line `└ [Warning] [a2a-stub] mcpServers.a2a-stub: Missing environment variables: A2A_API_KEY`.
- Removal: `claude mcp remove -s local a2a-stub`, then the jq checks in section 4.

### Wire evidence (stub log, `/home/rockad/scratch/a2a-spikes/stub/log/stub.jsonl`)

Variable set, `claude mcp list` at 06:36:15 UTC (and again for `get`):

    06:36:15.156 POST server/discover              (no session id)  auth yes  equals_token true   claude-code/2.1.318 (sdk-cli)
    06:36:15.159 POST initialize                   (no session id)  auth yes  equals_token true
    06:36:15.203 POST notifications/initialized    a0e88d9e         auth yes  equals_token true
    06:36:15.204 GET  (SSE stream, Accept: text/event-stream)  a0e88d9e  auth yes  equals_token true  -> stub answered 405
    06:36:15.206 POST tools/list                   a0e88d9e         auth yes  equals_token true

Variable set, after the `auth_len` field was added (06:37:40 UTC, `claude mcp get`): all five requests `auth_len=18`, `auth_is_literal_placeholder=false`; `printf 'Bearer spike-token' | wc -c` is 18. So the header is the **expanded** `Bearer spike-token`.

Variable unset (`claude mcp list`, 06:37:28 UTC):

    06:37:28.027 POST server/discover  auth_present yes  equals_token false  auth_len 21  literal_placeholder true
    06:37:28.028 POST initialize       auth_present yes  equals_token false  auth_len 21  literal_placeholder true
    responses: 401 bad_or_missing_bearer, 401 bad_or_missing_bearer

So with the variable unset the CLI sends the **literal text** `Bearer ${A2A_API_KEY}` (21 characters), the server answers 401 to both `server/discover` and `initialize`, and the client stops there (no further requests, no OAuth fallback: the message says it is disabled when `headers.Authorization` is set).

Client facts seen on the wire (useful for SP2 and the real `/mcp`):

- First request of a connection is `server/discover` with no `Mcp-Session-Id`, header `mcp-method: server/discover`, `mcp-protocol-version: 2026-07-28`, and `params._meta` keys `io.modelcontextprotocol/protocolVersion`, `.../clientInfo` (`name: claude-code`, `title: Claude Code`, `version: 2.1.318`), `.../clientCapabilities` (`roots`, `elicitation`, `extensions: io.modelcontextprotocol/tasks`). The stub answered it with 400 (no session header) and the client fell back to `initialize`.
- `initialize` asked for protocol `2025-11-25`; the stub offered `2025-06-18` and the client accepted it and sent `mcp-protocol-version: 2025-06-18` afterwards.
- User-Agent `claude-code/2.1.318 (sdk-cli)`; `clientInfo` as above.
- The health check did a `GET /mcp` for the SSE stream (405 accepted), `tools/list`, no `tools/call`, and **no `DELETE`** in the health-check run (0 DELETEs and 0 tools/call in the log).
- Per-request coverage of the header: every request that reached the stub carried `Authorization`, including the `GET`. The CLI check never issues a `tools/call` or a `DELETE`, so those two request types are **unverified** for Claude Code (spikes.md C9 wants all four; SP2 interactive).

### Pass and fail (spikes.md C9 is "record", with a decided fallback)

- Expansion of `${A2A_API_KEY}` from the process environment into the `Authorization` header: **yes** in the CLI health check, local scope, requests `server/discover`, `initialize`, `notifications/initialized`, `GET`, `tools/list`. Verified.
- Failure mode with the variable unset: literal placeholder sent, 401, shown as `✘ Failed to connect` with the 401 text above, plus a `Missing environment variables: A2A_API_KEY` warning in `claude mcp list` (not in `claude mcp get`). Verified.
- Project-scope `.mcp.json` entry: not connected until approved. Verified. Expansion in project scope itself is **unverified** (needs approval in an interactive session).
- `tools/call` and `DELETE` carrying the header, and the 401 display inside an interactive session: **unverified**.
- GUI-launched Claude seeing `A2A_API_KEY`: **unverified**. For reference only, `A2A_API_KEY` is not set in this shell and is not mentioned in `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.profile` or `~/.bashrc` today.

Decision consequence: the decision 24 plan (a `.mcp.json` or plugin entry that holds only `Bearer ${A2A_API_KEY}`) is plausible for Claude Code: local-scope expansion works in the CLI health check (`~/.claude.json` entry, verified above). The `.mcp.json` (project-scope) form itself is **unverified** until SP2 C9 confirms it after approval in an interactive session (0 requests reached the stub before approval, see above). The decision 34 fallback (literal key in `~/.claude.json`) therefore stays open until an interactive session confirms expansion on `tools/call`, `DELETE` and in project scope, and until the GUI-launch question is answered.

Side effect to know about: `claude mcp list` health-checks every configured server, so it contacted the claude.ai connectors and started or probed the stdio plugin servers (jev, gitea, google-workspace, chrome-devtools), and waited 30 s each for three that time out (`plugin:memory:recall`, `plugin:memory:lookup`, `plugin:obsidian:obsidian`, which were already failing at session start). A run takes about 41 s. `claude mcp get` checks only the named server.

## 4. Touched files, restore check, cleanup

Touched files:

- `/home/rockad/.claude.json` (user level, unmanaged by chezmoi): changed only by `claude mcp add -s local` and `claude mcp remove -s local`, for the scratch project path. Safety copy `sp2c/backup/claude.json.pre-c9` was taken first. Not restored byte for byte, as instructed, because running sessions rewrite it.
  - Verified after removal: `jq '[.. | objects | select(has("a2a-stub"))] | length'` gives 0; `rg -c a2a-stub` finds 0 occurrences; `A2A_API_KEY` occurs 0 times.
  - Verified: the sorted list of server names across all `mcpServers` objects is identical before and after; the top-level keys are identical; the only difference in `projects` keys is one added key, `/home/rockad/scratch/a2a-spikes/sp2c`.
  - **Residual, not removable with the CLI:** that project entry remains, empty and inert: `{"allowedTools":[],"mcpContextUris":[],"mcpServers":{},"enabledMcpjsonServers":[],"disabledMcpjsonServers":[],"hasTrustDialogAccepted":false,...}`. I did not hand-edit the file because it is rewritten continuously by running sessions. If you want it gone, delete that one key by hand when no session is writing.
  - The safety copy held credentials, so it was deleted after the checks above (and its directory removed); it is no longer on disk.
- `/home/rockad/scratch/a2a-spikes/sp2c/.mcp.json` (scratch): created by `claude mcp add -s project`, emptied by `remove`; now `{"mcpServers": {}}`. Kept.
- `/home/rockad/.local/state/a2a-coord/` (accidental): one test run used an empty state-directory variable (a bug in `test-listen.sh`, since fixed) and the listener fell back to its default state directory, creating this directory with `listen.log` and three empty marker files. I removed those files and the directory and verified `ls ~/.local/state` no longer lists it. Nothing else under `~/.local` was touched.
- Repo: only this file was written in `/home/rockad/projects/agentic-hub`. Before writing it `git status --short` was empty; branch `feat/coordination-s0`; no commit, push or branch switch.
- Not touched: `~/.claude/settings.json`, any hooks file, `~/.gemini`, `~/.agents`, any chezmoi-managed file, agy in any form, Docker (containers `a2a-spike-sp5*` belong to another workstream).

Cleanup confirmation:

- Stub stopped (SIGTERM, `shutdown` line in the log, `run/stub.pid` removed); `ss -ltn` shows nothing on 18120. No stub, listener or `sleep 600` process of this run remains.
- No Claude session was started; no `claude -p`; only `claude --version` and `claude mcp add|list|get|remove` were run.
- Docker not used.

Scratch files kept under `/home/rockad/scratch/a2a-spikes/`:

- `stub/`: `stub.py`, `README.md`, `selftest.sh`, `log/` (`stub.jsonl`, `stub-selftest.jsonl`, `selftest-output.txt`, `stdout.log`), `ctl/`, `run/`
- `sp1/`: `a2a-listen`, `test-listen.sh`, `out/test-listen-output.txt`, `state/`, `state-run2/`, `state-run3/` (listener logs of three test runs; `state-run3` is the clean final run, `state` and `state-run2` are earlier runs with the connection-refused test still pointed at the timing-out IPv4 port)
- `sp2c/`: `.mcp.json`, `list-1-project-set.txt`, `list-2-local-set.txt`, `list-3-local-unset.txt`, `get-1-project.txt`, `get-2-local-unset.txt`, `get-3-local-set.txt`, `mark*` (stub log line offsets)

## 5. Open points for the user-run spikes

- Restart the stub for the interactive work: `cd /home/rockad/scratch/a2a-spikes/stub && mkdir -p ctl log run && setsid nohup python3 stub.py >> log/stdout.log 2>&1 < /dev/null &` (default budget 12). Note: the stdlib-only stub runs on the system `python3` (3.14.4), outside any uv project. This is a deliberate exception: spikes.md section 3 allows a stdlib-only stub with no install. The alternative that follows the tool rule strictly is `uv run --no-project python stub.py`. The log accumulates; move `log/stub.jsonl` aside first if a clean log is wanted.
- SP1 must determine the real owner pid (`$PPID` versus `claude`) and the hook environment (T7, T10); the listener's owner default is unverified.
- SP2 interactive part must confirm `${A2A_API_KEY}` expansion in an interactive session for `tools/call` and `DELETE`, in project scope after approval, and with a GUI-launched Claude.
- Choose one spelling for the wake headers (`X-Session` or `X-Coord-Session`) in the spec.
- Make sure the real `/mcp` answers `server/discover` with a plain error rather than a 5xx or a dropped connection.
