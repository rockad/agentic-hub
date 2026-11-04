# T1b audit: wake mechanisms for idle coding-agent sessions

Date: 2026-11-04. Read-only audit. Clones (never executed, built or installed):

- `/tmp/claude-1000/-home-rockad-projects-agents-bridge/98480dc1-8bea-40bd-bd24-5519ebd285d6/scratchpad/audit/amahpour-switchboard` (HEAD d6cfd32, 2026-11-03)
- `/tmp/claude-1000/-home-rockad-projects-agents-bridge/98480dc1-8bea-40bd-bd24-5519ebd285d6/scratchpad/audit/zb-ss-agent-group-mcp` (HEAD 3b3dc2a, 2026-10-25)
- `/tmp/claude-1000/-home-rockad-projects-agents-bridge/98480dc1-8bea-40bd-bd24-5519ebd285d6/scratchpad/audit/wilfreddenton-interlink` (HEAD 01edda0, 2026-11-03)
- Official docs saved as read-only text under `.../audit/docs-cc/` (hooks.md, channels-reference.md, xsm.md, changelog.md)

Labels: verified = read in source or official docs this session; reported = the project's own claim (tests, PR text) that I did not reproduce; unverified = inference or not documented.

Tools: `jq`, `rg`, `fd`, `gh`, `curl` (fetch only), WebFetch were all available. No tool was missing.

## Bottom line

- Claude Code idle wake works and is well proven: a `type: command` hook with `asyncRewake: true` on `Stop` and `SessionStart` that blocks on the server and exits 2 with a stub. Switchboard has the best implementation. Borrow the pattern, do not adopt the code.
- Antigravity (`agy`): the official hooks page documents no async, background or rewake mechanism. No compliant wake exists that is documented. The only existing `agy` wake in this group (zb-ss) runs `agy agentapi send-message` from the sender, which is a DDR-003 violation.
- Channels are not a safe primary path: research preview, allowlist or dev flag, org gating, and #61797 (silent drops while idle) was closed as stale, not fixed.
- All three projects are MIT with no riders. No licensing rejection.
- There is a second, official Claude Code route worth a spike: the per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) from the cross-session messaging feature. Interlink already uses it.

---

## 1. amahpour/switchboard

### License, language, maintenance

- License: MIT, 21-line standard text, "Copyright (c) 2026 Ari Mahpour" (verified, `LICENSE:1-21`). The body is byte-identical to the other two repos' (sha256 of lines 4-21 matches).
- Riders: none restricting AI vendors. `src/switchboard/web/static/agents/NOTICE:1-5` only says the OpenAI, Anysphere and Cognition icons are their trademarks, not under MIT, and removable on request (verified). README:121-123 repeats this (verified). Nothing restricts Anthropic, Google or partner agents.
- Language: Python (GitHub metadata, verified). Web UI bundles Mermaid (MIT).
- Maintenance: created 2026-09-28, last push 2026-11-04, 410 commits, release v0.48.0, 1 star, 2 open issues (verified via `gh api`, `git log`). Extremely active, single maintainer, heavily AI-authored ("Generated with Claude Code" in PR bodies). Young and fast-moving; expect churn.

### PR #391 (verified via `gh pr view`)

