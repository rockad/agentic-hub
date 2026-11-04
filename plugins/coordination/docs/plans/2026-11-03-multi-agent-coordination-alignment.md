---
project: rockad/cognitive-engine
author_agent: antigravity-cli
target_agent: all
host_origin: linux/alyx
timestamp_utc: 2026-11-03T10:50:00Z
git_branch: main
git_head_sha: N/A
status: input-required
supersedes: N/A
---

# Multi-Agent Coordination Protocol Alignment: Scaling to N > 2 Agents

## 1. Context & Problem Statement

The user has highlighted that while the local workspace currently runs two primary coding agents (Claude Code and Google Antigravity CLI), the target architecture must support **arbitrary N-agent collaboration** (N > 2).

### Why Pairwise Coordination Files Break at N > 2
- **Quadratic Mesh Explosion**: A pairwise append-file model requires $O(N^2)$ communication channels ($N(N-1)/2$).
- **Single Broadcast Lock Contention**: Merging all agents into a single append file results in race conditions during concurrent turn flushes, excessive context consumption (agents must parse and discard irrelevant messages), and no delivery receipts.
- **Resource Contention**: Multiple agents running in parallel worktrees collide on local singletons (the rootless Docker daemon, network ports, GPU devices) without centralized semaphores or build slots.
- **Scope Creep & Write Collisions**: Without advisory file reservation leases, parallel agents risk modifying overlapping files across detached worktrees.

---

## 2. Deep Dive: Preferred Focus Area 1 — Local MCP Coordination Servers

Local MCP coordination servers allow long-lived, heterogeneous agent sessions across harnesses (Claude Code, Antigravity, OpenCode, Codex) to communicate via standard Model Context Protocol (MCP) tool calls and streaming resources.

### Option 1: `Dicklesworthstone/mcp_agent_mail_rust` (Postal Mailbox + Leases + Slots)
- **Topology**: Star topology with an agent mailbox server.
- **N-Agent Scalability**:
  - Each agent registers an identity (`agent_name`).
  - Native multi-agent addressing:
    - Directed messages: `to: ["agentA", "agentB"]`
    - Carbon copy: `cc: [...]`
    - Threaded discussions: `thread_id` and `reply_to`
  - Per-agent MCP resources: `resource://inbox/{agent_name}` and `resource://thread/{thread_id}`.
- **Distributed Resource Arbitration**:
  - **Advisory File Reservations (Leases)**: Agents acquire time-bounded leases (with TTL) on file paths or glob patterns. Staged edits outside an active lease can be blocked by a Git pre-commit guard.
  - **Build Slots**: Built-in semaphore management (`acquire_build_slot("rootless-docker", ttl=600)`), preventing test suite collisions across parallel worktrees.
  - **Crash Recovery**: PID checking and automatic lease expiration cleanly handle crashed or rate-limited sessions.
- **Storage & Overhead**:
  - High-performance Rust backend.
  - SQLite WAL + FTS5 indexing.
  - Automatic Git plumbing commits coalesced into a dedicated branch for durable history.

### Option 2: `TadMSTR/agent-bus` (Pub/Sub Event Bus)
- **Topology**: Publish-Subscribe Event Bus over FastMCP + JSONL.
- **N-Agent Scalability**:
  - Agents publish structured events (`log_event`) with topic tags.
  - Subscriber agents filter and query events (`query_events`) matching domain patterns.
  - Optional NATS JetStream federation allows events to bridge across local workstations and remote servers (`core`).
- **Human Gate Integration**:
  - Native support for webhook and `ntfy` push alerts, immediately alerting the human when any agent sets `status: input-required`.

---

## 3. Deep Dive: Preferred Focus Area 2 — Industry Wire Protocols

### Option 1: Agent2Agent (A2A) Protocol (`a2aproject/A2A`)
- **Origin**: Linux Foundation / Google open specification.
- **Transport**: JSON-RPC 2.0 over HTTP/SSE.
- **N-Agent Scalability**:
  - **AgentCard Dynamic Discovery**: Agents publish capabilities, input/output schemas, and authentication endpoints at `/.well-known/agent.json`.
  - Open network: Any agent can query the network to find capable specialists (e.g. formal verifier, fuzz tester, review judge).
- **Formal Task State Machine**:
  - States: `submitted` → `working` → `input-required` / `completed` / `canceled` / `failed`.
  - Cleanly solves the missing cancellation and human approval states in Bridge v1.
- **Official SDKs**: Available in Rust (`a2a-rs`), Python (`a2a-python`), TypeScript (`a2a-js`), and Go (`a2a-go`).

### Option 2: Agent Client Protocol (ACP) (`agentclientprotocol/agent-client-protocol`)
- **Transport**: JSON-RPC 2.0 over stdio or Unix domain sockets.
- **N-Agent Scalability**:
  - Designed for deterministic control of coding CLI engines.
  - Allows an external supervisor daemon to drive multiple agent engines concurrently without keeping LLMs in idle polling loops.

---

## 4. Integration Analysis: How and Where it Fits `cognitive-engine`

### Architectural Layering
- **Transport Layer (External Infrastructure)**:
  - The coordination server daemon (e.g. `mcp_agent_mail_rust` or an A2A router) should reside in `agentic-hub/plugins/coordination` or the local daemon compose stack (alongside `lookup` :8100 and `recall` :8110).
  - This keeps the physical transport decoupled and reusable across workspaces.
- **Substrate Layer (Inside `cognitive-engine`)**:
  - Implement a dedicated coordination adapter package in `cognitive-engine`:
    - E.g. `adapters/coordination/` or `packages/coordination/`.
    - Exposes typed task abstractions to System 1 (`packages/jev`) for pre-flight batch routing (`jev_batch_dispatch`).
    - Exposes file leases, build slots, and A2A task states to System 2 (`packages/harness2`) when running parallel worktree solvers.

---

## 5. Alignment Questions for Active Sessions & Claude Code

1. **Coordination Architecture Preference**:
   - Do you favor **Local MCP Mailbox (`mcp_agent_mail_rust`)** with advisory file leases and build slots, or **Wire Protocol (`A2A`)** with dynamic AgentCards, or a hybrid (MCP tools bridging into an A2A bus)?
2. **Resource Arbitration in Worktrees**:
   - For multi-agent test execution, would file-level reservation leases and build slots adequately solve our rootless Docker and detached worktree collisions?
3. **Daemon Placement**:
   - Does placing the daemon in `agentic-hub` / compose and exposing typed contracts in `cognitive-engine` align with our repository boundaries?
