# AGENTS.md

This file provides guidance to Google Antigravity (CLI and IDE), Claude Code, and other AI coding assistants working in this repository. It is the single canonical source of truth for repository instructions, rules, and conventions. `CLAUDE.md` imports this file via `@./AGENTS.md`.

## What this repository is

`agentic-hub` is an **agent-provider-agnostic hub for plugins, skills, and MCP tools**. It houses reusable capabilities that work seamlessly across:
- **Google Antigravity** (CLI, daemon, and IDE)
- **Claude Code** (`claude` CLI and plugins)
- Other agent frameworks adhering to standard MCP (Model Context Protocol) and Agent Skills specifications.

```
agentic-hub/
├── plugins/              # Composite plugins bundling MCP servers, skills, and launcher scripts
│   ├── chrome-devtools/  # Persistent Windows Chrome browser automation via CDP & DevTools MCP
│   ├── gitea/            # Gitea repository inspection, issue reading, and commit inspection
│   ├── google-workspace/ # Google Workspace integration: Gmail and Calendar
│   ├── jev/              # Jev routing, scoring, model ceiling guard, and automated task execution
│   ├── local-transcribe/ # Local Russian/English speech transcription and call recording
│   └── memory/           # Unified session memory umbrella wrapping Recall (:8110) & Lookup (:8100)
│       ├── servers/lookup/ # Relocated FTS5 search engine & extractors
│       ├── skills/       # memory, lookup, recall
│       └── docker-compose.yml # Resident daemon compose stack
├── skills/               # Standalone agent skills
│   ├── clarify/          # Interactive design clarification skill
│   ├── markdown-convert/ # Document to Markdown converter
│   ├── md-to-pdf/        # Markdown to PDF converter via WeasyPrint
│   ├── rclone-cloud-storage/ # Multi-cloud storage operations via rclone
│   └── skills-doctor/    # Skills installation repair utility
└── marketplace.json      # Public marketplace manifest
```

## Conventions

1. **Provider Agnostic**:
   - Do not hardcode provider-specific tool assumptions where general standards exist.
   - Use the standard Model Context Protocol (MCP) for tool exposure and standard YAML frontmatter for skills (`name`, `description`).

2. **Dual-Agent Compatibility**:
   - Plugins supply both `.mcp.json` (for MCP clients / Claude Code) and wrapper entrypoints that Antigravity can execute.
   - Relative paths inside plugins are resolved relative to the plugin root or repo root.

3. **Tool Choice & Execution**:
   - Adhere to the machine-wide tool guidelines: reach for purpose-built tools (`jq`, `yq`, `mdq`, `rg`, `fd`, `sd`) before ad-hoc python glue.
   - Use native edit tools (`replace_file_content` / `Edit`) rather than custom read-replace-write scripts.

## `plugins/jev` — Decision Engine & Router

`plugins/jev` provides fast, low-cost System 1 decision-making, task routing, quality gate enforcement, and free-tier coprocessor execution.

- **Architecture**: Lightweight orchestration layer using OpenRouter Decisions API (~800ms) for probabilistic routing, rubric scoring, and binary diff judging.
- **MCP Server (`jev-mcp`)**: Exposes decision tools (`jev_route`, `jev_judge`, `jev_score`, `jev_dispatch`, `jev_agent_free`, `jev_execute_free`, `jev_set_mode`, `jev_get_mode`, `jev_quota`, `jev_select_model`).
- **OpenCode Integration**: OpenCode V2 plugin (`plugins/jev/opencode/`) provides cost-tiered model selection, automatic model swapping, free-tier delegation, and approval flows for expensive model tiers.
- **Router & Free Models**:
  - Router/Judge: OpenRouter Decisions API (`~typesafe/jev-latest`).
  - Free Execution: `openrouter/free` pool (`google/gemma-4-31b-it:free`, `cohere/north-mini-code:free`, `nvidia/nemotron-3.5-lightning:free`).
- **Quality Gate Scripts**:
  - `commit.ts` (`dg-commit`): Semantic commit generator using free models and `jev_judge` validation. Enforces strict quality gate blocking (`noul >= 0.35` required, exits code 1 if rejected unless overridden with `--force` or `--no-verify`).

## `plugins/memory` — Unified Session Memory Umbrella

`plugins/memory` coordinates durable memory state, cross-harness handoffs, and full-text transcript search.

- **Architecture**:
  - **Recall (`http://127.0.0.1:8110/mcp`)**: Structured entities, semantic search, and `session-memory:<workspace>` notes.
  - **Lookup (`http://127.0.0.1:8100/mcp`)**: Fast SQLite FTS5 search engine over session transcripts, docs, and archives.
  - **Local Disk Fallback**: Automatic fail-soft persistence in `.agents/memory.json` / `.agents/MEMORY.md`.
- **Bundled Skills**:
  - `memory`: Cross-harness session goal and milestone coordination.
  - `lookup`: Full-text document and transcript archive search.
  - `recall`: Durable note creation, semantic search, and project entities.
- **CLI (`scripts/memory.sh`)**:
  - `memory.sh status` / `get` / `set` / `mark-done` / `search` / `up` / `down`.
- **Daemon Stack (`docker-compose.yml`)**:
  - Brings up `recall` (`basic-memory:0.23.2`) and builds `lookup` (`servers/lookup/Dockerfile`).


