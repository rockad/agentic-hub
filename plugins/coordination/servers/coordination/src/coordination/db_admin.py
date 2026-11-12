"""`a2a-coord db init-dump-role`: create or refresh the read-only `dump_ro` Postgres role.

A host command (spec 1.2, round-4 X2), not an admin-socket command. It reads the `dump_ro`
secret file on the host and feeds SQL to `psql` in the Postgres container over STDIN with
`docker compose exec -T`. The password value therefore never appears in an argv, in the compose
file, in the container's environment or in a message. The file is not mounted into Postgres.

One mechanism covers a fresh volume, an existing volume and a rotation: the role is created if
it is absent, its password is always set from the file, and `pg_read_all_data` is granted.
Every run ends the same way, so it is safe to repeat.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

DUMP_ROLE = "dump_ro"
SECRET_FILE = "pg_dump_password"
SERVICE = "postgres"
DB_USER = "coordination"  # POSTGRES_USER in docker-compose.yml
DB_NAME = "coordination"  # POSTGRES_DB in docker-compose.yml
SERVER_SECRET_IN_CONTAINER = "/run/secrets/a2a_db_password"
DEFAULT_PROJECT = "coordination"  # the `name:` in docker-compose.yml


class InitDumpRoleError(RuntimeError):
    """The command failed. The message never contains the dump_ro password."""


@dataclass(frozen=True)
class RunResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


#: (argv, stdin text, environment) -> result. Tests pass a fake.
Runner = Callable[[Sequence[str], str, Mapping[str, str]], RunResult]


def subprocess_runner(argv: Sequence[str], stdin: str, env: Mapping[str, str]) -> RunResult:
    proc = subprocess.run(
        list(argv), input=stdin, capture_output=True, text=True, env=dict(env), check=False
    )
    return RunResult(proc.returncode, proc.stdout, proc.stderr)


def default_secrets_dir(environ: Mapping[str, str], flag: str | None = None) -> Path:
    """`--secrets-dir`, else `A2A_SECRETS_DIR`, else `~/.config/a2a-coord/secrets`."""
    if flag:
        return Path(flag).expanduser()
    if environ.get("A2A_SECRETS_DIR"):
        return Path(environ["A2A_SECRETS_DIR"]).expanduser()
    return Path.home() / ".config" / "a2a-coord" / "secrets"


def default_compose_file(environ: Mapping[str, str], flag: str | None = None) -> Path:
    """`--compose-file`, else `A2A_COMPOSE_FILE`, else the plugin's own file in a source
    checkout, else `docker-compose.yml` in the current directory."""
    if flag:
        return Path(flag).expanduser()
    if environ.get("A2A_COMPOSE_FILE"):
        return Path(environ["A2A_COMPOSE_FILE"]).expanduser()
    up = Path(__file__).resolve().parents  # coordination, src, servers/coordination, servers, plugin root
    in_checkout = up[4] / "docker-compose.yml" if len(up) > 4 else None
    return in_checkout if in_checkout and in_checkout.is_file() else Path("docker-compose.yml")


def default_project(environ: Mapping[str, str], flag: str | None = None) -> str:
    """`--project`, else `A2A_COMPOSE_PROJECT`, else `COMPOSE_PROJECT_NAME`, else `coordination`."""
    return flag or environ.get("A2A_COMPOSE_PROJECT") or environ.get("COMPOSE_PROJECT_NAME") or DEFAULT_PROJECT


def read_secret(path: Path) -> str:
    """The password from the file; trailing newlines stripped, as the Postgres entrypoint does."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise InitDumpRoleError(f"cannot read {path}: {exc.strerror or type(exc).__name__}") from None
    try:
        value = raw.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError:
        raise InitDumpRoleError(f"{path} is not UTF-8") from None
    if not value:
        raise InitDumpRoleError(f"{path} is empty")
    if "\x00" in value:
        raise InitDumpRoleError(f"{path} contains a NUL byte")
    return value


