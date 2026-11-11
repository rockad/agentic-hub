# A2A coordination server: third-party audit, wake mechanisms and cognitive-engine fit (synthesis)

Author: Claude Code (session `agents-bridge-52`), 2026-11-04. Research only; nothing was built or installed. Clones were read in a scratchpad, never executed.

Inputs (full reports, copied into the repo):

- [`a2a-audit-2026-11-04/t1a-a2a-mcp-bridges.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1a-a2a-mcp-bridges.md): A2A bridges with an MCP facade.
- [`a2a-audit-2026-11-04/t1b-wake-mechanisms.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1b-wake-mechanisms.md): idle-session wake mechanisms and the official Claude Code and Antigravity hook docs.
- [`a2a-audit-2026-11-04/t1c-bridges-and-sdks.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md): remaining bridges, Docker Agent, official A2A SDKs.
- [`a2a-audit-2026-11-04/t2-cognitive-engine-integration.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md): answer from the `cognitive-engine` session.

Labels: **verified** (read in code or official docs by the auditor), **reported** (project README or PR text), **unverified**. The audits were run by Sonnet subagents; the labels are theirs.

## 1. Bottom line

- **Build, do not adopt or fork.** No existing project combines an A2A server, a persistent task store, per-session addressing, an MCP facade and a compliant wake. Every bridge either spawns agent CLIs as one-shot processes, has a single shared queue, is client-only, keeps tasks in memory, or is archived.
- **Build base: `a2a-python` 1.3.0** (Apache-2.0, all 11 core operations, about 1,700 tests, TCK in CI). It ships a SQL `DatabaseTaskStore` (SQLite via aiosqlite, Postgres, MySQL) and a "cluster mode" (versioned compare-and-swap store plus DB event stream) that lets the server, hooks and MCP facade run as separate processes on one database. Cluster mode is about five weeks old (verified in code, maturity unproven). Python also matches `cognitive-engine` (Python/uv). `a2a-js` 1.3.0 is the second choice (all 11 operations, DB stores only since 2026-09-29, in-process event bus, Bun unverified).
- **Claude Code wake is solved** by a borrowed pattern: an `asyncRewake` command hook on `SessionStart` and `Stop` that long-polls our server in 15-minute rounds and exits 2 only on a 200 stub (switchboard design, official hook semantics verified).
- **Antigravity wake is not solved.** The official hooks page documents no async, background or rewake option. Compliant options surface pending tasks at the next model call (`PreInvocation` `injectSteps`), not on an idle session. This is a known asymmetry to record, not hide.
- **cognitive-engine is a one-way status client only**, never a task provider; the server must reuse its `audit.jsonl` and never become a second approval path.
- **No license riders** in any assessable candidate (all plain MIT or Apache-2.0, verified; hieuntg81 not assessable).

## 2. Candidate matrix

| candidate | license | spawns or wraps agents | A2A | persistence | verdict |
| --- | --- | --- | --- | --- | --- |
| `toshiotomikawa/a2a-bridge` | MIT | yes: `agy -p`, `claude -p --resume`, `codex exec` (verified, `runners.py`) | 1.0, 4 of 11 ops, hand-rolled | JSON files | **reject** (DDR-003, live-session rule; remote text can reach `--dangerously-skip-permissions`, reported in README, at permission level `full`) |
| `mgcrea/mcp-a2a` | MIT | no (verified) | 1.0 on `@a2a-js/sdk`; inbound 4 ops, outbound 9 | one JSON file per task, no cross-process lock | **borrow patterns** (park inbound as SUBMITTED, write tools opt-in, peer endpoint only from card, Host/Origin checks); limits: one card per machine, shared queue, stdio only, loopback only, no cross-process lock |
| `TonPC64/mcp-a2a-bridge` | MIT | examples spawn `claude -p`, `copilot -p` | 1.0 client only, 5 tools | weak SQLite store in examples | **borrow patterns** |
| `GongRzhe/A2A-MCP-Server` | Apache-2.0 | no | pre-1.0 (`tasks/send`) | JSON files | **reject** (archived, last commit 2025-06, pre-1.0, no tests) |
| `hieuntg81/a2a-bridge` | n/a | n/a | n/a | n/a | **unauditable** (404; correct URL needed) |
| Docker Agent (cagent) | Apache-2.0 | its harness runs `claude --print` sub-agents | 1.0 on a2a-go | A2A task store in memory | **borrow patterns** |
| `amahpour/switchboard` | MIT | no | none | server-side | **borrow pattern** (best wake hardening) |
| `wilfreddenton/interlink` | MIT | no | loosely aligned states | per-session inbox | **borrow pattern** (stub-plus-ack delivery) |
| `zb-ss/agent-group-mcp` | MIT | agy wake via `agy agentapi send-message`; tmux example | none | SQLite | **reject agy part**, borrow Claude hook shape only |
| `a2a-python` 1.3.0 | Apache-2.0 | no | all 11 ops, JSON-RPC, REST, gRPC | SQLAlchemy DB stores, cluster mode | **adopt as build base** |
| `a2a-js` 1.3.0 | Apache-2.0 | no | all 11 ops | Kysely DB stores (new) | second choice |
| `a2a-go` 2.7.0 | Apache-2.0 | no | all 11 | in-memory in library; SQL store only in an example | not chosen (Go; language fit) |
| `a2a-rs` 0.x | Apache-2.0 | no | partial | in-memory only | not suitable |

