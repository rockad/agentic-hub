# Runbook: backup and restore of the coordination database

Stream S1-BKP of the implementation plan (decision 37; round-2 R4 to R6; round-3 R9, R11, R12, R14). Values in angle brackets are placeholders: `<workstation>` is the dev box, `<storage-host>` the always-on host, `<media-root>` its storage root, `<gdrive-remote>` the rclone remote name.

## What is backed up

- **The dump is the backup.** A nightly `pg_dump -Fc` (custom format) of the whole `coordination` database: every schema and table, one consistent snapshot, taken by the sidecar container `dump` as the read-only role `dump_ro`.
- **Loss window: up to about one day.** The dump runs once a night (default 02:00 in the sidecar's time zone), so a failure just before the next dump loses what was written since the previous one. WAL archiving and point-in-time restore are not adopted.
- **A copy of the Postgres data directory is not a backup.** Copying the `a2a-pgdata` volume (or `/var/lib/postgresql/data`) from a running container gives a torn, possibly unrestorable copy. Only the dump files count.
- **The `a2a-data` volume is out of backup scope.** It holds go-live import run artefacts only (`/data/imports/<run_id>/`), not the database.
- **Not in the dump:** the secret files, the compose project, the images. Those come from the host (secrets directory) and the repo.

## Where things are

| What | Where |
| --- | --- |
| Dump files | the host directory `A2A_DUMP_DIR`. Default `~/.local/share/a2a-coord/dumps` (dev). On `<storage-host>`: `<media-root>/backup/a2a/`. Outside the repo. |
| Nightly file name | `a2a-<UTC timestamp>.dump`, for example `a2a-20261112T020000Z.dump` (mode 0600) |
| Go-live snapshot | `pre-import-<run_id>.dump`, written by GL-APPLY, never deleted by the sidecar |
| `last_ok` | one line, the UTC time of the last good dump (`2026-11-12T02:00:00Z`), in the named volume `a2a-backup-state`. The sidecar mounts it read-write at `/state`, the server read-only at `/var/lib/a2a-backup` (`A2A_DUMP_LAST_OK_FILE`) |
| Sidecar log | `docker compose logs dump` |

Create the dump directory first, owned by the user that runs the stack, before the first start (otherwise Docker creates it as root on a rootful host):

```sh
install -d -m 700 ~/.local/share/a2a-coord/dumps     # dev; on <storage-host>: install -d -m 700 <media-root>/backup/a2a
```

Read `last_ok` by hand:

```sh
docker compose exec coordination cat /var/lib/a2a-backup/last_ok
```

## The compose profile

- The `dump` service has `profiles: ["backup"]`. A plain `docker compose up` does not start it and does not need the file `pg_dump_password` (S1 dev on `<workstation>`).
- On `<storage-host>` the stack runs with `COMPOSE_PROFILES=backup` (S2-DEPLOY). **A mis-set profile means backups silently off.** It shows up as `dump_age_h` null or stale (below).
- Prerequisites for the sidecar: the secret file `pg_dump_password` exists (see the server README), and `a2a-coord db init-dump-role` has been run against the running Postgres.
- Settings (all optional): `A2A_DUMP_DIR` (host directory), `A2A_TZ` (time zone of the nightly time, default `UTC`), `A2A_BACKUP_AT` (`HH:MM`, default `02:00`), `A2A_UID` / `A2A_GID` (as for the server: the owner of the 0600 secret file; rootless Docker `0` and `0`).
- One dump right now, for a test or before an upgrade: `docker compose --profile backup run --rm dump once`.
- The sidecar's modes: `loop` (the service's default command: wait for the next 02:00, dump, prune, repeat; a failed dump logs an `ERROR` line and the loop continues), `once` (one dump, exit non-zero on failure, never prunes), `prune` (retention only).

## What a dump does and what failure looks like

1. `pg_dump -Fc` into a temporary file `.a2a-<timestamp>.dump.partial` in the dump directory.
2. Verify: `pg_restore --list`, then a full read of the file with `pg_restore -f /dev/null` (a file cut off after its table of contents passes `--list` but not the full read).
3. Atomic rename to `a2a-<UTC timestamp>.dump`.
4. Only then `last_ok` is written (temp file plus rename).

A failed dump, or a file that fails the verification, removes the partial file, **does not touch `last_ok`**, logs an `ERROR` line (no secret in it) and makes `once` exit non-zero. The loop logs `ERROR dump cycle failed` and tries again at the next scheduled time. `last_ok` then keeps ageing, which is how the stale flag catches it.

## Reading `dump_age_h`

The server derives `dump_age_h` from `last_ok` (`coordination.backup_status`); the `/status` endpoint that reports it comes with a later stream. A number is the age of the last good dump in hours.

- **`null`**: no good dump yet (file absent, empty or unreadable). Expected before the first dump. After that, it means the profile is not on, `init-dump-role` was not run, or the secret is wrong. Check `docker compose logs dump`.
- **Up to 36**: healthy for a nightly dump.
- **Above 36: stale.** One night was missed. Look at `docker compose logs dump` for `ERROR` lines.
- `null` is unknown, not stale; a status display must show it on its own.

## Retention

The sidecar prunes after each good dump in the loop (and on `prune`):

- keeps the newest dump of each of the **14** most recent UTC days that have a dump (daily);
- keeps the first dump of each of the last **3** calendar months, UTC, counted from now (monthly);
- deletes every other `a2a-<UTC timestamp>.dump`;
- **never** touches `pre-import-*.dump` (remove those by hand), nor any other file, nor a name that is not exactly `a2a-YYYYMMDDTHHMMSSZ.dump`.

