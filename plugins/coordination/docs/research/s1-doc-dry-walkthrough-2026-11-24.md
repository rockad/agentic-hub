# S1-DOC dry walk-through, 2026-11-24

Evidence for the acceptance line of stream S1-DOC ([`../plans/master-plan.md`](../plans/master-plan.md), "a dry walk-through ... reaches a working S1 using only the docs"). It covers the guides [`../runbooks/setup.md`](../runbooks/setup.md) and [`../runbooks/operations.md`](../runbooks/operations.md). A read-only record.

## Method and isolation

- Host: a workstation with rootless Docker 29.10.0 and Compose v5.8.0. The user's own stack (compose project `coordination`, port 8120) was up and in use; it was **never touched**: not its containers, its volumes, its secret files, its image tags or its port.
- A throwaway stack under a unique compose project name (`a2adocwalk` plus six hex characters), on host port 18877, with:
  - throwaway secrets generated in a temporary directory (mode 0600 files in a 0700 directory, made with the commands of setup section 5, values never printed);
  - a throwaway cards file, dump directory and `HOME` in the same temporary directory;
  - a compose override file that gave the two images private tags (`a2adoc-coordination:walk`, `a2adoc-backup:walk`), so `coordination:local` and `coordination-backup:local` were not rebuilt or retagged;
  - `A2A_UID=0 A2A_GID=0` (rootless Docker).
- The key-creating commands need a terminal, and the tool session had none, so they were run on a pseudo-terminal made with `script -qec "<command>" <file>`; the printed keys went to files in the temporary directory and nowhere else. The host's real home directory, key files and agy file were never read; `a2a-doctor` ran with `env -i ... HOME=<temporary>`.
- The harnesses were not started (`claude` and `agy` were never run).

## What was run and what happened

| Step (guide) | Result |
| --- | --- |
| Secret files, cards file, dump directory (setup 5, 6) | Created with the guide's commands; modes 0600 and 0700 as stated |
| `docker compose build` of both images (setup 7) | Built; the server image ran its test suite inside the build and passed |
| `docker compose up -d` (setup 7) | `postgres` and `coordination` healthy; `GET /healthz` answered `{"ok":true}` |
| `a2a-coord db init-dump-role` twice (setup 8) | Both runs `dump_ro: role ready, password set from pg_dump_password, pg_read_all_data granted`, exit 0 |
| `key create` twice on a terminal (setup 9) | Two `local-harness` keys (card `claude-code@<machine>`, `antigravity@<machine>`) printed once; `key list` showed both with no secret |
| `key create` with `-T` (setup 9) | Refused: "needs a terminal on standard input and output", exit 1, nothing created |
| Key file, agy `mcp_config.json`, settings file (setup 10, 11) | Written in the temporary `HOME` with mode 0600 |
| `bin/a2a-doctor` with the temporary `HOME` (setup 12) | After the correction below: `0 FAIL, 1 WARN` (`A2A_API_KEY` not set), and `0 FAIL, 0 WARN` with it exported. The probe registered and ended one session per key |
| Doctor failure cases (setup 12.1) | Missing key file: FAIL with the "create it yourself" text; unknown key: `FAIL ... rejected the Claude key (status 401)`; nothing listening: `FAIL ... no answer`; config directory mode 755: WARN |
| `a2a-coord status`, `card check` (ops 3) | `stage s1, env dev`, `schema: coordination v4`, `backup: ... null` before the first dump; `cards OK`, exit 0 |
| One dump with `run --rm dump once` (ops 5) | `a2a-<UTC timestamp>.dump` (24528 bytes, mode 0600), "verified, last_ok updated"; `last_ok` readable in the server container; `status` then showed `last good dump 0.0 h ago` |
| Restore into a scratch Postgres (ops 7) | Image from `docker compose config`; ready twice; `pg_restore --exit-on-error` exit 0; 14 tables; `api_keys` count equal to the source (2 at that time) |
| `--profile backup up -d dump`, `restart dump` (ops 5) | The loop started and logged "next dump in 26464s (at 02:00, TZ=UTC)" |
| `key rotate --grace 1h`, `key revoke` (ops 11) | New key printed; old key's expiry 1 hour out; after `revoke` the old agy key got 401 in the doctor until the config held the new key |
| `remote-peer` key, a REST `SendMessage`, `review`, `review show`, `review deny` (ops 12) | The task was held (`held for review: 1`); `show` printed the body under the untrusted-data header; a wrong phrase left it held; the exact phrase denied it |
| `docker compose build`, then `A2A_ALLOW_WRITES=1 up -d --no-build --no-deps --force-recreate coordination` (ops 4) | Recreated; `/healthz` 200 after 3 polls; `A2A_ALLOW_WRITES=1` in the container; doctor passed. A later plain `up -d` set the flag back to 0 and recreated the container |
| `docker compose stop coordination`, then `up -d --no-build coordination` (ops 14) | Doctor: `FAIL ... no answer`; after the start, `0 FAIL, 0 WARN` |
| `a2a-coord expose check` (ops 13) | `expose check is not available at this stage (S3-EXPOSE-CHECK)`, exit 2 |

