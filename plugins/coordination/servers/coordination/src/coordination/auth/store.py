"""Where API key records live: the `ApiKeyStore` interface, the SQL store and a test double.

`SqlApiKeyStore` is SQLAlchemy Core over `tables.api_keys` (created by migration m0001; S1-AUTH
adds no column). It never reads or writes a secret: the only secret-derived value is
`secret_hash`.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta
from typing import Protocol, runtime_checkable

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.auth.records import ApiKeyRecord
from coordination.store.tables import api_keys

#: `last_used_at` is refreshed at most this often per key [design], so a busy client does not
#: turn every request into a database write.
LAST_USED_RESOLUTION = timedelta(seconds=60)


@runtime_checkable
class ApiKeyStore(Protocol):
    async def get(self, key_id: str) -> ApiKeyRecord | None:
        """The record with this key id, or None."""
        ...

    async def insert(self, record: ApiKeyRecord) -> None:
        """Add a record. A duplicate key id raises."""
        ...

    async def revoke(self, key_id: str, at: datetime) -> bool:
        """Mark the key revoked at `at`. True if a live key was revoked, False if none matched."""
        ...

    async def touch(self, key_id: str, at: datetime) -> None:
        """Record use. May skip the write if `last_used_at` is recent."""
        ...


def _from_row(row: sa.Row) -> ApiKeyRecord:
    cards = row.cards_allowed
    return ApiKeyRecord(
        key_id=row.key_id,
        env=row.env,
        name=row.name,
        scope=row.scope,
        secret_hash=row.secret_hash,
        created_at=row.created_at,
        expires_at=row.expires_at,
        card_id=row.card_id,
        peer_id=row.peer_id,
        cards_allowed=tuple(cards) if cards is not None else None,
        tailnet_node=row.tailnet_node,
        tailnet_login=row.tailnet_login,
        last_used_at=row.last_used_at,
        revoked_at=row.revoked_at,
    )


class SqlApiKeyStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def get(self, key_id: str) -> ApiKeyRecord | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(sa.select(api_keys).where(api_keys.c.key_id == key_id))).first()
        return _from_row(row) if row is not None else None

    async def insert(self, record: ApiKeyRecord) -> None:
        values = {
            "key_id": record.key_id,
            "env": record.env,
            "name": record.name,
            "scope": record.scope,
            "card_id": record.card_id,
            "peer_id": record.peer_id,
            "cards_allowed": list(record.cards_allowed) if record.cards_allowed is not None else None,
            "tailnet_node": record.tailnet_node,
            "tailnet_login": record.tailnet_login,
            "secret_hash": record.secret_hash,
            "created_at": record.created_at,
            "expires_at": record.expires_at,
            "last_used_at": record.last_used_at,
            "revoked_at": record.revoked_at,
        }
        async with self._engine.begin() as conn:
            await conn.execute(sa.insert(api_keys).values(**values))

    async def revoke(self, key_id: str, at: datetime) -> bool:
        stmt = (
            sa.update(api_keys)
            .where(api_keys.c.key_id == key_id, api_keys.c.revoked_at.is_(None))
            .values(revoked_at=at)
        )
        async with self._engine.begin() as conn:
            return (await conn.execute(stmt)).rowcount == 1

    async def touch(self, key_id: str, at: datetime) -> None:
        stmt = (
            sa.update(api_keys)
            .where(
                api_keys.c.key_id == key_id,
                sa.or_(api_keys.c.last_used_at.is_(None), api_keys.c.last_used_at < at - LAST_USED_RESOLUTION),
            )
            .values(last_used_at=at)
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)


class InMemoryApiKeyStore:
    """A dict-backed store for unit tests. Same behaviour as the SQL one, no database."""

    def __init__(self) -> None:
        self.records: dict[str, ApiKeyRecord] = {}

    async def get(self, key_id: str) -> ApiKeyRecord | None:
        return self.records.get(key_id)

    async def insert(self, record: ApiKeyRecord) -> None:
        if record.key_id in self.records:
            raise ValueError("duplicate key id")
        self.records[record.key_id] = record

    async def revoke(self, key_id: str, at: datetime) -> bool:
        rec = self.records.get(key_id)
        if rec is None or rec.revoked_at is not None:
            return False
        self.records[key_id] = dataclasses.replace(rec, revoked_at=at)
        return True

    async def touch(self, key_id: str, at: datetime) -> None:
        rec = self.records.get(key_id)
        if rec is not None and (rec.last_used_at is None or rec.last_used_at < at - LAST_USED_RESOLUTION):
            self.records[key_id] = dataclasses.replace(rec, last_used_at=at)
