---
name: session-handoff
description: >
  Cross-harness session handoff and context retrieval between Google Antigravity and OpenCode.
  Synchronizes active goals, milestones, and next actions via Recall note `session-handoff:<workspace>`
  and retrieves relevant transcript snippets and decisions via Lookup archive search.
when_to_use: Switching between Antigravity and OpenCode harnesses, checkpointing session goals
  and completed milestones, reading previous session handoff directives, or searching past transcripts.
allowed-tools: mcp(recall/*), mcp(lookup/*), bash
metadata:
  author: agentic-hub
  source: antigravity-mcp
  mcp: [recall, lookup]
---

# session-handoff

Cross-harness state synchronization and context retrieval between Google Antigravity and OpenCode.

## Overview

Session handoff coordinates state across AI harnesses using two services:
1. **Recall (`http://127.0.0.1:8110/mcp`)**: Stores durable, structured session handoff state as note `session-handoff:<workspace>` (e.g. `session-handoff:doppelganger`) with YAML frontmatter metadata.
2. **Lookup (`http://127.0.0.1:8100/mcp`)**: Indexes session transcripts (`~/.gemini/antigravity-cli/brain/`), OpenCode logs (`~/.local/share/opencode/`), documentation, and knowledge archives for rapid full-text retrieval.
3. **Local Disk Cache (`.agents/handoff.json` & `.agents/HANDOFF.md`)**: Provides automatic fallback when daemon containers are unavailable.

---

## CLI Interface (`handoff.sh`)

Path: `doppelganger/scripts/handoff.sh`

### 1. View Status
Displays human-readable handoff summary loaded from Recall (falling back to disk):
```bash
./scripts/handoff.sh status [--workspace <name>]
```

### 2. Get Machine-Readable JSON
Returns JSON for programmatic preflight checks:
```bash
./scripts/handoff.sh get [--workspace <name>]
```

### 3. Set Active Session Goal & Milestones
Updates `.agents/handoff.json`, `.agents/HANDOFF.md`, and writes note `session-handoff:<workspace>` to Recall:
```bash
./scripts/handoff.sh set \
  --harness <antigravity|opencode> \
  --goal "Implement cross-harness bridge" \
  --milestone "Integration Phase" \
  --next "Verify cross-harness state"
```

### 4. Mark Milestone Done
Appends a completed milestone to both Recall and local disk:
```bash
./scripts/handoff.sh mark-done "Verified Recall and Lookup integration"
```

### 5. Search Transcript & Prior Context
Queries `lookup`'s `search_archive` tool for matching transcript or log snippets:
```bash
./scripts/handoff.sh search-context "merlin cdp bridge"
```

---

## Direct MCP Tool Invocations

When operating inside an agent environment where `recall` and `lookup` MCP servers are registered:

### Recall: Read Handoff Note
```json
{
  "name": "read_note",
  "arguments": {
    "identifier": "session-handoff:doppelganger",
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

### Recall: Write / Update Handoff Note
```json
{
  "name": "write_note",
  "arguments": {
    "title": "session-handoff:doppelganger",
    "directory": "",
    "content": "# Session Handoff: doppelganger\n\n**Active Goal:** ...",
    "metadata": {
      "workspace": "doppelganger",
      "lastHarness": "antigravity",
      "updatedAt": "2026-10-06T12:00:00Z",
      "activeGoal": "Implement cross-harness bridge",
      "currentMilestone": "Integration Phase",
      "nextAction": "Verify cross-harness state",
      "completedMilestones": ["Phase 1 complete"]
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
    "query": "session handoff recall lookup",
    "limit": 5
  }
}
```

---

## Preflight Integration

- **Google Antigravity**: Handled by `scripts/jev-preflight.ts`. Reads `session-handoff:<workspace>` at preflight and injects `[CROSS-HARNESS HANDOFF from OpenCode]` directives when OpenCode was the last active harness.
- **OpenCode**: Handled by `plugins/jev/opencode/plugin.ts`. Reads `session-handoff:<workspace>` at session start and injects `[CROSS-HARNESS HANDOFF from Antigravity]` directives into the system prompt.
