---
name: clarify
description: >-
  Walk a non-trivial design through its forks one question at a time: explore the
  codebase first, argue each trade-off in prose, ask one interactive single-choice
  question per fork, and close with a decision table and a Jev-aware handoff.
  Works in Antigravity, Claude Code and OpenCode. Mode A is technical
  (/clarify, /grill-me); Mode B is plain English (/cplain, /celi5).
when_to_use: >-
  The user is designing something non-trivial (schema, data model, API contract, UX
  flow, architecture, migration) with at least three orthogonal open decisions, or asks
  to clarify before coding. Triggers: /clarify, /grill-me, /clarify:plain, /clarify:eli5, /cplain, /celi5, cplain, celi5,
  --plain, --eli5, /clarify eli5, "explain like I'm five", "plain english", "walk me
  through the options", "interview me", "one at a time", "trade-offs", "design
  decision", "discuss before coding", "clarify architecture before coding",
  "architecture without code". Skip for a single isolated choice, when the user said to
  just build it, or while another interactive flow owns the conversation.
metadata:
  author: doccr
---

# clarify

A working mode for designing something non-trivial with the user when several orthogonal forks are open and each carries its own trade-offs. It makes every decision visible, argued, and reversible while it is still cheap to reverse, before any implementation code is written.

- **Mode A: Standard Architectural (`/clarify`, `/grill-me`)**: senior engineering mechanics, DDL, DTOs, interface contracts, formal pros and cons.
- **Mode B: Plain English (`/clarify:plain`, `/clarify:eli5`, `/cplain`, `/celi5`, `cplain`, `celi5`, `--plain`, `--eli5`, `eli5`, `/clarify eli5`, "explain like I'm five", "plain english")**: everyday analogies, Door Type reversibility (One-Way Tattoo vs Two-Way Sticker), failure blast radius, and "where the analogy breaks".

Do not enter for a single question with a single choice, a trivial fork (`let` vs `const`), urgent implementation the user told you to just build, or while another interactive flow (plan mode, a setup wizard) owns the conversation.

## Read before the first question

Read exactly these, once, relative to this skill directory:

- **Your harness's reference**, picked by which question tool exists: `references/antigravity.md` (`ask_question`), `references/claude-code.md` (`AskUserQuestion`), `references/opencode.md` (`question`). None for the Terminal CLI fallback (below).
- **`references/plain-mode.md`**, only in Mode B.
- **`references/closing.md`**, only after the last fork has been answered.

The rules in this file apply on every question; the references hold examples and formats.

## Rules that apply on every question

> [!CRITICAL]
> **Same-Reply Invariant.** A `## Question N (of Total)` heading and the interactive question tool call MUST appear in the same assistant reply. Never end a turn after `> **Recommendation:**` without the call.
> - Antigravity: `ask_question`. Claude Code: `AskUserQuestion` with `"multiSelect": false`. OpenCode: `question`.
> - Pickers render only when the tool is called; prose alone degrades to static text and the user has to type answers.
> - Never print numbered text options when a question tool exists; numbered text options belong only in the Terminal CLI fallback.
> - Use the Terminal CLI fallback only when no question tool is exposed.
> - Antigravity also needs the clarify Stop hook (see `references/antigravity.md` and the plugin README).

> [!IMPORTANT]
> **Per-fork invariant.** Fork N gets its complete step in prose immediately before its own question call, for forks 2..N too, with no exceptions. An answer arriving as a tool result in the same turn is not a reason to skip the next step. Mode A: heading, context, argued options, your reading, recommendation. Mode B: Door Type and Under the Hood header, the 4-question framing, recommendation.

