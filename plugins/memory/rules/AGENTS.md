# Memory Plugin: Rules & Guidelines

This document governs memory discipline, cross-harness coordination, and storage fallbacks for AI agents using the `memory` plugin.

## 1. Architecture & Dual-Daemon Topology

The `memory` plugin coordinates durable memory and full-text transcript search across two resident HTTP daemon containers and a local disk cache:

1. **Recall (`http://127.0.0.1:8110/mcp`)**:
   - Manages durable entities, projects, and structured session memory notes.
   - Primary state note: `session-memory:<workspace>` (with `session-handoff:<workspace>` mirrored for full backward compatibility).
   - Backed by Basic Memory (`ghcr.io/basicmachines-co/basic-memory:0.23.2`) with hybrid vector + reranker search.

2. **Lookup (`http://127.0.0.1:8100/mcp`)**:
   - Indexes session transcripts (`~/.gemini/antigravity-cli/brain/`), OpenCode session logs (`~/.local/share/opencode/`), repository documents, and knowledge archives.
   - Powered by SQLite FTS5 with BM25 ranking and per-source result grouping.

3. **Local Disk Cache (`.agents/memory.json` & `.agents/MEMORY.md`)**:
   - Resides directly in the workspace repository.
   - Acts as the zero-dependency, local fallback store whenever containers are offline or unreachable.

---

## 2. Memory Discipline for Agents

### Session Inception & Pre-flight
- At the start of a multi-turn task or new session, query session memory to restore active context:
  - Check `read_note(identifier="session-memory:<workspace>")` via Recall, or inspect `.agents/memory.json` / `.agents/MEMORY.md`.
  - Look for unfinished milestones, immediate next actions, and active goals.
  - If previous work was performed in another harness (e.g. OpenCode vs Google Antigravity), heed cross-harness context directives.

### Search Before Re-deriving
- Before re-deriving complex architectural decisions, researching past bugs, or guessing paths:
  - Call `search_archive(query="...")` via Lookup.
  - Inspect transcripts and past meeting/decision records.
  - Check visibility annotations (`open` vs `gated`): gated findings require user verification before public reuse.

### Progress Checkpointing
- At logical milestones, record progress:
  - Update `activeGoal`, `currentMilestone`, `nextAction`, and append to `completedMilestones`.
  - Use `memory.sh set` or `memory.sh mark-done` via shell, or write directly to Recall via `write_note`.
  - Ensure `.agents/memory.json` and `.agents/MEMORY.md` reflect the state.

---

## 3. Local Disk Fallback & Resilience

- **Fail-Open Design**: A failure to reach Recall (`:8110`) or Lookup (`:8100`) must **never abort an agent turn or break a session**.
- **Transparent Fallback**:
  - `memory.sh` automatically checks daemon health. If HTTP endpoints fail or timeout, it reads/writes directly to `.agents/memory.json` and `.agents/MEMORY.md`.
  - When daemons resume, the local state is ready to be synchronized back to Recall.
- **Docker Management**:
  - To bring up the memory stack: `memory.sh up` (or `docker compose up -d`).
  - To stop the memory stack: `memory.sh down`.
