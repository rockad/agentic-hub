"""The two migration streams together: the SDK's Alembic revisions first, ours second."""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from alembic import command

from conftest import run
from coordination.store import migrations, schema, sdk_migrations
from coordination.store.engine import make_engine
from coordination.store.migrations import LATEST, MigrationError, SchemaTooNew, Step
from test_store_migrations import _with_engine

OLDEST_SDK_REVISION = "6419d2d130f6"  # the first of the SDK's three revisions
SDK_HEAD = sdk_migrations.head_revision()

LEGACY_DDL = """
CREATE TABLE tasks (
    id VARCHAR(36) PRIMARY KEY, context_id VARCHAR(36) NOT NULL, kind VARCHAR(16) NOT NULL,
    status JSON NOT NULL, artifacts JSON, history JSON, metadata JSON);
CREATE INDEX ix_tasks_id ON tasks (id);
CREATE TABLE push_notification_configs (
    task_id VARCHAR(36) NOT NULL, config_id VARCHAR(255) NOT NULL, config_data BYTEA NOT NULL,
    PRIMARY KEY (task_id, config_id));
INSERT INTO tasks (id, context_id, kind, status, history) VALUES
    ('11111111-1111-1111-1111-111111111111', 'ctx-1', 'task', '{"state": "TASK_STATE_COMPLETED"}', '[]'),
    ('22222222-2222-2222-2222-222222222222', 'ctx-2', 'task', '{"state": "TASK_STATE_WORKING"}', '[]');
INSERT INTO push_notification_configs VALUES ('11111111-1111-1111-1111-111111111111', 'c1', '\\x00');
"""


def table_columns(conn: sa.Connection, table: str) -> dict[str, bool]:
    return {c["name"]: c["nullable"] for c in sa.inspect(conn).get_columns(table)}


def table_names(conn: sa.Connection) -> set[str]:
    return set(sa.inspect(conn).get_table_names())


async def _tables(engine) -> set[str]:
    async with engine.connect() as conn:
        return await conn.run_sync(table_names)


def test_fresh_database_gets_both_streams_and_a_second_run_changes_nothing(config):
    async def go(engine):
        first = await schema.migrate_all(engine)
        second = await schema.migrate_all(engine)
        return first, second, await schema.versions(engine), await _tables(engine)

    first, second, versions, tables = run(_with_engine(config, go))
    assert first.sdk.created_fresh and first.sdk.before is None and first.sdk.after == SDK_HEAD
    assert first.coord_applied == list(range(1, LATEST + 1)) and first.changed
    assert not second.changed and not second.sdk.created_fresh and second.coord_applied == []
    assert versions == schema.Versions(SDK_HEAD, LATEST)
    assert {*sdk_migrations.SDK_TABLES, "a2a_alembic_version", "coord_schema_version", "api_keys", "task_index"} <= tables


def test_migrations_run_from_the_oldest_sdk_revision_with_data_present(pg_server, config):
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, LEGACY_DDL)

    async def go(engine):
        report = await schema.migrate_all(engine)
        async with engine.connect() as conn:
            tasks = (await conn.execute(sa.text("SELECT id, owner, last_updated, protocol_version FROM tasks ORDER BY id"))).all()
            pushes = (await conn.execute(sa.text("SELECT task_id, owner FROM push_notification_configs"))).all()
            cols = await conn.run_sync(table_columns, "tasks")
            versions_cols = await conn.run_sync(table_columns, "task_versions")
        return report, tasks, pushes, cols, versions_cols

    report, tasks, pushes, cols, versions_cols = run(_with_engine(config, go))
    assert report.sdk.before is None and not report.sdk.created_fresh and report.sdk.after == SDK_HEAD
    # The data is still there, and the three revisions' columns have arrived.
    assert [t.id for t in tasks] == ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
    assert {t.owner for t in tasks} == {"legacy_v03_no_user_info"}
    assert all(t.last_updated is None and t.protocol_version is None for t in tasks)
    assert [(p.task_id, p.owner) for p in pushes] == [("11111111-1111-1111-1111-111111111111", "legacy_v03_no_user_info")]
    assert {"owner", "last_updated", "protocol_version"} <= set(cols)
    assert set(versions_cols) == {"task_id", "owner", "version"}


def test_migrations_resume_from_a_recorded_middle_revision(pg_server, config):
    """A database an operator already moved part-way with `a2a-db`: the version table exists."""
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, LEGACY_DDL)

    def to_oldest(conn):
        command.upgrade(sdk_migrations._config(conn), OLDEST_SDK_REVISION)

    async def go(engine):
        async with engine.begin() as conn:
            await conn.run_sync(to_oldest)
        async with engine.connect() as conn:
            assert await conn.run_sync(sdk_migrations.read_revision) == OLDEST_SDK_REVISION
        report = await schema.migrate_all(engine)
        return report, await schema.versions(engine)

    report, versions = run(_with_engine(config, go))
    assert report.sdk.before == OLDEST_SDK_REVISION and report.sdk.after == SDK_HEAD
    assert versions.sdk_revision == SDK_HEAD


