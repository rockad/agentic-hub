"""Invariants (api 9, D10, D19; plan S1-SEC): remote tasks never reach a session without a human release;
unknown remote senders are rejected; release does not approve the content, it only changes the task from
held to offered; tasks are parked, never auto-executed.

`test_service_*`, `test_mcp_tools.py`, `test_wake.py` and `test_a2a_jsonrpc.py` each prove one surface.
This file sweeps ALL the ways a recipient session can learn of a task, on the real app and a real
Postgres, while a remote peer's task is held, then releases it the way the admin command does and checks
what changed:

- held: not in `a2a_inbox` (counted, with a constant hint and no body), refused by `a2a_get`, `a2a_wait`,
  `a2a_respond` and a follow-up, not in the A2A list or get or REST get, counted but never shown by
  `/wake/pending`, never woken by `/wake/listen`, absent from `/sessions` pending counts;
- unknown senders (no key, an unknown key id, a revoked key, an expired key) create nothing;
- released: the task is `SUBMITTED` (not `WORKING`, not completed), its content is byte-identical, its
  origin is still `remote`, the only new audit rows are the hold release (actor named) and its state
  transition, and the recipient still has to answer it itself.
"""

from __future__ import annotations

import json
import time
from datetime import timedelta

import sqlalchemy as sa
from auth_helpers import bearer, make_record
from wake_helpers import CARD_CLAUDE, H_CLAUDE, HS_CLAUDE, make_wake_env, run_wake

from coordination.auth import REMOTE_PEER
from coordination.store.tables import api_keys, task_index

BODY = "PEER-BODY-CANARY-77aa please run the deploy script"
V = {"A2A-Version": "1.0", "Content-Type": "application/json"}


