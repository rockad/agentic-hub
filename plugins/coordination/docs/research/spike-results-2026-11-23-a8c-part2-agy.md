# SP2 A8c part 2: plugin validator and hook probe in a project workspace (2026-11-23)

Status: two scratch-only steps run by the user and agy on 2026-11-23, after the read-only Part 1 ([Part 1 answers](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-results-2026-11-23-a8c-part1-agy.md)). They used no network, no key, no account email, and did not touch user-level config (`~/.gemini/config`). The A8c runs R0 to R3 (user-level placement, `agy plugin install`, signed out) are still not done. Labels: **verified** (agy ran it or read it in a file or log, quoted below), **reported** (docs only), **unverified**, **[design]** (our consequence, not tested). Paths use `~` or `/home/user`.

What ran:

1. agy validated five throwaway plugin directories with `agy plugin validate --json` (read-only) and read `cli.log`.
2. agy wrote a probe (two scripts and a project-level `.agents/hooks.json` with a `SessionStart` hook, a `PreInvocation` hook and a `PreInvocation` hook with `timeout: 3` that sleeps 40 s) in a workspace named `R&D probe`. The user exported a made-up marker variable `A2A_PROBE`, started a fresh agy there, trusted the folder, and sent one prompt that asked for no tools. A second agy session read the probe output.

## 1. Plugin validator (verified)

| Directory | Exit | Findings |
| --- | --- | --- |
| `.mcp.json` only | 1 | error: "no plugin.json found at the plugin root or in .antigravity-plugin or .gemini-plugin" |
| `plugin.json` (`{"name": ...}`) + `.mcp.json` | 0 | warning on `.mcp.json`: "never loaded: this is Claude Code's file name. Move the servers to mcp_config.json"; `mcpServers: 0` |
| `plugin.json` + `mcp_config.json` with a placeholder `Authorization: Bearer a2ak_dev_...` header | 0 | `mcpServers: 1`; warning: no `version`; note: no `logo`; `--strict` turns the warning into exit 1 |
| `plugin.json` = `{}` | 0 | warnings: no `name` ("`plugin install` refuses it"), no `version` |
| `plugin.json` + `hooks.json` at the plugin root (a `SessionStart` command hook) | 0 | `hooks: 1`, no findings beyond version and logo |

Consequences:

- `.mcp.json` is never loaded, so A8c run R1 (item 1) is answered: the installer keeps `mcp_config.json`.
- The one hard requirement is the `plugin.json` file. For no warning under `--strict` it needs `name` and `version`.
- A plugin can bundle its hooks: `hooks.json` at the plugin root, groups mapped to event arrays, `SessionStart` and `PreInvocation` as flat arrays of handlers (the shape of our fragment). The docs say a plugin placed in `~/.gemini/config/plugins/` "activates across all workspaces", that bundled hooks run while the plugin is enabled, and that plugin hooks get `PLUGIN_ROOT` and `PLUGIN_DATA` in their environment with the plugin folder as the working directory (reported, not run). **[design]** One directory could then carry `plugin.json`, `mcp_config.json`, `hooks.json` and the scripts, with no merge into the shared user-level `hooks.json` (decision 26, Y9). Untested at run time.
- `agy plugin validate --strict --json <dir>` is a read-only check the user can run on the plugin directory. It starts the `agy` binary (not a session), so the installer should print the command and the user runs it; nothing in the plugin runs it (DDR-003). **[design]**

## 2. `cli.log` (verified)

At startup, `Auth succeeded, refreshing features and managers` and then the warning `Not reloading plugin MCP servers: cannot get the signed-in user: error getting token source: You are not logged into Antigravity.` appear about 83 ms before `keyringAuth: loaded token, expiry=... expired=false` and `ChainedAuth: authenticated via keyring`. The warning occurs once in the log. So the warning is an ordering effect at startup (the plugin MCP reload runs before the keyring token is loaded), in a session that is signed in. Whether plugin MCP servers are reloaded after the token loads is not shown here (A8b saw tools work in such sessions). Item 4 (does tool use need a live sign-in) stays open for run R3.

