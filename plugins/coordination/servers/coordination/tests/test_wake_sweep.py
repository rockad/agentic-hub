"""Z18: the app lifespan runs the TTL sweep, and the sweep ends idle sessions by name.

- Through the real wiring (`build_server_app`, a hand-moved clock, a real Postgres): a session whose
  listener is parked goes idle past `A2A_SESSION_IDLE_TTL_H`, `service.sweep()` ends it through
  `IdentityService.end_idle`, the listener gets `410 ended`, and one `session_ended` row (`via`
  `idle_ttl`, actor `system`) is written. A second sweep does nothing.
- `CoordinationService.sweep` calls the bound idle ender with the idle cutoff and counts what it
  returns; without one it keeps the `Directory.end_idle` path.
- The lifespan starts the sweep task and cancels it on shutdown.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import run
from wake_helpers import H_CLAUDE, H_CLAUDE2, HS_CLAUDE, HS_CLAUDE2, WakeEnv, make_wake_env, run_wake

from coordination.service import CoordinationService, ServiceSettings, SweepResult

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def detail(row) -> dict:
    value = row.detail_json
    return json.loads(value) if isinstance(value, str) else value


# =============================================================================================
# the real wiring
# =============================================================================================


@pytest.fixture
def wk(pg_db) -> WakeEnv:
    # A long re-check: a parked listener refreshes its session's `last_seen_at` on every look, and
    # this test needs the session to stay idle while the clock is moved past the TTL.
    return make_wake_env(pg_db, recheck_s=3600.0)


def test_the_sweep_ends_an_idle_session_by_name_and_answers_its_parked_listener_410(wk):
    ttl_h = wk.env.config.session_idle_ttl_h

    async def scenario(wk):
        await wk.add_session(H_CLAUDE, HS_CLAUDE)
        async with wk.client() as http:
            listener = wk.listen(http, wk.keys.claude, HS_CLAUDE)
            await wk.parked_and_checked(H_CLAUDE)
            wk.clock.advance(hours=ttl_h, minutes=1)
            await wk.add_session(H_CLAUDE2, HS_CLAUDE2)  # registered now, so not idle
            service = wk.app.state.service
            first = await service.sweep()
            r = await wk.settle(listener, 5)
            assert r.status_code == 410 and r.headers["x-coord-reason"] == "ended"
            assert first == SweepResult(sessions_ended=1)
            rows = await wk.audit_events("session_ended")
            assert [(x.subject, x.actor, detail(x)) for x in rows] == [(H_CLAUDE, "system", {"via": "idle_ttl"})]
            assert wk.table.count() == 0
            # the other session is untouched, and a second sweep ends nothing and writes nothing
            second = await service.sweep()
            assert second == SweepResult()
            assert len(await wk.audit_events("session_ended")) == 1
            again = await http.post("/wake/listen", headers={"Authorization": f"Bearer {wk.keys.claude}", "X-Coord-Session": HS_CLAUDE2, "X-Coord-Wait": "1"})
            assert again.status_code == 408  # the fresh session is still live

    run_wake(wk, scenario)


# =============================================================================================
# the unit: the binding
# =============================================================================================


class _Clock:
    def now(self) -> datetime:
        return NOW

    def monotonic(self) -> float:
        return 0.0


class _EmptyStore:
    async def expired(self, now, limit):
        return []

    async def working_of_ended_sessions(self, cutoff, limit):
        return []

    async def requeue_due(self, now, limit):
        return []


class _Directory:
    def __init__(self, ended: int) -> None:
        self.ended = ended
        self.calls: list[tuple[datetime, datetime]] = []

    async def end_idle(self, before, now):
        self.calls.append((before, now))
        return self.ended


def _service(directory: _Directory, **kwargs) -> CoordinationService:
    return CoordinationService(
        _EmptyStore(),  # type: ignore[arg-type]
        directory,  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
        _Clock(),
        ServiceSettings(session_idle_ttl_h=12),
        **kwargs,
    )


def test_sweep_calls_the_bound_idle_ender_with_the_cutoff_and_counts_its_result():
    directory = _Directory(ended=99)
    service = _service(directory)
    seen: list[datetime] = []

    async def ender(cutoff: datetime) -> list[str]:
        seen.append(cutoff)
        return ["a", "b", "c"]

    service.bind_idle_ender(ender)
    result = run(service.sweep())
    assert seen == [NOW - timedelta(hours=12)]
    assert result == SweepResult(sessions_ended=3)
    assert directory.calls == []  # the directory's one-statement end is not used once an ender is bound


def test_sweep_accepts_the_idle_ender_as_a_constructor_argument():
    async def ender(cutoff: datetime) -> list[str]:
        return ["x"]

    assert run(_service(_Directory(ended=99), idle_ender=ender).sweep()).sessions_ended == 1


def test_sweep_without_a_binding_uses_directory_end_idle():
    directory = _Directory(ended=2)
    result = run(_service(directory).sweep())
    assert result == SweepResult(sessions_ended=2)
    assert directory.calls == [(NOW - timedelta(hours=12), NOW)]


# =============================================================================================
# the lifespan
# =============================================================================================


def _sweep_tasks() -> list[asyncio.Task]:
    return [t for t in asyncio.all_tasks() if t.get_name() == "coordination-sweep"]


def test_the_lifespan_starts_the_sweep_and_cancels_it_on_shutdown(pg_db):
    wk = make_wake_env(pg_db, recheck_s=3600.0, sweep_interval_s=0.05)
    ttl_h = wk.env.config.session_idle_ttl_h
    service = wk.app.state.service
    passes: list[int] = []
    real_sweep = service.sweep

    async def counting_sweep():
        passes.append(1)
        return await real_sweep()

    service.sweep = counting_sweep  # `run_forever` calls `self.sweep()`, so the instance wins

    async def scenario(wk):
        await wk.add_session(H_CLAUDE, HS_CLAUDE)
        wk.clock.advance(hours=ttl_h, minutes=1)
        assert not _sweep_tasks()
        async with wk.app.router.lifespan_context(wk.app):
            assert len(_sweep_tasks()) == 1
            async with asyncio.timeout(10):
                while len(passes) < 2 or not await wk.audit_events("session_ended"):
                    await asyncio.sleep(0.02)
            rows = await wk.audit_events("session_ended")
            assert [(x.subject, x.actor, detail(x)) for x in rows] == [(H_CLAUDE, "system", {"via": "idle_ttl"})]
        # the shutdown cancelled the task and waited for it: nothing left running, nothing more swept
        assert not _sweep_tasks()
        seen = len(passes)
        await asyncio.sleep(0.2)
        assert len(passes) == seen
        assert len(await wk.audit_events("session_ended")) == 1  # ended once, by the loop

    run_wake(wk, scenario)
