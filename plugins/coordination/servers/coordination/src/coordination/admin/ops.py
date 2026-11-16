"""The command table of the admin socket (S1-ADMIN): one place that maps a command name to the code
that runs it, and turns every failure into a short, safe `AdminError`.

There is no command here that releases tasks in bulk, no flag that skips the typed phrase and no
`admin` HTTP anything: the socket is the only caller, and `COMMANDS` in `protocol` is the whole
list. `expose check` and `admin-apply` are not commands yet (S3-EXPOSE-CHECK, GL-IMPORT).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from coordination.admin.keyadmin import KeyAdmin
from coordination.admin.protocol import COMMANDS, AdminError
from coordination.admin.review import ReviewAdmin
from coordination.admin.status import StatusAdmin
from coordination.audit.events import AuditError
from coordination.service.errors import ServiceError

log = logging.getLogger("coordination.admin")

Handler = Callable[[Mapping[str, Any], str], Awaitable[dict[str, Any]]]


class AdminOps:
    def __init__(self, keys: KeyAdmin, review: ReviewAdmin, status: StatusAdmin) -> None:
        async def key_list(_args: Mapping[str, Any], _actor: str) -> dict[str, Any]:
            return await keys.list_keys()

        async def review_list(_args: Mapping[str, Any], _actor: str) -> dict[str, Any]:
            return await review.list_held()

        async def review_show(args: Mapping[str, Any], _actor: str) -> dict[str, Any]:
            return await review.show(args)

        async def status_(_args: Mapping[str, Any], _actor: str) -> dict[str, Any]:
            return await status.status()

        async def card_check(_args: Mapping[str, Any], _actor: str) -> dict[str, Any]:
            return await status.card_check()

        self._handlers: dict[str, Handler] = {
            "key.create": keys.create,
            "key.list": key_list,
            "key.rotate": keys.rotate,
            "key.revoke": keys.revoke,
            "review.list": review_list,
            "review.show": review_show,
            "review.release": review.release,
            "review.deny": review.deny,
            "status": status_,
            "card.check": card_check,
        }
        assert set(self._handlers) == set(COMMANDS), "the command table and protocol.COMMANDS differ"

    async def run(self, cmd: str, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        """Run one command. Raises `AdminError` for every failure; nothing else escapes."""
        handler = self._handlers.get(cmd)
        if handler is None:
            raise AdminError("unknown_command", f"unknown command {cmd[:40]!r}")
        try:
            return await handler(args, actor)
        except AdminError:
            raise
        except ServiceError as exc:
            raise AdminError(exc.code, str(exc) or exc.code) from None
        except AuditError:
            raise AdminError("audit_failed", "the audit row was refused") from None
        except (SQLAlchemyError, OSError) as exc:
            log.error("admin command hit a database error", extra={"fields": {"cmd": cmd, "error": type(exc).__name__}})
            raise AdminError("unavailable", "the database did not answer") from None
        except Exception as exc:  # noqa: BLE001 - the socket must answer; the detail stays in the log
            log.error("admin command failed", extra={"fields": {"cmd": cmd, "error": type(exc).__name__}})
            raise AdminError("internal", "the command failed; see the server log") from None
