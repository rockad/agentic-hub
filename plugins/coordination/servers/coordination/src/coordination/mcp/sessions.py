"""Who is calling: the `Mcp-Session-Id` map (Claude Code) and the durable registry (agy).

Two identity paths, never mixed (spec 5.4 and 5.4.1):

- **Claude Code and every other client that is not agy.** The server issues an `Mcp-Session-Id` at
  `initialize` and keeps `mcp_session_id -> (key_id, handle)` in memory (`McpSessions`). The handle
  is set by `a2a_hello`. A restart loses the map; the client then gets 404, re-initialises, and its
  first identity-bound call returns the constant "Not bound. Call a2a_hello." The map is also tied
  to the API key: a request that carries key B's bearer and key A's session id is refused 403
  (SP5 D12 finding 1; the `mcp` SDK did not do this and a hand-written server must).
- **agy.** Identity is the conversation id the client puts in `params._meta` on every `tools/call`,
  read only for a `local-harness` key whose card is an `antigravity@` card, and only matched
  against sessions of that same card. It is mapped through the durable `sessions` table, with the
  conversation id stored as `harness_session_id`, so a restart loses nothing. `Mcp-Session-Id` is
  never used for agy identity.

What is built here and what is S1-ID's: this module registers and finds sessions only as far as the
MCP acceptance needs (`a2a_hello` in `name` mode, and the first-call registration of an unseen agy
conversation, decision D30). `POST /sessions`, `GET /sessions`, `POST /sessions/end`, aliases for a
later `SessionStart` name, and the full liveness rules belong to S1-ID.
"""

from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.clock import Clock
from coordination.service.directory import ACTIVE_WINDOW, Session
from coordination.service.types import HANDLE_RE
from coordination.store.tables import cards, sessions

#: The `_meta` keys agy puts on `tools/call` (spec 5.4.1, verified on the wire, SP2 A4).
AGY_CONVERSATION_KEY = "antigravity.google/conversation_id"
AGY_ROOT_KEY = "antigravity.google/root_conversation_id"
#: The only card harness whose `_meta` is read.
AGY_HARNESS = "antigravity"

#: What a conversation id may look like before it is stored: `sessions.harness_session_id` is 128
#: characters. Anything else is treated as no conversation id (the call is then unbound).
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_NAME_STRIP = re.compile(r"[^a-z0-9._-]")
MAX_NAME = 39

#: The in-memory map is bounded: a client that never sends `DELETE` (Claude Code) would grow it.
MAX_MCP_SESSIONS = 4096


def is_agy_card(card_id: str | None) -> bool:
    return bool(card_id) and card_id.split("@", 1)[0] == AGY_HARNESS  # type: ignore[union-attr]


def valid_session_id(value: object) -> str | None:
    return value if isinstance(value, str) and _SESSION_ID_RE.match(value) else None


def sid8_of(harness_session_id: str) -> str:
    """The first 8 hex characters of a session id (spec 5.1). A UUID or a hex string gives its own
    first 8; an id that is not hex gives the first 8 of its SHA-256, so the handle regex still holds."""
    hexed = harness_session_id.replace("-", "").lower()
    if len(hexed) >= 8 and re.fullmatch(r"[0-9a-f]+", hexed):
        return hexed[:8]
    return hashlib.sha256(harness_session_id.encode()).hexdigest()[:8]


def derive_name(hint: str) -> str:
    """`name_hint` lowercased and reduced to `[a-z0-9._-]`, at most 39 characters, starting with
    `[a-z0-9]` (spec 3.5). May be empty: the caller then falls back to the session id [design,
    open in the spec: the unnamed form]."""
    reduced = _NAME_STRIP.sub("", hint.lower()).lstrip("._-")
    return reduced[:MAX_NAME]


def build_handle(card_id: str, hint: str, harness_session_id: str) -> str:
    sid8 = sid8_of(harness_session_id)
    handle = f"{card_id}/{derive_name(hint) or sid8}~{sid8}"
    if not HANDLE_RE.match(handle):  # a card id the cards file should never have produced
        raise ValueError("handle does not match the handle grammar")
    return handle