def test_fresh_schema_matches_the_one_built_by_upgrading(pg_db):
    """Create-and-stamp and upgrade-from-oldest end at the same columns and indexes."""
    fresh, legacy = pg_db(), pg_db()

    def shape(conn):
        insp = sa.inspect(conn)
        return {
            t: (
                {c["name"]: c["nullable"] for c in insp.get_columns(t)},
                sorted(i["name"] for i in insp.get_indexes(t)),
                insp.get_pk_constraint(t)["constrained_columns"],
            )
            for t in sdk_migrations.SDK_TABLES
        }

    async def fresh_shape(engine):
        await schema.migrate_all(engine)
        async with engine.connect() as conn:
            return await conn.run_sync(shape)

    async def legacy_shape(engine):
        async with engine.begin() as conn:
            for stmt in LEGACY_DDL.split(";"):
                if stmt.strip() and not stmt.strip().startswith("INSERT"):
                    await conn.execute(sa.text(stmt))
        await schema.migrate_all(engine)
        async with engine.connect() as conn:
            return await conn.run_sync(shape)

    a, b =run(_with_engine(fresh, fresh_shape)), run(_with_engine(legacy, legacy_shape))
    assert a == b


def test_a_revision_this_sdk_does_not_know_is_refused_and_nothing_changes(config):
    async def go(engine):
        await schema.migrate_all(engine)
        async with engine.begin() as conn:
            await conn.execute(sa.text("UPDATE a2a_alembic_version SET version_num = 'ffffffffffff'"))
        before = await _tables(engine)
        for call in (schema.preflight_all, schema.migrate_all):
            with pytest.raises(SchemaTooNew) as exc:
                await call(engine)
            assert "\n" not in str(exc.value) and "ffffffffffff" in str(exc.value)
        return before == await _tables(engine)

    assert run(_with_engine(config, go))


def test_a_newer_coord_schema_is_refused_before_the_sdk_stream_changes_anything(pg_server, config):
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, LEGACY_DDL)  # an old SDK shape that the SDK stream WOULD change
    pg_server.psql(
        db,
        "CREATE TABLE coord_schema_version (id integer primary key, version integer not null, "
        f"updated_at timestamptz not null, CHECK (id = 1)); INSERT INTO coord_schema_version VALUES (1, {LATEST + 3}, now())",
    )

    async def go(engine):
        with pytest.raises(SchemaTooNew, match=str(LATEST + 3)):
            await schema.migrate_all(engine)
        async with engine.connect() as conn:
            return await conn.run_sync(table_columns, "tasks"), await conn.run_sync(table_names)

    cols, tables = run(_with_engine(config, go))
    assert "owner" not in cols  # the SDK's revisions did not run
    assert "a2a_alembic_version" not in tables and "task_versions" not in tables


def test_a_failure_in_our_stream_rolls_back_the_sdk_stream_too(config, monkeypatch):
    def boom(conn):
        raise sa.exc.ProgrammingError("x", {}, Exception("boom"))

    monkeypatch.setattr(migrations, "STEPS", (*migrations.STEPS, Step(LATEST + 1, "boom", boom)))
    monkeypatch.setattr(migrations, "LATEST", LATEST + 1)

    async def go(engine):
        with pytest.raises(MigrationError):
            await schema.migrate_all(engine)
        return await _tables(engine)

    assert run(_with_engine(config, go)) == set()


def test_the_sdk_stream_needs_no_database_url_variable(config):
    """The SDK's own env.py reads DATABASE_URL (a URL with the password in it). Ours must not."""
    assert "DATABASE_URL" not in os.environ

    async def go(engine):
        await schema.migrate_all(engine)

    run(_with_engine(config, go))
    assert "DATABASE_URL" not in os.environ


def test_tasks_table_accepts_a_versioned_save_after_migration(config):
    """The tables the SDK stream builds are the ones its versioned store reads and writes."""
    from a2a.server.cluster.version import TaskVersion
    from a2a.server.context import ServerCallContext
    from a2a.types import a2a_pb2 as pb
    from a2a.server.cluster.database_task_store import VersionedDatabaseTaskStore

    async def go(engine):
        await schema.migrate_all(engine)
        store = VersionedDatabaseTaskStore(engine, create_table=False, owner_resolver=lambda ctx: "coord")
        task = pb.Task(id="33333333-3333-3333-3333-333333333333", context_id="c")
        task.status.state = pb.TaskState.TASK_STATE_SUBMITTED
        task.status.timestamp.FromDatetime(datetime.now(UTC).replace(tzinfo=None))
        ctx = ServerCallContext()
        v1 = await store.save(task, event=None, prev=None, prev_version=TaskVersion.MISSING, context=ctx)
        got = await store.get(task.id, ctx)
        return v1, got

    v1, got = run(_with_engine(config, go))
    assert v1 == TaskVersion(1) and got is not None and got.version == TaskVersion(1)
