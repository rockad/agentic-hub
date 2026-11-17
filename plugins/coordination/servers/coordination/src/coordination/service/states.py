"""The task state machine of spec 6.2, as data.

Logical states are the seven A2A states we produce plus our extension `QUARANTINED`. A held task
is STORED as `TASK_STATE_INPUT_REQUIRED` with `coord.hold = "quarantine"` in its metadata (and
`task_index.hold`); `logical_state` reads that marker. Nothing else tells a hold from a real
clarification question.

The table below is the whole of the transition rules, and the only place they live. A pair that
is not in it is `invalid_transition`; the terminal states have no outgoing row. Entry (no task
yet to a first state) is decided by origin and allowlist in `CoordinationService.send_message`
and is not in this table.

Actors:

- `ORIGINATOR`: the sender, through `CancelTask` or a new message to its own task.
- `RECIPIENT`: the session the task is bound to, through `a2a_respond`.
- `ADMIN`: a human at the admin socket (`a2a-coord review release` or `deny`).
- `SYSTEM`: a TTL sweep.
"""

from __future__ import annotations

from enum import StrEnum

from a2a.types import a2a_pb2 as pb
from coordination.service.coord import coord_get

S = pb.TaskState


class State(StrEnum):
    SUBMITTED = "SUBMITTED"
    WORKING = "WORKING"
    INPUT_REQUIRED = "INPUT_REQUIRED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"
    REJECTED = "REJECTED"
    QUARANTINED = "QUARANTINED"


class Actor(StrEnum):
    ORIGINATOR = "originator"
    RECIPIENT = "recipient"
    ADMIN = "admin"
    SYSTEM = "system"


TERMINAL = frozenset({State.COMPLETED, State.FAILED, State.CANCELED, State.REJECTED})

#: The wire state each logical state is stored as. `QUARANTINED` is stored as `INPUT_REQUIRED`.
RAW: dict[State, int] = {
    State.SUBMITTED: S.TASK_STATE_SUBMITTED,
    State.WORKING: S.TASK_STATE_WORKING,
    State.INPUT_REQUIRED: S.TASK_STATE_INPUT_REQUIRED,
    State.COMPLETED: S.TASK_STATE_COMPLETED,
    State.FAILED: S.TASK_STATE_FAILED,
    State.CANCELED: S.TASK_STATE_CANCELED,
    State.REJECTED: S.TASK_STATE_REJECTED,
    State.QUARANTINED: S.TASK_STATE_INPUT_REQUIRED,
}

#: The names the audit log uses (`audit.log.TASK_STATES`): A2A enum names plus `QUARANTINED`.
AUDIT_NAME: dict[State, str] = {
    state: ("QUARANTINED" if state is State.QUARANTINED else S.Name(RAW[state])) for state in State
}

HOLD_QUARANTINE = "quarantine"


def logical_state(task: pb.Task) -> State:
    """The logical state of a stored task: `QUARANTINED` is `INPUT_REQUIRED` plus the hold marker."""
    raw = task.status.state
    if raw == S.TASK_STATE_INPUT_REQUIRED and coord_get(task).get("hold") == HOLD_QUARANTINE:
        return State.QUARANTINED
    for state, value in RAW.items():
        if state is not State.QUARANTINED and value == raw:
            return state
    raise ValueError(f"task {task.id} is in a state this server never produces: {S.Name(raw)}")


def _rows(frm: State | tuple[State, ...], to: State | tuple[State, ...], actor: Actor):
    frms = frm if isinstance(frm, tuple) else (frm,)
    tos = to if isinstance(to, tuple) else (to,)
    return [(f, t, actor) for f in frms for t in tos]


_RESPOND = (State.INPUT_REQUIRED, State.COMPLETED, State.FAILED, State.REJECTED)

#: Every allowed (from, to, actor), from the transition table of spec 6.2.
TRANSITIONS: frozenset[tuple[State, State, Actor]] = frozenset(
    [
        # Held: release, deny, TTL expiry, originator cancel.
        *_rows(State.QUARANTINED, State.SUBMITTED, Actor.ADMIN),
        *_rows(State.QUARANTINED, State.REJECTED, Actor.ADMIN),
        *_rows(State.QUARANTINED, State.REJECTED, Actor.SYSTEM),
        *_rows(State.QUARANTINED, State.CANCELED, Actor.ORIGINATOR),
        # SUBMITTED: confirmation, one-step confirm and move, cancel, expiry.
        *_rows(State.SUBMITTED, State.WORKING, Actor.RECIPIENT),
        *_rows(State.SUBMITTED, _RESPOND, Actor.RECIPIENT),
        *_rows(State.SUBMITTED, State.CANCELED, Actor.ORIGINATOR),
        *_rows(State.SUBMITTED, State.REJECTED, Actor.SYSTEM),
        # WORKING.
        *_rows(State.WORKING, _RESPOND, Actor.RECIPIENT),
        *_rows(State.WORKING, State.CANCELED, Actor.ORIGINATOR),
        *_rows(State.WORKING, State.FAILED, Actor.SYSTEM),
        # A real INPUT_REQUIRED (a question to the originator).
        *_rows(State.INPUT_REQUIRED, State.SUBMITTED, Actor.ORIGINATOR),
        *_rows(State.INPUT_REQUIRED, State.CANCELED, Actor.ORIGINATOR),
        *_rows(State.INPUT_REQUIRED, (State.FAILED, State.REJECTED), Actor.RECIPIENT),
    ]
)


def is_allowed(frm: State, to: State, actor: Actor) -> bool:
    return (frm, to, actor) in TRANSITIONS


def sources(to: State, actor: Actor) -> frozenset[State]:
    """The logical states `actor` may move a task to `to` from."""
    return frozenset(f for (f, t, a) in TRANSITIONS if t is to and a is actor)
