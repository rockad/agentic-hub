# todo reference: Claude Code

Claude Code has a built-in todo, so this file is only the shortcut: tool names, the load line, and what was verified about delegation. The status rules are in the tools' own descriptions.

## Tools

- `TaskList` (list), `TaskGet` (fetch one), `TaskCreate` (create), `TaskUpdate` (status, owner, description, metadata, `addBlockedBy`, `status: "deleted"`).
- `TaskUpdate` `description` replaces the whole text: fetch first and append.
- "Blocked by": `TaskUpdate` on the original item with `addBlockedBy: ["<blocker id>"]`.
- They are deferred. Load all four in one call: `ToolSearch` with query `select:TaskCreate,TaskUpdate,TaskList,TaskGet`.
- Set `activeForm` on create: the spinner shows it while the item is `in_progress`.

## Delegation, verified 2026-11-20

| Delegation | Todo tools | Sees the main list |
| --- | --- | --- |
| `Agent` tool subagent (`general-purpose` and custom agent types) | no: `ToolSearch` returns "No matching deferred tools found" | no |
| Workflow `agent()` call | yes, all four | yes: reads, updates and creates in the same list |
| Fork, agent-team teammate | not verified | not verified |

The probe in the SKILL.md brief block covers all of them, so the table is for understanding, not for choosing a path. Load line for the brief: `ToolSearch` with query `select:TaskUpdate,TaskGet`.

## Workflow report field

Give every workflow `agent()` schema this required field and return it from the script. It is the structured form of the status report:

```js
todo: {
  type: 'object',
  required: ['id', 'status', 'evidence', 'followUps'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'in_progress', 'blocked'] },
    evidence: { type: 'string' },
    followUps: { type: 'array', items: { type: 'string' } },
  },
}
```

The main session sees a workflow's result only in its completion notice, so the checks in SKILL.md Step 3 run then. A `null` agent result means the agent was skipped or died.
