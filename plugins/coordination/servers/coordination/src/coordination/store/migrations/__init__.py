"""Our migration stream (spec 1.3): numbered steps and a `coord_schema_version` row.

This is the second of two streams. The SDK's own Alembic stream (`coordination.store.sdk_migrations`)
runs first and owns `tasks`, `push_notification_configs`, `task_versions` and `task_events`
under its own version table `a2a_alembic_version`. This one owns everything we add, under
`coord_schema_version`. The two never share a version table, so neither can mistake the other's
history for its own (BP16, SP5 D6).

How it works:
- Each step is a module `mNNNN_<name>.py` with `VERSION`, `NAME` and `upgrade(conn)`, listed in
  `STEPS`. A step carries its own frozen copy of the DDL; `store/tables.py` is the schema at head.
- `migrate` applies the missing steps in one transaction (Postgres DDL is transactional), so a
  failed step leaves the database as it was. A second run applies nothing.
- A database whose `coord_schema_version` is newer than `LATEST` is refused with
  `SchemaTooNew`: an older server never runs against a schema it does not understand.
- One server process owns the database (spec 1.1), so there is no cross-process migration lock.

To add a table or column: add `m000N_<name>.py`, append it to `STEPS`, update `tables.py`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.store.migrations import m0001_api_keys_task_index
from coordination.store.tables import coord_schema_version


class SchemaTooNew(RuntimeError):
    """The database schema is newer than this code knows. The message is one line."""


class MigrationError(RuntimeError):
    """A step failed. The transaction was rolled back; the message is one line."""


@dataclass(frozen=True)
class Step:
    version: int
    name: str
    upgrade: Callable[[sa.Connection], None]


STEPS: tuple[Step, ...] = (
    Step(m0001_api_keys_task_index.VERSION, m0001_api_keys_task_index.NAME, m0001_api_keys_task_index.upgrade),
)

LATEST: int = STEPS[-1].version

assert [s.version for s in STEPS] == list(range(1, len(STEPS) + 1)), "migration steps must be 1..N, in order"


def read_version(conn: sa.Connection) -> int:
    """The applied version, 0 if the version table or its row is missing. Creates nothing."""
    if not sa.inspect(conn).has_table(coord_schema_version.name):
        return 0
    value = conn.execute(sa.select(coord_schema_version.c.version).where(coord_schema_version.c.id == 1)).scalar_one_or_none()
    return int(value or 0)


def check_not_newer(conn: sa.Connection) -> int:
    """Return the applied version, or raise `SchemaTooNew` if it is newer than `LATEST`."""
    current = read_version(conn)
    if current > LATEST:
        raise SchemaTooNew(
            f"database coord_schema_version {current} is newer than this server knows ({LATEST}); "
            "run a newer server or restore an older database"
        )
    return current


def _ensure_version_row(conn: sa.Connection) -> None:
    coord_schema_version.create(conn, checkfirst=True)
    has_row = conn.execute(sa.select(coord_schema_version.c.id).where(coord_schema_version.c.id == 1)).first()
    if has_row is None:
        conn.execute(coord_schema_version.insert().values(id=1, version=0, updated_at=datetime.now(UTC)))


def apply(conn: sa.Connection) -> list[int]:
    """Apply the missing steps on `conn`, inside the caller's transaction. Returns their versions."""
    current = check_not_newer(conn)
    if current == LATEST:
        return []
    _ensure_version_row(conn)
    applied: list[int] = []
    for step in STEPS[current:]:
        try:
            step.upgrade(conn)
        except sa.exc.SQLAlchemyError as exc:
            # SQLAlchemy puts the SQL statement in str(exc); keep the message to one line.
            raise MigrationError(
                f"migration {step.version} ({step.name}) failed: {type(exc.orig or exc).__name__}"
            ) from exc
        conn.execute(
            coord_schema_version.update()
            .where(coord_schema_version.c.id == 1)
            .values(version=step.version, updated_at=datetime.now(UTC))
        )
        applied.append(step.version)
    return applied


async def current_version(engine: AsyncEngine) -> int:
    async with engine.connect() as conn:
        return await conn.run_sync(read_version)


async def preflight(engine: AsyncEngine) -> int:
    """Read-only: the applied version, or `SchemaTooNew`. Changes nothing."""
    async with engine.connect() as conn:
        return await conn.run_sync(check_not_newer)


async def migrate(engine: AsyncEngine) -> list[int]:
    """Bring our stream to `LATEST` in one transaction. Returns the versions applied."""
    async with engine.begin() as conn:
        return await conn.run_sync(apply)
