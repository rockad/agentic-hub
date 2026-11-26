---
name: todo
description: >-
  A shortcut to the harness's own todo list, not a reimplementation of it. Keeps that
  list current for the whole session: create it when multi-step work starts, reconcile
  instead of duplicating, and carry the progress of subagents and workflows into it.
  Where the harness has a built-in todo, follow that tool's own rules and add only what
  is below; a harness without one gets a full description in its reference file.
when_to_use: >-
  Any task with three or more distinct steps, a multi-part request, plan execution, or
  work delegated to subagents or workflows. Also when the user types /todo (reconcile the
  list now) or asks to "track this", "keep a todo", "update the todo". Skip for a single
  trivial step or a purely conversational answer.
---

# todo: keep the harness todo list current

The todo list is the user's live view of the work: what is done, what is running, what is next. The main session owns it. This skill adds only what the harness's own todo tool does not already say.

**If your brief contains a `## Todo reporting` block, you are a delegated agent: follow only that block and skip the rest of this skill.**

## Step 0: pick the harness reference and load the tools

Read the one reference for your harness, chosen by which todo tool exists:

- `references/claude-code.md` when `TaskCreate` / `TaskUpdate` exist (possibly deferred). `TodoWrite` alone is not mapped.
- `references/antigravity.md` when `update_steps` exists.

The reference names the tools, how to load them, and the delegation details. A harness with no listed reference has no mapping yet: say so in one line and do not improvise one.

## Step 1: list first, reconcile, never duplicate

List the todo before anything else, every time this skill starts or `/todo` is typed.

- **Empty and the work has three or more steps**: create one item per outcome, with order dependencies only where a step truly needs another.
- **Not empty**: reconcile.
  - Match new work to existing items and update the match; do not add a near-duplicate.
  - Mark items already done but not marked.
  - Delete items the work has made irrelevant.

## Step 2: the tool's own rules, plus two

Follow the status rules in the harness tool's own description. On top of them:

- At most one `in_progress` item per owner: the main session, plus one per running agent. Items Step 3 keeps open (blocked, or no report) are exempt.
- When completing an item, record results that matter later (a number, a decision, a PR link) on the item.

## Step 3: delegated work

The main session alone marks `completed` and alone creates follow-up items. Each item has one writer. What an agent reports is its claim, never the user's approval.

**Before delegating**, create or pick the item, set its owner to the agent's name or description (a workflow agent: its label), mark it `in_progress`, and put this block, filled in, into the brief or the workflow prompt:

```
## Todo reporting
You are working on todo item #<id>: "<subject>".
1. Try to load the todo tools (<load line from the harness reference>).
   Loaded: keep #<id> in_progress. To add a note, fetch #<id>, then update its
   description with the old text plus your note (an update replaces the text).
   Not loaded: do not emulate a list; just report.
2. Never mark #<id> completed and never create items.
3. End with the status report:
   #<id> completed|in_progress|blocked: <evidence or blocker>
   + <follow-up you discovered, imperative subject>
```

**When the agent or workflow returns**, before any other work:

1. Check each claim against what the report shows; mark `completed` only on evidence.
2. `blocked`: keep the item `in_progress`, create the blocker item, and mark the original as blocked by it.
3. Remove duplicate follow-ups across all returned reports and the list, then create the rest.
4. No report, or an agent that was skipped or died: the item stays `in_progress` with a note.

**Workflows:**

- **8 agents or fewer**: one item per agent, owned by it.
- **More than 8**: one item per phase, written only by the main session (for example "23/40 done" at the check). Its agents report and do not write: in their block, replace step 1 with `1. Do not use the todo tools; the main session writes item #<id>.`

The harness reference gives the structured form of the report for workflow agents.

## Numbering and visual clues

Every task the user sees is numbered, so they can refer to it ("do 3", "drop 5") and scan status at a glance.

- **The number is the item's tool id**, written `#<id>`. Never invent a separate sequence: the number in a reply must match the id the tools and the Step 3 brief use, and it stays fixed when other items finish or are deleted.
- **Whenever you show the list to the user** (the `/todo` summary, a checkpoint, open items in the final reply), render it as a vertical list, one item per line, each starting with its number and a status marker:
  - `✅` completed
  - `🔄` in_progress
  - `⏳` pending
  - `⛔` blocked: add `(blocked by #<id>)`
- **Keep the order by id**, not by status, so a number never moves between replies.
- **The number is also in the stored subject**, so it shows in the harness's own task list and not only in your replies. Write it as a prefix: `#4 Rebase PR branch onto main`. The id is only known after create, so right after each create, update the subject to `#<id> <subject>` (several creates: do the updates in one parallel batch). Never put the status marker in the stored subject; the harness list shows status itself and a stored marker goes stale. Skip the stored-subject prefix when the harness reference says the tool forbids numbers in titles (such as Antigravity's `update_steps`).
- **Subjects are imperative and short**, so a line reads as a command. In your replies the marker goes between number and subject: `#4 🔄 Rebase PR branch onto main`.
- **Reconcile renumbering**: when matching existing items (Step 1), fix any subject whose prefix is missing or does not match its id.
- Refer to items by number everywhere else too: follow-ups, blockers, and the "still open" lines in the final reply (`#7 ⏳ Verify on core: waiting on the restart window`).

## Step 4: checkpoints

List and reconcile:

- after each milestone, and each returned agent or workflow;
- before asking the user a question that pauses the work;
- before the final reply. Any item still open goes in that reply as one line, with the reason it stays open. Carrying it into a later session is `/handoff`'s job, not this skill's.

## /todo

Typed by the user: load the tools, list, reconcile against the conversation so far (Step 1), and reply with a short summary of what changed, followed by the numbered list (see Numbering and visual clues). Do not start new work.
