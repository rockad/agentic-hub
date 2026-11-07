# To check

Tools to evaluate for possible integration into the hub (plugin, skill, or MCP wrapper). Info gathered 2026-11-07 from READMEs and third-party write-ups; not yet verified hands-on.

## Kanzo — kanban for agents

- Repo: https://github.com/emanuele-em/kanzo (AGPL-3.0)
- Local-first kanban board and MCP server in one small Rust binary (about 4–5 MB), SQLite storage. Runs on macOS, Linux, Windows, Raspberry Pi.
- Agents claim cards, update status and post comments through MCP while the browser board (localhost:4242) updates live.
- Setup for Claude Code: `claude mcp add kanzo --scope user -- kanzo mcp`. An HTTP MCP endpoint (`/mcp`) is also available for a shared network board.
- Multi-machine sync via a private git repo.
- To check: how it compares with `plugins/coordination`; whether a `plugins/kanzo` wrapper (`.mcp.json` plus skill) is worthwhile. AGPL license implications. One aggregator lists it as paid, which conflicts with the repo.

## OpenUI — generative UI for agents

- Repo: https://github.com/thesysdev/openui (MIT)
- Generative UI framework. The model writes "OpenUI Lang", a streaming, line-oriented language, and a React runtime renders it with built-in charts, forms, tables and layouts. Invalid parts are dropped. The project claims up to 67% fewer tokens than JSON (unverified).
- Not a separate tool call; the agent emits the language in its response and the client renders it.
- CLI scaffold: `npx @openuidev/cli@latest create`. Ships an Agent Skill for coding assistants.
- To check: whether it fits as a standalone skill, and whether it works outside React clients. Not to be confused with the unrelated `CreativLogic/openUI`.

## OpenRig — multi-agent control plane

- Repo: https://github.com/mvschwarz/openrig (Apache-2.0; about v0.5.x)
- Runs Claude Code and Codex as a persistent team, defined in YAML and booted with one command ("rig"). Local daemon plus CLI, TUI, MCP server and React UI, built on tmux.
- `rig discover` and `rig adopt` bring existing tmux sessions under management. Per-seat inbox and outbox via `rig send`, `rig broadcast` and `rig chatroom`. Agents in a pod share memory.
- Safety: YOLO mode is opt-in. Launching a rig writes provider hook and workspace trust settings, so review them first.
- To check: overlap with `plugins/coordination`, `plugins/memory` and `plugins/subagents`; Antigravity compatibility.
