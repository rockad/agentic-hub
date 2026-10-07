# TypeSafe Jev: Rules & Guidelines

This document governs System 1 decision-making, model tier governance, thinking effort, and quota preservation for AI agents using the `jev` plugin.

## 1. Operating Modes

- **`off`**: MCP disabled, zero token overhead, zero OpenRouter calls.
- **`on-demand`**: MCP enabled. Passive System 1 coprocessor for multi-role workflows and ad-hoc routing.
- **`on`**: Aggressive System 1 enforcement: mandatory pre-flight dispatch, free-tier offloading, thinking effort governance, and automated quality gates.

## 2. Pre-Flight Dispatch & Routing

- **Pre-Flight Dispatch (`jev_dispatch`)**:
  - Run before executing non-trivial tasks, refactors, or spawning subagents.
  - Evaluates calibrated probability distributions over candidate subagents and execution tiers (`openrouter_free`, `flash_lite`, `flash`, `pro`).
  - If `recommendedTier` is `openrouter_free`, execute immediately via `jev_execute_free` rather than spawning a paid subagent.
- **Fast Option Routing (`jev_route`)**:
  - Use when a discrete choice between 2–8 options needs a fast calibrated probabilistic verdict (~800ms) via OpenRouter Decisions API.

## 3. Free-Tier Offloading & Quota Preservation

- **Zero-Cost Offloading (`jev_execute_free`)**:
  - Offload mechanical work—boilerplate scaffolding, markdown formatting, text transformations, log distillations, and draft summaries—to `openrouter/free` at **$0.00 cost** and **zero Gemini quota**.
  - Subagents performing bulk transformations or formatting must call `jev_execute_free` directly.
- **Concurrency Cap**:
  - Cap concurrent tasks targeting `openrouter_free` at **maximum 10 simultaneous instances** to respect OpenRouter rate limits.
- **Quota Exhaustion & 429 Fallback**:
  - If a subagent returns `RESOURCE_EXHAUSTED` (HTTP 429), never fall back to generating the task in the main agent context. Retry on the free tier via `jev_agent_free` or `jev_execute_free`.

## 4. Session Model Alignment & Thinking Effort Governance

- **Session Model Ceiling**:
  - The model running in the main agent session defines the absolute upper-bound model tier and version ceiling for all delegated subagents and tasks.
- **Subagent Tier Clamping**:
  - Subagents default to `Model: "inherit"` or lower (`flash`, `flash_lite`, `openrouter_free`).
- **Pro Tier Manual Approval Workflow**:
  - Pro tier models (`pro`, `opus`) must NEVER be used automatically.
  - If `jev_dispatch` recommends `pro`, prompt the user for explicit approval. If declined, execute on `flash` or cheaper.
- **Thinking Effort**:
  - Match reasoning effort to task complexity. High thinking effort should be reserved for ambiguous architectural decisions, while routine transformations run with minimal or zero thinking overhead.

## 5. Quality Gates (`jev_judge`)

- Gate non-trivial diffs, code refactors, and test outcomes using `jev_judge`.
- Pre-commit: reject diffs containing merge conflict markers or unresolved lint failures.
