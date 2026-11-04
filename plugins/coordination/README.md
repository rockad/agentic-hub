# coordination

An A2A (Agent2Agent 1.0.1) coordination server that lets live, side-by-side coding-agent sessions exchange tasks. Today that means Claude Code and Google Antigravity (`agy`) on one machine. Later it means remote agents connecting over HTTPS.

## Status

- **Planning only.** No server code, Dockerfile, hook script or `plugin.json` exists yet.
- **Next step: S0 spikes.** They test the unverified parts of the design (handle binding, Claude Code wake, agy hook behaviour) in scratch space. Spike code is never merged.
- Branch: `feat/coordination` in the `agentic-hub` repository.
- Decisions of 2026-11-04 (13 binding decisions from the `/clarify` session) are recorded in the plans under [`docs/plans/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/). Start with the consolidated plan.

## What it is

One server process, one SQLite database, several doors.

- The server speaks A2A 1.0.1 (all 11 core operations, JSON-RPC and REST) on top of `a2a-python` (>=1.3.0), using its `DatabaseTaskStore`.
- Each harness and machine has one Agent Card (`claude-code@alyx`, `antigravity@alyx`). Each live session has a handle under its card (`claude-code@alyx/<session-name>`).
  - Addressing a handle reaches that session.
  - Addressing a card reaches the newest live listener, otherwise the task is queued.
  - Handles are our extension; the mapping to A2A (`contextId` and `metadata`) is documented in the specs.
- Sessions use MCP tools served by the same process at `/mcp` (streamable HTTP). Write tools are behind an opt-in flag.
- Claude Code idle sessions are woken by an `asyncRewake` hook that long-polls `/wake/listen`. agy sessions are not woken while idle; they see pending tasks at the next model call (accepted asymmetry).
- Inbound tasks are parked, never auto-executed. A session takes a task with a tool call.

## Architecture

```
                         host: alyx (S1: 127.0.0.1 only)

  +-----------------------+                         +-----------------------------+
  | Claude Code session   |   MCP /mcp  ----------> |                             |
  |  claude-code@alyx/x   |   hooks: POST /sessions |   container  a2a-coord      |
  |  a2a-listen (hook)  --+-- POST /wake/listen --> |   127.0.0.1:8120            |
  +-----------------------+                         |                             |
                                                    |   /mcp                      |
  +-----------------------+                         |   /a2a/v1  (JSON-RPC + REST)|
  | agy session           |   MCP /mcp  ----------> |   /wake/listen              |
  |  antigravity@alyx/y   |   SessionStart,         |   /sessions                 |
  |  (no idle wake)       |   PreInvocation hooks   |   /status                   |
  +-----------------------+   -> /sessions, count   |   /.well-known/agent-card   |
                                                    |        .json                |
  +-----------------------+                         |                             |
  | cognitive-engine      |   POST /status -------> |   one process owns SQLite   |
  | (optional, one-way,   |   (status-client scope) |   (WAL, busy_timeout)       |
  |  off by default)      |                         |   volume a2a-data -> /data  |
  +-----------------------+                         +--------------+--------------+
                                                                   |
        S2: tailnet (tailscale serve): alyx, mac, core             |  /a2a/v1 only
        S3: public HTTPS via reverse proxy or tunnel (deferred) ---+  for remote peers
                                                                      (remote-peer scope)
  cognitive-engine model sessions (sbx) must never reach :8120.
```

Notes on the diagram:

- Everyone except the server uses HTTP. Only the server touches SQLite.
- Postgres later means changing the SQLAlchemy URL, nothing else.
- Every request carries a scoped bearer token, loopback included.
  - `local-harness`: `/mcp`, `/wake/listen`, `/sessions`, `/a2a/v1`.
  - `remote-peer`: `/a2a/v1` only.
  - `status-client`: `POST /status` only.
- Remote peers never reach `/mcp`, `/wake/listen` or `/sessions`.

### Exposure stages

- **S1, localhost.** `127.0.0.1:8120` on alyx. Gate: S0 spikes done.
- **S2, tailnet.** `tailscale serve` for own machines (alyx, mac, core). Gate: tokens and scopes live, cross-host wake works.
- **S3, public HTTPS.** Existing `bigrockad.com` reverse proxy or Cloudflare Tunnel, choice deferred. Gate: quarantine live, rate limits, fuzz pass (header smuggling, request splitting, SSRF), honest Agent Card, explicit user go.

`tailscale`, `cloudflared` and `caddy` are not installed on alyx today.

## Planned layout

Illustrative. Nothing below exists yet except `docs/`. The single illustrative layout is the tree in [`docs/specs/server-api.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/server-api.md) section 1.4 (`servers/coordination`, `bin/a2a-register`, `bin/a2a-listen`, `hooks/hooks.json`); the tree below is a rough sketch and does not override it. The final layout is open decision 3 in the plan.