- **Option naming rule.** Option A is always the recommended option, titled `### Option A. <name> (Recommended)` in prose and `1. (Recommended) Option A: <name>` in the Antigravity and terminal picker (Claude Code and OpenCode labels use the suffix: `Option A: <name> (Recommended)`); then `Option B: <name>`, `Option C: <name>`, in the same order as the prose. Mode B names read `Option X: <Analogy Name> (<Formal Tech Anchor>)`. Never emit a bare option name, never reorder, never add a manual "Other" (the UI adds it). Four options per question is the harness limit; it is not a limit on the number of forks.
- **Counter prefix rule.** Harness widgets count only the single-element call array (`1/1`), so you MUST always prefix the question string: `"[Question N of Total] <text>"` (or `[Fork N of Total]`). In Claude Code and OpenCode also set `"header": "Fork N/Total"`.
- **Fork count is locked.** The total is fixed when the fork map is announced, and every counter uses it. If it genuinely changes (a fork is retired, split or discovered), say `Fork map revised: N → M (<reason>)` before the next question and use M from then on. A silently drifting counter ("of 5" then "of 3") reads as a bug.
- **One question per call.** One fork, one question call, one answer. Never batch, even if the tool schema allows arrays.
- **Prose first.** All analysis, diagrams, snippets and trade-offs live in the markdown prose above the call; it renders in every harness. In Claude Code the dialog may be the only surface the user sees, so there it must also stand on its own (`references/claude-code.md`); in Antigravity and OpenCode keep previews out of the dialog strings. The dialog never replaces the prose.
- **Claude Code dialog rules** (the dialog may be the only thing the user sees, so it must carry the argument): `"multiSelect": false` (previews render only then; on a multi-select fork they silently do not appear), a short `header`, and a `label` with the `Option X:` prefix. Each `description` is 2–3 sentences (what it does, main pro, main con), 150–300 characters, never under 120 (Mode B: include the analogy). Each `preview` is a technical or mental-model block plus `+` and `-` lines, about 6–12 lines (Mode B adds `Under the hood:` and `Door:` lines), and ends with `→ next: full Question N+1 write-up, then ask` (last fork: `→ next: decision table and closing`). Full examples: `references/claude-code.md`.
- **Terse output styles.** Invoking clarify asks for the full step, and terse styles treat requested detail as what the user needs (Concise's own rule: give full detail on request), so under Concise or a similar style the full step is the required content, not padding. Only the "Noted: ..." lines and the closing stay terse. Terse styles re-inject a brevity reminder after each answer; the `→ next:` preview line (Claude Code) is the counterweight, so never drop it.
- **No code without a go.** Never modify code before the user explicitly confirms after the closing.

## Pre-flight Investigation (Codebase Discovery)

Before forming forks, investigate the codebase: use `fd`, `rg` and file reads to find existing conventions, folder layouts, types, schemas and dependencies. If a question can be answered from the repository ("which ORM is used?"), adopt the established pattern silently. Ask the user only genuine architectural forks, never facts already in the repo.

## Target Resolution When Invoked Without Parameters

When invoked as a bare `/clarify`, `/grill-me`, `/cplain` or `/celi5`, decide what to interrogate by evaluating this cascade in order, without asking a disambiguation question:

- **Tier 0, explicit argument**: a path or topic in the invocation (`/clarify plans/auth-service.md`, `/cplain auth service`). Use it directly.
- **Tier 1, recent chat pivot**: the user's latest message pivots away from earlier plans ("instead", "forget that", "new plan", "different approach") or posts a fresh proposal. Use that proposal.
- **Tier 2, active session plan files**: plan documents created or touched in this session, newest first: Antigravity artifacts in `<appDataDir>/brain/<conversation-id>/*.md`; Claude Code / OpenCode files matching `plan*.md`, `*-plan.md` or `./.claude/plans/*.md`; local markdown links in recent turns.
- **Tier 3, model-suggested plan**: an in-memory proposal from the previous one or two turns not yet on disk. It outranks the historical sweep.
- **Tier 4, historical plan sweep**: the most recently modified `./plans/*.md` or `docs/plans/*.md`.
- **Tier 5, active task goal**: the overarching task or workspace goal from session memory.

Always announce the resolved target and mode in one declarative line before the fork map, so the user can correct a wrong pick on the next turn:

> Target resolved: **[<target name or path>]** (Mode: <Standard Architecture /clarify | Plain English /cplain>). Decomposing into N orthogonal forks...

Example: `> Target resolved: **[plans/auth-service.md]** (Mode: Standard Architecture /clarify). Decomposing into 6 orthogonal forks...`

## Before the First Question

1. **Decompose exhaustively into all genuine architectural forks.** There is no cap of 3 or 4: if the design has 6, 8 or 12 forks, walk through all of them, because a cap leaves decisions to silent assumption. Forks must be orthogonal (answering one must not predetermine another); omit only derived or cosmetic choices.
2. **Sweep the taxonomy** so no dimension is missed:
   - Core architecture and topology; data model and schemas; state, persistence and caching.
   - API and protocol contracts; concurrency, sync and locking; error handling and failure modes.
   - Security, auth and privacy; lifecycle and execution flow (push vs pull, event vs cron).
   - UI/UX and interaction model; migration, rollback and compatibility.
3. **Present the complete fork map upfront**, compact, one short line per fork:
   > Identified N orthogonal architectural forks across [topics]: [list]. We start with Fork 1: <topic>.
   - Format each line `- **Fork k:** <topic> (<3–6 word scope>)`.
   - **Turn-1 single-reply invariant:** target announcement, fork map, Question 1 prose and the question tool call all complete in this same Turn 1 reply.

## The Shape of Each Step (Mode A)

````markdown
## Question N (of Total) — <name of the fork, four to eight words>
````

- **Context:** two to four sentences: what is decided, why it matters, what it constrains downstream.
- **Recommendation first:** decide which option you recommend before writing any `### Option X.` heading, and make it Option A. If your view changes while drafting, rewrite the headings in place; never correct it in a later sentence or reorder only the picker.
- **Options, argued** (two to four, mutually exclusive, genuinely different in consequence; merge cosmetic differences): for each, a technical block (ASCII diagram, snippet, DTO, schema or formula), **Pros** (two to four concrete points) and **Cons** (two to four). Four to eight lines of pros and cons per option is plenty.
- **Your reading:** three to six sentences: why Option A is recommended, under what conditions it would flip to B or C, and which later forks this cascades into.
- **Recommendation line:**

  > **Recommendation:** **Option A: <name>** — <one clause explaining why>.

- **Then the tool call:** invoke the question tool in the same reply, straight after the Recommendation. Print no extra cue line.

Mode B's full format (Door Type and Under the Hood header, 4-question framing, example option) is in `references/plain-mode.md`. Read it before the first question in Mode B.

### Terminal CLI Fallback

Only when no interactive question tool is bound. Print the question and the numbered options, then wait for the user's text reply before the next fork.

```markdown
Which data model should we use for record tagging?
1. (Recommended) Option A: M:N join table
2. Option B: Denormalized JSONB array
```

In Mode B use `Option A: The Digital Sticky Tag (M:N Join Table)` style names.

## After Each Answer

The order is fixed: **Noted line → full Question N+1 step → tool call.** The acknowledgement is short; the next step is not.

1. Acknowledge in one line: `Noted: **<chosen option>**. <Optional clause on what it cascades into.> On to the next.`
2. Print the full step for Question N+1, then call the tool. This applies even when the answer arrived as a tool result in the same turn. Do not re-show the fork just answered.
3. If the answer makes a later fork moot, say so at once: "Choosing X retires fork Y; next is Z."
4. If the answer touches decisions already taken, revisit them out loud, never silently: "This clarification affects decisions N and M — reopening both."
5. If the user picks "Other" and supplies their own answer, take it without pushback and re-check the remaining forks against it.

## Closing the Series & Jev-Aware Execution Handoff

Once all forks are resolved, read `references/closing.md` for the full format. In short: present the Decision Table, the final architecture artifact and the parallel workstream breakdown, then stop and ask for confirmation. After the go, detect Jev and dispatch the workstreams. In Mode B use the Mode B table and artifact from `references/plain-mode.md`.

## Style

- Keep your normal voice; the mode governs structure, not personality. Precise terminology in the analysis; preview blocks are monospaced ASCII; emoji only where they carry meaning.
- Do not apologise for the length of the analysis, and do not pad it.

## Anti-Patterns

Each of these breaks a rule above:

- Text-only question turns, or unlabeled and reordered options (Same-Reply Invariant, Option naming rule).
- Capping at 3 or 4 forks, or two options that mean the same thing.
- Asking what the codebase already answers, or firing options without analysis or a prose preview.
- Back-to-back question calls with no step prose between them; skipping the next step because the answer arrived as a tool result.
- Hiding the recommendation, silently revising earlier decisions, or ending without the Decision Table.
- Plain Mode: an analogy without an "Under the Hood" anchor and a "where the analogy breaks", or no Door Type and failure blast radius.
- Overloading dialog strings with previews in Antigravity or other GUI harnesses (it breaks modal dialogs); a thin dialog in Claude Code (one-line descriptions, no `+`/`-` preview) is the opposite failure.
- Sliding into code without a go, or, once approved with subagents or Jev available, editing files sequentially in the orchestrator instead of dispatching workstreams.
