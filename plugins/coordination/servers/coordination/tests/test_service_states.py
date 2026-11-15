"""The state machine of spec 6.2, table-driven (S1-STATE acceptance)."""

from __future__ import annotations

import itertools

import pytest

from a2a.types import a2a_pb2 as pb
from conftest import run
from coordination.service import Actor, State
from coordination.service.coord import coord_set
from coordination.service.errors import InvalidTransition
from coordination.service.states import (
    AUDIT_NAME,
    RAW,
    TERMINAL,
    TRANSITIONS,
    is_allowed,
    logical_state,
    sources,
)
from coordination.store.task_store import IndexEntry
from service_helpers import CARD_A, H_A1, service_env
from store_helpers import new_task


def test_the_table_has_exactly_the_rows_of_spec_6_2():
    expected = {
        (State.QUARANTINED, State.SUBMITTED, Actor.ADMIN),
        (State.QUARANTINED, State.REJECTED, Actor.ADMIN),
        (State.QUARANTINED, State.REJECTED, Actor.SYSTEM),
        (State.QUARANTINED, State.CANCELED, Actor.ORIGINATOR),
        (State.SUBMITTED, State.WORKING, Actor.RECIPIENT),
        (State.SUBMITTED, State.INPUT_REQUIRED, Actor.RECIPIENT),
        (State.SUBMITTED, State.COMPLETED, Actor.RECIPIENT),
        (State.SUBMITTED, State.FAILED, Actor.RECIPIENT),
        (State.SUBMITTED, State.REJECTED, Actor.RECIPIENT),
        (State.SUBMITTED, State.CANCELED, Actor.ORIGINATOR),
        (State.SUBMITTED, State.REJECTED, Actor.SYSTEM),
        (State.WORKING, State.INPUT_REQUIRED, Actor.RECIPIENT),
        (State.WORKING, State.COMPLETED, Actor.RECIPIENT),
        (State.WORKING, State.FAILED, Actor.RECIPIENT),
        (State.WORKING, State.REJECTED, Actor.RECIPIENT),
        (State.WORKING, State.CANCELED, Actor.ORIGINATOR),
        (State.WORKING, State.FAILED, Actor.SYSTEM),
        (State.INPUT_REQUIRED, State.SUBMITTED, Actor.ORIGINATOR),
        (State.INPUT_REQUIRED, State.CANCELED, Actor.ORIGINATOR),
        (State.INPUT_REQUIRED, State.FAILED, Actor.RECIPIENT),
        (State.INPUT_REQUIRED, State.REJECTED, Actor.RECIPIENT),
    }
    assert TRANSITIONS == expected


def test_terminal_states_have_no_outgoing_transition():
    assert all(frm not in TERMINAL for (frm, _to, _actor) in TRANSITIONS)
    assert TERMINAL == {State.COMPLETED, State.FAILED, State.CANCELED, State.REJECTED}


def test_only_the_admin_moves_a_held_task_to_submitted():
    assert [(f, a) for (f, t, a) in TRANSITIONS if t is State.SUBMITTED and f is State.QUARANTINED] == [
        (State.QUARANTINED, Actor.ADMIN)
    ]
    assert sources(State.SUBMITTED, Actor.ADMIN) == {State.QUARANTINED}


def test_quarantined_is_stored_as_input_required_plus_the_hold_marker():
    assert RAW[State.QUARANTINED] == pb.TaskState.TASK_STATE_INPUT_REQUIRED
    assert AUDIT_NAME[State.QUARANTINED] == "QUARANTINED"
    real = new_task(pb.TaskState.TASK_STATE_INPUT_REQUIRED)
    held = new_task(pb.TaskState.TASK_STATE_INPUT_REQUIRED)
    coord_set(held, hold="quarantine")
    assert logical_state(real) is State.INPUT_REQUIRED
    assert logical_state(held) is State.QUARANTINED


def _task_in(state: State) -> tuple[pb.Task, IndexEntry]:
    task = new_task(RAW[state])
    entry = IndexEntry(from_principal=CARD_A, origin="local", to_card=CARD_A, to_handle=H_A1, addressing="handle")
    if state is State.QUARANTINED:
        coord_set(task, hold="quarantine")
        entry = IndexEntry(
            from_principal="peer:p", origin="remote", to_card=CARD_A, addressing="card", hold="quarantine"
        )
    return task, entry


def test_every_from_to_actor_triple_against_the_real_state_machine(config):
    """256 triples: the allowed ones succeed, every other one is `invalid_transition` and changes
    nothing (state, version, audit)."""
    triples = list(itertools.product(State, State, Actor))
    assert len(triples) == 256

    async def go():
        outcomes = []
        async with service_env(config) as env:
            for frm, to, actor in triples:
                task, entry = _task_in(frm)
                await env.store.create(task, entry)
                before = await env.store.get(task.id)
                try:
                    await env.service._transition(task.id, to=to, actor=actor, who="t", mutate=lambda _t, _w: None)
                    ok = True
                except InvalidTransition:
                    ok = False
                after = await env.store.get(task.id)
                outcomes.append(
                    (frm, to, actor, ok, logical_state(after.task), after.version, before.version, len(await env.transitions_of(task.id)))
                )
        return outcomes

    outcomes = run(go())
    allowed = invalid = 0
    for frm, to, actor, ok, final, v_after, v_before, rows in outcomes:
        assert ok == is_allowed(frm, to, actor), (frm, to, actor)
        if ok:
            allowed += 1
            assert final is to and rows == 1
        else:
            invalid += 1
            assert final is frm and v_after == v_before and rows == 0, (frm, to, actor)
    assert allowed == len(TRANSITIONS) == 21 and invalid == 256 - 21


@pytest.mark.parametrize("terminal", sorted(TERMINAL, key=lambda s: s.value))
def test_no_transition_leaves_a_terminal_state(config, terminal):
    async def go():
        async with service_env(config) as env:
            task, entry = _task_in(terminal)
            await env.store.create(task, entry)
            results = []
            for to, actor in itertools.product(State, Actor):
                try:
                    await env.service._transition(task.id, to=to, actor=actor, who="t", mutate=lambda _t, _w: None)
                    results.append(True)
                except InvalidTransition:
                    results.append(False)
            return results, logical_state((await env.store.get(task.id)).task)

    results, final = run(go())
    assert not any(results) and final is terminal