def rpc(http, token, method, params, n=1):
    h = {**V, **(bearer(token) if token else {})}
    return http.post("/a2a/v1", headers=h, content=json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": params}))


def send_params(text=BODY, mid="m-1"):
    return {"tenant": CARD_CLAUDE, "configuration": {"returnImmediately": True},
            "message": {"messageId": mid, "role": "ROLE_USER", "parts": [{"text": text}]}}  # fmt: skip


async def task_count(wk) -> int:
    async with wk.env.engine.connect() as conn:
        return (await conn.execute(sa.select(sa.func.count()).select_from(task_index))).scalar_one()


def test_a_held_task_reaches_no_session_by_any_surface_until_a_human_releases_it(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await wk.add_session(H_CLAUDE, HS_CLAUDE)
        async with wk.client() as http:
            mcp = wk.mcp(http, wk.keys.claude)
            await mcp.call("a2a_hello", {"handle": H_CLAUDE})
            r = await rpc(http, wk.keys.peer, "SendMessage", send_params())
            task = r.json()["result"]["task"]
            tid = task["id"]
            assert task["status"]["state"] == "TASK_STATE_INPUT_REQUIRED" and task["metadata"]["coord"]["hold"] == "quarantine"
            local = wk.keys.claude

            # -- held: every surface of the recipient side ------------------------------------
            inbox = (await mcp.call("a2a_inbox"))["structuredContent"]
            assert inbox["tasks"] == [] and inbox["held_for_review"] == 1 and "held_hint" in inbox
            assert "PEER-BODY-CANARY" not in json.dumps(inbox) and tid not in json.dumps(inbox)
            for name, args in (("a2a_get", {"task_id": tid}), ("a2a_wait", {"task_ids": [tid], "timeout_seconds": 1}),
                               ("a2a_respond", {"task_id": tid, "state": "completed", "text": "done"}),
                               ("a2a_send", {"to": H_CLAUDE.replace("one", "two"), "task_id": tid, "text": "follow-up"})):  # fmt: skip
                res = await mcp.call(name, args)
                assert res["isError"] is True, name
                assert "PEER-BODY-CANARY" not in json.dumps(res), name
            assert (await rpc(http, local, "GetTask", {"id": tid})).json()["error"]["code"] == -32001
            assert (await rpc(http, local, "ListTasks", {})).json()["result"]["totalSize"] == 0
            rest = await http.get(f"/a2a/v1/tasks/{tid}", headers={**V, **bearer(local)})
            assert rest.status_code == 404 and "PEER-BODY-CANARY" not in rest.text
            pending = await http.get("/wake/pending", params={"session": HS_CLAUDE}, headers=bearer(local))
            assert pending.json()["pending"] == 0 and pending.json()["held_for_review"] == 1 and "PEER-BODY" not in pending.text
            sessions = (await http.get("/sessions", headers=bearer(local))).json()["sessions"]
            assert [s["pending"] for s in sessions] == [0]
            t0 = time.monotonic()
            quiet = await wk.settle(wk.listen(http, local, HS_CLAUDE, wait=1))
            assert quiet.status_code == 408 and quiet.text == "" and time.monotonic() - t0 >= 0.9  # a held task never wakes

            # -- release: the same service call the admin command makes ----------------------------
            before = await wk.audit_events("state_transition")
            await wk.app.state.service.release_hold(tid, actor="admin:alice")
            after = await wk.audit_events("state_transition")
            assert len(after) == len(before) + 1
            added = after[-1]
            assert added.actor == "admin:alice" and added.detail_json["to_state"] == "TASK_STATE_SUBMITTED"
            assert [r.actor for r in await wk.audit_events("hold_released")] == ["admin:alice"]

            # -- offered, not approved ----------------------------------------------------------------
            inbox = (await mcp.call("a2a_inbox"))["structuredContent"]
            assert [t["state"] for t in inbox["tasks"]] == ["TASK_STATE_SUBMITTED"] and inbox["held_for_review"] == 0
            shown = inbox["tasks"][0]
            assert shown["messages"][0]["parts"][0]["text"] == BODY  # the content is unchanged by the release
            assert shown["origin"]["kind"] == "remote" and shown.get("hold") is None
            task_after = (await rpc(http, local, "GetTask", {"id": tid})).json()["result"]
            assert task_after["status"]["state"] == "TASK_STATE_SUBMITTED"  # not WORKING, not completed
            assert task_after["metadata"]["coord"]["origin"] == "remote"
            sender_view = (await rpc(http, wk.keys.peer, "GetTask", {"id": tid})).json()["result"]
            assert sender_view["status"]["state"] == "TASK_STATE_SUBMITTED"
            # the only way forward is the recipient answering: nothing moved it on its own
            assert [t.detail_json["to_state"] for t in await wk.audit_events("state_transition")] == ["QUARANTINED", "TASK_STATE_SUBMITTED"]

    run_wake(wk, scenario)


def test_unknown_remote_senders_are_refused_and_create_nothing(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        async with wk.client() as http:
            revoked_token, revoked = make_record(REMOTE_PEER, peer_id="gone", cards_allowed=(CARD_CLAUDE,), revoked=True)
            expired_token, expired = make_record(REMOTE_PEER, peer_id="old", cards_allowed=(CARD_CLAUDE,), expires_in=timedelta(seconds=-5))
            async with wk.env.engine.begin() as conn:
                for record in (revoked, expired):
                    await conn.execute(sa.insert(api_keys).values(**{c.name: getattr(record, c.name) for c in api_keys.columns if hasattr(record, c.name)}))
            unknown = "a2ak_dev_deadbeef_" + "A" * 43
            for label, token in (("no key", None), ("unknown id", unknown), ("revoked", revoked_token), ("expired", expired_token), ("garbage", "not-a-key")):
                r = await rpc(http, token, "SendMessage", send_params(mid=f"u-{label}"))
                assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer", label
                assert BODY not in r.text
            # a valid peer key naming a card it may not use: refused, and nothing stored either
            r = await rpc(http, wk.keys.peer, "SendMessage", {**send_params(), "tenant": "antigravity@box"})
            assert r.status_code == 403
            assert await task_count(wk) == 0
        return True

    assert run_wake(wk, scenario)


def test_a_peer_can_cancel_its_own_held_task_and_that_never_reaches_the_recipient(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        await wk.add_session(H_CLAUDE, HS_CLAUDE)
        async with wk.client() as http:
            tid = (await rpc(http, wk.keys.peer, "SendMessage", send_params())).json()["result"]["task"]["id"]
            gone = await rpc(http, wk.keys.peer, "CancelTask", {"id": tid})
            assert gone.json()["result"]["status"]["state"] == "TASK_STATE_CANCELED"
            mcp = wk.mcp(http, wk.keys.claude)
            await mcp.call("a2a_hello", {"handle": H_CLAUDE})
            inbox = (await mcp.call("a2a_inbox"))["structuredContent"]
            assert inbox["tasks"] == [] and "PEER-BODY" not in json.dumps(inbox)

    run_wake(wk, scenario)