## 3. Hook probe in a project workspace (verified)

| Question | Observed |
| --- | --- |
| Did the hooks run? | `SessionStart` once, `PreInvocation` once per hook, all in the workspace opened after the trust dialog. |
| `~` in `command` | Expanded: all three commands began with a literal `~` and ran. |
| Working directory | The folder that contains the `hooks.json` (`<workspace>/.agents`), not the workspace root. |
| Environment | `HOME` was set; the marker `A2A_PROBE=probe-marker-4711`, exported in the shell before agy started, **reached the hook**: hooks inherit the environment agy was started with (terminal start; a GUI start is not tested). |
| Stdin | One compact line, keys sorted alphabetically, no whitespace after colons or commas. `SessionStart` keys: `artifactDirectoryPath`, `conversationId`, `cwd`, `hookEventName`, `lastUserInput`, `modelName`, `transcriptPath`, `workspacePaths`; `PreInvocation` adds `initialNumSteps` and `invocationNum`. Identical layout in both. |
| Escaping | The ampersand in `R&D probe` arrived as `&` in both `cwd` and `workspacePaths`. So the `<`, `>`, `&` escapes are real, and the decoding added in PR #96 is needed: without it a workspace named like `R&D` would have lost its hooks. |
| Timeout | The hook with `timeout: 3` was **killed** after 3.002 s (`cli.log`: "command failed: signal: killed"); "slow survived" never appeared. The model call waited for it: the first model reply was created at the second the slow hook was killed. So a `PreInvocation` hook delays the model call by up to its `timeout`. This refines SP3 P6, which saw agy proceed after about 31.5 s with the hook not killed when no `timeout` key was set. |
| Trust | The dialog offers only "Yes, I trust this folder" and "No, exit". At startup agy loaded 4 named hooks from 2 `hooks.json` files; after the trust answer it reloaded 5 named hooks from 3 files (4.5 ms after `settings.json` was written), and the project hook ran after that. So project-level hooks load only after trust. Which two files were loaded before trust (the user-level one is the likely one) is **unverified**. A session cannot continue in an untrusted folder at all (the choice is trust or exit), so "do user-level hooks run in an untrusted workspace" has no practical case. |
| Side effect | agy added the workspace to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (written as `R&D probe`). The user removes that entry when the probe is finished (runbook step 9). |

Cleanup done by agy: the probe `hooks.json` and the `/tmp/agy-exp-*` directories were deleted; `probe/out` was kept; `~/.gemini/config` was not touched.

## 4. What this changes

- **PR #96 was right and necessary** (verified): a workspace whose path contains `&`, `<` or `>` reaches the hook with the escape sequence.
- **`A2A_AGY_CARD` from the shell works** for terminal-started agy (verified); the installer can still bake the card into the hook command or read it from a file, because a GUI-started agy is not tested. The earlier must "do not rely on the shell environment" is relaxed to "verified from a terminal; GUI not tested".
- **A set `timeout` kills a stuck hook** (verified): the fragment's `timeout` of 10 (session) and 5 (pending) bound the damage. A `PreInvocation` hook delays every model call by its run time, so the 2 s curl limit in the scripts stays the right bound.
- **`~` in the hook command works** (verified in a project-level file; the same loader reads the user-level file, unverified).
- **Untrusted workspaces** are not a case for the hooks (trust or exit).
- **Design alternative to put to the user at S1-INST:** a plugin directory with bundled hooks (section 1) instead of a merge into `~/.gemini/config/hooks.json`. A workspace-level plugin in the scratch folder could test it without touching user config (a follow-up probe, not run).
- Still open: R2 (`agy plugin install` side effects and what uninstall removes), R3 (signed out), plugin-bundled hooks at run time, a GUI-started agy.
