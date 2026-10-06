---
name: mcp-recall
description: >
  Personal knowledge / memory management. Create, read, update, delete,
  and search notes and projects; build contextual bundles; inspect
  directory structure and recent activity. Use when the user wants to
  persist or retrieve structured memories, or to assemble context for a task.
when_to_use: The user asks to save a note, find a past note, create a
  project, build context, or inspect memory state. Also for schema
  validation and migration on the recall store.
allowed-tools: mcp(recall/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: recall
---

# recall (MCP bridge)

Personal memory / knowledge base, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: `write_note`, `read_note`, `search_notes`, `edit_note`,
  `delete_note`, `move_note`, `view_note`, `list_directory`,
  `create_memory_project`, `delete_project`, `list_memory_projects`,
  `list_workspaces`, `build_context`, `fetch`, `recent_activity`,
  `schema_diff`, `schema_infer`, `schema_validate`, `search`,
  `basic_memory_diagnostics`

## How to use

### Write a note
```
mcp(recall/write_note) { "project": "default", "path": "meeting/2026-09-30.md", "content": "# Meeting\n..." }
```

### Read a note
```
mcp(recall/read_note) { "project": "default", "path": "meeting/2026-09-30.md" }
```

### Search notes
```
mcp(recall/search_notes) { "query": "decision", "project": "default", "limit": 10 }
```

### Build a context bundle
```
mcp(recall/build_context) { "query": "auth refactor", "maxTokens": 8000 }
```

### List projects / workspaces
```
mcp(recall/list_memory_projects) {}
mcp(recall/list_workspaces) {}
```

## Tips
- Notes live under a `project`; use `default` if unsure.
- `build_context` is the primary way to assemble task-relevant memory.
- `schema_infer` / `schema_validate` help when migrating note formats.