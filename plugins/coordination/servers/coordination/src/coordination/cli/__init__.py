"""`a2a-coord` command line.

Two kinds of command:

- Admin commands (S1-ADMIN): `key create|list|rotate|revoke`, `review [list|show|release|deny]`,
  `status`, `card check`. They run inside the container (`docker compose exec -it coordination
  a2a-coord ...`) and talk to the server over the admin socket (`A2A_ADMIN_SOCKET`, in-container
  Unix socket, mode 0600). There is no network path to it. The terminal rules (`tty`) apply to
  `key create`, `key rotate` and `review show|release|deny`. There is no `--yes`, no batch form,
  no "release all" and no option that skips a prompt.
- Host commands, which do not use the socket: `db init-dump-role` (S1-PG, talks to Docker) and,
  later, `install` (S1-INST).

`expose check` (S3-EXPOSE-CHECK) and `admin-apply` (GL-IMPORT) are named here and answer that they
are not available at this stage; they exit 2 ("could not evaluate"), never 0.

Exit codes: 0 done; 1 refused or failed (the message says why); 2 the server could not be reached,
the command is not available yet, or the arguments are wrong. `card check` follows the same
convention as `expose check`: 0 no problem, 1 at least one problem, 2 could not evaluate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TextIO

from coordination import __version__, db_admin
from coordination.admin.protocol import AdminError, phrase_for
from coordination.cli import render
from coordination.cli.client import AdminClient, Unreachable, UnixClient
from coordination.cli.tty import RealTerminal, Terminal, TtyRefused, confirm, require_real_terminal
from coordination.config import ConfigError, Config

ClientFactory = Callable[[str], AdminClient]

SCOPES = ("local-harness", "remote-peer", "status-client")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="a2a-coord", description="A2A coordination server admin", allow_abbrev=False
    )
    parser.add_argument("--version", action="version", version=f"a2a-coord {__version__}")
    sub = parser.add_subparsers(dest="command")

    def add(name: str, **kwargs: Any) -> argparse.ArgumentParser:
        return sub.add_parser(name, allow_abbrev=False, **kwargs)

    def as_json(p: argparse.ArgumentParser) -> None:
        p.add_argument("--json", action="store_true", help="print the server's answer as JSON")

    # -- key --------------------------------------------------------------------------------
    key = add("key", help="API keys (admin socket; create and rotate need a terminal)")
    key_sub = key.add_subparsers(dest="key_command", required=True)
    create = key_sub.add_parser("create", allow_abbrev=False, help="create a key and print its secret once")
    create.add_argument("--scope", required=True, choices=SCOPES)
    create.add_argument("--agent", required=True, help="owner card (local-harness), peer label (remote-peer) or label (status-client)")
    create.add_argument("--tailnet-node", help="Tailscale node the key is bound to (local-harness; required at stage s2 and s3)")
    create.add_argument("--cards", action="append", help="remote-peer only: card the peer may reach (repeat, or comma-separated)")
    create.add_argument("--expires", required=True, help="lifetime, for example 90d or 36h (ceiling 365d at s1, 90d at s2 and s3)")
    lst = key_sub.add_parser("list", allow_abbrev=False, help="list keys; never prints a secret")
    as_json(lst)
    rotate = key_sub.add_parser("rotate", allow_abbrev=False, help="issue a replacement; the old key ends after the grace period")
    rotate.add_argument("key_id")
    rotate.add_argument("--grace", help="how long the old key keeps working (default 24h; 0h ends it now)")
    rotate.add_argument("--expires", help="lifetime of the replacement (default: the old key's, within the ceiling)")
    revoke = key_sub.add_parser("revoke", allow_abbrev=False, help="revoke a key and close its live connections")
    revoke.add_argument("key_id")

    # -- review -----------------------------------------------------------------------------
    review = add("review", help="held tasks of remote peers (admin socket; show, release and deny need a terminal)")
    as_json(review)
    review_sub = review.add_subparsers(dest="review_command")
    review_list = review_sub.add_parser("list", allow_abbrev=False, help="list held tasks")
    as_json(review_list)
    for name, text in (
        ("show", "show a held task's body inside the untrusted-data frame"),
        ("release", "release one held task to SUBMITTED after a typed phrase"),
        ("deny", "reject one held task (reason denied_by_human) after a typed phrase"),
    ):
        review_sub.add_parser(name, allow_abbrev=False, help=text).add_argument("task_id")

    # -- status, card check, stubs ----------------------------------------------------------
    as_json(add("status", help="sessions, listeners, pending, wake budgets, stale offers, schema"))
    card = add("card", help="Agent Card checks")
    card_sub = card.add_subparsers(dest="card_command", required=True)
    as_json(card_sub.add_parser("check", allow_abbrev=False, help="check the cards file, the cards table and the keys that name cards"))
    expose = add("expose", help="S3 exposure check (not available at this stage)")
    expose.add_subparsers(dest="expose_command", required=True).add_parser("check", allow_abbrev=False)
    add("admin-apply", help="go-live import (not available at this stage)")

    # -- db (host side) ---------------------------------------------------------------------
    db = add("db", help="database commands (host side, through docker compose)")
    db_sub = db.add_subparsers(dest="db_command", required=True)
    init = db_sub.add_parser(
        "init-dump-role",
        allow_abbrev=False,
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


def _cards(values: Sequence[str] | None) -> list[str] | None:
    if not values:
        return None
    return [c.strip() for v in values for c in v.split(",") if c.strip()]


class _Cli:
    """One invocation: the output streams, the terminal, the socket client and the environment."""

    def __init__(
        self,
        environ: Mapping[str, str],
        terminal: Terminal,
        client: AdminClient,
        out: TextIO,
        err: TextIO,
    ) -> None:
        self.environ = environ
        self.terminal = terminal
        self.client = client
        self.out = out
        self.err = err

    def fail(self, message: str, code: int = 1) -> int:
        print(f"a2a-coord: {message}", file=self.err)
        return code

    def run(self, args: argparse.Namespace) -> int:
        try:
            return self._dispatch(args)
        except TtyRefused as exc:
            return self.fail(str(exc))
        except Unreachable as exc:
            return self.fail(str(exc), 2)
        except AdminError as exc:
            # `unavailable` is "could not evaluate" for every command, like `expose check`.
            return self.fail(f"{exc.message} [{exc.code}]", 2 if exc.code == "unavailable" else 1)

    def _dispatch(self, a: argparse.Namespace) -> int:
        if a.command == "key":
            return getattr(self, f"_key_{a.key_command}")(a)
        if a.command == "review":
            return getattr(self, f"_review_{a.review_command or 'list'}")(a)
        if a.command == "status":
            return self._show("status", {}, render.status, a)
        if a.command == "card":
            return self._card_check(a)
        if a.command == "expose" and a.expose_command == "check":
            return self._expose_check(a)
        if a.command == "expose":
            return self.fail("expose check is not available at this stage (S3-EXPOSE-CHECK)", 2)
        if a.command == "admin-apply":
            return self.fail("admin-apply is not available at this stage (GL-IMPORT)", 2)
        raise AssertionError(f"unhandled command {a.command!r}")

    def _show(self, cmd: str, args: dict[str, Any], renderer: Callable[[TextIO, dict[str, Any]], None], a: argparse.Namespace) -> int:
        result = self.client.call(cmd, args)
        if getattr(a, "json", False):
            print(json.dumps(result, indent=2, sort_keys=True), file=self.out)
        else:
            renderer(self.out, result)
        return 0

    # -- key --------------------------------------------------------------------------------

    def _key_create(self, a: argparse.Namespace) -> int:
        require_real_terminal(self.terminal, self.environ, "key create")
        result = self.client.call(
            "key.create",
            {
                "scope": a.scope,
                "agent": a.agent,
                "tailnet_node": a.tailnet_node,
                "cards": _cards(a.cards),
                "expires": a.expires,
            },
        )
        render.key_issued(self.out, result, verb="created")
        return 0

    def _key_list(self, a: argparse.Namespace) -> int:
        return self._show("key.list", {}, render.key_list, a)

    def _key_rotate(self, a: argparse.Namespace) -> int:
        require_real_terminal(self.terminal, self.environ, "key rotate")
        result = self.client.call("key.rotate", {"key_id": a.key_id, "grace": a.grace, "expires": a.expires})
        render.key_issued(self.out, result, verb="rotated")
        return 0

    def _key_revoke(self, a: argparse.Namespace) -> int:
        result = self.client.call("key.revoke", {"key_id": a.key_id})
        closed = ", ".join(f"{name} {n}" for name, n in sorted(result["closed"].items())) or "nothing live to close"
        print(f"key {render.clean(result['key_id'])} revoked; closed: {closed}", file=self.out)
        for name in result["hook_failures"]:
            print(f"warning: the {render.clean(name)} hook failed; run the command again", file=self.err)
        if not result["audited"]:
            print("warning: the audit row could not be written", file=self.err)
        return 0 if not result["hook_failures"] else 1

    # -- review -----------------------------------------------------------------------------

    def _review_list(self, a: argparse.Namespace) -> int:
        return self._show("review.list", {}, render.review_list, a)

    def _review_show(self, a: argparse.Namespace) -> int:
        require_real_terminal(self.terminal, self.environ, "review show")
        result = self.client.call("review.show", {"task_id": a.task_id})
        render.review_show(self.out, result)
        return 0

    def _decide(self, a: argparse.Namespace, action: str, cmd: str, done: str) -> int:
        require_real_terminal(self.terminal, self.environ, f"review {action}")
        # What the human is about to decide on: peer, card and size, never the body.
        held = self.client.call("review.show", {"task_id": a.task_id})
        print(f"task {render.clean(held['task_id'])} from {render.clean(held['peer'])} to {render.clean(held.get('card') or '-')}, {held['size_bytes']} bytes", file=self.out)
        phrase = phrase_for(action, a.task_id)
        if not confirm(self.terminal, f"Type '{phrase}' to {action} this task: ", phrase):
            return self.fail(f"the phrase did not match; nothing was {done}")
        self.client.call(cmd, {"task_id": a.task_id, "phrase": phrase})
        print(f"task {render.clean(a.task_id)} {done}", file=self.out)
        return 0

    def _review_release(self, a: argparse.Namespace) -> int:
        return self._decide(a, "release", "review.release", "released to SUBMITTED")

    def _review_deny(self, a: argparse.Namespace) -> int:
        return self._decide(a, "deny", "review.deny", "denied (REJECTED, denied_by_human)")

    # -- card check -------------------------------------------------------------------------

    def _card_check(self, a: argparse.Namespace) -> int:
        result = self.client.call("card.check", {})
        if a.json:
            print(json.dumps(result, indent=2, sort_keys=True), file=self.out)
        else:
            render.card_check(self.out, result)
        return 0 if result["ok"] else 1

    def _expose_check(self, a: argparse.Namespace) -> int:
        result = self.client.call("expose.check", {})
        if getattr(a, "json", False):
            print(json.dumps(result, indent=2, sort_keys=True), file=self.out)
        else:
            render.expose_check(self.out, result)
        return 0 if result["ok"] else 1


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    runner: db_admin.Runner = db_admin.subprocess_runner,
    terminal: Terminal | None = None,
    client_factory: ClientFactory = UnixClient,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    environ = os.environ if environ is None else environ
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
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
            print(f"a2a-coord: {exc}", file=err)
            return 1
        print(line, file=out)
        return 0
    if args.command is None:
        parser.print_help(out)
        return 0
    try:
        socket_path = Config.from_env(environ).admin_socket
    except ConfigError as exc:
        print(f"a2a-coord: {exc}", file=err)
        return 2
    cli = _Cli(environ, terminal if terminal is not None else RealTerminal(), client_factory(socket_path), out, err)
    return cli.run(args)
