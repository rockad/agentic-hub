# Per-harness API keys: the contract

Decided with the user in a `/clarify` session on 2026-11-24. This spec is the contract for where each harness's `local-harness` API key lives, how each part of the plugin reads it, and what a rotation touches. It supersedes the key-delivery text of [`server-api.md`](server-api.md) section 8.2 (Client storage), section 11.0 and section 11.1, and the key sources named in [`claude-hooks.md`](claude-hooks.md) and [`agy-hooks.md`](agy-hooks.md) before this date. It does not change how the server issues, hashes, rotates or revokes keys.

Tags used below:

- **[verified]** names the experiment or test that backs the point.
- **[documented]** is a statement of the Claude Code documentation, fetched 2026-11-24, not re-run here.
- **[design]** is what the implementation stream builds from this contract; it is not yet backed by a test or an observation in this document.
- **[unverified]** was not run.

## 1. Purpose

Before this design a harness's key could sit in up to three places: a key file for the hooks, an environment variable for Claude's MCP header, and a literal in a harness config. The copies drifted, a rotation had to touch each by hand, and a GUI-launched Claude lost the environment variable. The contract fixes three rules:

- Each harness has one canonical key file, and every part of the plugin that can read a file reads that one.
- A second copy exists only where a harness's MCP client cannot read a file, and then it is stated, checked and named in the rotation steps.
- A later harness is added by filling in one table row, one section of this contract and one test block (section 8).

## 2. The table

Harness ids are `claude-code` and `antigravity`. The table in this spec is mirrored by a table in `bin/a2a-lib.sh` and in the doctor, one row per harness **[design]**; a test requires every row there to have a section in this file whose `Second copy:` line is present (section 8).

| Harness id | Card | Hook key file | MCP mechanism | Second copy | Rotation step |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | `claude-code@<machine>` | `~/.config/a2a-coord/keys/claude-code.key` | `headersHelper` in the plugin's `claude/mcp.json`: `bin/a2a-mcp-headers` reads the key file | none | write the new key to the key file; nothing else |
| `antigravity` | `antigravity@<machine>` | `~/.config/a2a-coord/keys/antigravity.key` | a literal `Authorization` header in the user's `~/.gemini/config/mcp_config.json` | the literal in `~/.gemini/config/mcp_config.json` | write the new key to the key file **and** replace the literal, both inside the grace window |

One key per card: one per harness per machine, shared by every session of that harness on that machine. A session **handle** is a routing label, never a credential: two sessions of one harness use the same key and are told apart by the handle the server issues at registration.

## 3. Common rules

### 3.1 Key files

- One file per harness: `~/.config/a2a-coord/keys/<harness>.key`, first line the key and nothing else, mode 0600.
- The directory `~/.config/a2a-coord/keys` has mode 0700 (the parent `~/.config/a2a-coord` stays 0700 as the doctor already checks).
- The hooks, the doctor and Claude's MCP helper read this file. The plugin never creates, edits or deletes it **[design]**; you create it with the commands of section 9.

### 3.2 Overrides

The settings file `~/.config/a2a-coord/settings` (see the README, Settings file) names another key file per harness:

| Harness id | Settings name |
| --- | --- |
| `claude-code` | `A2A_KEY_FILE` |
| `antigravity` | `A2A_AGY_KEY_FILE` |

A set override replaces the canonical path. The environment variable of the same name wins over the settings file, as for every other setting. **`A2A_API_KEY` is not read by anything**: not by the hooks, not by the helper, not by the doctor **[design]**. A shell that still exports it does no harm and does no good.

### 3.3 Fallbacks for one release

For one release after this design ships, a missing canonical file falls back to the old source **[design]**:

| Harness id | Old source |
| --- | --- |
| `claude-code` | `~/.config/a2a-coord/api-key` |
| `antigravity` | the first `a2ak_` token of `~/.gemini/config/mcp_config.json` |

The canonical file always wins when it exists. The doctor `WARN`s while a fallback is in use and prints the migration commands of section 9. After the release the fallbacks are removed and a missing canonical file is a `FAIL`.

## 4. Harness sections

### 4.1 `claude-code`

- Hooks (`a2a-register`, `a2a-listen`, `a2a-pending`) read `keys/claude-code.key` and pass the key to curl on stdin. Behaviour of the hooks is in [`claude-hooks.md`](claude-hooks.md).
- The plugin's `claude/mcp.json` declares the `a2a-coord` server with `"headersHelper": "${CLAUDE_PLUGIN_ROOT}/bin/a2a-mcp-headers"` and no `headers` block **[design]**. `bin/a2a-mcp-headers` is a POSIX script that prints exactly `{"Authorization":"Bearer <key>"}` on stdout, read from the key file **[design]**. It fails closed: on a missing, unreadable or malformed file it prints nothing and exits 1 **[design]**.
- How Claude Code runs a helper **[documented]**:
  - at session start and on reconnect, and once more after a 401 or 403
  - with a 10 second limit
  - with no caching of its output
  - for a plugin's helper, without credential-named environment variables
  - with the plugin root as its working directory
