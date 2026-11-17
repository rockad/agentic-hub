"""What happens, besides the database write, when a key is revoked (S1-ADMIN; spec 3.7, 8.3).

Revoking a key must also end the live connections it holds: its MCP sessions at once, and its
parked `/wake/listen` request (which answers `403`). The two live in memory in other streams, so
this module is a small registry they plug into:

- S1-MCP registered `McpSessions.drop_key` (`build_server_app` does the wiring).
- `/wake/listen` does not exist yet (S1-WAKE). **The parked-listener half is handed to WAKE:** when
  it builds the listener table it registers a hook here, `hooks.register("wake", table.close_key)`,
  that releases every parked request of the key with `403`. Nothing in this stream parks or closes
  a listener.

A hook takes the key id and returns the number of things it closed (or None); it may be a plain
function or a coroutine function. A hook that raises does not undo the revocation (the key is
already refused by the access-control middleware, which reads the database on every request): the
failure is logged and reported to the admin, who can run the command again.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

log = logging.getLogger("coordination.admin")

RevokeHook = Callable[[str], "int | None | Awaitable[int | None]"]


@dataclass(frozen=True)
class RevokeReport:
    """What the hooks did for one revocation: `closed` by hook name, and `failed` hook names."""

    closed: dict[str, int] = field(default_factory=dict)
    failed: list[str] = field(default_factory=list)


class RevokeHooks:
    def __init__(self) -> None:
        self._hooks: dict[str, RevokeHook] = {}

    def register(self, name: str, hook: RevokeHook) -> None:
        """Add (or replace) the hook called `name`."""
        self._hooks[name] = hook

    def names(self) -> list[str]:
        return list(self._hooks)

    async def fire(self, key_id: str) -> RevokeReport:
        closed: dict[str, int] = {}
        failed: list[str] = []
        for name, hook in list(self._hooks.items()):
            try:
                result = hook(key_id)
                if inspect.isawaitable(result):
                    result = await result
            except Exception as exc:  # noqa: BLE001 - one broken hook must not skip the others
                log.error("revoke hook failed", extra={"fields": {"hook": name, "error": type(exc).__name__}})
                failed.append(name)
                continue
            closed[name] = int(result or 0)
        return RevokeReport(closed, failed)
