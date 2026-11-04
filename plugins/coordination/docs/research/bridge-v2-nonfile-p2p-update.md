________________


project: rockad/cognitive-engine author_agent: gemini-workspace target_agent: all host_origin: cloud timestamp_utc: 2026-11-03T15:15:00Z git_branch: docs/bridge-v2-update git_head_sha: N/A status: ready-for-pickup supersedes: bridge-v2-ecosystem-analysis.md
Multi-Agent Bridge v2: Non-File P2P & Multi-Agent Scaling Update (OpenCode, MCP, ACP, A2A)
5. Non-File Peer-to-Peer Protocols & Multi-Agent Scaling (OpenCode, MCP, ACP, A2A)
A. Non-File Peer-to-Peer Architectures (Symmetric P2P)
Eliminating file- and Git-based append channels in favor of true non-file P2P coordination leads to two primary SQLite/FastMCP engines:


1. bompus/swarmail: A zero-dependency Bun binary running locally (127.0.0.1:18765) backed by SQLite. It provides named peer sessions, threaded mail, broadcast channels, and advisory file reservations with native wake-on-mail hooks for Claude Code, Antigravity, and OpenCode.
2. Dicklesworthstone/mcp_agent_mail_rust: A Rust FastMCP server (HTTP + stdio) over SQLite WAL + FTS5. It features 45 MCP tools, 25 read-only resources (resource://inbox/..., resource://thread/...), PID-checked crash recovery, and Build Slots to serialize shared rootless Docker test runs across agents.
B. Scaling to 3+ Peers (Adding OpenCode)
Moving beyond a 2-party dyad to include OpenCode (opencode):


* Shared Leases & Build Slots: All three agents (claude, agy, opencode) connect to the same SQLite WAL database, honoring advisory file reservations to prevent scope creep and locking the Docker build slot during containerized test runs.
* Native ACP Support: Unlike Claude Code (which relies on background monitors or terminal injection), OpenCode natively supports the Agent Client Protocol (opencode acp), allowing an external daemon to wake and drive OpenCode deterministically over JSON-RPC 2.0 without polling loops or 30-minute monitor expirations.
C. Wire Protocols: ACP vs. A2A
* Agent Client Protocol (ACP): The production standard for local CLI harnesses. Connects editors/daemons to coding agents over stdio or Unix domain sockets (gua-bridge), enabling programmatically driven sessions with zero polling overhead.
* Agent2Agent (A2A): Linux Foundation standard (JSON-RPC 2.0 / HTTP / SSE) with cryptographically signed AgentCard discovery and a strict task state machine (submitted -> working -> input-required / completed / canceled / failed). Best reserved for cross-cloud federated meshes rather than single-machine local agent clusters.