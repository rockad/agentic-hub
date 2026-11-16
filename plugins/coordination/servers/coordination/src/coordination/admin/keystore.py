"""The two key-table operations the admin commands need and the S1-AUTH `ApiKeyStore` does not have
(S1-ADMIN): list every key, and rotate (issue the replacement and shorten the old key's expiry in
one transaction).

They are subclasses of the S1-AUTH stores, so `insert`, `revoke` and `get` stay S1-AUTH's code and
the files of that stream are untouched. No column is added: both operations use `api_keys` as
migration m0001 made it. A secret never passes through here, only `secret_hash`.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime
from typing import Protocol, runtime_checkable

import sqlalchemy as sa

from coordination.auth.records import ApiKeyRecord
from coordination.auth.store import ApiKeyStore, InMemoryApiKeyStore, SqlApiKeyStore
from coordination.auth.store import _from_row as _record_from_row  # one row-to-record mapping, S1-AUTH's
from coordination.store.tables import api_keys


@runtime_checkable
class KeyAdminStore(ApiKeyStore, Protocol):
    async def list_all(self) -> list[ApiKeyRecord]:
        """Every key, live or not, oldest first."""
        ...

    async def rotate(self, old_key_id: str, old_expires_at: datetime, new: ApiKeyRecord, now: datetime) -> bool:
        """Insert `new` and set the old key's expiry to `old_expires_at`, in one transaction. False
        (and nothing written) if the old key is not live at `now` (unknown, revoked or expired)."""
        ...


class SqlKeyAdminStore(SqlApiKeyStore):
    async def list_all(self) -> list[ApiKeyRecord]:
        stmt = sa.select(api_keys).order_by(api_keys.c.created_at, api_keys.c.key_id)
        async with self._engine.connect() as conn:
            return [_record_from_row(row) for row in (await conn.execute(stmt)).all()]

    async def rotate(self, old_key_id: str, old_expires_at: datetime, new: ApiKeyRecord, now: datetime) -> bool:
        shorten = (
            sa.update(api_keys)
            .where(api_keys.c.key_id == old_key_id, api_keys.c.revoked_at.is_(None), api_keys.c.expires_at > now)
            .values(expires_at=old_expires_at)
        )
        async with self._engine.begin() as conn:
            if (await conn.execute(shorten)).rowcount != 1:
                return False
            await conn.execute(
                sa.insert(api_keys).values(
                    key_id=new.key_id,
                    env=new.env,
                    name=new.name,
                    scope=new.scope,
                    card_id=new.card_id,
                    peer_id=new.peer_id,
                    cards_allowed=list(new.cards_allowed) if new.cards_allowed is not None else None,
                    tailnet_node=new.tailnet_node,
                    tailnet_login=new.tailnet_login,
                    secret_hash=new.secret_hash,
                    created_at=new.created_at,
                    expires_at=new.expires_at,
                    last_used_at=None,
                    revoked_at=None,
                )
            )
        return True


class InMemoryKeyAdminStore(InMemoryApiKeyStore):
    """The test double: the same behaviour on a dict."""

    async def list_all(self) -> list[ApiKeyRecord]:
        return sorted(self.records.values(), key=lambda r: (r.created_at, r.key_id))

    async def rotate(self, old_key_id: str, old_expires_at: datetime, new: ApiKeyRecord, now: datetime) -> bool:
        old = self.records.get(old_key_id)
        if old is None or old.revoked_at is not None or old.expires_at <= now:
            return False
        if new.key_id in self.records:
            raise ValueError("duplicate key id")
        self.records[old_key_id] = dataclasses.replace(old, expires_at=old_expires_at)
        self.records[new.key_id] = new
        return True
