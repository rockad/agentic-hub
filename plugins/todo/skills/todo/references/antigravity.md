# todo reference: Antigravity

Antigravity has a built-in checklist tool (`update_steps`), so this file is only the shortcut: tool contract, status mapping, numbering rules, and delegation details. The base rules are in `update_steps`'s own tool description.

## Tool

- `update_steps(steps=[{title, status}, ...])` — always loaded; no `ToolSearch` or load step is needed.
- **Replace-all model**: every call sends the full ordered list (at most 12 items; aim for 3–8). There is no separate `list` or `get` tool: reconcile by reading the most recent `update_steps` call in conversation history and sending the updated full array.
- **Parallel call timing**: call `update_steps` in parallel with the first tool call of a step (zero extra turn), and once more with every step `done` before the final reply.
- **Status mapping**:
  - `pending` -> `pending`
  - `in_progress` -> `in_progress`
  - `completed` (SKILL.md) -> `done`
  - `skipped` / `failed` -> native `update_steps` statuses when an item is intentionally bypassed or permanently failed
  - No `deleted` status: drop irrelevant items by omitting them from the array (or mark `skipped` if keeping the record helps the user).
  - No `blocked` status or `addBlockedBy`: keep the blocked item `in_progress` (or `pending` if not started), add the blocker as a separate step when actionable, and show `(blocked by #<id>)` in the chat reply.
- **No `description` or `owner` fields**: record key results (a number, a decision, a PR link) in the 1–2 sentence status note sent alongside the `update_steps` call, and track delegated ownership in the main session's context.

## Numbering and titles

- `update_steps` forbids numbers, IDs, labels (`0.1`, `Step 2:`, `P0`), and unmentioned code identifiers in `title`. Keep each stored `title` short (2–6 words), imperative, and plain English without a `#<id>` prefix.
- In chat replies and Step 3 briefs, `#<id>` is the item's 1-based index in the current `update_steps` array (`#1`, `#2`, …). Keep order stable so numbers do not shift needlessly; if an earlier item is omitted, show the updated list in the reply.
- Status markers in chat replies:
  - `✅` `done`
  - `🔄` `in_progress`
  - `⏳` `pending`
  - `⛔` blocked (add `(blocked by #<id>)`)
  - `⏭️` `skipped`
  - `❌` `failed`

## Delegation, verified 2026-11-26

| Delegation | Todo tool | Sees the main list |
| --- | --- | --- |
| `invoke_subagent` (built-in and custom agent types) | own `update_steps` only | no: updates only the child conversation UI, not the parent's checklist |
| `run_workflow` `agent()` call | own `update_steps` only | no: isolated child conversation; returns structured `finish` payload |

Because delegated agents cannot read or write the main session's `update_steps` list, replace step 1 in the SKILL.md `## Todo reporting` brief with:

`1. Do not call update_steps for the parent checklist; the main session owns it.`

## Workflow report field (`run_workflow`)

Give every `run_workflow` `agent(..., schema=...)` schema this required field and return it from the Python script. It is the structured form of the status report:

```python
"todo": {
    "type": "object",
    "required": ["id", "status", "evidence", "followUps"],
    "properties": {
        "id": {"type": "string"},
        "status": {"type": "string", "enum": ["done", "in_progress", "blocked"]},
        "evidence": {"type": "string"},
        "followUps": {"type": "array", "items": {"type": "string"}},
    },
}
```

The main session sees a workflow's result in its completion notice, so the checks in SKILL.md Step 3 run then. An agent that ends without calling `finish` fails the workflow; treat missing or failed agent results as `in_progress` with a note when reconciling.
