# SP2 A8c part 3: a workspace-level plugin with bundled hooks and an MCP server (2026-11-23)

Status: scratch-only probe run by the user and agy on 2026-11-23, after [part 1](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-results-2026-11-23-a8c-part1-agy.md) and [part 2](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-results-2026-11-23-a8c-part2-agy.md). No network, no key, no account email, no user-level config touched. The user-level placement runs R0 to R3 are still not done. Labels: **verified** (agy quoted a file or log line), **reported** (docs only), **unverified**, **[design]**. Paths use `~` or `/home/user`.

What ran: agy documented where a workspace-level plugin lives, created a plugin `a2aprobe` in the scratch workspace `R&D probe` (a `plugin.json` with `name` and `version`, a root `hooks.json` with a `SessionStart` hook, a `PreInvocation` hook and a `PreInvocation` hook with `timeout: 3` that sleeps 40 s, scripts under `hooks/` called with relative paths, and an `mcp_config.json` with one http server on a closed port and a placeholder `Bearer` header), and validated it. The user then started a fresh agy there with the marker variable `A2A_PROBE` exported, asked for one answer with no tools, and a second agy session read the probe files and `cli.log` and cleaned up.

## 1. Observed (verified)

| Question | Observed |
| --- | --- |
| Location and activation | `<workspace>/.agents/plugins/<plugin_name>/`, documented as "a subdirectory of a `plugins/` folder in a customization root"; the plugin activated **without** `agy plugin install`. |
| Validation | `agy plugin validate --strict --json`: exit 0, `hooks: 1`, `mcpServers: 1`, no error, no warning. |
| Hooks ran | `SessionStart` once and both `PreInvocation` hooks once, with no install step. `cli.log`: 4 named hooks from 2 `hooks.json` files before the workspace opened, 5 named hooks from 3 files in it. |
| Relative command | `./hooks/probe.sh` and `./hooks/slow.sh` were found: relative paths resolve against the plugin folder. |
| Working directory | The plugin folder (`pwd` equal to `PLUGIN_ROOT`). |
| Environment | `PLUGIN_ROOT` was set to the plugin folder; `PLUGIN_DATA` was **unset** (the docs give it to installed plugins only); `HOME` was set; the marker `A2A_PROBE` reached the hook (inherited from the shell that started agy). |
| Stdin | Identical to the project-level probe: one compact line, keys sorted, `&` for the ampersand, no extra keys. |
| Timeout | The `timeout: 3` hook was killed after 3 s (`cli.log`: "command failed: signal: killed"); "survived" never appeared. |
| MCP server on a closed port | Started under the plugin-prefixed name `a2aprobe_a2a-probe` at session start; at 30 s `cli.log` logged `MCP: 1 server(s) still connecting after 30s: a2aprobe_a2a-probe` (22.4 s after the first reply). No refusal line was logged in the 51 s the session lasted. It did **not** delay the first reply. |
| `config.json` | No entry was written for the workspace plugin (no `a2aprobe` key; file unchanged). |

## 2. What this means for S1-INST

- **A plugin-bundled layout works at run time in a workspace** (verified): `plugin.json` + `hooks.json` + `hooks/*.sh` + `mcp_config.json` in one folder, no install command, no merge into any shared file, and a hook's relative path and `PLUGIN_ROOT` point at the folder. The global location `~/.gemini/config/plugins/<name>/` is documented to load the same way and to activate in all workspaces (reported, not run at user level).
- **[design] recommendation for the user to decide at S1-INST:** place one agy plugin directory by copying it into `~/.gemini/config/plugins/<name>/` (not `agy plugin install`, which replaces the folder on update) instead of merging into `~/.gemini/config/hooks.json`. This drops the Y9 merge rules (backup, re-read, atomic write of a shared and possibly chezmoi-managed file) and gives one directory to add or remove. It changes decision 28 for agy: the scripts live in the plugin folder (`./hooks/`), not under `~/.local/share/a2a-coord/<version>/bin/` with a `current` symlink (the Claude hooks keep that layout). Decisions 26 and 28 would be revised for agy; the card and the server URL come from the environment, a 0600 file next to the key, or the hook command.
- **Key placement:** the agy key stays a literal in the plugin's `mcp_config.json` (decision 34), which is safe in the copied directory and lost on an `agy plugin install` update. The scripts read it from that file (`A2A_AGY_KEY_FILE` default), now relative to the plugin folder. One file, mode 0600.
- **Health check:** a plugin MCP server that cannot connect does not delay the first reply and logs only a 30 s "still connecting" line, so a failing registration is invisible to the user: the installer's health check (a real `a2a_hello`, decision 24 update) stays necessary and the hooks stay silent on failure.
- **Not covered:** the same layout in `~/.gemini/config/plugins/` (R0 to R2 style placement), a real tool call, a GUI-started agy, and signed-out use (R3).
