# Setup guide: from a clean machine to a working stage s1

Stream S1-DOC of the master plan ([`../plans/master-plan.md`](../plans/master-plan.md), section "S1-DOC"). The goal is that someone other than the author can install and run the coordination service on one workstation, connect Claude Code and Antigravity (`agy`) to it, and check the result. Day-two work (backups, keys, upgrades, stopping it) is in [`operations.md`](operations.md). The backup details are in [`backup.md`](backup.md).

Labels used in this guide:

- **[verified 2026-11-24]** means the step was run in the dry walk-through of that date ([`../research/s1-doc-dry-walkthrough-2026-11-24.md`](../research/s1-doc-dry-walkthrough-2026-11-24.md)) on a throwaway stack and a temporary `HOME`, and the output was read.
- **[verified, `tests/<file>`]** means a test in the repository pins the point (named in the label or in the spec it comes from). That stream of the plan ran it; this documentation stream did not run that test again unless the text says 2026-11-24.
- **[unverified]** means it was not run, either because it needs a live harness, a real host or something not yet built, or because it was read from the code and the specs only.
- Values in angle brackets are placeholders: `<machine>` is the short host name of the workstation, `<key id>` is the 8-hex-character id that `key list` prints.

## 1. What you are installing

- One Docker Compose project with two services and, optionally, a third:
  - `postgres`: the database. No published port, password from a secret file.
  - `coordination`: the server. One Python process, port 8120 on host loopback (`127.0.0.1`) only.
  - `dump`: the nightly backup sidecar, in the compose profile `backup`. Off unless you ask for it.
- Two plugin installs, one per harness, from the remote `main` of `rockad/agentic-hub`. The plugin brings the hook scripts; it does not carry a key.
- Two small files of your own outside the repo: a key file per harness, and an optional settings file.

Nothing here starts, drives or wraps `claude` or `agy`. Sessions talk to the server over HTTP; the server never launches a harness.

## 2. Stages: what `s1` means

The server has an exposure stage, `A2A_EXPOSURE_STAGE`. The default, and the only stage this guide sets up, is `s1`.

- **`s1`**: development on one workstation. The server is reachable on `127.0.0.1:8120` only. Every request still needs a scoped API key, loopback included. No public listener, no Tailscale identity check, `A2A_PUBLIC_URL` may be `http://`.
- **`s2`** and **`s3`**: production on the always-on host (tailnet, later a public HTTPS route). They add start-up checks (an `https://` public URL, trusted proxies, the public listener on 8121, the Tailscale identity check) and are **not usable with the shipped compose file and server today**; see [`operations.md`](operations.md) section 13. Do not set them to "try them out": the server refuses to start with an `s2` or `s3` configuration that fails its checks [verified, `tests/test_auth_startup.py`].

The compose file publishes the server on host loopback at every stage (`127.0.0.1:${A2A_PORT:-8120}:8120`). Nothing in this guide opens the service to the network.

## 3. Prerequisites

On the machine that runs the stack:

- Docker Engine with Compose v2 (`docker compose version`). The dry walk-through used Docker 29.10.0 (rootless) with Compose v5.8.0 [verified 2026-11-24]. Network access to pull `python:3.14-slim`, the pinned `postgres:17.11-alpine` image and the `uv` image at build time.
- `uv`, to run the host command `a2a-coord db init-dump-role` from the checkout (it needs Python 3.14 or newer; `uv` finds or fetches one). [verified 2026-11-24]
- `openssl` and `curl`. `jq` is optional and makes `a2a-doctor` more precise.
- A checkout of the repository: `git clone https://github.com/rockad/agentic-hub` (the stack is built from `plugins/coordination/` in that checkout).

On each machine that runs a harness:

- Claude Code 2.1.290 or later [reported, from the Claude Code changelog; see [`../specs/server-api.md`](../specs/server-api.md) 7.6] and/or `agy`.
- `curl` and a POSIX `sh` (the hooks use nothing else). The stack and the harnesses may be on one machine, which is what stage s1 assumes.

Find out which Docker you have, because it changes one variable in section 5:

```sh
docker info --format '{{.SecurityOptions}}'    # a list containing name=rootless means rootless Docker
id -u; id -g
```

## 4. Names: machine, cards, keys

A **card** is the name a harness registers under: `<harness>@<machine>`. The hooks compute it from the host name, so the cards file (section 6), the key (section 8) and the hook must all agree.

