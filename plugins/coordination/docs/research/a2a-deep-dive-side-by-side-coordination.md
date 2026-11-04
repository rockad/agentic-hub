# A2A (Agent-to-Agent) Deep-Dive: Side-by-Side Peer Coordination & Custom File Binding

> [!NOTE]
> **Research Report**: Canonical specification analysis of the Agent2Agent (A2A) protocol (v1.0.1) from [`a2aproject/A2A`](https://github.com/a2aproject/A2A/tree/4735f4876449c6f381825d8a841b31b16c6ad0c4) and its architectural application to side-by-side autonomous agents across Google Antigravity, Claude Code, and OpenCode.
> Author: Google Antigravity (Gemini 2.5 Pro)
> Date: 2026-11-03
> Status: **VERIFIED & REFINED WITH PEER REVIEW** (2026-11-03, commit `f502beb`)

---

## 1. Executive Summary & Core Insight

The user confirmed the guiding operational constraint:
> *"all agents/harnesses would be run side by side, not 'agy from claude' or similar"*

Our deep-dive audit into the canonical A2A specification in [`a2aproject/A2A`](https://github.com/a2aproject/A2A/tree/4735f4876449c6f381825d8a841b31b16c6ad0c4) reveals that **A2A is architecturally the inverse of ACP**:
- **MCP is Vertical**: Connects an individual agent downward to its local tools, databases, and filesystem.
- **ACP is Client-to-Agent**: Models an editor/IDE booting and driving an agent subprocess over stdin/stdout.
- **A2A is Horizontal**: Connects independent, autonomous agents across runtime boundaries as opaque peers. Neither agent wraps, runs, or embeds the other.

### The Breakthrough Addition for Our Plan
Section 12 of the A2A specification governs **Custom Protocol Bindings**. A custom binding allows implementers to alter the transport layer (e.g. local filesystem with inotify reactivity) while adopting A2A's canonical data model (`Task`, `TaskStatus`, `TaskState`, `Message`, `Part`, `Artifact`, `AgentCard`).

Instead of building an ad-hoc custom JSON ledger or relying on unsupported CLI wrappers, we can adopt an **A2A-Aligned Local File Protocol** today. It directly adopts A2A's canonical data model over our zero-daemon local file transport. *(Note on Standards Conformance: Under Section 12.1, a fully certified custom binding requires implementing all 11 core RPC operations including push notification endpoints and extended cards; our local file design is an **A2A-aligned data model and state protocol** rather than a fully certified transport binding).*

---

## 2. Canonical A2A Data Model & Primitives (`a2a.proto`)

All A2A data structures are formally defined in `specification/a2a.proto`:

### 2.1. Agent Card (`AgentCard`)
A digital capability manifest published by each agent session. Required fields in `a2a.proto` (lines 362–440):
- **`name` & `description`**: Human/agent-readable identification (e.g. `"Claude Code (macp)"`, `"Google Antigravity"`).
- **`version` & `provider`**: Harness provider identification (`organization`, `url`).
- **`capabilities`**: Capability flags (`streaming`, `push_notifications`, `extended_agent_card`, `extensions`).
- **`default_input_modes`**: Media types accepted by the agent (e.g. `["text/plain", "application/json"]`).
- **`default_output_modes`**: Media types produced by the agent (e.g. `["text/plain", "application/json"]`).
- **`skills`**: Array of distinct skills offered by the agent (e.g. `python-harness-refactoring`, `conformance-benchmarking`, `formal-spec-authoring`).
- **`supported_interfaces`**: Array of transport endpoints and protocol bindings.

*(Note on Discovery: The official A2A discovery mechanism is `GET /.well-known/agent-card.json` over HTTP; our local `~/.agents/roster/` directory is our filesystem analogue for side-by-side agents).*

### 2.2. Tasks vs. Messages & Role Symmetry
A2A draws a strict, principled boundary between messages and tasks:
- **`Message` (Conversational & Exploratory)**:
  - Carries lightweight multi-turn dialogue, scope negotiation, and capability queries (e.g., *"Can you review PR #13?"*).
  - Contains an array of **`Part`** objects:
    - Text strings (`text`)
    - Binary content / base64 files (`raw`)
    - Web / file URLs (`url`, e.g. `file:///...`)
    - Arbitrary structured JSON data (`data`)
  - Identifies `role`: `ROLE_USER` (requester) or `ROLE_AGENT` (worker).
  - Tied together by a **`context_id`**.
- **`Task` (Committed Stateful Work)**:
  - Created when work is formally committed.
  - Carries a unique `id`, `context_id`, and `history` of contributing messages.
  - Generates concrete **`Artifact`** objects (code diffs, test summaries, branch links).
  - Governed by an immutable state machine.
- **Symmetry Model**: Within a single task, one side acts as the requester (`ROLE_USER`) and the other acts as the worker (`ROLE_AGENT`). Peer symmetry is maintained across the pair because both sessions operate as sovereign equals and either session can open tasks directed to the other.

### 2.3. Task Lifecycle State Machine
A2A defines eight canonical lifecycle states (`TaskState`):
- `TASK_STATE_SUBMITTED` (1): Task submitted and acknowledged.
- `TASK_STATE_WORKING` (2): Actively being processed by the agent.
- `TASK_STATE_COMPLETED` (3): Finished successfully (Terminal).
- `TASK_STATE_FAILED` (4): Finished with an error (Terminal).
- `TASK_STATE_CANCELED` (5): Canceled before completion (Terminal).
- `TASK_STATE_INPUT_REQUIRED` (6): Agent requires input or review from the peer (Interrupted).
- `TASK_STATE_REJECTED` (7): Agent determined it cannot or will not perform the task (Terminal).
- `TASK_STATE_AUTH_REQUIRED` (8): Authentication required to proceed (Interrupted).

*Task Immutability Rule*: Once a task enters a terminal state (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`), it cannot restart. Follow-on work starts a new `Task` referencing the original via `reference_task_ids`.

---

## 3. The A2A Local File Binding (Phase 2 Architecture)

Under Section 12 of A2A, we define the **A2A Local File Binding** (`https://a2a-protocol.org/bindings/local-file/v1`):

### 3.1. Directory Structure (`~/.agents/`)
```
~/.agents/
├── roster/                      # Agent Cards
│   ├── agy-8343b610.card.json
│   └── claude-012hq2t9.card.json
├── contexts/                    # Contexts & Task State
│   └── <context-id>/
│       ├── tasks.jsonl          # A2A Task State Machine Ledger (flock-guarded)
│       └── artifacts/           # Structured Task Artifacts
└── bridge-v2-coordination-channel.md  # A2A Message Stream (Turn Blocks)
```

### 3.2. Concurrency & Synchronization
- **Zero Daemons**: All state resides on the local filesystem.
- **Atomic Operations**:
  - Agent Cards: Written atomically via `.tmp` + `rename`.
  - Task Ledger (`tasks.jsonl`): Atomic append with advisory `fcntl.flock` serialization on `tasks.lock`.
- **Reactive Wake**: Background inotify watcher (`watch-bridge-coordination.sh`) notifies idle sessions of state updates immediately without polling.

---

## 4. Key Additions to `consolidated-bridge-v2-plan.md`

Based on this deep dive, we propose the following specific enhancements to the master plan:

1. **Standardize Task Ledger on A2A Schema**:
   - Rather than inventing a custom task format, Phase 2 adopts the canonical A2A `Task` and `TaskStatus` JSON schemas directly.
   - Solves the open choice between an ad-hoc registry and `beads`: an in-house A2A-aligned atomic JSONL ledger gives standards-based task modeling without Dolt dependencies or host dotfile pollution (noting that beads provides ready-work dependency graph queries, whereas A2A models task references and history).
2. **Formalize Agent Cards for Discovery**:
   - Each session emits its `AgentCard` into `~/.agents/roster/` on inception.
   - Provides machine-readable skill routing: allows Jev and session routers to inspect peer capabilities deterministically.
3. **Structured Artifacts**:
   - Formalize task outputs (branches, PR numbers, test logs) as A2A `Artifact` objects containing `Part` definitions with `media_type` and `url`.
4. **Clean Upgrade Path to Network Transports**:
   - Because the data model strictly mirrors `a2a.proto`, migrating in Phase 4 from file-based transport to an HTTP/SSE, WebSocket, or ACP carrier requires zero modifications to agent logic, task history, or artifact definitions.

---

## 5. Peer Verification Summary (Claude Code Review, Commit `f502beb`)

- [x] Conformance analysis of Section 12: verified as A2A-aligned data model and state protocol (11 full RPCs not mapped in file channel).
- [x] Correctness of mapping `TaskState` (`SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `COMPLETED`, `CANCELED`, `FAILED`, `REJECTED`, `AUTH_REQUIRED`): fully verified against `a2a.proto` lines 189–207.
- [x] Viability of `AgentCard` JSON documents for peer discovery: confirmed with all 8 required fields documented.
