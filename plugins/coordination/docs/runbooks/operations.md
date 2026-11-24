# Operations runbook: run, back up, restore, rotate, stop

Stream S1-DOC of the master plan ([`../plans/master-plan.md`](../plans/master-plan.md), section "S1-DOC"). It assumes the stack from [`setup.md`](setup.md) is installed. The backup details (retention, failure behaviour, the second restic script text) are in [`backup.md`](backup.md); this runbook gives the procedure and links there instead of repeating the whole text.

Labels:

- **[verified 2026-11-24]** means the step was run in the dry walk-through ([`../research/s1-doc-dry-walkthrough-2026-11-24.md`](../research/s1-doc-dry-walkthrough-2026-11-24.md)) on a throwaway stack and the output was read.
- **[unverified]** means it was not run (needs a real host, a live harness, a different Postgres image, or something not yet built), or it was read from code and specs only.
- **[not built]** means the command or feature is named in the plan and does not exist yet. Where the plan or a spec says it works, this runbook says what the code does today.

Placeholders: `<key id>` is the 8-hex id from `key list`; `<task id>` is a task id from `review`; `<UTC timestamp>` is like `20261112T020000Z`; `<storage-host>`, `<media-root>`, `<gdrive-remote>` are as in [`backup.md`](backup.md).

All `docker compose` commands run from `plugins/coordination` (the directory with `docker-compose.yml`), with the same environment you started the stack with: `A2A_UID`, `A2A_GID`, `A2A_CONFIG_DIR` and any other variable of [`setup.md`](setup.md) section 7. A different value on a later command changes the container (a different `A2A_UID` can make the secret files unreadable).

## 1. Two kinds of command

- **Admin commands** (`key`, `review`, `status`, `card check`) run inside the server container and talk to an unpublished Unix socket. Form: `docker compose exec -T coordination a2a-coord ...` for read-only ones, `docker compose exec -it coordination a2a-coord ...` for the ones that need a terminal (`key create`, `key rotate`, `review show|release|deny`). There is no admin HTTP endpoint.
- **Host commands** run on the host from the checkout and use Docker: `a2a-coord db init-dump-role` (`cd servers/coordination; uv run a2a-coord db init-dump-role -p coordination`).
- Exit codes of `a2a-coord`:
  - 0: done.
  - 1: refused or failed (the message says why).
  - 2: the server could not be reached, the command is not available yet, or the arguments are wrong.

## 2. Day to day

```sh
docker compose ps                                  # postgres and coordination "healthy"
curl -fsS http://127.0.0.1:8120/healthz            # {"ok":true}
docker compose logs --tail 100 coordination        # no bodies and no keys are logged
docker compose exec -T coordination a2a-coord status
plugins/coordination/bin/a2a-doctor                # from the repo root: the install check
```

- Stop without losing anything: `docker compose stop` (or `docker compose down`, which keeps the named volumes). Start again with `docker compose up -d --no-build` (see section 4 for the image caveat). Tasks and sessions are in Postgres and survive.
- **Never run `docker compose down -v` on a stack you care about.** `-v` removes the named volumes, including `a2a-pgdata`, which is the database.
- Server log levels: `A2A_LOG_LEVEL` (`debug`, `info`, `warning`, `error`, `critical`); any other value stops the start.

## 3. Reading `a2a-coord status`

`a2a-coord status` (add `--json` for the raw answer) prints counts and identifiers only, never a body or a secret. Output of a healthy idle stack [verified 2026-11-24]:

```text
stage s1, env dev, at 2026-11-24 18:37Z
sessions:     0 registered, 0 active, 4 ended; MCP sessions bound 0
listeners:    0 parked
pending:      0 submitted (0 in a card queue), 0 held for review, 0 working
wake budgets: limit 20 per hour per handle; 0 handle(s) woken in the last hour
stale offers: 0 task(s) offered 5 times and still unconfirmed
schema:       coordination v4, SDK revision b5e3d1c8a2f7
backup:       last good dump 0.0 h ago (null = unknown)
```