## Where the docs had to be corrected

Each is already fixed in the guides.

- **A non-default host port fails with status 421.** The first run mapped the server to host port 18877 with `A2A_PORT`. Every doctor registration failed with `421`: the server checks the `Host` header against `A2A_ALLOWED_HOSTS` (default `127.0.0.1:8120,localhost:8120`), and `docker-compose.yml` does not pass that variable into the container. The walk-through only worked after an override file set `A2A_ALLOWED_HOSTS`. Setup section 7 now says to keep 8120 and what a second stack needs; the doctor table lists `421`.
- **`init-dump-role` acts on the project named `coordination` by default.** On a machine with another stack that is the wrong project, so the guides always pass `-p`.
- **The restore command's `\dt *.*` listing in `backup.md` printed hundreds of system rows.** Changed to `\dt` with a pointer to a row-count check, and the scratch container renamed `a2a-restore-scratch` so it does not collide with other scratch names.
- **`backup.md` said the status display "comes with a later stream".** `a2a-coord status` already prints `dump_age_h`; the text now says so.
- **A flag set on a `docker compose up` command line does not persist.** The next plain `up -d` reset `A2A_ALLOW_WRITES` to 0 and recreated the container. Operations section 4 now says to persist flags in `.env` or the shell environment and to keep `A2A_UID`, `A2A_GID` and `A2A_CONFIG_DIR` unchanged.
- **The recreate needs a build first.** Added as operations section 4 (the user's report of 2026-11-24: the tag `coordination:local` was missing from the image store).
- **Terminal-only commands cannot be driven without a terminal.** Not a doc error, but the reason the walk-through used `script`; the guides keep `-it` as the rule.

## Not run

- Installing the plugin in Claude Code and in agy, a live session, the hooks inside a harness, a real task round trip between two live sessions: no harness was started.
- The second restic job: `restic` is not installed on the walk-through machine and there is no rclone remote; the job needs the always-on host.
- A Postgres upgrade and a restore into the real stack's volume (only the scratch restore was run).
- Rotation of the server's database password.
- The stage flip, `expose check` (a stub), the 8121 listener, Tailscale identity, the Cloudflare route: not built.
- The SDK upgrade routine and the A2A TCK run.
- Use of `.env` with compose, a rootful Docker, macOS.
- `docker compose up` on the user's real stack, its secrets and its files: deliberately not touched.

## Teardown

- `docker compose --profile backup down -v` for the throwaway project removed its containers, its network and its three volumes.
- The temporary directory (secrets, keys, dumps, cards, `HOME`, typescripts) was deleted.
- After it, `docker ps -a`, `docker network ls` and `docker volume ls` listed no entry with the project name or the prefix `a2adoc`.
- Left on purpose: the two images `a2adoc-coordination:walk` and `a2adoc-backup:walk` (no image was removed in this stream; remove them by their exact tags if the disk space matters), and the base images pulled for the build.
