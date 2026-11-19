---
name: clarify
description: >-
  Walk a non-trivial design through its forks one question at a time. Resolves
  design targets without parameters via a multi-tier recency cascade, explores the
  codebase first, surfaces genuine architectural trade-offs with prose-first
  previews, self-contained dialogs and explicit recommendations, and asks
  interactive single-choice questions across Antigravity, Claude Code, and OpenCode. Supports both deep
  technical architecture (/clarify, /grill-me) and plain-English intuitive mental
  model clarification (/cplain, /celi5). Closes with a decision table, architecture
  artifact, and Jev-aware parallel workstream handoff.
when_to_use: >-
  The user is designing something non-trivial (DB schema, data model, API contract,
  UX flow, architecture, migration) and at least three orthogonal decisions are open,
  each with two or more defensible options — or the user asks to clarify before coding.
  Triggers include /clarify, /grill-me, /cplain, /celi5, /clarify --plain, /clarify --eli5,
  /clarify eli5, "explain like I'm five", "plain english", "cplain", "celi5",
  "walk me through the options", "interview me", "one at a time",
  "clarify architecture before coding", "trade-offs", "design decision",
  "discuss before coding", "architecture without code". Skip for a single isolated choice,
  for urgent implementation where the user said to just build it, or while another
  interactive flow already owns the conversation.
metadata:
  author: doccr
---

# clarify

A working mode for designing something non-trivial together with the user — a database schema, a data model, an API contract, a UX flow, an architecture refactor, or a migration — when several orthogonal forks are open and each carries its own trade-offs.

Unifies `/clarify`, `/grill-me`, `/cplain`, and `/celi5` into a single cross-harness skill compatible with Google Antigravity, Claude Code, and OpenCode.

The point is not to collect answers faster or run a superficial questionnaire. It is to make every decision visible, argued, and reversible while it is still cheap to reverse, before a single line of implementation code is written.

## Relationship to Native Harness Commands (`/grill-me`)

- **Native Antigravity Slash Command**: In Google Antigravity, `/grill-me` is a built-in slash command that injects the native `<GRILL_ME>` system prompt. The `clarify` skill does **not** shadow, replace, or override `/grill-me` at the CLI or parser level.
- **Architectural Fulfillment**: Instead, `clarify` recognizes `/grill-me` as an intentional trigger to fulfill and elevate the native command with industrial-strength discipline: exhaustive fork decomposition (no artificial 4-fork cap), codebase pre-flight discovery, prose-first visual previews, Option A recommendations, and Jev-aware parallel execution handoffs.
- **Cross-Harness Parity**: In Claude Code and OpenCode, where native `/grill-me` does not exist, `clarify` brings this exact interview capability across harnesses under the same command syntax.

## Operational Modes

The skill provides two operational modes tailored to different audiences and depth requirements:

- **Mode A: Standard Architectural Mode (`/clarify`, `/grill-me`)**: Senior engineering mechanics, DDL, DTOs, ERDs, interface contracts, formal invariants, and technical pros/cons. Previews feature code snippets, database schemas, and protocol specs.
- **Mode B: Plain English & Intuitive Mode (`/cplain`, `/celi5`, `--plain`, `--eli5`, `eli5`, "explain like I'm five", "plain english")**: Everyday analogies, mental models, 4-Question framing, Door Type reversibility (One-Way Tattoo vs. Two-Way Sticker), concrete Failure Blast Radius, and Dual-Anchors ("Where the analogy breaks"). Ensures complex architectural decisions are intuitive without sacrificing technical rigor.

## Triggers & When to Enter

- **Slash commands & phrase triggers**:
  - **Standard Architectural Mode**: `/clarify` (universal slash command), `/grill-me` (native slash command in Antigravity; prompt phrase trigger in Claude Code & OpenCode).
  - **Plain English / ELI5 Mode**: `/cplain`, `/celi5`, `/clarify --plain`, `/clarify --eli5`, `/clarify eli5`, `cplain`, `celi5`.
- **User prompts**:
  - **Standard Architecture**: "walk me through the options", "interview me", "one at a time", "clarify architecture before coding", "trade-offs", "let's clarify this first", "design decision", "discuss before coding", "architecture without code".
  - **Plain English / ELI5**: "explain like I'm five", "plain english", "plain english clarification", "explain this simply before coding", "eli5 architecture".
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

