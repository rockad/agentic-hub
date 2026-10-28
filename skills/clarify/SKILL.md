---
name: clarify
description: >-
  Walk a non-trivial design through its forks one question at a time. Resolves
  design targets without parameters via a multi-tier recency cascade, explores the
  codebase first, surfaces genuine architectural trade-offs with prose-first
  previews and explicit recommendations, and asks interactive single-choice
  questions across Antigravity, Claude Code, and OpenCode. Closes with a
  decision table, architecture artifact, and Jev-aware parallel workstream handoff.
when_to_use: >-
  The user is designing something non-trivial (DB schema, data model, API contract,
  UX flow, architecture, migration) and at least three orthogonal decisions are open,
  each with two or more defensible options — or the user asks to clarify before coding.
  Triggers include /clarify, /grill-me, "walk me through the options", "interview me",
  "one at a time", "clarify architecture before coding", "trade-offs", "design decision",
  "discuss before coding", "architecture without code". Skip for a single isolated choice,
  for urgent implementation where the user said to just build it, or while another
  interactive flow already owns the conversation.
metadata:
  author: doccr
---

# clarify

A working mode for designing something non-trivial together with the user — a database schema, a data model, an API contract, a UX flow, an architecture refactor, or a migration — when several orthogonal forks are open and each carries its own trade-offs.

Unifies `/clarify` and `/grill-me` into a single cross-harness skill compatible with Google Antigravity, Claude Code, and OpenCode.

The point is not to collect answers faster or run a superficial questionnaire. It is to make every decision visible, argued, and reversible while it is still cheap to reverse, before a single line of implementation code is written.

## Triggers & When to Enter

- **Slash commands & phrase triggers**: `/clarify` (universal slash command), `/grill-me` (native slash command in Antigravity; prompt phrase trigger in Claude Code & OpenCode).
- **User prompts**: "walk me through the options", "interview me", "one at a time", "clarify architecture before coding", "trade-offs", "let's clarify this first", "design decision", "discuss before coding", "architecture without code".
- Three or more related design decisions are open, and each has at least two reasonable, defensible options.
- The user explicitly asks for trade-off analysis without jumping into implementation.
- You decomposed the request yourself and can see that without a choice on each fork, the implementation would be either incomplete or built on silent assumptions.

## When Not to Enter

- A single question with a single choice — ask it plainly or with one single question call; do not inflate it into a series.
- Urgent implementation where the user explicitly said to just build it or make all decisions autonomously.
- The fork is trivial (`let` versus `const`, minor styling) and does not deserve ceremony.
- Another interactive flow (such as plan mode or a dedicated setup wizard) already owns the conversation — do not stack modes.

## Pre-flight Investigation (Codebase Discovery)

Before formulating forks or prompting the user, **investigate the existing codebase first**:

1. **Discover prior art**: Use file search (`fd`, `find`), symbol search (`rg`, `grep`), and file inspection tools to check existing conventions, folder layouts, types, schemas, and dependencies.
2. **Adopt existing patterns silently**: If a question can be answered by inspecting the codebase (e.g. "which ORM is used?", "what is the existing token structure?", "what database drivers are installed?"), inspect the code and adopt the established pattern silently.
3. **Isolate genuine architectural forks**: Never interrogate the user about facts already present in the repository. Present only genuine architectural forks and intentional design trade-offs to the user.

## Target Resolution When Invoked Without Parameters

When invoked simply as `/clarify` or `/grill-me` without an explicit target or file argument, the skill must determine what architectural topic, plan, or artifact to interrogate. To ensure it focuses on what the user currently cares about without asking an unnecessary disambiguation question, evaluate the following cascade in order:

### 1. The Resolution Cascade

- **Tier 0 — Explicit Argument**:
  - The invocation contains an explicit path or topic string (e.g., `/clarify plans/auth-service.md`, `/clarify database migration`).
  - Target: The provided path or topic directly.

- **Tier 1 — Recent User Chat Override**:
  - The user's most recent chat message expresses an explicit pivot away from previous plans or introduces a fresh proposal.
  - Detect pivot signals such as *"instead"*, *"forget that"*, *"new plan"*, *"different approach"*, or a fresh numbered/bulleted architecture proposal posted directly into chat.
  - Target: The fresh proposal or pivoted concept stated in the user's latest prompt.

