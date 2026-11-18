"""The listener table: one parked `/wake/listen` request per handle, in process memory (spec 7.2).

- Newest wins. A new listener for a handle ends the old one with `409 superseded` and takes its
  place.
- `close_key(key_id)` answers every parked request that key parked with `403` (the revoke hook of
  `coordination.admin.hooks`; spec 7.2).
- `close_session(handle)` answers a handle's parked request with `410 ended` (the session-end hook
  of `coordination.identity.hooks`).
- `begin_shutdown()` answers every parked request `503` with `Retry-After: 5` and refuses new
  ones (SIGTERM).

The table also is the `ListenerView` the service layer, the MCP tools and `GET /sessions` read for
the `listening` liveness state, so one table serves all of them. Every method is synchronous: a
dict in memory, no await between a read and the write that depends on it, so nothing here needs a
lock. Single worker only (spec 1.1).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from coordination.wake.outcomes import ENDED, KEY_REVOKED, SHUTDOWN, SUPERSEDED, Release


@dataclass(eq=False)
class Parked:
    """One parked request. `future` is resolved exactly once, with the `Release` that ends it."""

    handle: str
    card_id: str
    key_id: str
    seq: int
    future: asyncio.Future[Release]
    #: Serialises wake decisions for this listener, so two tasks arriving together cannot both
    #: write a wake row for one parked request.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def done(self) -> bool:
        return self.future.done()

    def release(self, outcome: Release) -> bool:
        """End this listener with `outcome`. False if it had already ended."""
        if self.future.done():
            return False
        self.future.set_result(outcome)
        return True


class ListenerTable:
    def __init__(self) -> None:
        self._by_handle: dict[str, Parked] = {}
        self._seq = 0
        self._closing = False

    # -- the parked requests ---------------------------------------------------------------

    @property
    def closing(self) -> bool:
        """True once shutdown began: no new listener may park."""
        return self._closing

    def park(self, handle: str, card_id: str, key_id: str) -> Parked:
        """Park a new listener for `handle`. An older one for the same handle is ended with
        `409 superseded`. Must be called on the event loop."""
        self._seq += 1
        entry = Parked(handle, card_id, key_id, self._seq, asyncio.get_running_loop().create_future())
        old = self._by_handle.get(handle)
        self._by_handle[handle] = entry
        if old is not None:
            old.release(SUPERSEDED)
        return entry

    def remove(self, entry: Parked) -> None:
        """Forget `entry`, but only if it is still the table's entry for its handle (a newer
        listener may have replaced it)."""
        if self._by_handle.get(entry.handle) is entry:
            del self._by_handle[entry.handle]

    def get(self, handle: str) -> Parked | None:
        """The live parked listener of `handle`, or None."""
        entry = self._by_handle.get(handle)
        return entry if entry is not None and not entry.done else None

    def __len__(self) -> int:
        return sum(1 for e in self._by_handle.values() if not e.done)

    def count(self) -> int:
        """Parked listeners now (the `listeners.parked` figure of the admin `status`)."""
        return len(self)

    # -- ListenerView (service layer, MCP tools, GET /sessions) -----------------------------

    def is_listening(self, handle: str) -> bool:
        return self.get(handle) is not None

    def newest_listening(self, card_id: str) -> str | None:
        newest: Parked | None = None
        for entry in self._by_handle.values():
            if entry.card_id == card_id and not entry.done and (newest is None or entry.seq > newest.seq):
                newest = entry
        return newest.handle if newest is not None else None

    # -- closing ---------------------------------------------------------------------------

    def close_key(self, key_id: str) -> int:
        """Revoke hook: answer every listener this key parked with `403`. Returns how many."""
        return sum(1 for e in list(self._by_handle.values()) if e.key_id == key_id and e.release(KEY_REVOKED))

    def close_session(self, handle: str) -> int:
        """Session-end hook: answer the handle's listener with `410 ended`. Returns how many."""
        entry = self._by_handle.get(handle)
        return 1 if entry is not None and entry.release(ENDED) else 0

    def close_all(self, outcome: Release) -> int:
        return sum(1 for e in list(self._by_handle.values()) if e.release(outcome))

    def begin_shutdown(self) -> int:
        """SIGTERM: refuse new listeners and answer every parked one `503` with `Retry-After: 5`."""
        self._closing = True
        return self.close_all(SHUTDOWN)