def sql_literal(value: str) -> str:
    """A SQL string literal. Correct under `standard_conforming_strings = on`, which `build_sql`
    sets first: the only character that needs escaping is the single quote, doubled."""
    return "'" + value.replace("'", "''") + "'"


def build_sql(password: str) -> str:
    """The whole stdin payload. Idempotent: any number of runs leaves the same state."""
    return "\n".join(
        [
            # Keep the statement with the password out of the server log, also if it fails.
            "SET log_statement = 'none';",
            "SET log_min_duration_statement = -1;",
            "SET log_min_error_statement = 'panic';",
            "SET standard_conforming_strings = on;",
            f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{DUMP_ROLE}') "
            f"THEN CREATE ROLE {DUMP_ROLE} LOGIN; END IF; END $$;",
            f"ALTER ROLE {DUMP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION "
            f"PASSWORD {sql_literal(password)};",
            f"GRANT pg_read_all_data TO {DUMP_ROLE};",
            "",
        ]
    )


def compose_argv(compose_file: Path, project: str) -> list[str]:
    """`docker compose ... exec -T postgres sh -c '<psql with the server password>'`.

    psql must log in (no trust authentication anywhere). The server password is read from the
    secret that is mounted in the container, by the shell in the container, and handed to psql
    in its own environment: it is in no argv and does not leave the container.
    """
    script = (
        f'PGPASSWORD="$(cat {SERVER_SECRET_IN_CONTAINER})" '
        f"exec psql -X -q -v ON_ERROR_STOP=1 -U {DB_USER} -d {DB_NAME}"
    )
    return [
        "docker", "compose", "-f", str(compose_file), "-p", project,
        "exec", "-T", SERVICE, "sh", "-c", script,
    ]  # fmt: skip


def redact(text: str, password: str) -> str:
    """Make psql's error text safe to show.

    psql repeats the failing statement (`LINE 1: ...`, then a caret line), possibly cut in the
    middle of the password, so those two kinds of line are dropped; the password is also
    removed, raw and as a SQL literal body, from whatever is left.
    """
    kept = [
        line
        for line in text.splitlines()
        if not re.match(r"\s*LINE \d+:", line) and not re.fullmatch(r"\s*\^\s*", line)
    ]
    text = "\n".join(kept)
    for needle in (sql_literal(password)[1:-1], password):
        if needle:
            text = text.replace(needle, "***")
    return text


def init_dump_role(
    *,
    compose_file: Path,
    project: str,
    secrets_dir: Path,
    environ: Mapping[str, str] | None = None,
    runner: Runner = subprocess_runner,
    warn: Callable[[str], None] = lambda m: print(m, file=sys.stderr),
) -> str:
    """Run the command. Returns the success line, which carries no secret."""
    environ = os.environ if environ is None else environ
    secret_path = secrets_dir / SECRET_FILE
    password = read_secret(secret_path)
    mode = stat.S_IMODE(secret_path.stat().st_mode)
    if mode & 0o077:
        warn(f"warning: {secret_path} is mode {mode:04o}; it should be 0600")
    if not compose_file.is_file():
        raise InitDumpRoleError(f"compose file not found: {compose_file} (use --compose-file or A2A_COMPOSE_FILE)")

    # Compose reads the file secrets of the project even for `exec`, so it must see the same directory.
    env = {**environ, "A2A_SECRETS_DIR": str(secrets_dir)}
    result = runner(compose_argv(compose_file, project), build_sql(password), env)
    if result.returncode != 0:
        detail = redact(result.stderr, password).strip() or "no error output"
        raise InitDumpRoleError(
            f"docker compose exec psql failed (exit {result.returncode}); is the {SERVICE} service up "
            f"and healthy in project {project!r}?\n{detail}"
        )
    return f"{DUMP_ROLE}: role ready, password set from {secret_path.name}, pg_read_all_data granted"