- **[verified 2026-11-24, Claude Code 2.1.331]** a plugin `headersHelper` that read a key file delivered its header to the server, and a real model call of `a2a_hello` through such a helper on the real server returned `bound: true` with no `A2A_API_KEY` in the environment.
- Because the helper runs again after a 401 or 403 and does not cache, a rotation takes effect as soon as the key file holds the new key: no restart of `claude` **[design, from the documented behaviour above]**. A GUI-launched or IDE-launched Claude needs nothing from your shell.

Second copy: none. The MCP header is computed from `keys/claude-code.key` at connect time, so Claude has no second copy of its key.

### 4.2 `antigravity`

- Hooks (`a2a-agy-session`, `a2a-agy-pending`) read `keys/antigravity.key` and pass the key to curl on stdin. Behaviour of the hooks is in [`agy-hooks.md`](agy-hooks.md).
- agy's MCP client can take only a literal `Authorization` header, and only in the user's global `~/.gemini/config/mcp_config.json`. agy expands its own placeholders but no environment variables in a plugin's MCP config **[verified, A8c parts 4 and 5, [`spike-results-2026-11-23-a8c-part4-5-agy.md`](../research/spike-results-2026-11-23-a8c-part4-5-agy.md)]**. So the plugin brings no MCP entry for agy, and you add one entry by hand (README, Antigravity). The plugin never edits that file.
- The key therefore exists twice: in `keys/antigravity.key` for the hooks, and as the literal in `mcp_config.json` for the MCP client. The user accepted this explicitly on 2026-11-24.
- The doctor hash-compares the two copies without printing either and `WARN`s when they differ **[design]**. A difference shows up as a working hook with a 401 on the MCP tools, or the other way round.

Second copy: the literal `Authorization` header of the `a2a-coord` entry in `~/.gemini/config/mcp_config.json` (keep that file mode 0600, out of any dotfiles repository and out of chezmoi). A rotation must replace it as well as the key file.

## 5. Lifecycle

### 5.1 Create

- One key per card, issued on a TTY, shown once:

```sh
docker compose exec -it coordination a2a-coord key create --scope local-harness --agent <card> --expires 90d
```

- Copy it into `keys/<harness>.key` at once (section 9). For `antigravity` also put it in the `mcp_config.json` entry.

### 5.2 Rotate

1. Issue the replacement. The old key keeps working until the grace period ends:

```sh
docker compose exec -it coordination a2a-coord key rotate <key_id> --grace 24h
```

2. Write the new key to `keys/<harness>.key`. The hooks and, for `claude-code`, the MCP helper read the file on their next call, so no restart is needed **[design]**.
3. For `antigravity` only: also replace the literal in `~/.gemini/config/mcp_config.json`, inside the grace window. agy may need a new session to reread that file **[unverified]**.
4. Run `bin/a2a-doctor`. It must show no `WARN` about the key files and both probes accepted.

### 5.3 Expiry

- Nothing warns before a key expires. The first sign is a 401 from the server.
- The doctor's probe then says "expired or revoked, run key rotate" **[design]**.
- `a2a-coord key list` shows each key's expiry date. Look a month ahead, and note it in your calendar.
- Rotate before the expiry. For a key that has already expired, create a new key and revoke the old one (see [`../runbooks/operations.md`](../runbooks/operations.md) section 11); whether `key rotate` accepts an expired key is **[unverified]**.

### 5.4 Revoke

`a2a-coord key revoke <key_id>` ends a key at once. Hooks stay silent; the doctor shows the 401.

## 6. What the doctor checks

All **[design]**; the checks are table-driven from the table of section 2, one block per harness. The doctor's own behaviour (output shape, never printing a key, bounded requests) is in [`doctor.md`](doctor.md).

- Per harness:
  - the key file exists (else `FAIL`; while a fallback source is in use, `WARN` with the migration commands)
  - the key file has mode 0600 and its directory 0700 (else `WARN`)
  - the first line looks like an `a2ak_` key (else `FAIL`; the line is not printed)
  - the key is accepted by the server through the registration probe (a 401 or 403 is a `FAIL` that says "expired or revoked, run key rotate")
