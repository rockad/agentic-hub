"""`CoordTaskStore` against a real Postgres: creation, visibility, compare-and-swap, index."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from a2a.server.cluster.version import TaskVersion
from a2a.server.context import ServerCallContext
from a2a.server.models import TaskVersionModel
from a2a.types import a2a_pb2 as pb
from a2a.utils.errors import InvalidParamsError
from conftest import run
from coordination.store.task_store import (
    OWNER,
    CoordTaskStore,
    IndexEntry,
    TaskExists,
    TaskNotFound,
    TransitionContention,
    TransitionRefused,
    Viewer,
)
from store_helpers import FakeClock, S, entry, migrated_engine, migrated_store, new_task, set_state


def test_create_writes_task_version_and_index_together(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            version = await store.create(new_task(task_id="t1"), entry(to_handle="claude-code@box/n~3f2a9c1d", addressing="handle"))
            stored = await store.get("t1")
            index = await store.get_index("t1")
            return version, stored, index, await store.check_integrity()

    version, stored, index, integrity = run(go())
    assert version == TaskVersion(1) and stored.version == TaskVersion(1)
    assert stored.task.id == "t1" and stored.task.status.state == S.TASK_STATE_SUBMITTED
    assert stored.task.history[0].parts[0].text == "hello"
    # The status timestamp was stamped from the clock, so retention can age the task.
    assert stored.task.status.timestamp.ToDatetime() == clock.now().replace(tzinfo=None)
    assert (index.from_principal, index.origin, index.to_card, index.to_handle, index.addressing) == (
        "key-a", "local", "claude-code@box", "claude-code@box/n~3f2a9c1d", "handle",
    )
    assert index.offer_count == 0 and index.hold is None
    assert integrity.ok


def test_every_task_has_its_version_row_and_a_task_without_one_is_caught(config):
    """The SP5 D10 invariant, and a positive control that the check can fail."""

    async def go():
        async with migrated_engine(config) as engine:
            store = CoordTaskStore(engine)
            for i in range(25):
                state = (S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_REJECTED)[i % 4]
                await store.create(new_task(state), entry(sender=f"key-{i % 3}"))
            async with engine.connect() as conn:
                bare = (await conn.execute(sa.text(
                    "SELECT count(*) FROM tasks t LEFT JOIN task_versions v ON v.task_id = t.id WHERE v.task_id IS NULL"
                ))).scalar_one()
            ok_before = (await store.check_integrity()).ok
            # Control: the SDK's plain, unversioned store writes a task with no version row.
            plain = store._db
            await plain.save(new_task(task_id="bare-task"), ServerCallContext())
            return bare, ok_before, await store.check_integrity(), await store.get("bare-task")

    bare, ok_before, after, bare_task = run(go())
    assert bare == 0 and ok_before
    assert after.tasks_without_version == 1 and after.tasks_without_index == 1 and not after.ok
    assert bare_task.version.is_missing


def test_a_second_create_with_the_same_id_is_refused_and_changes_nothing(config):
    async def go():
        async with migrated_store(config) as store:
            await store.create(new_task(task_id="dup", text="first"), entry(sender="key-a"))
            with pytest.raises(TaskExists):
                await store.create(new_task(task_id="dup", text="second"), entry(sender="key-b"))
            stored = await store.get("dup")
            return stored, await store.get_index("dup"), await store.check_integrity()

    stored, index, integrity = run(go())
    assert stored.task.history[0].parts[0].text == "first" and stored.version == TaskVersion(1)
    assert index.from_principal == "key-a" and integrity.ok


def test_a_failed_index_insert_rolls_back_the_task_and_its_version(config):
    async def go():
        async with migrated_store(config) as store:
            with pytest.raises(sa.exc.IntegrityError):  # NOT NULL on from_principal: not "task exists"
                await store.create(new_task(task_id="half"), IndexEntry(from_principal=None, origin="local"))  # type: ignore[arg-type]
            return await store.get("half"), await store.check_integrity()

    stored, integrity = run(go())
    assert stored is None and integrity.ok


def test_visibility_originator_recipient_hold_and_remote(config):
    sender, other_card = Viewer("key-a", "claude-code@box"), Viewer("key-x", "antigravity@box")
    recipient = Viewer("key-b", "antigravity@mac")
    remote = Viewer("peer-1")  # a remote-peer key has no card

    async def go():
        async with migrated_store(config) as store:
            await store.create(new_task(task_id="open"), entry(sender="key-a", to_card="antigravity@mac"))
            await store.create(
                new_task(task_id="held", state=S.TASK_STATE_INPUT_REQUIRED),
                entry(sender="peer-1", to_card="antigravity@mac", origin="remote", hold="quarantine"),
            )
            seen = {}
            for name, viewer in (("sender", sender), ("recipient", recipient), ("other", other_card), ("remote", remote)):
                seen[name] = {t: (await store.get(t, viewer)) is not None for t in ("open", "held")}
            return seen

    seen = run(go())
    assert seen["sender"] == {"open": True, "held": False}  # sender is not the originator of "held"
    assert seen["recipient"] == {"open": True, "held": False}  # a held task never reaches the recipient side
    assert seen["other"] == {"open": False, "held": False}
    assert seen["remote"] == {"open": False, "held": True}  # a remote peer sees only what it sent, held or not


def test_list_is_visibility_aware_ordered_and_paged(config):
    clock = FakeClock()
    me = Viewer("key-a", "claude-code@box")

    async def go():
        async with migrated_store(config, clock) as store:
            ids = []
            for i in range(5):
                clock.advance(minutes=1)
                tid = f"task-{i}"
                ids.append(tid)
                await store.create(new_task(task_id=tid, context_id="ctx-1" if i < 3 else "ctx-2"), entry(sender="key-a", to_card="x@y"))
            await store.create(new_task(task_id="theirs"), entry(sender="key-z", to_card="x@y"))  # not visible to `me`
            await store.create(new_task(task_id="to-me"), entry(sender="key-z", to_card="claude-code@box"))
            await store.create(new_task(task_id="held-to-me"), entry(sender="key-z", to_card="claude-code@box", hold="quarantine"))
            pages, token = [], ""
            while True:
                resp = await store.list(pb.ListTasksRequest(page_size=3, page_token=token), me)
                pages.append([t.id for t in resp.tasks])
                token = resp.next_page_token
                if not token:
                    break
            ctx = await store.list(pb.ListTasksRequest(context_id="ctx-2"), me)
            await store.transition("task-0", allowed_from={S.TASK_STATE_SUBMITTED}, mutate=set_state(S.TASK_STATE_WORKING))
            working = await store.list(pb.ListTasksRequest(status=S.TASK_STATE_WORKING), me)
            first = await store.list(pb.ListTasksRequest(page_size=100), me)
            with pytest.raises(InvalidParamsError):
                await store.list(pb.ListTasksRequest(page_token="not-a-cursor"), me)
            return pages, first, ctx, working

    pages, first, ctx, working = run(go())
    flat = [i for page in pages for i in page]
    assert first.total_size == 6 and len(flat) == 6 and len(set(flat)) == 6
    assert [len(p) for p in pages] == [3, 3]
    assert "theirs" not in flat and "held-to-me" not in flat and "to-me" in flat and "task-0" in flat
    assert [t.id for t in first.tasks][:2] == ["to-me", "task-4"] or "to-me" in [t.id for t in first.tasks][:2]
    assert sorted(t.id for t in ctx.tasks) == ["task-3", "task-4"]
    assert [t.id for t in working.tasks] == ["task-0"]


def test_transition_checks_state_stamps_time_and_counts_versions(config):
    clock = FakeClock()

    async def go():
        async with migrated_store(config, clock) as store:
            await store.create(new_task(task_id="t"), entry())
            clock.advance(minutes=5)
            r1 = await store.transition("t", allowed_from={S.TASK_STATE_SUBMITTED}, mutate=set_state(S.TASK_STATE_WORKING))
            with pytest.raises(TransitionRefused) as refused:
                await store.transition("t", allowed_from={S.TASK_STATE_SUBMITTED}, mutate=set_state(S.TASK_STATE_FAILED))
            r2 = await store.transition(
                "t", allowed_from={S.TASK_STATE_WORKING}, mutate=set_state(S.TASK_STATE_COMPLETED),
                index_update={"released_at": clock.now(), "offer_count": 3},
            )
            with pytest.raises(TransitionRefused):  # terminal: no way out
                await store.transition("t", allowed_from={S.TASK_STATE_WORKING, S.TASK_STATE_COMPLETED}, mutate=set_state(S.TASK_STATE_WORKING)) if False else await store.transition("t", allowed_from={S.TASK_STATE_WORKING}, mutate=set_state(S.TASK_STATE_FAILED))
            with pytest.raises(TaskNotFound):
                await store.transition("nope", allowed_from={S.TASK_STATE_SUBMITTED}, mutate=set_state(S.TASK_STATE_WORKING))
            with pytest.raises(TaskNotFound):  # a viewer who cannot see it learns nothing
                await store.transition(
                    "t", allowed_from={S.TASK_STATE_COMPLETED}, mutate=set_state(S.TASK_STATE_WORKING), viewer=Viewer("stranger", "x@y")
                )
            return r1, r2, refused.value, await store.get("t"), await store.get_index("t")

    r1, r2, refused, stored, index = run(go())
    assert (r1.previous_state, r1.version) == (S.TASK_STATE_SUBMITTED, TaskVersion(2))
    assert (r2.previous_state, r2.version) == (S.TASK_STATE_WORKING, TaskVersion(3))
    assert refused.state == S.TASK_STATE_WORKING
    assert stored.task.status.state == S.TASK_STATE_COMPLETED and stored.version == TaskVersion(3)
    assert stored.task.status.timestamp.ToDatetime() == datetime(2026, 11, 14, 12, 5, 0)
    assert index.offer_count == 3 and index.released_at == clock.now()


def test_cancel_versus_complete_race_loses_no_update(config):
    """300 rounds; the loser must be told, and the stored state must be the winner's."""
    rounds = 300

    async def one_round(store, tid):
        complete = asyncio.create_task(
            store.transition(tid, allowed_from={S.TASK_STATE_WORKING}, mutate=set_state(S.TASK_STATE_COMPLETED))
        )
        cancel = asyncio.create_task(
            store.transition(
                tid, allowed_from={S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED},
                mutate=set_state(S.TASK_STATE_CANCELED),
            )
        )
        results = await asyncio.gather(complete, cancel, return_exceptions=True)
        stored = await store.get(tid)
        return results, stored.task.status.state

    async def go():
        async with migrated_store(config) as store:
            ids = [f"race-{i}" for i in range(rounds)]
            for tid in ids:
                await store.create(new_task(S.TASK_STATE_WORKING, task_id=tid), entry())
            outcomes = []
            for start in range(0, rounds, 20):  # 20 rounds in flight at once, 40 writers
                outcomes += await asyncio.gather(*(one_round(store, tid) for tid in ids[start : start + 20]))
            return outcomes, await store.check_integrity()

    outcomes, integrity = run(go())
    completed_wins = cancel_wins = both = neither = unexpected = 0
    for (complete, cancel), final in outcomes:
        c_ok, x_ok = not isinstance(complete, BaseException), not isinstance(cancel, BaseException)
        for r in (complete, cancel):
            if isinstance(r, BaseException) and not isinstance(r, TransitionRefused):
                unexpected += 1
        if c_ok and x_ok:
            both += 1  # both told success: a lost update
        elif c_ok:
            completed_wins += 1
            assert final == S.TASK_STATE_COMPLETED
        elif x_ok:
            cancel_wins += 1
            assert final == S.TASK_STATE_CANCELED
        else:
            neither += 1
    assert both == 0 and neither == 0 and unexpected == 0
    assert completed_wins + cancel_wins == rounds
    assert integrity.ok