```
plugins/coordination/
├── plugin.json
├── docker-compose.yml            # service a2a-coord, volume a2a-data -> /data, port 8120
├── README.md
├── AGENTS.md
├── servers/
│   └── a2a-coord/
│       ├── pyproject.toml        # uv project, a2a-python >=1.3.0
│       ├── Dockerfile
│       └── src/
│           └── a2a_coord/        # server, MCP tools, wake, auth, store, CLI (a2a-coord)
├── hooks/
│   ├── claude/
│   │   └── a2a-listen            # sh + curl long-poll script
│   └── agy/                      # SessionStart and PreInvocation hook scripts
└── docs/                         # plans, specs, research (exists now)
```

The `memory` plugin (`plugin.json`, `docker-compose.yml`, `servers/lookup`) is the structural reference only. This plugin does not depend on it.

## Documentation index

All links are absolute `file://` links.

### Start here

- [`docs/plans/consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md): the canonical plan: DDR-001 to DDR-004, the 13 decisions of 2026-11-04, and the S0-S3 roadmap.
- [`docs/research/a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md): synthesis of the third-party audit, wake mechanisms and cognitive-engine fit.

### Plans

- [`docs/plans/consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md)
- [`docs/plans/master-tasklist.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/master-tasklist.md)
- [`docs/plans/go-live-migration.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/go-live-migration.md): one-time import of the frozen channel files into the store, then deletion.
- [`docs/plans/claude-a2a-server-tasklist.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/claude-a2a-server-tasklist.md)
- [`docs/plans/2026-11-03-multi-agent-coordination-alignment.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/2026-11-03-multi-agent-coordination-alignment.md)

### Specs

- [`docs/specs/server-api.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/server-api.md): endpoints, handles, trust states, wake, auth.
- [`docs/specs/status-client.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/status-client.md): cognitive-engine status contract.
- [`docs/specs/spikes.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/spikes.md): S0 spikes and the S1 gate.
- [`docs/specs/buildslot-spec.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/buildslot-spec.md): Docker and GPU contention (cognitive-engine PR #13). Still in force.
- [`docs/specs/heartbeat-spec.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/heartbeat-spec.md): historical. Liveness is now a parked listener or a session registration.
- [`docs/specs/paf-trial-protocol-obsolete.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/paf-trial-protocol-obsolete.md): obsolete.

### Research

Audit of 2026-11-04:

- [`docs/research/a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md): synthesis.
- [`t1a-a2a-mcp-bridges.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1a-a2a-mcp-bridges.md): A2A bridges with an MCP facade, patterns to borrow.
- [`t1b-wake-mechanisms.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1b-wake-mechanisms.md): idle-session wake designs; Claude Code and agy hook documentation.
- [`t1c-bridges-and-sdks.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md): remaining bridges and the official A2A SDKs (`a2a-python` details and gaps).
- [`t2-cognitive-engine-integration.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md): cognitive-engine constraints.

Earlier research:

- [`docs/research/a2a-deep-dive-side-by-side-coordination.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-deep-dive-side-by-side-coordination.md)
- [`docs/research/a2a-deep-dive-verification-by-claude-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-deep-dive-verification-by-claude-2026-11-03.md)
- [`docs/research/claude-acp-a2a-findings-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/claude-acp-a2a-findings-2026-11-03.md)
- [`docs/research/r1-antigravity-terms-and-acp-gate-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/r1-antigravity-terms-and-acp-gate-2026-11-03.md)
- [`docs/research/r2-beads-concurrency-and-footprint-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/r2-beads-concurrency-and-footprint-2026-11-03.md)
- [`docs/research/r4-claude-code-hooks-and-wake-for-heartbeat-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/r4-claude-code-hooks-and-wake-for-heartbeat-2026-11-03.md)
- [`docs/research/bridge-v2-ecosystem-analysis.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/bridge-v2-ecosystem-analysis.md)
- [`docs/research/bridge-v2-nonfile-p2p-update.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/bridge-v2-nonfile-p2p-update.md)
- [`docs/research/AGENTS-EXCHANGE-RULES.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/AGENTS-EXCHANGE-RULES.md): rules for the retired file channel. Historical.

### Historical (from `agents-bridge`)

- [`docs/agents-bridge-README.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/agents-bridge-README.md): the old repository README. It still describes ACP and a zero-daemon core, both superseded.
- [`docs/agents-bridge-AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/agents-bridge-AGENTS.md): the old repository rules, carried over and updated into [`AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/AGENTS.md).

## History

This plugin replaces `~/projects/agents-bridge`, which is being retired. Its `docs/` tree was copied here unchanged, so nothing in the old repository is lost.

What changed on 2026-11-04:

- DDR-004 was accepted, which lifts the daemon and container restrictions.
- ACP was removed from the plan entirely.
- The file channel (`~/.agents/bridge-v2-coordination-channel.md` and the other `~/.agents` channel files) is frozen. After go-live, a one-time migration imports those files into this plugin's store and the channel is deleted.
- The old Phase 2 ledger forks, Phase 3 swarmail and Phase 4 ACP are superseded.

Still in force: the DDR-001 exclusions (`mcp_agent_mail_rust`), DDR-003 (never wrap agy), BuildSlot for Docker and GPU contention, and symmetric agency.

## Working in this plugin

Read [`AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/AGENTS.md) before touching anything.
