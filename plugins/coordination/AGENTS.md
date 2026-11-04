# AGENTS.md

Rules for Google Antigravity, Claude Code and any other AI coding assistant working in `plugins/coordination`. Carried over from the old `agents-bridge` rules ([`docs/agents-bridge-AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/agents-bridge-AGENTS.md), kept as history) and updated for the 2026-11-04 decisions.

## Read first

- Read [`docs/plans/consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md) before doing any work here.
- The plan records DDR-004 (accepted 2026-11-04) and its 22 binding decisions (13 from the `/clarify` session, 14 to 22 from the `/cplain` session); they override anything older in `docs/`. Superseded:
  - DDR-002 file-channel carrier and ACP
  - old Phase 2 ledger forks A and B
  - Phase 3 swarmail
  - Phase 4 ACP
  - the heartbeat sidecar files (liveness is now a parked listener or a session registration; [`docs/specs/heartbeat-spec.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/heartbeat-spec.md) is historical)
- Overview and layout: [`README.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/README.md).
- Evidence: [`docs/research/a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md).

## What this plugin is

An A2A 1.0.1 coordination server (Python, `a2a-python` >=1.3.0, uv, Docker) on port 8120. It serves `/mcp`, `/a2a/v1`, `/wake/listen`, `/sessions`, `/status` and `/.well-known/agent-card.json`. One server process owns the SQLite database; everyone else uses HTTP. It lives only in this plugin, on branch `feat/coordination`. The `memory` plugin is a structural reference only; never depend on it.

## Status rules

- **Planning only** until the user lifts it. Write documents, not product code.
- Implementation is allowed only where strictly necessary for a spike.
  - Spike code lives in a scratch directory and is never merged.
  - Do not add `plugin.json`, Dockerfiles, hook scripts, config files or marketplace entries as real files unless the user says so.
  - Do not install anything (no `tailscale`, `cloudflared`, `caddy`) without being asked. The user's Cloudflare Tunnel on core already exists; do not edit its configuration.
  - Do not write harness hook or MCP configuration by hand or by script. The planned installer `a2a-coord install --claude --agy` does that later, only when the user runs it, and it edits chezmoi-managed dotfiles through chezmoi (edit the chezmoi source, then apply), never the targets (decision 16).
- Do not commit or switch branches unless the user asks.

## Architectural conventions

- **Symmetric agency.** All communicating agents are equals. Master/dependent and caller/subordinate patterns are prohibited. Either side can open tasks to the other.
- **Live persistent sessions only.** Transports connect long-lived interactive sessions with warm context. One-shot subprocess transports (`claude -p`, `agy -p`, `agy --prompt`) are prohibited.
- **Never launch, drive or wrap agy (DDR-003).**
  - No `agy -p`, no PTY, no `tmux send-keys`, no `agentapi`, no relay of any kind.
  - Claude Code and agy run side by side as independent peers.
  - Nothing in this plugin may start, steer or wrap an agy process.
- **Restrictive-terms rule applies symmetrically.** Skip any option whose terms restrict Claude Code, and apply the same test to Antigravity. No design may depend on access patterns that Google's terms or official FAQs prohibit.
- **No ACP.** It is removed from the plan. A2A principles govern capability advertisement, task negotiation and task states. The states are the A2A 1.0.1 enum names:
  - `TASK_STATE_SUBMITTED`
  - `TASK_STATE_WORKING`
  - `TASK_STATE_INPUT_REQUIRED`
  - `TASK_STATE_COMPLETED`
  - `TASK_STATE_CANCELED`
  - `TASK_STATE_FAILED`
  - `TASK_STATE_REJECTED`
  - `TASK_STATE_AUTH_REQUIRED` is never produced.
  - `QUARANTINED` is our extension. The sender sees it as `INPUT_REQUIRED`.
- **Handles are our extension.** `claude-code@alyx/<session-name>` is not an A2A concept. Keep the mapping to `contextId` and `metadata` documented.
- **Decoupled from cognitive-engine.** Its deterministic core gets no network client. Any status client is an optional adapter package, off by default, built only on the user's go.
- **Still in force.**
  - DDR-001 exclusions (`mcp_agent_mail_rust`).
  - BuildSlot (cognitive-engine PR #13) for Docker and GPU contention.

## The frozen file channel

- `~/.agents/bridge-v2-coordination-channel.md` and the other `~/.agents` channel files are frozen. Nobody uses them.
- Do not post to them, append to them or poll them.
  - **One exception (decision 14): Antigravity may still use the channel for research on this work.** No other agent does.
- Go-live is after S3, the public stage. Then a one-time migration imports the files into the plugin's store, a tar backup is taken, and the channel is deleted. That is a later task and needs the user's go.

## Security invariants

These hold in every design, spec and spike.

- **Wake text is a constant stub**, for example `[a2a] N pending. Call a2a_inbox.` Task bodies reach a session only as tool results, never in a hook output or wake line.
- **Bodies are untrusted data.** Frame them as data. A body is never an approval and never a command. Tasks are parked, never auto-executed.
- **Trust by origin.**
  - Own local handles: `SUBMITTED`.
  - Allowlisted remote (a peer that holds a `remote-peer` token): `QUARANTINED` until a human releases it with `a2a-coord review` on a real TTY, one typed decision per task. No code path releases a task automatically: no rules, no agent pre-screen (decision 19).
  - Unknown remote: `REJECTED`.
- **Auth.** Scoped bearer tokens (`local-harness`, `remote-peer`, `status-client`), shown once, stored hashed. Loopback still needs a token. `remote-peer` never reaches `/mcp`, `/wake/listen` or `/sessions`.
  - Own machines on the tailnet (mac, core) get one `local-harness` token each with their own cards, and the server also checks the Tailscale identity matches the machine the token was issued for (decision 17).
  - Remote peers hold per-peer tokens: hashed, revocable, rate-limited (decision 18).
- **Admin access.** `a2a-coord` admin commands run inside the container (`docker compose exec -it coordination a2a-coord ...`) over an unpublished in-container Unix socket. Never add an admin HTTP endpoint or an admin token scope (decision 15).
- **Public front door (S3).** The user's existing Cloudflare Tunnel on core, routing only `/a2a/v1` and the Agent Card. Cloudflare sees decrypted traffic. Trust `CF-Connecting-IP` only for requests arriving from the tunnel. Blocking `SendMessage` is capped at 60 s (decisions 20 and 22).
- **Never expose, on any interface or stage:**
  - anything that starts a sweep or grants approval
  - credentials (OpenRouter key, the RFC 006 credential route, Claude and agy tokens)
  - run directories and transcripts
  - Jev config tools such as `jev_set_mode`
- **The server is never a second approval path.** cognitive-engine `audit.jsonl` stays the source of truth. cognitive-engine never receives tasks.
- **Status contract carries no model data.** Only `run_id`, `run_scope`, `state`, `report_path`, `ts`. Never prompts, model text, transcripts or denial counts (R-18: `sessions_summary.denied_requests` counts path denials only).
- **cognitive-engine model sessions (sbx) must never reach the server.** It is not on the sbx allow rule.
- **No non-loopback bind without TLS proxy config.** Do not propose one.
- Label every claim from the audit as verified, reported or unverified, as the audit did. Do not upgrade a label without reading the source.

## Tool discipline

- Use purpose-built tools before ad-hoc Python glue.
  - `jq` for JSON
  - `yq` for YAML, TOML and XML
  - `mdq` for Markdown structure
  - `rg` for searching a tree
  - `fd` for finding files
  - `sd` for bulk text replacement
- Edit existing files with the harness edit tool, not a Python read-replace-write.
- If a tool is missing, say so and stop; do not substitute silently.
- Real Python goes through `uv`, and only as checked-in tooling or a spike in scratch.

## Writing style

- Vertical markdown lists only. No inline enumerations such as `(1) a, (2) b`, and no long comma lists of items.
- Use absolute `file://` links for files in this repository, for example `file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/...`.
- Plain, direct English. Concrete over padded.