def test_double_take_gives_exactly_one_winner(config):
    """Two takers (SUBMITTED to WORKING) per task, 300 tasks: 0 double takes."""
    tasks = 300

    async def take(store, tid, who):
        def mutate(task):
            task.status.state = S.TASK_STATE_WORKING
            task.metadata.update({"taken_by": who})

        try:
            await store.transition(tid, allowed_from={S.TASK_STATE_SUBMITTED}, mutate=mutate)
            return who
        except TransitionRefused:
            return None

    async def go():
        async with migrated_store(config) as store:
            ids = [f"take-{i}" for i in range(tasks)]
            for tid in ids:
                await store.create(new_task(task_id=tid), entry())
            winners = {}
            for start in range(0, tasks, 25):
                chunk = ids[start : start + 25]
                got = await asyncio.gather(*(take(store, tid, w) for tid in chunk for w in ("a", "b")))
                for i, tid in enumerate(chunk):
                    winners[tid] = [w for w in got[2 * i : 2 * i + 2] if w]
            final = {tid: dict((await store.get(tid)).task.metadata).get("taken_by") for tid in ids}
            return winners, final, await store.check_integrity()

    winners, final, integrity = run(go())
    assert all(len(w) == 1 for w in winners.values())  # no double take, none lost
    assert all(final[tid] == w[0] for tid, w in winners.items())  # what is stored is the winner's
    assert integrity.ok