A failed dump never triggers a prune, so a long outage does not eat the older dumps.

## Restore

Restore into a scratch Postgres first; do this to check a dump and before every upgrade. The scratch container uses the same pinned image as the stack, has no network and no password (it is reachable only by `docker exec`), and never touches the real volume.

```sh
IMAGE=$(docker compose config --format json | jq -r '.services.postgres.image')
docker run -d --name a2a-scratch --network none -e POSTGRES_USER=coordination -e POSTGRES_DB=coordination \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE"
# wait until the log shows "ready to accept connections" twice (the init run, then the real start)
DUMP=a2a-<UTC timestamp>.dump
docker exec -i a2a-scratch pg_restore -U coordination -d coordination --exit-on-error < "$A2A_DUMP_DIR/$DUMP"
docker exec a2a-scratch psql -U coordination -d coordination -c '\dt *.*'   # look around, compare counts
docker rm -f a2a-scratch
```

`pg_restore` must exit 0 (`--exit-on-error` makes any error fatal). Compare row counts against the source only **after writers are stopped**: a dump is a snapshot of one moment, a live database has moved on since.

To restore into the real stack after losing the volume: `docker compose down`, remove the `a2a-pgdata` volume, `docker compose up -d postgres` (a fresh, empty database), run the same `pg_restore` through `docker compose exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/a2a_db_password)" exec pg_restore -U coordination -d coordination --exit-on-error' < "$A2A_DUMP_DIR/$DUMP"`, run `a2a-coord db init-dump-role`, then `docker compose up -d`.

The restore test of this stream does the scratch restore end to end (`servers/backup/restore-test.sh`): it creates synthetic tables `sessions`, `tasks`, `task_index`, `wakes` with foreign keys in a schema of their own in a dev stack, runs a writer while the sidecar takes dump A, restores A into a scratch container (restore exits 0, no foreign-key violation, orphan-task count 0, one consistent snapshot), stops the writer, takes dump B and checks that the restored row counts equal the source counts taken after the writer stopped. Run it only against a dev project, never the live stack:

```sh
COMPOSE_PROJECT_NAME=<dev project> A2A_SECRETS_DIR=... A2A_DUMP_DIR=... sh servers/backup/restore-test.sh
```

## Upgrading Postgres

An upgrade is deliberate: take a dump, change the pinned image and the sidecar's `postgresql17-client` package together (the client's major version must equal the server's), restore the dump into a scratch container of the new image, then upgrade. The sidecar image's base is pinned by tag and digest in `servers/backup/Dockerfile`.

## Rotating the `dump_ro` secret

1. Put a new value in `pg_dump_password` (mode 0600, different from `a2a_db_password`), for example `(umask 077; openssl rand -hex 32 | tr -d '\n' > "$A2A_SECRETS_DIR/pg_dump_password")`.
2. Run `a2a-coord db init-dump-role` again (it sets the role's password from the file; the old password stops working).
3. Restart the sidecar so it reads the file again: `docker compose --profile backup restart dump` (a one-off `run --rm dump once` always reads the current file).

The value is never put in an argument, an environment variable or a log by either step.

## The second restic job (USER-INSTALLED in S2-DEPLOY)

**This section is text only.** S1-BKP does not install anything on `<storage-host>`, and the installer never edits its crontab. The user installs the script and the crontab line in S2-DEPLOY and checks there, read-only, that the job collects the dump directory; the label of that check (verified or not) is recorded in S2-DEPLOY. It is a new job beside the existing knowledge-archive job (05:30), not an addition to it.

Values (placeholders; the real ones are filled in by the user on `<storage-host>`):

- source `<media-root>/backup/a2a/`, tag `a2a-dumps`;
- repository `rclone:<gdrive-remote>:backups/restic-a2a` (its own repository, created once by the user with `restic init`);
- password file `~/.config/a2a-coord/restic-password`, mode 0600, **created by the user**, never in a doc or a repo;
- retention `restic forget --keep-last 3 --prune --tag a2a-dumps`;
- schedule: one user-crontab line `45 5 * * *` in `<storage-host>`'s local time, after the existing 05:30 job and well after the 02:00 dump.

Script `~/.local/share/a2a-coord/<version>/bin/a2a-restic-backup.sh` (never written into the knowledge-archive git repository):

```sh
#!/bin/sh
# a2a-restic-backup.sh: second restic job, collects the a2a dump directory. USER-INSTALLED (S2-DEPLOY).
set -eu
SRC=<media-root>/backup/a2a/
TAG=a2a-dumps
export RESTIC_REPOSITORY=rclone:<gdrive-remote>:backups/restic-a2a
export RESTIC_PASSWORD_FILE="$HOME/.config/a2a-coord/restic-password"

[ -d "$SRC" ] || { echo "ERROR: $SRC is not a directory" >&2; exit 1; }
restic backup "$SRC" --tag "$TAG"
restic forget --keep-last 3 --prune --tag "$TAG"
```

Crontab line (`crontab -e` as the user, after the script is in place and executable):

```
45 5 * * * $HOME/.local/share/a2a-coord/<version>/bin/a2a-restic-backup.sh >> $HOME/.local/share/a2a-coord/a2a-restic.log 2>&1
```

If the server is down, this job's own log is the second check that dumps are still being collected.
