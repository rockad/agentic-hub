# R2: beads (`bd`) concurrency, footprint and host side effects

Author: Claude Code (macp), 2026-11-03. Read-only: I read the docs in a local clone of [`steveyegge/beads`](https://github.com/steveyegge/beads/tree/dbe6699) (HEAD dbe6699, 2026-11-03, MIT; the clone is now deleted). I installed and ran nothing. Labels: **verified** (read in the repo docs), **unverified** (not found or not tested).

## 1. Storage modes and what two agent writers need

- **Embedded (default, `bd init`)** (verified): Dolt runs in-process inside the `bd` binary; data in `.beads/embeddeddolt/`; "single writer (one process at a time)"; the architecture diagram says "single writer, file-locked". Each `bd` call starts the engine, so loops pay startup every time; `bd batch` runs close, update, create and dep add/remove in one transaction and one process. What happens when a second writer arrives (wait, error, timeout) is not described in the pages I read (unverified).
- **Server (`bd init --server`)** (verified): an external `dolt sql-server` (default 127.0.0.1:3307, or a Unix socket via `--server-socket`) gives concurrent writers. It needs the `dolt` CLI at 2.6.0 or newer; `bd` refuses older ones. Setting `BEADS_DOLT_SERVER_PORT` marks the server as externally managed, so `bd` will not start it. Auto-start is not supported with sockets.
- **Proxied-server (`bd init --proxied-server`)** (verified, thinly): a "managed proxied-server" mode where `bd` starts its own server on demand ("the proxy starts its server again on the next command"; `bd dolt stop` alone stops it). The docs say it suits sustained concurrent agents. It is marked experimental in one CLI reference entry about migrating to it (unverified how mature it is). It still needs the `dolt` CLI at 2.6.0+.
- The docs' own advice: "For sustained concurrent agents, use server or proxied-server mode."

Conclusion for two agents on one machine: embedded mode with writes serialised (for example under a flock) is the zero-daemon option; proxied-server is the "no standing daemon but concurrent" option; server mode is the daemon option.

## 2. Footprint

- Install routes (verified): `brew install beads`, `npm install -g @beads/bd`, an install script (curl to bash), `go install`, build from source. A no-cgo `go install` produces a server-mode-only build.
- Embedded mode links the Dolt 2.6.0 engine into the binary (verified); binary size, memory and startup time were not measured (unverified).
- Server and proxied modes add the separate `dolt` CLI (verified requirement), version 2.6.0 or newer.
- Project naming note: README badges point to `gastownhall/beads` while the clone is `steveyegge/beads` (verified); repo ownership and maintainers were not checked.

## 3. Host side effects of `bd init` and `bd setup`

- `bd init` (verified): creates or updates `AGENTS.md` and installs the project Claude Code, Codex and Cursor integrations unless `--skip-agents` or `--stealth` is passed. For Claude the project-scoped files are `.claude/settings.json` plus a `CLAUDE.md` section; Codex gets `.agents/skills/beads/`, an `AGENTS.md` section and `.codex/` hooks; Cursor gets `.cursor/` rules and hooks.
- `bd setup <host> --global` (verified) writes to the user's home instead: `~/.claude/settings.json` and `~/.claude/CLAUDE.md`, `~/.cursor/hooks.json`, `~/.agents/skills/beads/`, `$CODEX_HOME` or `~/.codex`. Do not pass `--global`.
- The Claude Code hook it installs runs `bd prime` (verified); `--stealth` switches it to a flush-only mode with no git operations. `bd hooks install` also exists in upgrade notes (git hooks; what it writes was not read, unverified).
- `--stealth` (verified): use beads locally without committing files to the main repo (`no-git-ops: true`).
- So the repo-local, no-dotfile path is: run `bd init --skip-agents` (or `--stealth`) in a scratch directory, and never run `bd setup ... --global` (derived from the docs; I did not run it, so any unexpected write is unverified).

## 4. Fit with the bridge plan (opinion)

- Symmetry: yes. Any session that can run a shell command can claim and close work. Interactive `agy` and Claude Code both can.
- Writes: the plan's Phase 2 needs two writers. In embedded mode that means wrapping `bd` calls in a lock (same idea as BuildSlot). In proxied-server mode it needs the `dolt` CLI and an on-demand server process.
- The in-house registry (Option A in the plan) avoids both the Dolt dependency and the question of mode maturity, at the cost of writing claim rules.
- A trial, when implementation is allowed, should run in a scratch directory with `--skip-agents` and the user installing `bd` himself.

## 5. Not answered

- Behaviour of a second embedded writer; how mature proxied-server mode is; binary size and startup time; what `bd hooks install` and `bd init` write into `.git/hooks`; who maintains the project now.
