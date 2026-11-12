"""`a2a-coord` command line.

Admin commands (key, review, status, card check, install) are added by S1-ADMIN and S1-INST.
S1-PG adds `db init-dump-role`, a host command that talks to Docker, not to the admin socket.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Mapping, Sequence

from coordination import __version__
from coordination import db_admin


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="a2a-coord", description="A2A coordination server admin")
    parser.add_argument("--version", action="version", version=f"a2a-coord {__version__}")
    sub = parser.add_subparsers(dest="command")

    db = sub.add_parser("db", help="database commands (host side, through docker compose)")
    db_sub = db.add_subparsers(dest="db_command", required=True)
    init = db_sub.add_parser(
        "init-dump-role",
        help="create or refresh the read-only dump_ro role from the pg_dump_password file",
        description=(
            "Idempotent. Reads pg_dump_password on the host and feeds SQL to psql in the postgres "
            "container over stdin (docker compose exec -T). Safe on a fresh volume, an existing "
            "volume and after a rotation."
        ),
    )
    init.add_argument("--secrets-dir", help="directory holding pg_dump_password (default: $A2A_SECRETS_DIR, else ~/.config/a2a-coord/secrets)")
    init.add_argument("--compose-file", help="compose file of the stack (default: $A2A_COMPOSE_FILE, else the plugin's docker-compose.yml)")
    init.add_argument("-p", "--project", help="compose project name (default: $A2A_COMPOSE_PROJECT, else $COMPOSE_PROJECT_NAME, else coordination)")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    runner: db_admin.Runner = db_admin.subprocess_runner,
) -> int:
    environ = os.environ if environ is None else environ
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "db" and args.db_command == "init-dump-role":
        try:
            line = db_admin.init_dump_role(
                compose_file=db_admin.default_compose_file(environ, args.compose_file),
                project=db_admin.default_project(environ, args.project),
                secrets_dir=db_admin.default_secrets_dir(environ, args.secrets_dir),
                environ=environ,
                runner=runner,
            )
        except db_admin.InitDumpRoleError as exc:
            print(f"a2a-coord: {exc}", file=sys.stderr)
            return 1
        print(line)
        return 0
    parser.print_help()
    return 0
