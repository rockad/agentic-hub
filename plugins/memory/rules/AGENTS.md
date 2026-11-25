# Memory Plugin: Rules & Guidelines

Governs durable memory discipline, cross-harness continuity, and local fallbacks for the `memory` plugin.

## 1. Dual-Daemon Topology & Local Cache

- **Recall (`http://127.0.0.1:8110/mcp`)**: Basic Memory (`0.24.1`) hybrid vector + reranker store for durable entities, projects, and `session-memory:<workspace>` (mirrored to `session-handoff:<workspace>`).
- **Lookup (`http://127.0.0.1:8100/mcp`)**: SQLite FTS5 + BM25 index over Antigravity transcripts (`~/.gemini/antigravity-cli/brain/`), OpenCode logs (`~/.local/share/opencode/`), repo docs, and archives.
- **Local Disk Cache (`.agents/memory.json` & `.agents/MEMORY.md`)**: Zero-dependency workspace fallback when daemons are offline.

## 2. Agent Discipline

- **Session Inception**: Query `read_note(identifier="session-memory:<workspace>")` (or `.agents/memory.json` / `.agents/MEMORY.md`) at start of multi-turn/new sessions for `activeGoal`, `currentMilestone`, `nextAction`, and cross-harness directives (OpenCode vs Antigravity).
- **Search Before Re-Deriving**: Call `search_archive(query="...")` via Lookup before guessing paths or re-deriving past decisions/bugs; verify `gated` vs `open` findings with the user before public reuse.
- **Progress Checkpointing**: Update `activeGoal`, `currentMilestone`, `nextAction`, and `completedMilestones` at logical milestones via `memory.sh set`, `memory.sh mark-done`, or `write_note`, keeping `.agents/memory.json` and `.agents/MEMORY.md` in sync.

## 3. Fail-Open Resilience

- **Never Abort**: Unreachable Recall (`:8110`) or Lookup (`:8100`) must never break a turn or session.
- **Auto-Fallback & Docker**: `memory.sh` checks daemon health and falls back transparently to `.agents/memory.json` / `.agents/MEMORY.md` (syncing back when daemons resume). Manage stack via `memory.sh up` (`docker compose up -d`) and `memory.sh down`.