When invoked simply as `/clarify`, `/grill-me`, `/cplain`, or `/celi5` without an explicit target or file argument, the skill must determine what architectural topic, plan, or artifact to interrogate. To ensure it focuses on what the user currently cares about without asking an unnecessary disambiguation question, evaluate the following cascade in order:

### 1. The Resolution Cascade

- **Tier 0 — Explicit Argument**:
  - The invocation contains an explicit path or topic string (e.g., `/clarify plans/auth-service.md`, `/clarify database migration`, `/cplain auth service`, `/celi5 database indexing`).
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

Always announce the resolved target and the active operational mode in a single unambiguous declarative line before presenting the fork map:

> Target resolved: **[<target name or path>]** (Mode: <Standard Architecture /clarify | Plain English /cplain>). Decomposing into N orthogonal forks...

*Examples:*
- **Standard Mode:** `> Target resolved: **[plans/auth-service.md]** (Mode: Standard Architecture /clarify). Decomposing into 6 orthogonal forks...`
- **Plain English Mode:** `> Target resolved: **[User Authentication Architecture]** (Mode: Plain English /cplain). Decomposing into 5 orthogonal forks...`

This ensures total transparency: if the skill picked up an artifact the user did not intend to clarify or selected the wrong operational mode, the user can immediately intervene or re-invoke with explicit parameters on the next turn.

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
   - **The total is fixed once the map is announced.** Every `Question N (of Total)` heading, `[Question N of Total]` prefix, and `Fork N/Total` header uses that same N.
   - If the count genuinely changes (a fork is retired, split, or discovered), say so before the next question: `Fork map revised: N → M (<reason>)`. From then on, use M in every counter.
4. **Never batch the questions**: One fork, one interactive question call, one answer. Walk through all N forks sequentially.

## The Shape of Each Step (Prose-First Previews)

All substantive analysis, ASCII diagrams, code snippets, and trade-offs live in the **markdown prose above the tool call**. Prose is the universal canvas: it renders in every harness, and in Antigravity and OpenCode it keeps dialogs, chips, and modal prompts concise and clean. In Claude Code the `AskUserQuestion` dialog may be the only surface the user is sure to see, so there the dialog must also stand on its own (see "B. Claude Code"). Prose is still printed; the rich dialog is added to it, never a replacement for it.

> [!IMPORTANT]
> **Per-fork invariant — every fork gets the full step, every time.**
> Fork N gets the complete step in prose **immediately before its own question call**, with no exceptions:
> - **Mode A**: heading, context, argued options, your reading, and the recommendation.
> - **Mode B**: header with Door Type and Under the Hood, the 4-question framing, and the recommendation.
>
> This holds for forks 2..N too, including when the previous answer arrived as a tool result inside the same turn. An answer arriving as a tool result is not a reason to skip the next step.

The step structure adapts based on the active operational mode:

---

### Mode A: Standard Architectural Step Format (`/clarify`, `/grill-me`)

#### 1. Heading and Context

A short numbered heading:

```markdown
## Question N (of Total) — <name of the fork, four to eight words>
```

Below it, **two to four sentences of context**: what is being decided, why it matters, and what it will constrain downstream.

#### 2. Options, Argued

For each option (two to four options per fork):

- **Option A is ALWAYS the Recommended Option**: Formulate the best architectural path as **Option A**, titled `### Option A. <name> (Recommended)`. This guarantees that:
  - Option A is presented first in prose.
  - Option A is placed first in the interactive selection tool with the `(Recommended)` tag, satisfying harness-level requirements (like Antigravity `ask_question`).
  - In the selection UI, Option A is assigned number `1.` (`1. (Recommended) Option A: <name>`), followed by `2. Option B: <name>`, `3. Option C: <name>`. The numbers and letters align in identical 1:1 order without confusing the user.
- Subsequent options are labeled `### Option B. <name>`, `### Option C. <name>`, etc.
- A technical block for each option — ASCII diagram, code snippet, DTO, schema, or formula.
- **Pros:** two to four concrete points.
- **Cons:** two to four concrete points.

Options must be **mutually exclusive** and genuinely different in consequence. If two differ only cosmetically, merge them or drop one.

#### 3. Your Reading, and a Recommendation

After the options, **three to six sentences**: why Option A is recommended, under what specific conditions that recommendation would flip to Option B or C, and what downstream forks this decision cascades into.

Close with a one-line recommendation:

