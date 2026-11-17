"""What happens, besides the database write, when a session ends (S1-ID; spec 3.5, 5.5).

`POST /sessions/end` must close the session's parked `/wake/listen` request with `410`. The parked
listener table is S1-WAKE's and does not exist in this stream, so this module is a small registry
WAKE plugs into, the same shape as `coordination.admin.hooks` (the key-revoke hand-over):

    app.state.identity.end_hooks.register("wake", table.close_session)

`close_session(handle)` answers every parked request of that handle with `410` and returns how many
it closed. A hook takes the handle and returns a number (or None); it may be a plain function or a
coroutine function. A hook that raises does not undo the end (the row is already ended and every
later call by that session is refused): the failure is logged and counted in the report.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

log = logging.getLogger("coordination.identity")

#: `fn(handle)`; returns how many things it closed.
SessionEndHook = Callable[[str], "int | None | Awaitable[int | None]"]


@dataclass(frozen=True)
class EndReport:
    """What the hooks did for one ended session: `closed` by hook name, and `failed` hook names."""

    closed: dict[str, int] = field(default_factory=dict)
    failed: list[str] = field(default_factory=list)

    @property
    def total_closed(self) -> int:
        return sum(self.closed.values())


class SessionEndHooks:
    def __init__(self) -> None:
        self._hooks: dict[str, SessionEndHook] = {}

    def register(self, name: str, hook: SessionEndHook) -> None:
        """Add (or replace) the hook called `name`."""
        self._hooks[name] = hook

    def names(self) -> list[str]:
        return list(self._hooks)

    async def fire(self, handle: str) -> EndReport:
        closed: dict[str, int] = {}
        failed: list[str] = []
        for name, hook in list(self._hooks.items()):
            try:
                result = hook(handle)
                if inspect.isawaitable(result):
                    result = await result
            except Exception as exc:  # noqa: BLE001 - one broken hook must not skip the others
                log.error("session end hook failed", extra={"fields": {"hook": name, "error": type(exc).__name__}})
                failed.append(name)
                continue
            closed[name] = int(result or 0)
        return EndReport(closed, failed)
