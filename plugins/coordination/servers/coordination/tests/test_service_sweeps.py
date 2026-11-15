"""TTL sweeps (spec 1.5, 6.2): unconfirmed SUBMITTED, held, WORKING of an ended session, idle
sessions. Nothing here may release a held task."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from google.protobuf import json_format

from a2a.types import a2a_pb2 as pb
from conftest import run
from coordination.service import SweepResult
from service_helpers import CARD_A, CARD_B, H_A1, H_B1, local, msg, remote, service_env, to_meta

S = pb.TaskState


def block(task: pb.Task) -> dict:
    return json_format.MessageToDict(task.metadata).get("coord", {})


def test_an_unconfirmed_submitted_task_expires_to_rejected_after_its_ttl(config):
    async def go():
        async with service_env(config, submitted_ttl_h=168) as env:
            await env.add_session(H_A1)
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("x"), metadata=to_meta(H_A1))
            await env.touch_session(H_A1)
            env.clock.advance(hours=167)
            await env.touch_session(H_A1)
            early = await env.service.sweep()
            env.clock.advance(hours=2)
            await env.touch_session(H_A1)
            late = await env.service.sweep()
            view = await env.service.get_task(local(CARD_B, H_B1), task.id)
            again = await env.service.sweep()
            return early, late, view, again, await env.transitions_of(task.id), await env.store.get_index(task.id)

    early, late, view, again, rows, index = run(go())
    assert early.submitted_expired == 0 and late.submitted_expired == 1 and again.total == 0
    assert view.status.state == S.TASK_STATE_REJECTED and block(view)["reason"] == "expired"
    assert rows[-1] == ("TASK_STATE_SUBMITTED", "TASK_STATE_REJECTED", "system")
    assert index.expires_at is None


def test_an_unreleased_held_task_expires_to_rejected_and_is_never_released(config):
    async def go():
        async with service_env(config, quarantine_ttl_h=72) as env:
            await env.add_session(H_A1)
            peer = remote("p", (CARD_A,))
            held = await env.service.send_message(peer, CARD_A, msg("held"))
            env.clock.advance(hours=71)
            await env.touch_session(H_A1)
            before = await env.service.sweep()
            still = await env.service.get_task(peer, held.id)
            env.clock.advance(hours=2)
            await env.touch_session(H_A1)
            after = await env.service.sweep()
            view = await env.service.get_task(peer, held.id)
            with pytest.raises(Exception) as hidden:
                await env.service.get_task(local(CARD_A, H_A1), held.id)
            return before, still, after, view, hidden.value, await env.transitions_of(held.id), await env.store.get_index(held.id), await env.store.count_held("peer:p")

    before, still, after, view, hidden, rows, index, held_count = run(go())
    assert before.total == 0 and still.status.state == S.TASK_STATE_INPUT_REQUIRED and block(still)["hold"] == "quarantine"
    assert after.quarantine_expired == 1 and after.submitted_expired == 0
    assert view.status.state == S.TASK_STATE_REJECTED and block(view)["reason"] == "quarantine_expired"
    assert "hold" not in block(view)
    assert rows[-1] == ("QUARANTINED", "TASK_STATE_REJECTED", "system")
    assert hidden.code == "task_not_found" and index.hold == "quarantine" and held_count == 0
    assert S.TASK_STATE_SUBMITTED not in {pb.TaskState.Value(r[1]) for r in rows if r[1].startswith("TASK_STATE_")}


def test_a_real_question_never_expires_and_reads_never_release_a_held_task(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            await env.add_session(H_B1)
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            q = await env.service.send_message(sender, CARD_A, msg("q"), metadata=to_meta(H_A1))
            await env.service.respond(me, q.id, "input_required", text="which?")
            held = await env.service.send_message(remote("p", (CARD_A,)), CARD_A, msg("held"))
            # a very long time of READS only: no sweep runs, so nothing may change
            for _ in range(5):
                env.clock.advance(hours=500)
                await env.service.list_tasks(local(CARD_A, H_A1), pb.ListTasksRequest())
                await env.service.inbox(me)
                await env.service.get_task(remote("p", (CARD_A,)), held.id)
                await env.service.pending_count(H_A1)
            reads = (await env.store.get(q.id)).task.status.state, (await env.store.get(held.id)).task.status.state
            await env.touch_session(H_A1)
            await env.touch_session(H_B1)
            swept = await env.service.sweep()
            return reads, swept, (await env.store.get(q.id)).task.status.state, (await env.service.get_task(remote("p", (CARD_A,)), held.id)).status.state

    reads, swept, question, held_state = run(go())
    assert reads == (S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_INPUT_REQUIRED)
    assert question == S.TASK_STATE_INPUT_REQUIRED  # a clarification question has no TTL
    assert held_state == pb.TaskState.TASK_STATE_REJECTED and swept.quarantine_expired == 1  # expired, not released


def test_a_working_task_of_an_ended_session_fails_after_the_working_ttl(config):
    async def go():
        async with service_env(config, working_ttl_h=24, session_idle_ttl_h=12) as env:
            await env.add_session(H_A1)
            await env.add_session(f"{CARD_A}/live~aaaaaaa3")
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            live_handle = f"{CARD_A}/live~aaaaaaa3"
            live = local(CARD_A, live_handle)
            dead_task = await env.service.send_message(sender, CARD_A, msg("d"), metadata=to_meta(H_A1))
            live_task = await env.service.send_message(sender, CARD_A, msg("l"), metadata=to_meta(live_handle))
            await env.service.respond(me, dead_task.id, "working")
            await env.service.respond(live, live_task.id, "working")
            await env.end_session(H_A1)  # the owner went away
            env.clock.advance(hours=23)
            await env.touch_session(live_handle)
            early = await env.service.sweep()
            env.clock.advance(hours=2)
            await env.touch_session(live_handle)
            late = await env.service.sweep()
            return early, late, (await env.store.get(dead_task.id)).task, (await env.store.get(live_task.id)).task, await env.transitions_of(dead_task.id)

    early, late, dead, live, rows = run(go())
    assert early.working_failed == 0 and late.working_failed == 1
    assert dead.status.state == S.TASK_STATE_FAILED and block(dead)["reason"] == "expired"
    assert live.status.state == S.TASK_STATE_WORKING  # its session is still there
    assert rows[-1] == ("TASK_STATE_WORKING", "TASK_STATE_FAILED", "system")


def test_idle_sessions_end_and_their_tasks_stop_being_offered(config):
    async def go():
        async with service_env(config, session_idle_ttl_h=12) as env:
            await env.add_session(H_A1)
            await env.add_session(f"{CARD_A}/kept~aaaaaaa4")
            await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("x"), metadata=to_meta(H_A1))
            env.clock.advance(hours=11)
            await env.touch_session(f"{CARD_A}/kept~aaaaaaa4")
            none = await env.service.sweep()
            env.clock.advance(hours=2)
            await env.touch_session(f"{CARD_A}/kept~aaaaaaa4")
            one = await env.service.sweep()
            return none, one, await env.directory.session(H_A1), await env.directory.session(f"{CARD_A}/kept~aaaaaaa4"), await env.service.pending_count(H_A1)

    none, one, gone, kept, pending = run(go())
    assert none.sessions_ended == 0 and one.sessions_ended == 1
    assert gone.ended and not kept.ended and pending == 0


def test_a_sweep_that_loses_a_race_to_a_real_answer_changes_nothing(config):
    async def go():
        async with service_env(config, submitted_ttl_h=1) as env:
            await env.add_session(H_A1)
            me = local(CARD_A, H_A1)
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("x"), metadata=to_meta(H_A1))
            env.clock.advance(hours=2)
            await env.touch_session(H_A1)
            await env.service.respond(me, task.id, "completed", text="just in time")
            swept = await env.service.sweep()
            return swept, (await env.store.get(task.id)).task.status.state

    swept, state = run(go())
    assert swept.total == 0 and state == S.TASK_STATE_COMPLETED


def test_run_forever_sweeps_each_round_and_survives_a_failed_one(config):
    async def go():
        async with service_env(config, submitted_ttl_h=1) as env:
            await env.add_session(H_A1)
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("x"), metadata=to_meta(H_A1))
            env.clock.advance(hours=2)
            await env.touch_session(H_A1)
            rounds = []
            real = env.service.sweep

            async def flaky():
                rounds.append(1)
                if len(rounds) == 1:
                    raise RuntimeError("database blinked")
                return await real()

            env.service.sweep = flaky

            async def sleep(_s):
                if len(rounds) >= 3:
                    raise asyncio.CancelledError
                await asyncio.sleep(0)

            with pytest.raises(asyncio.CancelledError):
                await env.service.run_forever(1.0, sleep=sleep)
            return len(rounds), (await env.store.get(task.id)).task.status.state

    assert run(go()) == (3, S.TASK_STATE_REJECTED)


def test_the_sdk_interrupted_task_timeout_is_not_in_our_request_path():
    """Acceptance: `interrupted_task_timeout` does not auto-release a held task.

    In a2a-sdk 1.3.0 the setting belongs to the SDK's `DefaultRequestHandlerV2` and its
    `ActiveTask`: after that many seconds it releases the IN-MEMORY `ActiveTask` of a task idle in
    input-required (a follow-up recreates it from the store); it never writes the task. Its default
    is None (never). Our requests do not go through the SDK handler at all (BP16, SP5 D11: our own
    service layer), so none of that code runs. This test pins that: nothing under `src/` imports
    the SDK handler, the active-task classes or the setting. The other half of the acceptance, that
    nothing but `release_hold` leaves a hold however long a task sits, is
    `test_a_real_question_never_expires_and_reads_never_release_a_held_task` and the property test.
    """
    ours = Path(__file__).resolve().parents[1] / "src" / "coordination"
    needles = ("interrupted_task_timeout", "DefaultRequestHandler", "ActiveTask", "request_handlers")
    hits = [(p.name, n) for p in ours.rglob("*.py") for n in needles if n in p.read_text()]
    assert hits == []


def test_sweep_result_total():
    assert SweepResult(1, 2, 3, 4, 5).total == 15
