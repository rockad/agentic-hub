# SP2 A8b runbook: do user-level agy plugin tools run when signed in? (2026-11-08)

Why: the SP2 agy results ([A8](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-results-2026-11-08-sp2-agy.md)) marked plugin placement a pass, but at `~/.gemini/config/plugins/coordination` the stub connected and the tools failed (`tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`, `cli.log`: `Not reloading plugin MCP servers: cannot get the signed-in user`), and the plugin hid the workspace copy. Every successful tool call in SP2 (including the 10 of 10 binding runs) went through the workspace placement. So the installer's agy MCP placement (decisions 24 and 26) is unproven.

Labels: **verified**, **reported**, **unverified**. Rules as in [`spike-runbooks-2026-11-05.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/spike-runbooks-2026-11-05.md) section 0.1 and decision 25 (borrow and put back). Nothing here launches, drives or wraps agy: the user starts agy, agy answers prompts, the helper only reads logs.

Read-only facts found while preparing this (2026-11-08, verified by reading files):

- agy's own docs say plugin enablement lives in `~/.gemini/config/config.json` under `plugins.<directory name>.enabled`, an unlisted plugin is enabled by default, and `agy plugin enable|disable` write it.
- `config.json` lists `gitea`, `jev`, `job-search`, `local-transcribe` and `memory` as enabled; `chrome-devtools`, `google-workspace` and the marketplace plugins as disabled.
- The working user-level plugins use `.mcp.json` (Claude style); the only user-level `mcp_config.json` is `google-developer-knowledge` (disabled). Our failed candidate used `mcp_config.json`.
- The sign-in warning appears once in `cli.log` (2026-11-08 22:43:41 local, `Auth succeeded` then `error getting token source: You are not logged into Antigravity` within 1 ms). The OAuth token file exists (modified 22:02) and holds `auth_method`, `id_token_email`, `token` with no expiry key.
- The failed run therefore looks like a start-up race or a lapsed token, not a property of the placement, but nothing yet shows a user-level `mcp_config.json` plugin ever ran a tool.

## Hypotheses

- H1: the sign-in warning was transient or a lapsed token; a signed-in, warm start runs the tools.
- H2: the plugin needs an explicit `config.json` entry (`agy plugin enable`), or must be installed with `agy plugin install`.
- H3: `.mcp.json` works at user level where `mcp_config.json` does not (or the reverse).
- H4: tools are never enabled for a plugin added by copying a directory while a session is open or at first start, and work after one more restart.

## Variants (staged in `~/scratch/a2a-spikes/agy-staging/a8b/`, each its own server name and `X-Spike-Via`)

| id | directory name | file | server | via |
| --- | --- | --- | --- | --- |
| native | `coordination` | `mcp_config.json` | `a2a-stub-gemini` | `gemini` |
| dotmcp | `coordmcp` | `.mcp.json` (`type: http`) | `a2a-stub-u2` | `u2` |
| cli | `coordcli` | `mcp_config.json` | `a2a-stub-u3` | `u3` |

## Steps

Roles: helper reads logs (never starts agy), user copies files and starts agy, agy follows the briefs in `~/scratch/a2a-spikes/agy-operator/a8b-operator-brief.md`.

1. Part 1, no files placed (agy, read-only): the user starts a fresh `agy` in `/home/rockad/scratch/a2a-spikes/sp2-agy-a8b` (create it first; trust it and note the dialog), pastes the Part 1 prompt. Capture agy's explanation and its cheapest-experiment proposal. Helper: record the `cli.log` size and last line before starting (`wc -l`, `tail -n 1`).
2. Preflight (helper, then user): back up `~/.gemini/config/config.json` (mode 0600, delete after the restore check) and take `sha256sum` of it, `~/.gemini/config/hooks.json` and `mcp_config.json`; `ls -A ~/.agents ~/.gemini/config/plugins` and `chezmoi diff` to compare with the baselines in `runlogs/`; start the stub (`echo none > ctl/agy-inject-mode`, `rm -f ctl/KILL`, `stub_start`).
3. R0 control, no candidate: fresh agy, Part 2 checklist. Records signed-in state and that `gitea`, `jev`, `memory`, `obsidian` connect.
4. R1 native, cold: user copies `agy-staging/a8b/native/coordination` to `~/.gemini/config/plugins/` (the STOP check from SP2 step 3 first: the directory must not exist), fresh agy, Part 2. Then quit and start another fresh agy, Part 2 again (warm). Helper: stub `via=gemini` requests, `cli.log` lines since the mark.
5. R2 explicit enable: with R1 in place, the user runs the enable command agy gave in Part 1 (expected `agy plugin enable coordination`), fresh agy, Part 2. Helper: `jq '.plugins.coordination' ~/.gemini/config/config.json` before and after.
6. R3 dotmcp: remove R1 (and its `config.json` entry if R2 created one, by the command agy documented), copy `agy-staging/a8b/dotmcp/coordmcp`, fresh agy, Part 2.
7. R4 CLI install: remove R3, run the documented `agy plugin install` on `agy-staging/a8b/cli/coordcli` (syntax from Part 1, user runs it), fresh agy, Part 2, then the documented uninstall.
8. Shadowing check (only if R1 or R2 ran tools): copy the old workspace plugin back into `sp2-agy-a8b/.agents/plugins/coordination` with server `a2a-stub-ws`, with R1 in place: does `a2a-stub-ws` load? Record which wins and whether disabling R1 brings the workspace one back.
9. Cleanup and restore: remove every candidate and cache (`~/.gemini/antigravity-cli/mcp/*a2a-stub*`), restore or verify `config.json` (`jq -S '.plugins' ` against the backup: only entries for our candidates may differ, and those are removed), the baseline checks of SP2 step 4, stop the stub, remove `sp2-agy-a8b` from `trustedWorkspaces` if agy added it, delete the `config.json` backup.

## Pass and fail

- Pass: at least one user-level placement runs `a2a_hello` and `a2a_inbox` through agy, signed in, without any manual per-session step, and the working form, file name and install command are recorded. That form becomes the installer's agy MCP placement.
- Fail: no user-level form runs tools after a clean restart: the installer falls back to the `agy mcp add` global entry in `~/.gemini/config/mcp_config.json` (chezmoi-managed, verified to work in SP2 A6 and A4 on 2026-11-04) via the documented chezmoi route, or to a per-workspace plugin written by the user; record which. Decision 24's "plugin-scoped file outside chezmoi" is then reopened.
- Either way record the sign-in finding: whether tools depend on a live sign-in at start (matters for the installer's health check and the agy MCP view).

## Results

Written by Antigravity as `spike-results-<date>-a8b-agy.md` from the stub logs, `cli.log` excerpts, the helper's notes and the Part 1 and Part 2 answers, using the same rules as prompt 3C.