> **Recommendation:** **Option A: <name>** — <one clause explaining why>.

---

### Mode B: Plain English & Intuitive Step Format (`/cplain`, `/celi5`)

Plain English mode translates technical trade-offs into accessible mental models, everyday analogies, and clear risk boundaries while maintaining technical precision underneath.

#### 1. Header with Door Type & Under the Hood Anchor

Every question in Plain Mode begins with a clear classification of reversibility and its technical domain:

```markdown
## Question N (of Total) — <Everyday Descriptive Name>
> **Door Type:** One-Way Door (Tattoo — high cost to reverse) | Two-Way Door (Sticker — easily changed)
> **Under the Hood:** <Formal Engineering Topic / Subsystem>
```

- **One-Way Door (Tattoo)**: High cost to reverse. Hard or destructive to undo once code and data are live (e.g. database schema topology, primary storage engine, public API protocol contracts).
- **Two-Way Door (Sticker)**: Easily changed. Low cost to reverse or iterate upon (e.g. cache TTL duration, polling interval, worker batch chunk size, internal retry limits).

#### 2. The 4-Question Framing

Structure the markdown prose above the tool call around these four questions:

##### 1. What problem are we actually solving?
1–2 plain-English sentences removing all jargon, explaining the practical user-facing or system challenge.

##### 2. What are our choices in plain English?
Present two to four mutually exclusive choices. **Option A is ALWAYS the Recommended Option** (`### Option A. <Analogy Name> (Recommended)`).

For each option, provide:
- **Everyday Analogy**: A relatable real-world comparison (e.g., "The Digital Sticky Tag", "The Fast-Food Drive-Through Lane", "The Central Dispatch Office").
- **Conceptual ASCII Sketch**: Simple mental model diagram (not raw code or DDL).
- **Under the Hood**: Formal engineering mechanism/term (e.g., `M:N Join Table with compound unique index`, `Redis pub/sub ring buffer`, `Optimistic locking with version column`).
- **Where the Analogy Breaks**: The exact boundary where the real-world analogy stops matching software reality, preventing false assumptions.

*Example Option Format:*
```markdown
### Option A. The Digital Sticky Tag (Recommended)
- **Everyday Analogy**: Like sticking a color-coded reusable post-it note on a folder.
- **Mental Model**:
  [Record Folder] <---> [Sticky Tag Box] <---> [Tag Name]
- **Under the Hood**: Normalized `record_tags` join table with foreign keys and compound unique index `(record_id, tag_id)`.
- **Where the Analogy Breaks**: Unlike physical sticky notes that fall off or tear, database join rows never peel off accidentally and enforce strict referential integrity.
```

##### 3. What are the tangible trade-offs & blast radius?
- **What gets easier (Pros)**: 2–3 concrete operational or developer benefits.
- **Failure Blast Radius / Rework Cost (Cons)**: What happens if this assumption is wrong? How much work is required to undo this decision? Who or what gets affected?

##### 4. Why is Option A the common-sense pick?
- 2–3 plain sentences explaining why Option A is the pragmatic default.
- Specific scenario or constraint under which the recommendation would flip to Option B or C.

Close with the recommendation line:

> **Recommendation:** **Option A: <Analogy Name> (<Formal Tech Anchor>)** — <one plain sentence explaining why>.

---

### Adaptive Interactive Tool Calling

After printing the markdown analysis, **ALWAYS invoke the harness-appropriate interactive question tool**.

> [!CRITICAL]
> **MANDATORY TOOL CALL RULE — NEVER OMIT THE TOOL CALL**:
> In Google Antigravity (Web UI and IDE), Claude Code, and OpenCode, interactive selection chips, radio buttons, and terminal comparison pickers are rendered **exclusively when an active question tool is called**.
> - **Antigravity**: MUST call `ask_question`. If the agent merely outputs markdown text without invoking `ask_question`, the Web UI silently degrades to static markdown text, forcing the user to type answers manually.
> - **Claude Code**: MUST call `AskUserQuestion` (with `"multiSelect": false`).
> - **OpenCode**: MUST call `question`.
> **Never terminate a question turn with markdown prose alone.** Every single fork step MUST conclude with the native tool call. Only when running in headless environments where no interactive question tool is exposed should the terminal CLI fallback be used.

