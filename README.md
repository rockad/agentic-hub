# agentic-hub

An agent-provider-agnostic hub for AI skills, plugins, and MCP integrations. Built to run interchangeably across **Google Antigravity**, **Claude Code**, **OpenCode**, and modern Model Context Protocol (MCP) agent environments.

## Repository Structure

```text
agentic-hub/
├── .claude-plugin/       # Claude Code plugin registry manifest
│   └── marketplace.json
├── plugins/              # Composite plugins bundling MCP servers, skills, and launchers
│   ├── chrome-browser/   # Persistent Windows Chrome browser automation via CDP & DevTools MCP
│   ├── jev/              # TypeSafe Jev decision engine v2.3.0, OpenCode & Claude Code integration
│   ├── local-transcribe/ # Local Russian/English audio/video transcription & call recorder
│   └── memory/           # Unified session memory umbrella wrapping Recall (:8110) & Lookup (:8100)
│       ├── servers/lookup/ # Resident SQLite FTS5 search engine & extractors
│       ├── skills/       # memory, lookup, recall
│       └── docker-compose.yml # Dual-service daemon stack for recall & lookup
├── skills/               # Standalone agent skills
│   ├── clarify/          # Interactive design clarification skill
│   ├── markdown-convert/ # PDF, Office, and EML to Markdown converter via local OCR
│   ├── md-to-pdf/        # Markdown to PDF converter via WeasyPrint
│   ├── rclone-cloud-storage/ # Multi-cloud storage operations via rclone
│   ├── skills-doctor/    # Diagnostic and repair tool for npx skills installs
│   └── mcp-*/            # MCP documentation wrappers (chrome-devtools, gitea, google-workspace, jev)
├── marketplace.json      # Google Antigravity plugin and skill marketplace manifest
├── AGENTS.md             # Canonical AI agent guidance
└── LICENSE               # MIT Open Source License
```

---

## Included Plugins & Skills

### `plugins/jev`
- **What it does**: System 1 decision engine providing fast probabilistic routing, task evaluation, quality gate enforcement, thinking effort governance, and free-tier coprocessor offloading.
- **Key Features**:
  - **MCP Server (`jev-mcp`)**: Exposes decision tools (`jev_route`, `jev_judge`, `jev_score`, `jev_dispatch`, `jev_agent_free`, `jev_execute_free`, `jev_set_mode`, `jev_get_mode`, `jev_quota`, `jev_select_model`).
  - **OpenCode Integration**: OpenCode V2 plugin (`plugins/jev/opencode/`) providing automatic cost-tiered model selection, model swapping, and expensive tier approval flows.
  - **Claude Code Integration**: Lifecycle hooks (`plugins/jev/claude/`) enforcing session model ceiling governance and Jev task routing advice.
  - **Router & Free Models**: Uses OpenRouter Decisions API (`~typesafe/jev-latest`) for ~800ms scoring/judging and offloads to `openrouter/free` models for zero-cost generation.
  - **Quality Gates & Commits**: Includes `commit` (`plugins/jev/scripts/commit.ts`) semantic commit generator with `jev_judge` quality gate verification.

### `plugins/local-transcribe`
- **What it does**: End-to-end local transcription and call recording pipeline optimized for mixed Russian/English speech without sending audio to cloud services.
- **Key Features**:
  - **Local Whisper & Diarization**: High-accuracy local speech recognition via whisper.cpp / PyTorch whisper.
  - **Call & Screen Recording**: Local OBS and macOS screencapture automation via `record` skill.
  - **Speaker Separation & Naming**: Heuristic and diarization-based speaker labelling with vocabulary spelling correction.
  - **Zero-Cloud Privacy**: Processes audio strictly on local GPU/CPU hardware.

### `plugins/chrome-browser`
- **What it does**: Controls a native Google Chrome browser instance from Linux/WSL or desktop using the Chrome DevTools Protocol (`chrome-devtools-mcp`).
- **Resilience**:
  - Automatically launches Chrome with `--remote-debugging-port=9222`, `--remote-allow-origins=*`, and an isolated persistent profile directory if not already running.
  - Automatically attaches via `--browserUrl=http://127.0.0.1:9222`.
- **Skills included**:
  - `chrome-browser`: Navigation, tab management, web interaction, downscaled screenshots.

### `plugins/memory`
- **What it does**: Unified session memory umbrella wrapping Recall (knowledge graph @ `:8110`) and Lookup (FTS5 search @ `:8100`) for cross-harness state tracking and context retrieval.
- **Key Features**:
  - **Relocated Lookup Engine**: Houses the complete, pure Python SQLite FTS5 search engine (`plugins/memory/servers/lookup/`) with robust extractors and MCP server.
  - **Dual-Daemon Stack**: Supplies `docker-compose.yml` for running both `recall` (`basic-memory:0.23.2`) and `lookup`.
  - **Three Bundled Skills**: `skills/memory` (cross-harness coordination), `skills/lookup` (archive/transcript search), and `skills/recall` (durable note/entity storage).
  - **Cross-Harness Coordination**: Bridges session goals, milestones, and next actions across Google Antigravity, OpenCode, and Claude Code.
  - **Fail-Soft Local Cache**: Operates seamlessly even if daemons are offline by falling back to local `.agents/memory.json` / `.agents/MEMORY.md`.
  - **CLI Tool**: Portable `scripts/memory.sh` supporting `status`, `get`, `set`, `mark-done`, `search`, `up`, and `down`.

### Standalone Skills
- **`skills/clarify`**: Walk non-trivial designs through trade-off analysis and structured option selection.
- **`skills/markdown-convert`**: Convert PDFs, Office documents, and `.eml` emails to Markdown sidecar files with offline OCR fallback.
- **`skills/md-to-pdf`**: Generate clean, professional PDFs from Markdown using HTML/CSS templates and WeasyPrint.
- **`skills/rclone-cloud-storage`**: Safe cloud storage management (Google Drive, OneDrive, etc.) via rclone.
- **`skills/skills-doctor`**: Diagnose and repair `npx skills` installations across projects and global directories.

---

## Installation

### Google Antigravity
Plugins and skills are discoverable and installable via the marketplace manifest:
```bash
agy marketplace add https://github.com/rockad/agentic-hub.git
```

### Claude Code
Install plugins directly from the Claude Code marketplace:
```bash
/plugin marketplace add rockad/agentic-hub
/plugin install jev@agentic-hub
```

### OpenCode & Standalone Skills
Install standalone skills via `npx skills`:
```bash
# List available skills
npx skills add rockad/agentic-hub -l

# Install a specific skill
npx skills add rockad/agentic-hub --skill md-to-pdf
```

## License

MIT — see [LICENSE](LICENSE) for details.