- For `claude-code`: the plugin's `claude/mcp.json` names the helper and the helper is executable.
- For `antigravity`: the `a2a-coord` entry exists in `mcp_config.json`, its URL is the effective server URL plus `/mcp`, and the hash of its literal equals the hash of the key file (`WARN` when they differ; neither value is printed).
- `A2A_API_KEY` is not checked at all.

## 7. Invariants

- A key is never in a command line, in a repository, or in a chezmoi-managed file.
- A key is never printed: not by a hook, not by the helper's error path, not by the doctor. The helper prints the key only inside the header JSON it hands to Claude Code.
- The plugin never edits a harness's config. The `mcp_config.json` entry for agy is yours to add and to change.
- Hooks fail closed and silent: with no usable key they send no request, print nothing and exit 0. The helper also prints nothing, but exits 1, because Claude Code reads its exit status.
- A handle is not a credential. Nothing in the key files or the helper depends on a session.
- The key never enters a subprocess environment: it travels to curl on stdin, and to Claude Code on the helper's stdout.

## 8. Adding a harness

A new harness is exactly:

1. One row in the table of `bin/a2a-lib.sh` and the doctor (harness id, card prefix, key file, settings override name, old source if any).
2. One section of this file, headed by the harness id, ending with a line that starts exactly `Second copy:` followed by `none` or by where the second copy lives. If a harness's MCP client can read a file or run a helper, the answer is `none`.
3. One test block that exercises the hook read, the doctor checks and, when there is a second copy, the hash comparison.

A test requires every table row to have a section here that states its second copy **[design]**, so a harness cannot be added without answering the question.

## 9. Migration from the old layout

Run these in your own terminal. None of them prints a key.

```sh
mkdir -p -m 700 ~/.config/a2a-coord/keys

# Claude Code: move the old key file
mv ~/.config/a2a-coord/api-key ~/.config/a2a-coord/keys/claude-code.key

# agy: copy the literal out of the global MCP file into the canonical key file
jq -r '.mcpServers["a2a-coord"].headers.Authorization' ~/.gemini/config/mcp_config.json \
  | sed 's/^Bearer //' \
  | (umask 077; cat > ~/.config/a2a-coord/keys/antigravity.key)

bin/a2a-doctor
```

- The `mv` keeps the old file's mode 0600. Check with `ls -l ~/.config/a2a-coord/keys`.
- The agy command leaves the literal in `mcp_config.json` where it is: that is the second copy.
- If the `a2a-coord` entry is missing, `jq` writes the text `null` into the new file. The doctor's shape check then fails with `does not look like an a2a key`; remove the file and add the entry first.
- Remove the `export A2A_API_KEY=...` line from your shell profile. Nothing reads it any more. That profile and the rest of your dotfiles setup are yours to edit; this repository does not touch them.
- Until you migrate, the old sources keep working for one release and the doctor `WARN`s.

## 10. Guards

- The doctor's table-driven checks (section 6).
- `scripts/check-public-leaks.sh` fails on a key-shaped string, `a2ak_<env>_<id>_<secret>` with real-looking parts. A placeholder such as `a2ak_REPLACE_WITH_YOUR_KEY` is allowed **[design]**.
- A general secret scanner, `gitleaks`, runs in CI and as a pre-commit hook for this repository **[design]**.
- The user's dotfiles or chezmoi repository is outside this repository. The user owns that setup. A scanner there is an optional follow-up; nothing here depends on it.

## 11. Decisions and why

The decisions were made with the user on 2026-11-24 and are settled.

- **One canonical file per harness, read by everything that can read a file.** Why: one place to rotate, one thing for the doctor to check.
- **Claude gets its header from a `headersHelper`, not from a stored copy.** Why: the helper reads the same file the hooks do, so there is no second copy to drift, and it works from a GUI launch.
- **agy keeps a second copy, stated everywhere.** Why: its MCP client takes only a literal header in the global file. The user accepted this; the doctor compares hashes so a drift is visible.
- **The key is per card, not per session.** Why: handles are routing labels; a per-session key would need issuing on every start.
- **Fallbacks last one release.** Why: an upgrade must not break a working install, and the doctor tells you how to migrate.

Rejected alternatives for Claude's MCP credential:

| Alternative | Why not |
| --- | --- |
| Claude Code's `userConfig` credential store | The key would sit in a store the doctor cannot read: a second copy it cannot see or compare |
| A literal in the user scope of `~/.claude.json` | That file is mode 644, so the key would be readable by every local user |
| An environment variable (`A2A_API_KEY`) | It needs a shell export, is missing under a GUI or IDE launch, and needs a restart on every rotation |
| An `env` block in Claude's `settings.json` | The key would be in the environment of every subprocess Claude starts |