> [!IMPORTANT]
> **Strict Option Naming & Sequence Rule**:
> Options in the selection tool MUST be named with their explicit letter prefix and title in the exact order they appeared in prose:
> - **Mode A (Architecture)**:
>   - `1. (Recommended) Option A: <name>`
>   - `2. Option B: <name>`
>   - `3. Option C: <name>`
> - **Mode B (Plain English)**:
>   - `1. (Recommended) Option A: <Analogy Name> (<Formal Tech Anchor>)`
>   - `2. Option B: <Analogy Name> (<Formal Tech Anchor>)`
>   - `3. Option C: <Analogy Name> (<Formal Tech Anchor>)`
> Never emit bare option names without the `Option X:` prefix, and never reorder options in the selection tool.

> [!IMPORTANT]
> **Mandatory Question Counter Prefix (`[Question N of Total]`)**:
> Harness interactive question widgets (such as Google Antigravity) compute their UI badge (`Question 1/1`) solely from the single-element tool call array (`questions.length`). Because `clarify` deliberately runs single-question turns to preserve markdown trade-off depth, the UI's native pager badge always shows `1/1`.
> **To ensure the user always sees their exact progress through the clarification session**, agents MUST ALWAYS prefix the question string with the explicit fork counter:
> - Format: `"[Question N of Total] <Question text>"` (or `"[Fork N of Total] <Question text>"`)
> - In Antigravity: `"question": "[Question 5 of 9] Which cross-harness title write-back strategy should ax adopt?"`
> - In Claude Code & OpenCode: Also set `"header": "Fork 5/9"` (or `"Q5/9: Strategy"`).

#### A. Google Antigravity (`ask_question`)

Uses `ask_question`. The recommended option (Option A) is listed first and prefixed with `(Recommended)`. The question string is prefixed with `[Question N of Total]`. The UI automatically prepends numbers (`1.`, `2.`, `3.`) and appends an `Other` option:

