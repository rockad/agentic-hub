"""Property test over random event sequences with a fake clock (S1-STATE acceptance).

Random sends (local and remote, card and handle), responds, cancels, follow-ups, inbox calls,
claims, admin releases and denials, TTL sweeps and clock jumps. After every step, for every task:

- a task that reached a terminal state never changes again (state and version);
- a task that was ever held is never active again unless an admin release of it succeeded;
- `task_index.hold` is set only on a held task or on one that ended without being released;
- the audit log is a chain: one row per transition, each row starts where the last one ended,
  the first starts from nothing and the last ends in the state the task is in.

The generator is seeded, so a failure reproduces.
"""

from __future__ import annotations

import random

import pytest
import sqlalchemy as sa

from a2a.server.models import TaskVersionModel
from conftest import run
from coordination.service import Caller
from coordination.service.errors import ServiceError
from coordination.service.states import AUDIT_NAME, RAW, TERMINAL, State
from coordination.store.tables import task_index
from service_helpers import CARD_A, CARD_B, H_A1, H_A2, H_B1, Env, local, msg, remote, service_env, to_meta

STEPS = 260
SEEDS = (1, 2, 3)
HANDLES = (H_A1, H_A2, H_B1)
LOCALS = (local(CARD_A, H_A1), local(CARD_A, H_A2), local(CARD_B, H_B1))
REMOTES = (remote("r1", (CARD_A,), key_id="r0000001"), remote("r2", (CARD_A, CARD_B), key_id="r0000002"))
ALL_CALLERS: tuple[Caller, ...] = (*LOCALS, *REMOTES)
RESPONSES = ("working", "working", "input_required", "completed", "failed", "rejected")


def mid(rng: random.Random) -> str:
    """A message id drawn from the seeded generator, so task ids (derived from it) repeat per seed."""
    return f"p-{rng.getrandbits(48):x}"


async def one_step(env: Env, rng: random.Random, ids: list[str], released: set[str]) -> None:
    s = env.service
    op = rng.choice(
        ("send_card", "send_handle", "send_remote", "send_remote_handle", "respond", "respond", "cancel", "followup",
         "inbox", "inbox", "claim", "release", "deny", "sweep", "advance", "advance", "touch", "touch")
    )
    pick = lambda: rng.choice(ids) if ids else "99999999-9999-9999-9999-999999999999"  # noqa: E731
    try:
        if op == "send_card":
            sender = rng.choice(LOCALS)
            task = await s.send_message(sender, rng.choice((CARD_A, CARD_B)), msg("m", message_id=mid(rng)))
            ids.append(task.id)
        elif op == "send_handle":
            sender, to = rng.choice(LOCALS), rng.choice(HANDLES)
            task = await s.send_message(sender, to.split("/")[0], msg("m", message_id=mid(rng)), metadata=to_meta(to))
            ids.append(task.id)
        elif op == "send_remote":
            task = await s.send_message(rng.choice(REMOTES), CARD_A, msg("m", message_id=mid(rng)))
            ids.append(task.id)
        elif op == "send_remote_handle":
            to = rng.choice((*HANDLES, f"{CARD_A}/nope~00000000"))
            task = await s.send_message(rng.choice(REMOTES), to.split("/")[0], msg("m", message_id=mid(rng)), metadata=to_meta(to))
            ids.append(task.id)
        elif op == "respond":
            tid = pick()
            index = await env.store.get_index(tid)
            by_handle = {c.handle: c for c in LOCALS}
            caller = by_handle.get(index.to_handle) if index and rng.random() < 0.8 else None
            await s.respond(caller or rng.choice(LOCALS), tid, rng.choice(RESPONSES), text=rng.choice((None, "t")))
        elif op == "cancel":
            await s.cancel_task(rng.choice(ALL_CALLERS), pick())
        elif op == "followup":
            caller = rng.choice(ALL_CALLERS)
            await s.send_message(caller, rng.choice((CARD_A, CARD_B)), msg("f", message_id=mid(rng), task_id=pick()))
        elif op == "inbox":
            await s.inbox(rng.choice(LOCALS))
        elif op == "claim":
            await s.claim(rng.choice(LOCALS), pick())
        elif op == "release":
            held = [t.id for t in await s.held_tasks()]
            tid = rng.choice(held) if held and rng.random() < 0.9 else pick()
            await s.release_hold(tid, actor="human")
            released.add(tid)
        elif op == "deny":
            held = [t.id for t in await s.held_tasks()]
            await s.deny_hold(rng.choice(held) if held and rng.random() < 0.9 else pick(), actor="human")
        elif op == "sweep":
            await s.sweep()
        elif op == "advance":
            env.clock.advance(seconds=rng.choices((5, 90, 700, 4000, 40_000, 400_000), weights=(8, 8, 6, 4, 2, 1))[0])
        elif op == "touch":
            await env.touch_session(rng.choice(HANDLES))
    except ServiceError:
        pass  # a refusal is a correct outcome; the invariants below are what matter


