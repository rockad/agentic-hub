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


def test_expose_check_pre_flip_s2_passes_without_public_host_or_pepper(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        last_ok.write_text("2026-11-27T10:00:00Z\n", encoding="utf-8")

        config = Config(
            exposure_stage="s2",
            public_url="https://box.tail1234.ts.net",
            allowed_hosts=("127.0.0.1:8120", "box.tail1234.ts.net"),
            key_pepper="",
            dump_last_ok_file=str(last_ok),
        )
        status_admin = StatusAdmin(
            config,
            FakeClock(now),
            FakeEngine(),
            FakeKeyAdminStore(),
            CardRegistry({}),
            remote_quarantine_enforced=True,
            rate_limits_and_guess_counter_enabled=True,
            public_listener_loopback_bound=True,
        )
        res = await status_admin.expose_check()

        assert res["ok"] is True
        assert res["problems"] == []
        assert len(res["manual"]) == 4
        by_item = {c["item"]: c for c in res["checks"]}
        assert by_item["public_url_https"]["status"] == "pass"
        assert by_item["allowed_hosts_public"]["status"] == "pass"
        assert by_item["key_pepper"]["status"] == "info"
        assert by_item["backup_dump_fresh"]["status"] == "pass"

    run(go())


def test_expose_check_s3_all_pass(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        last_ok.write_text("2026-11-27T10:00:00Z\n", encoding="utf-8")

        config = Config(
            exposure_stage="s3",
            public_url="https://a2a.example.org",
            allowed_hosts=("a2a.example.org", "127.0.0.1:8120"),
            key_pepper="secret-pepper",
            dump_last_ok_file=str(last_ok),
        )
        status_admin = StatusAdmin(
            config,
            FakeClock(now),
            FakeEngine(),
            FakeKeyAdminStore(),
            CardRegistry({}),
            remote_quarantine_enforced=True,
            rate_limits_and_guess_counter_enabled=True,
            public_listener_loopback_bound=True,
        )
        res = await status_admin.expose_check()

        assert res["ok"] is True
        assert res["problems"] == []
        assert len(res["manual"]) == 4
        assert any(m["item"] == "fuzz_report" for m in res["manual"])
        assert all(c["status"] == "pass" for c in res["checks"])

    run(go())


def test_expose_check_fails_closed_on_missing_x5_flags_and_36h_boundary(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        # Exactly 36.0 hours old: spec says "below 36 h", so 36.0 must fail
        last_ok.write_text("2026-11-26T00:00:00Z\n", encoding="utf-8")

        config = Config(
            exposure_stage="s3",
            public_url="http://127.0.0.1:8120",  # loopback not https
            allowed_hosts=("127.0.0.1:8120", "*"),
            key_pepper="secret-pepper",
            dump_last_ok_file=str(last_ok),
        )
        status_admin = StatusAdmin(config, FakeClock(now), FakeEngine(), FakeKeyAdminStore(), CardRegistry({}))
        res = await status_admin.expose_check()

        assert res["ok"] is False
        by_item = {c["item"]: c for c in res["checks"]}
        assert by_item["rate_limits_and_guess_counter"]["status"] == "fail"
        assert by_item["public_listener_loopback"]["status"] == "fail"
        assert by_item["backup_dump_fresh"]["status"] == "fail"
        assert by_item["allowed_hosts_public"]["status"] == "fail"
        assert by_item["public_url_https"]["status"] == "fail"
        for p in res["problems"]:
            assert "secret-pepper" not in p

    run(go())


def test_expose_check_sanitizes_hosts_in_details_and_problems(tmp_path):
    async def go():
        last_ok = tmp_path / "last_ok"
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
        last_ok.write_text("2026-11-27T10:00:00Z\n", encoding="utf-8")

        config = Config(
            exposure_stage="s3",
            public_url="https://a2a.example.org/\x1b[31m\u202ebad",
            allowed_hosts=("other\x1b[31m.example.org\u202e",),
            key_pepper="",
            dump_last_ok_file=str(last_ok),
        )
        status_admin = StatusAdmin(
            config,
            FakeClock(now),
            FakeEngine(),
            FakeKeyAdminStore(),
            CardRegistry({}),
            remote_quarantine_enforced=True,
            rate_limits_and_guess_counter_enabled=True,
            public_listener_loopback_bound=True,
        )
        res = await status_admin.expose_check()
        assert res["ok"] is False
        for c in res["checks"]:
            assert "\x1b" not in c["detail"] and "\u202e" not in c["detail"]
        for p in res["problems"]:
            assert "\x1b" not in p and "\u202e" not in p

    run(go())


def test_expose_check_database_unreachable_raises_unavailable():
    async def go():
        last_ok = Path("/nonexistent")
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)

        config = Config(
            exposure_stage="s2",
            public_url="https://box.tail1234.ts.net",
            allowed_hosts=("127.0.0.1:8120", "box.tail1234.ts.net"),
            key_pepper="",
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

        status_admin = StatusAdmin(config, clock, BadEngine(), FakeKeyAdminStore(), CardRegistry({}))
        with pytest.raises(AdminError) as exc_info:
            await status_admin.expose_check()
        assert exc_info.value.code == "unavailable"

    run(go())
