---
name: memory
description: >
  Unified Memory umbrella wrapping Recall (durable memory graph @ :8110) and Lookup (semantic transcript index @ :8100).
  Coordinates cross-harness session goals, milestones, and next actions between Google Antigravity and OpenCode,
  and retrieves relevant transcript snippets and decisions via archive search.
when_to_use: Checking session status, checkpointing goals/milestones, switching between Antigravity and OpenCode harnesses,
  or searching past session transcripts and decision logs.
allowed-tools: mcp(recall/*), mcp(lookup/*), bash
metadata:
  author: agentic-hub
  source: antigravity-mcp
  mcp: [recall, lookup]
---

# memory

Unified memory umbrella and cross-harness state coordination wrapping Recall and Lookup.

## Overview

The Memory umbrella coordinates state and past context across AI harnesses (Google Antigravity and OpenCode):
1. **Recall (`http://127.0.0.1:8110/mcp`)**: Stores durable, structured session memory state as note `session-memory:<workspace>` (e.g. `session-memory:doppelganger`, with `session-handoff:<workspace>` mirrored for full compatibility) with YAML frontmatter metadata.
2. **Lookup (`http://127.0.0.1:8100/mcp`)**: Indexes session transcripts (`~/.gemini/antigravity-cli/brain/`), OpenCode logs (`~/.local/share/opencode/`), documentation, and knowledge archives for rapid full-text retrieval.
3. **Local Disk Cache (`.agents/memory.json` & `.agents/MEMORY.md`)**: Provides automatic fallback when daemon containers are unavailable.
4. **Backwards Compatibility**: `scripts/handoff.sh` forwards transparently to `scripts/memory.sh`.

---

## CLI Interface (`memory.sh`)

Canonical path: `scripts/memory.sh` (or bundled in `plugins/memory/scripts/memory.sh`)

### 1. View Status
Displays human-readable memory summary loaded from Recall (falling back to disk):
```bash
./scripts/memory.sh status [--workspace <name>]
```

### 2. Get Machine-Readable JSON
Returns JSON for programmatic preflight checks:
```bash
./scripts/memory.sh get [--workspace <name>]
```

### 3. Set Active Session Goal & Milestones
Updates `.agents/memory.json`, `.agents/MEMORY.md`, `.agents/handoff.json`, `.agents/HANDOFF.md`, and writes note `session-memory:<workspace>` to Recall:
```bash
./scripts/memory.sh set \
  --harness <antigravity|opencode> \
  --goal "Unified memory umbrella refactor complete" \
  --milestone "Verification" \
  --next "Ready"
```

### 4. Mark Milestone Done
Appends a completed milestone to both Recall and local disk:
```bash
./scripts/memory.sh mark-done "Verified Recall and Lookup integration"
```

### 5. Search Transcript & Prior Context
Queries `lookup`'s `search_archive` tool for matching transcript or log snippets:
```bash
./scripts/memory.sh search "merlin cdp bridge"
```

### 6. Dump Markdown State
Re-generates markdown handoff files from JSON cache:
```bash
./scripts/memory.sh dump-markdown
```

---

## Direct MCP Tool Invocations

When operating inside an agent environment where `recall` and `lookup` MCP servers are registered:

### Recall: Read Memory Note
```json
{
  "name": "read_note",
  "arguments": {
    "identifier": "session-memory:doppelganger",
    "output_format": "json",
    "include_frontmatter": true
  }
}
```
Frontmatter contains:
- `workspace`: string (e.g. `"doppelganger"`)
- `lastHarness`: `"antigravity"` | `"opencode"`
- `updatedAt`: ISO timestamp
- `activeGoal`: string
- `currentMilestone`: string
- `nextAction`: string
- `completedMilestones`: list of strings
- `modifiedFiles`: list of strings

### Recall: Write / Update Memory Note
```json
{
  "name": "write_note",
  "arguments": {
    "title": "session-memory:doppelganger",
    "directory": "",
    "content": "# Unified Session Memory: doppelganger\n\n**Active Goal:** ...",
    "metadata": {
      "workspace": "doppelganger",
      "lastHarness": "antigravity",
      "updatedAt": "2026-10-06T12:00:00Z",
      "activeGoal": "Unified memory umbrella refactor complete",
      "currentMilestone": "Verification",
      "nextAction": "Ready",
      "completedMilestones": ["Verification complete"]
    },
    "overwrite": true
  }
}
```

### Lookup: Search Archive and Transcripts
```json
{
  "name": "search_archive",
  "arguments": {
    "query": "merlin cdp bridge",
    "limit": 5
  }
}
```

---

## Preflight Integration

- **Google Antigravity**: Handled by `scripts/jev-preflight.ts`. Reads `session-memory:<workspace>` (or `session-handoff:<workspace>`) at preflight and injects `[CROSS-HARNESS MEMORY from OpenCode]` directives when OpenCode was the last active harness.
- **OpenCode**: Handled by `plugins/jev/opencode/plugin.ts`. Reads `session-memory:<workspace>` (or `session-handoff:<workspace>`) at session start and injects `[CROSS-HARNESS MEMORY from Antigravity]` directives into the system prompt.
