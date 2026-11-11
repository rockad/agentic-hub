# SP2 A8c runbook: the three agy items A8b left open (2026-11-09)

Why: the A8b results ([A8b](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-results-2026-11-09-a8b-agy.md), [runbook](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-runbook-a8b-user-level-plugin-2026-11-08.md)) showed that a user-level plugin at `~/.gemini/config/plugins/<name>/` with a native `mcp_config.json` runs `a2a_hello` and `a2a_inbox` signed in, provided its name is unique. Three things stayed untested: `.mcp.json` at user level, `agy plugin install`, and whether tool use needs a live sign-in. They decide the form the installer documents for agy and what its health check may assume. This is a planned spike (D-E, decided 2026-11-09). It is not run yet and it does not block S1: until it runs, the installer's agy placement is the A8b form.

Labels: **verified**, **reported**, **unverified**, plus **[design]** for what this runbook proposes and has not tested. Rules as in [`spike-runbooks-2026-11-05.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/spike-runbooks-2026-11-05.md) section 0.1 and decision 25 (borrow and put back). Nothing here launches, drives or wraps agy: the user starts agy, agy answers prompts, the helper only reads logs.

The one step that changes the user's real agy login is the signed-out run (R3). It is the last run. The user signs out and the user signs in again; the helper never does either. How it is put back is in "Put-back and check" below.

Read-only facts carried in from A8b (verified by reading files and logs, 2026-11-09):

- agy's own docs say plugin enablement lives in `~/.gemini/config/config.json` under `plugins.<directory name>.enabled`, an unlisted plugin is enabled by default, and `agy plugin enable|disable` write it.
- The working user-level plugins use `.mcp.json` (Claude style); the A8b candidate that worked used `mcp_config.json`.
- The startup warning `Not reloading plugin MCP servers: cannot get the signed-in user: error getting token source: You are not logged into Antigravity` appears within the first 150 ms of every agy start, including runs whose tools worked, and before `keyringAuth: loaded token, expiry=...` is logged (about one hour ahead of launch in each A8b run).
- Every successful tool call in SP2 and A8b happened while signed in through the keyring OAuth login.
- agy keeps a token file at `~/.gemini/antigravity-cli/antigravity-oauth-token` (mode 0600, seen by a directory listing; contents not read). Whether sign-out deletes it, empties it, or only clears the keyring entry is **unverified**.

## Questions and hypotheses

Item 1, `.mcp.json` at user level:

- H1: `.mcp.json` (`type: http`) in `~/.gemini/config/plugins/<name>/` is loaded like the native `mcp_config.json` and runs the tools signed in, with no `agy plugin enable` and no `config.json` entry.
- Q1: if it does not run, is the failure the file name, a missing plugin manifest, or the name rule?

Item 2, `agy plugin install` and uninstall:

- H2: `agy plugin install <path>` places and registers the plugin so its tools run, and the documented uninstall removes the directory, any `config.json` entry and the cache.
- Q2: what exact syntax and side effects does agy document, and does install add a `config.json` entry?

Item 3, tool use while signed out:

- H3a: signed out, a loopback MCP server still connects and its tools run, because the sign-in warning at startup is benign.
- H3b: signed out, plugin MCP servers are not reloaded or their tools are "not enabled" (the 2026-11-08 failure text), or agy refuses to start without a login.
- Q3: whichever happens, what does agy show and what does `cli.log` say? The answer sets whether the installer's health check (a real `a2a_hello` in a fresh agy session, decision 24 update, DDR-003) must require a signed-in agy.

## Variants

Staged in `~/scratch/a2a-spikes/agy-staging/a8c/` by the helper when the spike runs, each with its own server name and `X-Spike-Via`. Nothing is staged by this document, and no staging directory exists yet. Every variant's directory name must differ from any workspace plugin name (the A8b unique-name rule; the helper checks the scratch workspace and the user's real workspaces before the run, and the names must also differ from the A8b candidates in case agy kept a cache for them) [design names]:

| id | item | directory name | file | server | via |
| --- | --- | --- | --- | --- | --- |
| dotmcp-user | 1 | `a8cmcp` | `.mcp.json` (`type: http`), placed by copying | `a2a-stub-u4` | `u4` |
| cli-install | 2 | `a8ccli` | native `mcp_config.json`, placed by `agy plugin install <path>` | `a2a-stub-u5` | `u5` |
| signedout | 3 | `a8cso` | the A8b native `mcp_config.json` form, placed by copying | `a2a-stub-u6` | `u6` |

- The signed-out variant uses the form already proven in A8b, so a failure can only be put down to the sign-out and not to the placement [design].
- Whether a plugin manifest (`plugin.json`) must sit beside the file is open [design]: stage the variants with the manifest the A8b native variant used, and let Part 1 record what agy documents.
- The helper writes the A8c operator brief at `~/scratch/a2a-spikes/agy-operator/a8c-operator-brief.md` (Part 1 and Part 2) when the spike runs [design]. Part 2 follows the A8b brief's checklist style: agy states whether it is signed in, lists which MCP servers connected, calls `a2a_hello` then `a2a_inbox` on the variant's server, quotes any error text verbatim, and answers nothing from memory.

## Steps

Roles: helper reads logs (never starts agy, never writes agy's files), user copies files, runs the plugin commands, starts agy and signs out and in, agy answers the prompts from the brief (Part 2 style checklist).

1. Part 1, no files placed (agy, read-only): the user starts a fresh `agy` in `~/scratch/a2a-spikes/sp2-agy-a8c` (create it first; trust it and note the dialog) and pastes the Part 1 prompt. agy documents: the syntax and effects of `agy plugin install <path>` and its uninstall; how a user signs out and in; what sign-out removes; and its cheapest-experiment proposal. Helper: record the `cli.log` size and last line before starting (`wc -l`, `tail -n 1`).
2. Preflight and baseline (helper, then user):
   - take `sha256sum` of `~/.gemini/config/config.json`, `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json`, and keep them in the notes; also back up `config.json` (mode 0600, delete after the restore check), since plugin install can write to it
   - `ls -A ~/.agents ~/.gemini/config/plugins` and `chezmoi diff`, compared with the baselines in `runlogs/`
   - check the variant names against every workspace plugin directory (unique-name rule)
   - start the stub (`echo none > ctl/agy-inject-mode`, `rm -f ctl/KILL`, `stub_start`)
   - no credential is read, printed or copied in this step
3. R0 control, no candidate, signed in: fresh agy, Part 2 checklist. Records the signed-in state and that `gitea`, `jev`, `memory` and `obsidian` connect.
4. R1, item 1, signed in: the user copies `agy-staging/a8c/dotmcp-user/a8cmcp` to `~/.gemini/config/plugins/` (the STOP check from SP2 step 3 first: the directory must not exist), fresh agy, Part 2. Then quit, start another fresh agy, Part 2 again (warm). Helper: stub `via=u4` requests, `cli.log` lines since the mark. Afterwards the user removes `a8cmcp`.
5. R2, item 2, signed in: the user runs the documented `agy plugin install` on `agy-staging/a8c/cli-install/a8ccli` (syntax from Part 1), fresh agy, Part 2, then the documented uninstall. Helper: `jq '.plugins' ~/.gemini/config/config.json` before and after, `ls ~/.gemini/config/plugins` before and after, stub `via=u5` requests; after the uninstall, the directory, any `config.json` entry and `~/.gemini/antigravity-cli/mcp/*a2a-stub*` caches for this variant must be gone.
6. Credential backup and baseline (borrow, before R3): the helper writes the exact commands, the user runs them. Nothing is printed.
   - create the backup directory with `umask 077` (`~/scratch/a2a-spikes/backup/`, mode 0700) and copy `~/.gemini/antigravity-cli/antigravity-oauth-token` into it (mode 0600); never `cat`, `jq`, `head` or otherwise open it
   - record, as notes only: `sha256sum` and `stat` modification time of the original and of the copy (they must match each other), and the account email agy shows when signed in (the user reads it in agy; it is written in the notes as "noted", not repeated in any result)
   - record `sha256sum` and modification time (no copy) of `~/.gemini/antigravity-cli/antigravity_state.pbtxt`, `jetski_state.pbtxt` and `settings.json`, so the result can say whether sign-out touched them [design; these are not known to hold credentials]
   - the login also lives in the OS keyring, which cannot be backed up by copying a file; that entry is put back only by signing in again [reported, from the `keyringAuth` lines in `cli.log`]
7. R3, item 3, signed out, LAST (the user does all of it): the user copies `agy-staging/a8c/signedout/a8cso` to `~/.gemini/config/plugins/`, then signs out by the command Part 1 documented, then starts a fresh agy and pastes Part 2. If agy refuses to start without a login, stop there, record what it said, and go to the put-back step. Otherwise agy follows Part 2 (state the sign-in status, list connected servers, call `a2a_hello` then `a2a_inbox`, quote errors). One cold and one warm start at most while signed out [design]. Helper: stub `via=u6` requests and `cli.log` lines since the mark (the `keyringAuth` and sign-in lines), no credential file read.
8. Put-back and check (user signs in, helper reads only): see the next section. Nothing else runs until it passes.
9. Cleanup and restore (helper, user for agy's files): remove every candidate and cache (`~/.gemini/antigravity-cli/mcp/*a2a-stub*`), verify `config.json` (`jq -S '.plugins'` against the backup: only entries for our candidates may differ, and those are removed) and that the `sha256sum` of `hooks.json` and `mcp_config.json` equal the step 2 baselines, run the baseline checks of SP2 step 4, stop the stub, remove `sp2-agy-a8c` from `trustedWorkspaces` if agy added it, then delete the `config.json` backup and, once the put-back check has passed, the credential backup directory.

## Put-back and check

The signed-out run (R3) is the only step that changes the real agy login. It is put back by the user signing in again through agy's normal sign-in route, not by the helper and not by copying files over agy's state. The check reads two facts only and prints no credential:

- the account email agy shows after sign-in is the one noted in step 6 (the user compares by eye and writes "matches" or "differs" in the notes)
- the modification time of `~/.gemini/antigravity-cli/antigravity-oauth-token` (`stat`, time only), which should be later than the sign-in; record it next to the pre-run time from step 6. A missing file after sign-in is a failure
- then one fresh agy starts and passes the R0 checklist again (signed in, `gitea`, `jev`, `memory` and `obsidian` connect), and the next `cli.log` shows `keyringAuth: loaded token`

If the user cannot sign in again, stop and report to the user before anything else. The credential copy from step 6 is a diagnostic fallback only: whether sign-out revokes the token on the server, which would make the copy useless, is **unverified**, so restoring it is not promised. Do not print or compare token contents in either case.

## Pass and fail

- Item 1 pass: `.mcp.json` at user level runs `a2a_hello` and `a2a_inbox` through agy, signed in, with no manual per-session step, under a unique name. Fail: record the failure text; the installer keeps the A8b native `mcp_config.json` form.
- Item 2 pass: the documented install runs the tools signed in, and the documented uninstall leaves no directory, `config.json` entry or cache. Fail: record which of those remained; the installer's agy step stays "the user copies the directory" and never drives agy (DDR-003).
- Item 3, record only: either tools run signed out (the health check need not require a sign-in) or they do not (the health check tells the user to sign in first). Record the exact agy and `cli.log` text either way.
- Put-back pass: email matches, token file modification time later than the sign-in, R0 checklist passes again. A put-back failure is reported to the user at once and outranks every other result.
- Nothing here blocks S1.

## Results

Written by Antigravity as `spike-results-<date>-a8c-agy.md` from the stub logs, `cli.log` excerpts, the helper's notes and the Part 1 and Part 2 answers, using the same rules as prompt 3C. It lists each touched file, the backup location and the restore check, states that the signed-out run was the only step that changed the real login and how it was put back, and contains no token, key or account email text.
