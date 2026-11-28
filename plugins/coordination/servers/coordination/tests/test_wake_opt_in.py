"""AW1 (decision Z23): `sessions.wake_opted_in`, `listening` in `/wake/pending`, `a2a_wake_off`.

Same harness as `test_wake.py`: the real app over a real Postgres, one event loop, a hand-moved clock.

- the first successful park of an agy listener sets `wake_opted_in`; a refused park (410, 429) does not;
- a Claude Code listener (it sends the same `X-Coord-Again: 1`) never opts in;
- a later round of the same listener (`X-Coord-Again` above 1) does not set it again, so a listener
  that outlives `a2a_wake_off` cannot undo it;
- `GET /wake/pending` carries `listening` (a listener is parked now) and `wake_opted_in`;
- `a2a_wake_off` clears the flag, is idempotent and is refused for a handle of another card;
- a sub-invocation conversation id (Z23 decision 7) cannot park under its root (403) and is never
  told to re-arm; the busy-session hook (`POST`) never records a re-arm key.
"""

from __future__ import annotations

import sqlalchemy as sa
from auth_helpers import bearer
from mcp_helpers import agy_meta
from wake_helpers import CARD_AGY, H_AGY, H_CLAUDE, HS_AGY, HS_CLAUDE, WakeEnv, make_wake_env, run_wake

from coordination.store.tables import session_conversations, sessions
from coordination.wake.rules import ParkLimiter

# A second agy session on the same card, and a sub-invocation conversation of the first.
H_AGY2 = f"{CARD_AGY}/two~bbbbbbb2"
HS_AGY2 = "bbbbbbb2-5555-4555-8555-555555555555"
HS_SUB = "ddddddd1-6666-4666-8666-666666666666"


async def two_sessions(wk: WakeEnv) -> None:
    await wk.add_session(H_AGY, HS_AGY)
    await wk.add_session(H_AGY2, HS_AGY2)
    await wk.add_session(H_CLAUDE, HS_CLAUDE)


async def link_sub(wk: WakeEnv, conversation: str, root_handle: str, root_conversation: str) -> None:
    async with wk.env.engine.begin() as conn:
        await conn.execute(
            sa.insert(session_conversations).values(
                card_id=CARD_AGY,
                conversation_id=conversation,
                handle=root_handle,
                root_conversation_id=root_conversation,
                parent_conversation_id=root_conversation,
                first_seen_at=wk.clock.now(),
            )
        )


async def opted_in(wk: WakeEnv, handle: str):
    async with wk.env.engine.connect() as conn:
        return (await conn.execute(sa.select(sessions.c.wake_opted_in).where(sessions.c.handle == handle))).scalar_one()


async def pending(http, wk: WakeEnv, session: str, *, announce: str | None = None) -> dict:
    params = {"session": session} if announce is None else {"session": session, "announce": announce}
    r = await http.get("/wake/pending", params=params, headers=bearer(wk.keys.agy))
    assert r.status_code == 200
    return r.json()


