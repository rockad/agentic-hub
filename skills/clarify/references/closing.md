# clarify reference: Closing the Series & Jev-Aware Execution Handoff

Read this once, only after the last fork has been answered. The core `SKILL.md` rules still apply: the Style section (terse closing) and the rule to never write code without an explicit go. In Mode B, also use the Mode B decision table and artifact in `plain-mode.md`.

Once all forks are resolved, present the consolidated architectural blueprint and transition gate.

### 1. Decision Table

#### Mode A (Standard Architecture)

| # | Decision Topic | Chosen Option | Changed? |
|---|----------------|---------------|----------|
| 1 | <topic> | Option A: <formal technical decision> | unchanged / revised |
| 2 | <topic> | Option B: <formal technical decision> | new |

#### Mode B (Plain English / ELI5)

See `plain-mode.md` ("Decision Table (Mode B)").

The "Changed?" column earns its place only if something was revised mid-series; drop it when every decision held.

### 2. Final Architecture Artifact

Assemble the **final picture**:
- **Mode A (Standard Architecture)**: Complete technical blueprint — complete ASCII diagram, DTOs/schemas, state machines, API contracts, and governing invariants in a single consolidated block.
- **Mode B (Plain English / ELI5)**: See `plain-mode.md` ("Final Architecture Artifact (Mode B)").

### 3. Proposed Parallel Workstream Breakdown Table

When the architecture spans multiple files or components, break down the execution into a DAG of independent workstreams:

| Stream | Scope / File Targets | Description | Suggested Role | Recommended Tier |
|---|---|---|---|---|
| WS1 | `src/db/schema.ts`, `migrations/` | Database schema & migration files | `code_engineer` | `flash` |
| WS2 | `src/api/routes.ts`, `src/api/dto.ts` | Endpoint definitions & validation | `code_engineer` | `flash` |
| WS3 | `docs/adr/001-tag-model.md` | ADR documentation & schema dictionary | `ghostwriter` / `vault_librarian` | `openrouter_free` |

### 4. Gated Execution Transition

> [!IMPORTANT]
> **Do not write code without an explicit go from the user.**

Before creating or editing files, present the decision table, artifact, and workstream breakdown, then stop and ask for confirmation (e.g. "Ready to proceed with execution?").

Once the user approves:

1. **Detect Jev Coprocessor**:
   - Check if `jev_batch_dispatch` exists in available tools, or run CLI check `jev status` via `run_command`.

2. **Branch A — Jev Active (`jev on` or `jev on-demand`)**:
   - **Post-Approval Transition Gate**: Call `jev_batch_dispatch` with the workstream DAG to calibrate tier recommendations and subagent assignments.
   - Inspect active and idle subagents with `manage_subagents(Action: "list")`. Reuse idle workers via `send_message` or spawn parallel subagents with `invoke_subagent`.
   - Offload non-sensitive, public, or sanitized boilerplate, formatting, and markdown summaries to `jev_execute_free` ($0.00 cost, 0 Gemini quota).
   - **Strict Main Context Gate**: The main orchestrator **must not** edit multiple files (`>=2`) sequentially in the main turn. Work must be delegated to parallel subagents as mapped in the workstream breakdown.

3. **Branch B — Jev Inactive / Standard Environment**:
   - In multi-agent environments: delegate independent workstreams to native subagents in parallel (`invoke_subagent` / `send_message`).
   - In single-agent environments: execute the workstream breakdown sequentially step by step.