| Line | Meaning | When to act |
| --- | --- | --- |
| `stage`, `env` | The exposure stage and `A2A_ENV` | `env` must match the key prefix: a `dev` stack accepts only `a2ak_dev_` keys |
| `sessions` | Registered sessions, those active in the last 15 minutes, ended ones; `MCP sessions bound` is the in-memory Claude Code binding map | A session that should be live and shows `ended`: its hooks cannot reach the server (run `a2a-doctor`) |
| `listeners` | Parked `/wake/listen` requests, one per idle Claude Code session | 0 while Claude sessions are idle: the wake hooks are not running |
| `pending` | Submitted tasks, tasks queued at a card, tasks **held for review**, working tasks | `held` above 0: a remote peer waits for a human (section 12) |
| `wake budgets` | Wakes per handle in the last hour against the limit (`A2A_WAKE_BUDGET_PER_H`) | A handle near its limit: something is looping |
| `stale offers` | Submitted tasks offered `A2A_REOFFER_MAX` times and still unconfirmed, with up to 20 ids | Tasks nobody picks up; the recipient session may be gone |
| `schema` | The database schema version of this code and the SDK's migration revision | After an upgrade, to see what the database is at |
| `backup` | Age in hours of the last good dump; `null` is unknown (no good dump yet), not fresh | See section 6: `null` after the first night, or a value above 36, means backups are not working |

`status` does not flag a stale dump by itself: read the number. The 36-hour stale rule is applied by the server's `POST /status` (a `warning` log line "database dump is stale") for the later status client, and by `expose check` [not built].

`a2a-coord card check` (exit 0 no problem, 1 at least one, 2 could not evaluate) lists each card and whether it is in the `cards` table, and reports a card named by a key or a `remote-peer` allowlist but missing from the cards file [verified 2026-11-24: `cards OK`, exit 0].

## 4. Changing a flag or upgrading the server

Use this whenever the server container is recreated with a new environment value (for example `A2A_ALLOW_WRITES=1`), or the code changes (a `git pull`, a new SDK pin).

Always build first. A recreate with `--no-build` needs the image tag `coordination:local` in the image store, and the tag may be missing or stale: a container can stay healthy after its tag and image id have gone from the image store, and then `up --no-build --force-recreate` fails with "No such image: coordination:local" (seen on 2026-11-24 on a running stack). Building first makes the tag exist and makes it match the code in your checkout.

```sh
cd plugins/coordination
docker compose build coordination
A2A_ALLOW_WRITES=1 docker compose up -d --no-build --no-deps --force-recreate coordination
docker ps                                       # coordination "healthy", Postgres untouched
curl -fsS http://127.0.0.1:8120/healthz
plugins/coordination/bin/a2a-doctor            # from the repo root
```

- `--no-deps` leaves Postgres running; only the server container is recreated.
- A flag set on one command line applies to that recreate only. The next `docker compose up` without it goes back to the default and recreates the container to do so [verified 2026-11-24: after a recreate with `A2A_ALLOW_WRITES=1`, a plain `up -d` put it back to 0]. To make it stay, put the variable in the uncommitted `plugins/coordination/.env` (non-secret values only) or export it in the shell that runs compose.
- Keep `A2A_UID`, `A2A_GID` and `A2A_CONFIG_DIR` the same as when you started the stack.
- **Outage:** the server is down from the stop of the old container to the new one's health check, about 10 seconds at most (3 seconds on an idle throwaway stack, [verified 2026-11-24]; the image health check allows a 10 s start period). Parked wake listeners get `503` with `Retry-After: 5` on shutdown and re-park on their own. Sessions and tasks survive: they are in Postgres. What does not survive is the in-memory map from a Claude Code MCP session to its handle; the next `a2a_` call answers "Not bound. Call a2a_hello." and the session recovers by calling `a2a_hello` [by the S1-MCP spec; not exercised here].
- Test the flag: `A2A_ALLOW_WRITES=1` registers the MCP write tools (`a2a_send`, `a2a_respond`, `a2a_cancel`); `docker inspect` shows the variable in the container environment [verified 2026-11-24].
- **Upgrading the code:** take a dump first (`docker compose --profile backup run --rm dump once`), then `git pull`, then the same three steps. Migrations run at start and bring both streams (the service's and the SDK's) to head. A database migrated by a newer code or SDK is refused at start ("schema newer than the code"), so rolling the image back after a migration means restoring the dump (section 7) [by the code in `store/connect.py` and `store/sdk_migrations.py`; not exercised here].
- Plugins on the harness side update with the harness's own command; the exact commands are [unverified]. A server upgrade does not require a plugin update unless the release notes say so.