def test_contention_beyond_the_attempt_limit_is_reported_not_swallowed(config):
    async def go():
        async with migrated_store(config) as store:
            tight = CoordTaskStore(store._db.engine, max_cas_attempts=1)
            await store.create(new_task(task_id="hot"), entry())

            def mutate_and_interfere(task):
                task.status.state = S.TASK_STATE_WORKING
                # Another writer gets in between this attempt's read and its write.
                asyncio.get_running_loop().create_task(asyncio.sleep(0))
                interfered.append(1)

            interfered: list[int] = []
            original = tight._versioned.save

            async def interfering_save(task, **kw):
                if not interfered:
                    interfered.append(1)
                    await store.transition("hot", allowed_from={S.TASK_STATE_SUBMITTED}, mutate=set_state(S.TASK_STATE_WORKING))
                return await original(task, **kw)

            tight._versioned.save = interfering_save
            with pytest.raises(TransitionContention):
                await tight.transition("hot", allowed_from={S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING}, mutate=set_state(S.TASK_STATE_INPUT_REQUIRED))
            return (await store.get("hot")).task.status.state

    # The interfering writer's state stands; the contended writer was not silently applied.
    assert run(go()) == S.TASK_STATE_WORKING


def test_index_update_and_the_atomic_claim(config):
    async def go():
        async with migrated_store(config) as store:
            await store.create(new_task(task_id="card-task"), entry(to_card="claude-code@box", addressing="card"))
            claims = await asyncio.gather(
                *(store.update_index("card-task", {"to_handle": f"claude-code@box/s{i}~0000000{i}"}, expect={"to_handle": None}) for i in range(6))
            )
            index = await store.get_index("card-task")
            with pytest.raises(ValueError, match="from_principal"):
                await store.update_index("card-task", {"from_principal": "someone-else"})
            gone = await store.update_index("no-such-task", {"hold": None})
            return claims, index, gone

    claims, index, gone = run(go())
    assert sum(claims) == 1  # exactly one claimant won
    assert index.to_handle in {f"claude-code@box/s{i}~0000000{i}" for i in range(6)}
    assert gone is False


