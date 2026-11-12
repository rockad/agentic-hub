# coordination server

The A2A 1.0.1 coordination server of the `coordination` plugin. One Python process, one uvicorn worker, managed with `uv`, shipped as a Docker image. The plugin README and `docs/specs/server-api.md` describe the whole design; this directory holds the code.

Layout under `src/coordination/`:

- `app.py`, `config.py`, `cli.py`, `healthcheck.py`, `clock.py`: the S1-SCAF skeleton.
- `service/`, `store/`, `wake/`: typed protocols (`protocol.py`) that later streams code against.
- `mcp/`, `auth/`: empty packages owned by S1-MCP and S1-AUTH.

Local use:

- `uv sync` then `uv run pytest`.
- `uv run python -m coordination` serves `/healthz` on `A2A_LISTEN` (default `0.0.0.0:8120`).

## Postgres and secrets (S1-PG)

`docker-compose.yml` runs Postgres next to the server (exact image tag plus digest, named volume `a2a-pgdata`, no published port, password auth on every path, no `trust`). The server waits for the database to report healthy, then proves at start-up that `SELECT 1` works, and exits non-zero with a clear message if it cannot connect.

The two secret files live on the host, outside the repo, in one directory (default `~/.config/a2a-coord/secrets`, override with `A2A_SECRETS_DIR`), mode 0700, each file mode 0600:

- `a2a_db_password`: the password of the `coordination` role, read by Postgres (`POSTGRES_PASSWORD_FILE`) and by the server (`A2A_DB_PASSWORD_FILE`). `A2A_DB_URL` carries no password.
- `pg_dump_password`: the password of the read-only `dump_ro` role. It is not mounted into Postgres or the server; the dump sidecar (S1-BKP) will mount it, and `a2a-coord db init-dump-role` reads it on the host.

Create them (the values are never printed or stored anywhere else):

```sh
install -d -m 700 ~/.config/a2a-coord/secrets
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/secrets/a2a_db_password)
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/a2a-coord/secrets/pg_dump_password)
```

The two values must differ. A new password for `a2a_db_password` after the volume exists needs `ALTER ROLE` inside Postgres as well; changing the file alone does not change the role.

Start the stack and create the `dump_ro` role:

```sh
cd plugins/coordination
docker compose up -d --build
cd servers/coordination
uv run a2a-coord db init-dump-role   # idempotent: fresh volume, existing volume, rotation
```

`init-dump-role` takes `--secrets-dir`, `--compose-file` and `-p/--project` (defaults: `A2A_SECRETS_DIR`, the plugin's `docker-compose.yml`, `coordination`). It feeds SQL to `psql` in the Postgres container over stdin (`docker compose exec -T`), so the `dump_ro` password is in no argv, no log and no environment. To rotate, put a new value in `pg_dump_password` and run it again.

Who may read the secret file inside the container:

- Compose outside Swarm bind-mounts a file secret unchanged: the `uid`, `gid` and `mode` of a service secret are ignored. The server must therefore run as the user that owns the 0600 file.
- Rootful Docker: `A2A_UID=$(id -u) A2A_GID=$(id -g) docker compose up -d`.
- Rootless Docker (the host user is container root): `A2A_UID=0 A2A_GID=0 docker compose up -d`.
- The default `10001` is the image's own user and only works for a secret file owned by that uid.
- A failure to read the file names the path and the OS error, never the contents.