## 3. Patterns to carry into our design

- **Park, never auto-execute.** Inbound tasks wait in `SUBMITTED` until a live session takes them with a tool call (mgcrea).
- **Stub-only wake.** The wake text is a fixed string such as `[a2a] N task(s) pending. Call a2a_inbox.`; the task body arrives only as a tool result, framed as data (switchboard, interlink). The injection surface of the wake itself is a constant.
- **Offered until confirmed.** The server keeps a task "offered" until the woken turn confirms it (`SUBMITTED` to `WORKING`); unconfirmed offers are re-offered after a crash or kill.
- **One parked listener per session**, newest wins (HTTP 409 to the old one), plus a server-side wake budget (switchboard 60 per room per hour, zb-ss 20 per agent per hour) to stop runaway loops.
- **Write tools behind an opt-in flag**; read tools always on (mgcrea `A2A_ALLOW_WRITES`).
- **Refuse non-loopback binds without a token**, constant-time bearer compare, Host and Origin checks, CORS allowlist (Docker Agent, mgcrea).
- **Honest Agent Cards**: declare `securitySchemes` actually enforced and only the capabilities implemented (mgcrea and Docker Agent both get this wrong).
- **Never take a peer's endpoint from anywhere but its card.**

## 4. Wake design

### 4.1 Claude Code (verified mechanism, reported hardening)

- `SessionStart` and `Stop`: one command hook, `asyncRewake: true`, long `timeout` (switchboard uses 604800), running a small `a2a-listen` script.
- The script long-polls `POST /wake/listen` with the session id, 900 s rounds. 200 prints the stub to stderr and exits 2. 408 loops. 409 exits 0 silently (superseded or busy). 410, 401 and 403 write a marker and wake the session once with a one-line reason (exit 2, marker-guarded so it cannot loop). 5xx and 429 back off. Exits when the owning Claude Code process dies.
- `UserPromptSubmit` (or `PostToolUse`) short HTTP hook returns `additionalContext` with the pending count, so tasks surface while a session is busy without a wake.
- Known failure modes (t1b section 5.1):
  - the hook `timeout` is enforced, so nothing re-arms until the next `Stop` or `SessionStart`
  - an Esc-interrupted turn fires no `Stop`
  - `claude -p`, IDE and desktop sessions are not woken (interactive CLI only)
  - a bug that exits 2 repeatedly loops the session about once per second, hence the server wake budget
