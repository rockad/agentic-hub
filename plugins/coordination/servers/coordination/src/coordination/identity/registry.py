"""`SessionRegistry`: the durable session registry (tables `sessions`, `session_aliases`,
`session_conversations`). SQLAlchemy Core, no dialect SQL.

S1-MCP built the first half of this class (`by_handle`, `by_harness_session`, `register`, `touch`,
`live_sessions`, `cards`) as far as its acceptance needed; S1-ID extends that same class rather than
building a second one. It lives here, and `coordination.mcp.sessions` re-exports it.

Rules held here:

- A handle is never reused for a different `harness_session_id`, in any state: `sessions.handle` is
  the primary key and rows are never deleted by this class.
- `register` is idempotent on (card, harness session id).
- Nothing here stores a working directory, a path, a process id or a hostname beyond the card.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from coordination.clock import Clock
from coordination.identity.errors import HandleCollision
from coordination.identity.liveness import liveness_state
from coordination.service.directory import Session
from coordination.store.tables import cards, session_aliases, session_conversations, sessions

#: A session's `last_seen_at` is written at most this often per handle by `touch` [design], so a
#: chatty client does not turn every tool call into a database write. Far below the 15 minute
#: `active` window.
TOUCH_RESOLUTION = timedelta(seconds=30)
#: At most this many aliases per handle [design]: a later `SessionStart` that keeps sending new
#: names cannot grow the table without bound.
MAX_ALIASES = 8
#: The longest listing `GET /sessions` returns [design].
MAX_LIST = 200


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
        return liveness_state(ended=False, last_seen_at=self.last_seen_at, now=now, listening=listening)


@dataclass(frozen=True)
class SessionView:
    """A session as `GET /sessions` lists it."""

    handle: str
    card_id: str
    registered_at: datetime
    last_seen_at: datetime
    ended_at: datetime | None
    aliases: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ConversationLink:
    """An agy sub-invocation conversation grouped under a root session's handle (spec 5.4.1)."""

    card_id: str
    conversation_id: str
    handle: str
    root_conversation_id: str | None
    parent_conversation_id: str | None
    first_seen_at: datetime


