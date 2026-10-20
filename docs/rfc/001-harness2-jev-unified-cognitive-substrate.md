# RFC 001: Cognitive Engine — Autonomous Cognitive Substrate (Harness² + Jev + Memory)

- **Document Type**: Architecture RFC & Unified Implementation Plan
- **RFC Number**: 001
- **Status**: Requesting Comments & Review from [@Doc-Cr](https://github.com/Doc-Cr)
- **Authors**: Aleksandr Korolev ([@rockad](https://github.com/rockad)), Antigravity Pair Architect
- **Target Reviewers**: [@doc-cr](https://github.com/doc-cr), Aleksandr Korolev
- **Target Runtimes**: Google Antigravity, Claude Code, OpenCode
- **Upstream PR**: [rockad/agentic-hub#11](https://github.com/rockad/agentic-hub/pull/11)

> [!IMPORTANT]
> **Unified Entity Invariant**: This RFC serves simultaneously as the formal architectural proposal and the actionable engineering implementation plan. There is zero divergence between this document and the active execution roadmap. Following review feedback from [@Doc-Cr](https://github.com/Doc-Cr), this plan will be executed directly without intermediate translation layers.

---

## 1. Executive Summary & Tripartite Architecture

This plan establishes **Cognitive Engine** as a dedicated standalone core platform repository (`rockad/cognitive-engine`) consolidating three complementary AI agent infrastructure layers into an **Autonomous Cognitive Substrate**:

1. **System 1 (TypeSafe Jev)**: Sub-second (~380ms) probabilistic routing, model tier dispatch, free-tier offloading, quality gatekeeping (`jev_judge`), and session ceiling governance.
2. **System 2 (Google Harness²)**: Contrastive trajectory probing (*Propose–Probe–Compose*) without ground truth, automated harness component mutation across 8 dimensions, and continual learning via `EXPERIENCE.md`.
3. **Memory Substrate (Recall & Lookup)**: Daemonized semantic entity graph (Recall `:8110`), SQLite FTS5 transcript & knowledge search (Lookup `:8100`), and machine-wide domain experience stores.

```mermaid
flowchart TB
    subgraph CognitiveEngine ["1. Cognitive Engine (New Standalone Monorepo: rockad/cognitive-engine)"]
        direction TB
        
        subgraph TS_Runtime ["TypeScript / Bun Runtime"]
            JevCore["TypeSafe Jev Core (System 1 Coprocessor)"]
            JevRouter["Probabilistic Tier Dispatch (~380ms)"]
            JevJudge["Quality & Diff Gate (jev_judge)"]
            FreeOffload["Zero-Cost Boilerplate Offloader (openrouter/free)"]
        end
        
        subgraph Python_Runtime ["Python 3.12 / uv Runtime"]
            H2Engine["Google Harness² Core (System 2 Optimizer)"]
            H2Proposer["Candidate Mutators (8 Components)"]
            H2Composer["Behavioral Contrast Composer (No Ground-Truth Needed)"]
            H2Reflector["Continual Reflector (INDEX.md + EXPERIENCE.md)"]
            
            MemoryService["Unified Cognitive Memory Daemon (:8100/mcp)"]
            SQLiteDB[("~/.local/share/cognitive-engine/memory.sqlite")]
            MemoryService --- SQLiteDB
        end
        
        TS_Runtime <==>|Standard FastMCP-over-stdio / Local HTTP| Python_Runtime
    end

    subgraph SandboxLayer ["2. Execution Isolation Layer"]
        DockerSandbox1["Docker Sandbox (Candidate Trajectory A)"]
        DockerSandbox2["Docker Sandbox (Candidate Trajectory B)"]
        H2Engine -.->|Parallel Candidate Dispatch| DockerSandbox1
        H2Engine -.->|Parallel Candidate Dispatch| DockerSandbox2
    end

    subgraph Peripherals ["3. Peripheral Registry (rockad/agentic-hub)"]
        PluginsRegistry["Standalone Tool Plugins (chrome-devtools, gitea, google-workspace, local-transcribe)"]
        SkillsRegistry["Standalone Utility Skills (clarify, md-to-pdf, markdown-convert, rclone)"]
        Marketplace[".claude-plugin/ & marketplace.json Manifests"]
    end

    subgraph ConsumerRuntimes ["4. Tri-Harness Adapters"]
        AGY["Google Antigravity (MCP + ask_question + Subagents)"]
        Claude["Claude Code (Hooks + AskUserQuestion + .claude-plugin)"]
        OpenCode["OpenCode (V2 Plugin + --substrate opencode + TUI)"]
    end

    subgraph ConsumerWorkspaces ["5. Consumer Workspaces"]
        Doppelganger["doppelganger ($VAULT: Personal Second Brain & Career Master Records)"]
        WorkRepos["Work Repositories (Software Projects, Tooling)"]
    end

    CognitiveEngine ===> ConsumerRuntimes
    Peripherals ===> ConsumerRuntimes
    ConsumerRuntimes ===> ConsumerWorkspaces
```

### Tripartite Separation of Concerns
* **`cognitive-engine` (The Core Platform)**: Holds Jev, Harness², the unified memory daemon, domain experience libraries, and native cross-harness adapters. Zero project-specific notes or application data.
* **`agentic-hub` (The Peripheral Registry)**: Repositioned as the community marketplace and distribution hub for peripheral, tool-specific plugins (`chrome-devtools`, `gitea`, `google-workspace`, `local-transcribe`) and standalone skills (`md-to-pdf`, `markdown-convert`).
* **`doppelganger` (The Consumer Vault)**: Preserved as Aleksandr's pure personal knowledge vault and second brain (`$VAULT`), holding zero container plumbing, optimizer loops, or engine code.

---

## 2. Four Locked Architectural Decisions (Clarify Consensus)

Through formal architectural clarification (`/clarify`), four key forks have been resolved:

| # | Architectural Dimension | Clarified Decision | Operational Rationale |
|---|---|---|---|
| **1** | **Monorepo Packaging & Runtime** | **Polyglot Monorepo** | Bun workspaces for TypeScript (Jev/MCP) + `uv` workspaces for Python 3.12 (Harness²/Memory). Zero rewrite debt; native performance for both runtimes. |
| **2** | **Internal Component IPC** | **Standard MCP-to-MCP** | Harness² exposes standard FastMCP tools (`harness2_propose`, `harness2_probe`, `harness2_compose`) consumed by Jev. Standardized, inspectable, decoupled. |
| **3** | **Memory Substrate Engine** | **Consolidated Single-Daemon SQLite Engine** | Retire `basic-memory` Docker container; unify Recall (notes/entities) and Lookup (FTS5 search) into a single native SQLite daemon (`:8100/mcp`). Saves ~1GB RAM in WSL2. |
| **4** | **Probe Execution Isolation** | **Docker Sandboxes** | Isolated agent micro-sandboxes ([Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/)) for secure, zero-risk parallel candidate execution. |

---

## 3. Deep Component Specifications

### 3.1 System 1: TypeSafe Jev Coprocessor (TypeScript / Bun)
- **Sub-Second Tier Dispatch (`jev_dispatch`)**: Evaluates task complexity in ~380ms and routes to optimal subagents and model tiers (`openrouter_free`, `flash_lite`, `flash`, `pro`).
- **Quota Preservation & Free Offloading (`jev_execute_free`)**: Automatically offloads boilerplate generation, summaries, text formatting, and commit message drafting to `openrouter/free` at $0.00 cost (0 Gemini/Claude quota).
- **Session Model Ceiling Enforcement**: Clamps child subagents to never exceed the active parent model tier without explicit manual user approval.
- **Diff Quality Gates (`jev_judge`)**: Binary acceptance testing for file diffs, test outcomes, and pre-commit checks.

### 3.2 System 2: Google Harness² Recursive Optimizer (Python 3.12 / uv)
- **Task-Level Recursion (*Propose–Probe–Compose*)**:
  - Automatically triggered when `jev_dispatch` reports low confidence (`<0.50`), or on-demand via `/probe`.
  - Probes $k$ candidate modifications across the **8 editable harness components** (System prompt, Guardrails, Memory, Tool guidance, Subagents, Skills, Scripts, Plugins) in parallel isolated Docker Sandboxes.
  - Contrasts execution trajectories using behavioral diffs and synthesizes winning enhancements without requiring ground-truth labels.
- **Harnessing-Level Recursion (*Continual Learning*)**:
  - Post-task reflection that harvests empirical, evidence-supported lessons into persistent domain libraries (`EXPERIENCE.md` + `INDEX.md`), keeping base system prompts invariant and lean (~1,500 tokens).

### 3.3 Memory Substrate: Unified Cognitive Memory Daemon (`:8100/mcp`)
Replaces the dual-container setup (`basic-memory:0.23.2` on `:8110` + `lookup` on `:8100`) with a single native Python SQLite daemon:
- **`notes` & `entities` tables**: Replaces Recall. Stores session handoffs (`session-memory:<workspace>`), active goals, and knowledge entities.
- **`fts_transcripts` & `fts_docs` tables**: Replaces Lookup. Full-text SQLite FTS5 search with BM25 ranking across session logs and documents.
- **`experiences` table**: Stores Harness² empirical playbooks per domain (`job-search`, `devops-infra`, `vault-curation`).
- **Storage**: Single local database file at `~/.local/share/cognitive-engine/memory.sqlite` (<50MB RAM, zero Docker, <10ms queries).

### 3.4 Execution Isolation: Docker Sandboxes
Parallel candidate probing ($k \ge 2$) runs inside ephemeral [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/):
- **Safety**: Running untrusted agent mutations, experimental code, and compiler checks is strictly isolated from the host filesystem.
- **Fast Spin-up & Snapshotting**: Docker Sandboxes provide lightweight, near-instant containerized environments optimized specifically for autonomous coding agents.
- **Composition**: Trajectory outputs and diffs are evaluated by `jev_judge`, and only the winning patch is applied back to the consumer workspace.

### 3.5 Tri-Harness Optimization
| Feature / Capability | Google Antigravity | Claude Code | OpenCode |
| :--- | :--- | :--- | :--- |
| **System 1 Coprocessor** | MCP Server (`jev-mcp`) | Lifecycle Hooks (`PreToolUse`, `PostToolUse`) | Native OpenCode V2 Plugin |
| **System 2 Probing** | Native Subagent Delegation (`invoke_subagent`) | Multi-Agent Claude Workspaces / Subagents | Native Substrate Engine (`--substrate opencode`) |
| **Interactive Clarification** | `ask_question` Native UI Chips | `AskUserQuestion` Terminal Comparison Box | `question` Option Dialogs |
| **Quota Governance** | `quota-state.json` UI Dropdown Sync | Session Ceiling Hook (`session-ceiling.sh`) | OpenCode Model Swapper & Cost Guard |
| **Free Tier Offloader** | Direct MCP `jev_execute_free` | Hook-assisted Free Execution | Background OpenCode Worker (`openrouter/free`) |
| **Slash Commands** | Chat shortcuts (`/probe`, `/clarify`) | Slash Commands (`.claude-plugin/`) | Native TUI Slash Commands (`commands/`) |

---

## 4. Proposed Repository Topology (`rockad/cognitive-engine`)

```text
cognitive-engine/
├── packages/
│   ├── jev/                          # System 1: Router, Judge, Free-tier coprocessor
│   │   ├── src/                      # TypeScript / Bun MCP server & core logic
│   │   ├── hooks/                    # Claude Code Pre/PostToolUse lifecycle hooks
│   │   └── opencode/                 # OpenCode V2 plugin
│   ├── harness2/                     # System 2: Recursive Optimizer & Prober
│   │   ├── core/                     # Python 3.12 engine (wrapped from google-research/harness2)
│   │   ├── substrate/                # OpenCode & Antigravity substrate adapters
│   │   ├── proposer/                 # Candidate mutators (8 components)
│   │   ├── prober/                   # Docker Sandboxes parallel execution manager
│   │   └── composer/                 # Contrastive behavioral synthesizer
│   └── memory/                       # Unified Memory Daemon (:8100/mcp)
│       ├── src/                      # Python SQLite service (FTS5 + Graph Notes + Experiences)
│       └── experiences/              # Machine-Wide Domain Experience Libraries
│           ├── job-search/           # INDEX.md + EXPERIENCE.md
│           ├── devops-infra/         # INDEX.md + EXPERIENCE.md
│           └── vault-curation/       # INDEX.md + EXPERIENCE.md
├── adapters/                         # First-Class Cross-Harness Integrations
│   ├── antigravity/                  # Antigravity sidecar & MCP registrations
│   ├── claude/                       # Claude Code plugin bundle
│   └── opencode/                     # OpenCode plugin bundle
├── package.json                      # Bun workspace manifest
└── pyproject.toml                    # uv workspace manifest
```

---

## 5. Implementation Roadmap & Parallel Workstream Breakdown

```mermaid
flowchart LR
    WS1["WS1: Repo Provisioning (Bun + uv)"] --> WS2["WS2: Jev Migration"]
    WS1 --> WS3["WS3: Unified Memory Daemon"]
    WS1 --> WS4["WS4: Harness² & Docker Sandboxes"]
    WS2 & WS3 & WS4 --> WS5["WS5: Tri-Harness Adapters & Vault Decoupling"]
```

| Stream | Scope / File Targets | Description | Suggested Role | Recommended Tier |
|---|---|---|---|---|
| **WS1: Repo Provisioning** | `cognitive-engine/` (New Repo Root) | Scaffold polyglot monorepo with Bun workspaces (`package.json`) and `uv` workspaces (`pyproject.toml`) | `system-operator` | `flash_lite` |
| **WS2: Jev Migration** | `packages/jev/` | Migrate TypeSafe Jev core, FastMCP server, and cross-harness hook bindings into the monorepo | `code-engineer` | `flash_lite` |
| **WS3: Unified Memory Daemon** | `packages/memory/` | Author native SQLite schema (`notes`, `entities`, `fts_transcripts`, `experiences`) and expose unified `:8100/mcp` daemon, deprecating `basic-memory` Docker container | `code-engineer` | `flash_lite` |
| **WS4: Harness² & Sandboxes** | `packages/harness2/` | Package Google Harness² with FastMCP tool wrappers and integrate [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/) execution adapter | `code-engineer` | `flash_lite` |
| **WS5: Adapters & Vault Decoupling** | `adapters/`, `doppelganger/` | Package Antigravity, Claude Code, and OpenCode adapters; remove legacy engine plumbing from `doppelganger` | `system-operator` | `flash_lite` |

---

## 6. Targeted Review Requests & Brainstorming Points for [@Doc-Cr](https://github.com/Doc-Cr)

We specifically request [@Doc-Cr](https://github.com/Doc-Cr)'s architectural review and guidance on:

1. **Docker Sandboxes vs. Worktree Fallback**:
   Docker Sandboxes provide exceptional container isolation, but what should be our offline or headless fallback if the Docker daemon is temporarily offline? Should the prober fall back to ephemeral git worktrees in `/tmp/`?
2. **Unified Memory Schema Migration**:
   For the unified SQLite memory daemon on `:8100`, should we maintain exact API parity with Recall (`/read_note`, `/write_note`) and Lookup (`/search_archive`) so all existing MCP configs continue working with zero edits?
3. **OpenRouter Rate Limits & Concurrency**:
   Harness² probing can generate $k$ parallel trajectories. When offloading to `openrouter/free`, OpenRouter enforces a global 20 RPM limit. Does capping concurrent sandboxes at 2 parallel instances provide the best safety margin?
4. **Packaging & Monorepo Structure**:
   Does the polyglot structure (Bun workspaces at root + `uv` workspace for Python) align with your expectations for long-term CI and multi-platform distribution?
