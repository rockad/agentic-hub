"""The retention job against a real Postgres, with a fake clock (spec 1.3).

Rules under test: terminal tasks go `A2A_RETAIN_DAYS` after their last status change, remote
`REJECTED` tasks after 24 h, `audit` never, open tasks never.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, timedelta

import pytest
import sqlalchemy as sa

from conftest import run
from coordination.store import tables
from coordination.store.retention import REMOTE_REJECTED_AFTER, DEFAULT_INTERVAL_S, RetentionJob
from store_helpers import FakeClock, S, entry, migrated_engine, migrated_store, new_task

TERMINAL = (S.TASK_STATE_COMPLETED, S.TASK_STATE_FAILED, S.TASK_STATE_CANCELED, S.TASK_STATE_REJECTED)
OPEN = (S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED)


async def _present(store, *ids: str) -> dict[str, bool]:
    return {i: await store.get(i) is not None for i in ids}


def test_terminal_tasks_are_purged_after_retain_days_and_exactly_those(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            job = RetentionJob(store, clock, retain_days=30)
            # One task per state, all created at t0.
            for state in (*TERMINAL, *OPEN):
                await store.create(new_task(state, task_id=f"t-{S.Name(state)}"), entry())
            clock.advance(days=29, hours=23)
            early = await job.run_once()
            still = await _present(store, *(f"t-{S.Name(s)}" for s in (*TERMINAL, *OPEN)))
            clock.advance(hours=2)  # now 30 d + 1 h after the status change
            late = await job.run_once()
            after = await _present(store, *(f"t-{S.Name(s)}" for s in (*TERMINAL, *OPEN)))
            return early, still, late, after, await store.check_integrity()

    early, still, late, after, integrity = run(go())
    assert early.total == 0 and all(still.values())
    # REJECTED here is local origin, so only the 30-day rule covers it.
    assert (late.terminal, late.remote_rejected) == (4, 0)
    for state in TERMINAL:
        assert after[f"t-{S.Name(state)}"] is False
    for state in OPEN:
        assert after[f"t-{S.Name(state)}"] is True  # open tasks are never purged, however old
    assert integrity.ok  # the purge took the version and index rows with the task


def test_the_age_is_the_last_status_change_not_the_creation(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            job = RetentionJob(store, clock, retain_days=30)
            await store.create(new_task(S.TASK_STATE_WORKING, task_id="late"), entry())
            clock.advance(days=40)
            await store.transition(
                "late", allowed_from={S.TASK_STATE_WORKING},
                mutate=lambda t: setattr(t.status, "state", S.TASK_STATE_COMPLETED),
            )  # completes at day 40
            clock.advance(days=29)
            first = await job.run_once()
            kept = await store.get("late") is not None
            clock.advance(days=2)
            second = await job.run_once()
            return first, kept, second, await store.get("late")

    first, kept, second, gone = run(go())
    assert first.total == 0 and kept
    assert second.terminal == 1 and gone is None


def test_remote_rejected_goes_after_24h_and_other_remote_states_do_not(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            job = RetentionJob(store, clock, retain_days=30)
            await store.create(new_task(S.TASK_STATE_REJECTED, task_id="remote-rej"), entry(origin="remote", to_card=None))
            await store.create(new_task(S.TASK_STATE_REJECTED, task_id="local-rej"), entry(origin="local"))
            await store.create(new_task(S.TASK_STATE_COMPLETED, task_id="remote-done"), entry(origin="remote", to_card=None))
            await store.create(new_task(S.TASK_STATE_SUBMITTED, task_id="remote-open"), entry(origin="remote", to_card=None))
            clock.advance(hours=23, minutes=59)
            before = await job.run_once()
            clock.advance(minutes=2)
            after = await job.run_once()
            return before, after, await _present(store, "remote-rej", "local-rej", "remote-done", "remote-open")

    before, after, present = run(go())
    assert before.total == 0
    assert (after.terminal, after.remote_rejected) == (0, 1)
    assert present == {"remote-rej": False, "local-rej": True, "remote-done": True, "remote-open": True}


def test_audit_is_never_pruned(config):
    clock = FakeClock()

    async def go():
        async with migrated_engine(config) as engine:
            from coordination.store.task_store import CoordTaskStore

            store = CoordTaskStore(engine, clock=clock)
            async with engine.begin() as conn:
                await conn.execute(
                    tables.audit.insert().values(at=clock.now() - timedelta(days=3650), actor="a", event="key.create")
                )
            await store.create(new_task(S.TASK_STATE_COMPLETED, task_id="old"), entry())
            clock.advance(days=365)
            result = await RetentionJob(store, clock, retain_days=30).run_once()
            async with engine.connect() as conn:
                audit_rows = (await conn.execute(sa.select(sa.func.count()).select_from(tables.audit))).scalar_one()
            return result, audit_rows

    result, audit_rows = run(go())
    assert result.terminal == 1 and audit_rows == 1


def test_a_purge_larger_than_one_batch_removes_everything_due(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            job = RetentionJob(store, clock, retain_days=1, batch_size=7)
            for i in range(23):
                await store.create(new_task(S.TASK_STATE_FAILED, task_id=f"f{i}"), entry())
            await store.create(new_task(S.TASK_STATE_WORKING, task_id="keep"), entry())
            clock.advance(days=2)
            result = await job.run_once()
            return result, await store.check_integrity(), await store.get("keep")

    result, integrity, keep = run(go())
    assert result.terminal == 23 and integrity.ok and keep is not None


def test_a_second_run_finds_nothing(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            job = RetentionJob(store, clock, retain_days=1)
            await store.create(new_task(S.TASK_STATE_CANCELED, task_id="c"), entry())
            clock.advance(days=2)
            return (await job.run_once()).total, (await job.run_once()).total

    assert run(go()) == (1, 0)


def test_constructor_rejects_nonsense():
    with pytest.raises(ValueError):
        RetentionJob(None, FakeClock(), retain_days=0)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        RetentionJob(None, FakeClock(), batch_size=0)  # type: ignore[arg-type]
    assert REMOTE_REJECTED_AFTER == timedelta(hours=24)
    assert FakeClock().now().tzinfo is UTC


def test_run_forever_repeats_survives_a_failed_run_and_stops_on_cancel():
    """No database: a stub store whose first query fails, then succeeds."""

    class Stub:
        def __init__(self):
            self.calls = 0

        async def remote_rejected_ids_older_than(self, cutoff, limit):
            self.calls += 1
            if self.calls == 1:
                raise ConnectionError("database away")
            return []

        async def terminal_ids_older_than(self, cutoff, limit):
            return []

    stub = Stub()
    sleeps: list[float] = []

    async def go():
        job = RetentionJob(stub, FakeClock())  # type: ignore[arg-type]

        async def sleep(seconds: float) -> None:
            sleeps.append(seconds)
            if len(sleeps) == 3:
                raise asyncio.CancelledError

        with pytest.raises(asyncio.CancelledError):
            await job.run_forever(sleep=sleep)

    run(go())
    assert stub.calls == 3 and sleeps == [DEFAULT_INTERVAL_S] * 3
