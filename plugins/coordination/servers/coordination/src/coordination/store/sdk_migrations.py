"""The SDK migration stream: `a2a-python`'s own Alembic revisions (spec 1.3). Runs first.

It owns `tasks`, `push_notification_configs`, `task_versions` and `task_events` under the version
table `a2a_alembic_version`. Our own stream (`coordination.store.migrations`) never touches those
tables and the SDK's never touches ours.

Three starting points are handled:
- fresh database (no `a2a_alembic_version`, no `tasks`): the SDK models create the tables at head
  and the version table is stamped `head`, the standard Alembic pattern. The SDK's own revisions
  only alter tables that already exist, so they cannot build a database from nothing.
- an existing database with no version table (older SDK use, or `create_table=True`): the revisions
  run from the base. They check for each column and index first, so any older shape is brought to
  head with its rows kept.
- a database with a version table: upgrade to head.

A revision the installed SDK does not know means the database was migrated by a newer SDK. That is
refused (`SchemaTooNew`), like a newer `coord_schema_version`.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from importlib.resources import files
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config as AlembicConfig
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError

from a2a.server.models import Base
from coordination.store.migrations import MigrationError, SchemaTooNew

VERSION_TABLE = "a2a_alembic_version"
SDK_TABLES = ("tasks", "push_notification_configs", "task_versions", "task_events")
_ENV_DIR = Path(__file__).parent / "sdk_env"


@dataclass(frozen=True)
class SdkResult:
    before: str | None  # revision before, None when there was no version table
    after: str  # head
    created_fresh: bool


def _config(conn: sa.Connection) -> AlembicConfig:
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(_ENV_DIR))
    cfg.set_main_option("path_separator", "os")
    cfg.set_main_option("version_locations", str(files("a2a").joinpath("migrations", "versions")))
    cfg.attributes["connection"] = conn
    return cfg


def head_revision() -> str:
    """The revision the installed SDK migrates to. Needs no connection."""
    script = ScriptDirectory.from_config(_config(None))  # type: ignore[arg-type]
    head = script.get_current_head()
    assert head is not None
    return head


def read_revision(conn: sa.Connection) -> str | None:
    """The recorded SDK revision, None if there is no version table. Creates nothing."""
    if not sa.inspect(conn).has_table(VERSION_TABLE):
        return None
    rows = conn.execute(sa.text(f"SELECT version_num FROM {VERSION_TABLE}")).scalars().all()
    if len(rows) > 1:
        raise SchemaTooNew(f"database {VERSION_TABLE} holds several revisions ({', '.join(sorted(rows))}); refusing to start")
    return rows[0] if rows else None


def check_not_newer(conn: sa.Connection) -> str | None:
    """Return the recorded revision, or raise `SchemaTooNew` if the SDK does not know it."""
    rev = read_revision(conn)
    if rev is None:
        return None
    script = ScriptDirectory.from_config(_config(conn))
    try:
        script.get_revision(rev)
    except CommandError:
        raise SchemaTooNew(
            f"database {VERSION_TABLE} revision {rev} is unknown to a2a-sdk {metadata.version('a2a-sdk')}; "
            "run a newer server or restore an older database"
        ) from None
    return rev


def apply(conn: sa.Connection) -> SdkResult:
    """Bring the SDK tables to head on `conn`, inside the caller's transaction."""
    before = check_not_newer(conn)
    head = head_revision()
    cfg = _config(conn)
    created_fresh = False
    try:
        if before is None and not sa.inspect(conn).has_table("tasks"):
            wanted = [Base.metadata.tables[name] for name in SDK_TABLES]
            Base.metadata.create_all(conn, tables=wanted, checkfirst=False)
            command.stamp(cfg, "head")
            created_fresh = True
        elif before != head:
            command.upgrade(cfg, "head")
    except (sa.exc.SQLAlchemyError, CommandError) as exc:
        raise MigrationError(f"SDK migration to {head} failed: {type(getattr(exc, 'orig', None) or exc).__name__}") from exc
    return SdkResult(before=before, after=head, created_fresh=created_fresh)
