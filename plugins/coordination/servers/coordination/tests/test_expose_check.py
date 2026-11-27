"""Tests for `expose check` (S3-EXPOSE-CHECK)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import pytest
import sqlalchemy as sa

from conftest import run
from coordination.admin.ops import AdminOps
from coordination.admin.protocol import AdminError
from coordination.admin.status import StatusAdmin
from coordination.admin.keystore import KeyAdminStore
from coordination.a2a.cards import CardRegistry
from coordination.clock import Clock
from coordination.config import Config


class FakeClock(Clock):
    def __init__(self, t: datetime) -> None:
        self._t = t

    def now(self) -> datetime:
        return self._t


class FakeKeyAdminStore(KeyAdminStore):
    async def list_all(self) -> list:
        return []


def test_expose_check_all_pass(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        last_ok.write_text("2026-11-27T10:00:00Z\n", encoding="utf-8")

        config = Config(
            public_url="https://a2a.example.org",
            allowed_hosts=("a2a.example.org", "127.0.0.1:8120"),
            key_pepper="secret-pepper",
            dump_last_ok_file=str(last_ok),
        )
        clock = FakeClock(now)

        class FakeConnection:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def execute(self, stmt):
                return None

        class FakeEngine:
            def connect(self):
                return FakeConnection()

        engine = FakeEngine()
        registry = CardRegistry({})
        keys = FakeKeyAdminStore()

        status_admin = StatusAdmin(config, clock, engine, keys, registry)
        res = await status_admin.expose_check()

        assert res["ok"] is True
        assert len(res["problems"]) == 0
        assert len(res["manual"]) == 4
        assert any(m["item"] == "fuzz_report" for m in res["manual"])

    run(go())


def test_expose_check_failures(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        # Stale dump (40 hours old)
        last_ok.write_text("2026-11-25T20:00:00Z\n", encoding="utf-8")

        config = Config(
            public_url="http://127.0.0.1:8120",  # loopback not https
            allowed_hosts=("127.0.0.1:8120",),
            key_pepper="",  # missing pepper
            dump_last_ok_file=str(last_ok),
        )
        clock = FakeClock(now)

        class FakeConnection:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

            async def execute(self, stmt):
                return None

        class FakeEngine:
            def connect(self):
                return FakeConnection()

        engine = FakeEngine()
        registry = CardRegistry({})
        keys = FakeKeyAdminStore()

        status_admin = StatusAdmin(config, clock, engine, keys, registry)
        res = await status_admin.expose_check()

        assert res["ok"] is False
        assert len(res["problems"]) >= 3
        for p in res["problems"]:
            assert "secret-pepper" not in p

    run(go())


def test_expose_check_database_unreachable():
    async def go():
        last_ok = Path("/nonexistent")
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)

        config = Config(
            public_url="https://a2a.example.org",
            allowed_hosts=("a2a.example.org",),
            key_pepper="pepper",
            dump_last_ok_file=str(last_ok),
        )
        clock = FakeClock(now)

        class BadConnection:
            async def __aenter__(self):
                raise sa.exc.SQLAlchemyError("boom")

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass

        class BadEngine:
            def connect(self):
                return BadConnection()

        engine = BadEngine()
        registry = CardRegistry({})
        keys = FakeKeyAdminStore()

        status_admin = StatusAdmin(config, clock, engine, keys, registry)
        res = await status_admin.expose_check()
        assert res["ok"] is False
        assert any("database is unreachable" in p for p in res["problems"])

    run(go())