- Claude Code card: `claude-code@<machine>`.
- agy card: `antigravity@<machine>`.
- `<machine>` is the host name up to the first dot, lower case, any character outside `a-z0-9-` replaced by `-`, at most 32 characters. Compute it the way the hooks do:

```sh
uname -n | cut -d. -f1 | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n-' '-' | cut -c1-32
```

If that is not the name you want (a Mac with a changing host name, WSL), pick the name yourself and tell the hooks with `A2A_CARD` and `A2A_AGY_CARD` in the settings file (section 11). A card id must match `^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}$`.

You need two keys per machine, one per harness, because a key is bound to one card.

## 5. The host directories and secret files

Everything below lives **outside the repository**. The stack reads secret files from one directory, default `~/.config/a2a-coord/secrets` (override with `A2A_SECRETS_DIR`). The directory is mode 0700, each file mode 0600, and the two values differ.

Create the two secret files yourself. The commands generate a random value and write it straight into the file; nothing prints it and nothing else stores it:

```sh
install -d -m 700 ~/.config/a2a-coord/secrets
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/secrets/a2a_db_password)
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/secrets/pg_dump_password)
```

- `a2a_db_password`: the password of the `coordination` database role. Postgres and the server read it. Changing the file after the database volume exists does not change the role; see [`operations.md`](operations.md) section 8.
- `pg_dump_password`: the password of the read-only `dump_ro` role, used by the backup sidecar only. A plain `docker compose up` does not need the file, but the compose file declares it, so create it now to avoid a start-up error at the time you turn backups on.

Never paste either value into a chat, a ticket or a shell history, and never commit them. [verified 2026-11-24: both files were created with these commands in a throwaway directory.]

- **Optional API key pepper (`A2A_KEY_PEPPER`):** by default, API key secrets are stored as SHA-256 hashes (`sha256:<hex>`). To enable server-side HMAC-SHA-256 peppering (`hmac-sha256:<hex>`), create a mode-0600 pepper file outside the repository and export `A2A_KEY_PEPPER` from the shell that starts or recreates `coordination`:

  ```sh
  (umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/secrets/a2a_key_pepper)
  export A2A_KEY_PEPPER="$(cat ~/.config/a2a-coord/secrets/a2a_key_pepper)"
  ```

  When `A2A_KEY_PEPPER` is unset or empty, the stack starts normally without peppering. Never put `A2A_KEY_PEPPER` in `.env`, never commit it, and do not paste `docker compose config` output while it is exported (server logs automatically scrub `key_pepper`). Keys created before enabling `A2A_KEY_PEPPER` keep verifying under `sha256:`, whereas keys created with a pepper (`hmac-sha256:`) stop verifying if the pepper is removed or changed.

The dump directory (for backups; create it now, owned by you, before the first start, otherwise a rootful Docker creates it as root):

```sh
install -d -m 700 ~/.local/share/a2a-coord/dumps
```

## 6. The cards file and `A2A_CONFIG_DIR`

The server reads its Agent Card definitions from `/config/cards.yaml`, which compose mounts read-only from the host directory `A2A_CONFIG_DIR`. The repository's `config/cards.yaml` is an empty placeholder (`cards: []`): with it the server starts, but no key can be issued for a card that does not exist.

Create your own cards directory, outside the repo:

```sh
install -d ~/.config/a2a-coord/config
```

Put this in `~/.config/a2a-coord/config/cards.yaml`, with your own `<machine>`:

```yaml
cards:
  - name: claude-code@<machine>
  - name: antigravity@<machine>
```

- `description`, `version` and `skills` are optional per card ([`../specs/server-api.md`](../specs/server-api.md) 1.5 and `a2a/cards.py`). A card with only `name` is valid [verified 2026-11-24].
- Cards are read when the server starts and written to the database then. After you edit the file, restart the server (`docker compose restart coordination`). `a2a-coord card check` says when a card in the file is missing from the table.
- **This directory is the cards directory, not the hook settings file.** The hook settings file is `~/.config/a2a-coord/settings` (section 11); `~/.config/a2a-coord/config/` is where a hand-run server keeps its cards. The two names are different on purpose.

## 7. Build and start

From the root of your checkout. After this block your working directory is `plugins/coordination`, and every later command in this guide and in [`operations.md`](operations.md) assumes it:

```sh
cd plugins/coordination
export A2A_CONFIG_DIR="$HOME/.config/a2a-coord/config"
export A2A_UID=$(id -u) A2A_GID=$(id -g)          # rootful Docker
# export A2A_UID=0 A2A_GID=0                       # rootless Docker instead (the host user is container root)
docker compose up -d --build
```

