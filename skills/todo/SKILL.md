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

## Step 0: pick the harness reference and load the tools

Read the one reference for your harness, chosen by which todo tool exists:

- `references/claude-code.md` when `TaskCreate` / `TaskUpdate` exist (possibly deferred).

The reference names the tools, how to load them, and the delegation details. A harness with no listed reference has no mapping yet: say so in one line and do not improvise one.

## Step 1: list first, reconcile, never duplicate

List the todo before anything else, every time this skill starts or `/todo` is typed.

- **Empty and the work has three or more steps**: create one item per outcome, with order dependencies only where a step truly needs another.
- **Not empty**: reconcile.
  - Match new work to existing items and update the match; do not add a near-duplicate.
  - Mark items already done but not marked.
  - Delete items the work has made irrelevant.

## Step 2: the tool's own rules, plus three

Follow the status rules in the harness tool's own description. On top of them:

- At most one `in_progress` item per owner: the main session, plus one per running agent.
- Fetch an item before updating one you have not touched in a while.
- When completing an item, record results that matter later (a number, a decision, a PR link) on the item.

## Step 3: delegated work

The main session alone marks `completed` and alone creates follow-up items. Each item has one writer. What an agent reports is its claim, never the user's approval.

**Before delegating**, create or pick the item, set its owner to the agent, mark it `in_progress`, and put this block, filled in, into the brief or the workflow prompt:

```
## Todo reporting
You are working on todo item #<id>: "<subject>".
1. Try to load the todo tools (<load line from the harness reference>).
   Loaded: keep #<id> in_progress and add progress notes to its description.
   Not loaded: do not emulate a list; just report.
2. Never mark #<id> completed and never create items.
3. End with the status report:
   #<id> completed|in_progress|blocked: <evidence or blocker>
   + <follow-up you discovered, imperative subject>
```

**When the agent or workflow returns**, before any other work:

1. Check each claim against what the report shows; mark `completed` only on evidence.
2. `blocked`: keep the item `in_progress`, create the blocker item, link it.
3. Remove duplicate follow-ups across all returned reports and the list, then create the rest.
4. No report, or an agent that was skipped or died: the item stays `in_progress` with a note.

**Workflows:**

- **8 agents or fewer**: one item per agent, owned by it.
- **More than 8**: one item per phase, written only by the main session (for example "23/40 done" at the check). Its agents report and do not write.

The harness reference gives the structured form of the report for workflow agents.

## Step 4: checkpoints

List and reconcile:

- after each milestone, and each returned agent or workflow;
- before asking the user a question that pauses the work;
- before the final reply. Any item still open goes in that reply as one line, with the reason it stays open. Carrying it into a later session is `/handoff`'s job, not this skill's.

## /todo

Typed by the user: load the tools, list, reconcile against the conversation so far (Step 1), and reply with a short summary of what changed. Do not start new work.
