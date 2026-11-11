Multi-Agent Bridge v2: Ecosystem Analysis & Live-Env Evaluation Spec
Target Project: rockad/cognitive-engine (~/projects/cognitive-engine)
Participating Harnesses: Claude Code ⇄ Google Antigravity CLI (agy)
Baseline Reference: ~/.agents/antigravity-claude-bridge-cognitive-engine.md & docs/handoffs/antigravity-claude-bridge.md (Bridge v1, built 2026-10-29/30)
1. Baseline Architecture Audit (Bridge v1 Summary)
The existing v1 protocol coordinates Claude Code and Antigravity CLI across isolated Git worktrees using three shared file primitives and an inotify loop:


* Transport Layer: A live append-only Markdown file outside the repository (~/.agents/antigravity-claude-bridge-cognitive-engine.md, moved out of the repo after docs/handoffs/antigravity-claude-bridge.md left a permanently dirty hub checkout and stale copies across branches), paired with milestone-only numbered "Turns" in docs/handoffs/antigravity-claude-bridge.md on dedicated docs branches.
* Shared State Files: A hand-edited task tracker (~/.agents/cognitive-engine-tasklist.md), a session/worktree mapping file (~/.agents/session-registry.json), and a shared review checklist (~/.agents/cognitive-engine-wsb-threat-model.md).
* Framing & Delivery: Column-0 fenced message blocks (---<agent> conversation <uuid> message <n> begin/end <ISO-8601>---) written atomically via temp-file concatenation (cat tmp >> channel) so inotify sees a single close_write event.
* Wake-Up & Execution Asymmetry: Claude Code runs an internal background Monitor that hits a hard 30-minute expiration limit (requiring manual or session-cron re-arming), whereas Antigravity runs a persistent watch-bridge.sh script with an awk extractor and state counter, but still requires a human nudge when its interactive session is idle.
2. Ecosystem Catalog: Open-Source Repos, Plugins, Buses & Protocols
Category A: Direct Claude Code ⇄ Antigravity CLI (agy) Plugins & Relays
Use these when one harness acts as the primary conductor and invokes the other on-demand or as a background job without file-polling loops.


Project / Repository
	Language / Type
	Core Capabilities & Relevance to cognitive-engine
	yuting0624/antigravity-for-claude-code
	Shell / Claude Code Plugin (v0.30.2)
	Adds /antigravity:delegate, /antigravity:handoff [--dir] [--tests], /antigravity:review [--adversarial], /antigravity:research, and /antigravity:status · :result · :cancel. Enforces a --digest output contract (with digest_warn_chars alerts) so Claude reads compact summaries instead of long free-text logs. Bounds headless agy -p calls with GNU timeout guards so hung executions return a clean TIMEOUT instead of silent 17+ hour stalls. Includes /antigravity:setup (agy-doctor) and path-scoped write rules in ~/.gemini/antigravity-cli/settings.json.
	keli-wen/agy-staff
	JavaScript / Cross-Harness Skill + Companion
	Exposes five specialized agy personas (staffer, researcher, reviewer, implementer, ask) plus /agy:jobs. Includes a companion/ background process manager that eliminates polling wake-ups—cutting Claude Code host token spend by 16% to 39% on multi-agent benchmarks.
	freibergergarcia/phone-a-friend
	Node.js / Multi-Agent CLI Relay
	Connects Claude Code, Antigravity (agy), Gemini CLI, Codex, OpenCode, pi, and Ollama with persistent multi-turn sessions, streaming output, cross-model diff reviews, and multi-model team dispatch. Preserves conversation state across turns rather than treating each delegation as a stateless one-shot CLI call.
	stellarlinkco/myclaude
	Go / Orchestration CLI
	Coordinates structured multi-agent workflows (sparv, omo, do) across Claude Code, Gemini, OpenCode, and Codex with automated verification gates.
	markfulton/claude-antigravity-agents & ProxyAyush/antigravity-fusion-plugin
	JS / Agent Definitions
	Lightweight sub-agent prompt definitions and routing rules for pairing Claude Code with Antigravity workspaces.
	Category B: Local MCP Coordination Servers (Peer-to-Peer Mailboxes & Leases)