# ---------------------------------------------------------------------------------------------
# The in-memory map
# ---------------------------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------------------------
# The durable registry (the `sessions` table)
# ---------------------------------------------------------------------------------------------


class HandleCollision(Exception):
    """A different harness session already holds this handle (spec 3.5: practically impossible,
    and never resolved by appending a suffix)."""


@dataclass(frozen=True)
class CardInfo:
    card_id: str
    harness: str
    machine: str


@dataclass(frozen=True)
class PeerSession:
    handle: str
    card_id: str
    last_seen_at: datetime

    def liveness(self, now: datetime, listening: bool) -> str:
        """`listening`, `active` or `registered` (spec 5.5); ended sessions are not listed."""
        if listening:
            return "listening"
        return "active" if now - self.last_seen_at <= ACTIVE_WINDOW else "registered"


#: A session's `last_seen_at` is written at most this often per handle [design], so a chatty
#: client does not turn every tool call into a database write. Far below the 15 minute window.
TOUCH_RESOLUTION = timedelta(seconds=30)


class SessionRegistry:
    """The `sessions` table as the MCP binding needs it. SQLAlchemy Core, no dialect SQL."""

    def __init__(self, engine: AsyncEngine, clock: Clock) -> None:
        self._engine = engine
        self._clock = clock
        self._touched: dict[str, datetime] = {}

    async def by_handle(self, handle: str) -> Session | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(sa.select(sessions).where(sessions.c.handle == handle))).one_or_none()
        return _session(row) if row is not None else None

    async def by_harness_session(self, card_id: str, harness_session_id: str) -> Session | None:
        stmt = sa.select(sessions).where(
            sessions.c.card_id == card_id, sessions.c.harness_session_id == harness_session_id
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return _session(row) if row is not None else None

    async def register(self, card_id: str, harness_session_id: str, handle: str) -> tuple[Session, bool]:
        """Idempotent on (card, harness session id): a repeat returns the stored session. Returns
        (session, created). Raises `HandleCollision` if another harness session holds `handle`."""
        existing = await self.by_harness_session(card_id, harness_session_id)
        if existing is not None:
            return existing, False
        now = self._clock.now()
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    sa.insert(sessions).values(
                        handle=handle,
                        card_id=card_id,
                        harness_session_id=harness_session_id,
                        registered_at=now,
                        last_seen_at=now,
                        ended_at=None,
                    )
                )
        except IntegrityError:
            # Either a concurrent registration of the same session won (return it), or another
            # session holds this handle (refuse).
            again = await self.by_harness_session(card_id, harness_session_id)
            if again is not None:
                return again, False
            raise HandleCollision(handle) from None
        return Session(handle, card_id, now, now, None), True

    async def touch(self, handle: str) -> None:
        """Record an authenticated call from a live session (liveness `active`, spec 5.5)."""
        now = self._clock.now()
        last = self._touched.get(handle)
        if last is not None and now - last < TOUCH_RESOLUTION:
            return
        self._touched[handle] = now
        stmt = (
            sa.update(sessions)
            .where(sessions.c.handle == handle, sessions.c.ended_at.is_(None))
            .values(last_seen_at=now)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def cards(self) -> list[CardInfo]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(sa.select(cards).order_by(cards.c.card_id))).all()
        return [CardInfo(r.card_id, r.harness, r.machine) for r in rows]

    async def live_sessions(self) -> list[PeerSession]:
        """Every session that has not ended, newest first (spec 4.6: handle names and liveness)."""
        stmt = (
            sa.select(sessions.c.handle, sessions.c.card_id, sessions.c.last_seen_at)
            .where(sessions.c.ended_at.is_(None))
            .order_by(sessions.c.last_seen_at.desc(), sessions.c.handle)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return [PeerSession(r.handle, r.card_id, r.last_seen_at) for r in rows]


def _session(row: sa.Row) -> Session:
    return Session(
        handle=row.handle,
        card_id=row.card_id,
        registered_at=row.registered_at,
        last_seen_at=row.last_seen_at,
        ended_at=row.ended_at,
    )