- "feat(agents): idle agents over HTTPS wake on a message", merged 2026-10-16, stage 2 of #380.
- Claude Code: a `curl` command hook with `asyncRewake` runs a listener at Stop. It sends only the session id (from the hook's stdin) and waits at `/mcp/listen`. 200 with text: curl prints it, hook exits 2, Claude Code starts a turn. Any 4xx makes `curl -f` fail, hook exits 0, nothing wakes.
- Codex: a held Stop `mcp_tool` hook returning `decision: block`. Not relevant to us.
- Reported verification: real Claude Code 2.1.300 (haiku) in tmux, woke and answered in 2.0 s. 10 integration tests, 20/20 passes. Not tested: Claude Desktop Code tab, Windows, Codex live.
- Important: the code has moved on since #391. The `curl` one-liner was replaced by a hardened shell script `plugins/claude/bin/listen` (see below). Audit the script, not the PR text.

### Exact wake mechanism (current main)

Hook config (verified, `docs/USAGE.md:232-235`):

```json
"SessionStart": [{"hooks": [{"type": "command", "timeout": 10, "command": "~/.claude/hooks/switchboard-session"},
  {"type": "command", "asyncRewake": true, "timeout": 604800,
  "command": "~/.claude/hooks/switchboard-listen"}]}],
"Stop": [{"hooks": [{"type": "command", "asyncRewake": true, "timeout": 604800,
  "command": "~/.claude/hooks/switchboard-listen"}]}],
"SessionEnd": [{"hooks": [{"type": "command", "timeout": 10, "command": "~/.claude/hooks/switchboard-session"}]}]
```

The plugin form is the same with `cd "${CLAUDE_PLUGIN_ROOT}/bin"; ./listen; exit $LASTEXITCODE` (verified, `plugins/claude/hooks/hooks.json`).

How it blocks (verified, `plugins/claude/bin/listen:123-189`):

- POSIX `sh` + `curl`. Loop `while kill -0 "$owner"` (owner = `CLAUDE_PID` or `$PPID`), so it dies with Claude Code.
- Each round is one `curl -s --max-time $((round+30)) -X POST` to `$url/mcp/listen` with headers `X-Switchboard-Session`, `X-Switchboard-Wait: 900`, `X-Switchboard-Again`. The server holds the request open (HTTP long-poll, up to 15 min per round) and answers when a message is due.
- Token goes to curl on stdin (`-K -`), never on the command line (line 127).
- A side subshell kills curl within 2 s of the owner dying (line 132).

Exit-code and status semantics (verified, `listen:140-188`):

- 200: print body to stderr, `exit 2` (wake).
- 408 (round ran out): sleep 1, next round.
- empty, 000, 429, 500, 502, 503, 504: if the call lasted at least 10 s treat it as a proxy cut and re-ask at once, otherwise exponential backoff 1..60 s.
- 409 (busy, or a newer listener or other hook took over): `exit 0` silently.
- 410 (session ended by someone else): print once and `exit 2`, guarded by a marker file so it cannot loop.
- 401/403/other: `stopped()` logs to `listen.log`, writes a marker, wakes the session once with a one-line reason, `exit 2`. The marker prevents repeat wakes ("no marker, no wake: it could loop the session awake", line 118).
- Every other path is `exit 0`. This is the guard against the runaway-wake bug (see hazards).

Guards on entry (verified, `listen:32-53`):

- `CLAUDE_CODE_SESSION_ATTENDED=0` (`claude -p`) exits 0, because background hooks hold a one-shot process open.
- Event filter: only `Stop`, or `SessionStart` with `source` startup or resume (not clear/compact, which can fire mid-turn).
- Session id must match `[A-Za-z0-9_-]+`.

Timeouts and re-arm:

- Hook `timeout` is 604800 s (7 days) in config; the script loops 15-min rounds inside it. Claude Code still enforces `timeout` on asyncRewake hooks (verified, `docs-cc/hooks.md:4099`). `docs/USAGE.md:203` claims "up to a week" (reported).
- Re-arm happens at every Stop (a new listener starts) and at SessionStart. Server-side supersede: a newer listener or any other hook of the session ends the old one with 409 (verified, `agent_http.py:1124-1131`). The newest listener wins. Switchboard also fixed a case where a long wait caused duplicate delivery (#581, latest commit).
- Claude Code minimum: plugin 2.1.290 or later is what zb-ss derived from the changelog (reported by `zb-ss .../clients/claude.py:48-49`); switchboard's own PR verified on 2.1.300 and its docs reference 2.1.303-2.1.307 (reported).

Switchboard's own empirical hazard table (reported, `docs/FINDINGS.md:159-171`, each marked "verified" by the author, I did not reproduce):

- Runaway (#96148): any command that exits 2 immediately (missing script, `sh -c 'exit 2'`) wakes the session about once per second without limit. Exit 127 or 1 does not. Mitigation: wrapper that exits 0 on every error, plus a broker-side wake budget.
- Accumulation: a new listener per Stop, old ones never die (3 alive after 2 turns). Needs server-side supersede.
- Orphans: `kill -9 claude` reparents listeners to pid 1, and one later claimed a message and exited 2 to nobody, so the message was lost. Mitigation: parent-pid watch and treating a claimed message as "offered" until a hook in the woken turn confirms it.
- Esc: an interrupted turn fires no Stop, so nothing re-arms. Real only when the interrupted turn was started by that listener's wake.
- Permission prompt: a wake that fires while a prompt is open is held, then starts a turn 0.1 s after the prompt is rejected, and the model misread it as "a stop hook blocked my command".
- Timeout: at the timeout the listener gets SIGTERM, nothing wakes, nothing is shown, the session stays unarmed until the next Stop, so pending messages must stay in the broker. Default is 600 s. `timeout: 86400` accepted; a 45-minute idle wake worked. No maximum found (reported).
- Wake latency (reported): turn start 53-131 ms after exit 2, first model action about 1.7-2.9 s, n=8 and n=14.
- Works in `bypassPermissions` unchanged (reported).
- Stop block caps: text-only continuations stop at 8 consecutive; any tool call resets (the cap and its reset on tool calls are confirmed by official docs, `hooks.md:2763`; the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` override name is from switchboard only, reported).
- A synchronous Stop long-poll holds the user's typed input until it returns, so avoid it (reported, FINDINGS:177-178).

### Payload to the model and prompt-injection handling

- On a 200 the script writes the server's text to stderr and exits 2; Claude Code shows it to the model as a system reminder (official, `hooks.md:445`; FINDINGS:159 reports it renders as `Stop hook blocking error from command "Stop": <text>`).
- Peer-message text is NOT sent on this path. USAGE.md:352 (verified): other agents' text "becomes a 'not shown here; call read()' pointer instead of inline text" on hook and Stop-hook wakes, and reaches the model only as an untrusted tool result (`read()`, `wait()`, `say()`). SECURITY.md:29 says the same. The server writes the hook reply text, not a local script, and checks it against exact reply shapes (PR #391 body, `reply_for`).
- Extra controls: "read before pass" enforcement (USAGE.md:354), wake budget 60 per room per hour (USAGE.md:351), `unaddressed_hold_s` 270 s batching (USAGE.md:346), `/pause`.
- Residual risk: the hook output text is interpreted by the model as a hook message; keeping it a fixed stub minimizes injection surface.

### Harness coverage and DDR-003

- Claude Code (hooks, as above), Codex (held Stop `mcp_tool` hook with `decision: block`; separate local tier uses the app-server/`codex queue`), Cursor (held Stop 625 s), Devin (`wait()` + capped re-arms), OpenCode (plugin idle listener).
- Gemini / Antigravity: no adapter. `src/switchboard/adapters/` contains only `base.py`, `https.py`, `testagent.py` (verified). The `agy` mentions in `docs/research/openagents.md` and `prior-art.md` are about other projects (e.g. agentchattr's tmux paste).
- DDR-003 check: the HTTPS path launches nothing and drives no TUI (no tmux, no PTY, no `claude -p`; `rg -w 'tmux|send-keys|pexpect'` over `src` finds nothing outside JS). The `claude -p` case is explicitly excluded (listener exits at once). Codex `codex queue` use is irrelevant to Claude/agy but is an external-driver pattern; ignore it.
- Live persistent sessions only: yes. One-shot spawns: not used.

### Messaging model

- Rooms plus per-session membership; addressing by `name@host`, @mentions, replies; persisted in SQLite; per-recipient first-batch latency stats; read receipts via "read before pass" and hook-confirmed wake (a wake counts only when the session's next hook confirms) (verified, USAGE.md:354, 459).
- Auth: per-device agent tokens, or a "listener key" (`sbl_` + 64 hex) minted on the user's machine, scoped to one session, for the browser-sign-in case (verified, `listen:68-74`, USAGE.md:194).
- Deployment: single broker process, HTTPS in front with `docs/DEPLOY.md` giving proxy timeouts.

### A2A alignment

- None. `rg -i 'a2a|agent card'` over README and DESIGN found nothing. Task states (working, input-required) do not exist; it is a chat-room model.

### Verdict: borrow pattern

- Do not adopt or fork: chat-room product with a large UI, 410 commits in 5 weeks, one maintainer, wrong data model for A2A tasks.
- Borrow: the `listen` script design (rounds, exit-code table, marker files, owner watch, `ATTENDED=0` guard, SessionStart source filter), server-side supersede (409), "offered until confirmed" delivery, stub-only wake text, wake budget, and its FINDINGS.md hazard list. MIT permits copying with attribution.

---

## 2. wilfreddenton/interlink (crate `interlink-mcp`)

### Identification

- crates.io `interlink-mcp` v0.13.1, repository `https://github.com/wilfreddenton/interlink` (verified via crates.io API, 370 downloads, updated 2026-11-03).
- docs.rs DELIVERY.md equals `docs/DELIVERY.md` in the repo (read from the clone).

### License, language, maintenance

- MIT, "Copyright (c) 2026 interlink authors", identical body (verified `LICENSE`). README:269-271 "MIT. See LICENSE." No riders.
- Rust (plus a Node progress hook and `npx` wrapper). Created 2026-07-11, last push 2026-11-03, 104 commits, 0 stars, 2 open issues (verified).

### Exact wake mechanism

Three Claude delivery modes (verified, `docs/DELIVERY.md:149-205`, `plugin/hooks/hooks.json`):

1. Default since 0.12.0: the local messaging socket. The MCP process posts to `CLAUDE_CODE_MESSAGING_SOCKET` with the per-session `CLAUDE_CODE_MESSAGING_TOKEN`. Frames (verified in source, `src/claude.rs:58-64`): an auth line `{"type":"auth","token":...}` then `{"type":"user","session_id":...,"message":{"role":"user","content":text}}`. 3 s connect/write timeout. No acceptance receipt; recorded as `socket_sent`. In this mode `interlink-mcp wait` exits 0 immediately (`src/bin/interlink-mcp.rs:2765-2768`), so idle Claude has no maintenance turns.
2. Legacy Stop listener (the one the task mentions). Hook config (verified, `plugin/hooks/hooks.json` and DELIVERY.md:158-168):

```json
{
  "type": "command",
  "command": "npx -y interlink-mcp wait",
  "async": true,
  "asyncRewake": true,
  "timeout": 3600
}
```

   - Blocks by polling a local append-only file `inbox/<session>.jsonl` every 400 ms (verified, `src/inbox.rs:141-155`) under a per-session exclusive OS file lock (duplicate listeners exit 0). It reads local state written by the MCP process, not the network. The MCP process is what talks to the broker (`INTERLINK_URL`, polling).
   - On messages: writes notice to stderr, flushes, commits the cursor, `exit(2)` (verified, `interlink-mcp.rs:2775-2791`).
   - 50-minute idle limit: `RENEW_AFTER = 3000 s` (verified `inbox.rs:14`). At expiry it also exits 2 with a renewal notice asking the model to end the maintenance turn so the next Stop re-arms before the 3600 s hook timeout. DELIVERY.md:62-63: "This costs a model turn; following the notice is host/model behavior, not something the MCP server forces."
   - Re-arm: a new Stop starts a new listener; the lock enforces one.
3. Native Claude channels: opt-in with `INTERLINK_CHANNELS=1 claude --dangerously-load-development-channels plugin:interlink@interlink` (DELIVERY.md:247-259, verified text). Listener self-disables. The doc says "A successful MCP notification send alone cannot prove that Claude accepted it."

Minimum Claude Code: legacy fixture validated on 2.1.278; socket mode needs the host that supplies `CLAUDE_CODE_MESSAGING_SOCKET` (docs say cross-session messaging needs 2.1.224 or later, official `xsm.md:11`); live runs on 2.1.301-2.1.312 (reported, DELIVERY.md:399-412).

### Payload and injection handling

- New notices are the single line `[Interlink inbox notice: ID]` (0.13.1). Bodies are fetched by the model through `receive_messages(notification_id=...)` and acknowledged with `acknowledge_messages` (DELIVERY.md:13-31, verified). Wake text carries no peer content.
- Trust gate: Ed25519 signed messages, deny-by-default `peers.json` allowlist, replay and freshness checks; unknown-key pairing names are shown as untrusted metadata (README, DESIGN). DESIGN.md:82 says it does not "promise containment of an untrusted peer". Admitted peers are full collaborators whose messages enter the model context.
- Anti-laundering rule: a peer's claim that its operator approved something is never operator consent (README, CHANGELOG:479-485).

### Harnesses and DDR-003

- Claude Code and Codex CLI only ("for Claude Code and Codex CLI", README:7). No Gemini, no Antigravity (`rg -i 'antigravity|agy|gemini'` finds nothing outside incidental text). Not usable for `agy`.
- DDR-003: Claude path is hook or Claude's own socket, compliant. The Codex path runs `codex queue` (external subprocess); irrelevant to Claude/agy but it is outside our scope. No tmux or PTY. Compliant for Claude.
- Live-session only: yes. Real-model validation used interactive-ish PTY variants and stream-json persistent processes (reported).
- Supply-chain flag: both the MCP server and the legacy listener are `npx -y interlink-mcp` with no version pin, executed at every Stop (verified, `hooks.json`). Treat as a risk if copied.

### Messaging model

- Per `public-key#session` inbox, persisted to `mailbox/<identity>/<session>.json` before broker ack; durable across restarts; 4,096 records / 32 MiB cap per session; bodies not consumed until explicit ack (verified, DELIVERY.md:9-31, 288-299).
- Delivery states: `pending`, `bus_accepted`, `receiver_stored`, `inbox_queued`, `notification_sent`, `socket_sent`, `host_queued`, `delivery_failed`, `receiver_acknowledged`. "No signed remote receipt protocol is implemented." Not exactly-once (DELIVERY.md:130-151).
- Retries: 30, 60, 120, 240, max 300 s while attention-worthy messages remain unread (DELIVERY.md:85-90).

### A2A alignment

- Light, by analogy only: `task_id`, `status` (`update`, `needs_input`, `result`, `failed`, `canceled`), `in_reply_to`, `cancel_task`. CHANGELOG:479 says `needs_input` "is A2A's `input-required`". This is the closest of the three to our task model. No A2A wire protocol, no agent cards.

### Verdict: borrow pattern (do not adopt)

- Borrow: the three-mode delivery taxonomy, the "notice has an ID, body fetched by tool, ack by receipt" design (stub-only wake, durable body until explicit ack), the `socket` mode as the best Claude-native alternative, and the task-status vocabulary. Also its explicit lesson that the 50-minute-renew-by-model-turn design is a cost to avoid (switchboard's in-script rounds avoid it).
- Reject as a dependency: local-first, peer-to-peer crypto model not needed behind our authenticated server; unpinned `npx`; no agy.

---

## 3. zb-ss/agent-group-mcp (v0.7.2; CLI name `agent-bus`; PyPI `agent-group-mcp`)

### License, language, maintenance

- MIT, "Copyright (c) 2026 agent-bus contributors" (verified `LICENSE`), identical body. README:1068-1070 "MIT." No riders.
- Python 3.11+, local only ("Zero external services. Local-only. Filesystem + SQLite", README:13-16; "no network calls", README:30). Created 2026-05-13, last push 2026-10-25, 70 commits, 0 stars, 0 open issues (verified).
- PR #7 "Wake idle agents when mail arrives" merged 2026-10-19 (verified). Current v0.7.2 adds the agy wake.

### Exact wake mechanism (Claude Code)

- `agent-bus init` writes an `asyncRewake` hook on `SessionStart` and `Stop` (verified, `src/agent_bus/clients/claude.py:90-122`):

```json
{
  "type": "command",
  "command": "AGENT_BUS_NAME=<name> <bin> hook-watch --client claude --max-seconds <N> ; [ $? -ne 10 ] || exit 2",
  "asyncRewake": true,
  "timeout": "<max_seconds + 30>",
  "rewakeSummary": "agent-bus: new mail"
}
```

  (`base.py:176-192` verified: `hook-watch` exits 10 on a wake and the shell maps exactly that to 2; any other result, including an older binary whose argparse exits 2, becomes exit 0.)
- Blocking: local SQLite polling every 2 s (`AGENT_BUS_WATCH_POLL_SECONDS`) in `src/agent_bus/watch.py`. It prints the mail on stderr and exits. Newest watcher wins via a `routes` table; stops when the owner pid dies, after `AGENT_BUS_WATCH_HOURS` (24 h default), at once for `wake.json` entries, and when `CLAUDE_CODE_ENTRYPOINT != cli` (verified, `claude.py:36-45`, `watch.py:1-30`).
- Timeout: `max_seconds + 30`, clamped to `(2**31-1)/1000` s, the JS timer limit (verified, `claude.py:55-57,122-126`).
- Rate limit: at most 20 native wakes per agent per hour (README:915-919).
- Minimum Claude Code: 2.1.290, noted as "Changelog facts: asyncRewake hooks exist from 2.1.287, and 2.1.290 fixed one waking Claude in an endless loop" (verified in source comment; official changelog line 2260 confirms an asyncRewake missing-script runaway fix in the 2.1.287 era).
- `rewakeSummary` is undocumented upstream (README:938-940 admits it; also absent from official `hooks.md`, verified by rg).
- Not run by the author: Linux end to end, Claude Code in an IDE or desktop app, Codex with its shared background server (PR #7 body, reported). Live-tested on Claude Code 2.1.303 (reported).
- Weak point for us: it polls a local SQLite file and cannot cross a Docker boundary without a network client; it is a local single-machine bus.

### Payload and injection handling

- The mail text itself is placed on stderr and becomes the wake message (`hooks.py:343-344`: "[agent-bus] N new message(s) since last turn:" plus formatted messages). I found no untrusted-content framing, no stub indirection, and no sanitization (`rg -i 'untrusted|injection|sanitiz'` finds only a README shell-quoting note for `wake.json`). Peer text enters the model as a hook message. Verified by absence; treat as the weakest injection posture of the three.

### Harness coverage and DDR-003 (important)

- Table (README:430-435, verified): Claude Code (asyncRewake), Codex (`codex queue`), Antigravity CLI `agy`, opencode (plugin).
- Antigravity: "A sender wakes an idle session with `agy agentapi send-message`" (README:459-470; `clients/agy.py:15-27,71-77` verified). The sender executes the `agy` binary (`[program, "agentapi", "send-message", thread, WAKE_NOTICE]`) against the live session's local API. That needs the API address and a CSRF token that agy only gives to commands its agent runs, so the first model call asks the agent to run `agent-bus wake-register` and stores the token in `push-credentials/` (`agy.py:21-22,53-68`). The README itself says "agy's `agentapi` is barely documented and may change" and "The token lets whoever holds it drive that session".
- This is a DDR-003 violation: it executes `agy` and drives a session via its control API from outside. Also harvests a CSRF token by prompting the agent, which is a trust and security smell. I found no official Antigravity documentation of `agentapi` (web search returned none; reported undocumented).
- `wake.json` (README:~930-960; `wake.py:9,186`) is an explicit user hook for arbitrary commands, with `tmux send-keys` given as an example. Not default, but if used for agy it is a DDR-003 violation by definition.
- Claude path itself: hook-only, no launch, compliant. `claude -p` explicitly excluded.
- Useful agy facts that came from its source and that match the official page where checkable: agy hooks speak JSON, camelCase, payload has `conversationId`, `workspacePaths`; no prompt-submit event; `PreInvocation` returns `{"injectSteps":[{"ephemeralMessage": ...}]}`; `Stop` must return `{"decision":"stop"}` or `{"decision":"continue","reason":...}`; agy loads `.agents/plugins/<name>/{plugin.json,mcp_config.json,hooks.json}` only for trusted workspaces (`agy.py:3-13,100-123`, README:454-466). The official hooks page (section 5) confirms the event names, JSON shapes and the Stop decision.

### Messaging model

- Per-client identity `<repo>/<client>`; bare repo name reaches all agents in that repo; SQLite WAL; one MCP server process per client session; CLI `send/inbox/tail/chat` for humans; audit log with `wake` rows (`wake_driver` watch or push; `wake_status` woke, fired:OK, rate-limited, unregistered) (README:11-30, 905-925, verified).
- Delivery receipt: audit rows only; no ack protocol. A claimed message is consumed when `hook-watch` takes it (`watch.py` docstring: "takes that mail from the inbox"), so a lost wake can lose the notification, though the mail is also shown at next turn start via UserPromptSubmit hook.

### A2A alignment

- None (`rg -i 'a2a|agent2agent'` finds nothing).

### Verdict: reject for the agy part; borrow pattern for Claude only; do not fork

- Reject the agy wake outright (DDR-003).
- The Claude hook shape (the `hook-watch` plus shell exit-code mapping and `rewakeSummary`) is a good small reference, but switchboard's is more robust and server-based. Local-only SQLite design does not fit a Docker server. Raw-text wake payload is the wrong default for us.

---

## 4. Official documentation findings

### Claude Code hooks (code.claude.com/docs/en/hooks, fetched as `hooks.md`)

- `asyncRewake` is a command-hook field: "If `true`, runs in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder" (`hooks.md:445`, verified).
- `async` and `asyncRewake` exist only on `type: "command"` (`hooks.md:~4070`, "This field is only available on `type: "command"` hooks"). `http`, `mcp_tool`, `prompt`, `agent` hooks have no async option (verified from the field tables). So an HTTP endpoint cannot be a background hook directly; a command hook must curl it.
- Timeout: "Claude Code doesn't enforce [timeout] on [async: true]. Claude Code still enforces `timeout` on a hook you run with `asyncRewake`" (`hooks.md:4099`, verified). Default 600 s for command hooks. `SessionEnd` shares a 1.5 s budget.
- Limitations section (`hooks.md:4176`, verified): async output is normally delivered on the next turn; "Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle." Each execution creates a separate background process.
- `-p` mode: Claude Code kills still-running async hooks at teardown (`hooks.md:4101-4104`, verified). Exposed to hooks as `CLAUDE_CODE_SESSION_ATTENDED=0` per switchboard (reported).
- Stop: exit code 2 or `decision: "block"` keeps Claude working; 8-consecutive-continuation cap that resets on any tool call (`hooks.md:2761-2763`, verified); `stop_hook_active`, `last_assistant_message` in input.
- SessionStart: matchers `startup|resume|clear|compact|fork`; only `command` and `mcp_tool` hook types; `additionalContext` supported; "SessionStart runs on every session, so keep these hooks fast" (verified).
- A synchronous Stop hook (non-async) delays turn completion, and per switchboard's measurements holds typed input (reported).
- Minimum version evidence: switchboard 2.1.290+ guidance (reported), changelog 2.1.287 era runaway fix (verified).

### Claude Code Channels (channels.md, channels-reference.md)

- Status: "Channels are in research preview"; "the `--channels` flag syntax and protocol contract may change" (verified).
- Requires claude.ai or Console API-key auth; not available on Bedrock, Vertex (Google Cloud Agent Platform) or Foundry. Team and Enterprise must enable `channelsEnabled`; Pro/Max without an org skip the checks (verified).
- During preview `--channels` only accepts the Anthropic allowlist (or the org's `allowedChannelPlugins`). Custom channels need `--dangerously-load-development-channels` with a confirmation prompt, per entry. Neither flag appears in `claude --help` (verified, channels.md "Research preview" and channels-reference:133,172-186).
- Protocol: server declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel` with content and `meta`; events are queued and delivered together on the next turn when busy (channels-reference:45-46,223-254, verified). "An ungated channel is a prompt injection vector" (channels-reference:418). Events only arrive while the session is open.
- Open issue anthropics/claude-code#61797 (verified via `gh issue view`): reported 2026-05-23 on v2.1.148-2.1.156, idle session at the prompt, notifications acked at the MCP layer but never shown to the model, intermittent, retransmit workarounds fail because the drop is at the attach layer. State: CLOSED by the stale bot on 2026-06-23 ("inactive for too long"), locked 2026-08-26. No maintainer response, no fix, no root cause in the thread. Treat as unresolved.
- Interlink corroborates: "A successful MCP notification send alone cannot prove that Claude accepted it." and keeps it opt-in.

### Cross-session messaging (code.claude.com/docs/en/cross-session-messaging, `xsm.md`)

- Native feature, Claude Code 2.1.224+ (macOS, Linux, WSL2), 2.1.234+ native Windows. "When the receiving session is idle, Claude Code starts a new turn with the message" (`xsm.md:59`, verified).
- Each session binds an inbox Unix socket; path exported as `CLAUDE_CODE_MESSAGING_SOCKET` and token as `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash, "including SessionStart" (`xsm.md:239-259`, verified). The docs explicitly describe "a script or hook to post into a session" with an optional `{"type":"auth","token":...}` first line.
- Inbound controls: `crossSessionInbound` accept/hold/refuse. Default: a session bypassing permission prompts holds peer messages for approval; own-child messages are verified by process evidence (Linux) or token; in a container where Claude runs as PID 1 there is no process evidence (`xsm.md:195-263`, verified). `-p` sessions bind a socket too.
- Message frame beyond the auth line is not in the official page I read. Interlink's source shows `{"type":"user","session_id":...,"message":{"role":"user","content":...}}` (verified in `claude.rs:62-63`, reported as working on 2.1.308+).

### Antigravity hooks (antigravity.google/docs/hooks, via WebFetch, two passes)

- Events (6): `SessionStart` ("Fires once when a new conversation session starts, before the first model invocation"), `PreToolUse`, `PostToolUse`, `PreInvocation` ("Fires before the model is called"), `PostInvocation`, `Stop` ("Fires when the execution loop terminates").
- Config: CLI reads `.agents/hooks.json`, `~/.gemini/config/hooks.json`, and a plugin's `hooks.json`; "Hooks in `~/.gemini/antigravity-cli/settings.json` aren't loaded."
- Handler: `type` is `command` only ("Currently only `command` is supported"); `command` required; `timeout` seconds, default 30. No HTTP hook type.
- Input is camelCase JSON on stdin: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`. Stop adds `executionNum`, `terminationReason`, `error`, `fullyIdle` (required; "`true` if the agent is completely finished and all background commands or asynchronous tasks have completed").
- Output on stdout as JSON: SessionStart and PreInvocation return `injectSteps` (items may be `systemMessage`, `userMessage`, `ephemeralMessage`, `toolCall`); PostInvocation adds `terminationBehavior` (`force_continue`, `terminate`); Stop requires `decision`, and `{"decision":"continue","reason":...}` "prevent[s] the agent from stopping and re-enter[s] the execution loop"; reason is injected as a system message.
- Not documented (verified by absence, two passes): exit-code semantics, async or background or non-blocking hooks, any rewake mechanism, behaviour on timeout, maximum timeout, whether the user can type during a Stop hook, whether Stop fires per turn or per conversation, whether SessionStart fires on resume, environment variables, trust notes.
- agy SessionStart equivalent: `SessionStart` exists, for new conversations; resume behaviour unknown. zb-ss notes workspace hooks load only in trusted workspaces (reported).

---

## 5. Synthesis for our server

### 5.1 Recommended Claude Code wake design

Principles, taken from switchboard's verified hazards and interlink's delivery model:

- The wake carries a fixed stub, never task content. Content is fetched by an MCP tool call (`a2a_inbox` or A2A `tasks/get`), so the injection surface is a constant string.
- Server state is authoritative and durable on the Docker volume. A wake is only "offered" until the woken turn calls a tool that confirms it (A2A states `submitted` then `working`). Unconfirmed offers are re-offered.
- The hook script exits 2 only on an explicit 200 from our server, and 0 on every other outcome, with the single exception of a rate-limited, marker-guarded "listener stopped" notice (switchboard pattern).

Hook config sketch (one script for SessionStart and Stop; ship as a plugin so one install gives hooks plus MCP):

```json
{
  "hooks": {
    "SessionStart": [
      {"hooks": [
        {"type": "command", "asyncRewake": true, "timeout": 604800,
         "command": "${CLAUDE_PLUGIN_ROOT}/bin/a2a-listen"}
      ]}
    ],
    "Stop": [
      {"hooks": [
        {"type": "command", "asyncRewake": true, "timeout": 604800,
         "command": "${CLAUDE_PLUGIN_ROOT}/bin/a2a-listen"}
      ]}
    ],
    "UserPromptSubmit": [
      {"hooks": [
        {"type": "http", "url": "https://a2a.example/hooks/prompt", "timeout": 5,
         "headers": {"Authorization": "Bearer $A2A_TOKEN"}, "allowedEnvVars": ["A2A_TOKEN"]}
      ]}
    ]
  }
}
```

Script behaviour, sketch (not code to copy blindly, derived from switchboard `listen`, verified):

- Read stdin JSON: `hook_event_name`, `session_id`, and for SessionStart `source`.
- Exit 0 immediately if `CLAUDE_CODE_SESSION_ATTENDED=0`, if the event is neither Stop nor SessionStart(startup|resume), or if `session_id` fails `^[A-Za-z0-9_-]+$`.
- Loop while the owner pid (Claude Code) is alive: `POST https://a2a.example/wake/listen` with `Authorization` (via `curl -K -` on stdin), `X-Session: $sid`, `X-Wait: 900`, `X-Again: n`; treat the request as a 15-minute HTTP long-poll served by the container.
- Map status codes: 200 prints the stub (for example `[a2a] N task(s) pending for this session. Call a2a_inbox.`) to stderr and exits 2; 408 loops; 000/429/5xx back off (reset if the call lasted at least 10 s); 409 exits 0 (superseded or busy); 410 and 401/403 write a marker and notify once.
- The server side holds the request open, closes it when a task arrives or on supersede, and tracks "at most one parked listener per session".
- Use the `UserPromptSubmit` (or `PostToolUse`) hook for the busy-session path: an HTTP or command hook that returns `additionalContext` with the pending count, so mid-turn tasks surface without a wake (switchboard does this via `PostToolUse` `mcp_tool` hooks, verified USAGE.md:216).
- Sync HTTP hooks are fine for these (short, 2-10 s timeouts). Do not use a synchronous Stop hook for waiting: it holds typed input (reported).

Failure modes and re-arm (all but the first two reported by switchboard's measurements; the first two are official):

- Timeout: Claude Code SIGTERMs the listener at `timeout` and nothing wakes (official: timeout is enforced for asyncRewake). Re-arm only at the next Stop or SessionStart, so tasks must stay queued server-side. Use the in-script 15-minute rounds inside a long `timeout` (switchboard) rather than interlink's 3600 s plus a model-turn renewal.
- `claude -p`, IDE or desktop sessions: not woken. Both zb-ss and switchboard did not test IDE or desktop (PR bodies, reported). Document interactive CLI only.
- Esc-interrupted turn fires no Stop, so nothing re-arms until the next prompt completes. Mitigate with the `UserPromptSubmit` / `SessionStart` path and a server-side "no listener parked" flag, so the A2A task state shows `submitted` with a "not listening" badge instead of silently pending.
- `kill -9 claude`: orphaned listeners; the pid watch plus server-side supersede and "offered until confirmed" cover it.
- Permission prompt open: the wake is held, then fires after the prompt closes and can be misread. Use a fixed, self-explanatory stub.
- Runaway: any bug that makes the script exit 2 repeatedly loops the session about once per second (#96148, reported). Keep the exit-0 default, the marker files, and a server-side wake budget (switchboard: 60 per room per hour; zb-ss: 20 per agent per hour).
- Stop continuation cap of 8 applies only to Stop-hook blocks, not asyncRewake wakes (separate path; unverified whether asyncRewake wakes count toward it).
- Proxy cuts: keep the server and any reverse proxy read timeout above the round (900 s) or let the script re-ask immediately on a long call that ended with 5xx.
- Version: require Claude Code 2.1.290 or later (reported), set minimum in the install doc, and have the installer check `claude --version` as zb-ss does.

Secondary Claude option to spike (not default): the official inbox socket.

- A small user-side helper (or the same asyncRewake script) posts the stub to `CLAUDE_CODE_MESSAGING_SOCKET` instead of exiting 2. Pros: no hook timeout, no Esc gap for the wake itself, no "Stop hook blocking error" framing, it is the vendor's own message path (interlink made this its default in 0.12.0). Cons: depends on `crossSessionInbound` (a session in bypass mode holds messages for approval unless the sender is a verified own-child), frame shape beyond the auth line is not in the official docs I read, no receipt, socket is local to the machine so the helper must run on the user's host, not in Docker. Needs a hands-on test with the real client.

### 5.2 Channels: usable or not

- Not as the primary path, not as a required path.
- Reasons (all verified): research preview with a contract that "may change"; custom channels need `--dangerously-load-development-channels` plus a confirmation each launch, because our server would not be on the allowlist; flags hidden from `--help`; org admin must enable on Team/Enterprise; Bedrock/Vertex/Foundry excluded; #61797 documents silent drops to idle sessions and was closed stale (not fixed); no accept receipt.
- Acceptable as an optional, off-by-default accelerator behind a flag, only if every message remains durable server-side and the hook wake plus pull path stays the source of truth. Also note it is `unverified` whether a remote HTTP MCP server (our Docker server) can register as a channel; the docs describe channels as MCP servers the session starts (Bun/Node examples).

### 5.3 Antigravity

What the official hooks page allows (verified, section 4):

- Six events, `command` handlers only, default 30 s timeout, JSON in and out, workspace-trust gated (per zb-ss, reported).
- No async or background or rewake option, no documented exit-code semantics, no documented maximum timeout. Therefore no documented way for a hook to start a turn in an idle session.
- Documented tools that help: `PreInvocation` `injectSteps` (inject an `ephemeralMessage` before any model call), `SessionStart` `injectSteps`, `Stop` `{"decision":"continue","reason":...}`, and `PostInvocation` `terminationBehavior: force_continue`.

Whether any compliant wake exists:

- Documented and compliant: none. An idle `agy` cannot be started by anything we are allowed to run. No external trigger is allowed (DDR-003 forbids `agy -p`, PTY or tmux injection, subprocess relays, and the `agentapi` route).
- Compliant mid-session surfacing (not a wake): a `PreInvocation` command hook that `curl`s our server (30 s default timeout, keep it to 2-5 s) and injects `{"injectSteps":[{"ephemeralMessage":"[a2a] N task(s) pending. Call a2a_inbox."}]}`. This surfaces tasks at the next model call. Plus an AGENTS.md rule to check the inbox on session start, and an MCP `a2a_wait` tool for explicit blocking.
- Possible held Stop park (unverified, needs a spike by the user in their own session): a `Stop` hook that long-polls our server and returns `{"decision":"continue","reason":"..."}` when a task arrives, gated on `fullyIdle: true`. The hook runs inside the user's own agy session and nothing external launches or drives agy, so it is within DDR-003 as written, but it is a synchronous park: Cursor, Codex and Devin precedents in switchboard show the TUI showing "Working" and deferring input during a long Stop hook (reported, USAGE.md:142,269,271 and FINDINGS section 6 for Devin). agy's `timeout` maximum, input behaviour, and whether Stop fires per turn are not documented. Do not ship without testing. Treat as the user's decision.

Stated fallback (as requested): if no hook-based park proves workable, the fallback is a background watcher started from inside the user's own agy session. Concretely, the user (or the agent at their request) starts a long-poll watcher process through agy's own shell tool, and tasks surface when that process completes or when a background-command completion re-enters the loop. Caveats: it must be started by the live agy session itself, never by our tooling; whether an idle agy resumes a turn on background-command completion is `unverified` (the Stop `fullyIdle` field says agy tracks "background commands or asynchronous tasks", which suggests it might, but nothing documents a wake); it would be per session, one-shot per task, and the model must re-arm it each time. Claude Code's equivalent (background Bash or Monitor) is measured in switchboard FINDINGS 2.6 and works (reported), so the pattern has precedent, but not for agy.

Reject for agy: `agy agentapi send-message` (zb-ss), any `tmux send-keys` (zb-ss `wake.json`, agentchattr, hcom from switchboard's prior-art table), any `agy -p` relay (agy-connect, lark bridge).

---

## 6. Summary table

| Candidate | License | Claude wake | agy | DDR-003 | A2A | Verdict |
|---|---|---|---|---|---|---|
| amahpour/switchboard | MIT, no riders | `asyncRewake` curl long-poll (15-min rounds) to server; stub-only; best hardening | none | compliant | none | borrow pattern |
| wilfreddenton/interlink | MIT, no riders | native socket default; legacy `asyncRewake` on a local file with 50-min model-turn renewal | none | compliant (Claude); `codex queue` out of scope | partial (task_id, status, `needs_input` = input-required) | borrow pattern |
| zb-ss/agent-group-mcp | MIT, no riders | `asyncRewake` local SQLite poll; raw text on stderr | `agy agentapi send-message` | violates for agy; `wake.json` tmux example | none | reject agy part; borrow Claude shape only |

## 7. Open items to verify with a hands-on spike (not done, read-only audit)

- Whether asyncRewake wakes count toward Claude Code's 8-continuation Stop cap.
- Exact `timeout` ceiling for asyncRewake on current Claude Code (switchboard reports 604800 works in config; behaviour at expiry is SIGTERM).
- Inbox-socket frame shape and `crossSessionInbound` behaviour for a host-side helper (docs vs interlink source).
- agy: maximum Stop-hook `timeout`, whether a held Stop hook blocks typing, whether Stop fires per turn, whether SessionStart fires on resume, whether a background shell command completion wakes an idle agy.
- Whether a remote HTTP MCP server can register as a Claude Code channel.
