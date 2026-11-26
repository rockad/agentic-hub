"""Unit tests for `StatusAdmin.status()` backup freshness and `stale` flag."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

from auth_helpers import FixedClock, make_config
from conftest import run
from coordination.a2a.cards import CardRegistry
from coordination.admin.keystore import InMemoryKeyAdminStore
from coordination.admin.status import StatusAdmin
from coordination.store import schema


class _FakeResult:
    def __init__(self, *, one: Any = None, all_rows: list[Any] | None = None, scalar: Any = None) -> None:
        self._one = one
        self._all = all_rows or []
        self._scalar = scalar

    def one(self) -> Any:
        return self._one

    def all(self) -> list[Any]:
        return self._all

    def scalar_one(self) -> Any:
        return self._scalar


class _FakeConn:
    def __init__(self) -> None:
        self._calls = 0

    async def execute(self, _stmt: Any) -> _FakeResult:
        self._calls += 1
        if self._calls == 1:
            return _FakeResult(one=(0, 0, 0, 0))
        if self._calls in (4, 6):
            return _FakeResult(scalar=0)
        return _FakeResult(all_rows=[])


class _FakeConnectCtx:
    async def __aenter__(self) -> _FakeConn:
        return _FakeConn()

    async def __aexit__(self, *args: object) -> None:
        return None


class _FakeEngine:
    def connect(self) -> _FakeConnectCtx:
        return _FakeConnectCtx()


def _status_for(monkeypatch, last_ok_path: Path, clock: FixedClock) -> dict[str, Any]:
    async def fake_versions(_engine: Any) -> schema.Versions:
        return schema.Versions(coord_schema_version=4, sdk_revision="rev1")

    monkeypatch.setattr(schema, "versions", fake_versions)
    admin = StatusAdmin(
        make_config(dump_last_ok_file=str(last_ok_path)),
        clock,
        _FakeEngine(),  # type: ignore[arg-type]
        InMemoryKeyAdminStore(),
        CardRegistry(),
    )
    return run(admin.status())


def test_status_backup_fresh_dump_is_not_stale(monkeypatch, tmp_path):
    clock = FixedClock()
    last_ok = tmp_path / "last_ok"
    last_ok.write_text((clock.now() - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ\n"))
    res = _status_for(monkeypatch, last_ok, clock)
    assert res["backup"] == {"dump_age_h": 2.0, "stale": False}

    # Exact 36.0h boundary is not stale (strictly > 36h is stale).
    last_ok.write_text((clock.now() - timedelta(hours=36)).strftime("%Y-%m-%dT%H:%M:%SZ\n"))
    res_boundary = _status_for(monkeypatch, last_ok, clock)
    assert res_boundary["backup"] == {"dump_age_h": 36.0, "stale": False}


def test_status_backup_stale_dump_over_36h_sets_stale_true(monkeypatch, tmp_path):
    clock = FixedClock()
    last_ok = tmp_path / "last_ok"
    last_ok.write_text((clock.now() - timedelta(hours=40)).strftime("%Y-%m-%dT%H:%M:%SZ\n"))
    res = _status_for(monkeypatch, last_ok, clock)
    assert res["backup"] == {"dump_age_h": 40.0, "stale": True}


def test_status_backup_missing_last_ok_is_unknown_and_not_stale(monkeypatch, tmp_path):
    clock = FixedClock()
    res = _status_for(monkeypatch, tmp_path / "missing_last_ok", clock)
    assert res["backup"] == {"dump_age_h": None, "stale": False}
