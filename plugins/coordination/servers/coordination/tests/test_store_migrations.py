"""Our migration stream and the engine, against a real Postgres (see conftest.py)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from conftest import run
from coordination.store import migrations
from coordination.store.engine import make_engine
from coordination.store.migrations import LATEST, MigrationError, SchemaTooNew, Step
from coordination.store.tables import api_keys, coord_schema_version, metadata, task_index

OUR_TABLES = sorted(metadata.tables)


def describe(conn: sa.Connection, names: list[str]) -> dict:
    """A comparable description of the named tables: columns, keys, indexes, checks."""
    insp = sa.inspect(conn)
    out = {}
    for name in names:
        out[name] = {
            "columns": [
                (c["name"], str(c["type"]), c["nullable"], str(c.get("default")))
                for c in insp.get_columns(name)
            ],
            "pk": insp.get_pk_constraint(name)["constrained_columns"],
            "indexes": sorted(
                (i["name"], tuple(i["column_names"]), bool(i["unique"])) for i in insp.get_indexes(name)
            ),
            "uniques": sorted((u["name"], tuple(u["column_names"])) for u in insp.get_unique_constraints(name)),
            "checks": sorted((c["name"], c["sqltext"]) for c in insp.get_check_constraints(name)),
        }
    return out


async def _with_engine(config, fn):
    engine = make_engine(config)
    try:
        return await fn(engine)
    finally:
        await engine.dispose()


def test_migrate_applies_all_steps_then_nothing(config):
    async def go(engine):
        first = await migrations.migrate(engine)
        second = await migrations.migrate(engine)
        return first, second, await migrations.current_version(engine)

    first, second, version = run(_with_engine(config, go))
    assert first == list(range(1, LATEST + 1))
    assert second == []  # migrations run twice with no change
    assert version == LATEST


def test_schema_at_head_equals_tables_py(pg_server, pg_db):
    """The frozen DDL in the steps and `tables.py` describe the same schema."""
    migrated, created = pg_db(), pg_db()

    async def describe_only(engine):
        async with engine.connect() as conn:
            return await conn.run_sync(describe, OUR_TABLES)

    async def via_migrations(engine):
        await migrations.migrate(engine)
        async with engine.connect() as conn:
            return await conn.run_sync(describe, OUR_TABLES)

    async def via_metadata(engine):
        async with engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
        async with engine.connect() as conn:
            return await conn.run_sync(describe, OUR_TABLES)

    from_migrations = run(_with_engine(migrated, via_migrations))
    assert from_migrations == run(_with_engine(created, via_metadata))
    # Not vacuous: the description really holds our tables, their columns and their indexes.
    assert set(from_migrations) == set(OUR_TABLES)
    assert len(from_migrations["task_index"]["columns"]) == len(task_index.c)
    assert ("ix_task_index_to_handle", ("to_handle",), False) in from_migrations["task_index"]["indexes"]
    # Positive control: a real one-column difference in the database is detected.
    pg_server.psql(created.db_url.rsplit("/", 1)[1], "ALTER TABLE api_keys DROP COLUMN peer_id")
    assert run(_with_engine(created, describe_only)) != from_migrations


def test_version_table_is_single_row(config):
    async def go(engine):
        await migrations.migrate(engine)
        async with engine.begin() as conn:
            rows = (await conn.execute(sa.select(coord_schema_version))).all()
            assert [(r.id, r.version) for r in rows] == [(1, LATEST)]
            assert rows[0].updated_at.tzinfo is not None
            with pytest.raises(sa.exc.IntegrityError):
                async with conn.begin_nested():
                    await conn.execute(
                        coord_schema_version.insert().values(id=2, version=1, updated_at=datetime.now(UTC))
                    )

    run(_with_engine(config, go))


def test_newer_schema_is_refused_and_nothing_changes(config):
    async def go(engine):
        await migrations.migrate(engine)
        async with engine.begin() as conn:
            await conn.execute(coord_schema_version.update().values(version=LATEST + 7))
        for call in (migrations.preflight, migrations.migrate):
            with pytest.raises(SchemaTooNew) as exc:
                await call(engine)
            message = str(exc.value)
            assert "\n" not in message
            assert str(LATEST + 7) in message and str(LATEST) in message
        async with engine.connect() as conn:
            return (await conn.execute(sa.select(coord_schema_version.c.version))).scalar_one()

    assert run(_with_engine(config, go)) == LATEST + 7  # untouched by the refused run


def test_preflight_creates_nothing_on_an_empty_database(config):
    async def go(engine):
        assert await migrations.preflight(engine) == 0
        async with engine.connect() as conn:
            return await conn.run_sync(lambda c: sa.inspect(c).get_table_names())

    assert run(_with_engine(config, go)) == []


def test_failed_step_rolls_back_everything(config, monkeypatch):
    def boom(conn):
        conn.execute(sa.text("CREATE TABLE half_done (x integer)"))
        conn.execute(sa.text("SELECT * FROM no_such_table_secret_name"))

    monkeypatch.setattr(migrations, "STEPS", (*migrations.STEPS, Step(LATEST + 1, "boom", boom)))
    monkeypatch.setattr(migrations, "LATEST", LATEST + 1)

    async def go(engine):
        with pytest.raises(MigrationError) as exc:
            await migrations.migrate(engine)
        assert "\n" not in str(exc.value) and "no_such_table_secret_name" not in str(exc.value)
        async with engine.connect() as conn:
            return await conn.run_sync(lambda c: sa.inspect(c).get_table_names())

    # The whole run is one transaction: not even step 1 or the version table survived.
    assert run(_with_engine(config, go)) == []


def test_a_table_that_already_exists_without_a_record_fails_loudly(config):
    async def go(engine):
        async with engine.begin() as conn:
            await conn.execute(sa.text("CREATE TABLE api_keys (key_id text)"))
        with pytest.raises(MigrationError, match="migration 1"):
            await migrations.migrate(engine)

    run(_with_engine(config, go))


def test_api_keys_and_task_index_round_trip(config):
    now = datetime.now(UTC)

    async def go(engine):
        await migrations.migrate(engine)
        async with engine.begin() as conn:
            await conn.execute(
                api_keys.insert().values(
                    key_id="3f9c01ab", env="dev", name="claude on box", scope="local-harness",
                    card_id="claude-code@box", cards_allowed=["a@b", "c@d"], secret_hash="0" * 64,
                    created_at=now, expires_at=now + timedelta(days=365),
                )
            )
            await conn.execute(
                task_index.insert().values(task_id="t" * 36, from_principal="3f9c01ab", origin="local", to_card="x@y")
            )
        async with engine.connect() as conn:
            key = (await conn.execute(sa.select(api_keys))).one()
            row = (await conn.execute(sa.select(task_index))).one()
        assert key.cards_allowed == ["a@b", "c@d"]
        assert key.created_at == now and key.created_at.tzinfo is not None
        assert key.revoked_at is None and key.last_used_at is None
        assert row.offer_count == 0 and row.hold is None
        async with engine.begin() as conn:
            with pytest.raises(sa.exc.IntegrityError):  # key_id is the primary key
                await conn.execute(
                    api_keys.insert().values(
                        key_id="3f9c01ab", env="dev", name="dup", scope="local-harness", secret_hash="x",
                        created_at=now, expires_at=now,
                    )
                )

    run(_with_engine(config, go))


# -- the engine -------------------------------------------------------------------------------


def test_engine_keeps_the_password_out_of_every_representation(pg_server, pg_db):
    cfg = pg_db()
    engine = make_engine(cfg)
    try:
        password = pg_server.password
        assert password not in str(engine.url) and password not in repr(engine) and password not in repr(engine.url)
        assert engine.url.password is None  # the password is a connect argument, not part of the URL

        async def ping():
            async with engine.connect() as conn:
                return (await conn.execute(sa.text("SELECT 1"))).scalar_one()

        assert run(ping()) == 1
    finally:
        run(engine.dispose())


def test_engine_with_a_wrong_password_fails_without_leaking_it(pg_db, tmp_path):
    wrong = tmp_path / "wrong"
    wrong.write_text("CANARY-wrong-password-value\n")
    wrong.chmod(0o600)
    cfg = pg_db(db_password_file=str(wrong))

    async def go(engine):
        async with engine.connect():
            pass

    with pytest.raises(Exception) as exc:  # noqa: PT011 - any driver error will do
        run(_with_engine(cfg, go))
    assert "CANARY-wrong-password-value" not in f"{exc.value!r} {exc.value}"


def test_engine_survives_a_dead_connection_in_the_pool(pg_server, pg_db):
    """pool_pre_ping: a connection killed on the server side is replaced, not handed out dead."""
    cfg = pg_db()
    database = cfg.db_url.rsplit("/", 1)[1]

    async def go(engine):
        async with engine.connect() as conn:
            await conn.execute(sa.text("SELECT 1"))
        pg_server.psql(
            "postgres",
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{database}' AND pid <> pg_backend_pid()",
        )
        async with engine.connect() as conn:
            return (await conn.execute(sa.text("SELECT 2"))).scalar_one()

    assert run(_with_engine(cfg, go)) == 2
