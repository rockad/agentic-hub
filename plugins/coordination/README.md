# coordination

An A2A (Agent2Agent 1.0.1) coordination server that lets live, side-by-side coding-agent sessions exchange tasks. That means Claude Code and Google Antigravity (`agy`) on the user's workstations (alyx, mac), later also remote agents connecting over HTTPS. It is a portable image; production runs on `core`, which is always on, so tasks wait there while the workstations are shut down.

## Status

- **Planning only, and planning is complete.** No server code, Dockerfile, hook script or `plugin.json` exists yet. There is no urgency.
- **Next step: S0 spikes on alyx.** They test the unverified parts of the design (handle binding, Claude Code wake, agy hook behaviour) in scratch space. Spike code is never merged.
- Branch: `feat/coordination` in the `agentic-hub` repository.
- Decisions of 2026-11-04 and 2026-11-05 are recorded in the plans under [`docs/plans/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/). Start with the consolidated plan.
  - 13 binding decisions from the `/clarify` session.
  - 12 more on 2026-11-05 (decisions 25 to 36): spike host changes under "borrow and put back", agy hooks in the user-level `~/.gemini/config/hooks.json`, the agy inbox instruction through `SessionStart` `injectSteps` (the installer never writes an `AGENTS.md`), hook scripts under `~/.local/share/a2a-coord/<version>/bin/`, card routing and discovery (a path per card plus a public front-desk card; member cards need an API key), strict `A2A-Version`, Claude key delivery from `~/.config/a2a-coord/api-key`, streaming and push deferred, and the go-live importer built during S2 and S3 under one final gate.
  - 11 more (decisions 14 to 24) on 2026-11-04: go-live after S3, admin access inside the container, one harness installer, per-machine API keys with a Tailscale identity check, per-peer remote keys, human-only quarantine release, the Cloudflare Tunnel on core as the public front door, research clones deleted, a 60 s cap on blocking `SendMessage`, production on core (a portable image; dev and spikes on alyx), and service-issued API keys that never enter chezmoi-managed files.
  - Nothing is waiting on a user decision. What remains is spike outcomes, and one design choice that falls due at S3 (the tunnel's listener port, plan section 7).

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
            host: alyx for S1 dev (127.0.0.1 only); core in production (S2, S3)

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
        S2: workstations alyx, mac over the tailnet                |  /a2a/v1 only
            (tailscale serve on core)                              |  for remote peers
        S3: public HTTPS, cloudflared on core -> localhost:8121 ---+  (remote-peer scope)
                                                                      (remote-peer scope)
  cognitive-engine model sessions (sbx) must never reach :8120.
```

Notes on the diagram:

- Everyone except the server uses HTTP. Only the server touches SQLite.
- Postgres later means changing the SQLAlchemy URL, nothing else.
- Every request carries a scoped bearer API key, loopback included.
  - `local-harness`: `/mcp`, `/wake/listen`, `/sessions`, `/a2a/v1`.
  - `remote-peer`: `/a2a/v1` only.
  - `status-client`: `POST /status` only.
- Remote peers never reach `/mcp`, `/wake/listen` or `/sessions`.
- Admin commands (`key create|list|rotate|revoke`, `review`) run inside the container, on whichever host runs it (core in production: `ssh core`, then `docker compose exec -it coordination a2a-coord ...`), over an in-container Unix socket that is not published on any port. There is no admin HTTP endpoint and no admin API-key scope. `review` needs a TTY, and only a human releases a quarantined task, one typed decision per task.
- Credentials are service-issued API keys (`a2ak_<env>_<keyid>_<secret>`, shown once, stored hashed). Claude Code's key lives in an unmanaged, mode-0600 `~/.config/a2a-coord/api-key` that the hooks read directly, exported as `A2A_API_KEY` by one non-secret chezmoi-managed shell line (with a `~/.claude.json` fallback if Claude Code does not expand env vars in MCP headers); agy's key is a literal in an unmanaged, mode-0600, user-level plugin file `~/.gemini/config/plugins/<name>/mcp_config.json` (verified in SP2 A8b; the plugin name must be unique across user and workspace scopes). Chezmoi-managed files never hold keys.
- Harness setup is one installer, `a2a-coord install --claude --agy`. It configures the non-secret parts through chezmoi where the files are chezmoi-managed, never writing the targets. Hook scripts are copied to `~/.local/share/a2a-coord/<version>/bin/` with a `current` symlink. agy hooks go in the user-level `~/.gemini/config/hooks.json`, and the agy inbox instruction comes from `SessionStart` `injectSteps`: the installer never writes any `AGENTS.md`. Nothing in it launches, drives or wraps agy.
- Agent Cards: one path per card, `/agents/<card>/.well-known/agent-card.json`, plus a public, generic "front desk" card at the root. Member cards need a valid API key. `A2A-Version` is strict. Streaming and push are off until a peer needs them.

### Exposure stages

- **S1, dev on alyx.** `127.0.0.1:8120` only. Gate: S0 spikes done.
- **S2, production on core.** `tailscale serve` on core; every workstation (alyx, mac) reaches core over the tailnet from day one, with one `local-harness` API key per harness per machine. The server checks the Tailscale identity matches the machine the key was issued for, for all harness keys including alyx's. Hooks on alyx and mac long-poll core over the tailnet (wake latency and tailnet dependency are risks). Gate: API keys and scopes live, cross-host wake works.
- **S3, public HTTPS.** The user's existing Cloudflare Tunnel (`cloudflared`) on core; the chosen hostname is `a2a.bigrockad.com`, but no route exists now (one was created and deleted on 2026-11-04; the hostname no longer resolves). The route is created only at S3, after the gate passes and on the user's explicit go. Only `/a2a/v1` and the card are to be routed. Decided 2026-11-09: the tunnel targets a dedicated loopback port (`localhost:8121`) that the server treats as the public listener, while 8120 stays tailnet-only. The server starts that listener from stage s2, on host loopback only, so its rules are tested before S3; the tunnel route is the exposure gate. Cloudflare sees decrypted traffic; the client IP comes only from `CF-Connecting-IP`, believed only for tunnel traffic; Cloudflare's request timeout of about 100 s is reported (unverified), so blocking `SendMessage` is capped at 60 s. Each remote peer holds its own API key, delivered out of band. Gate: quarantine live, rate limits, fuzz pass (header smuggling, request splitting, SSRF), honest Agent Card, explicit user go.
- **Rule:** never create the public route before the S3 gate and the user's explicit go. The 8121 listener itself runs from stage s2 on host loopback only, so nothing reaches it from outside until the route exists. If a route is created early for testing, it must sit behind a Cloudflare Access deny-all or service-token-only policy. S2 workstation traffic goes over the tailnet, not through the public hostname.
- **Go-live migration** (import and deletion of the old file channel) comes after S3.

`tailscale`, `cloudflared` and `caddy` are not installed on alyx today. The user's Cloudflare Tunnel runs on core (reported by the user).

## Planned layout

Illustrative. Nothing below exists yet except `docs/`. The single illustrative layout is the tree in [`docs/specs/server-api.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/server-api.md) section 1.4 (`servers/coordination`, `bin/a2a-register`, `bin/a2a-listen`, `hooks/hooks.json`); the tree below is a rough sketch and does not override it. The final layout is settled when S1 starts (plan section 7, design details).

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

- [`docs/plans/consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md): the canonical plan: DDR-001 to DDR-004, the 36 decisions of 2026-11-04 and 2026-11-05 (13 from `/clarify`, 11 later on 2026-11-04, 12 on 2026-11-05), and the S0-S3 roadmap.
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
- The file channel (`~/.agents/bridge-v2-coordination-channel.md` and the other `~/.agents` channel files) is frozen, with one exception: Antigravity may still use it for research on this work. Go-live is after S3; then a one-time migration imports those files into this plugin's store, a tar backup is taken, and the channel is deleted.
- The six research clones in `~/projects` were deleted on 2026-11-04; spec references use pinned GitHub URLs (plan section 8).
- The old Phase 2 ledger forks, Phase 3 swarmail and Phase 4 ACP are superseded.

Still in force: the DDR-001 exclusions (`mcp_agent_mail_rust`), DDR-003 (never wrap agy), BuildSlot for Docker and GPU contention, and symmetric agency.

## Working in this plugin

Read [`AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/AGENTS.md) before touching anything.
