"""Sessions and cards, as the state machine reads them (tables `sessions` and `cards`, spec 1.3).

Reads, plus the one write the TTL sweep owns: marking an idle session ended. Registering sessions
and loading the cards file belong to S1-ID and S1-AUTH; this module never inserts either.

Liveness (spec 5.5): `ended` when `ended_at` is set; `active` when not ended and `last_seen_at` is
within 15 minutes; `listening` is the in-memory `ListenerView`, not stored.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.store.tables import cards, sessions

#: A session with an authenticated call inside this window is `active` (spec 5.5) [design].
ACTIVE_WINDOW = timedelta(minutes=15)


@dataclass(frozen=True)
class Session:
    handle: str
    card_id: str
    registered_at: datetime
    last_seen_at: datetime
    ended_at: datetime | None

    @property
    def ended(self) -> bool:
        return self.ended_at is not None

    def active(self, now: datetime) -> bool:
        return self.ended_at is None and now - self.last_seen_at <= ACTIVE_WINDOW


class Directory:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def card_exists(self, card_id: str) -> bool:
        async with self._engine.connect() as conn:
            return (await conn.execute(sa.select(cards.c.card_id).where(cards.c.card_id == card_id))).first() is not None

    async def session(self, handle: str) -> Session | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(sa.select(sessions).where(sessions.c.handle == handle))).one_or_none()
        return _session(row) if row is not None else None

    async def newest_active(self, card_id: str, now: datetime) -> Session | None:
        """The newest registered `active` session under the card (the D29 second choice)."""
        stmt = (
            sa.select(sessions)
            .where(
                sessions.c.card_id == card_id,
                sessions.c.ended_at.is_(None),
                sessions.c.last_seen_at >= now - ACTIVE_WINDOW,
            )
            .order_by(sessions.c.registered_at.desc(), sessions.c.handle)
            .limit(1)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return _session(row) if row is not None else None

    async def end_idle(self, last_seen_before: datetime, now: datetime) -> int:
        """Mark sessions with no call since `last_seen_before` as ended (`A2A_SESSION_IDLE_TTL_H`)."""
        stmt = (
            sa.update(sessions)
            .where(sessions.c.ended_at.is_(None), sessions.c.last_seen_at < last_seen_before)
            .values(ended_at=now)
        )
        async with self._engine.begin() as conn:
            return (await conn.execute(stmt)).rowcount


def _session(row: sa.Row) -> Session:
    return Session(
        handle=row.handle,
        card_id=row.card_id,
        registered_at=row.registered_at,
        last_seen_at=row.last_seen_at,
        ended_at=row.ended_at,
    )
