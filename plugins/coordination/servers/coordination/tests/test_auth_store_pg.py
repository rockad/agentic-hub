"""S1-AUTH against a real Postgres: the SQL key store, the middleware on it, and the canary scan.

The canary scan answers the plan's acceptance line: after a key is created and used, its secret is
not in the database, the logs or the audit. The database is searched as text, through a plain-text
rendering of a `pg_dump -Fc` file (`pg_restore -f -`): a `-Fc` file is binary and compressed, so
`rg` over the raw file proves nothing. The scan has a positive control: a known string written to
a table is found by the same rendering and search.
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import logging
import os
import secrets
import subprocess
from datetime import timedelta

import pytest
import sqlalchemy as sa
from auth_helpers import NOW, FixedClock, bearer, client_for, make_config, make_record, probe_app
from conftest import PG_USER, free_port, run
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from coordination.audit import AuditLog, AuditRow
from coordination.auth import LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT, ApiKeyRecord, SqlApiKeyStore, generate_key, parse_key
from coordination.logging import configure_logging
from coordination.store import schema
from coordination.store.connect import params_from_config
from coordination.store.tables import api_keys, audit as audit_table


def null_pool_engine(config):
    """An engine without a pool: the tests use it from several event loops (asyncio.run and the
    test client's own loop), and a pooled asyncpg connection is bound to the loop that made it."""
    p = params_from_config(config)
    url = URL.create("postgresql+asyncpg", username=p.user, host=p.host, port=p.port, database=p.database)
    return create_async_engine(url, poolclass=NullPool, connect_args={"password": p.password}, hide_parameters=True)


class SqlAuditStore:
    """Test-side `AuditStore` over the real `audit` table. (S1-STATE owns the production one.)"""

    def __init__(self, engine):
        self.engine = engine

    async def append_audit(self, row: AuditRow) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(
                sa.insert(audit_table).values(
                    at=row.at, actor=row.actor, event=row.event.value, subject=row.subject, detail_json=dict(row.detail)
                )
            )


@pytest.fixture
def db(pg_db):
    """A migrated database: (config, engine)."""
    config = pg_db()
    engine = null_pool_engine(config)
    run(schema.migrate_all(engine))
    yield config, engine
    run(engine.dispose())


def record_of(token_record) -> ApiKeyRecord:
    return token_record[1]


# the SQL store ----------------------------------------------------------------------------------


def test_insert_and_get_round_trip_every_field(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    token, rec = make_record(
        REMOTE_PEER,
        peer_id="peer-1",
        card_id="claude-code@box",
        cards_allowed=("claude-code@box", "antigravity@box"),
        tailnet_node="box",
        tailnet_login="a@example.test",
    )
    run(store.insert(rec))
    got = run(store.get(rec.key_id))
    assert got == rec and isinstance(got.cards_allowed, tuple)
    assert token not in repr(got)


def test_get_of_an_unknown_id_is_none_and_a_duplicate_id_raises(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    assert run(store.get("00000000")) is None
    _, rec = make_record(LOCAL_HARNESS)
    run(store.insert(rec))
    with pytest.raises(sa.exc.IntegrityError):
        run(store.insert(rec))


def test_a_record_without_a_card_list_round_trips_as_none(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    _, rec = make_record(LOCAL_HARNESS)
    run(store.insert(rec))
    assert run(store.get(rec.key_id)).cards_allowed is None


def test_revoke_marks_the_key_once(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    _, rec = make_record(LOCAL_HARNESS)
    run(store.insert(rec))
    assert run(store.revoke(rec.key_id, NOW)) is True
    assert run(store.get(rec.key_id)).revoked_at == NOW
    assert run(store.revoke(rec.key_id, NOW + timedelta(hours=1))) is False  # not moved
    assert run(store.get(rec.key_id)).revoked_at == NOW
    assert run(store.revoke("00000000", NOW)) is False


def test_touch_writes_at_most_once_a_minute(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    _, rec = make_record(LOCAL_HARNESS)
    run(store.insert(rec))
    run(store.touch(rec.key_id, NOW))
    assert run(store.get(rec.key_id)).last_used_at == NOW
    run(store.touch(rec.key_id, NOW + timedelta(seconds=59)))
    assert run(store.get(rec.key_id)).last_used_at == NOW
    run(store.touch(rec.key_id, NOW + timedelta(seconds=61)))
    assert run(store.get(rec.key_id)).last_used_at == NOW + timedelta(seconds=61)


def test_the_table_is_the_one_migration_1_made_and_needs_no_new_column(db):
    _, engine = db

    async def columns():
        async with engine.connect() as conn:
            return await conn.run_sync(lambda c: {col["name"] for col in sa.inspect(c).get_columns("api_keys")})

    assert run(columns()) == {c.name for c in api_keys.columns}
    assert run(schema.versions(engine)).coord_schema_version == 2  # S1-AUTH adds no migration


# the middleware on the SQL store ----------------------------------------------------------------


def test_the_middleware_on_postgres_matrix_sample_and_immediate_revocation(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    clock = FixedClock()
    client = client_for(probe_app(make_config(status_enabled=True), store, clock=clock))

    def issue(scope, **kw):
        token, rec = make_record(scope, **kw)
        run(store.insert(rec))
        return token

    assert client.post("/mcp").status_code == 401  # loopback, no key
    good = issue(LOCAL_HARNESS)
    assert client.post("/mcp", headers=bearer(good)).status_code == 200
    assert client.post("/mcp", headers=bearer(issue(REMOTE_PEER))).status_code == 403
    assert client.post("/a2a/v1", headers=bearer(issue(REMOTE_PEER))).status_code == 200
    assert client.post("/status", headers=bearer(issue(STATUS_CLIENT))).status_code == 200
    assert client.post("/mcp", headers=bearer(issue(LOCAL_HARNESS, expires_in=timedelta(seconds=-1)))).status_code == 401
    assert client.post("/mcp", headers=bearer(issue(LOCAL_HARNESS, revoked=True))).status_code == 401
    assert client.post("/mcp", headers=bearer(issue(LOCAL_HARNESS, env="live"))).status_code == 401
    # revoke the good key in the database: the very next request is refused
    assert run(store.revoke(parse_key(good).key_id, NOW)) is True
    assert client.post("/mcp", headers=bearer(good)).status_code == 401


def test_a_dev_key_is_refused_by_a_live_server_on_postgres(db):
    _, engine = db
    store = SqlApiKeyStore(engine)
    dev_token, dev_rec = make_record(LOCAL_HARNESS, env="dev")
    live_token, live_rec = make_record(LOCAL_HARNESS, env="live")
    run(store.insert(dev_rec))
    run(store.insert(live_rec))
    live = client_for(probe_app(make_config(env="live"), store))
    assert live.post("/mcp", headers=bearer(dev_token)).status_code == 401  # spec 8.2: a dev key never works live
    assert live.post("/mcp", headers=bearer(live_token)).status_code == 200
    dev = client_for(probe_app(make_config(env="dev"), store))
    assert dev.post("/mcp", headers=bearer(dev_token)).status_code == 200
    assert dev.post("/mcp", headers=bearer(live_token)).status_code == 401


def test_a_database_that_cannot_be_reached_fails_closed(db):
    config, _ = db
    dead_url = f"postgresql+asyncpg://{PG_USER}@127.0.0.1:{free_port()}/nothing"  # nothing listens there
    broken = null_pool_engine(dataclasses.replace(config, db_url=dead_url))
    store = SqlApiKeyStore(broken)
    token, _ = make_record(LOCAL_HARNESS)
    client = client_for(probe_app(make_config(), store))
    r = client.post("/mcp", headers=bearer(token))
    assert r.status_code == 503 and token not in r.text
    assert client.post("/mcp").status_code == 401  # no key: refused before the database is asked
    run(broken.dispose())


# the canary scan: database, logs, audit ---------------------------------------------------------


def plain_text_dump(pg_server, database: str) -> str:
    """`pg_dump -Fc` rendered as plain text by `pg_restore -f -`, all inside the container."""
    proc = subprocess.run(
        [
            "docker", "exec", "-i", "-e", "PGPASSWORD", pg_server.name, "sh", "-c",
            f"pg_dump -Fc -h 127.0.0.1 -U {PG_USER} -d {database} | pg_restore -f -",
        ],
        capture_output=True, text=True, check=False, env={**os.environ, "PGPASSWORD": pg_server.password},
    )  # fmt: skip
    assert proc.returncode == 0, proc.stderr[:300]
    return proc.stdout


def hits(haystack: str, needles) -> list[str]:
    return [n for n in needles if n and n in haystack]


@pytest.fixture
def canary_files(tmp_path_factory):
    """A throwaway pepper and a throwaway control string, written 0600 outside the repository."""
    d = tmp_path_factory.mktemp("canary")
    out = {}
    for name, value in (("pepper", secrets.token_urlsafe(32)), ("control", f"CONTROL-{secrets.token_hex(12)}")):
        f = d / name
        f.write_text(value)
        os.chmod(f, 0o600)
        assert (f.stat().st_mode & 0o777) == 0o600
        out[name] = f.read_text()
    return out


def test_a_created_and_used_key_secret_is_nowhere_in_the_database_the_logs_or_the_audit(db, pg_server, canary_files):
    config, engine = db
    database = config.db_url.rsplit("/", 1)[1]
    pepper, control = canary_files["pepper"], canary_files["control"]

    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    log_stream = io.StringIO()
    configure_logging("debug", stream=log_stream, secrets=(pepper,))
    try:
        clock = FixedClock()
        store = SqlApiKeyStore(engine)
        audit = AuditLog(SqlAuditStore(engine), clock)
        app_config = make_config(status_enabled=True, key_pepper=pepper)
        client = client_for(probe_app(app_config, store, clock=clock, audit=audit))

        # create two keys the way `a2a-coord key create` will: generate, store hash, show token once
        keys = {}
        for scope in (LOCAL_HARNESS, REMOTE_PEER):
            key = generate_key("dev", pepper)
            rec = ApiKeyRecord(
                key_id=key.key_id, env="dev", name=f"canary-{scope}", scope=scope, secret_hash=key.secret_hash,
                created_at=NOW, expires_at=NOW + timedelta(days=30),
            )  # fmt: skip
            run(store.insert(rec))
            run(audit.key_created(actor="admin", key_id=key.key_id, scope=scope))
            keys[scope] = key.token
        # a positive control row: a plain string that must be found by the scan
        _, control_rec = make_record(STATUS_CLIENT)
        run(store.insert(dataclasses.replace(control_rec, name=control)))

        # use them: successes, a wrong scope, bad secrets and malformed tokens (all logged and audited)
        local, peer = keys[LOCAL_HARNESS], keys[REMOTE_PEER]
        responses = [
            client.post("/mcp", headers=bearer(local), content=b"BODY-canary"),
            client.post("/a2a/v1", headers=bearer(peer)),
            client.post("/mcp", headers=bearer(peer)),
            client.post("/mcp", headers=bearer(local[:-1] + ("A" if local[-1] != "A" else "B"))),
            client.post("/mcp", headers=bearer(local + "x")),
            client.post("/mcp", headers={"Authorization": f"Basic {local}"}),
            client.post("/mcp"),
        ]
        assert [r.status_code for r in responses] == [200, 200, 403, 401, 401, 401, 401]
        run(audit.flush_auth_failures(force=True))

        secrets_ = {s: parse_key(t).secret for s, t in keys.items()}
        needles = [*keys.values(), *secrets_.values(), pepper]
        db_text = plain_text_dump(pg_server, database)
        log_text = log_stream.getvalue()
        audit_rows = run(_audit_text(engine))
        response_text = "".join(r.text + str(r.headers) for r in responses)
    finally:
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)

    # positive controls: the scan can see what is there
    assert hits(db_text, [control]) == [control]  # a plain string in a table is found
    for key_id in (parse_key(t).key_id for t in keys.values()):
        assert key_id in db_text  # the key ids are stored in clear
    assert "sha256" in db_text  # and so are the hashes, which are not secrets
    assert "COPY public.api_keys" in db_text and "COPY public.audit" in db_text  # both tables are in the render
    assert "key_created" in audit_rows and "auth_failure_sampled" in audit_rows  # the audit has rows
    assert log_text.count("\n") >= 1 and "api key refused" in log_text  # the log has lines

    # the scan
    assert hits(db_text, needles) == [], "database"
    assert hits(audit_rows, needles) == [], "audit"
    assert hits(log_text, needles) == [], "logs"
    assert hits(response_text, needles) == [], "responses"


def test_the_scan_would_catch_a_secret_if_one_were_stored(db, pg_server):
    """Negative control: put a key secret into a column and the same scan finds it."""
    config, engine = db
    database = config.db_url.rsplit("/", 1)[1]
    key = generate_key("dev")
    secret = parse_key(key.token).secret
    _, rec = make_record(LOCAL_HARNESS)
    run(SqlApiKeyStore(engine).insert(dataclasses.replace(rec, name=f"oops {secret}")))
    assert hits(plain_text_dump(pg_server, database), [secret]) == [secret]


async def _audit_text(engine) -> str:
    async with engine.connect() as conn:
        rows = (await conn.execute(sa.select(audit_table))).all()
    return json.dumps([[r.actor, r.event, r.subject, r.detail_json] for r in rows], default=str)
