"""Who is calling: the `Mcp-Session-Id` map (Claude Code) and, for agy, the durable registry.

Two identity paths, never mixed (spec 5.4 and 5.4.1):

- **Claude Code and every other client that is not agy.** The server issues an `Mcp-Session-Id` at
  `initialize` and keeps `mcp_session_id -> (key_id, handle)` in memory (`McpSessions`). The handle
  is set by `a2a_hello`; one handle is bound to one `Mcp-Session-Id` at a time, the newest
  `a2a_hello` takes it (`unbind_others`, decision Z17). A restart loses the map; the client then gets 404, re-initialises, and its
  first identity-bound call returns the constant "Not bound. Call a2a_hello." The map is also tied
  to the API key: a request that carries key B's bearer and key A's session id is refused 403
  (SP5 D12 finding 1; the `mcp` SDK did not do this and a hand-written server must).
- **agy.** Identity is the conversation id the client puts in `params._meta` on every `tools/call`,
  read only for a `local-harness` key whose card is an `antigravity@` card, and only matched
  against sessions of that same card. It is mapped through the durable `sessions` table, with the
  conversation id stored as `harness_session_id`, so a restart loses nothing. `Mcp-Session-Id` is
  never used for agy identity.

What lives where since S1-ID: the durable registry (`SessionRegistry`), the handle grammar and the
registration and conversation-binding logic moved to `coordination.identity` (the registry is the
class S1-MCP built here, extended, not a second one). This module keeps only the in-memory
`Mcp-Session-Id` map, and re-exports the moved names so existing imports keep working.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass

from coordination.clock import Clock
from coordination.identity.errors import HandleCollision
from coordination.identity.handles import (
    AGY_CONVERSATION_KEY,
    AGY_HARNESS,
    AGY_PARENT_KEY,
    AGY_ROOT_KEY,
    MAX_NAME,
    SESSION_ID_RE,
    build_handle,
    derive_name,
    is_agy_card,
    sid8_of,
    valid_session_id,
)
from coordination.identity.registry import TOUCH_RESOLUTION, CardInfo, PeerSession, SessionRegistry

#: The in-memory map is bounded: a client that never sends `DELETE` (Claude Code) would grow it.
MAX_MCP_SESSIONS = 4096

__all__ = [
    "AGY_CONVERSATION_KEY",
    "AGY_HARNESS",
    "AGY_PARENT_KEY",
    "AGY_ROOT_KEY",
    "MAX_MCP_SESSIONS",
    "MAX_NAME",
    "SESSION_ID_RE",
    "TOUCH_RESOLUTION",
    "CardInfo",
    "HandleCollision",
    "McpSession",
    "McpSessions",
    "PeerSession",
    "SessionRegistry",
    "build_handle",
    "derive_name",
    "is_agy_card",
    "sid8_of",
    "valid_session_id",
]


@dataclass
class McpSession:
    session_id: str
    key_id: str
    card_id: str
    created_m: float
    last_seen_m: float
    handle: str | None = None  # set by `a2a_hello`; never set for agy


class McpSessions:
    """`Mcp-Session-Id` to (key id, handle), in process memory (spec 3.4).

    Entries idle longer than `idle_ttl_s` are dropped; the client then gets 404 and the normal
    "Not bound" recovery. Dropped lazily, on `create`.
    """

    def __init__(self, clock: Clock, *, idle_ttl_s: float, max_sessions: int = MAX_MCP_SESSIONS) -> None:
        self._clock = clock
        self._idle_ttl_s = idle_ttl_s
        self._max = max_sessions
        self._by_id: OrderedDict[str, McpSession] = OrderedDict()

    def __len__(self) -> int:
        return len(self._by_id)

    def create(self, session_id: str, key_id: str, card_id: str) -> McpSession:
        self._expire()
        while len(self._by_id) >= self._max:
            self._by_id.popitem(last=False)  # the least recently used
        now = self._clock.monotonic()
        session = McpSession(session_id, key_id, card_id, created_m=now, last_seen_m=now)
        self._by_id[session_id] = session
        return session

    def get(self, session_id: str) -> McpSession | None:
        """The live session, or None if unknown or idle past the TTL. A use refreshes it."""
        session = self._by_id.get(session_id)
        if session is None:
            return None
        now = self._clock.monotonic()
        if now - session.last_seen_m > self._idle_ttl_s:
            del self._by_id[session_id]
            return None
        session.last_seen_m = now
        self._by_id.move_to_end(session_id)
        return session

    def remove(self, session_id: str) -> bool:
        return self._by_id.pop(session_id, None) is not None

    def unbind_others(self, handle: str, card_id: str, keep_session_id: str) -> list[str]:
        """Drop `handle` from every other live `Mcp-Session-Id` of `card_id` that holds it, and
        return their ids (decision Z17: the newest `a2a_hello` wins). The sessions stay in the map;
        their next identity-bound call finds them unbound ("Not bound. Call a2a_hello."). An entry
        idle past the TTL is not live and is dropped, not reported."""
        now = self._clock.monotonic()
        dropped: list[str] = []
        for sid, s in list(self._by_id.items()):
            if sid == keep_session_id or s.handle != handle or s.card_id != card_id:
                continue
            if now - s.last_seen_m > self._idle_ttl_s:
                del self._by_id[sid]
                continue
            s.handle = None
            dropped.append(sid)
        return dropped

    def drop_key(self, key_id: str) -> int:
        """Forget every session of a key (S1-ADMIN calls this when it revokes one)."""
        gone = [sid for sid, s in self._by_id.items() if s.key_id == key_id]
        for sid in gone:
            del self._by_id[sid]
        return len(gone)

    def _expire(self) -> None:
        now = self._clock.monotonic()
        stale = [sid for sid, s in self._by_id.items() if now - s.last_seen_m > self._idle_ttl_s]
        for sid in stale:
            del self._by_id[sid]