- **Tier 2 — Active Session Plan Files / Artifacts**:
  - If no prompt-level pivot occurred, scan for active plan documents created or touched in the current session:
    1. **Session Artifacts in `<appDataDir>/brain/<conversation-id>/*.md`** (Antigravity): Sorted by descending modification time `mtime`.
    2. **Recently Touched Workspace Plans in Active Session** (Claude Code / OpenCode): Files matching `plan*.md`, `*-plan.md`, or `./.claude/plans/*.md` in the active workspace (tightened globs to avoid false matches like `explanation.md`).
    3. **Transcript File Links**: Any local markdown file links (`file:///.../*.md` or workspace-relative links) explicitly referenced in recent conversation turns.
  - Target: The highest-priority active plan file found.

- **Tier 3 — Model-Suggested Plan**:
  - In-memory proposal, architecture draft, or structural outline proposed by the model in the preceding 1–2 turns that has not yet been written to disk (promoted above historical archive sweeps so fresh conversation proposals take precedence).
  - Target: The model's proposed plan from the immediate context window.

- **Tier 4 — Historical Repository Plan Sweep**:
  - Fallback scan of existing repository plan documents under `./plans/*.md` or `docs/plans/*.md` when no active session artifact exists.
  - Target: The most recently modified plan document in the repository.

- **Tier 5 — Active Task Goal**:
  - Root `/grill-me` baseline: fallback to the overarching user request, task prompt, or active workspace goal from session memory.
  - Target: The core task objective currently active in the session.

### 2. Target Announcement Protocol

Always announce the resolved target in a single unambiguous declarative line before presenting the fork map:

> Target resolved: **[<target name or path>]**. Decomposing into N orthogonal forks...

This ensures total transparency: if the skill picked up an artifact the user did not intend to clarify, the user can immediately intervene or provide an explicit argument on the next turn.

## Before the First Question

1. **Decompose the request exhaustively into all genuine architectural forks**:
   - **No artificial 4-fork limit**: There is no limit of 3 or 4 forks. If a design has 6, 8, 10, or 12 genuine architectural forks, the skill **must identify and walk through all of them**.
   - Do not truncate or stop prematurely at 4 forks. An artificial cap leaves major architectural decisions made by silent assumption.
   - Aim to identify all orthogonal decisions that are independent of each other — answering one must not predetermine another.
   - Only derived or purely cosmetic choices should be omitted or merged.
2. **Systematic Architectural Discovery Taxonomy**:
   Sweep across the entire problem space using this dimension checklist during pre-flight decomposition to ensure all possible forks are uncovered:
   - **Core Architecture & Topology**: Monolithic vs modular, client vs server compute, process boundaries, execution environments.
   - **Data Model & Schemas**: Entity relationships, normalization vs denormalization (e.g. JSONB), compound indexes, type definitions.
   - **State Management & Persistence**: Storage engine, caching layers, invalidation strategy, transactional semantics, durability, retention.
   - **API & Protocol Contracts**: Synchronous REST/gRPC vs asynchronous job/webhook, payload shapes, batching, pagination model.
   - **Concurrency, Sync & Locking**: Optimistic vs pessimistic locking, event ordering, idempotency keys, race condition mitigation, worker pool topology.
   - **Error Handling & Failure Modes**: Fail-open vs fail-closed, backoff/retry policies, dead-letter queues, degraded modes, circuit breakers.
   - **Security, Auth & Privacy**: Token scopes, RBAC/ABAC enforcement boundary, secret handling, data isolation, encryption at rest/in-transit.
   - **Lifecycle & Execution Flow**: Push vs pull, event-driven vs cron polling, synchronous blocking vs background queue.
   - **UI/UX & User Interaction Model**: Optimistic UI updates vs blocking progress indicators, modal vs inline flows, manual trigger vs automated sync.
   - **Migration, Rollback & Compatibility**: Dual-writing, phased schema rollouts, backward compatibility boundaries, data backfill strategy.
3. **Present the complete fork map upfront**:
   - Always state the total count and list all identified forks before asking the first question:
     > "Identified N orthogonal architectural forks across [topics]: [list of forks 1..N]. We start with Fork 1: <topic>."
4. **Never batch the questions**: One fork, one interactive question call, one answer. Walk through all N forks sequentially.

## The Shape of Each Step (Prose-First Previews)

All substantive analysis, ASCII diagrams, code snippets, and trade-offs live in the **markdown prose above the tool call**. This keeps interactive UI dialogs, chips, and modal prompts concise, clean, and readable across all harnesses.

### 1. Heading and Context

A short numbered heading:

```markdown
## Question N (of Total) — <name of the fork, four to eight words>
```

Below it, **two to four sentences of context**: what is being decided, why it matters, and what it will constrain downstream.

### 2. Options, Argued

For each option (two to four options per fork):

