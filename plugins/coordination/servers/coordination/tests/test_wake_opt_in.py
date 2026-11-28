"""AW1 (decision Z23): `sessions.wake_opted_in`, `listening` in `/wake/pending`, `a2a_wake_off`.

Same harness as `test_wake.py`: the real app over a real Postgres, one event loop, a hand-moved clock.

- the first successful park of a listener sets `wake_opted_in`; a refused park (410, 429) does not;
- a later round of the same listener (`X-Coord-Again` above 1) does not set it again, so a listener
  that outlives `a2a_wake_off` cannot undo it;
- `GET /wake/pending` carries `listening` (a listener is parked now) and `wake_opted_in`;
- `a2a_wake_off` clears the flag, is idempotent and is refused for a handle of another card.
"""

from __future__ import annotations

import sqlalchemy as sa
from auth_helpers import bearer
from wake_helpers import H_AGY, H_CLAUDE, H_CLAUDE2, HS_AGY, HS_CLAUDE, HS_CLAUDE2, WakeEnv, make_wake_env, run_wake

from coordination.store.tables import sessions


async def two_sessions(wk: WakeEnv) -> None:
    await wk.add_session(H_CLAUDE, HS_CLAUDE)
    await wk.add_session(H_CLAUDE2, HS_CLAUDE2)
    await wk.add_session(H_AGY, HS_AGY)


async def opted_in(wk: WakeEnv, handle: str):
    async with wk.env.engine.connect() as conn:
        return (await conn.execute(sa.select(sessions.c.wake_opted_in).where(sessions.c.handle == handle))).scalar_one()


async def pending(http, wk: WakeEnv, session: str) -> dict:
    r = await http.get("/wake/pending", params={"session": session}, headers=bearer(wk.keys.claude))
    assert r.status_code == 200
    return r.json()


def test_first_park_sets_the_opt_in_and_pending_reports_it(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            assert await opted_in(wk, H_CLAUDE) is None
            assert await pending(http, wk, HS_CLAUDE) == {
                "pending": 0,
                "announce": False,
                "held_for_review": 0,
                "listening": False,
                "wake_opted_in": False,
                "rearm": False,
            }
            listener = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=2, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is not None
            view = await pending(http, wk, HS_CLAUDE)
            assert view["listening"] is True and view["wake_opted_in"] is True
            # only this session: its sibling on the same card never parked
            assert await opted_in(wk, H_CLAUDE2) is None
            assert (await pending(http, wk, HS_CLAUDE2))["wake_opted_in"] is False
            assert (await wk.settle(listener)).status_code == 408
            # the listener is gone, the opt-in stays: this is what the re-arm line keys on
            assert await pending(http, wk, HS_CLAUDE) == {
                "pending": 0,
                "announce": False,
                "held_for_review": 0,
                "listening": False,
                "wake_opted_in": True,
                "rearm": False,
            }

    run_wake(wk, scenario)


def test_a_refused_park_does_not_opt_in(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await wk.add_session(H_CLAUDE, HS_CLAUDE, ended=True)
        async with wk.client() as http:
            r = await wk.settle(wk.listen(http, wk.keys.claude, HS_CLAUDE))
            assert r.status_code == 410
            assert await opted_in(wk, H_CLAUDE) is None

    run_wake(wk, scenario)


def test_a_later_round_does_not_set_it_again_after_wake_off(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            first = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is not None
            await wk.settle(first)
            mcp = wk.mcp(http, wk.keys.claude)
            off = await mcp.call("a2a_wake_off", {"handle": H_CLAUDE})
            assert off["isError"] is False
            assert off["structuredContent"] == {"handle": H_CLAUDE, "wake_opted_in": False, "cleared": True}
            assert await opted_in(wk, H_CLAUDE) is None
            # the old listener loops: round 2 must not undo the switch-off
            second = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "2"})
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is None
            await wk.settle(second)
            # a fresh listener (round 1) is a new opt-in
            third = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert await opted_in(wk, H_CLAUDE) is not None
            await wk.settle(third)

    run_wake(wk, scenario)


def test_wake_off_is_idempotent_and_refuses_a_foreign_handle(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await two_sessions(wk)
        async with wk.client() as http:
            mcp = wk.mcp(http, wk.keys.claude)
            off = await mcp.call("a2a_wake_off", {"handle": H_CLAUDE})
            assert off["isError"] is False
            assert off["structuredContent"]["cleared"] is False  # nothing was set
            assert off["structuredContent"]["wake_opted_in"] is False
            foreign = await mcp.call("a2a_wake_off", {"handle": "antigravity@alyx-wsl/b-agy~0000000b"})
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
            key = bearer(wk.keys.claude)

            async def get(announce: str = "1") -> dict:
                r = await http.get("/wake/pending", params={"session": HS_CLAUDE, "announce": announce}, headers=key)
                assert r.status_code == 200
                return r.json()

            assert (await get())["rearm"] is False  # never opted in: nothing to re-arm
            first = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert (await get())["rearm"] is False  # a listener is parked
            await wk.settle(first)
            assert (await get("0"))["rearm"] is False  # no `announce`: state only, nothing told or recorded
            assert (await get())["rearm"] is True  # opted in and not listening: told
            assert (await get())["rearm"] is False  # the same lapse, a moment later
            wk.clock.advance(minutes=10, seconds=1)
            assert (await get())["rearm"] is True  # ten minutes: told again
            # armed again, then lapsed again: announced afresh without waiting out the window
            again = wk.listen(http, wk.keys.claude, HS_CLAUDE, wait=1, headers={"X-Coord-Again": "1"})
            await wk.parked_and_checked(H_CLAUDE)
            assert (await get())["rearm"] is False
            await wk.settle(again)
            assert (await get())["rearm"] is True
            # a2a_wake_off ends it
            mcp = wk.mcp(http, wk.keys.claude)
            assert (await mcp.call("a2a_wake_off", {"handle": H_CLAUDE}))["isError"] is False
            assert (await get())["rearm"] is False

    run_wake(wk, scenario)
