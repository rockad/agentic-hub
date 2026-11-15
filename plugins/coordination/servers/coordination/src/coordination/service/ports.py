"""Interfaces the service layer needs from streams that do not exist yet.

The parked-listener table lives in process memory and belongs to S2-LISTEN / S1-WAKE (spec 7.2).
The state machine only has to ask it two questions, so it takes this narrow port, and a test (or
a server that has no listeners yet) passes `NoListeners`. Both methods are synchronous: the table
is a dict in memory.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ListenerView(Protocol):
    def is_listening(self, handle: str) -> bool:
        """A parked `/wake/listen` request exists for this handle (liveness `listening`)."""
        ...

    def newest_listening(self, card_id: str) -> str | None:
        """The handle of the newest parked listener under this card, or None."""
        ...


class NoListeners:
    """The listener table before WAKE exists: nobody is ever listening."""

    def is_listening(self, handle: str) -> bool:
        return False

    def newest_listening(self, card_id: str) -> str | None:
        return None