class SessionRegistry:
    def __init__(self, engine: AsyncEngine, clock: Clock) -> None:
        self._engine = engine
        self._clock = clock
        self._touched: dict[str, datetime] = {}

    # -- reads ---------------------------------------------------------------------------

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

    async def list_sessions(
        self,
        *,
        handle: str | None = None,
        card_id: str | None = None,
        include_ended: bool = False,
        limit: int = MAX_LIST,
    ) -> list[SessionView]:
        """Sessions newest-seen first, with their aliases (`GET /sessions`)."""
        stmt = sa.select(sessions).order_by(sessions.c.last_seen_at.desc(), sessions.c.handle).limit(min(limit, MAX_LIST))
        if handle is not None:
            stmt = stmt.where(sessions.c.handle == handle)
        if card_id is not None:
            stmt = stmt.where(sessions.c.card_id == card_id)
        if not include_ended:
            stmt = stmt.where(sessions.c.ended_at.is_(None))
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
            by_handle = await self._aliases_of(conn, [r.handle for r in rows])
        return [
            SessionView(r.handle, r.card_id, r.registered_at, r.last_seen_at, r.ended_at, tuple(by_handle.get(r.handle, ())))
            for r in rows
        ]

    async def aliases(self, handle: str) -> list[str]:
        async with self._engine.connect() as conn:
            return (await self._aliases_of(conn, [handle])).get(handle, [])

    async def by_alias(self, card_id: str, alias: str) -> list[str]:
        """Handles of `card_id` that carry `alias`. Several sessions may share a name, so this is a
        lookup aid and never a routing rule [design]."""
        stmt = (
            sa.select(session_aliases.c.handle)
            .where(session_aliases.c.card_id == card_id, session_aliases.c.alias == alias)
            .order_by(session_aliases.c.handle)
        )
        async with self._engine.connect() as conn:
            return [r.handle for r in (await conn.execute(stmt)).all()]

    async def conversation(self, card_id: str, conversation_id: str) -> ConversationLink | None:
        stmt = sa.select(session_conversations).where(
            session_conversations.c.card_id == card_id, session_conversations.c.conversation_id == conversation_id
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        if row is None:
            return None
        return ConversationLink(
            row.card_id, row.conversation_id, row.handle, row.root_conversation_id, row.parent_conversation_id, row.first_seen_at
        )

    async def conversations_of(self, handle: str) -> list[ConversationLink]:
        stmt = (
            sa.select(session_conversations)
            .where(session_conversations.c.handle == handle)
            .order_by(session_conversations.c.first_seen_at, session_conversations.c.conversation_id)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return [
            ConversationLink(r.card_id, r.conversation_id, r.handle, r.root_conversation_id, r.parent_conversation_id, r.first_seen_at)
            for r in rows
        ]

    @staticmethod
    async def _aliases_of(conn: AsyncConnection, handles: list[str]) -> dict[str, list[str]]:
        if not handles:
            return {}
        stmt = (
            sa.select(session_aliases.c.handle, session_aliases.c.alias)
            .where(session_aliases.c.handle.in_(handles))
            .order_by(session_aliases.c.created_at, session_aliases.c.alias)
        )
        out: dict[str, list[str]] = {}
        for r in (await conn.execute(stmt)).all():
            out.setdefault(r.handle, []).append(r.alias)
        return out

    # -- writes --------------------------------------------------------------------------

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
            raise HandleCollision from None
        return Session(handle, card_id, now, now, None), True

    async def touch(self, handle: str) -> None:
        """Record an authenticated call from a live session (liveness `active`, spec 5.5), at most
        once per `TOUCH_RESOLUTION` per handle."""
        now = self._clock.now()
        last = self._touched.get(handle)
        if last is not None and now - last < TOUCH_RESOLUTION:
            return
        self._touched[handle] = now
        await self._set_last_seen(handle, now)

    async def refresh(self, handle: str) -> None:
        """Record a registration refresh (`POST /sessions` on a known session, spec 3.5: "Refreshing
        updates `last_seen_at`"). Not throttled: a registration is rare."""
        now = self._clock.now()
        self._touched[handle] = now
        await self._set_last_seen(handle, now)

    async def _set_last_seen(self, handle: str, now: datetime) -> None:
        stmt = (
            sa.update(sessions)
            .where(sessions.c.handle == handle, sessions.c.ended_at.is_(None))
            .values(last_seen_at=now)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)

    async def idle_handles(self, last_seen_before: datetime) -> list[str]:
        """Handles of live sessions with no call since `last_seen_before` (the idle-TTL candidates),
        oldest first."""
        stmt = (
            sa.select(sessions.c.handle)
            .where(sessions.c.ended_at.is_(None), sessions.c.last_seen_at < last_seen_before)
            .order_by(sessions.c.last_seen_at, sessions.c.handle)
        )
        async with self._engine.connect() as conn:
            return [r.handle for r in (await conn.execute(stmt)).all()]

    async def end(self, handle: str, *, idle_before: datetime | None = None) -> bool:
        """Mark the session ended. True if this call ended it, False if it was already ended (or
        unknown). The row is kept: a handle is never reused. With `idle_before` the row is ended
        only while its `last_seen_at` is still older than that, so a session that called in between
        the idle scan and this write is left alone."""
        stmt = (
            sa.update(sessions)
            .where(sessions.c.handle == handle, sessions.c.ended_at.is_(None))
            .values(ended_at=self._clock.now())
        )
        if idle_before is not None:
            stmt = stmt.where(sessions.c.last_seen_at < idle_before)
        async with self._engine.begin() as conn:
            result = await conn.execute(stmt)
        if result.rowcount:
            self._touched.pop(handle, None)
        return bool(result.rowcount)

    async def revive(self, handle: str) -> bool:
        """Clear `ended_at` and refresh `last_seen_at`: a resumed ended session comes back with the
        same handle (decision Z17). True only for the call that revived it, so a concurrent revive
        is counted, and audited, once."""
        now = self._clock.now()
        stmt = (
            sa.update(sessions)
            .where(sessions.c.handle == handle, sessions.c.ended_at.is_not(None))
            .values(ended_at=None, last_seen_at=now)
        )
        async with self._engine.begin() as conn:
            result = await conn.execute(stmt)
        self._touched[handle] = now
        return bool(result.rowcount)

    async def add_alias(self, card_id: str, handle: str, alias: str) -> bool:
        """Record `alias` as another name of `handle`. True if it was added; False if the handle
        already has it or already has `MAX_ALIASES` aliases."""
        async with self._engine.connect() as conn:
            held = (
                await conn.execute(sa.select(session_aliases.c.alias).where(session_aliases.c.handle == handle))
            ).all()
        if alias in {r.alias for r in held} or len(held) >= MAX_ALIASES:
            return False
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    sa.insert(session_aliases).values(
                        handle=handle, alias=alias, card_id=card_id, created_at=self._clock.now()
                    )
                )
        except IntegrityError:  # a concurrent call added the same alias
            return False
        return True

    async def link_conversation(
        self,
        card_id: str,
        conversation_id: str,
        handle: str,
        *,
        root_conversation_id: str | None,
        parent_conversation_id: str | None,
    ) -> bool:
        """Record that `conversation_id` is a sub-invocation grouped under `handle`. True if the row
        is new; an existing link is left as it is (first sight wins)."""
        if await self.conversation(card_id, conversation_id) is not None:
            return False
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    sa.insert(session_conversations).values(
                        card_id=card_id,
                        conversation_id=conversation_id,
                        handle=handle,
                        root_conversation_id=root_conversation_id,
                        parent_conversation_id=parent_conversation_id,
                        first_seen_at=self._clock.now(),
                    )
                )
        except IntegrityError:  # a concurrent call linked it first
            return False
        return True


def _session(row: sa.Row) -> Session:
    return Session(
        handle=row.handle,
        card_id=row.card_id,
        registered_at=row.registered_at,
        last_seen_at=row.last_seen_at,
        ended_at=row.ended_at,
    )