async def snapshot(env: Env) -> dict[str, tuple[State, int, str | None]]:
    """(logical state, version, index hold) of every task, in ONE query."""
    tm, vm, ix = env.store._tm, TaskVersionModel, task_index
    stmt = (
        sa.select(tm.id, tm.status, tm.task_metadata, vm.version, ix.c.hold)
        .outerjoin(vm, vm.task_id == tm.id)
        .outerjoin(ix, ix.c.task_id == tm.id)
    )
    async with env.engine.connect() as conn:
        rows = (await conn.execute(stmt)).all()
    out = {}
    for tid, status, metadata, version, hold in rows:
        raw = status["state"]
        marked = ((metadata or {}).get("coord") or {}).get("hold") == "quarantine"
        if raw == "TASK_STATE_INPUT_REQUIRED" and marked:
            state = State.QUARANTINED
        else:
            state = State[raw.removeprefix("TASK_STATE_")]
        out[tid] = (state, version, hold)
    return out


async def check(env: Env, terminal: dict, was_held: set[str], released: set[str]) -> None:
    for tid, (state, version, hold) in (await snapshot(env)).items():
        if tid in terminal:
            assert (state, version) == terminal[tid], f"{tid} left a terminal state"
        elif state in TERMINAL:
            terminal[tid] = (state, version)
        if state is State.QUARANTINED:
            was_held.add(tid)
            assert hold == "quarantine"
        if tid in was_held and tid not in released:
            assert state in (State.QUARANTINED, State.REJECTED, State.CANCELED), f"{tid} was released without the admin"
        if hold is not None:
            assert state in (State.QUARANTINED, State.REJECTED, State.CANCELED), f"{tid} is active with hold set"


async def audit_chain(env: Env, ids: list[str]) -> None:
    final = {tid: AUDIT_NAME[state] for tid, (state, _v, _h) in (await snapshot(env)).items()}
    chains: dict[str, list[tuple[str | None, str]]] = {}
    for row in await env.audit_rows("state_transition"):
        chains.setdefault(row.subject, []).append((row.detail_json["from_state"], row.detail_json["to_state"]))
    for tid in ids:
        rows = chains.get(tid)
        assert rows, f"{tid} has no audit row"
        assert rows[0][0] is None
        for prev, cur in zip(rows, rows[1:], strict=False):
            assert cur[0] == prev[1], f"{tid}: audit chain broken {prev} -> {cur}"
        assert rows[-1][1] == final[tid], f"{tid}: last audit row is not its state"


@pytest.mark.parametrize("seed", SEEDS)
def test_random_event_sequences_keep_the_invariants(config, seed):
    async def go():
        async with service_env(config) as env:
            for h in HANDLES:
                await env.add_session(h)
            rng = random.Random(seed)
            ids: list[str] = []
            terminal: dict = {}
            was_held: set[str] = set()
            released: set[str] = set()
            counts: dict[str, int] = {}
            for _ in range(STEPS):
                await one_step(env, rng, ids, released)
                await check(env, terminal, was_held, released)
            await audit_chain(env, ids)
            for state, _v, _h in (await snapshot(env)).values():
                counts[state.value] = counts.get(state.value, 0) + 1
            return counts, released, was_held, await env.store.check_integrity(), len(ids)

    counts, released, was_held, integrity, n = run(go())
    assert integrity.ok
    assert n > 20 and was_held and released  # the run really exercised holds, and admin releases
    assert len(counts) >= 4  # and several different end states


def test_the_invariant_check_can_fail(config):
    """Positive control: a held task moved to SUBMITTED behind the service's back, and a terminal
    task moved on, are both caught by `check`. A check that cannot fail proves nothing."""
    from coordination.service import coord

    async def go():
        async with service_env(config) as env:
            await env.add_session(H_A1)
            held = await env.service.send_message(REMOTES[0], CARD_A, msg("held"))
            done = await env.service.send_message(LOCALS[2], CARD_A, msg("done"), metadata=to_meta(H_A1))
            await env.service.cancel_task(LOCALS[2], done.id)
            terminal: dict = {}
            was_held: set[str] = set()
            await check(env, terminal, was_held, set())  # clean: passes

            def release_quietly(task):
                task.status.state = RAW[State.SUBMITTED]
                coord.coord_set(task, hold=None)

            await env.store.transition(held.id, allowed_from={RAW[State.INPUT_REQUIRED]}, mutate=release_quietly)
            with pytest.raises(AssertionError, match="released without the admin"):
                await check(env, terminal, was_held, set())
            await env.store.transition(done.id, allowed_from={RAW[State.CANCELED]}, mutate=lambda t: setattr(t.status, "state", RAW[State.WORKING]))
            with pytest.raises(AssertionError):
                await check(env, terminal, was_held, {held.id})

    run(go())