- **Option A is ALWAYS the Recommended Option**: Formulate the best architectural path as **Option A**, titled `### Option A. <name> (Recommended)`. This guarantees that:
  - Option A is presented first in prose.
  - Option A is placed first in the interactive selection tool with the `(Recommended)` tag, satisfying harness-level requirements (like Antigravity `ask_question`).
  - In the selection UI, Option A is assigned number `1.` (`1. Option A: <name> (Recommended)`), followed by `2. Option B: <name>`, `3. Option C: <name>`. The numbers and letters align in identical 1:1 order without confusing the user.
- Subsequent options are labeled `### Option B. <name>`, `### Option C. <name>`, etc.
- A technical block for each option — ASCII diagram, code snippet, DTO, schema, or formula.
- **Pros:** two to four concrete points.
- **Cons:** two to four concrete points.

Options must be **mutually exclusive** and genuinely different in consequence. If two differ only cosmetically, merge them or drop one.

### 3. Your Reading, and a Recommendation

After the options, **three to six sentences**: why Option A is recommended, under what specific conditions that recommendation would flip to Option B or C, and what downstream forks this decision cascades into.

Close with a one-line recommendation:

> **Recommendation:** **Option A: <name>** — <one clause explaining why>.

### 4. Adaptive Interactive Tool Calling

After printing the markdown analysis, invoke the harness-appropriate interactive question tool.

> [!IMPORTANT]
> **Strict Option Naming & Sequence Rule**:
> Options in the selection tool MUST be named with their explicit letter prefix and title in the exact order they appeared in prose:
> - `1. Option A: <name> (Recommended)`
> - `2. Option B: <name>`
> - `3. Option C: <name>`
> Never emit bare option names without the `Option X:` prefix, and never reorder options in the selection tool.

#### A. Google Antigravity (`ask_question`)

Uses `ask_question`. The recommended option (Option A) is listed first and prefixed with `(Recommended)`. The UI automatically prepends numbers (`1.`, `2.`, `3.`) and appends an `Other` option:

```json
ask_question({
  "questions": [
    {
      "question": "Which data model should we use for record tagging?",
      "options": [
        "(Recommended) Option A: M:N join table",
        "Option B: Denormalized JSONB array",
        "Option C: Single-tenant delimited string"
      ],
      "is_multi_select": false
    }
  ]
})
```

*What the user sees in the Antigravity UI picker:*
```
1. (Recommended) Option A: M:N join table
2. Option B: Denormalized JSONB array
3. Option C: Single-tenant delimited string
4. Other
```

#### B. Claude Code (`AskUserQuestion`)

Uses `AskUserQuestion` with concise `header`, `label`, `description`, and `"multiSelect": false` (strictly required by Claude Code). Options can include the `"preview"` field to provide side-by-side terminal UI comparison boxes on single-select forks:

```json
AskUserQuestion({
  "questions": [
    {
      "header": "Tag Model",
      "question": "Which data model should we use for record tagging?",
      "multiSelect": false,
      "options": [
        {
          "label": "Option A: M:N join table (Recommended)",
          "description": "Normalized join table with compound unique index. Flexible queries, zero migration debt.",
          "preview": "record_tags\n  record_id\n  tag_id\n  UNIQUE (record_id, tag_id)"
        },
        {
          "label": "Option B: Denormalized JSONB array",
          "description": "Embedded JSON array on record. Faster writes, but slower tag aggregation and no foreign keys.",
          "preview": "records\n  id\n  tags: jsonb -- ['backend', 'urgent']"
        },
        {
          "label": "Option C: Single-tenant delimited string",
          "description": "Simple comma-delimited string in record column. Zero relations, but fragile querying.",
          "preview": "records\n  id\n  tags: text -- 'backend,urgent'"
        }
      ]
    }
  ]
})
```

#### C. OpenCode (`question`)

Uses `question` following standard option schema with `Option A:` labels:

```json
question({
  "questions": [
    {
      "header": "Tag Model",
      "question": "Which data model should we use for record tagging?",
      "options": [
        {
          "label": "Option A: M:N join table (Recommended)",
          "description": "Normalized join table with compound unique index. Flexible queries, zero migration debt."
        },
        {
          "label": "Option B: Denormalized JSONB array",
          "description": "Embedded JSON array on record. Faster writes, but slower tag aggregation and no foreign keys."
        },
        {
          "label": "Option C: Single-tenant delimited string",
          "description": "Simple comma-delimited string in record column. Zero relations, but fragile querying."
        }
      ]
    }
  ]
})
```

#### D. Terminal CLI Fallback

When running in headless CLI environments or where no interactive question tool is bound:

```markdown
Which data model should we use for record tagging?
1. Option A: M:N join table (Recommended)
2. Option B: Denormalized JSONB array
3. Option C: Single-tenant delimited string
```