## 5. Backups with the dump sidecar

The nightly `pg_dump -Fc` of the whole `coordination` database is the backup. Full text: [`backup.md`](backup.md). The short form:

- The sidecar service `dump` is in the compose profile `backup`. A plain `docker compose up` does not start it. **A mis-set profile means backups silently off**; it shows up only as `dump_age_h` null or growing (section 6).
- Prerequisites: the secret file `pg_dump_password` (setup section 5), the role (`uv run a2a-coord db init-dump-role -p coordination`, setup section 8) and the dump directory (`A2A_DUMP_DIR`, default `~/.local/share/a2a-coord/dumps`, created by you).
- Start the nightly loop (about 02:00 in `A2A_TZ`, default UTC; change the time with `A2A_BACKUP_AT`, `HH:MM`):

```sh
docker compose --profile backup up -d dump
docker compose --profile backup logs dump          # "next dump in <s>s (at 02:00, TZ=UTC)"
```

  On a host that should always back up, set `COMPOSE_PROFILES=backup` in the compose environment instead, so every `docker compose up` includes the sidecar. [verified 2026-11-24: `--profile backup up -d dump` started the loop and logged the next time; `restart dump` worked.]
- One dump now (a test, or before an upgrade or a risky change); it exits non-zero when the dump fails:

```sh
docker compose --profile backup run --rm dump once
```

  It wrote `a2a-<UTC timestamp>.dump` (mode 0600) into the dump directory, verified it with `pg_restore`, then updated `last_ok`, and `status` showed `last good dump 0.0 h ago` [verified 2026-11-24].
- Loss window: up to about one day. A copy of the Postgres data directory or the `a2a-pgdata` volume is **not** a backup. The `a2a-data` volume is out of scope (go-live import artefacts only).
- Retention (done by the sidecar after each good dump): the newest dump of each of the last 14 UTC days that have one, plus the first dump of each of the last 3 months; `pre-import-*.dump` files are never deleted by the sidecar.

## 6. `dump_age_h`, and the second check

```sh
docker compose exec -T coordination a2a-coord status | tail -1     # backup: last good dump N h ago
docker compose exec -T coordination cat /var/lib/a2a-backup/last_ok   # the UTC time of the last good dump
docker compose --profile backup logs dump                              # ERROR lines on a failed dump
```

| `dump_age_h` | Meaning |
| --- | --- |
| `null` | No good dump yet (file absent, empty, unreadable). Expected before the first dump. Afterwards: profile not on, `init-dump-role` not run, or the secret is wrong. Read `docker compose logs dump`. |
| up to 36 | Healthy for a nightly dump |
| above 36 | Stale: at least one night was missed. Read the `ERROR` lines of the sidecar log. A failed dump never touches `last_ok`, so the age keeps growing. |

**The second check, when the server is down:** the second restic job (section 9) has its own log, `~/.local/share/a2a-coord/a2a-restic.log` on the always-on host. A line per run showing the snapshot of the dump directory means dumps are still being collected. Look at it on any morning the server is down or `status` is not reachable.

## 7. Restore

Restore into a scratch Postgres first: to check a dump, and before every Postgres upgrade. The scratch container uses the pinned image of the stack, has no network and no password (reachable only by `docker exec`), and never touches the real volume. Run from `plugins/coordination` with the stack's environment:

```sh
IMAGE=$(docker compose config --format json | jq -r '.services.postgres.image')
docker run -d --name a2a-restore-scratch --network none -e POSTGRES_USER=coordination -e POSTGRES_DB=coordination \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE"
# wait until the log shows "ready to accept connections" twice (the init run, then the real start)
docker logs a2a-restore-scratch 2>&1 | grep -c 'ready to accept connections'
DUMP=a2a-<UTC timestamp>.dump
docker exec -i a2a-restore-scratch pg_restore -U coordination -d coordination --exit-on-error < "${A2A_DUMP_DIR:-$HOME/.local/share/a2a-coord/dumps}/$DUMP"
echo "pg_restore exit: $?"                                       # must be 0
docker exec a2a-restore-scratch psql -U coordination -d coordination -c '\dt'      # 14 tables at schema v4
docker exec a2a-restore-scratch psql -U coordination -d coordination -tAc 'SELECT count(*) FROM api_keys'
docker rm -f a2a-restore-scratch
```