**Mode A (Standard Architecture):**
```json
ask_question({
  "questions": [
    {
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
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

**Mode B (Plain English / ELI5):**
```json
ask_question({
  "questions": [
    {
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "options": [
        "(Recommended) Option A: The Digital Sticky Tag (M:N Join Table)",
        "Option B: The Direct Sharpie Label (Denormalized JSONB)",
        "Option C: The Comma List on the Box (Delimited String)"
      ],
      "is_multi_select": false
    }
  ]
})
```

*What the user sees in the Antigravity UI picker (Mode B):*
```
1. (Recommended) Option A: The Digital Sticky Tag (M:N Join Table)
2. Option B: The Direct Sharpie Label (Denormalized JSONB)
3. Option C: The Comma List on the Box (Delimited String)
4. Other
```

#### B. Claude Code (`AskUserQuestion`)

Uses `AskUserQuestion` with a short `header` and `label`, a self-sufficient `description` and `preview` on every option, and `"multiSelect": false` (strictly required by Claude Code; `preview` renders only on single-select forks). Claude Code may show the user only the dialog, so the dialog carries the argument in addition to the prose step above it:

- **`description`**: two to three sentences per option — what it does, the main pro, the main con. Target 150–300 characters, never under 120. In Mode B it also carries the analogy.
- **`preview`**: a technical or mental-model block, followed by `+` pro lines and `- con` lines, about 6–12 lines in all. In Mode B it holds the sketch, an `Under the hood:` line, a `Door:` line (Tattoo or Sticker), then the `+` and `-` lines.
- **Prose stays**: the full step is still printed above the call (see the per-fork invariant). The dialog repeats the essentials; it does not replace the analysis.
- **Final `→ next:` line**: every option's `preview` ends with `→ next: full Question N+1 write-up, then ask` (on the last fork: `→ next: decision table and closing`). The `AskUserQuestion` tool result echoes the chosen option's preview, so this line lands right beside any output-style brevity reminder and counters it. Keep previews within about 12 lines including it.

**Mode A (Standard Architecture):**
```json
AskUserQuestion({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
      "multiSelect": false,
      "options": [
        {
          "label": "Option A: M:N join table (Recommended)",
          "description": "Normalized join table with a compound unique index on (record_id, tag_id). Tags are queryable from either side and a rename touches one row. Costs one extra join per tagged read and a separate table to migrate.",
          "preview": "record_tags\n  record_id -> records.id\n  tag_id    -> tags.id\n  UNIQUE (record_id, tag_id)\n\nRead: JOIN record_tags USING (record_id)\n+ FK integrity, rename a tag in one row\n+ indexed lookups from either side\n- extra join on every tagged read\n- one more table to migrate and back up\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option B: Denormalized JSONB array",
          "description": "Embedded JSON array on the record row, queried through a GIN index. Writes stay in one row and reads need no join. Renaming or aggregating tags means scanning every row, and there are no foreign keys.",
          "preview": "records\n  id\n  tags: jsonb -- ['backend', 'urgent']\n\nIndex: GIN (tags jsonb_path_ops)\n+ single-row write, no join on read\n+ no extra table to migrate\n- rename a tag = rewrite every row\n- no FK, a typo becomes a new tag\n- tag counts need a full scan\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option C: Single-tenant delimited string",
          "description": "Comma-delimited string in one text column on the record. Zero relations and the fastest start, but matching needs LIKE patterns, a typo silently creates a new tag, and fixing it later is a full data migration.",
          "preview": "records\n  id\n  tags: text -- 'backend,urgent'\n\nRead: tags LIKE '%urgent%'\n+ trivial to start, no schema work\n- LIKE cannot use a normal index\n- 'urgent' also matches 'non-urgent'\n- a comma inside a tag breaks parsing\n- later migration touches every row\n→ next: full Question 2 write-up, then ask"
        }
      ]
    }
  ]
})
```

**Mode B (Plain English / ELI5):**
```json
AskUserQuestion({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "multiSelect": false,
      "options": [
        {
          "label": "Option A: The Digital Sticky Tag (M:N Join Table) (Recommended)",
          "description": "Like reusable sticky notes on a folder: each note lives in its own box and can be moved or renamed freely. Searchable from either side with clean integrity, but you maintain an extra index-card box (a join table).",
          "preview": "[Records] <---> [Sticky Tag Box] <---> [Tags]\n\nUnder the hood: record_tags join table, UNIQUE (record_id, tag_id)\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ rename a tag once, every folder follows\n+ searchable from either side\n- one more table to maintain\n- a join on every tagged read\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option B: The Direct Sharpie Label (Denormalized JSONB)",
          "description": "Like writing tags in ink directly on the folder. Fast to write and nothing extra to maintain, but finding every folder with one tag means opening them all, and renaming a tag means rewriting each folder.",
          "preview": "[Record Folder]\n  tags in ink: [urgent, backend]\n\nUnder the hood: jsonb array column on records with a GIN index\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ one write, no joins\n+ no extra table\n- rename = rewrite 10,000 folders\n- no integrity check, typos spawn new tags\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option C: The Comma List on the Box (Delimited String)",
          "description": "Like jotting tags separated by commas on the box lid. Quickest to start and needs no schema work, but a typo breaks the search, similar names collide, and untangling it later means rewriting every box.",
          "preview": "[Record Folder]\n  lid: \"urgent,backend\"\n\nUnder the hood: delimited text column, matched with LIKE\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ zero setup\n- typos and near-names silently break searches\n- no index can help, every search is a full scan\n- a comma inside a tag corrupts the list\n→ next: full Question 2 write-up, then ask"
        }
      ]
    }
  ]
})
```

#### C. OpenCode (`question`)

Uses `question` following standard option schema with `Option A:` labels:

**Mode A (Standard Architecture):**
```json
question({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
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

**Mode B (Plain English / ELI5):**
```json
question({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "options": [
        {
          "label": "Option A: The Digital Sticky Tag (M:N Join Table) (Recommended)",
          "description": "Like reusable sticky notes. Independent, clean, but needs a separate index card box."
        },
        {
          "label": "Option B: The Direct Sharpie Label (Denormalized JSONB)",
          "description": "Like writing directly on the folder. Fast to write, but harder to search all folders for one tag."
        },
        {
          "label": "Option C: The Comma List on the Box (Delimited String)",
          "description": "Writing tags separated by commas. Quickest to start, messy to organize later."
        }
      ]
    }
  ]
})
```

#### D. Terminal CLI Fallback

When running in headless CLI environments or where no interactive question tool is bound:

**Mode A (Standard Architecture):**
```markdown
Which data model should we use for record tagging?
1. (Recommended) Option A: M:N join table
2. Option B: Denormalized JSONB array
3. Option C: Single-tenant delimited string
```

**Mode B (Plain English / ELI5):**
```markdown
How should we organize user tags on records?
1. (Recommended) Option A: The Digital Sticky Tag (M:N Join Table)
2. Option B: The Direct Sharpie Label (Denormalized JSONB)
3. Option C: The Comma List on the Box (Delimited String)
```

Wait for the user's text reply before advancing to the next fork.

## After Each Answer

The order is fixed: **Noted line → full Question N+1 step → tool call.** The acknowledgement is short; the next step is not.

1. **Acknowledge in one line:**

   > Noted: **<chosen option>**. <Optionally, one clause on what it cascades into.> On to the next.

2. **Then print the full step for Question N+1** — heading, context, argued options, reading, recommendation (Mode A) or the Door Type header, 4-question framing, and recommendation (Mode B) — and only then call the question tool. This applies even when the answer arrived as a tool result in the same turn.
3. **Do not re-show the fork that was just answered** — no recap of its options or preview. The next fork still gets its full step.
4. If the answer makes a later fork moot — choosing multi-select dissolves a pending question about a tag limit — **say so immediately**: "Choosing X retires fork Y; next is Z."
5. If the answer carries a clarification that touches decisions already taken, **revisit them out loud**. Never silently. "This clarification affects decisions N and M — reopening both."
6. If the user picks "Other" and supplies their own answer, **take it without pushback** and re-check the remaining forks against it.

## Closing the Series & Jev-Aware Execution Handoff

Once all forks are resolved, present the consolidated architectural blueprint and transition gate.

### 1. Decision Table

#### Mode A (Standard Architecture)

| # | Decision Topic | Chosen Option | Changed? |
|---|----------------|---------------|----------|
| 1 | <topic> | Option A: <formal technical decision> | unchanged / revised |
| 2 | <topic> | Option B: <formal technical decision> | new |

#### Mode B (Plain English / ELI5)

| # | Decision Topic | Plain English Analogy | Under the Hood | Door Type | Changed? |
|---|----------------|-----------------------|----------------|-----------|----------|
| 1 | Tag Storage | The Digital Sticky Tag | M:N Join Table | Two-Way (Sticker) | unchanged / revised |
| 2 | Cache Invalidation | The Daily Menu Board | TTL Cache Invalidation | One-Way (Tattoo) | new |

The "Changed?" column earns its place only if something was revised mid-series; drop it when every decision held.

### 2. Final Architecture Artifact

Assemble the **final picture**:
- **Mode A (Standard Architecture)**: Complete technical blueprint — complete ASCII diagram, DTOs/schemas, state machines, API contracts, and governing invariants in a single consolidated block.
- **Mode B (Plain English / ELI5)**: Dual-layer blueprint providing **both** the conceptual ASCII mental model (everyday system metaphor) and the formal technical specification (under-the-hood contracts, schemas, and invariants). This bridges the intuitive high-level understanding with rigorous implementation-ready contracts.

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
- **Step format agrees with terse output styles.** The user asked for the full step by invoking clarify, and terse styles treat requested detail as what the user needs (Concise's own rule: give full detail on request). So under Concise or a similar style, the full step is the required content, not padding. Only the acknowledgements ("Noted: ...") and the closing stay terse.

## Anti-Patterns

- **Text-only question turns (Omitting the tool call)** — printing options as markdown text without calling `ask_question` (Antigravity), `AskUserQuestion` (Claude Code), or `question` (OpenCode). This silently disables the interactive UI picker widget in Web/IDE harnesses and forces the user to manually type replies.
- **Artificial 4-fork truncation** — capping the clarification at 3 or 4 superficial questions when major architectural dimensions (persistence, error handling, auth, concurrency, lifecycle) remain unclarified.
- **Unlabeled or scrambled options in selection** — emitting options in the interactive tool without `Option A:`, `Option B:` prefixes, or reordering them so they disagree with the prose preview.
- **Analogy without technical anchor (Plain Mode)** — using everyday analogies without naming the "Under the Hood" engineering mechanism or "Where the analogy breaks". A metaphor without an anchor is fiction, not architecture.
- **Skipping Door Type or failure blast radius (Plain Mode)** — failing to classify decisions as One-Way (Tattoo) vs Two-Way (Sticker), or omitting the failure blast radius if the assumption is wrong.
- **Firing options without codebase discovery** — asking questions the codebase already answers damages trust.
- **Firing options without analysis** — that is a questionnaire, not a clarification.
- **Options with no preview in prose** — the visual comparison is the point. If a fork resists having a preview, it may not be a fork worth this mode.
- **Overloading tool call descriptions with previews (Antigravity / GUI harnesses whose dialogs take plain strings)** — breaks modal dialogs. There, keep previews in markdown prose. This does **not** apply to Claude Code: a thin `AskUserQuestion` dialog (one-line descriptions, no pros and cons in `preview`) is the anti-pattern there.
- **Back-to-back question calls** — two question tool calls with no step prose between them. An answer arriving as a tool result is not a reason to skip the next step: every fork gets its full step immediately before its own call.
- **Two options that mean the same thing** — merge them.
- **Hiding the recommendation** — without a `(Recommended)` tag you are not helping, you are polling.
- **Silent revision of earlier decisions** — always name what changed and why out loud.
- **Ending without the decision table** — by step seven the user no longer remembers what they chose at step three.
- **Sliding into code without a go** — always require explicit user confirmation before modifying code.
- **Bypassing subagents after approval (when subagents or Jev are available in multi-agent environments)** — sequentially modifying files in the orchestrator instead of dispatching workstreams.

## Gotchas

- **Cross-Harness Tool Names**: Antigravity uses `ask_question`, Claude Code uses `AskUserQuestion`, OpenCode uses `question`. Adapt dynamically without crashing if a specific tool is absent.
- **Single Question per Call**: One question per call is this skill's protocol, even if the underlying tool schema permits multi-question arrays. A batch turns the session back into an overwhelming questionnaire.
- **UI "Question 1/1" Widget Counter Override via Prefix**: Harness question dialogs (such as Google Antigravity) compute their badge strictly from the single-turn array length (`1/1`). To ensure the user always sees their exact progress through the session (e.g. Question 5 of 9), the agent MUST prepend `[Question N of Total]` (e.g. `[Question 5 of 9]`) to the `question` argument in `ask_question`, and set `header: "Fork N/Total"` in Claude Code and OpenCode.
- **Option Naming & Ordering in Selection**: Every option in the interactive selection tool MUST be named `Option A: <name>`, `Option B: <name>` in the exact sequence they appeared in prose. The UI numbers them (`1.`, `2.`, `3.`), rendering `1. Option A: <name> (Recommended)`, `2. Option B: <name>`, etc. Always make Option A the recommended path so that the recommendation is first without breaking letter ordering.
- **Plain Mode Dual Anchoring**: In Plain English mode, always format option names as `Option X: <Analogy Name> (<Formal Tech Anchor>)` to preserve both conversational intuition and engineering clarity in the picker UI.
- **Door Type Classification**: One-Way Doors (Tattoos) are expensive or destructive to undo (database storage engine, primary key schema, public API shape, distributed protocol). Two-Way Doors (Stickers) are cheap to change (cache TTL, batch chunk size, retry count, UI label phrasing). Make this distinction explicit in Plain Mode.
- **Dual Anchors ("Where the Analogy Breaks")**: Every analogy breaks somewhere. Explicitly identifying the break-point prevents false mental models that could cause bad downstream assumptions.
- **Total Forks vs. Options per Fork Distinction**: Clarify this distinction carefully: **4 options per question is the harness limit for choices**, NOT a limit on the total number of architectural forks in the session! A comprehensive clarification should uncover **all** genuine architectural forks (e.g. 5 to 12+), sweeping across all architectural dimensions, and walk through them one by one.
- **Previews in Markdown Prose**: Prose is always required — it is the universal preview canvas across all harnesses, so never rely on tool-specific preview properties alone. In Claude Code, add a rich dialog on top (full `description` plus `preview` with `+`/`-` lines), because the dialog may be the only thing shown.
- **Output-style reminders after tool results**: Terse output styles re-inject a brevity reminder after each answer comes back. The preview's `→ next:` line is the counterweight; never drop it.
- **Fork Count Is Locked**: The total N is fixed when the fork map is announced. If it changes, state `Fork map revised: N → M (<reason>)` before the next question and use M in every counter from then on. A silently drifting counter ("of 5" then "of 3") reads as a bug.
- **Claude Code `preview` Rendering**: In Claude Code, the `preview` field renders only when `multiSelect: false`. On a multi-select fork the preview blocks silently do not appear in the terminal UI comparison box — keep the comparison in markdown prose.
- **Option Count & Limits**: Four options per question is the harness limit. "Other" is automatically appended by the UI; never add a manual "Other" option.