Wait for the user's text reply before advancing to the next fork.

## After Each Answer

1. **Acknowledge in one line:**

   > Noted: **<chosen option>**. <Optionally, one clause on what it cascades into.> On to the next.

2. **Do not repeat the preview** — the user just reviewed it in prose.
3. If the answer makes a later fork moot — choosing multi-select dissolves a pending question about a tag limit — **say so immediately**: "Choosing X retires fork Y; next is Z."
4. If the answer carries a clarification that touches decisions already taken, **revisit them out loud**. Never silently. "This clarification affects decisions N and M — reopening both."
5. If the user picks "Other" and supplies their own answer, **take it without pushback** and re-check the remaining forks against it.

## Closing the Series & Jev-Aware Execution Handoff

Once all forks are resolved, present the consolidated architectural blueprint and transition gate.

### 1. Decision Table

| # | Decision | Changed? |
|---|----------|----------|
| 1 | <decision> | unchanged / revised |
| 2 | <decision> | new |

The "Changed?" column earns its place only if something was revised mid-series; drop it when every decision held.

### 2. Final Architecture Artifact

Assemble the **final picture** — complete ASCII diagram, DTOs/schemas, state machines, API contracts, and governing invariants — in a single consolidated block.

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

## Style

- Keep whatever voice you normally use — the mode governs structure, not personality.
- Precise terminology inside the trade-off analysis.
- Preview blocks are monospaced ASCII. Emoji only where they carry meaning, such as colour swatches in a palette fork.
- Four to eight lines of pros and cons per option is plenty; do not stretch each one into half a page.
- Do not apologise for the length of the analysis — it is the value of the mode. Do not pad it either.

## Anti-Patterns

- **Artificial 4-fork truncation** — capping the clarification at 3 or 4 superficial questions when major architectural dimensions (persistence, error handling, auth, concurrency, lifecycle) remain unclarified.
- **Unlabeled or scrambled options in selection** — emitting options in the interactive tool without `Option A:`, `Option B:` prefixes, or reordering them so they disagree with the prose preview.
- **Firing options without codebase discovery** — asking questions the codebase already answers damages trust.
- **Firing options without analysis** — that is a questionnaire, not a clarification.
- **Options with no preview in prose** — the visual comparison is the point. If a fork resists having a preview, it may not be a fork worth this mode.
- **Overloading tool call descriptions with previews** — breaks modal dialogs in GUI harnesses. Keep previews in markdown prose.
- **Two options that mean the same thing** — merge them.
- **Hiding the recommendation** — without a `(Recommended)` tag you are not helping, you are polling.
- **Silent revision of earlier decisions** — always name what changed and why out loud.
- **Ending without the decision table** — by step seven the user no longer remembers what they chose at step three.
- **Sliding into code without a go** — always require explicit user confirmation before modifying code.
- **Bypassing subagents after approval (when subagents or Jev are available in multi-agent environments)** — sequentially modifying files in the orchestrator instead of dispatching workstreams.

## Gotchas

- **Cross-Harness Tool Names**: Antigravity uses `ask_question`, Claude Code uses `AskUserQuestion`, OpenCode uses `question`. Adapt dynamically without crashing if a specific tool is absent.
- **Single Question per Call**: One question per call is this skill's protocol, even if the underlying tool schema permits multi-question arrays. A batch turns the session back into an overwhelming questionnaire.
- **Option Naming & Ordering in Selection**: Every option in the interactive selection tool MUST be named `Option A: <name>`, `Option B: <name>` in the exact sequence they appeared in prose. The UI numbers them (`1.`, `2.`, `3.`), rendering `1. Option A: <name> (Recommended)`, `2. Option B: <name>`, etc. Always make Option A the recommended path so that the recommendation is first without breaking letter ordering.
- **Total Forks vs. Options per Fork Distinction**: Clarify this distinction carefully: **4 options per question is the harness limit for choices**, NOT a limit on the total number of architectural forks in the session! A comprehensive clarification should uncover **all** genuine architectural forks (e.g. 5 to 12+), sweeping across all architectural dimensions, and walk through them one by one.
- **Previews in Markdown Prose**: Do not rely exclusively on tool-specific preview properties. Markdown prose is the universal preview canvas across all harnesses.
- **Claude Code `preview` Rendering**: In Claude Code, the `preview` field renders only when `multiSelect: false`. On a multi-select fork the preview blocks silently do not appear in the terminal UI comparison box — keep the comparison in markdown prose.
- **Option Count & Limits**: Four options per question is the harness limit. "Other" is automatically appended by the UI; never add a manual "Other" option.
