# coordination

An A2A (Agent2Agent 1.0.1) coordination server that lets live, side-by-side coding-agent sessions exchange tasks. That means Claude Code and Google Antigravity (`agy`) on the user's workstations (<workstation>, mac), later also remote agents connecting over HTTPS. It is a portable image; production runs on `<storage-host>`, which is always on, so tasks wait there while the workstations are shut down.

## Status

- **S1 has started; planning-only is lifted for S1** (the user's go, 2026-11-11). The S0 spikes are done and the S1 entry gate is satisfied.
- **S1-SCAF is delivered:** `plugin.json`, `docker-compose.yml` (service `coordination` only), and `servers/coordination/` with the Dockerfile, `pyproject.toml`, `uv.lock`, the module skeleton (config, typed protocols, `/healthz`, an `a2a-coord` entry point) and tests. The Postgres service, the dump sidecar and every endpoint beyond `/healthz` are later S1 streams. The hook scripts, the plugin layout and the install commands came later (see Install and Layout).
- Branch: `feat/coordination` in the `agentic-hub` repository.
- Decisions of 2026-11-04 and 2026-11-05 are recorded in the master plan, [`docs/plans/master-plan.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-plan.md) (section 11), and in full in the archived consolidated plan. Start with the doc map, [`docs/README.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/README.md).
  - 13 binding decisions from the `/clarify` session.
  - 12 more on 2026-11-05 (decisions 25 to 36): spike host changes under "borrow and put back", agy hooks in the user-level `~/.gemini/config/hooks.json`, the agy inbox instruction through `SessionStart` `injectSteps` (the installer never writes an `AGENTS.md`), hook scripts under `~/.local/share/a2a-coord/<version>/bin/`, card routing and discovery (a path per card plus a public front-desk card; member cards need an API key), strict `A2A-Version`, Claude key delivery from `~/.config/a2a-coord/api-key`, streaming and push deferred, and the go-live importer built during S2 and S3 under one final gate.
  - 11 more (decisions 14 to 24) on 2026-11-04: go-live after S3, admin access inside the container, one harness installer, per-machine API keys with a Tailscale identity check, per-peer remote keys, human-only quarantine release, the Cloudflare Tunnel on <storage-host> as the public front door, research clones deleted, a 60 s cap on blocking `SendMessage`, production on <storage-host> (a portable image; dev and spikes on <workstation>), and service-issued API keys that never enter chezmoi-managed files.
  - Nothing is waiting on a user decision. What remains is spike outcomes, and one design choice that falls due at S3 (the tunnel's listener port, plan section 7).

## What it is

One server process, one SQLite database, several doors.

- The server speaks A2A 1.0.1 (all 11 core operations, JSON-RPC and REST) on top of `a2a-python` (>=1.3.0), using its `DatabaseTaskStore`.
- Each harness and machine has one Agent Card (`claude-code@<workstation>`, `antigravity@<workstation>`). Each live session has a handle under its card (`claude-code@<workstation>/<name>~<sid8>`, round-4 X1: `~` plus the first 8 hex characters of the session id).
  - Addressing a handle reaches that session.
  - Addressing a card reaches the newest live listener, otherwise the task is queued.
  - Handles are our extension; the mapping to A2A (`contextId` and `metadata`) is documented in the specs.
- Sessions use MCP tools served by the same process at `/mcp` (streamable HTTP). Write tools are behind an opt-in flag.
- Claude Code idle sessions are woken by an `asyncRewake` hook that long-polls `/wake/listen`. agy sessions are not woken while idle; they see pending tasks at the next model call (accepted asymmetry).
- Inbound tasks are parked, never auto-executed. A session takes a task with a tool call.

## Install

This directory is one plugin that both harnesses install with their own command (decisions Z20 and Z21). Each installs from the remote `main` of `rockad/agentic-hub`, never from a copied or symlinked folder, and neither install command edits a shared user-level file. The server must be running (`docker compose up`, port 8120) and you need a `local-harness` API key (`a2a-coord key create`, run on a TTY inside the container; the key is shown once).

The full path from a clean machine (prerequisites, secret files, the cards file, build and start, creating the keys, then the two installs below and `a2a-doctor`) is the [setup guide](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/runbooks/setup.md). Running it afterwards (backups, restore, key rotation, review, kill switches) is the [operations runbook](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/runbooks/operations.md).

### Claude Code

```sh
claude plugin marketplace add rockad/agentic-hub
claude plugin install coordination@agentic-hub
```

The plugin brings the hooks (`claude/hooks.json`: `a2a-register`, `a2a-listen`, `a2a-pending`) and the MCP entry `a2a-coord` (`claude/mcp.json`; the Claude manifest names both files, as Jev's does, so agy never sees a `hooks/hooks.json` or `.mcp.json` it would warn about; `http://127.0.0.1:8120/mcp`; the credential comes from a `headersHelper`, `${CLAUDE_PLUGIN_ROOT}/bin/a2a-mcp-headers`, which prints `{"Authorization":"Bearer <key>"}` from the key file below).

- Put the key in `~/.config/a2a-coord/keys/claude-code.key`: one line, the key, mode 0600, in a directory of mode 0700 (`install -d -m 700 ~/.config/a2a-coord/keys`, then `(umask 077; ${EDITOR:-vi} ~/.config/a2a-coord/keys/claude-code.key)`). The hooks and the MCP helper both read this one file, so **Claude has no second copy of its key**. There is no `A2A_API_KEY` to export and nothing reads it; a Claude Code started from a desktop launcher or an IDE works like one started from a shell.
- The helper is built by the key-files stream [design: `bin/a2a-mcp-headers` and the `claude/mcp.json` change]. What backs the approach: on 2026-11-24, with Claude Code 2.1.331, a plugin `headersHelper` that read a key file delivered its header, and a real model call of `a2a_hello` through such a helper on the real server returned `bound: true` with no `A2A_API_KEY` in the environment [verified, an experiment, not a test in this repository]. Claude Code runs the helper at session start and on reconnect, once more after a 401 or 403, with a 10 s limit and no caching [documented, Claude Code docs fetched 2026-11-24].
- The helper fails closed: on any problem it prints nothing and exits 1 [design].
- Rotating: write the new key to the same file. The hooks and the helper pick it up at once, with no restart [design, from the documented helper behaviour].
- Upgrading from the old layout: for one release the hooks still fall back to `~/.config/a2a-coord/api-key`, and `a2a-doctor` warns and shows how to migrate ([Key files](#key-files)).

### Antigravity (agy)

```sh
agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/coordination
```

**Unverified:** A8c ran `agy plugin install <path>` only. Installing from a GitHub tree URL has not been run (user's live-check list). `agy plugin validate --strict` exited 1 on three warnings before the Claude files moved into `claude/` (agy's own run, 2026-11-24, verified: `.mcp.json` never loaded, `hooks/hooks.json` ignored, `AGENTS.md` at the plugin root is not a rule); the first two are gone, and the third stays on purpose, because `AGENTS.md` is developer guidance for this folder. Re-run it to confirm.

The plugin brings the hooks (`hooks.json` at the plugin root: `./bin/a2a-agy-session` on `SessionStart`, `./bin/a2a-agy-pending` on `PreInvocation`). It brings **no** MCP entry and no key: agy expands only its own placeholders in a plugin's MCP config, not environment variables, so agy's entry is a user-scope server in your global `~/.gemini/config/mcp_config.json`, with the key as a literal `Authorization` header. Add this entry once (merge it into the existing `mcpServers` object by hand or with `agy mcp add`; the plugin never edits the file) and keep the file private:

```json
{
  "mcpServers": {
    "a2a-coord": {
      "type": "http",
      "url": "http://127.0.0.1:8120/mcp",
      "headers": {
        "Authorization": "Bearer a2ak_<env>_<keyid>_<secret>"
      }
    }
  }
}
```

```sh
chmod 600 ~/.gemini/config/mcp_config.json
```

The agy hooks read the key from the same file: the first `a2ak_` token in it (`A2A_AGY_KEY_FILE`, default `~/.gemini/config/mcp_config.json`). Keep that file out of any dotfiles repository and out of chezmoi (decision D24). Because the entry lives outside the plugin, `agy plugin uninstall` does not remove it.

### Settings file

Both harnesses read the machine's settings from `${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord/settings` (`A2A_SETTINGS_FILE` names another file), plain `KEY=value` lines. The file is outside the plugin, so installing, updating or reinstalling the plugin loses nothing. Every setting is optional.

```sh
# ~/.config/a2a-coord/settings
A2A_SERVER_URL=http://127.0.0.1:8120
A2A_CARD=claude-code@mybox
A2A_AGY_CARD=antigravity@mybox
A2A_KEY_FILE=/home/user/.config/a2a-coord/api-key
A2A_AGY_KEY_FILE=/home/user/.gemini/config/mcp_config.json
```

- Only these five names are read. Anything else, a comment (`#`), a blank line and a line without `=` is ignored.
- The file is read line by line and never sourced or evaluated. A value is literal text: `$HOME`, `~`, a backtick or `$(...)` are not expanded, so write absolute paths. One pair of surrounding single or double quotes is removed; a value over 512 bytes or with a control character is dropped.
- An environment variable that is set and not empty wins over the file; the first occurrence of a name in the file wins over a later one.
- A missing or unreadable file, a directory of that name, or a file you do not own (`test -O`) is ignored silently: another local user must not be able to point the hooks at their own listener. Keep the file mode 0600; [`a2a-doctor`](#doctor) reports a wider mode. The name is `settings`, not `config`: `~/.config/a2a-coord/config/` is where a hand-run server keeps its cards.
- `A2A_SERVER_URL` must be `http://` or `https://` with plain URL characters in every script (the Claude scripts check it now as the agy ones did), and curl is called with `--proto =http,https`, so a settings value can never become a curl option.

### Doctor

`bin/a2a-doctor` checks the install and says what to do. You run it by hand; it is not a hook and nothing calls it. Details, and what each check is tested by, are in [`docs/specs/doctor.md`](docs/specs/doctor.md).

```sh
<plugin folder>/bin/a2a-doctor              # every check
<plugin folder>/bin/a2a-doctor --no-network # skip the server section: no request at all
```

`<plugin folder>` is where the harness installed the plugin (the path is the harness's own and is not fixed here; it is the folder that holds `plugin.json` and `bin/`). The script finds `a2a-lib.sh` and the other scripts next to itself, so run it in place, not from a copy of the one file.

- It checks, in sections: the plugin files next to it and the plugin version; the settings file and the config directory (mode, owner, a directory of that name); the Claude key file (exists, mode, looks like a key) and whether `A2A_API_KEY` is set in your shell; the agy file (entry, url, `Authorization` header, key, mode, orphans: the old pre-Z20 `~/.gemini/config/plugins/coordination/mcp_config.json` and any other `a2a-` server in the global file); and the server (`GET /healthz`, then a probe session registered and ended again for each key it can use).
- It prints the two Claude install commands, the agy one and the agy MCP snippet, so the fix for each finding is on the screen.
- It edits **nothing**: no harness config, no settings file, no key file, no file at all. It never prints a key or any part of one, never puts a key in a command line or a child's environment (curl reads it on stdin), and never starts `claude` or `agy`. Every request has a 2 s connect and 5 s total limit.
- Output is plain ASCII, one line per check, prefixed `OK`, `WARN`, `FAIL` or `INFO`, and ends with `a2a-doctor: N FAIL, M WARN`. Exit status: 0 when there is no `FAIL`, 1 when there is at least one, 2 for a usage error.

```text
== Claude key ==
OK    Claude key file /home/user/.config/a2a-coord/api-key mode 600
OK    Claude key file first line looks like an a2a key
WARN  A2A_API_KEY is not set in this shell: Claude Code's MCP header needs it; export it from the key file in your shell rc, then restart Claude Code

== Server ==
INFO  effective server URL http://127.0.0.1:8120
OK    GET http://127.0.0.1:8120/healthz answered 200
OK    Claude key accepted: registered as claude-code@box/doctor-4242~3f2a9c1d
INFO  Claude probe session ended

a2a-doctor: 0 FAIL, 1 WARN
```

## Architecture

```
            host: <workstation> for S1 dev (127.0.0.1 only); <storage-host> in production (S2, S3)

  +-----------------------+                         +-----------------------------+
  | Claude Code session   |   MCP /mcp  ----------> |                             |
  |  claude-code@<workstation>/x   |   hooks: POST /sessions |   container  a2a-coord      |
  |  a2a-listen (hook)  --+-- POST /wake/listen --> |   127.0.0.1:8120            |
  +-----------------------+                         |                             |
                                                    |   /mcp                      |
  +-----------------------+                         |   /a2a/v1  (JSON-RPC + REST)|
  | agy session           |   MCP /mcp  ----------> |   /wake/listen              |
  |  antigravity@<workstation>/y   |   SessionStart,         |   /sessions                 |
  |  (no idle wake)       |   PreInvocation hooks   |   /status                   |
  +-----------------------+   -> /sessions, count   |   /.well-known/agent-card   |
                                                    |        .json                |
  +-----------------------+                         |                             |
  | cognitive-engine      |   POST /status -------> |   one process owns SQLite   |
  | (optional, one-way,   |   (status-client scope) |   (WAL, busy_timeout)       |
  |  off by default)      |                         |   volume a2a-data -> /data  |
  +-----------------------+                         +--------------+--------------+
                                                                   |
        S2: workstations <workstation>, mac over the tailnet                |  /a2a/v1 only
            (tailscale serve on <storage-host>)                              |  for remote peers
        S3: public HTTPS, cloudflared on <storage-host> -> localhost:8121 ---+  (remote-peer scope)
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
- Admin commands (`key create|list|rotate|revoke`, `review`) run inside the container, on whichever host runs it (<storage-host> in production: `ssh <storage-host>`, then `docker compose exec -it coordination a2a-coord ...`), over an in-container Unix socket that is not published on any port. There is no admin HTTP endpoint and no admin API-key scope. `review` needs a TTY, and only a human releases a quarantined task, one typed decision per task.
- Credentials are service-issued API keys (`a2ak_<env>_<keyid>_<secret>`, shown once, stored hashed). Claude Code's key lives in an unmanaged, mode-0600 `~/.config/a2a-coord/api-key` that the hooks read directly, exported as `A2A_API_KEY` by one non-secret shell line for the plugin's `claude/mcp.json` entry; agy's key is a literal `Authorization` header in a user-scope `a2a-coord` entry of the user's global `~/.gemini/config/mcp_config.json` (mode 0600, outside the plugin, Z20 and Z21), which the agy hooks also read. See [Install](#install). Chezmoi-managed files never hold keys.
- Harness setup is the harness's own plugin install (decisions Z20 and Z21): `claude plugin install coordination@agentic-hub` and `agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/coordination`, from the remote `main`. One shared `bin/` serves both: Claude's hooks call `"${CLAUDE_PLUGIN_ROOT}/bin/..."`, agy's call `./bin/...` (agy runs a plugin hook with the plugin folder as its working directory). The agy inbox instruction comes from `SessionStart` `injectSteps`: nothing writes any `AGENTS.md`, and nothing launches, drives or wraps agy.
- Agent Cards: one path per card, `/agents/<card>/.well-known/agent-card.json`, plus a public, generic "front desk" card at the root. Member cards need a valid API key. `A2A-Version` is strict. Streaming and push are off until a peer needs them.

### Exposure stages

- **S1, dev on <workstation>.** `127.0.0.1:8120` only. Gate: the S1 entry gate (SP1, SP2, SP3, SP4 recorded, SP5b; `docs/specs/spikes.md` section 11). Status 2026-11-10: S1 storage gate satisfied by SP5b (Postgres); the overall S1 entry gate was then satisfied on 2026-11-11 (SP3 passed, SP4 recorded) and the S1 kickoff approved.
- **S2, production on core.** `tailscale serve` on <storage-host>; every workstation (<workstation>, mac) reaches <storage-host> over the tailnet from day one, with one `local-harness` API key per harness per machine. The server checks the Tailscale identity matches the machine the key was issued for, for all harness keys including <workstation>'s. Hooks on <workstation> and mac long-poll <storage-host> over the tailnet (wake latency and tailnet dependency are risks). Gate: API keys and scopes live, cross-host wake works.
- **S3, public HTTPS.** The user's existing Cloudflare Tunnel (`cloudflared`) on <storage-host>; the chosen hostname is `<a2a-host>`, but no route exists now (one was created and deleted on 2026-11-04; the hostname no longer resolves). The route is created only at S3, after the gate passes and on the user's explicit go. Only `/a2a/v1` and the card are to be routed. Decided 2026-11-09: the tunnel targets a dedicated loopback port (`localhost:8121`) that the server treats as the public listener, while 8120 stays tailnet-only. The server starts that listener from stage s2, on host loopback only, so its rules are tested before S3; the tunnel route is the exposure gate. Cloudflare sees decrypted traffic; the client IP comes only from `CF-Connecting-IP`, believed only for tunnel traffic; Cloudflare's request timeout of about 100 s is reported (unverified), so blocking `SendMessage` is capped at 60 s. Each remote peer holds its own API key, delivered out of band. Gate: quarantine live, rate limits, fuzz pass (header smuggling, request splitting, SSRF), honest Agent Card, explicit user go.
- **S3 procedure** (decided 2026-11-09, R13): the flip to `A2A_EXPOSURE_STAGE=s3` is a deliberate human step, in this order. (1) The user runs the read-only `a2a-coord expose check`, which prints the S3 gate list and exits 0 when all conditions are met, 1 when at least one is unmet and 2 when it could not evaluate (decided 2026-11-10, X5: the server checks quarantine, per-key rate limits with the guess counter, `dump_age_h` below 36 h and port 8121 on host loopback only; fuzz report, honest card and extension URI are manual items until S3). (2) The user sets `A2A_EXPOSURE_STAGE=s3` and the public host in the compose environment and restarts the stack. (3) The server's `s3` start-up checks refuse to start if a condition fails. (4) The user then creates the Cloudflare Tunnel route to `127.0.0.1:8121`. There is no runtime admin command for the flip, and the stage is not derived from other configuration.
- **Rule:** never create the public route before the S3 gate and the user's explicit go. The 8121 listener itself runs from stage s2 on host loopback only, so nothing reaches it from outside until the route exists. If a route is created early for testing, it must sit behind a Cloudflare Access deny-all or service-token-only policy. S2 workstation traffic goes over the tailnet, not through the public hostname.
- **Go-live migration** (import and deletion of the old file channel) comes after S3.

`tailscale`, `cloudflared` and `caddy` are not installed on <workstation> today. The user's Cloudflare Tunnel runs on <storage-host> (reported by the user).

## Layout

One plugin directory for both harnesses (decisions Z20 and Z21). The server tree is `servers/coordination/` (package `coordination`).

```
plugins/coordination/
├── plugin.json                   # agy manifest (name, version, description)
├── .claude-plugin/plugin.json    # Claude Code manifest; same name, version and description; `hooks` and `mcpServers` point into claude/
├── hooks.json                    # agy hooks: group a2a-coord, SessionStart and PreInvocation, commands ./bin/a2a-agy-*
├── claude/hooks.json             # Claude hooks (named by the Claude manifest): "${CLAUDE_PLUGIN_ROOT}/bin/..." commands
├── claude/mcp.json               # Claude MCP entry a2a-coord (agy never sees it; there is no mcp_config.json here)
├── bin/
│   ├── a2a-lib.sh                # sourced settings reader (~/.config/a2a-coord/settings)
│   ├── a2a-register, a2a-listen, a2a-pending            # Claude hooks
│   ├── a2a-agy-session, a2a-agy-pending                 # agy hooks (agy only)
│   └── a2a-doctor                # run by hand: checks the install, edits nothing (no hook)
├── docker-compose.yml            # the server stack (port 8120)
├── servers/coordination/         # the server: uv project, Dockerfile, src, tests
├── config/cards.yaml
├── README.md
├── AGENTS.md
└── docs/                         # plans, specs, research
```

The version in `plugin.json`, `.claude-plugin/plugin.json` and the plugin's entries in `.claude-plugin/marketplace.json` and the root `marketplace.json` must be equal: `bun scripts/validate-manifests.ts` and `tests/test_plugin_layout.py` check it.

The `memory` plugin (`plugin.json`, `docker-compose.yml`, `servers/lookup`) is the structural reference only. This plugin does not depend on it.

## Documentation index

Links to files in this repository are absolute `https://github.com/rockad/agentic-hub/blob/main/...` URLs in this README, and relative links inside `docs/`. There are no `file://` links: this repository is public and a `file://` link would carry a local path.

### Set up and run it

- [`docs/runbooks/setup.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/runbooks/setup.md): the setup guide, from a clean machine to a working stage s1.
- [`docs/runbooks/operations.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/runbooks/operations.md): the operations runbook.
- [`docs/runbooks/backup.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/runbooks/backup.md): the dump sidecar, restore and the second restic job.

### Start here

- [`docs/README.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/README.md): the doc map. Two live planning documents, everything else is reference or archive.
- [`docs/plans/master-tasklist.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-tasklist.md): for a new session (Antigravity or another Claude Code session) taking over: how to pick up, status, milestones, todo, open items.
- [`docs/plans/master-plan.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-plan.md): the whole plan: workstreams and acceptance, decision records DDR-001 to DDR-004, the decision rounds, waves and the workflow process.
- [`docs/research/a2a-mcp-wake-audit-2026-11-04.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md): synthesis of the third-party audit, wake mechanisms and cognitive-engine fit.

### Plans

- [`docs/plans/master-plan.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-plan.md): the plan; section 9 is the go-live migration (one-time import of the frozen channel files into the store, then deletion) and section 10 the git history rewrite.
- [`docs/plans/master-tasklist.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-tasklist.md): status and todo.
- Archive: [`docs/archive/consolidated-bridge-v2-plan.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/consolidated-bridge-v2-plan.md) (the old canonical plan; the full text of decisions D1 to D40 and the risks), [`docs/archive/master-tasklist-through-2026-11-14.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/master-tasklist-through-2026-11-14.md) (the old tasklist).
- [`docs/archive/claude-a2a-server-tasklist.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/claude-a2a-server-tasklist.md)
- [`docs/archive/2026-11-03-multi-agent-coordination-alignment.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/2026-11-03-multi-agent-coordination-alignment.md)

### Specs

- [`docs/specs/server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md): endpoints, handles, trust states, wake, auth.
- [`docs/specs/doctor.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/doctor.md): `bin/a2a-doctor`, the install check: checks, output, exit codes, what is verified.
- [`docs/specs/status-client.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/status-client.md): cognitive-engine status contract.
- [`docs/specs/spikes.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/spikes.md): S0 spikes and the S1 gate.
- [`docs/specs/buildslot-spec.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/buildslot-spec.md): Docker and GPU contention (cognitive-engine PR #13). Still in force.
- [`docs/specs/heartbeat-spec.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/heartbeat-spec.md): historical. Liveness is now a parked listener or a session registration.
- [`docs/archive/paf-trial-protocol-obsolete.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/paf-trial-protocol-obsolete.md): obsolete.

### Research

Audit of 2026-11-04:

- [`docs/research/a2a-mcp-wake-audit-2026-11-04.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md): synthesis.
- [`t1a-a2a-mcp-bridges.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1a-a2a-mcp-bridges.md): A2A bridges with an MCP facade, patterns to borrow.
- [`t1b-wake-mechanisms.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1b-wake-mechanisms.md): idle-session wake designs; Claude Code and agy hook documentation.
- [`t1c-bridges-and-sdks.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md): remaining bridges and the official A2A SDKs (`a2a-python` details and gaps).
- [`t2-cognitive-engine-integration.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md): cognitive-engine constraints.

Earlier research:

- [`docs/research/a2a-deep-dive-side-by-side-coordination.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-deep-dive-side-by-side-coordination.md)
- [`docs/research/a2a-deep-dive-verification-by-claude-2026-11-03.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-deep-dive-verification-by-claude-2026-11-03.md)
- [`docs/research/claude-acp-a2a-findings-2026-11-03.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/claude-acp-a2a-findings-2026-11-03.md)
- [`docs/research/r1-antigravity-terms-and-acp-gate-2026-11-03.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/r1-antigravity-terms-and-acp-gate-2026-11-03.md)
- [`docs/research/r2-beads-concurrency-and-footprint-2026-11-03.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/r2-beads-concurrency-and-footprint-2026-11-03.md)
- [`docs/research/r4-claude-code-hooks-and-wake-for-heartbeat-2026-11-03.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/r4-claude-code-hooks-and-wake-for-heartbeat-2026-11-03.md)
- [`docs/research/bridge-v2-ecosystem-analysis.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/bridge-v2-ecosystem-analysis.md)
- [`docs/research/bridge-v2-nonfile-p2p-update.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/bridge-v2-nonfile-p2p-update.md)
- [`docs/research/AGENTS-EXCHANGE-RULES.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/AGENTS-EXCHANGE-RULES.md): rules for the retired file channel. Historical.

### Historical (from `agents-bridge`)

- [`docs/archive/agents-bridge-README.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/agents-bridge-README.md): the old repository README. It still describes ACP and a zero-daemon core, both superseded.
- [`docs/archive/agents-bridge-AGENTS.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/archive/agents-bridge-AGENTS.md): the old repository rules, carried over and updated into [`AGENTS.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/AGENTS.md).

## History

This plugin replaces `~/projects/agents-bridge`, which is being retired. Its `docs/` tree was copied here unchanged, so nothing in the old repository is lost.

What changed on 2026-11-04:

- DDR-004 was accepted, which lifts the daemon and container restrictions.
- ACP was removed from the plan entirely.
- The file channel (`~/.agents/custom/bridge-v2-coordination-channel.md` and the other `~/.agents/custom` channel files) is frozen, with one exception: Antigravity may still use it for research on this work. Go-live is after S3; then a one-time migration imports those files into this plugin's store, a tar backup is taken, and the channel is deleted.
- The six research clones in `~/projects` were deleted on 2026-11-04; spec references use pinned GitHub URLs (plan section 8).
- The old Phase 2 ledger forks, Phase 3 swarmail and Phase 4 ACP are superseded.

Still in force: the DDR-001 exclusions (`mcp_agent_mail_rust`), DDR-003 (never wrap agy), BuildSlot for Docker and GPU contention, and symmetric agency.

## Working in this plugin

Read [`AGENTS.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/AGENTS.md) before touching anything.
