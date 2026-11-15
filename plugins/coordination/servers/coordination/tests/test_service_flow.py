"""Offers, claims, respond, cancel and the admin release of a hold (S1-STATE)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from google.protobuf import json_format

from a2a.types import a2a_pb2 as pb
from conftest import run
from coordination.service import offers
from coordination.service.errors import (
    AlreadyClaimed,
    Forbidden,
    InvalidParams,
    InvalidTransition,
    SessionNotLive,
    TaskNotCancelable,
    TaskNotFound,
)
from service_helpers import CARD_A, CARD_B, H_A1, H_A2, H_B1, local, msg, remote, service_env, to_meta

S = pb.TaskState
SEC = timedelta(seconds=1)


def block(task: pb.Task) -> dict:
    return json_format.MessageToDict(task.metadata).get("coord", {})


# -- offered until confirmed ---------------------------------------------------------------------


def test_reoffer_schedule_matches_the_formula_for_n_1_to_5(config):
    base = 600

    async def go():
        async with service_env(config, reoffer_after_s=base, reoffer_max=5) as env:
            await env.add_session(H_A1)
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            task = await env.service.send_message(sender, CARD_A, msg("work"), metadata=to_meta(H_A1))
            gaps, wake_when_due = [], []
            assert await env.service.has_wake_pending(H_A1)  # never offered: wakeable at once
            for n in range(1, 6):
                await env.service.inbox(me)
                index = await env.store.get_index(task.id)
                assert index.offer_count == n
                gaps.append(index.next_offer_at - index.last_offered_at)
                assert not await env.service.has_wake_pending(H_A1)  # offered, window running
                env.clock.advance(seconds=base * 3 ** (n - 1))
                wake_when_due.append(await env.service.has_wake_pending(H_A1))
            # after REOFFER_MAX offers: no wake, but the task stays in the inbox and the count
            inbox = await env.service.inbox(me)
            index = await env.store.get_index(task.id)
            return gaps, wake_when_due, inbox, index, await env.service.pending_count(H_A1), await env.service.has_wake_pending(H_A1)

    gaps, wake_when_due, inbox, index, pending, wake = run(go())
    assert [g.total_seconds() for g in gaps] == [base * 3 ** (n - 1) for n in range(1, 6)] == [600, 1800, 5400, 16200, 48600]
    assert wake_when_due == [True, True, True, True, False]  # the fifth offer was the last
    assert [i.offer_count for i in inbox.items] == [5] and index.offer_count == 5
    assert pending == 1 and wake is False


def test_offer_arithmetic_is_the_formula():
    from datetime import UTC, datetime

    t = datetime(2026, 11, 15, tzinfo=UTC)
    for n in range(1, 6):
        assert offers.next_offer_at(t, n, 60) - t == timedelta(seconds=60 * 3 ** (n - 1))
    assert offers.after_offer(5, t, 60, 5) == (5, t + timedelta(seconds=60 * 81))  # the count stops at the cap
    assert offers.wakes_stopped(5, 5) and not offers.wakes_stopped(4, 5)
    with pytest.raises(ValueError):
        offers.offer_delay(0, 60)


def test_inbox_lists_in_the_spec_order_and_never_a_held_task(config):
    async def go():
        async with service_env(config) as env:
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            card_task = await env.service.send_message(sender, CARD_A, msg("card"))  # nobody is there: queued
            await env.add_session(H_A1)
            own = await env.service.send_message(sender, CARD_A, msg("own"), metadata=to_meta(H_A1))
            await env.service.send_message(remote("p", (CARD_A,)), CARD_A, msg("held"))
            inbox = await env.service.inbox(me)
            again = await env.service.inbox(me)
            small = await env.service.inbox(local(CARD_A, H_A1), limit=1)
            with pytest.raises(InvalidParams):
                await env.service.inbox(me, limit=0)
            with pytest.raises(InvalidParams):
                await env.service.inbox(me, limit=51)
            return card_task, own, inbox, again, small

    card_task, own, inbox, again, small = run(go())
    assert [(i.task.id, i.addressed_to, i.kind) for i in inbox.items] == [
        (own.id, "handle", "new"),
        (card_task.id, "card", "new"),
    ]
    assert inbox.held_for_review == 1 and inbox.pending_total == 2
    assert [i.offer_count for i in inbox.items] == [1, 1] and [i.offer_count for i in again.items] == [2, 2]
    # `limit` cuts the list. By now the queued task was claimed by the first call, so both are this
    # session's own and, on a frozen clock, their order is not defined: only the count is.
    assert len(small.items) == 1 and small.items[0].task.id in {own.id, card_task.id}


def test_inbox_needs_a_live_bound_session(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1, ended=True)
            out = []
            for caller in (local(CARD_A, None), local(CARD_A, H_A1), local(CARD_A, H_A2), remote("p", (CARD_A,))):
                try:
                    await env.service.inbox(caller)
                    out.append("ok")
                except (Forbidden, SessionNotLive) as exc:
                    out.append(exc.code)
            return out

    assert run(go()) == ["forbidden", "session_ended", "session_ended", "forbidden"]


def test_two_concurrent_claims_of_one_card_task_give_one_winner(config):
    async def go():
        async with service_env(config) as env:
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("take me"))  # queued
            await env.add_session(H_A1)
            await env.add_session(H_A2)
            index = await env.store.get_index(task.id)
            results = await asyncio.gather(
                env.service.claim(local(CARD_A, H_A1), task.id),
                env.service.claim(local(CARD_A, H_A2), task.id),
                return_exceptions=True,
            )
            return index, results, await env.store.get_index(task.id)

    index, results, final = run(go())
    assert index.to_handle is None
    won = [r for r in results if not isinstance(r, BaseException)]
    lost = [r for r in results if isinstance(r, BaseException)]
    assert len(won) == 1 and [type(e) for e in lost] == [AlreadyClaimed] and lost[0].code == "already_claimed"
    assert final.to_handle in (H_A1, H_A2)


def test_concurrent_inbox_calls_and_respond_calls_claim_a_queued_task_once(config):
    async def go():
        async with service_env(config) as env:
            sender = local(CARD_B, H_B1)
            q1 = await env.service.send_message(sender, CARD_A, msg("q1"))  # no sessions yet: queued
            q2 = await env.service.send_message(sender, CARD_A, msg("q2"))
            await env.add_session(H_A1)
            await env.add_session(H_A2)
            a, b = local(CARD_A, H_A1), local(CARD_A, H_A2)
            inboxes = await asyncio.gather(env.service.inbox(a), env.service.inbox(b))
            claimed = [sorted(i.task.id for i in r.items) for r in inboxes]
            q3 = await env.service.send_message(sender, CARD_A, msg("q3"))  # routed to the newest active
            await env.service.sweep()
            return q1, q2, q3, claimed

    q1, q2, q3, claimed = run(go())
    flat = claimed[0] + claimed[1]
    assert sorted(flat) == sorted([q1.id, q2.id])  # each queued task listed to exactly one session


def test_concurrent_respond_on_a_queued_card_task_claims_it_once(config):
    async def go():
        async with service_env(config) as env:
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("q"))  # queued
            await env.add_session(H_A1)
            await env.add_session(H_A2)
            res = await asyncio.gather(
                env.service.respond(local(CARD_A, H_A1), task.id, "working"),
                env.service.respond(local(CARD_A, H_A2), task.id, "working"),
                return_exceptions=True,
            )
            return res, await env.store.get_index(task.id), await env.store.get(task.id), await env.transitions_of(task.id)

    res, index, stored, rows = run(go())
    assert sum(1 for r in res if not isinstance(r, BaseException)) == 1
    assert [type(r) for r in res if isinstance(r, BaseException)] in ([AlreadyClaimed], [InvalidTransition])
    assert stored.task.status.state == S.TASK_STATE_WORKING and index.to_handle in (H_A1, H_A2)
    assert len(rows) == 2  # creation, then exactly one SUBMITTED -> WORKING


def test_an_unconfirmed_routed_card_task_goes_back_to_the_queue_and_the_next_session_claims_it(config):
    async def go():
        async with service_env(config, reoffer_after_s=600) as env:
            await env.add_session(H_A1)
            env.clock.advance(seconds=1)
            await env.add_session(H_A2)
            task = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("who takes this"))
            routed = await env.store.get_index(task.id)  # to the newest active: A2
            await env.touch_session(H_A1)
            await env.touch_session(H_A2)
            first = await env.service.sweep()
            env.clock.advance(seconds=599)
            await env.touch_session(H_A1)
            await env.touch_session(H_A2)
            early = await env.service.sweep()
            env.clock.advance(seconds=2)  # the 600 s offer window ran out unconfirmed
            second = await env.service.sweep()
            queued = await env.store.get_index(task.id)
            woke_a1 = await env.service.has_wake_pending(H_A1)
            inbox = await env.service.inbox(local(CARD_A, H_A1))
            with pytest.raises(AlreadyClaimed):
                await env.service.respond(local(CARD_A, H_A2), task.id, "working")
            done = await env.service.respond(local(CARD_A, H_A1), task.id, "completed", text="done")
            return routed, first, early, second, queued, woke_a1, inbox, done

    routed, first, early, second, queued, woke_a1, inbox, done = run(go())
    assert routed.to_handle == H_A2 and routed.addressing == "card"
    assert first.requeued == 0 and early.requeued == 0 and second.requeued == 1
    assert queued.to_handle is None
    assert woke_a1 is False  # H_A1 is not a parked listener, so the queue wake is not its to take
    assert [i.addressed_to for i in inbox.items] == ["card"]
    assert done.status.state == S.TASK_STATE_COMPLETED


def test_a_queued_card_task_wakes_only_the_newest_parked_listener(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            await env.add_session(H_A2)
            env.clock.advance(minutes=30)  # nobody active: the task queues
            await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("queued"))
            env.listeners.park(H_A1)
            return (
                await env.service.has_wake_pending(H_A1),
                await env.service.has_wake_pending(H_A2),
                await env.service.pending_count(H_A1),
                await env.service.pending_count(H_A2),
            )

    assert run(go()) == (True, False, 1, 1)  # both SEE it pending; only the parked listener is woken


# -- respond ---------------------------------------------------------------------------------


def test_respond_confirms_moves_and_audits_with_the_actor(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            task = await env.service.send_message(sender, CARD_A, msg("do it"), metadata=to_meta(H_A1))
            working = await env.service.respond(me, task.id, "working")
            done = await env.service.respond(
                me, task.id, "completed", text="all green", artifacts=[{"name": "report", "text": "ok"}]
            )
            quick = await env.service.send_message(sender, CARD_A, msg("quick"), metadata=to_meta(H_A1))
            one_step = await env.service.respond(me, quick.id, "failed", text="no")
            refused = await env.service.send_message(sender, CARD_A, msg("nope"), metadata=to_meta(H_A1))
            declined = await env.service.respond(me, refused.id, "rejected")
            return working, done, one_step, declined, await env.transitions_of(task.id), task.id

    working, done, one_step, declined, rows, tid = run(go())
    assert working.status.state == S.TASK_STATE_WORKING and block(working)["delivery"] == "accepted"
    assert done.status.state == S.TASK_STATE_COMPLETED and done.artifacts[0].name == "report"
    assert done.status.message.parts[0].text == "all green" and done.history[-1].role == pb.Role.ROLE_AGENT
    assert one_step.status.state == S.TASK_STATE_FAILED
    assert declined.status.state == S.TASK_STATE_REJECTED and block(declined)["reason"] == "recipient_declined"
    assert rows == [
        (None, "TASK_STATE_SUBMITTED", H_B1),
        ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", H_A1),
        ("TASK_STATE_WORKING", "TASK_STATE_COMPLETED", H_A1),
    ]


def test_respond_refusals(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            await env.add_session(H_A2)
            await env.add_session(H_B1)
            sender, me, other = local(CARD_B, H_B1), local(CARD_A, H_A1), local(CARD_A, H_A2)
            task = await env.service.send_message(sender, CARD_A, msg("x"), metadata=to_meta(H_A1))
            out = {}

            async def attempt(name, coro):
                try:
                    await coro
                    out[name] = "ok"
                except (Forbidden, InvalidParams, InvalidTransition, TaskNotFound, AlreadyClaimed) as exc:
                    out[name] = exc.code

            await attempt("canceled", env.service.respond(me, task.id, "canceled"))
            await attempt("auth_required", env.service.respond(me, task.id, "auth_required"))
            await attempt("other_session", env.service.respond(other, task.id, "working"))
            await attempt("originator", env.service.respond(sender, task.id, "working"))
            await attempt("unknown", env.service.respond(me, "99999999-9999-9999-9999-999999999999", "working"))
            await attempt("too_many_artifacts", env.service.respond(me, task.id, "completed", artifacts=[{"name": "a", "text": "t"}] * 9))
            await attempt("bad_artifact", env.service.respond(me, task.id, "completed", artifacts=[{"name": "a"}]))
            await env.service.respond(me, task.id, "completed")
            await attempt("after_terminal", env.service.respond(me, task.id, "working"))
            await attempt("working_again", env.service.respond(me, task.id, "failed"))
            q = await env.service.send_message(sender, CARD_A, msg("q"), metadata=to_meta(H_A1))
            await env.service.respond(me, q.id, "input_required", text="?")
            await attempt("working_from_question", env.service.respond(me, q.id, "working"))
            return out

    assert run(go()) == {
        "canceled": "invalid_params",
        "auth_required": "invalid_params",
        "other_session": "forbidden",
        "originator": "forbidden",
        "unknown": "task_not_found",
        "too_many_artifacts": "invalid_params",
        "bad_artifact": "invalid_params",
        "after_terminal": "invalid_transition",
        "working_again": "invalid_transition",
        "working_from_question": "invalid_transition",
    }


# -- cancel -----------------------------------------------------------------------------------


def test_cancel_originator_only_and_a_finished_task_is_not_cancelable(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            sender, me = local(CARD_B, H_B1), local(CARD_A, H_A1)
            t1 = await env.service.send_message(sender, CARD_A, msg("1"), metadata=to_meta(H_A1))
            with pytest.raises(Forbidden):
                await env.service.cancel_task(me, t1.id)  # the recipient says rejected or failed instead
            canceled = await env.service.cancel_task(sender, t1.id, reason="changed my mind")
            with pytest.raises(TaskNotCancelable) as exc:
                await env.service.cancel_task(sender, t1.id)
            t2 = await env.service.send_message(sender, CARD_A, msg("2"), metadata=to_meta(H_A1))
            await env.service.respond(me, t2.id, "working")
            await env.service.respond(me, t2.id, "completed")
            with pytest.raises(TaskNotCancelable):
                await env.service.cancel_task(sender, t2.id)
            t3 = await env.service.send_message(sender, CARD_A, msg("3"), metadata=to_meta(H_A1))
            await env.service.respond(me, t3.id, "working")
            working_cancel = await env.service.cancel_task(sender, t3.id)
            with pytest.raises(InvalidParams):
                await env.service.cancel_task(sender, t3.id, reason="x" * 1025)
            return canceled, exc.value, working_cancel, await env.transitions_of(t1.id)

    canceled, err, working_cancel, rows = run(go())
    assert canceled.status.state == S.TASK_STATE_CANCELED and canceled.status.message.parts[0].text == "changed my mind"
    assert err.rpc_code == -32002
    assert working_cancel.status.state == S.TASK_STATE_CANCELED
    assert rows[-1] == ("TASK_STATE_SUBMITTED", "TASK_STATE_CANCELED", H_B1)


def test_cancelling_a_held_task_ends_it_and_it_stays_hidden_from_the_recipient(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            peer, me = remote("p", (CARD_A,)), local(CARD_A, H_A1)
            held = await env.service.send_message(peer, CARD_A, msg("h"))
            canceled = await env.service.cancel_task(peer, held.id)
            with pytest.raises(TaskNotFound):
                await env.service.get_task(me, held.id)  # still never shown to the recipient side
            return canceled, await env.transitions_of(held.id), await env.store.count_held("peer:p"), await env.service.held_tasks()

    canceled, rows, held_count, admin = run(go())
    assert canceled.status.state == S.TASK_STATE_CANCELED and "hold" not in block(canceled)
    assert rows[-1] == ("QUARANTINED", "TASK_STATE_CANCELED", "r1234abcd")
    assert held_count == 0 and admin == []


# -- the admin release (D10, D19) ------------------------------------------------------------


def test_release_is_the_only_way_out_of_a_hold_and_it_is_audited_with_the_human(config):
    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            peer, me = remote("p", (CARD_A,)), local(CARD_A, H_A1)
            held = await env.service.send_message(peer, CARD_A, msg("held body"))
            with pytest.raises(TaskNotFound):
                await env.service.get_task(me, held.id)
            released = await env.service.release_hold(held.id, actor="aleksandr")
            seen = await env.service.get_task(me, held.id)
            index = await env.store.get_index(held.id)
            inbox = await env.service.inbox(me)
            with pytest.raises(InvalidTransition):  # nothing left to release
                await env.service.release_hold(held.id, actor="aleksandr")
            return released, seen, index, inbox, await env.transitions_of(held.id), await env.audit_rows("hold_released")

    released, seen, index, inbox, rows, hold_rows = run(go())
    assert released.status.state == S.TASK_STATE_SUBMITTED and "hold" not in block(released)
    assert seen.status.state == S.TASK_STATE_SUBMITTED and seen.history[0].parts[0].text == "held body"
    assert index.hold is None and index.released_at is not None and index.origin == "remote"
    assert [i.task.id for i in inbox.items] == [released.id]
    assert rows == [(None, "QUARANTINED", "r1234abcd"), ("QUARANTINED", "TASK_STATE_SUBMITTED", "aleksandr")]
    assert [(r.actor, r.subject) for r in hold_rows] == [("aleksandr", released.id)]


def test_release_routes_a_card_task_afresh_and_deny_keeps_it_hidden(config):
    async def go():
        async with service_env(config) as env:
            peer = remote("p", (CARD_A,))
            held = await env.service.send_message(peer, CARD_A, msg("one"))
            env.clock.advance(hours=2)
            await env.add_session(H_A1)  # registered AFTER the send, before the release
            await env.service.release_hold(held.id, actor="aleksandr")
            routed = await env.store.get_index(held.id)
            denied_src = await env.service.send_message(peer, CARD_A, msg("two"))
            env.clock.advance(seconds=61)
            denied = await env.service.deny_hold(denied_src.id, actor="aleksandr")
            with pytest.raises(TaskNotFound):
                await env.service.get_task(local(CARD_A, H_A1), denied.id)
            with pytest.raises(InvalidTransition):  # a denied task cannot then be released
                await env.service.release_hold(denied.id, actor="aleksandr")
            return routed, denied, await env.store.get_index(denied.id), await env.audit_rows("hold_denied")

    routed, denied, index, deny_rows = run(go())
    assert routed.to_handle == H_A1 and routed.addressing == "card" and routed.next_offer_at is not None
    assert denied.status.state == S.TASK_STATE_REJECTED and block(denied)["reason"] == "denied_by_human"
    assert index.hold == "quarantine"  # never released: stays invisible to the recipient side
    assert [r.actor for r in deny_rows] == ["aleksandr"]


def test_release_and_deny_of_something_that_is_not_held_or_does_not_exist(config):
    async def go():
        async with service_env(config) as env:
            plain = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("plain"))
            out = []
            for call in (
                env.service.release_hold(plain.id, actor="a"),
                env.service.deny_hold(plain.id, actor="a"),
                env.service.release_hold("99999999-9999-9999-9999-999999999999", actor="a"),
                env.service.release_hold(plain.id, actor=" "),
            ):
                with pytest.raises((InvalidTransition, TaskNotFound, InvalidParams)) as exc:
                    await call
                out.append(exc.value.code)
            return out, (await env.store.get(plain.id)).task.status.state

    out, state = run(go())
    assert out == ["invalid_transition", "invalid_transition", "task_not_found", "invalid_params"]
    assert state == S.TASK_STATE_SUBMITTED
