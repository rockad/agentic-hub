import asyncio

import pytest

from coordination.config import Config
from coordination.store import connect
from coordination.store.connect import (
    ConnectParams,
    DatabaseUnavailable,
    DbConfigError,
    check_database,
    params_from,
    read_password,
    wait_for_database,
)

# Throwaway canary with characters that break naive URL or SQL building.
PW = "CANARY-test'q\\b$d%40@:/x"
URL = "postgresql+asyncpg://coordination@postgres:5432/coordination"


def test_params_from_url_keeps_password_separate_and_verbatim():
    p = params_from(URL, PW)
    assert (p.host, p.port, p.user, p.database) == ("postgres", 5432, "coordination", "coordination")
    assert p.kwargs()["password"] == PW
    assert PW not in repr(p) and "CANARY" not in repr(p)
    assert PW not in p.target


def test_port_defaults_and_percent_escapes_in_user_and_database():
    p = params_from("postgresql+asyncpg://we%40ird@db.example/my%20db", "x")
    assert (p.user, p.database, p.port) == ("we@ird", "my db", 5432)


def test_url_with_a_password_is_refused_without_echoing_it():
    with pytest.raises(DbConfigError) as e:
        params_from("postgresql+asyncpg://coordination:CANARY-inurl@postgres/coordination", PW)
    assert "CANARY" not in str(e.value)


@pytest.mark.parametrize(
    "url",
    ["mysql://u@h/d", "postgresql+asyncpg://postgres/coordination", "postgresql+asyncpg://u@h", "postgresql+asyncpg://u@h:99999999/d"],
)
def test_bad_urls(url):
    with pytest.raises(DbConfigError):
        params_from(url, "x")


def test_read_password_strips_trailing_newlines_only(tmp_path):
    f = tmp_path / "pw"
    f.write_bytes(b" a b \n\n")
    assert read_password(f) == " a b "
    f.write_bytes(b"")
    with pytest.raises(DbConfigError, match="empty"):
        read_password(f)
    with pytest.raises(DbConfigError, match="cannot read"):
        read_password(tmp_path / "missing")


def run(coro):
    return asyncio.run(coro)


def _params():
    return ConnectParams("h", 5432, "u", "d", PW)


def test_wait_returns_on_first_success():
    calls = []

    async def ping(p):
        calls.append(p)

    run(wait_for_database(_params(), ping=ping, log=lambda m: None))
    assert len(calls) == 1


def test_wait_retries_then_succeeds():
    n = {"i": 0}
    sleeps = []
    logs = []

    async def ping(p):
        n["i"] += 1
        if n["i"] < 4:
            raise ConnectionRefusedError("not yet")

    async def sleep(s):
        sleeps.append(s)

    run(wait_for_database(_params(), attempts=10, delay_s=0.5, ping=ping, sleep=sleep, log=logs.append))
    assert n["i"] == 4 and sleeps == [0.5, 0.5, 0.5]
    assert len(logs) == 3


def test_wait_gives_up_after_bounded_attempts_and_hides_password():
    n = {"i": 0}
    logs = []

    async def ping(p):
        n["i"] += 1
        raise RuntimeError(f"auth failed, password was {PW}")

    async def sleep(s):
        pass

    with pytest.raises(DatabaseUnavailable) as e:
        run(wait_for_database(_params(), attempts=3, ping=ping, sleep=sleep, log=logs.append))
    assert n["i"] == 3
    assert "after 3 attempts" in str(e.value) and "u@h:5432/d" in str(e.value)
    assert PW not in str(e.value) and all(PW not in m for m in logs)
    assert "***" in str(e.value)


def test_check_database_exits_nonzero_when_unreachable(tmp_path):
    f = tmp_path / "pw"
    f.write_text(PW)
    cfg = Config(db_url="postgresql+asyncpg://u@127.0.0.1:1/d", db_password_file=str(f))
    with pytest.raises(SystemExit) as e:
        check_database(cfg, attempts=2, delay_s=0)
    assert isinstance(e.value.code, str) and e.value.code.startswith("coordination: cannot connect")
    assert PW not in e.value.code


def test_check_database_exits_nonzero_when_password_file_missing(tmp_path):
    cfg = Config(db_password_file=str(tmp_path / "missing"))
    with pytest.raises(SystemExit) as e:
        check_database(cfg)
    assert "cannot read the database password file" in e.value.code


def test_module_exports_are_the_ones_app_uses():
    assert callable(connect.check_database)
