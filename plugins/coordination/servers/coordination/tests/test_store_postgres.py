"""`PostgresStore` and the start-up check, against a real Postgres."""

from __future__ import annotations

import sqlalchemy as sa
import pytest

from conftest import run
from coordination.store import schema
from coordination.store.connect import check_database
from coordination.store.migrations import LATEST, SchemaTooNew
from coordination.store.postgres import PostgresStore
from coordination.store.protocol import Store
from coordination.store.retention import RetentionJob
from coordination.store.task_store import CoordTaskStore
from store_helpers import FakeClock, S, entry, new_task


def test_start_migrates_both_streams_and_stop_releases_the_pool(config):
    async def go():
        store = PostgresStore(config, clock=FakeClock())
        assert isinstance(store, Store)
        assert await store.ping() is False  # not started
        with pytest.raises(RuntimeError, match="not started"):
            _ = store.tasks
        await store.start()
        try:
            assert await store.ping() is True
            assert await store.schema_version() == LATEST
            assert isinstance(store.tasks, CoordTaskStore) and isinstance(store.retention, RetentionJob)
            await store.tasks.create(new_task(task_id="t1"), entry())
            versions = await schema.versions(store.engine)
            assert versions.sdk_revision is not None and versions.coord_schema_version == LATEST
        finally:
            await store.stop()
        assert await store.ping() is False

    run(go())


def test_a_second_start_changes_nothing_and_keeps_the_data(config):
    async def go():
        first = PostgresStore(config)
        await first.start()
        await first.tasks.create(new_task(task_id="keep"), entry())
        await first.stop()
        second = PostgresStore(config)
        await second.start()
        try:
            return await second.tasks.get("keep"), (await schema.migrate_all(second.engine)).changed
        finally:
            await second.stop()

    stored, changed = run(go())
    assert stored is not None and stored.task.status.state == S.TASK_STATE_SUBMITTED
    assert changed is False


def test_start_refuses_a_newer_schema_and_leaves_no_engine_behind(config, pg_server):
    db = config.db_url.rsplit("/", 1)[1]

    async def go():
        store = PostgresStore(config)
        await store.start()
        await store.stop()
        pg_server.psql(db, f"UPDATE coord_schema_version SET version = {LATEST + 1}")
        again = PostgresStore(config)
        with pytest.raises(SchemaTooNew):
            await again.start()
        assert await again.ping() is False

    run(go())


def test_check_database_migrates_then_a_rerun_is_quiet(config, pg_server):
    check_database(config, attempts=3, delay_s=0)
    check_database(config, attempts=3, delay_s=0)  # a second start: nothing to do, no error
    db = config.db_url.rsplit("/", 1)[1]
    assert pg_server.psql(db, "SELECT version FROM coord_schema_version") == str(LATEST)
    assert pg_server.psql(db, "SELECT count(*) FROM a2a_alembic_version") == "1"


def test_check_database_exits_nonzero_with_a_one_line_reason_on_a_newer_schema(config, pg_server):
    check_database(config, attempts=3, delay_s=0)
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, f"UPDATE coord_schema_version SET version = {LATEST + 4}")
    with pytest.raises(SystemExit) as exc:
        check_database(config, attempts=3, delay_s=0)
    reason = exc.value.code
    assert isinstance(reason, str) and reason.startswith("coordination: ")  # non-zero exit status
    assert "\n" not in reason and str(LATEST + 4) in reason and "newer" in reason
    assert pg_server.psql(db, "SELECT version FROM coord_schema_version") == str(LATEST + 4)  # untouched


def test_check_database_exits_nonzero_on_a_newer_sdk_revision(config, pg_server):
    check_database(config, attempts=3, delay_s=0)
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, "UPDATE a2a_alembic_version SET version_num = 'ffffffffffff'")
    with pytest.raises(SystemExit) as exc:
        check_database(config, attempts=3, delay_s=0)
    assert "\n" not in exc.value.code and "ffffffffffff" in exc.value.code


def test_the_connection_is_plain_postgres_with_no_sqlite_setup(config):
    """No PRAGMA, no BEGIN IMMEDIATE: the connection is a plain Postgres one (D4)."""

    async def go():
        store = PostgresStore(config)
        await store.start()
        try:
            async with store.engine.connect() as conn:
                app = (await conn.execute(sa.text("SHOW application_name"))).scalar_one()
                dialect = conn.dialect.name
            return app, dialect
        finally:
            await store.stop()

    assert run(go()) == ("a2a-coord", "postgresql")
