"""Both migration streams, in the order the spec fixes: the SDK's first, ours second (spec 1.3).

`migrate_all` runs both in ONE transaction, so a failure in either leaves the database as it was.
`preflight_all` only reads: it is what refuses a database that is newer than this code. Both refuse
before they change anything.
"""

from __future__ import annotations

from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.store import migrations, sdk_migrations
from coordination.store.migrations import MigrationError, SchemaTooNew  # noqa: F401 - re-exported


@dataclass(frozen=True)
class Versions:
    sdk_revision: str | None
    coord_schema_version: int


@dataclass(frozen=True)
class MigrationReport:
    sdk: sdk_migrations.SdkResult
    coord_before: int
    coord_after: int
    coord_applied: list[int]

    @property
    def changed(self) -> bool:
        return self.sdk.before != self.sdk.after or bool(self.coord_applied)


def _read(conn: sa.Connection) -> Versions:
    return Versions(sdk_migrations.read_revision(conn), migrations.read_version(conn))


def _check(conn: sa.Connection) -> Versions:
    return Versions(sdk_migrations.check_not_newer(conn), migrations.check_not_newer(conn))


def _migrate(conn: sa.Connection) -> MigrationReport:
    before = _check(conn)  # refuse a newer schema in either stream before changing anything
    sdk = sdk_migrations.apply(conn)
    applied = migrations.apply(conn)
    return MigrationReport(sdk, before.coord_schema_version, migrations.read_version(conn), applied)


async def versions(engine: AsyncEngine) -> Versions:
    async with engine.connect() as conn:
        return await conn.run_sync(_read)


async def preflight_all(engine: AsyncEngine) -> Versions:
    """Read-only. Raises `SchemaTooNew` if either stream is newer than this code knows."""
    async with engine.connect() as conn:
        return await conn.run_sync(_check)


async def migrate_all(engine: AsyncEngine) -> MigrationReport:
    async with engine.begin() as conn:
        return await conn.run_sync(_migrate)
