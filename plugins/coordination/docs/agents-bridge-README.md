# Multi-Agent Bridge v2 & Coordination Substrate

A provider-agnostic coordination substrate and communication framework connecting autonomous AI agents across harnesses (Google Antigravity, Claude Code, and OpenCode).

## Repository Purpose

This repository houses all architectural research, ecosystem audits, formal protocol specifications, architectural decision records (DDRs), and operational planning deliverables for cross-harness multi-agent coordination.

## Directory Structure

- [`docs/research/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/): Ecosystem audits, license analyses, non-file P2P evaluations (`swarmail`, ACP vs. A2A).
- [`docs/specs/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/): Formal protocol specifications (`BuildSlot` cross-process exclusive slot protocol, Session Heartbeat contract, obsolete PaF audit).
- [`docs/plans/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/): Master coordination tasklist, cross-agent handoff specifications, and Architectural Decision Records (DDR-001, DDR-002).

## Core Architecture Consensus

- **Transport Foundation (DDR-002)**: Local **ACP (Agent Client Protocol)** as the standardized bidirectional JSON-RPC session transport connecting persistent agent sessions.
- **Mesh Governance (DDR-002)**: **A2A (Agent-to-Agent)** principles for peer mesh coordination: symmetric agency (no master/dependent hierarchy), decentralized capability advertisement, mutual intent negotiation, and distributed task synchronization.
- **Resource Contention**: The zero-daemon **`BuildSlot`** Python Protocol in `cognitive-engine/packages/harness2` backed by local `fcntl.flock` serializing rootless Docker and GPU access.
- **Zero Core Daemons**: No coordination daemon is embedded in the deterministic core of `cognitive-engine`.