- Why `A2A_UID` and `A2A_GID`: compose bind-mounts a file secret as it is on the host and ignores the owner and mode set for it, so the server must run as the user that owns the 0600 file. The default `10001` is the image's own user and works only when the secret files are owned by that uid. A failure to read a secret names the path and the OS error, never the contents.
- You can put `A2A_CONFIG_DIR`, `A2A_UID`, `A2A_GID` and other non-secret variables in an uncommitted `plugins/coordination/.env` file instead of exporting them (`.env` is git-ignored; compose reads it by itself) [unverified: Compose's own behaviour, not run here]. Secrets never go there.
- The first build takes minutes: the image runs the whole test suite in its build stage, and a failing test fails the build [verified 2026-11-24]. The compose project name is `coordination`; the server image is tagged `coordination:local`. The sidecar image `coordination-backup:local` is built only when the `backup` profile is in play (for example `docker compose --profile backup build dump`); a plain `docker compose up -d --build` does not build it.
- By default `A2A_PORT` is `8120`, which the plugin's hooks and MCP entries default to. If you set a custom `A2A_PORT` (for example `A2A_PORT=8129` for a second stack with `-p`), `docker-compose.yml` derives `A2A_ALLOWED_HOSTS` (`127.0.0.1:${A2A_PORT:-8120},localhost:${A2A_PORT:-8120}`) and `A2A_PUBLIC_URL` (`http://127.0.0.1:${A2A_PORT:-8120}`) automatically unless overridden, so requests to that port do not fail with status 421; point your client's `A2A_SERVER_URL` (and second stack's image tags if needed) at the custom port.

Check that it is up:

```sh
docker compose ps                        # postgres and coordination both "healthy"
curl -fsS http://127.0.0.1:8120/healthz  # {"ok":true}
docker compose exec -T coordination a2a-coord status
```

`status` on a fresh stack shows `stage s1, env dev`, zero sessions, `schema: coordination v4` (the number grows with migrations) and `backup: last good dump null h ago` [verified 2026-11-24]. `null` is "unknown", expected before the first dump.

If the server container does not become healthy, read its log: `docker compose logs coordination`. A start-up check that fails prints one line starting `coordination:` that names the variable and never a secret [verified, `tests/test_auth_startup.py`].

## 8. Create the `dump_ro` role

Needed once if you will run backups (sections 5 and 8 of [`operations.md`](operations.md) are the routine; do this now so the first dump works). The role is created by a host command, with the stack up and your working directory `plugins/coordination` (the subshell in the command moves into the Python project and back):

```sh
(cd servers/coordination && uv run a2a-coord db init-dump-role -p coordination)
```

- It reads `pg_dump_password` on the host and feeds `psql` in the Postgres container over stdin, so the value is in no argument, log or environment. It is idempotent: run it again after a rotation [verified 2026-11-24, run twice, both "role ready"].
- Pass `-p <project>` (or set `A2A_COMPOSE_PROJECT`): the default project name is `coordination`, and the command acts on that project. `--secrets-dir` and `--compose-file` override the secrets directory and compose file.
- It prints `dump_ro: role ready, password set from pg_dump_password, pg_read_all_data granted` and exits 0. A non-zero exit says whether Postgres is up and healthy in that project.

## 9. Create the API keys (on a TTY)

Run this on your own terminal, from `plugins/coordination`. The key is printed **once, on that terminal**, and cannot be shown again. Create one key per harness card:

```sh
docker compose exec -it coordination a2a-coord key create --scope local-harness --agent claude-code@<machine> --expires 90d
docker compose exec -it coordination a2a-coord key create --scope local-harness --agent antigravity@<machine> --expires 90d
```

- `-it` is required. Without a terminal on both stdin and stdout the command refuses and creates nothing (`-T` refuses: verified 2026-11-24). It also refuses while an environment variable starting `CLAUDE`, `ANTIGRAVITY` or `AGY_`, or named `CI`, is set in the container; `docker compose exec` does not forward your host variables, so this matters only if you add `-e`.
- `--agent` must be a card from your cards file; otherwise the command is refused.
- `--expires` is required: `<n>d` or `<n>h`, at least 1 hour, at most 365 days at stage s1. Put a reminder in your calendar: an expired key stops working, and `key list` shows the expiry ([`operations.md`](operations.md) section 11).
- The output shows `key id`, `scope`, `owner`, `expires` and, last, the secret, `a2ak_dev_<keyid>_<secret>`. Copy it from the terminal into a mode-0600 file at once (section 10 and 11). It is in your terminal's scrollback until you clear it. [verified 2026-11-24: the command was run on a pseudo-terminal in the walk-through.]
- `key list` (no `-it` needed) shows the key id, status, scope, owner, expiry and last use, never a secret.

## 10. Install the plugin in Claude Code

```sh
claude plugin marketplace add rockad/agentic-hub
claude plugin install coordination@agentic-hub
```

[unverified: `claude` was not run in this stream. The commands are the ones in the plugin README and printed by `a2a-doctor`.] The plugin installs from the remote `main`, never from a copied or symlinked folder.

Then the key, which the hooks read from a file:

```sh
install -d -m 700 ~/.config/a2a-coord
(umask 077; : > ~/.config/a2a-coord/api-key)
${EDITOR:-vi} ~/.config/a2a-coord/api-key       # one line: the claude-code@<machine> key, nothing else
```

- The file is `~/.config/a2a-coord/api-key`, one line (the key), mode 0600.
- The MCP entry of the plugin sends `Authorization: Bearer ${A2A_API_KEY}`, and Claude Code expands that from the environment. This line holds no secret, so it may live in a shell profile (including a chezmoi-managed one): `export A2A_API_KEY="$(cat "$HOME/.config/a2a-coord/api-key")"`. Start `claude` from a shell that has it. Without it the `a2a_` tools answer 401, and the registration hook says so at session start. A Claude Code started from a desktop launcher or an IDE does not have your shell's variable; the hooks still work (they read the file) but the `a2a_` tools do not [unverified, a live check, see [`../specs/claude-hooks.md`](../specs/claude-hooks.md) section 9, L4].

## 11. Install the plugin in agy, and the settings file

```sh
agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/coordination
```

[unverified: `agy` was not run, and installing from a GitHub tree URL has never been run; a local-path install was verified by the A8c spike. See the plugin README.]

agy's plugin brings the hooks but **no MCP entry and no key**: agy does not expand environment variables in a plugin's MCP config. You add one entry to your global agy MCP file, `~/.gemini/config/mcp_config.json`, by hand, with the `antigravity@<machine>` key as a literal header. Merge this into the existing `mcpServers` object (do not replace the file):

```json
{
  "mcpServers": {
    "a2a-coord": {
      "type": "http",
      "url": "http://127.0.0.1:8120/mcp",
      "headers": {
        "Authorization": "Bearer <the antigravity@<machine> key>"
      }
    }
  }
}
```

```sh
chmod 600 ~/.gemini/config/mcp_config.json
```

- The agy hooks read the key from the first `a2ak_` token in that same file. Keep the file out of any dotfiles repository and out of chezmoi.
- The entry is outside the plugin, so `agy plugin uninstall` does not remove it.
- `"type": "http"` in a global `mcp_config.json` was not verified against agy (the spikes verified `url` and `headers`). [unverified]

The **settings file** is optional and holds no secret: `~/.config/a2a-coord/settings`, plain `KEY=value` lines, mode 0600, read by the hooks and by `a2a-doctor`. Only five names are read:

```sh
A2A_SERVER_URL=http://127.0.0.1:8120
A2A_CARD=claude-code@<machine>
A2A_AGY_CARD=antigravity@<machine>
A2A_KEY_FILE=/home/user/.config/a2a-coord/api-key
A2A_AGY_KEY_FILE=/home/user/.gemini/config/mcp_config.json
```

- Use absolute paths; `~` and `$HOME` are not expanded. Set `A2A_CARD` and `A2A_AGY_CARD` only when your card names differ from the host-name default of section 4.
- It is not `~/.config/a2a-coord/config/`; that is the cards directory of section 6.

## 12. Verify with `a2a-doctor`

`a2a-doctor` is a script you run by hand. It checks the install, prints what to do about each finding, edits nothing, and never prints a key. Run it in place, from the folder that holds `plugin.json` and `bin/` (a checkout: `bin/a2a-doctor` from `plugins/coordination`; an installed copy is at the harness's own path, which this guide does not fix [unverified]):

```sh
bin/a2a-doctor              # every check
bin/a2a-doctor --no-network # skip the server section
```

It ends with `a2a-doctor: N FAIL, M WARN`. Exit status 0 when there is no FAIL, 1 when there is at least one, 2 for a usage error. A healthy install ends `0 FAIL, 0 WARN` [verified 2026-11-24: with a temporary `HOME` holding the key file, the settings file and an agy file, against the throwaway stack, plus `A2A_API_KEY` exported].

The server section registers a probe session per key (`doctor-<pid>`) and ends it again; the server records both in its audit trail. A fresh stack with a probe shows `sessions: ... ended` counts in `a2a-coord status` afterwards [verified 2026-11-24].

### 12.1 What each line means and how to fix it

| Line | Meaning | Fix |
| --- | --- | --- |
| `FAIL a2a-lib.sh not found next to a2a-doctor` or `FAIL <script> missing / not executable` | The doctor was copied away from its folder, or the plugin is broken | Run it in place; reinstall the plugin from `main` |
| `FAIL curl` missing | The hooks need curl | Install curl |
| `WARN config directory ... mode 755 is wider than 700` | `~/.config/a2a-coord` is readable by others | `chmod 700 ~/.config/a2a-coord` [verified 2026-11-24 that this WARN appears for a mode-755 directory; the `chmod` fix itself was not run] |
| `WARN settings file ... mode` | The settings file is wider than 0600, or you do not own it (the hooks ignore a file you do not own) | `chmod 600` it, or recreate it as yourself |
| `FAIL settings ... is a directory` | A directory sits at the settings path | Remove it; the file is `settings`, not `config` |
| `FAIL Claude key file ... is missing` | No `~/.config/a2a-coord/api-key` | Create it (section 10) [verified 2026-11-24] |
| `WARN Claude key file ... mode` | Mode wider than 0600 | `chmod 600` it |
| `FAIL ... does not look like an a2a key` | First line is empty, has a space, quote or CR, or is not `a2ak_...` | Rewrite the file with the key only; the line is not printed |
| `WARN A2A_API_KEY is not set in this shell` | The MCP header of Claude Code needs it | Export it from the key file (section 10), restart Claude Code [verified 2026-11-24] |
| `WARN agy entry not set up` | No `a2a-coord` entry in the agy file | Add the snippet of section 11 [verified 2026-11-24] |
| `FAIL ... has an a2a-coord entry but no a2ak_ key`, or the placeholder `a2ak_REPLACE_WITH_YOUR_KEY` | The snippet was pasted without a key | Put the `antigravity@<machine>` key in the header |
| `WARN agy entry url is not <server url>/mcp` | The entry points elsewhere | Fix the `url` to the server URL plus `/mcp` |
| `WARN` orphan `~/.gemini/config/plugins/coordination/mcp_config.json`, or another `a2a-` server | Leftovers from the older install layout | Delete the old file by hand; the doctor never does |
| `FAIL GET <url>/healthz: no answer` | The server is not running, or the URL is wrong | `docker compose ps`; `docker compose up -d`; check `A2A_SERVER_URL` [verified 2026-11-24] |
| `FAIL Claude registration failed with status 421` (or agy) | The server refused the `Host` header | Use the default port 8120, or set `A2A_ALLOWED_HOSTS` in an override file [verified 2026-11-24] |
| `FAIL the server rejected the Claude key (status 401)` (or agy, or 403) | The key is wrong, expired, revoked, or the card of the key does not match the hook's card | `a2a-coord key list`; compare the status and owner; set `A2A_CARD` / `A2A_AGY_CARD`, or issue a new key [verified 2026-11-24: 401 for an unknown key; after `key revoke` the agy line failed with 401] |
| `FAIL not a valid card` | The computed card name has a bad shape | Set `A2A_CARD` / `A2A_AGY_CARD` in the settings file |
| `INFO probe session ended` / `could not be ended` | Cleanup of the probe; a failed end is harmless | None; the session ends by itself when idle |

Other statuses are printed as `status N` only; the server's body is never shown. Read `docker compose logs coordination` for the server's side.

When the doctor passes, the `a2a_` tools are available in a new Claude Code or agy session. The first real exchange (a task sent from one live session and read in another) is the user's live check, not something this guide exercises [unverified].

## 13. Where to go next

- A first backup and a restore test: [`operations.md`](operations.md) sections 5 to 7.
- Stopping it, changing a flag, rotating a key: [`operations.md`](operations.md).
- What the service does not do: [`operations.md`](operations.md) section 16 (known limits).

## 14. Dry walk-through

The dated record of an end-to-end run of these steps, every place the guide had to be corrected, and what was not run is in [`../research/s1-doc-dry-walkthrough-2026-11-24.md`](../research/s1-doc-dry-walkthrough-2026-11-24.md).