[verified 2026-11-24: restore of a dump of the throwaway stack exited 0; the 14 tables were present; `api_keys` held the same number of rows as the source.]

- `pg_restore` must exit 0 (`--exit-on-error` makes any error fatal). Compare row counts with the source only after writers are stopped: a dump is a snapshot of one moment.
- Use a different container name if `a2a-restore-scratch` exists. `docker rm -f` of the scratch container is the only removal this procedure does.
- **Restoring into the real stack** after losing the volume (this removes the database volume: do it only when it is lost or you have decided to replace it) [unverified, procedure from [`backup.md`](backup.md); the scratch restore above is the part that was run]:
  1. `docker compose down`
  2. Remove the `a2a-pgdata` volume of this project (`docker volume ls`, then `docker volume rm <project>_a2a-pgdata`).
  3. `docker compose up -d postgres` (a fresh, empty database).
  4. `docker compose exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/a2a_db_password)" exec pg_restore -U coordination -d coordination --exit-on-error' < "$A2A_DUMP_DIR/$DUMP"`
  5. `uv run a2a-coord db init-dump-role -p coordination` (from `servers/coordination`).
  6. `docker compose up -d --no-build` after `docker compose build coordination` (section 4).
- Keys, sessions and tasks come back with the dump. Keys issued after the dump are gone; reissue them.
- The restore test of the repository (`servers/backup/restore-test.sh`) runs only against a dev project, never the live stack.

## 8. The `dump_ro` role and the secrets

- `a2a-coord db init-dump-role -p <project>` creates the read-only role `dump_ro` if absent, sets its password from `pg_dump_password`, and grants `pg_read_all_data`. Run it once after Postgres first starts, and again on every rotation. It is idempotent [verified 2026-11-24].
- **Rotating the `dump_ro` secret:**
  1. Put a new value in `pg_dump_password` (mode 0600, different from `a2a_db_password`): `(umask 077; openssl rand -hex 32 | tr -d '\n' > "$A2A_SECRETS_DIR/pg_dump_password")`.
  2. `uv run a2a-coord db init-dump-role -p coordination` (the old password stops working).
  3. `docker compose --profile backup restart dump` so the loop reads the file again. A one-off `run --rm dump once` always reads the current file.
- The `pg_dump_password` file is mounted only into the sidecar; the server's `a2a_db_password` is never in the sidecar. Neither value is put in an argument, an environment variable or a log by these steps.
- **The server's database password** (`a2a_db_password`): changing the file does not change the role in an existing database. A rotation needs `ALTER ROLE coordination PASSWORD ...` inside Postgres and then a restart of both services. The procedure is **[unverified]** and not written as a command here on purpose: do it from a dump, in a scratch copy first, and never put the value in an argument.
- Keep the secret files out of every repository and backup that other people can read. The dump files contain the whole database (key hashes included, never key secrets): keep the dump directory mode 0700.

## 9. The second restic job (user-installed)

The dump directory is collected off the host by a second restic job. **The installer does nothing here and never edits a crontab: you install it.** The values, the script text and the crontab line are in [`backup.md`](backup.md) ("The second restic job"). The steps, on the always-on host:

1. Create the restic password file yourself, mode 0600, **never in a doc or a repository**: `install -d -m 700 ~/.config/a2a-coord; (umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/restic-password)`. **Keep an offline copy of this password** (a password manager): without it the restic repository cannot be opened and every backup in it is lost.
2. Create the restic repository once: `restic init` with `RESTIC_REPOSITORY=rclone:<gdrive-remote>:backups/restic-a2a` and `RESTIC_PASSWORD_FILE=$HOME/.config/a2a-coord/restic-password` set (a repository of its own, not the knowledge-archive one).
3. Save the script `a2a-restic-backup.sh` from `backup.md` at `~/.local/share/a2a-coord/<version>/bin/a2a-restic-backup.sh`, `chmod +x` it, with `SRC=<media-root>/backup/a2a/`, tag `a2a-dumps`, retention `restic forget --keep-last 3 --prune --tag a2a-dumps`.
4. Add the printed crontab line with `crontab -e` (as yourself): `45 5 * * *` in the host's local time, after the existing 05:30 job and well after the 02:00 dump, appending to `$HOME/.local/share/a2a-coord/a2a-restic.log`.
5. Check once that it collects the dump directory: run the script by hand and read `restic snapshots --tag a2a-dumps`. Record the result as verified or not in the deploy notes.