- Minimum Claude Code about 2.1.290 (reported).
- Alternatives: the official cross-session inbox socket (no hook timeout, but host-local, not reachable from Docker, and held for approval in some permission modes) is worth a spike; Channels (`claude/channel`) stay an optional accelerator only (research preview, needs `--dangerously-load-development-channels`, silent drops on idle sessions in issue #61797 closed stale without a fix).

### 4.2 Antigravity (official page verified; no compliant wake)

- The hooks page lists six events with `command` handlers only (default timeout 30 s), and no async, background or rewake option, exit-code semantics or maximum timeout.
- **Compliant surfacing, not a wake**: a `PreInvocation` hook that calls the server (2 to 5 s) and returns `injectSteps` with the stub, so pending tasks appear at the next model call; an `AGENTS.md` rule to check the inbox at session start; an MCP `a2a_wait` tool for explicit blocking.
- **Possible held-Stop park (unverified, user's decision)**: a `Stop` hook gated on `fullyIdle: true` that long-polls and returns `{"decision":"continue","reason":...}`. It runs inside the user's own session, so it is within DDR-003 as written, but precedents in other harnesses show the TUI stuck on "Working" and deferring input during a long Stop hook. Needs a hands-on spike before anyone relies on it.
- **Fallback**: a background long-poll watcher started by the live agy session through its own shell tool, never by our tooling. Whether a background command finishing wakes an idle agy is unverified.
- **Rejected for agy**: `agy agentapi send-message`, any `tmux send-keys`, any `agy -p` relay.
- Hooks in agy at all remain the user's decision under DDR-003 and R8 (third-party software attached to the product); plain MCP tool use inside the user's own agy session is the lower-risk path.

## 5. Fit with cognitive-engine (from the cognitive-engine session; it read origin refs, not PR #13)

- **Role**: optional one-way status publisher. After each sweep, `stage1` posts the A2A task state plus a pointer to `report.json` (run id and path, never prompts or model text). It never receives tasks: `stage1 run` requires a human typing an approval phrase on a controlling terminal, and a remote "submit sweep" tool would bypass that gate.
- **State mapping** of the harness2 sweep lifecycle: plan = `submitted`; waiting for the typed approval = `input-required`; sessions running = `working`; sweep ends = `completed` or `failed`; gate refusal = `rejected`; human Ctrl-C = `canceled` (teardown non-interruptible).
- **Not mapped**: the slot table, the approval gate itself and the sbx policy (enforcement, not coordination). Jev dispatch is stateless routing; a server could call it as a tool.
- **Location of the client**: a separate optional adapter package on the existing adapter seam (like `adapters/claude`), keeping the deterministic core free of network clients. Whether the deterministic-core rule has a written form beyond RFC 001 is unverified.
- **Reuse, do not duplicate**: `audit.jsonl` (with `run_scope` ids) is the source of truth; the server mirrors from it. Watch R-18: `sessions_summary.denied_requests` counts path denials only, so no dashboard may show "denied = 0" from that field.
- **Agent Cards** belong to the long-lived Claude Code and Antigravity sessions, not to cognitive-engine's contained sessions.
- **Network**: model sessions must never reach the server; it must not be on the sbx one-host allow rule.
- **Ports (t2)**: avoid 8100 to 8110 (8100, 8101, 8105, 8110 in use or reserved) and 11434. Separately, this session (not the cognitive-engine session) checked `:8120` free on <workstation>-wsl on 2026-11-04 with `ss -ltn`; it is not reserved anywhere.
- **Never expose publicly**:
  - anything that starts a sweep or grants approval
  - credentials (OpenRouter key, the RFC 006 credential route, Claude and agy tokens)
  - run directories and transcripts
  - Jev config tools such as `jev_set_mode`
- Wake-ups carry status only, never an approval or a command. If tokens ever sit behind the server, treat it as a proxy-class surface (header smuggling, request splitting, SSRF; fuzz it, per RFC 006 section 3).

## 6. Gaps we would have to fill on top of a2a-python

- SQLite hardening: WAL mode and busy timeout (not handled by the SDK).
- Inbound auth middleware and matching `securitySchemes` on the card.
- Push-notification SSRF screening (the SDK validator is opt-in, default off).
- The wake endpoint (`/wake/listen`) and per-session listener table.
- The MCP facade (streamable HTTP so both harnesses reach the same server).
- TLS termination behind a reverse proxy for any non-loopback exposure.

## 7. Open questions and spikes

- Correct URL for the hieuntg81 Go bridge, or drop it.
- MCP facade placement: in the container sharing the database (cluster mode), or on each session's host as an HTTP-only client of the server. Recommendation: facade as a thin HTTP client on the host, server alone owns the database; this works the same for agy and Claude Code and survives the later move to tailnet or public exposure.
- Spikes (none run; read-only audit):
  - whether `asyncRewake` wakes count toward Claude Code's Stop continuation cap
  - inbox-socket frame shape and `crossSessionInbound` behaviour for a host-side helper
  - agy:
    - maximum Stop-hook timeout
    - whether a held Stop hook blocks typing
    - whether Stop fires per turn
    - whether SessionStart fires on resume
    - whether a background command completion wakes an idle session
  - whether a remote HTTP MCP server can register as a Claude Code channel
  - SQLite cluster mode under the hook, facade and server write pattern
