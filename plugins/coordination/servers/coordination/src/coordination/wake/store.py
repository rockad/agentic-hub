"""The `wakes` table as the wake endpoint uses it (spec 1.3, 7.3, 7.5). SQLAlchemy Core only.

A row is written when a listener is answered `200` (so the rows of the last hour are the wake
budget, spec 7.3) and carries a count and the hash of the pending set (`set_hash`, ids only),
never task content. `confirmed_at` is set when the same handle shows up within the confirmation
window (spec 7.5). The anti-loop streak (spec 7.4) is read back from these rows (`latest`), so it
survives a restart. The table is S1-STORE's migration 2, plus `set_hash` from migration 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.store.tables import wakes

#: The rolling window of the budget (spec 7.3).
BUDGET_WINDOW = timedelta(hours=1)


@dataclass(frozen=True)
class WakeRow:
    wake_id: int
    at: datetime
    pending_n: int
    confirmed_at: datetime | None
    set_hash: str | None = None  # None on rows written before migration 4


_COLUMNS = (wakes.c.wake_id, wakes.c.at, wakes.c.pending_n, wakes.c.confirmed_at, wakes.c.set_hash)


class WakeStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def recent(self, handle: str, since: datetime) -> list[WakeRow]:
        """The handle's wakes after `since`, newest first (at most one budget's worth matters;
        a hard cap of 500 keeps a misconfigured budget from loading a whole hour of rows)."""
        stmt = (
            sa.select(*_COLUMNS)
            .where(wakes.c.handle == handle, wakes.c.at > since)
            .order_by(wakes.c.at.desc(), wakes.c.wake_id.desc())
            .limit(500)
        )
        async with self._engine.connect() as conn:
            return [WakeRow(*r) for r in (await conn.execute(stmt)).all()]

    async def latest(self, handle: str, n: int) -> list[WakeRow]:
        """The handle's `n` newest wakes of any age, newest first: what the anti-loop rule reads."""
        stmt = (
            sa.select(*_COLUMNS)
            .where(wakes.c.handle == handle)
            .order_by(wakes.c.at.desc(), wakes.c.wake_id.desc())
            .limit(n)
        )
        async with self._engine.connect() as conn:
            return [WakeRow(*r) for r in (await conn.execute(stmt)).all()]

    async def insert(self, handle: str, at: datetime, pending_n: int, set_hash: str) -> int:
        """Record a wake that is being delivered, with the hash of its pending set. Returns its id."""
        stmt = (
            sa.insert(wakes)
            .values(handle=handle, at=at, pending_n=pending_n, set_hash=set_hash)
            .returning(wakes.c.wake_id)
        )
        async with self._engine.begin() as conn:
            return int((await conn.execute(stmt)).scalar_one())

    async def confirm(self, handle: str, now: datetime, window: timedelta) -> int:
        """Mark the handle's unconfirmed wakes of the last `window` confirmed. Returns the count."""
        stmt = (
            sa.update(wakes)
            .where(wakes.c.handle == handle, wakes.c.confirmed_at.is_(None), wakes.c.at >= now - window)
            .values(confirmed_at=now)
        )
        async with self._engine.begin() as conn:
            return int((await conn.execute(stmt)).rowcount)
