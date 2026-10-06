# Memory Plugin

Unified Memory umbrella wrapping **Recall** (durable memory graph @ `127.0.0.1:8110`) and **Lookup** (semantic transcript and archive index @ `127.0.0.1:8100`).

## Features

- **Unified Memory CLI (`scripts/memory.sh`)**: Canonical CLI tool managing cross-harness session state and semantic transcript retrieval across Google Antigravity and OpenCode.
- **Recall Integration (`http://127.0.0.1:8110/mcp`)**: Stores durable, structured session memory state in Recall note `session-memory:<workspace>` (with `session-handoff:<workspace>` mirrored for full backwards compatibility) with YAML frontmatter metadata.
- **Lookup Integration (`http://127.0.0.1:8100/mcp`)**: Fast SQLite FTS5 search across agent transcripts (`~/.gemini/antigravity-cli/brain/`), OpenCode logs (`~/.local/share/opencode/`), vault notes, and knowledge archives via `search_archive`.
- **Local Fallback**: Automatically caches and syncs with `.agents/memory.json` / `.agents/MEMORY.md` (and `.agents/handoff.json` / `.agents/HANDOFF.md`) if services are offline.
- **Harness Hooks**: Preflight hooks automatically inject memory state into Antigravity turns (`scripts/jev-preflight.ts`) and OpenCode turns (`plugins/jev/opencode/plugin.ts`).
- **Backwards Compatibility**: `scripts/handoff.sh` is provided as a transparent wrapper forwarding directly to `scripts/memory.sh`.

## Structure

```
memory/
├── plugin.json
├── README.md
├── scripts/
│   └── memory.sh
└── skills/
    └── memory/
        └── SKILL.md
```

## CLI Interface

The CLI tool `scripts/memory.sh` manages session state and context retrieval:

```bash
# View human-readable session status
./scripts/memory.sh status [--workspace <name>]

# Get raw JSON state
./scripts/memory.sh get [--workspace <name>]

# Set goal, current milestone, and next action
./scripts/memory.sh set [--workspace <name>] [--harness <antigravity|opencode>] [--goal "..."] [--milestone "..."] [--next "..."]

# Mark milestone complete
./scripts/memory.sh mark-done <milestone>

# Semantic search over transcripts, logs, and docs
./scripts/memory.sh search <query>

# Generate markdown files from state
./scripts/memory.sh dump-markdown
```

## Setup & Endpoints

- **Recall Endpoint**: `http://127.0.0.1:8110/mcp` (Streamable HTTP, FastMCP)
- **Lookup Endpoint**: `http://127.0.0.1:8100/mcp` (Streamable HTTP, FTS5)
- **CLI Utility**: `scripts/memory.sh`
