---
name: clarify
description: >-
  Walk a non-trivial design through its forks one question at a time. Each
  fork gets a written trade-off analysis, two to four mutually exclusive
  options carrying ASCII or code preview blocks, an explicit recommendation,
  and a single AskUserQuestion call — never a batch. Revisions to earlier
  answers are surfaced out loud rather than applied silently, and the series
  closes with a decision table and a proposed next step, so the design is
  settled before any code is written.
when_to_use: The user is designing something non-trivial (DB schema, data model, API contract, UX flow, migration) and at least three orthogonal decisions are open, each with two or more defensible options — or the user asks to go through them one at a time. Keywords — clarify, one at a time, walk me through the options, trade-offs, design decision, discuss before coding, architecture without code. Skip for a single isolated choice (one plain AskUserQuestion is enough), for urgent implementation where the user said to just build it, and while another interactive flow (plan mode, another skill) already owns the conversation.
allowed-tools: AskUserQuestion
metadata:
  author: doccr
---

# clarify

A working mode for designing something non-trivial together with the user — a database schema, a data model, an API contract, a UX flow, a migration — when several orthogonal forks are open and each carries its own trade-offs.

The point is not to collect answers faster. It is to make every decision visible, argued, and reversible while it is still cheap to reverse.

## When to enter

- The user says "one at a time", "walk me through it", "let's clarify this first".
- Three or more related design decisions are open, and each has at least two reasonable options.
- The user explicitly asks for analysis without code, or for an architecture decision.
- You decomposed the request yourself and can see that without a choice on each fork, the implementation would be either incomplete or built on silent assumptions.

## When not to

- A single question with a single choice — ask it plainly, or with one AskUserQuestion, and do not inflate it into a series.
- Urgent implementation where the user said to just build it.
- The fork is trivial (`let` versus `const`) and does not deserve the ceremony.
- Another interactive flow already owns the conversation — do not stack modes.

## Before the first question

1. **Decompose the request** into orthogonal forks. Aim for five to fifteen decisions, each **independent** of the others — answering one must not predetermine another.
2. More than fifteen forks means some of them are derived. Merge and reformulate.
3. Fewer than three means the mode is unnecessary. Ask one or two ordinary questions instead.
4. **Present the map briefly** before starting: "there are N forks; we start with the one that determines the shape of the schema".
5. **Never batch the questions.** One fork, one AskUserQuestion, one answer.

## The shape of each step

### 1. Heading and context

A short numbered heading:

```
## Question N — <name of the fork, four to eight words>
```

Below it, **two to four sentences of context**: what is being decided, why it matters, what it will constrain downstream.

### 2. Options, argued

For each option (two to four per fork):

- A bold heading (`### A. <name>`).
- A small technical block — code, schema, formula — where one helps.
- **Pros:** two to four points.
- **Cons:** two to four points.

Options must be **mutually exclusive** and genuinely different in consequence. If two differ only cosmetically, merge them or drop one.

### 3. Your reading, and a recommendation

After the options, **three to six sentences**: which choice you consider best and why, under what conditions that recommendation would flip, and what downstream forks this decision cascades into.

Close with a one-line recommendation:

> **Recommendation:** **<option>** — <one clause explaining why>.

### 4. The AskUserQuestion call

Only then call `AskUserQuestion`, with:

- **Two to four options**, the recommended one **always first**, tagged `(Recommended)` in its `label`.
- **A `preview` field on every option** — ASCII diagram, DTO fragment, JSON, mockup, formula. The preview exists to make the options visually comparable; it is not a restatement of the description.
- **`description`** — one or two sentences carrying the key trade-off, not a retelling of the preview.
- **`header`** — a short chip label, twelve characters or fewer.
- **`multiSelect: false`** for most forks, since a fork is by definition one choice.

An option looks like this:

```json
{
  "label": "M:N join table + multi-select UI (Recommended)",
  "description": "Join table from the start, UI allows several tags per record. Most flexible; no migration debt later.",
  "preview": "record_tags\n  record_id\n  tag_id\n  UNIQUE (record_id, tag_id)\n\nUI: [#backend] [#urgent] [#regression]"
}
```

## After each answer

1. **Acknowledge in one line:**

   > Noted: **<chosen option>**. <Optionally, one clause on what it cascades into.> On to the next.

2. **Do not repeat the preview** — the user just looked at it.

3. If the answer makes a later fork moot — choosing multi-select can dissolve a pending question about a tag limit — **say so immediately**: "choosing X retires fork Y; next is Z".

4. If the answer carries a clarification that touches decisions already taken, **revisit them out loud**. Never silently. "This clarification affects decisions N and M — reopening both."

5. If the user picks "Other" and supplies their own answer, **take it without pushback** and re-check the remaining forks against it.

## Closing the series

### 1. Decision table

| # | Decision | Changed? |
|---|----------|----------|
| 1 | <decision> | unchanged / revised |
| 2 | <decision> | new |

The "Changed?" column earns its place only if something was revised mid-series; drop it when every decision held.

### 2. The resulting artifact

If the forks concerned a schema, an API, or a flow, assemble the **final picture** — ASCII diagram, DTOs, the governing rules — in a single block.

### 3. A proposed next step

End by proposing an action: writing the PRD or ADR, or starting implementation, or documenting first and coding second.

**Do not write code without an explicit go from the user.**

## Style

- Keep whatever voice you normally use — the mode governs structure, not personality.
- Precise terminology inside the trade-off analysis.
- Preview blocks are monospaced ASCII. Emoji only where they carry meaning, such as colour swatches in a palette fork.
- Four to eight lines of pros and cons per option is plenty; do not stretch each one into half a page.
- Do not apologise for the length of the analysis — it is the value of the mode. Do not pad it either.

## Anti-patterns

- **Firing options without analysis** — that is a questionnaire, not a clarification.
- **Options with no preview** — the comparison is the point. If a fork resists having a preview, it may not be a fork worth this mode.
- **Restating the preview in the description** — duplication, tiring to read.
- **Two options that mean the same thing** — merge them.
- **Hiding the recommendation** — without a `(Recommended)` tag you are not helping, you are polling.
- **Silent revision** of earlier decisions — always name what changed and why.
- **Ending without the decision table** — by step seven the user no longer remembers what they chose at step three.
- **Sliding into code without a go.**

## Gotchas

- **`preview` renders only when `multiSelect: false`.** On a multi-select fork the preview blocks silently do not appear — either make the fork single-select or move the comparison into `description`.
- **Four options per question, four questions per call** is the harness limit. "Other" is appended automatically; never add your own "Other" option.
- **One question per call is this skill's protocol**, even though the API permits four. The series *is* the mode; a batch turns it back into a questionnaire.