def test_first_park_sets_the_opt_in_and_pending_reports_it(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            assert await opted_in(wk, H_AGY) is None
            assert await pending(http, wk, HS_AGY) == {
                "pending": 0,
                "announce": False,
                "held_for_review": 0,
                "listening": False,
                "wake_opted_in": False,
                "rearm": False,
            }
            listener = wk.listen(http, wk.keys.agy, HS_AGY, wait=2, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            assert await opted_in(wk, H_AGY) is not None
            view = await pending(http, wk, HS_AGY)
            assert view["listening"] is True and view["wake_opted_in"] is True
            # only this session: its sibling on the same card never parked
            assert await opted_in(wk, H_AGY2) is None
            assert (await pending(http, wk, HS_AGY2))["wake_opted_in"] is False
            assert (await wk.settle(listener)).status_code == 408
            # the listener is gone, the opt-in stays: this is what the re-arm line keys on
            assert await pending(http, wk, HS_AGY) == {
                "pending": 0,
                "announce": False,
                "held_for_review": 0,
                "listening": False,
                "wake_opted_in": True,
                "rearm": False,
            }

    run_wake(wk, scenario)


def test_a_claude_listener_never_opts_in(pg_db):
    """Claude Code's `a2a-listen` also sends `X-Coord-Again: 1`; the flag is for agy cards only."""
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            listener = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is None
            assert (await wk.settle(listener)).status_code == 408
            assert await opted_in(wk, H_CLAUDE) is None
            # and no round without the header either
            bare = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1)
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is None
            await wk.settle(bare)

    run_wake(wk, scenario)


def test_a_refused_park_does_not_opt_in(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await wk.add_session(H_AGY, HS_AGY, ended=True)
        await wk.add_session(H_AGY2, HS_AGY2)
        async with wk.client() as http:
            r = await wk.settle(wk.listen(http, wk.keys.agy, HS_AGY))
            assert r.status_code == 410
            assert await opted_in(wk, H_AGY) is None
            # a park the limiter refuses (429) does not opt in either
            wk.wake._parks = ParkLimiter(limit=1, window_s=60.0)
            first = await wk.settle(wk.listen(http, wk.keys.agy, HS_AGY2, wait=1, headers={"X-Coord-Again": "2"}))
            assert first.status_code == 408  # round 2: parked, not an opt-in
            assert await opted_in(wk, H_AGY2) is None
            refused = await wk.settle(wk.listen(http, wk.keys.agy, HS_AGY2, wait=1, headers={"X-Coord-Again": "1"}))
            assert refused.status_code == 429
            assert await opted_in(wk, H_AGY2) is None

    run_wake(wk, scenario)


def test_a_later_round_does_not_set_it_again_after_wake_off(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            first = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            assert await opted_in(wk, H_AGY) is not None
            await wk.settle(first)
            mcp = wk.mcp(http, wk.keys.agy)
            off = await mcp.call("a2a_wake_off", {}, meta=agy_meta(HS_AGY))
            assert off["isError"] is False
            assert off["structuredContent"] == {"handle": H_AGY, "wake_opted_in": False, "cleared": True}
            assert await opted_in(wk, H_AGY) is None
            # the old listener loops: round 2 must not undo the switch-off
            second = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "2"})
            await wk.parked_and_checked(H_AGY)
            assert await opted_in(wk, H_AGY) is None
            await wk.settle(second)
            # a fresh listener (round 1) is a new opt-in
            third = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            assert await opted_in(wk, H_AGY) is not None
            await wk.settle(third)

    run_wake(wk, scenario)


def test_wake_off_is_idempotent_and_refuses_a_handle_of_another_card(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            mcp = wk.mcp(http, wk.keys.agy)
            off = await mcp.call("a2a_wake_off", {}, meta=agy_meta(HS_AGY))
            assert off["isError"] is False
            assert off["structuredContent"]["cleared"] is False  # nothing was set
            assert off["structuredContent"]["wake_opted_in"] is False
            # H_AGY exists, but on the antigravity card: the claude key's card check is what refuses it
            claude = wk.mcp(http, wk.keys.claude)
            foreign = await claude.call("a2a_wake_off", {"handle": H_AGY})
            assert foreign["isError"] is True
            tools = {t["name"] for t in await _tool_names(http, wk)}
            assert "a2a_wake_off" in tools

    run_wake(wk, scenario)


async def _tool_names(http, wk: WakeEnv):
    mcp = wk.mcp(http, wk.keys.claude)
    await mcp.initialize()
    r = await mcp._post({"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {}})
    assert r.status_code == 200
    return r.json()["result"]["tools"]


def test_rearm_is_told_once_per_window_to_an_opted_in_session_with_no_listener(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:

            async def get(announce: str = "1") -> dict:
                return await pending(http, wk, HS_AGY, announce=announce)

            assert (await get())["rearm"] is False  # never opted in: nothing to re-arm
            first = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            assert (await get())["rearm"] is False  # a listener is parked
            await wk.settle(first)
            assert (await get("0"))["rearm"] is False  # no `announce`: state only, nothing told or recorded
            assert (await get())["rearm"] is True  # opted in and not listening: told
            assert (await get())["rearm"] is False  # the same lapse, a moment later
            wk.clock.advance(minutes=10, seconds=1)
            assert (await get())["rearm"] is True  # ten minutes: told again
            # armed again, then lapsed again: announced afresh without waiting out the window
            again = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            assert (await get())["rearm"] is False
            await wk.settle(again)
            assert (await get())["rearm"] is True
            # a2a_wake_off ends it
            mcp = wk.mcp(http, wk.keys.agy)
            assert (await mcp.call("a2a_wake_off", {}, meta=agy_meta(HS_AGY)))["isError"] is False
            assert (await get())["rearm"] is False

    run_wake(wk, scenario)


def test_a_sub_invocation_conversation_cannot_arm_or_be_told_to_rearm(pg_db):
    """Z23 decision 7, enforced by the server: a linked id is `403` on listen (it must not park under
    the root handle and supersede the root's listener) and `rearm` is false for it."""
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        await link_sub(wk, HS_SUB, H_AGY, HS_AGY)
        async with wk.client() as http:
            # the sub-invocation id is refused and sets nothing
            r = await wk.settle(wk.listen(http, wk.keys.agy, HS_SUB, wait=1, headers={"X-Coord-Again": "1"}))
            assert r.status_code == 403
            assert not wk.table.is_listening(H_AGY)
            assert await opted_in(wk, H_AGY) is None
            # the root arms; a sub-invocation attempt must not supersede its listener
            root = wk.listen(http, wk.keys.agy, HS_AGY, wait=2, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            r = await wk.settle(wk.listen(http, wk.keys.agy, HS_SUB, wait=1, headers={"X-Coord-Again": "2"}))
            assert r.status_code == 403
            assert wk.table.is_listening(H_AGY) and not root.done()
            assert (await wk.settle(root)).status_code == 408  # the root's own round, not a 409
            # opted in and lapsed: the root is told to re-arm, its sub-invocation is not
            assert (await pending(http, wk, HS_SUB, announce="1"))["rearm"] is False
            assert (await pending(http, wk, HS_SUB))["wake_opted_in"] is True
            assert (await pending(http, wk, HS_AGY, announce="1"))["rearm"] is True

    run_wake(wk, scenario)


def test_the_busy_session_hook_records_no_rearm_key(pg_db):
    """`POST /wake/pending` (the Claude Code hook) is the count only: it must not write `<handle>|rearm`
    keys into the shared announcer, where they would count against its tracking limit."""
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            # an opted-in agy session whose listener has lapsed: the case where a re-arm key would be recorded
            opt = wk.listen(http, wk.keys.agy, HS_AGY, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_AGY)
            await wk.settle(opt)
            assert await opted_in(wk, H_AGY) is not None
            for key, hs in ((wk.keys.claude, HS_CLAUDE), (wk.keys.agy, HS_AGY)):
                r = await http.post("/wake/pending", json={"session_id": hs}, headers=bearer(key))
                assert r.status_code == 200
            assert not _rearm_keys(wk)
            # the agy GET with announce=1 is the one path that records it
            assert (await pending(http, wk, HS_AGY, announce="1"))["rearm"] is True
            assert _rearm_keys(wk) == [H_AGY + "|rearm"]

    run_wake(wk, scenario)


def _rearm_keys(wk: WakeEnv) -> list[str]:
    return [k for k in wk.wake._announcer._last if k.endswith("|rearm")]