Not run in this stream (it needs the always-on host and your rclone remote): [unverified]. `restic` was not installed on the walk-through machine.

## 10. Upgrading Postgres

An upgrade is deliberate: the image is pinned by exact tag and digest in `docker-compose.yml`, and the sidecar's client package must match the server's major version.

1. Take a dump: `docker compose --profile backup run --rm dump once`. Confirm `status` shows a fresh `backup` line.
2. Change the pinned `image:` of `postgres` in `docker-compose.yml` (exact tag plus digest) **and** the sidecar's `postgresql17-client` package in `servers/backup/Dockerfile` to the same major version.
3. Restore the dump into a scratch container of the new image (section 7, with the new image). `pg_restore` must exit 0 and the tables and counts must match.
4. Only then upgrade: `docker compose build` the images, stop the stack, and bring it up with the new image. Postgres cannot start a data directory written by another major version; a major upgrade therefore means the restore route of section 7 (new empty volume, `pg_restore`), not an in-place start [by Postgres's own rules; not run here]. A minor version of the same major starts on the existing volume.
5. Finish with three checks, in this order:
   - `uv run a2a-coord db init-dump-role -p coordination`
   - `docker compose --profile backup run --rm dump once`
   - `a2a-doctor`

The whole routine is **[unverified]**: only the scratch restore of step 3 was run (with the current image).

## 11. Keys: create, list, rotate, revoke

```sh
docker compose exec -T coordination a2a-coord key list
docker compose exec -it coordination a2a-coord key create --scope local-harness --agent <card> --expires 90d
docker compose exec -it coordination a2a-coord key rotate <key id> --grace 24h
docker compose exec -T coordination a2a-coord key revoke <key id>
```

- `key list` columns: key id, status (`active`, `expired`, `revoked`), scope, owner, node, created, expires, last used. Check the `expires` of every key a month ahead.
- **Create** is in [`setup.md`](setup.md) section 9. The scopes:
  - `local-harness`: a harness on a machine; `--agent` is its card.
  - `remote-peer`: an external agent; `--agent` is a peer label, `--cards <card>` is required with at least one existing card (repeat the option or comma-separate), `--tailnet-node` is refused.
  - `status-client`: the cognitive-engine adapter; `--agent` is a label.
- Lifetime ceiling of `--expires`: 365 days at `s1`, 90 days at `s2` and `s3`. `--tailnet-node` is optional at `s1` and required at `s2` and `s3`; `--tailnet-login` does not exist yet.
- **Rotate** (needs `-it`): issues a replacement with the same scope, owner, allowlist and node, and prints its secret once. The old key keeps working until the grace ends (default 24 h; `--grace 0h` ends it now; the sooner of its own expiry and now plus the grace). Hand the new key over, then the old one lapses by itself:
  - Claude Code: put the new key in `~/.config/a2a-coord/api-key` (mode 0600), re-export `A2A_API_KEY` in the shell profile's shell, and restart `claude`.
  - agy: replace the token in the `Authorization` header of `~/.gemini/config/mcp_config.json` (mode 0600).
  - Run `a2a-doctor`.
  [verified 2026-11-24: `rotate --grace 1h` printed a new key; `key list` showed the old one expiring in 1 hour and the new one active.]
- **Revoke:** ends a key at once. The next request with it gets 401, and its live `/mcp` sessions and parked `/wake/listen` requests are closed. `revoke` needs no terminal. Exit 1 if a revoke hook failed (the key is revoked anyway; run it again). [verified 2026-11-24: after revoking the old agy key the doctor's agy probe failed with 401 until the config held the new key; `closed: mcp 0, wake 0` was printed because nothing was open.]
- A lost key cannot be shown again: create a new one and revoke the old one.
- Admin actions are audited (`key_created`, `key_rotated`, `key_revoked`) with the operating-system user that ran the command; no secret is in any row.

## 12. The review procedure for held remote tasks

Tasks from a `remote-peer` key are held for a human. They never reach a session until you release them, one task at a time, on a terminal. There is no batch form, no `--yes` and no "release all"; the only automatic exit from a held state is expiry to `REJECTED` after `A2A_QUARANTINE_TTL_H` (72 h).

```sh
docker compose exec -T coordination a2a-coord review            # list: id, peer, card, received, size; no body
docker compose exec -it coordination a2a-coord review show <task id>      # the body, inside an untrusted-data frame
docker compose exec -it coordination a2a-coord review release <task id>   # type: release <last 6 characters of the task id>
docker compose exec -it coordination a2a-coord review deny <task id>      # type: deny <last 6 characters of the task id>
```

- The confirmation is read from `/dev/tty`, not stdin. A wrong phrase leaves the task held. `deny` rejects with the reason `denied_by_human`; `release` moves it to `SUBMITTED` for the recipient session.
- `show`, `release` and `deny` refuse without a terminal, and while an agent-session variable (`CLAUDE*`, `ANTIGRAVITY*`, `AGY_*`, `CI`) is set. This is friction against accidents and scripted calls, not proof of a human.
- **Releasing does not approve the content.** The recipient session still decides what to do with the text, which stays framed as untrusted data. Read the body before you release.
- [verified 2026-11-24, throwaway stack: a `remote-peer` key sent a message by REST; it appeared in `review` (no body) and as `held for review: 1` in `status`; `review show` printed the body under the untrusted-data header; a wrong phrase left it held ("nothing was denied"); the exact phrase denied it; `review` then answered "no held tasks". The terminal was a pseudo-terminal allocated by `script`.] `release` itself was verified by the user's hand run of 2026-11-17 ([`../specs/admin.md`](../specs/admin.md) section 11).

## 13. The stage flip to `s3`

**[not built] today.** The procedure below is the plan's (decisions R13 and X5, [`../specs/server-api.md`](../specs/server-api.md) 1.6 and 8.4.1). It cannot be carried out with the shipped compose file and server; the gaps are listed first so nobody discovers them in the middle.

What the code does today:

- `a2a-coord expose check` exists on the command line but is a stub: it prints `a2a-coord: expose check is not available at this stage (S3-EXPOSE-CHECK)` and exits **2** ("could not evaluate"), never 0 [verified 2026-11-24]. Task S3-EXPOSE-CHECK builds it.
- The compose file passes only `A2A_PUBLIC_URL`, `A2A_DEPLOY_HOST`, `A2A_ENV`, `A2A_EXPOSURE_STAGE` and `A2A_ALLOW_WRITES` (plus the database and backup variables) into the server. It does not pass `A2A_ALLOWED_HOSTS`, `A2A_TRUSTED_PROXY_IPS`, `A2A_ENFORCE_TAILNET_IDENTITY` or `A2A_PUBLIC_LISTEN`, and it has no `127.0.0.1:8121` port mapping. An `s2` or `s3` start needs all of these, so the compose file must change first (S2-DEPLOY).
- The server has no 8121 public listener yet (S2-LISTEN) and no real Tailscale identity source (S2-TS). The start-up check requires the listener to be "enabled" at `s2` and `s3`, but nothing binds 8121.
- There is no runtime command to flip the stage, and the stage is never derived from other configuration. That is by design.

The procedure, for when those are built:

1. **Run the read-only check:** `docker compose exec -T coordination a2a-coord expose check`. Exit codes: 0 all conditions met; 1 at least one unmet (an itemised report); 2 could not evaluate (admin socket unreachable or database error). The server checks: quarantine is enforced for `remote-peer` keys; per-key rate limits and the guess counter are enabled; `dump_age_h` is below 36 (null counts as unmet); port 8121 is bound to host loopback only. **Manual items** the command lists and you confirm yourself: the fuzz report is green, the Agent Card is honest (declares only what is on), the extension URI is fixed.
2. **Change the compose environment** (on the host, by hand): `A2A_EXPOSURE_STAGE=s3`, the public host added to `A2A_ALLOWED_HOSTS`, `A2A_PUBLIC_URL=https://<a2a-host>`, and (from `s2`) `A2A_TRUSTED_PROXY_IPS` and `A2A_ENFORCE_TAILNET_IDENTITY=1`. Then `docker compose build coordination` and the recreate of section 4.
3. **The server's `s3` start-up checks run.** It refuses to start, with one line naming the variable, when: the public URL is not `https://`; trusted proxies are empty; the public listener is not enabled; tailnet identity enforcement is off; the public host is in `A2A_ALLOWED_HOSTS` before `s3`. Read `docker compose logs coordination` if it does not become healthy.
4. **Only then create the route** (the Cloudflare Tunnel to `127.0.0.1:8121`), on your explicit decision. `expose check` never creates it. No route may exist before the S3 gate passes, and the service must never be started while an early route is present. A test route must sit behind a Cloudflare Access deny-all or service-token-only policy.

Until this exists, **stay on `s1`** (workstation) and keep the port on host loopback.

## 14. Kill switches per stage

Pick the smallest switch that does the job. All of these leave the database and its backups untouched unless stated.

**Stage `s1` (workstation, loopback only):**

| Switch | Effect | How |
| --- | --- | --- |
| Revoke one key | That machine's harness is refused at once (401); its MCP sessions and parked listeners close | `a2a-coord key revoke <key id>` [verified 2026-11-24] |
| Stop the server | Nothing reaches the service; hooks fail quietly and add no model delay beyond their short curl limits; tasks wait in Postgres | `docker compose stop coordination` [verified 2026-11-24: the doctor then reported `FAIL ... no answer`; `up -d --no-build coordination` brought it back] |
| Stop everything | As above, and Postgres too; data kept | `docker compose down` (never `down -v`) |
| Turn off the write tools | The MCP tools `a2a_send`, `a2a_respond`, `a2a_cancel` are not registered (the default) | `A2A_ALLOW_WRITES=0` and recreate (section 4) |
| One machine's hooks, without touching the server | Claude Code: remove or rename `~/.config/a2a-coord/api-key`; the hooks make no request without it. agy: remove the `a2a-coord` entry from `~/.gemini/config/mcp_config.json` | by hand; for Claude [by the hook specs, verified there; not re-run here] |
| One agy workspace | The agy hooks skip a workspace whose root holds a file named `.a2a-optout`, with no network call | `touch <workspace>/.a2a-optout` [by the agy hook specs; not re-run here] |
| Remove the plugin from a harness | The hooks and the Claude MCP entry go | `claude plugin uninstall coordination@agentic-hub`; `agy plugin uninstall <name>` [unverified: not run; the agy entry in `mcp_config.json` stays and must be removed by hand] |

**Stage `s2` [not built], in addition:** turning off `tailscale serve` on the always-on host leaves the server up on its loopback and makes workstations get connection errors, not data (the plan's drill; not rehearsed). The 8121 listener is on host loopback only, so nothing outside the host reaches it, route or no route, until the route exists.

**Stage `s3` [not built], in addition:** the fastest switch is to **delete the Cloudflare Tunnel route** (the exposure gate is the route); then revoke the `remote-peer` keys (`key list`, scope `remote-peer`, `key revoke` each). To go back to `s2`, set `A2A_EXPOSURE_STAGE=s2` and remove the public host from `A2A_ALLOWED_HOSTS` (the server refuses to start with the public host listed before `s3`), then recreate (section 4). The route-deletion drill is a **[proposal]** in the plan and was not rehearsed.

## 15. Upgrading the pinned A2A SDK

The server pins `a2a-sdk` to an exact version in `servers/coordination/pyproject.toml` (1.3.0 today) because the store sits on the SDK's tables and migrations. A new SDK minor is a deliberate change, about two hours each time (plan section 4). The routine, all **[unverified]** as a whole (it was not done in this stream; each piece is a test or job that exists):

1. Read the SDK's release notes and changelog (`a2aproject/a2a-python` on GitHub) for the versions between the pin and the target: store schema changes, handler behaviour, types.
2. Take a dump of the real database first (section 5): the SDK has its own Alembic revisions, which run at start, and a database migrated by a newer SDK is refused by older code.
3. Change the pin in `pyproject.toml` and run `uv lock` in `servers/coordination`.
4. Run the offline suite: `uv run pytest` there. Tests that need Docker and Postgres run against a pinned Postgres container; set `A2A_TEST_REQUIRE_DOCKER=1` so a missing Docker is a failure, not a skip. The suite includes the migration tests (twice-run, from the oldest SDK revision with data) and the `kill -9` durability test (no acknowledged write lost).
5. Re-run the SP5 load driver on the new pin, as the `pyproject.toml` comment asks (the plan keeps the driver as an on-demand job, a [proposal]); the store regression test `tests/test_store_durability.py` is the part that runs in CI.
6. Run the **A2A TCK** through the allowlist gate ([`../specs/a2a.md`](../specs/a2a.md) section 8): check out `a2aproject/a2a-tck` at the pinned commit, `uv sync --python 3.15` there, then `A2A_TCK_DIR=<checkout> A2A_TCK_REQUIRE=1 A2A_TEST_REQUIRE_DOCKER=1 uv run pytest tests/test_a2a_tck.py tests/test_a2a_tck_gate.py -s` in `servers/coordination` (about two minutes after the environment is built; the first build of the TCK environment compiles `grpcio` and takes much longer). A TCK failure that is not on `tests/tck/allowlist.yaml` blocks; so does an allowlist entry that no longer fails (the list must shrink when a deviation is fixed). New deviations need your review.
7. Build, then the recreate of section 4, then `a2a-doctor` and a real task round trip between two live sessions.

## 16. Known limits

- **Interactive CLI only.** Claude Code is woken only in an interactive terminal session. `claude -p`, IDE and desktop sessions are not woken [reported].
- **The Esc gap.** `Stop` does not fire when Esc interrupts a turn, so a session whose turn was interrupted has no wake listener until its next turn ends or the next prompt. The plugin re-arms the listener from a `UserPromptSubmit` hook; whether Claude Code honours `asyncRewake` on that hook is **[unverified]** (a live check, L3 in [`../specs/claude-hooks.md`](../specs/claude-hooks.md) section 9). Tasks stay queued on the server in the meantime.
- **agy has no idle wake.** A pending task shows at agy's next model call (the `PreInvocation` hook), at session start (the injected instruction) and on demand (`a2a_wait`). An agy session left idle is not woken. This asymmetry is accepted.
- **Binding is an assertion by a key holder.** A session binds to a handle by presenting a key; the server cannot tell two sessions sharing one key apart other than by the handle they assert, and `a2a_hello(handle)` lets a key holder claim any handle of its card. It is not authentication of a session.
- **Tasks are parked, never executed.** The server does not run, drive or message any harness.
- **Wake budget.** At most 20 wakes per handle per hour (`A2A_WAKE_BUDGET_PER_H`); past that, tasks wait for the next turn.
- **One server process, one worker, one workstation at stage s1.** Sessions on two machines need stage `s2`, which is not built.
- **The dump is a nightly snapshot.** Up to about a day of tasks can be lost on a total failure of the volume; there is no point-in-time restore.
- **No public exposure is available.** The stage flip, the 8121 listener, `expose check` and Tailscale identity are not built (section 13).

## 17. Still unverified

What no run covered, so far as this runbook and the specs it rests on go:

- Any behaviour of Claude Code or agy against this server: the harness install commands, `asyncRewake` on `UserPromptSubmit`, a GUI-launched Claude's MCP expansion of `A2A_API_KEY`, agy installing a plugin from a GitHub tree URL, the working directory of an installed agy plugin's hooks, `"type": "http"` in agy's global MCP file, `agy plugin validate --strict`.
- The second restic job on the always-on host, and `restic` itself.
- A Postgres upgrade, and a restore into the real stack's volume.
- Rotation of the server's database password.
- The stage flip, `expose check`, the 8121 listener, Tailscale identity, the Cloudflare route.
- The SDK upgrade routine as a whole, and the SP5 driver.
- The doctor and the hook scripts on macOS (BSD `stat`, `sed`, `tr`) [by the doctor spec].