def test_delete_tasks_removes_every_keyed_row_and_only_those(config):
    async def go():
        async with migrated_store(config) as store:
            for tid in ("a", "b", "c"):
                await store.create(new_task(task_id=tid), entry())
            removed = await store.delete_tasks(["a", "b", "ghost"])
            return removed, [await store.get(t) is not None for t in ("a", "b", "c")], await store.check_integrity()

    removed, present, integrity = run(go())
    assert removed == 2 and present == [False, False, True]
    assert integrity.ok  # no version row, index row or task left behind for a or b


def test_integrity_counts_orphan_index_and_version_rows(config):
    async def go():
        async with migrated_engine(config) as engine:
            store = CoordTaskStore(engine)
            async with engine.begin() as conn:
                await conn.execute(sa.text(
                    "INSERT INTO task_index (task_id, from_principal, origin) VALUES ('ghost-index', 'k', 'local')"
                ))
                await conn.execute(sa.insert(TaskVersionModel).values(task_id="ghost-version", owner=OWNER, version=1))
            return await store.check_integrity()

    integrity = run(go())
    assert (integrity.index_without_task, integrity.versions_without_task) == (1, 1) and not integrity.ok


def test_viewer_filter_cannot_be_skipped_by_a_none_card(config):
    """A remote-peer viewer (no card) must not match `to_card IS NULL` rows by accident."""

    async def go():
        async with migrated_store(config) as store:
            await store.create(new_task(task_id="nocard"), entry(sender="key-a", to_card=None))
            return await store.get("nocard", Viewer("peer-1")), await store.get("nocard", Viewer("key-a"))

    stranger, owner = run(go())
    assert stranger is None and owner is not None
