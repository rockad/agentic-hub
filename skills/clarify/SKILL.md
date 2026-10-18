---
name: clarify
description: >-
  Walk a non-trivial design through its forks one question at a time. Resolves
  design targets without parameters via a 5-tier recency cascade, explores the
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

- **Slash commands**: `/clarify`, `/grill-me`.
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

When invoked simply as `/clarify` or `/grill-me` without an explicit target or file argument, the skill must determine what architectural topic, plan, or artifact to interrogate. To ensure it focuses on what the user currently cares about without asking an unnecessary disambiguation question, evaluate the following 5-tier resolution cascade in order:

### 1. The 5-Tier Resolution Cascade

- **Tier 0 — Explicit Argument**:
  - The invocation contains an explicit path or topic string (e.g., `/clarify plans/auth-service.md`, `/clarify database migration`).
  - Target: The provided path or topic directly.

- **Tier 1 — Recent User Chat Override**:
  - The user's most recent chat message expresses an explicit pivot away from previous plans or introduces a fresh proposal.
  - Detect pivot signals such as *"instead"*, *"forget that"*, *"new plan"*, *"different approach"*, or a fresh numbered/bulleted architecture proposal posted directly into chat.
  - Target: The fresh proposal or pivoted concept stated in the user's latest prompt.

- **Tier 2 — Active Plan File / Artifact**:
  - If no explicit prompt-level pivot occurred, scan for active plan documents using the following multi-harness precedence:
    1. **Session Artifacts (Antigravity)**: Session artifacts in `<appDataDir>/brain/<conversation-id>/*.md` (sorted by descending modification time `mtime`).
    2. **Recently Touched Workspace Plans (Claude Code / OpenCode)**: Markdown plan documents recently created or edited in the active workspace (e.g. `./plans/*.md`, `./.claude/plans/*.md`, `docs/plans/*.md`, or root `*plan*.md`).
    3. **Transcript File Links (Universal)**: Any local markdown file links (`file:///.../*.md` or workspace-relative links) explicitly referenced in recent conversation turns.
    4. **Workspace Repository Plans (Universal)**: The most recently modified plan document under `./plans/` or `docs/plans/`.
  - Target: The highest-priority active plan file found.

- **Tier 3 — Model-Suggested Plan**:
  - The preceding model turn proposed an in-memory plan, architecture draft, or structural proposal that has not yet been saved to an artifact or plan file.
  - Target: The model's proposed plan from the immediate context window.

- **Tier 4 — Active Task Goal**:
  - Root `/grill-me` baseline: fallback to the overarching user request, task prompt, or active workspace goal from session memory.
  - Target: The core task objective currently active in the session.

### 2. Target Announcement Protocol

Always announce the resolved target in a single unambiguous declarative line before presenting the fork map:

> Target resolved: **[<target name or path>]**. Decomposing into N orthogonal forks...

This ensures total transparency: if the skill picked up an artifact the user did not intend to clarify, the user can immediately intervene or provide an explicit argument on the next turn.

## Before the First Question

1. **Decompose the request** into orthogonal forks. Aim for three to fifteen decisions, each **independent** of the others — answering one must not predetermine another.
2. More than fifteen forks means some of them are derived. Merge and reformulate.
3. Fewer than three means the mode is unnecessary. Ask one or two ordinary questions instead.
4. **Present the map briefly** before starting: "There are N forks; we start with the one that determines the core data model".
5. **Never batch the questions.** One fork, one interactive question call, one answer.

## The Shape of Each Step (Prose-First Previews)

All substantive analysis, ASCII diagrams, code snippets, and trade-offs live in the **markdown prose above the tool call**. This keeps interactive UI dialogs, chips, and modal prompts concise, clean, and readable across all harnesses.

### 1. Heading and Context

A short numbered heading:

```markdown
## Question N — <name of the fork, four to eight words>
```

Below it, **two to four sentences of context**: what is being decided, why it matters, and what it will constrain downstream.

### 2. Options, Argued

For each option (two to four per fork):