Use these to keep both harnesses as independent, long-lived peers (essential for shifting implementation vs. review load based on 5-hour and weekly quota availability) while replacing the raw Markdown append file and regex fence parser.


Project / Repository
	Stack / Transport
	Core Capabilities & Relevance to cognitive-engine
	Dicklesworthstone/mcp_agent_mail_rust (supersedes Python mcp_agent_mail)
	Rust / FastMCP (Streamable HTTP + serve-stdio), SQLite WAL + FTS5 + Git
	Purpose-built drop-in replacement for Bridge v1. Provides 45 MCP tools and 25 read-only MCP resources (resource://inbox/..., resource://thread/...). Key primitives: 1. Advisory File Reservations (Leases) + Pre-Commit Guard: Agents reserve explicit file paths/globs with a TTL; a Git pre-commit guard blocks out-of-scope edits at commit time. 2. Build Slots: Built-in concurrency slot management to serialize shared resource usage (solving rootless Docker test suite collisions). 3. Stale Lock & Crash Recovery: PID checking automatically cleans up crashed agent locks; SQLite WAL + Git plumbing commit coalescer prevents index.lock contention. 4. 16-Screen TUI & Web UI: Live visibility into agent liveness, leases, and inboxes.
	dannystocker/mcp-multiagent-bridge
	Python / MCP + SQLite WAL
	Zero-dependency SQLite WAL bridge (create_conversation, send_to_partner, check_messages, update_my_status, check_partner_status). Features HMAC-SHA256 session tokens, session TTL/heartbeats, programmatic secret redaction, and 4-stage execution safeguards (safe read-only, restricted git/test validation, yolo sandboxed).
	TadMSTR/agent-bus
	Python / FastMCP + JSONL + NATS / ntfy
	Exposes log_event, query_events, get_event, and get_status. Writes structured inter-agent events (handoffs, review requests, build completions) to local JSONL files with optional NATS JetStream federation and native ntfy / webhook push notifications (solving the v1 human-gate notification blind spot).
	Category C: Git-Backed Task Ledgers & Multi-Worktree Multiplexers
Use these to replace the hand-edited ~/.agents/cognitive-engine-tasklist.md and eliminate Claude Code's 30-minute internal background Monitor limit.


Project / Repository
	Architecture
	Core Capabilities & Relevance to cognitive-engine
	steveyegge/beads (bd CLI) & steveyegge/gastown
	Go CLI + SQLite + Git-versioned JSONL
	Replaces hand-edited Markdown task trackers with a dependency-aware DAG issue tracker (bd ready, bd claim, bd update, bd close) paired with bv graph analytics (PageRank, critical path, cycle detection). Tasks bind directly to branch names and latest head SHAs (eliminating manual "supersedes earlier heads" prose). Integrates natively with mcp_agent_mail_rust (Beads owns task state/priority/cancellation; Agent Mail owns threaded review conversations). Gas Town adds Witness/Deacon health watchdogs and a Refinery merge queue across worktrees.
	cdknorow/coral
	tmux + Git Worktrees + Web/Mobile UI
	Runs Claude Code, Gemini/Antigravity CLI, Codex, and pi in isolated tmux sessions and Git worktrees. Provides a cursor-tracked message board (immune to 30-minute monitor timeouts), translates a single permission schema across both Claude and Antigravity configs, and serves a mobile QR dashboard for approving human-gate operations.
	BloopAI/vibe-kanban & smtg-ai/claude-squad
	Rust / Go Worktree Daemons
	Spin up dedicated Git worktrees and tmux panes per task card, dispatching work to Claude Code or Gemini/Antigravity CLI with explicit human review gates before branch merging.
	Category D: Industry Wire Protocols & Native Harness Primitives
* Agent2Agent (A2A) Protocol (a2aproject/A2A) & Official SDKs (a2aproject/a2a-python, a2a-rs, a2a-go, a2a-js): Linux Foundation / Google open specification using JSON-RPC 2.0 over HTTP/SSE. Defines AgentCard capability discovery and a strict task state machine (submitted → working → input-required / completed / canceled / failed). Adopting A2A's state transitions (canceled, input-required) directly resolves v1's missing cancellation and human-gate states.
* Agent Client Protocol (ACP) (agentclientprotocol/agent-client-protocol) & CMGS/gua: JSON-RPC 2.0 protocol over stdio or Unix domain sockets (gua-bridge) that drives coding CLIs deterministically, allowing an external daemon to wake an idle session on incoming messages without keeping an in-model inotify loop running.
* Claude Code Native Agent Teams (v2.1.32+): Enabled via CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1; uses ~/.claude/tasks/ lock files and a peer-to-peer mailbox. Native to Claude instances, but external harnesses like agy can bridge into it via a wrapper skill or shared MCP server.
3. Resolution Matrix: Mapping Bridge v1's 9 Weak Points to v2 Primitives
#
	Bridge v1 Weak Point (agent-bridge-protocol.md)
	Recommended v2 Solution
	Concrete Technical Mechanism
	1
	No liveness signal (no heartbeat or delivery receipt; 17+ hr silent stall)
	mcp_agent_mail_rust or mcp-multiagent-bridge
	Explicit acknowledge_message read receipts, SQLite agent heartbeat timestamps, PID-checked stale lock recovery, and GNU timeout guards on headless agy -p calls.
	2
	Monitor expiry (Claude Code's 30-min hard limit on background Monitors; idle agy requires human nudge)
	Host-Level Event Dispatcher (systemd --user / tmux bridge) or keli-wen/agy-staff
	Move inotify/SQLite polling out of Claude's internal Monitor tool into an external host daemon (bridge-dispatcher.service) that wakes the target agent via tmux send-keys or claude --resume <uuid> -p / agy only when an unread message lands.
	3
	Stale Git references (messages cite moving heads; manual "supersedes earlier heads" notes)
	steveyegge/beads (bd)
	Store target_branch and head_sha as mutable fields on the task bead (bd update <id> --head $(git rev-parse HEAD)). Pushing a fix atomically supersedes the prior SHA in SQLite.
	4
	No cancel, no priority, scope creep (delegate edited file outside allowed list)
	mcp_agent_mail_rust File Leases + Git pre-commit Hook
	Delegation A/B/C grants an explicit MCP file reservation lease on the allowed file list; a shared Git pre-commit hook verifies that all staged files match the active agent's lease and aborts out-of-scope commits automatically.
	5
	State drift (hand-edited cognitive-engine-tasklist.md + duplicated history in archive and Turns doc)
	steveyegge/beads + mcp_agent_mail_rust
	beads serves as the single source of truth for tasks; mcp_agent_mail_rust automatically persists canonical Markdown messages to Git while indexing in SQLite, eliminating manual dual-maintenance.
	6
	Shared resources (real-daemon test suites colliding on the single rootless Docker daemon)
	mcp_agent_mail_rust Build Slots + Docker Labels
	Require agents to acquire an exclusive MCP build slot (acquire_build_slot("rootless-docker", ttl=600)) before running real-daemon tests, and namespace containers with COMPOSE_PROJECT_NAME=cog-${AGENT_ID} so leak checks filter by label.
	7
	Mixed time zones (one side reports UTC quota times, the other local EET)
	Schema-Enforced MCP Status Tool
	Enforce UTC ISO-8601 (Z) normalization inside the MCP server's status/quota tool (quota_reset_utc), rejecting or auto-converting local offsets before storage.
	8
	Cost & lack of schema validation (long free-text blocks are expensive to read/write)
	MCP Resources (resource://thread/...) + --digest Contract
	Agents query only unread message IDs or structured review JSON schemas (severity | file:line | what | failing input | expected vs actual) rather than re-ingesting an entire append-only Markdown file.
	9
	Human gate blind spot (outward-facing actions wait for user approval without pinging the user)
	TadMSTR/agent-bus (ntfy) or MCP Approval Hook
	Transitioning a task to input-required (for PR creation, merges, force-push, or host <storage-host> account actions) triggers a desktop notification (notify-send) and/or webhook (Home Assistant / ntfy) to alert the user immediately.
	4. Live Environment Audit & Verification Protocol (For Claude Code & Antigravity CLI)
Step 1: Sync or Export from agents exchange
Sync or export this document to ~/.agents/bridge-v2-ecosystem-analysis.md so neither agent's Git worktree is dirtied.
Step 2: Live Environment Inspection Commands (Run in Either Worktree)
#!/usr/bin/env bash
set -euo pipefail


echo "=== 1. Harness & CLI Versions ==="
claude --version 2>/dev/null || echo "claude CLI not in PATH"
agy --version 2>/dev/null || antigravity --version 2>/dev/null || echo "agy CLI not in PATH"
bd --version 2>/dev/null || echo "beads (bd) not installed"


echo "=== 2. Runtime & Build Toolchains (for MCP / Rust / Python / Go) ==="
rustc --version 2>/dev/null || echo "rustc not installed"
cargo --version 2>/dev/null || echo "cargo not installed"
uv --version 2>/dev/null || python3 --version
node --version 2>/dev/null || echo "node not installed"
tmux -V 2>/dev/null || echo "tmux not installed"
inotifywait --help >/dev/null 2>&1 && echo "inotify-tools: available" || echo "inotify-tools: missing"


echo "=== 3. Current Bridge v1 State (~/.agents/) ==="
ls -lh ~/.agents/
wc -l ~/.agents/antigravity-claude-bridge-cognitive-engine.md ~/.agents/cognitive-engine-tasklist.md 2>/dev/null || true
cat ~/.agents/session-registry.json 2>/dev/null || true


echo "=== 4. Git Worktrees & Rootless Docker State ==="
git -C ~/projects/cognitive-engine worktree list
docker info --format 'Context: {{.Name}} | Rootless: {{.SecurityOptions}}' 2>/dev/null || echo "Docker daemon unreachable"
Step 3: Relay Prompts for Claude Code and Antigravity CLI
Prompt for Claude Code:


* Read ~/.agents/bridge-v2-ecosystem-analysis.md (or fetch from Drive agents exchange/bridge-v2-ecosystem-analysis.md) and inspect our current live setup in ~/.agents/ and ~/projects/cognitive-engine.
* Run the read-only environment check in Section 4 (Step 2) to verify our installed runtimes (cargo, uv, node, tmux, agy, claude).
* Evaluate Architecture Path 1 (Symmetric Peer-to-Peer via Dicklesworthstone/mcp_agent_mail_rust + steveyegge/beads + external tmux/systemd wake-up daemon) vs. Architecture Path 2 (Direct Sub-Agent Plugin via yuting0624/antigravity-for-claude-code or freibergergarcia/phone-a-friend) against our quota-balancing workflow, detached review worktrees, and rootless Docker test suite constraints.
* Post a structured bridge message to antigravity in ~/.agents/antigravity-claude-bridge-cognitive-engine.md proposing a concrete Bridge v2 migration plan and asking antigravity to review it from its harness perspective.


Prompt for Antigravity CLI (agy):


* Read ~/.agents/bridge-v2-ecosystem-analysis.md and Claude Code's latest message in ~/.agents/antigravity-claude-bridge-cognitive-engine.md.
* Audit the proposed Bridge v2 architecture from the Antigravity side—specifically verifying how agy handles MCP stdio/HTTP servers (mcp_agent_mail_rust), path-scoped write permissions (~/.gemini/antigravity-cli/settings.json), headless agy -p wake-ups vs. tmux session injection, and rootless Docker test slot locking.
* Reply in the bridge channel with ranked findings (accepted | declined | counter-proposal) so we can finalize the v2 cutover.