- A bold heading (`### A. <name>`).
- A technical block — ASCII diagram, code snippet, DTO, schema, or formula.
- **Pros:** two to four concrete points.
- **Cons:** two to four concrete points.

Options must be **mutually exclusive** and genuinely different in consequence. If two differ only cosmetically, merge them or drop one.

### 3. Your Reading, and a Recommendation

After the options, **three to six sentences**: which choice you consider best and why, under what conditions that recommendation would flip, and what downstream forks this decision cascades into.

Close with a one-line recommendation:

> **Recommendation:** **<option>** — <one clause explaining why>.

### 4. Adaptive Interactive Tool Calling

After printing the markdown analysis, invoke the harness-appropriate interactive question tool. Visual previews and deep prose remain in the markdown text; the tool call carries concise labels and descriptions.

#### A. Google Antigravity (`ask_question`)

Uses `ask_question`. The recommended option is prefixed with `(Recommended)` and listed first:

```json
ask_question({
  "questions": [
    {
      "question": "Which data model should we use for record tagging?",
      "options": [
        "M:N join table (Recommended)",
        "Denormalized JSONB array",
        "Single-tenant delimited string"
      ],
      "is_multi_select": false
    }
  ]
})
```

#### B. Claude Code (`AskUserQuestion`)

Uses `AskUserQuestion` with concise `header`, `label`, and `description`:

```json
AskUserQuestion({
  "questions": [
    {
      "header": "Tag Model",
      "question": "Which data model should we use for record tagging?",
      "options": [
        {
          "label": "M:N join table (Recommended)",
          "description": "Normalized join table with compound unique index. Flexible queries, zero migration debt."
        },
        {
          "label": "Denormalized JSONB array",
          "description": "Embedded JSON array on record. Faster writes, but slower tag aggregation and no foreign keys."
        }
      ]
    }
  ]
})
```

#### C. OpenCode (`question`)

Uses `question` following standard option schema:

```json
question({
  "questions": [
    {
      "header": "Tag Model",
      "question": "Which data model should we use for record tagging?",
      "options": [
        {
          "label": "M:N join table (Recommended)",
          "description": "Normalized join table with compound unique index. Flexible queries, zero migration debt."
        },
        {
          "label": "Denormalized JSONB array",
          "description": "Embedded JSON array on record. Faster writes, but slower tag aggregation and no foreign keys."
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
1. M:N join table (Recommended)
2. Denormalized JSONB array
3. Single-tenant delimited string
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
   - Offload boilerplate, formatting, and markdown summaries to `jev_execute_free` ($0.00 cost, 0 Gemini quota).
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

- **Firing options without codebase discovery** — asking questions the codebase already answers damages trust.
- **Firing options without analysis** — that is a questionnaire, not a clarification.
- **Options with no preview in prose** — the visual comparison is the point. If a fork resists having a preview, it may not be a fork worth this mode.
- **Overloading tool call descriptions with previews** — breaks modal dialogs in GUI harnesses. Keep previews in markdown prose.
- **Two options that mean the same thing** — merge them.
- **Hiding the recommendation** — without a `(Recommended)` tag you are not helping, you are polling.
- **Silent revision of earlier decisions** — always name what changed and why out loud.
- **Ending without the decision table** — by step seven the user no longer remembers what they chose at step three.
- **Sliding into code without a go** — always require explicit user confirmation before modifying code.
- **Bypassing subagents after approval** — sequentially modifying files in the orchestrator instead of dispatching workstreams.

## Gotchas

- **Cross-Harness Tool Names**: Antigravity uses `ask_question`, Claude Code uses `AskUserQuestion`, OpenCode uses `question`. Adapt dynamically without crashing if a specific tool is absent.
- **Single Question per Call**: One question per call is this skill's protocol, even if the underlying tool schema permits multi-question arrays. A batch turns the session back into an overwhelming questionnaire.
- **Previews in Markdown Prose**: Do not rely on tool-specific preview properties (such as Claude Code's `preview` field), which silently drop on multi-select or fail on other harnesses. Markdown prose is the universal preview canvas.
